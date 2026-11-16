// The deployment review's findings (16 Nov, rev 2.2), on the real app:
//   A1 client metadata is read only from OAUTH_CIMD_HOSTS, with no request out for another host;
//   A2 2 MB bodies before login, 10 MB only on the named routes and only after the login check;
//   A4 /collab refuses a foreign or missing Origin at the upgrade (T8), the web app's connects;
//   and the capture queue: a model outage leaves a piece waiting with its tries untouched.
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { attachCollaborationServer, COLLAB_PATH, hocuspocusServer, initializeCollaboration } from '../../src/collaboration';
import { setCimdFetcherForTests } from '../../src/services/oauth/cimd';
import { setAiClientForTests } from '../../src/services/claude/client';
import { drainBuddyQueue } from '../../src/services/buddy/worker';
import { queueWords } from '../../src/services/buddy/capture.service';
import { AUTH_COOKIE_NAME, signAuthToken } from '../../src/services/auth/token';
import { authCookie, createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { FakeClaude, fakeMessage } from '../helpers/claude';

afterEach(() => {
    delete process.env.OAUTH_CIMD_HOSTS;
    setCimdFetcherForTests(null);
});

describe('A1: client metadata only from listed hosts', () => {
    const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
    const authorize = (clientId: string) =>
        request(app).get('/oauth/authorize').query({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });

    it('a metadata URL on a host not listed is refused, and nothing is fetched', async () => {
        process.env.OAUTH_CIMD_HOSTS = 'claude.ai';
        const fetcher = vi.fn(async () => ({ status: 200, headers: { get: () => null }, text: async () => '{}' }));
        setCimdFetcherForTests(fetcher);
        const res = await authorize('https://attacker.example/client.json');
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('a listed host is read as before', async () => {
        process.env.OAUTH_CIMD_HOSTS = 'claude.ai';
        const id = 'https://claude.ai/oauth/review-client-metadata';
        const fetcher = vi.fn(async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ client_id: id, client_name: 'Claude', redirect_uris: [REDIRECT] }) }));
        setCimdFetcherForTests(fetcher);
        await authorize(id);
        expect(fetcher).toHaveBeenCalledWith(id);
    });
});

describe('A2: request bodies', () => {
    const just = (bytes: number) => JSON.stringify({ email: 'x@example.org', password: 'p'.repeat(bytes) });
    /** The status, or 'reset' when the server ended the connection before the client finished sending (it refused the body unread). */
    const statusOf = async (req: PromiseLike<{ status: number }>): Promise<number | 'reset'> => {
        try {
            return (await req).status;
        } catch (err) {
            if (/ECONNRESET|EPIPE|socket hang up/i.test(String((err as Error)?.message ?? err))) return 'reset';
            throw err;
        }
    };

    it('2 MB + 1 byte before login answers 413; 2 MB passes the parser', async () => {
        const over = await statusOf(request(app).post('/api/login').set('Content-Type', 'application/json').send(just(2 * 1024 * 1024 + 1)));
        expect(over).toBe(413);
        const under = await request(app).post('/api/login').set('Content-Type', 'application/json').send(just(2 * 1024 * 1024 - 100));
        expect(under.status).not.toBe(413);
    });

    it('a named route takes up to 10 MB, read only after the login check', async () => {
        const big = JSON.stringify({ title: 'Big', content: 'x'.repeat(3 * 1024 * 1024) });
        const anonymous = await statusOf(request(app).post('/api/docs').set('Content-Type', 'application/json').send(big));
        expect([401, 'reset']).toContain(anonymous); // refused before the body is read
        const me = await createTestUser();
        const signedIn = await request(app).post('/api/docs').set('Cookie', authCookie(me)).set('Content-Type', 'application/json').send(big);
        expect(signedIn.status).not.toBe(413);
        const tooBig = await statusOf(request(app).post('/api/docs').set('Cookie', authCookie(me)).set('Content-Type', 'application/json').send(JSON.stringify({ content: 'x'.repeat(10 * 1024 * 1024 + 1) })));
        expect([413, 'reset']).toContain(tooBig);
    });
});

describe('A4: the Origin of a /collab upgrade (T8)', () => {
    let server: http.Server;
    let port = 0;
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        initializeCollaboration();
        server = http.createServer(app);
        attachCollaborationServer(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as { port: number }).port;
    });
    afterAll(async () => {
        await hocuspocusServer.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        vi.restoreAllMocks();
    });

    const tryOrigin = async (origin: string | null) => {
        const me = await createTestUser();
        const headers: Record<string, string> = { Cookie: `${AUTH_COOKIE_NAME}=${signAuthToken(me.id)}` };
        if (origin) headers.Origin = origin;
        return new Promise<string>((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}${COLLAB_PATH}`, { headers } as unknown as string[]);
            ws.onopen = () => {
                ws.close();
                resolve('open');
            };
            ws.onerror = () => resolve('refused');
        });
    };

    it("a foreign Origin is refused at the upgrade; a missing one too; the web app's connects", async () => {
        expect(await tryOrigin('https://evil.example')).toBe('refused');
        expect(await tryOrigin(null)).toBe('refused');
        expect(await tryOrigin('http://localhost:3005')).toBe('open');
    });
});

describe('the capture queue during a model outage', () => {
    const fake = new FakeClaude();
    beforeAll(() => {
        process.env.CLAUDE_API_KEY = 'test-key-not-real';
        setAiClientForTests(fake);
    });
    afterAll(() => {
        process.env.CLAUDE_API_KEY = '';
        setAiClientForTests(null);
    });

    it('an outage leaves the piece waiting, its tries untouched, however long; it is digested when the AI answers', async () => {
        const user = await createTestUser();
        await api(user).patch('/api/buddy/settings', { enabled: true });
        await queueWords(user.id, { sessionKey: 'cc_outage', seq: 1, project: 'second_brain', messages: [{ at: new Date().toISOString(), text: 'remember the dentist on Friday' }] });
        fake.push(new Error('The AI is overloaded'), new Error('socket hang up'), new Error('The AI is overloaded'), new Error('The AI is overloaded'), new Error('The AI is overloaded'));
        for (let i = 0; i < 5; i++) expect((await drainBuddyQueue()).failed).toBe(1);
        const piece = await prisma.buddyChunk.findFirstOrThrow({ where: { userId: user.id } });
        expect(piece.attempts).toBe(0);
        expect(piece.lastError).toBeTruthy();
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'none' }] }));
        expect(await drainBuddyQueue()).toMatchObject({ digested: 1, dropped: 0 });
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0);
    });
});
