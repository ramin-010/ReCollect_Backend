// The server as production runs it, in a child process (NODE_ENV=production, HOST=127.0.0.1,
// COLLAB_ATTACH=1, COOKIE_SAMESITE=lax, SIGNUP_MODE=closed, quiet scheduler), on the test database:
//   hosting P1-6: the login cookie reads HttpOnly; Secure; SameSite=Lax, with no Domain;
//   hosting P1-7: a marker word put in a query, a body and a live doc is nowhere in its log.
import { fork, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import jwt from 'jsonwebtoken';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { prisma } from '../../src/db/prisma';
import { createTestUser, TEST_PASSWORD } from '../helpers/auth';

const SECRET = 'production-mode-test-secret-0123456789abcdef-0123456789abcdef';
const MARKER = 'Zebrafinch4417';
let child: ChildProcess | null = null;
let output = '';

afterAll(async () => {
    if (child && child.exitCode === null) {
        const done = new Promise((r) => child!.once('exit', r));
        if (process.platform === 'win32') child.send('shutdown');
        else child.kill('SIGTERM');
        await done;
    }
});

const freePort = () =>
    new Promise<number>((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        });
    });

const cookieFor = (userId: string) => `token=${jwt.sign({ id: userId }, SECRET, { expiresIn: '1h' })}`;

describe('production mode', () => {
    it('sets the login cookie host-only and SameSite=Lax, and logs no query, body or doc text', async () => {
        const user = await createTestUser();
        const port = await freePort();
        child = fork(path.join(process.cwd(), 'node_modules', 'ts-node', 'dist', 'bin.js'), ['--transpile-only', 'src/index.ts'], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                NODE_ENV: 'production',
                PORT: String(port),
                HOST: '127.0.0.1',
                COLLAB_ATTACH: '1',
                COOKIE_SAMESITE: 'lax',
                SIGNUP_MODE: 'closed',
                JWT_SECRET: SECRET,
                ALLOWED_ORIGINS: 'https://re-collect.example',
                RECOLLECT_SELF_URL: 'https://api.recollect.example',
                OAUTH_CIMD_HOSTS: 'claude.ai',
                SCHEDULER_MODE: 'quiet',
                BUDDY_WORKER: 'off',
                RECOLLECT_STATE_DIR: path.join(os.tmpdir(), `recollect-state-${process.pid}`),
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        child.stdout?.on('data', (b) => (output += String(b)));
        child.stderr?.on('data', (b) => (output += String(b)));
        await vi.waitFor(() => expect(output).toContain('Server runnin on'), { timeout: 60_000, interval: 100 });
        const base = `http://127.0.0.1:${port}`;

        // P1-6: the cookie's flags.
        const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: TEST_PASSWORD }) });
        expect(login.status).toBe(200);
        const token = login.headers.getSetCookie().find((c) => c.startsWith('token='))!;
        expect(token).toMatch(/; HttpOnly/i);
        expect(token).toMatch(/; Secure/i);
        expect(token).toMatch(/; SameSite=Lax/i);
        expect(token).not.toMatch(/Domain=/i);

        // P1-7: the marker in a query, a body (a doc's title, a bad login), and a live doc.
        const cookie = cookieFor(user.id);
        expect((await fetch(`${base}/api/docs/search?q=${MARKER}`, { headers: { Cookie: cookie } })).status).toBeLessThan(500);
        const made = await fetch(`${base}/api/docs`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: `${MARKER} notes` }) });
        expect(made.status).toBeLessThan(300);
        const doc = (await made.json()) as { data?: { _id?: string; id?: string } };
        const docId = doc.data?._id ?? doc.data?.id ?? (await prisma.doc.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } })).id;
        expect((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${MARKER}@example.org`, password: MARKER }) })).status).toBe(400);
        expect((await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: MARKER, email: `${MARKER}@example.org`, password: `${MARKER}-pass` }) })).status).toBe(403);

        const document = new Y.Doc();
        class CookieSocket extends WebSocket {
            constructor(url: string) {
                super(url, { headers: { Cookie: cookie, Origin: 'https://re-collect.example' } } as unknown as string[]);
            }
        }
        const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: CookieSocket });
        const provider = new HocuspocusProvider({ websocketProvider: socket, name: `doc_${docId}`, document, token: '' });
        provider.attach();
        await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 15_000, interval: 20 });
        document.getText('t').insert(0, `a line with ${MARKER} in it`);
        await vi.waitFor(
            async () => {
                const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
                const y = new Y.Doc();
                if (row.yjsState) Y.applyUpdate(y, row.yjsState);
                expect(y.getText('t').toString()).toContain(MARKER);
            },
            { timeout: 15_000, interval: 100 },
        );
        provider.destroy();
        await new Promise((r) => setTimeout(r, 500));

        expect(output).toMatch(/POST \/api\/login 200 [\d.]+ ms/); // the request log: method, path, status, time
        expect(output).toMatch(/GET \/api\/docs\/search \d{3} /); // its query left out
        expect(output.includes(MARKER)).toBe(false);
        expect(output.includes(user.email)).toBe(false);
        expect(output.includes(user.name)).toBe(false);
    }, 120_000);
});
