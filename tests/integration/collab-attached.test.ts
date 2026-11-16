// Live editing attached to the API's own listener (hosting P1-1, COLLAB_ATTACH=1): one port serves
// the API and, at /collab, the WebSocket; clients sign in with the login cookie alone, as browsers do
// (the cookie is httpOnly, so the page cannot send it as a token); a viewer still cannot write; any
// other upgrade path is refused. The last test guards the Hocuspocus member this relies on.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { attachCollaborationServer, COLLAB_PATH, hocuspocusServer, initializeCollaboration } from '../../src/collaboration';
import { AUTH_COOKIE_NAME, signAuthToken } from '../../src/services/auth/token';
import { createTestUser } from '../helpers/auth';

let server: http.Server;
let port = 0;
const providers: HocuspocusProvider[] = [];

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    initializeCollaboration();
    const hp = hocuspocusServer as any;
    hp.hocuspocus.configuration.debounce = 50;
    hp.hocuspocus.configuration.maxDebounce = 200;
    server = http.createServer(app);
    attachCollaborationServer(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
});

afterEach(() => {
    for (const p of providers.splice(0)) p.destroy();
});

afterAll(async () => {
    await hocuspocusServer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
});

/**
 * A WebSocket that sends the login cookie on its handshake, as a browser on the same site does
 * (Node's own WebSocket takes headers as an extension of the standard options).
 */
const withCookie = (userId: string) =>
    class CookieSocket extends WebSocket {
        constructor(url: string) {
            super(url, { headers: { Cookie: `${AUTH_COOKIE_NAME}=${signAuthToken(userId)}` } } as unknown as string[]);
        }
    };

async function connect(room: string, userId: string) {
    const document = new Y.Doc();
    const auth = { scope: undefined as string | undefined, failed: '' };
    const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}${COLLAB_PATH}`, WebSocketPolyfill: withCookie(userId) });
    const provider = new HocuspocusProvider({
        websocketProvider: socket,
        name: room,
        document,
        token: '', // the cookie alone
        onAuthenticated: ({ scope }) => {
            auth.scope = scope;
        },
        onAuthenticationFailed: ({ reason }) => {
            auth.failed = reason || 'denied';
        },
    });
    provider.attach();
    providers.push(provider);
    await vi.waitFor(() => expect(provider.synced || auth.failed).toBeTruthy(), { timeout: 10_000, interval: 20 });
    return { provider, document, auth, text: () => document.getText('t').toString() };
}

async function storedText(docId: string): Promise<string> {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
    const ydoc = new Y.Doc();
    if (row.yjsState) Y.applyUpdate(ydoc, row.yjsState);
    return ydoc.getText('t').toString();
}

describe('live editing on the API listener at /collab', () => {
    it('two tabs edit one doc with the login cookie alone; a viewer cannot write; the text is stored', async () => {
        const [owner, viewer] = await Promise.all([createTestUser(), createTestUser()]);
        const doc = await prisma.doc.create({ data: { userId: owner.id, title: 'Attached' } });
        await prisma.docCollaborator.create({ data: { docId: doc.id, userId: viewer.id, role: 'viewer' } });
        const room = `doc_${doc.id}`;

        const tabA = await connect(room, owner.id);
        const tabB = await connect(room, owner.id);
        const reader = await connect(room, viewer.id);
        expect([tabA.auth.scope, tabB.auth.scope, reader.auth.scope]).toEqual(['read-write', 'read-write', 'readonly']);

        tabA.document.getText('t').insert(0, 'typed in tab A');
        await vi.waitFor(() => expect(tabB.text()).toBe('typed in tab A'), { timeout: 10_000, interval: 20 });
        reader.document.getText('t').insert(0, 'viewer-was-here ');
        tabB.document.getText('t').insert(14, ', then B');
        await vi.waitFor(() => expect(tabA.text()).toBe('typed in tab A, then B'), { timeout: 10_000, interval: 20 });
        await vi.waitFor(async () => expect(await storedText(doc.id)).toBe('typed in tab A, then B'), { timeout: 10_000, interval: 50 });
    });

    it('without a login, or as a stranger, the room refuses', async () => {
        const [owner, stranger] = await Promise.all([createTestUser(), createTestUser()]);
        const doc = await prisma.doc.create({ data: { userId: owner.id, title: 'Private' } });
        const outsider = await connect(`doc_${doc.id}`, stranger.id);
        expect(outsider.auth.failed).toBeTruthy();
    });

    it('any other upgrade path is refused; the API answers on the same port', async () => {
        const refused = await new Promise<string>((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/elsewhere`);
            ws.onopen = () => resolve('opened');
            ws.onerror = () => resolve('refused');
            ws.onclose = () => resolve('refused');
        });
        expect(refused).toBe('refused');
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(health.status).toBe(200);
    });

    it('guards the Hocuspocus member it relies on: a WebSocket server of its own, without a port, that hands over upgrades', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'node_modules', '@hocuspocus', 'server', 'package.json'), 'utf8')) as { version: string };
        // Pinned: an upgrade must re-check attachCollaborationServer (src/collaboration/hocuspocus.ts).
        expect(pkg.version).toBe('3.4.3');
        const wss = (hocuspocusServer as unknown as { webSocketServer: { handleUpgrade?: unknown; emit?: unknown; options?: { noServer?: boolean }; listenerCount: (e: string) => number } }).webSocketServer;
        expect(typeof wss.handleUpgrade).toBe('function');
        expect(typeof wss.emit).toBe('function');
        expect(wss.options?.noServer).toBe(true);
        expect(wss.listenerCount('connection')).toBeGreaterThan(0); // its own 'connection' handler takes the socket from here
    });
});
