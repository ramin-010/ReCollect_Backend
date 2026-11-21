// Stage 6 (ALWAYS_ON_SPEC): the wallpaper + widget, the morning notification's subscriptions and pass,
// remote MCP's door, and the night job that prunes old agent history.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { createTodoReminder } from '../../src/services/reminders/reminders.service';
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

        // 0.5.2 (stage 1): a phone that already has this picture gets 304 and no body; another size is another picture.
        const etag = png.headers['etag'];
        expect(etag).toMatch(/^"[a-z0-9]+"$/);
        const same = await request(app).get('/api/ambient/wallpaper.png?w=540&h=1170&theme=light').set('Authorization', `Bearer ${token}`).set('If-None-Match', String(etag));
        expect(same.status).toBe(304);
        const other = await request(app).get('/api/ambient/wallpaper.png?w=600&h=1170&theme=light').set('Authorization', `Bearer ${token}`).set('If-None-Match', String(etag));
        expect(other.status).toBe(200);
        expect(other.headers['etag']).not.toBe(etag);
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
        // B8: the home picture drawn for the phone's zoom (Android 11: 1.1) differs; a zoom out of range is 1. Stage 16: the
        // home picture's words are what is ahead (a to-do the day after tomorrow); the zoom moves only words.
        await prisma.todo.create({ data: { userId: user.id, title: 'Renew the passport', dueDate: new Date(Date.now() + 2 * 86_400_000) } });
        const ahead = await bearer('/api/ambient/wallpaper.png?w=540&h=1170&titles=0');
        const zoomed = await bearer('/api/ambient/wallpaper.png?w=540&h=1170&titles=0&zoom=1.1');
        expect([zoomed.status, zoomed.headers['content-type']]).toEqual([200, 'image/png']);
        expect(Buffer.compare(zoomed.body as Buffer, ahead.body as Buffer)).not.toBe(0);
        const silly = await bearer('/api/ambient/wallpaper.png?w=540&h=1170&titles=0&zoom=nope');
        expect(Buffer.compare(silly.body as Buffer, ahead.body as Buffer)).toBe(0);
        // The app's day card: one headline and what is left by kind under it (B8).
        expect(typeof widget.body.data.breakdown).toBe('string');
        // Today's reminders still to come reach the home picture (titles hidden: plain words); a finished task's don't.
        const soon = new Date(Date.now() + 2 * 60_000);
        const todo = await prisma.todo.create({ data: { userId: user.id, title: 'Call the bank' } });
        const done = await prisma.todo.create({ data: { userId: user.id, title: 'Already done', status: 'complete' } });
        await prisma.reminder.create({ data: { userId: user.id, todoId: todo.id, reminderDate: soon } });
        await prisma.reminder.create({ data: { userId: user.id, todoId: done.id, reminderDate: soon } });
        const withTitles = (await request(app).get('/api/ambient/widget').set('Cookie', authCookie(user))).body.data;
        const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(soon) === new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
        if (sameDay) {
            expect(withTitles.reminders).toEqual([{ at: expect.stringMatching(/^\d{1,2}(:\d\d)? (am|pm)$/), text: 'Call the bank' }]);
            expect((await bearer('/api/ambient/widget?titles=0')).body.data.reminders).toEqual([{ at: expect.any(String), text: 'A reminder' }]);
        }
        // The live lock screen (app 0.4.0): the band for the notification icons, its place in a header.
        const live = await bearer('/api/ambient/wallpaper.png?w=540&h=1170&titles=0&screen=lock&icons=1');
        expect(live.headers['x-ambient-icons']).toMatch(/^[\d.]+,[\d.]+,#[0-9A-F]{8}$/);
        expect(lock.headers['x-ambient-icons']).toBeUndefined();
        // Nothing else: not today, not the docs, not the agent API.
        for (const path of ['/api/today', '/api/docs', '/api/agent/docs']) expect((await bearer(path)).status, path).toBe(403);
        // The addresses: cookie only; the last one is always USB (localhost).
        const list = await request(app).get('/api/ambient/addresses').set('Cookie', authCookie(user));
        expect(list.body.data[list.body.data.length - 1]).toMatchObject({ kind: 'usb' });
        expect((await bearer('/api/ambient/addresses')).status).toBe(403);
    });

    it("reminders ring on the phone (app 0.5.0): the widget lists his own to come; the phone says which it holds (its own token, his own reminders only)", async () => {
        const user = await createTestUser();
        const phone = (await createTestToken(user, ['ambient'], 'Phone app')).token;
        const get = (path: string) => request(app).get(path).set('Authorization', `Bearer ${phone}`);
        const inMin = (m: number) => new Date(Date.now() + m * 60_000);
        const todo = (title: string, over: Record<string, unknown> = {}) => prisma.todo.create({ data: { userId: user.id, title, ...over } });
        const mine = await createTodoReminder({ userId: user.id, todoId: (await todo('Call the bank')).id, reminderDate: inMin(30), title: 'Call the bank' });
        await createTodoReminder({ userId: user.id, todoId: (await todo('Done already', { status: 'complete' })).id, reminderDate: inMin(40), title: 'Done already' });
        await createTodoReminder({ userId: user.id, todoId: (await todo('Too far ahead')).id, reminderDate: inMin(27 * 60), title: 'Too far ahead' });
        // A workspace task's reminder emails its assignees: never on his phone.
        const ws = await prisma.workspace.create({ data: { name: 'Team', ownerId: user.id } });
        const shared = await createTodoReminder({ userId: user.id, todoId: (await todo('Team standup notes', { workspaceId: ws.id })).id, reminderDate: inMin(35), title: 'Team standup notes' });

        const widget = (await get('/api/ambient/widget')).body.data;
        expect(widget.alarms).toEqual([{ id: mine.id, when: mine.reminderDate.toISOString(), text: 'Call the bank' }]);
        // The home picture's reminder says the task's words, not the stored "Reminder: ...".
        expect(widget.reminders?.[0]?.text ?? 'Call the bank').toBe('Call the bank');
        expect((await get('/api/ambient/widget?titles=0')).body.data.alarms).toEqual([{ id: mine.id, when: mine.reminderDate.toISOString(), text: 'A reminder' }]);

        // The phone holds it: only his own pending future reminders of his own tasks are marked.
        const other = await createTestUser();
        const theirs = await createTodoReminder({ userId: other.id, todoId: (await prisma.todo.create({ data: { userId: other.id, title: 'Theirs' } })).id, reminderDate: inMin(30), title: 'Theirs' });
        const held = await request(app).post('/api/ambient/reminders/scheduled').set('Authorization', `Bearer ${phone}`).send({ ids: [mine.id, theirs.id, shared.id] });
        expect(held.status).toBe(200);
        expect(held.body.data).toEqual({ held: 1 });
        expect((await prisma.reminder.findUniqueOrThrow({ where: { id: mine.id } })).phoneAt).toBeInstanceOf(Date);
        expect((await prisma.reminder.findUniqueOrThrow({ where: { id: theirs.id } })).phoneAt).toBeNull();
        expect((await prisma.reminder.findUniqueOrThrow({ where: { id: shared.id } })).phoneAt).toBeNull();
        // Only the phone's own kind of token (ambient) says it; a reader token may not.
        const reader = (await createTestToken(user, ['read'])).token;
        expect((await request(app).post('/api/ambient/reminders/scheduled').set('Authorization', `Bearer ${reader}`).send({ ids: [mine.id] })).status).toBe(403);
        expect((await request(app).post('/api/ambient/reminders/scheduled').set('Authorization', `Bearer ${phone}`).send({ ids: 'x' })).status).toBe(400);
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
