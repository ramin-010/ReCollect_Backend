// The buddy's memory (BUDDY_MEMORY_PLAN B1): an agent's note becomes a memory at once (a repeat is
// "seen again", one he marked wrong is not saved, a secret never lands); checkpoint's learned;
// search; his own changes win over agents; an agent's forget is undone; the brief carries pinned and
// tagged memories (private ones only when pinned); paused saves nothing; tokens need their scopes.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

const remember = (chat: ReturnType<typeof asAgent>, body: Record<string, unknown>) => chat.post('/api/buddy/remember', body);

describe('/api/buddy memories', () => {
    it('an agent remembers: a new memory with its note; a repeat is seen again; a secret is scrubbed; /you lists it', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'study-chat');
        const first = await remember(chat, { text: 'Prefers blunt pushback over agreement', kind: 'preference', tags: ['Recollect'] });
        expect(first.status).toBe(201);
        expect(first.body.data.notes[0]).toMatchObject({ status: 'saved', memory: { text: 'Prefers blunt pushback over agreement', kind: 'preference', sensitivity: 'open', lasting: true, byUser: false, source: 'agent', agentName: 'study-chat', tags: ['recollect'], seenCount: 1 } });

        const again = await remember(chat, { text: 'prefers BLUNT pushback, over agreement!', kind: 'preference' });
        expect(again.status).toBe(200);
        expect(again.body.data.notes[0]).toMatchObject({ status: 'seen', memory: { _id: first.body.data.notes[0].memory._id, seenCount: 2 } });
        expect(await prisma.observation.count({ where: { userId: user.id } })).toBe(2);

        // A worry is private by default, and a working memory; a key in the text never lands.
        const worry = await remember(chat, { text: 'Worried the job search is slow; key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 pasted', kind: 'state' });
        expect(worry.body.data.notes[0].memory).toMatchObject({ sensitivity: 'private', lasting: false, kind: 'state' });
        expect(worry.body.data.notes[0].memory.text).toContain('[secret]');
        expect(JSON.stringify(await prisma.observation.findMany({ where: { userId: user.id } }))).not.toContain('sk-ant-');

        const you = (await api(user).get('/api/buddy/you')).body.data;
        expect(you.counts).toMatchObject({ active: 2, lasting: 1, working: 1, notes: 3 });
        expect(you.memories.map((m: { kind: string }) => m.kind).sort()).toEqual(['preference', 'state']);
        expect(you.settings).toMatchObject({ enabled: false, paused: false, name: null, tone: 'candid', capUsd: 25 });
    });

    it('checkpoint learned: notes tagged with the session’s project, counted in the answer', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'build-chat');
        const put = await chat.put('/api/sessions/by-key/s_test_learned', {
            title: 'Built the memory tables',
            project: 'second_brain',
            learned: [{ text: 'Works best late at night on building' }, { text: 'Wants a buddy that knows his day', kind: 'aim' }, { text: '   ' }],
        });
        expect(put.status).toBe(200);
        expect(put.body.data.learned).toEqual({ saved: 2, seen: 0, skipped: 1, paused: false });
        const memories = await prisma.memory.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        expect(memories.map((m) => [m.kind, m.tags])).toEqual([
            ['fact', ['second_brain']],
            ['aim', ['second_brain']],
        ]);
        expect((await prisma.observation.findFirstOrThrow({ where: { userId: user.id } })).sessionKey).toBe('s_test_learned');
        expect((await chat.put('/api/sessions/by-key/s_test_learned', { learned: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }] })).status).toBe(400);
    });

    it('search finds words and word starts; status and kind filter', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token);
        await remember(chat, { text: 'Studies system design after 9 pm on weekdays', kind: 'fact' });
        await remember(chat, { text: 'Idea: a tool that turns notes into interview drills', kind: 'idea' });
        const hits = (await chat.get('/api/buddy/memories?q=interviews')).body.data;
        expect(hits.map((m: { kind: string }) => m.kind)).toEqual(['idea']);
        expect((await chat.get('/api/buddy/memories?q=desig')).body.data).toHaveLength(1);
        expect((await chat.get('/api/buddy/memories?kind=idea')).body.data).toHaveLength(1);
        expect((await chat.get('/api/buddy/memories?q=nothing+like+this')).body.data).toEqual([]);
    });

    it('his word wins: an agent cannot forget his memory; one he marked wrong is not learned again; an agent’s forget is undone', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'chat');
        const mine = (await api(user).post('/api/buddy/memories', { text: 'Never schedule anything on Sunday mornings', kind: 'preference' })).body.data;
        expect(mine).toMatchObject({ byUser: true, source: 'app' });
        expect((await chat.post(`/api/buddy/memories/${mine._id}/close`, {})).status).toBe(403);

        const theirs = (await remember(chat, { text: 'Likes long explanations', kind: 'preference' })).body.data.notes[0].memory;
        expect((await api(user).patch(`/api/buddy/memories/${theirs._id}`, { status: 'wrong' })).body.data).toMatchObject({ status: 'wrong', byUser: true });
        expect((await remember(chat, { text: 'likes long explanations', kind: 'preference' })).body.data.notes[0]).toMatchObject({ status: 'wrong' });
        expect(await prisma.memory.count({ where: { userId: user.id } })).toBe(2);

        const other = (await remember(chat, { text: 'Is learning Go', kind: 'fact' })).body.data.notes[0].memory;
        const closed = await chat.post(`/api/buddy/memories/${other._id}/close`, { reason: 'He stopped' });
        expect(closed.status).toBe(200);
        expect(closed.body.data.memory).toMatchObject({ status: 'closed', closeReason: 'He stopped' });
        expect((await chat.post(`/api/buddy/memories/${other._id}/close`, {})).status).toBe(409);
        const edit = await prisma.agentEdit.findFirstOrThrow({ where: { userId: user.id, kind: 'memory_close' } });
        expect((await api(user).post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(200);
        expect((await prisma.memory.findUniqueOrThrow({ where: { id: other._id } })).status).toBe('active');

        // Forget for good: the notes go too.
        expect((await api(user).delete(`/api/buddy/memories/${other._id}`)).body.data).toEqual({ deleted: true, notes: 1 });
        expect(await prisma.observation.count({ where: { memoryId: other._id } })).toBe(0);
    });

    it('the brief: pinned (even private) and this project’s memories; other private ones stay out', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token);
        await remember(chat, { text: 'Uses Postgres full-text, no vector store', kind: 'decision', tags: ['second_brain'] });
        await remember(chat, { text: 'Keeps replies short: bottom line first', kind: 'preference' });
        const worry = (await remember(chat, { text: 'Anxious about money this month', kind: 'state' })).body.data.notes[0].memory;
        const elsewhere = await chat.get('/api/brief');
        // No portrait yet: the lasting open memories fill in; the private worry stays out.
        expect(elsewhere.body.data.buddy).toMatchObject({ who: null, heading: null, now: null, note: null, followUp: null });
        expect(elsewhere.body.data.buddy.memories.map((m: { text: string }) => m.text).sort()).toEqual(['Keeps replies short: bottom line first', 'Uses Postgres full-text, no vector store']);

        await api(user).patch(`/api/buddy/memories/${worry._id}`, { pinned: true });
        const here = (await chat.get('/api/brief?project=second_brain')).body.data.buddy.memories;
        expect(here[0]).toEqual({ kind: 'state', text: 'Anxious about money this month', pinned: true });
        expect(here.map((m: { text: string }) => m.text)).toContain('Uses Postgres full-text, no vector store');
    });

    it('paused: nothing is saved (remember answers paused; checkpoint still saves the session)', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token);
        expect((await api(user).patch('/api/buddy/settings', { paused: true, name: '  Sol  ', tone: 'gentle' })).body.data).toMatchObject({ paused: true, name: 'Sol', tone: 'gentle' });
        expect((await remember(chat, { text: 'Anything at all' })).body.data).toEqual({ paused: true, notes: [] });
        const put = await chat.put('/api/sessions/by-key/s_paused', { title: 'A session', learned: [{ text: 'Something' }] });
        expect(put.body.data.learned).toEqual({ saved: 0, seen: 0, skipped: 1, paused: true });
        expect(await prisma.memory.count({ where: { userId: user.id } })).toBe(0);
        expect((await api(user).patch('/api/buddy/settings', { capUsd: 500 })).status).toBe(400);
    });

    it('tokens: remember and forget need sessions:write, reading needs read; the app-only routes refuse tokens; another user’s memory is 404', async () => {
        const user = await createTestUser();
        const readOnly = asAgent((await createTestToken(user, ['read'])).token);
        const writer = asAgent((await createTestToken(user, ['sessions:write'])).token);
        expect((await readOnly.post('/api/buddy/remember', { text: 'x y z' })).status).toBe(403);
        expect((await writer.get('/api/buddy/memories')).status).toBe(403);
        expect((await readOnly.get('/api/buddy/memories')).status).toBe(200);
        const full = asAgent((await createTestToken(user)).token);
        for (const path of ['/api/buddy/you', '/api/buddy/settings', '/api/buddy/export']) expect((await full.get(path)).status, path).toBe(403);
        expect((await full.post('/api/buddy/memories', { text: 'x', kind: 'fact' })).status).toBe(403);
        expect((await full.patch('/api/buddy/settings', { paused: true })).status).toBe(403);
        const stranger = await createTestUser();
        const theirs = (await api(stranger).post('/api/buddy/memories', { text: 'Not yours', kind: 'fact' })).body.data;
        expect((await api(user).patch(`/api/buddy/memories/${theirs._id}`, { pinned: true })).status).toBe(404);
        expect((await writer.post(`/api/buddy/memories/${theirs._id}/close`, {})).status).toBe(404);
    });

    it('export holds every memory and note', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token);
        await remember(chat, { text: 'Runs on his phone hotspot', kind: 'fact' });
        const res = await api(user).get('/api/buddy/export');
        expect(res.headers['content-disposition']).toMatch(/recollect-buddy-\d{4}-\d{2}-\d{2}\.json/);
        expect(res.body.data.memories).toHaveLength(1);
        expect(res.body.data.notes).toEqual([expect.objectContaining({ text: 'Runs on his phone hotspot', source: 'agent', memoryId: res.body.data.memories[0]._id })]);
    });
});
