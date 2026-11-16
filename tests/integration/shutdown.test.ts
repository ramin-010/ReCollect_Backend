// Graceful shutdown (hosting P1-2), on the real server in a child process: text typed into a live
// doc, the shutdown asked for within a second (before the 2-second store would run), the process
// exits 0 with the text stored, and a new process serves it. Linux gets a real SIGTERM; Windows
// cannot deliver one to a Node process gracefully (it ends it at once), so there the test asks over
// the process's IPC channel, which runs the same routine (src/lifecycle/shutdown.ts).
import { fork, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { prisma } from '../../src/db/prisma';
import { AUTH_COOKIE_NAME, signAuthToken } from '../../src/services/auth/token';
import { createTestUser } from '../helpers/auth';

const children: ChildProcess[] = [];
afterAll(() => {
    for (const c of children) if (c.exitCode === null) c.kill();
});

const freePort = () =>
    new Promise<number>((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        });
    });

/** The real entry point (src/index.ts), attached mode, on its own port; resolves once it listens. */
async function startServer(port: number): Promise<{ child: ChildProcess; output: () => string }> {
    let out = '';
    const child = fork(path.join(process.cwd(), 'node_modules', 'ts-node', 'dist', 'bin.js'), ['--transpile-only', 'src/index.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', COLLAB_ATTACH: '1', NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    child.stdout?.on('data', (b) => (out += String(b)));
    child.stderr?.on('data', (b) => (out += String(b)));
    await vi.waitFor(() => expect(out).toContain('Server runnin on'), { timeout: 60_000, interval: 100 });
    return { child, output: () => out };
}

const withCookie = (userId: string) =>
    class CookieSocket extends WebSocket {
        constructor(url: string) {
            super(url, { headers: { Cookie: `${AUTH_COOKIE_NAME}=${signAuthToken(userId)}`, Origin: 'http://localhost:3005' } } as unknown as string[]);
        }
    };

async function connect(port: number, room: string, userId: string) {
    const document = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}/collab`, WebSocketPolyfill: withCookie(userId) });
    const provider = new HocuspocusProvider({ websocketProvider: socket, name: room, document, token: '' });
    provider.attach();
    await vi.waitFor(() => expect(provider.synced).toBe(true), { timeout: 15_000, interval: 20 });
    return { provider, document };
}

describe('graceful shutdown', () => {
    it('text typed a moment before the shutdown is stored; the process exits 0; the next start serves it', async () => {
        const owner = await createTestUser();
        const doc = await prisma.doc.create({ data: { userId: owner.id, title: 'Before the restart' } });
        const room = `doc_${doc.id}`;
        const port = await freePort();

        const first = await startServer(port);
        const tab = await connect(port, room, owner.id);
        tab.document.getText('t').insert(0, 'typed just before the shutdown');
        await new Promise((r) => setTimeout(r, 300)); // on the wire; the server's store would wait 2 s
        const exited = new Promise<number | null>((resolve) => first.child.once('exit', (code) => resolve(code)));
        if (process.platform === 'win32') first.child.send('shutdown');
        else first.child.kill('SIGTERM');
        const code = await Promise.race([exited, new Promise<'late'>((r) => setTimeout(() => r('late'), 25_000))]);
        tab.provider.destroy();
        expect(code).toBe(0);
        expect(first.output()).toMatch(/\[shutdown\] .*: stopping/);
        expect(first.output()).toMatch(/\[shutdown\] done in \d+ ms/);

        const row = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        const stored = new Y.Doc();
        if (row.yjsState) Y.applyUpdate(stored, row.yjsState);
        expect(stored.getText('t').toString()).toBe('typed just before the shutdown');

        const second = await startServer(port);
        const again = await connect(port, room, owner.id);
        expect(again.document.getText('t').toString()).toBe('typed just before the shutdown');
        again.provider.destroy();
        const done = new Promise((resolve) => second.child.once('exit', resolve));
        if (process.platform === 'win32') second.child.send('shutdown');
        else second.child.kill('SIGTERM');
        await done;
    }, 120_000);
});
