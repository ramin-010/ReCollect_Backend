// EASY_SETUP_PLAN (11-23): a PC signs in by approval (no copied token); folder rules live on the server (what a folder
// is and what is logged there; a new folder asks once); the chat decides what it is (Personal, Study, Work) and the
// folder is only its default: the agent, the user's own words and the app can each say so, the more trusted choice
// wins, and a folder's change moves only the chats that follow it.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const pub = () => request(app);

describe('a PC signs in by approval (EASY_SETUP_PLAN §3.2)', () => {
    it('start → pending → approve on the page → the poll gets a token once; it works; it ends itself', async () => {
        const user = await createTestUser({ name: 'Asha Verma' });
        const start = await pub().post('/api/setup/start').send({ device: 'LAPTOP-7 (Windows)' });
        expect(start.status).toBe(201);
        const s = start.body.data;
        expect(s.userCode).toMatch(/^[B-DF-HJ-NP-TV-XZ]{4}-[B-DF-HJ-NP-TV-XZ]{4}$/);
        expect(s.verifyUrlComplete).toBe(`${s.verifyUrl}?code=${s.userCode}`);
        expect(s).toMatchObject({ interval: 3, expiresIn: 600 });
        // Only the hash of the device code is kept.
        expect(await prisma.deviceSignIn.count({ where: { deviceCodeHash: s.deviceCode } })).toBe(0);

        expect((await pub().post('/api/setup/poll').send({ deviceCode: s.deviceCode })).body.data).toEqual({ status: 'pending' });
        // Polling faster than the interval is told to slow down.
        expect((await pub().post('/api/setup/poll').send({ deviceCode: s.deviceCode })).body.data).toEqual({ status: 'slow_down' });

        // The page: signed in, it shows the computer as it called itself; the code may come typed in lower case.
        const page = await api(user).get(`/api/setup/request?code=${s.userCode.toLowerCase()}`);
        expect(page.body.data).toMatchObject({ code: s.userCode, device: 'LAPTOP-7 (Windows)', status: 'waiting' });
        expect((await api(user).post('/api/setup/answer', { code: s.userCode, allow: true })).body.data.status).toBe('approved');

        await prisma.deviceSignIn.updateMany({ data: { lastPollAt: null } });
        const got = (await pub().post('/api/setup/poll').send({ deviceCode: s.deviceCode })).body.data;
        expect(got).toMatchObject({ status: 'approved', scopes: ['read', 'docs:write', 'learning:write', 'sessions:write', 'tasks:write'], account: { name: 'Asha' } });
        expect(got.token).toMatch(/^rcl_/);
        // Once: the next poll (a lost answer, a copy) gets nothing.
        await prisma.deviceSignIn.updateMany({ data: { lastPollAt: null } });
        expect((await pub().post('/api/setup/poll').send({ deviceCode: s.deviceCode })).body.data.status).toBe('expired');
        expect((await api(user).get(`/api/setup/request?code=${s.userCode}`)).body.data.status).toBe('used');

        const pc = asAgent(got.token, 'Claude Code');
        expect((await pc.get('/api/setup/me')).body.data).toMatchObject({ name: 'Asha', tokenName: 'LAPTOP-7 (Windows) · kaaga-setup', setup: 1 });
        // Settings › Agents lists it as a token of theirs.
        expect((await api(user).get('/api/tokens')).body.data.map((t: { name: string }) => t.name)).toContain('LAPTOP-7 (Windows) · kaaga-setup');

        // kaaga-setup remove: the token ends itself, and stops working.
        expect((await pc.post('/api/setup/disconnect')).body.data).toEqual({ ended: true });
        expect((await pc.get('/api/setup/me')).status).toBe(401);
        // A cookie can't use the PC's door to end anything.
        expect((await api(user).post('/api/setup/disconnect')).status).toBe(400);
    });

    it('deny, run out, unknown codes; the page is cookie only; another account’s request reads as used', async () => {
        const user = await createTestUser();
        const other = await createTestUser();
        const a = (await pub().post('/api/setup/start').send({ device: 'x'.repeat(150) })).body.data;
        expect((await api(user).get(`/api/setup/request?code=${a.userCode}`)).body.data.device).toHaveLength(60);
        expect((await api(user).post('/api/setup/answer', { code: a.userCode, allow: false })).body.data.status).toBe('denied');
        expect((await pub().post('/api/setup/poll').send({ deviceCode: a.deviceCode })).body.data.status).toBe('denied');
        // The first answer stands.
        expect((await api(user).post('/api/setup/answer', { code: a.userCode, allow: true })).body.data.status).toBe('denied');
        expect((await api(other).get(`/api/setup/request?code=${a.userCode}`)).body.data.status).toBe('used');

        const b = (await pub().post('/api/setup/start').send({})).body.data;
        await prisma.deviceSignIn.updateMany({ where: { deviceCodeHash: { not: '' }, deniedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
        expect((await api(user).post('/api/setup/answer', { code: b.userCode, allow: true })).status).toBe(410);
        expect((await pub().post('/api/setup/poll').send({ deviceCode: b.deviceCode })).body.data.status).toBe('expired');

        expect((await api(user).get('/api/setup/request?code=BCDF-GHJK')).status).toBe(404);
        expect((await pub().post('/api/setup/poll').send({ deviceCode: 'nope' })).body.data.status).toBe('expired');
        // A token can't approve a PC (the page is the person's own, signed in).
        const agent = asAgent((await createTestToken(user)).token);
        expect((await agent.get(`/api/setup/request?code=${b.userCode}`)).status).toBe(403);
        expect((await agent.post('/api/setup/answer', { code: b.userCode, allow: true })).status).toBe(403);
    });
});

describe('folder rules on the server (EASY_SETUP_PLAN §3.4-§3.5)', () => {
    it('the rules list what each folder is and what is logged; a folder made by a checkpoint is not decided; set_folder decides it', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'Claude Code');
        // A PC's first guess (the hook's rule) decides a new folder; a checkpoint naming a folder does not.
        await chat.put('/api/sessions/by-key/cc_one', { source: 'hook', kindIfNew: 'build', project: 'erp-workspace', projectKind: 'work', startedAt: ago(5), minutes: 5 });
        await chat.put('/api/sessions/by-key/s_two', { project: 'side-thing', title: 'Looked around' });
        let rules = (await chat.get('/api/projects/rules')).body.data;
        expect(rules.newFolders).toBe('ask');
        expect(rules.folders).toEqual([
            { key: 'erp-workspace', name: 'erp-workspace', kind: 'work', tracking: 'light', decided: true },
            { key: 'side-thing', name: 'side-thing', kind: 'personal', tracking: 'full', decided: false },
        ]);

        // Their answer to the one question (set_folder): study; a folder never seen is made with its own spelling.
        const answered = await chat.put('/api/projects/by-key/side-thing', { kind: 'study' });
        expect(answered.body.data).toMatchObject({ kind: 'study', tracking: 'full', trackingSet: false, kindSetBy: 'chat' });
        const fresh = await chat.put('/api/projects/by-key/notes-app', { kind: 'personal', tracking: 'off', name: 'Notes-App' });
        expect(fresh.body.data).toMatchObject({ key: 'notes-app', name: 'Notes-App', kind: 'personal', tracking: 'off', trackingSet: true, kindSetBy: 'chat' });
        expect((await chat.put('/api/projects/by-key/notes-app', {})).status).toBe(400);
        rules = (await chat.get('/api/projects/rules')).body.data;
        expect(rules.folders.map((f: { key: string; decided: boolean; tracking: string }) => [f.key, f.decided, f.tracking])).toEqual([
            ['erp-workspace', true, 'light'],
            ['notes-app', true, 'off'],
            ['side-thing', true, 'full'],
        ]);

        // The app: what is logged (null goes back to the kind's default), and the default for new folders.
        const erp = await prisma.project.findFirstOrThrow({ where: { userId: user.id, key: 'erp-workspace' } });
        expect((await api(user).patch(`/api/projects/${erp.id}`, { tracking: 'full' })).body.data).toMatchObject({ tracking: 'full', trackingSet: true, kindSetBy: 'app' });
        expect((await api(user).patch(`/api/projects/${erp.id}`, { tracking: null })).body.data).toMatchObject({ tracking: 'light', trackingSet: false });
        expect((await api(user).patch('/api/learning/settings', { newFolders: 'personal' })).body.data.newFolders).toBe('personal');
        expect((await chat.get('/api/projects/rules')).body.data.newFolders).toBe('personal');
        // Agents may not change the default (the person's own setting).
        expect((await chat.patch('/api/learning/settings', { newFolders: 'off' })).status).toBe(403);
    });

    it('a folder nobody decided (a chat’s checkpoint made it) takes a PC’s first guess, its past with it; a decided one keeps its own', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'Claude Code');
        await chat.put('/api/sessions/by-key/s_one', { project: 'client-x', title: 'Looked at the API' });
        expect(await prisma.project.findFirstOrThrow({ where: { userId: user.id, key: 'client-x' } })).toMatchObject({ kind: 'personal', kindSetBy: null });
        await chat.put('/api/sessions/by-key/cc_two', { source: 'hook', kindIfNew: 'build', project: 'client-x', projectKind: 'work', startedAt: ago(5), minutes: 5 });
        expect(await prisma.project.findFirstOrThrow({ where: { userId: user.id, key: 'client-x' } })).toMatchObject({ kind: 'work', kindSetBy: 'pc' });
        expect((await prisma.workSession.findMany({ where: { userId: user.id }, orderBy: { key: 'asc' }, select: { key: true, area: true } })).map((r) => `${r.key}:${r.area}`)).toEqual(['cc_two:work', 's_one:work']);
        // Decided now: a later PC's other guess changes nothing.
        await chat.put('/api/sessions/by-key/cc_three', { source: 'hook', kindIfNew: 'build', project: 'client-x', projectKind: 'personal', startedAt: ago(5), minutes: 5 });
        expect(await prisma.project.findFirstOrThrow({ where: { userId: user.id, key: 'client-x' } })).toMatchObject({ kind: 'work', kindSetBy: 'pc' });
    });

    it('an agent’s update_project of what is logged is logged, and Undo puts it back', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'Claude Code');
        const p = (await chat.put('/api/projects/by-key/blog', { kind: 'personal' })).body.data;
        const res = await chat.patch(`/api/projects/${p._id}`, { tracking: 'light' });
        expect(res.status).toBe(200);
        const edit = await prisma.agentEdit.findFirstOrThrow({ where: { userId: user.id, kind: 'project_update' } });
        expect(edit.summary).toBe('Changed the project "blog": set what is logged there to the time only');
        expect((await api(user).post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(200);
        expect(await prisma.project.findUniqueOrThrow({ where: { id: p._id } })).toMatchObject({ tracking: null });
    });
});

