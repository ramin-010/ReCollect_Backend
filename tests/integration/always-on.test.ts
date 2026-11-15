// Stage 6 (ALWAYS_ON_SPEC): the wallpaper + widget, the morning notification's subscriptions and pass,
// remote MCP's door, and the night job that prunes old agent history.
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
