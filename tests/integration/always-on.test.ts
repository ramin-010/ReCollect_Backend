// Stage 6 (ALWAYS_ON_SPEC): the wallpaper + widget, the morning notification's subscriptions and pass,
// remote MCP's door, and the night job that prunes old agent history.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { authCookie, createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import { pruneAgentHistory } from '../../src/services/agent/prune.service';

const sub = (n: number) => ({ endpoint: `https://push.example.test/send/${n}`, keys: { p256dh: 'BPx3g9Wlzq3m1H9QzAQ4kq8Xo0yJ1w', auth: 'a1b2c3d4e5f6g7h8' } });

describe('the ambient phone (6.6)', () => {
    it('the widget says what today holds; a read token may fetch the wallpaper PNG', async () => {
        const user = await createTestUser();
        const widget = await api(user).get('/api/ambient/widget');
        expect(widget.status).toBe(200);
        expect(widget.body.data).toMatchObject({ mode: expect.any(String), state: expect.stringMatching(/morning|working|evening|done|rest/), lines: expect.any(Array) });
        const token = (await createTestToken(user, ['read'])).token;
        const png = await request(app).get('/api/ambient/wallpaper.png?w=540&h=1170&theme=light').set('Authorization', `Bearer ${token}`);
        expect(png.status).toBe(200);
        expect(png.headers['content-type']).toBe('image/png');
        expect((png.body as Buffer).subarray(1, 4).toString('latin1')).toBe('PNG');
    });

    it("the phone app's ambient token reads only the picture and the widget; Settings lists where the phone can reach the server", async () => {
        const user = await createTestUser();
        const phone = (await createTestToken(user, ['ambient'], 'Phone app')).token;
        const bearer = (path: string) => request(app).get(path).set('Authorization', `Bearer ${phone}`);
        const widget = await bearer('/api/ambient/widget?titles=0');
        expect(widget.status).toBe(200);
        // What the app's screen shows: whose day it is and where a tap opens Recollect.
        expect(widget.body.data).toMatchObject({ account: { name: user.name, email: user.email } });
        expect(widget.body.data.appUrl === null || typeof widget.body.data.appUrl === 'string').toBe(true);
        const png = await bearer('/api/ambient/wallpaper.png?w=540&h=1170&titles=0');
        expect([png.status, png.headers['content-type']]).toEqual([200, 'image/png']);
        // The lock screen's own picture (the dial), and what the app compares to fetch again only on a change.
        const lock = await bearer('/api/ambient/wallpaper.png?w=540&h=1170&titles=0&screen=lock');
        expect([lock.status, lock.headers['content-type']]).toEqual([200, 'image/png']);
        expect(Buffer.compare(lock.body as Buffer, png.body as Buffer)).not.toBe(0);
        expect(widget.body.data).toMatchObject({ key: expect.any(String), items: expect.any(Array), counts: { reviews: { done: expect.any(Number), total: expect.any(Number) } } });
        // The styles (11-16): the list for the app's picker, the sky first; a styled picture differs; an unknown style is the sky.
        const styles = (await bearer('/api/ambient/styles')).body.data as Array<{ id: string; colors: Array<{ id: string }> }>;
        expect(styles[0]!.id).toBe('sky');
        expect(styles.map((s) => s.id)).toEqual(['sky', 'glow', 'peaks', 'orb', 'dots', 'flow', 'aurora', 'mono']);
        const bold = await bearer('/api/ambient/wallpaper.png?w=540&h=1170&titles=0&screen=lock&style=peaks&color=dusk');
        expect([bold.status, bold.headers['content-type']]).toEqual([200, 'image/png']);
        expect(Buffer.compare(bold.body as Buffer, lock.body as Buffer)).not.toBe(0);
        const unknown = await bearer('/api/ambient/wallpaper.png?w=540&h=1170&titles=0&screen=lock&style=nope');
        expect(Buffer.compare(unknown.body as Buffer, lock.body as Buffer)).toBe(0);
        // Nothing else: not today, not the docs, not the agent API.
        for (const path of ['/api/today', '/api/docs', '/api/agent/docs']) expect((await bearer(path)).status, path).toBe(403);
        // The addresses: cookie only; the last one is always USB (localhost).
        const list = await request(app).get('/api/ambient/addresses').set('Cookie', authCookie(user));
        expect(list.body.data[list.body.data.length - 1]).toMatchObject({ kind: 'usb' });
        expect((await bearer('/api/ambient/addresses')).status).toBe(403);
    });

    it("the app's Disconnect ends its own token; nothing else can call it", async () => {
        const user = await createTestUser();
        const phone = (await createTestToken(user, ['ambient'], 'Phone app')).token;
        const read = (await createTestToken(user, ['read'])).token;
        expect((await request(app).post('/api/ambient/disconnect').set('Authorization', `Bearer ${read}`)).status).toBe(403);
        expect((await request(app).post('/api/ambient/disconnect').set('Cookie', authCookie(user))).status).toBe(400);
        const done = await request(app).post('/api/ambient/disconnect').set('Authorization', `Bearer ${phone}`);
        expect([done.status, done.body.data]).toEqual([200, { disconnected: true }]);
        expect((await request(app).get('/api/ambient/widget').set('Authorization', `Bearer ${phone}`)).status).toBe(401);
        expect((await request(app).get('/api/ambient/widget').set('Authorization', `Bearer ${read}`)).status).toBe(200);
    });

    it('the connect page and the app file need no sign-in; the token never leaves the link', async () => {
        const page = await request(app).get('/phone/connect');
        expect(page.status).toBe(200);
        expect(page.headers['content-type']).toMatch(/text\/html/);
        expect(page.headers['content-security-policy']).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
        expect(page.headers['referrer-policy']).toBe('no-referrer');
        expect(page.text).toContain('Open the phone app');
        expect(page.text).toContain('location.hash');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-apk-'));
        const apk = path.join(dir, 'recollect.apk');
        try {
            vi.stubEnv('RECOLLECT_APK_PATH', apk);
            expect((await request(app).get('/phone/recollect.apk')).status).toBe(404);
            expect((await request(app).get('/phone/connect')).text).toContain("doesn't have the phone app's file");
            fs.writeFileSync(apk, Buffer.alloc(2048, 1));
            const file = await request(app).get('/phone/recollect.apk');
            expect([file.status, file.headers['content-type']]).toEqual([200, 'application/vnd.android.package-archive']);
            expect((await request(app).get('/phone/connect')).text).toContain('Android, 2 KB');
        } finally {
            vi.unstubAllEnvs();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the morning notification (6.3)', () => {
    it('saves one row per browser, lists the device count, removes it; cookie only', async () => {
        const user = await createTestUser();
        expect((await api(user).post('/api/push/subscription', sub(1))).status).toBe(201);
        expect((await api(user).post('/api/push/subscription', sub(1))).status).toBe(201); // same browser again: still one row
        expect((await api(user).get('/api/push/status')).body.data.devices).toBe(1);
        expect((await api(user).post('/api/push/subscription', { endpoint: 'not a url', keys: {} })).status).toBe(400);
        const agent = asAgent((await createTestToken(user)).token, 'chat');
        expect((await agent.post('/api/push/subscription', sub(2))).status).toBe(403);
        const del = await request(app).delete('/api/push/subscription').set('Cookie', authCookie(user)).send({ endpoint: sub(1).endpoint });
        expect(del.body.data).toEqual({ removed: 1 });
        expect(await prisma.pushSubscription.count({ where: { userId: user.id } })).toBe(0);
    });

    it('the pass sends nothing without VAPID keys and claims nothing', async () => {
        const { runMorningPushPass } = await import('../../src/services/push/push.service');
        vi.stubEnv('VAPID_PUBLIC_KEY', '');
        expect(await runMorningPushPass(new Date())).toEqual({ checked: 0, sent: 0, empty: 0 });
        vi.unstubAllEnvs();
    });
});

describe('remote MCP (6.5)', () => {
    it('without a token: 401 with the protected-resource hint; the metadata answers', async () => {
        const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toMatch(/resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);
        const bad = await request(app).post('/mcp').set('Authorization', 'Bearer rcl_notarealtoken0000000000000000').send({});
        expect(bad.status).toBe(401);
        const meta = await request(app).get('/.well-known/oauth-protected-resource');
        expect(meta.body).toMatchObject({ resource: expect.stringMatching(/\/mcp$/), bearer_methods_supported: ['header'] });
        expect((await request(app).get('/mcp')).status).toBe(405);
    });
});

describe('pruning old agent history (D5, 6.4)', () => {
    it('drops edits after 90 days and snapshots after 30, keeping each doc\'s newest five and any an edit still needs', async () => {
        const user = await createTestUser();
        const doc = await prisma.doc.create({ data: { userId: user.id, title: 'Pruned' }, select: { id: true } });
        const old = new Date(Date.now() - 40 * 86_400_000);
        const snaps = [];
        for (let i = 0; i < 8; i++) {
            snaps.push(await prisma.docSnapshot.create({ data: { docId: doc.id, yjsState: new Uint8Array([0]), createdAt: new Date(old.getTime() - i * 60_000) } as never, select: { id: true } }));
        }
        // the oldest snapshot is still the before-state of a recent edit: kept
        await prisma.agentEdit.create({ data: { userId: user.id, docId: doc.id, kind: 'doc_append', agentName: 'chat', summary: 'recent', snapshotId: snaps[7]!.id } });
        await prisma.agentEdit.create({ data: { userId: user.id, docId: doc.id, kind: 'doc_append', agentName: 'chat', summary: 'ancient', createdAt: new Date(Date.now() - 100 * 86_400_000) } });
        const r = await pruneAgentHistory();
        expect(r.edits).toBeGreaterThanOrEqual(1);
        const left = await prisma.docSnapshot.findMany({ where: { docId: doc.id }, select: { id: true } });
        // newest 5 + the one a kept edit points at
        expect(left.map((s) => s.id).sort()).toEqual([...snaps.slice(0, 5).map((s) => s.id), snaps[7]!.id].sort());
        expect(await prisma.agentEdit.count({ where: { userId: user.id, summary: 'ancient' } })).toBe(0);
    });
});