describe('the chat decides (EASY_SETUP_PLAN §7)', () => {
    it('set_chat marks a chat; a weaker choice can’t undo a stronger one; the app’s switch wins; a folder flip leaves marked chats', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'Claude Code');
        const put = (key: string, extra: Record<string, unknown> = {}) =>
            chat.put(`/api/sessions/by-key/${key}`, { source: 'hook', kindIfNew: 'build', project: 'erp-workspace', projectKind: 'work', startedAt: ago(3), minutes: 30, ...extra });
        await put('cc_a');
        await put('cc_b');
        await put('cc_c');

        // The agent sees system design study in a work folder.
        const marked = await chat.patch('/api/sessions/by-key/cc_a/kind', { kind: 'study', by: 'agent' });
        expect(marked.body.data).toMatchObject({ changed: true, session: { chatKind: 'study', area: 'personal', kind: 'study', kindSetBy: 'agent' } });
        // Their own word outweighs it; the agent can't take theirs back.
        expect((await chat.patch('/api/sessions/by-key/cc_a/kind', { kind: 'personal', by: 'user' })).body.data.session).toMatchObject({ chatKind: 'personal', kindSetBy: 'chat' });
        expect((await chat.patch('/api/sessions/by-key/cc_a/kind', { kind: 'work', by: 'agent' })).body.data).toMatchObject({ changed: false, session: { chatKind: 'personal' } });
        expect((await chat.patch('/api/sessions/by-key/s_none/kind', { kind: 'work', by: 'agent' })).status).toBe(404);

        // The hook closing it again keeps what the chat is.
        expect((await put('cc_a', { minutes: 45 })).body.data.session).toMatchObject({ chatKind: 'personal', area: 'personal', minutes: 45 });

        // The app's switch (the session row) outweighs every chat.
        const b = await prisma.workSession.findFirstOrThrow({ where: { userId: user.id, key: 'cc_b' } });
        expect((await api(user).patch(`/api/sessions/${b.id}`, { chatKind: 'study' })).body.data).toMatchObject({ chatKind: 'study', kindSetBy: 'app' });
        expect((await chat.patch('/api/sessions/by-key/cc_b/kind', { kind: 'work', by: 'user' })).body.data.changed).toBe(false);

        // The folder becomes personal: only cc_c (it follows its folder) moves.
        const erp = await prisma.project.findFirstOrThrow({ where: { userId: user.id, key: 'erp-workspace' } });
        await api(user).patch(`/api/projects/${erp.id}`, { kind: 'personal' });
        const rows = await prisma.workSession.findMany({ where: { userId: user.id }, orderBy: { key: 'asc' }, select: { key: true, area: true, kind: true, kindSetBy: true } });
        expect(rows).toEqual([
            { key: 'cc_a', area: 'personal', kind: 'build', kindSetBy: 'chat' },
            { key: 'cc_b', area: 'personal', kind: 'study', kindSetBy: 'app' },
            { key: 'cc_c', area: 'personal', kind: 'build', kindSetBy: 'folder' },
        ]);
        // And back to work: the marked chats stay theirs.
        await api(user).patch(`/api/projects/${erp.id}`, { kind: 'work' });
        expect((await prisma.workSession.findMany({ where: { userId: user.id }, orderBy: { key: 'asc' }, select: { area: true } })).map((r) => r.area)).toEqual(['personal', 'personal', 'work']);
    });

    it('a part of a chat the hook split arrives with its kind; a checkpoint carries a kind set before its first write', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'Claude Code');
        const part = await chat.put('/api/sessions/by-key/cc_x:k1', { source: 'hook', kindIfNew: 'build', project: 'erp-workspace', projectKind: 'work', startedAt: ago(3), minutes: 20, chatKind: 'study', kindBy: 'chat' });
        expect(part.body.data.session).toMatchObject({ chatKind: 'study', area: 'personal', kind: 'study', kindSetBy: 'chat', project: { key: 'erp-workspace' } });
        const cp = await chat.put('/api/sessions/by-key/s_q', { title: 'Consistent hashing', project: 'erp-workspace', chatKind: 'study', kindBy: 'agent' });
        expect(cp.body.data.session).toMatchObject({ chatKind: 'study', kindSetBy: 'agent' });
        // Study counts as progress (personal), the work folder's own time does not.
        const stand = (await api(user).get('/api/mirror/stand')).body.data;
        expect(stand.periods.week.current.totalMinutes).toBeGreaterThanOrEqual(20);
    });

    it('their own word decides whose a chat’s words are: study in a work folder is theirs, an agent’s guess is not', async () => {
        const user = await createTestUser();
        const hook = asAgent((await createTestToken(user, ['read', 'sessions:write'], 'Claude Code hook')).token, 'Claude Code hook');
        await prisma.project.create({ data: { userId: user.id, key: 'erp-workspace', name: 'erp-workspace', kind: 'work', kindSetBy: 'app' } });
        const send = (sessionKey: string, chatWord?: { kind: string; by: string }) =>
            hook.post('/api/buddy/words', { sessionKey, seq: 1, project: 'erp-workspace', messages: [{ text: 'I want to get better at system design before my interviews' }], ...(chatWord ? { chat: chatWord } : {}) });
        const officeOf = async (sessionKey: string) => (await prisma.buddyChunk.findFirstOrThrow({ where: { userId: user.id, sessionKey } })).office;
        expect((await send('cc_w1')).status).toBe(202);
        await send('cc_w2', { kind: 'study', by: 'agent' });
        await send('cc_w3', { kind: 'study', by: 'chat' });
        await send('cc_w5', { kind: 'work', by: 'agent' });
        expect([await officeOf('cc_w1'), await officeOf('cc_w2'), await officeOf('cc_w3'), await officeOf('cc_w5')]).toEqual([true, true, false, true]);
        expect((await send('cc_w4', { kind: 'bogus', by: 'chat' })).status).toBe(400);
    });
});
