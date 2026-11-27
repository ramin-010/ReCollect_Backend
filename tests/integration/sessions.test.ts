// The record (SYNC_SPINE_SPEC 1.2): sessions written by a study chat (checkpoint, again and again),
// a Claude Code hook (kindIfNew, a project), or by hand; weak spots on topics, both ways with
// Recall; the rhythm; who may do what.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { newSessionKey } from '../../src/services/learningDb/sessions.service';
import { createTestUser } from '../helpers/auth';
import { api, createChainRows, createSubjectRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

async function planned(user: { id: string }, subjectId: string, titles: string[]) {
    return (await api(user).post(`/api/subjects/${subjectId}/path`, { titles })).body.data.path.topics as Array<{ _id: string; title: string }>;
}

describe('a study chat checkpoints as it goes', () => {
    it('the first checkpoint makes the session (minutes from the key), later ones change it; a topic change is logged once', async () => {
        const user = await createTestUser();
        const sys = await createSubjectRow(user.id, 'System Design');
        const [caching] = await planned(user, sys.id, ['Caching']);
        const { token } = await createTestToken(user);
        const chat = asAgent(token, 'study-chat');
        const key = newSessionKey(new Date(Date.now() - 20 * 60_000));

        const first = await chat.put(`/api/sessions/by-key/${key}`, { topicId: caching!._id, title: 'Cache-aside and stampedes', topicStatus: 'in_progress' });
        expect(first.status).toBe(200);
        expect(first.body.data.session).toMatchObject({ key, kind: 'study', title: 'Cache-aside and stampedes', source: 'agent', agentName: 'study-chat', subject: { _id: sys.id }, topic: { _id: caching!._id } });
        expect(first.body.data.session.minutes).toBeGreaterThanOrEqual(19);
        expect(first.body.data.topic).toMatchObject({ status: 'in_progress' });
        expect(first.body.data.topicEditId).toEqual(expect.any(String));

        // Second checkpoint: a quiz score and two weak spots; the title stays; the same status logs nothing.
        const second = await chat.put(`/api/sessions/by-key/${key}`, { score: { done: 7, total: 10 }, weakSpots: ['write-behind vs write-through', 'TTL jitter'], topicStatus: 'in_progress' });
        expect(second.body.data.session).toMatchObject({ title: 'Cache-aside and stampedes', score: { done: 7, total: 10 } });
        expect(second.body.data.weakSpots.map((w: { text: string }) => w.text)).toEqual(['write-behind vs write-through', 'TTL jitter']);
        expect(second.body.data.topicEditId).toBeNull();

        // The end: done, a next step; one weak spot cleared by its text (any case).
        const last = await chat.put(`/api/sessions/by-key/${key}`, { topicStatus: 'done', nextStep: 'Consistent hashing next', cleared: ['ttl JITTER'] });
        expect(last.body.data.topic).toMatchObject({ status: 'done', nextStep: 'Consistent hashing next' });
        expect(last.body.data.weakSpots.map((w: { text: string }) => w.text)).toEqual(['write-behind vs write-through']);
        expect(await prisma.workSession.count({ where: { userId: user.id } })).toBe(1);
        const edits = await prisma.agentEdit.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        expect(edits.map((e) => e.summary)).toEqual(['Started topic "Caching"', 'Finished topic "Caching"']);

        // Undo of "Finished" puts the topic back in progress; the session stays.
        expect((await api(user).post(`/api/agent/edits/${edits[1]!.id}/undo`)).status).toBe(200);
        expect(await prisma.topic.findUniqueOrThrow({ where: { id: caching!._id } })).toMatchObject({ status: 'in_progress', nextStep: null });

        // The path shows the open weak spot on the topic.
        const path = (await api(user).get(`/api/subjects/${sys.id}/path`)).body.data;
        expect(path.topics[0].weakSpots.map((w: { text: string }) => w.text)).toEqual(['write-behind vs write-through']);
    });

    it('refuses what does not fit, before writing anything', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token);
        expect((await chat.put('/api/sessions/by-key/has%20space', { title: 'x' })).status).toBe(400);
        expect((await chat.put('/api/sessions/by-key/s_ok', { weakSpots: ['x'] })).body.message).toMatch(/need a topicId or a subject/);
        expect((await chat.put('/api/sessions/by-key/s_ok', { topicId: 'nope' })).status).toBe(400);
        expect((await chat.put('/api/sessions/by-key/s_ok', { score: { done: 9, total: 5 } })).status).toBe(400);
        expect(await prisma.workSession.count({ where: { userId: user.id } })).toBe(0);
    });
});

describe('a Claude Code hook logs coding sessions', () => {
    it('kindIfNew build, a project made from the folder, commits; a chat’s session in that folder keeps its kind and writer', async () => {
        const user = await createTestUser();
        const { token } = await createTestToken(user, ['read', 'sessions:write'], 'Claude Code hook');
        const hook = asAgent(token, 'Claude Code hook');
        const started = new Date(Date.now() - 90 * 60_000).toISOString();

        const res = await hook.put('/api/sessions/by-key/cc_0b2f3c4d', {
            kindIfNew: 'build',
            source: 'hook',
            project: 'second_brain',
            startedAt: started,
            endedAt: new Date().toISOString(),
            minutes: 72,
            details: { branch: 'main', commits: ['Paths in the Docs library', 'Next up on Home'] },
        });
        expect(res.status).toBe(200);
        expect(res.body.data.session).toMatchObject({ kind: 'build', minutes: 72, source: 'hook', title: 'Paths in the Docs library', project: { key: 'second_brain', name: 'second_brain' } });
        expect(res.body.data.session.details).toEqual({ branch: 'main', commits: ['Paths in the Docs library', 'Next up on Home'] });

        // A study chat in that folder wrote its own session under the hook's key first.
        const chat = asAgent((await createTestToken(user)).token, 'study-chat');
        await chat.put('/api/sessions/by-key/cc_chat1', { title: 'Graphs: BFS', score: { done: 3, total: 4 } });
        const closed = await hook.put('/api/sessions/by-key/cc_chat1', { kindIfNew: 'build', source: 'hook', project: 'second_brain', minutes: 40 });
        expect(closed.body.data.session).toMatchObject({ kind: 'study', title: 'Graphs: BFS', minutes: 40, source: 'agent', agentName: 'study-chat' });

        // The project lists its last session; a hook token can't write anything else.
        const projects = (await api(user).get('/api/projects')).body.data;
        expect(projects).toEqual([expect.objectContaining({ key: 'second_brain', sessions: 2 })]);
        expect((await hook.post('/api/focus', { text: 'x' })).status).toBe(403);
        expect((await hook.post('/api/sessions', { title: 'x' })).status).toBe(403);
        const readOnly = asAgent((await createTestToken(user, ['read'])).token);
        expect((await readOnly.put('/api/sessions/by-key/cc_x', { title: 'x' })).status).toBe(403);
    });

    it('titles: the first commit, else the first prompt; a placeholder gives way; a coding chat keeps the project’s next step', async () => {
        const user = await createTestUser();
        const hook = asAgent((await createTestToken(user, ['read', 'sessions:write'], 'Claude Code hook')).token, 'Claude Code hook');
        const chat = asAgent((await createTestToken(user)).token, 'Claude Code');
        const close = (key: string, extra: Record<string, unknown> = {}) => hook.put(`/api/sessions/by-key/${key}`, { kindIfNew: 'build', source: 'hook', project: 'second_brain', minutes: 30, ...extra });

        expect((await close('cc_a', { titleIfNew: 'Fix the hook sweep', details: { commits: ['Hook: reopen a swept session'] } })).body.data.session.title).toBe('Hook: reopen a swept session');
        expect((await close('cc_b', { titleIfNew: 'Fix the hook sweep', details: { commits: [] } })).body.data.session.title).toBe('Fix the hook sweep');
        expect((await close('cc_c')).body.data.session.title).toBe('Worked on second_brain');

        // A coding chat checkpoints only a next step: a build row with a placeholder title; the hook's
        // first prompt replaces the placeholder, and the project's next step is the chat's.
        const first = await chat.put('/api/sessions/by-key/cc_d', { project: 'second_brain', nextStep: 'Wire the week into Home' });
        expect(first.body.data.session).toMatchObject({ kind: 'build', title: 'Worked on second_brain' });
        expect((await close('cc_d', { titleIfNew: 'Build the week' })).body.data.session).toMatchObject({ kind: 'build', title: 'Build the week', minutes: 30 });
        // A later checkpoint without the project still moves the project's next step.
        await chat.put('/api/sessions/by-key/cc_d', { nextStep: 'Screens for the week' });
        expect((await api(user).get('/api/projects')).body.data[0]).toMatchObject({ key: 'second_brain', nextStep: 'Screens for the week' });
        // A real title from a chat is never replaced.
        await chat.put('/api/sessions/by-key/cc_e', { project: 'second_brain', title: 'Refactor the brief' });
        expect((await close('cc_e', { titleIfNew: 'something else' })).body.data.session.title).toBe('Refactor the brief');
    });
});

describe('kinds, minutes and links when a write leaves them out (LOOP_COMPLETE_SPEC S1.1)', () => {
    it('a new row is practice with a problem, study with a topic or score, build with a project or a cc_ key, else study', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token);
        const sys = await createSubjectRow(user.id, 'DSA');
        const kindOf = async (key: string, body: Record<string, unknown>) => (await chat.put(`/api/sessions/by-key/${key}`, body)).body.data.session.kind;
        expect(await kindOf('s_p', { problem: 'Two sum', outcome: 'alone' })).toBe('practice');
        expect(await kindOf('s_t', { title: 'Graphs', subjectId: sys.id })).toBe('study');
        expect(await kindOf('s_q', { title: 'Quiz', score: { done: 2, total: 3 } })).toBe('study');
        expect(await kindOf('s_b', { title: 'Refactor', project: 'recollect' })).toBe('build');
        expect(await kindOf('cc_x', { title: 'Refactor' })).toBe('build');
        expect(await kindOf('s_x', { title: 'Something' })).toBe('study');
    });

    it('minutes: since the key at first (at most 45), then the time since the last write (at most 30 each)', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token);
        const key = newSessionKey(new Date(Date.now() - 3 * 3600_000));
        expect((await chat.put(`/api/sessions/by-key/${key}`, { title: 'Long chat' })).body.data.session.minutes).toBe(45);
        expect((await chat.put(`/api/sessions/by-key/${key}`, { title: 'Long chat' })).body.data.session.minutes).toBe(45);
        // Lunch: the last write was two hours ago; only 30 minutes are added.
        await prisma.$executeRaw`UPDATE "WorkSession" SET "updatedAt" = now() - interval '2 hours' WHERE "key" = ${key}`;
        expect((await chat.put(`/api/sessions/by-key/${key}`, { title: 'Long chat' })).body.data.session.minutes).toBe(75);
        // Ten minutes later: ten more.
        await prisma.$executeRaw`UPDATE "WorkSession" SET "updatedAt" = now() - interval '10 minutes' WHERE "key" = ${key}`;
        expect((await chat.put(`/api/sessions/by-key/${key}`, { title: 'Long chat' })).body.data.session.minutes).toBe(85);
    });

    it('a chat that goes on into a new day writes that day its own row, carrying what the chat is (11-26)', async () => {
        const user = await createTestUser();
        const sys = await createSubjectRow(user.id, 'System Design');
        const [web] = await planned(user, sys.id, ['How the web works']);
        const chat = asAgent((await createTestToken(user)).token, 'study-chat');
        const key = newSessionKey(new Date(Date.now() - 30 * 60_000));
        const first = (await chat.put(`/api/sessions/by-key/${key}`, { topicId: web!._id, title: 'DNS and TCP' })).body.data.session;
        // Yesterday's chat, last written an hour ago, marked work by the user (to see that it carries).
        await prisma.$executeRaw`UPDATE "WorkSession" SET "day" = "day" - 1, "updatedAt" = now() - interval '1 hour', "area" = 'work', "kindSetBy" = 'chat' WHERE "key" = ${key}`;
        const before = await prisma.workSession.findUniqueOrThrow({ where: { id: first._id } });

        const write = (await chat.put(`/api/sessions/by-key/${key}`, { nextStep: 'Traceroute in your own words' })).body.data;
        const today = write.session;
        // TOOL_ACCESS_PLAN §12.5: the answer says a new day's part began, and what the day the chat began keeps.
        expect(write.dayPart).toEqual({ day: today.day, began: before.day.toISOString().slice(0, 10), beganMinutes: before.minutes });
        expect(today.key).toMatch(new RegExp(`^${key}:d\\d{8}$`));
        expect(today._id).not.toBe(first._id);
        expect(today).toMatchObject({ kind: 'study', title: 'DNS and TCP', topic: { _id: web!._id }, subject: { _id: sys.id } });
        expect(today.minutes).toBeGreaterThanOrEqual(1);
        expect(today.minutes).toBeLessThanOrEqual(45);
        const row = await prisma.workSession.findUniqueOrThrow({ where: { id: today._id } });
        expect(row).toMatchObject({ area: 'work', kindSetBy: 'chat' });
        // Yesterday's row is left as it was.
        expect(await prisma.workSession.findUniqueOrThrow({ where: { id: first._id } })).toMatchObject({ minutes: before.minutes, day: before.day });

        // The chat goes on with its own key (or the day's): both write today's row.
        await prisma.$executeRaw`UPDATE "WorkSession" SET "updatedAt" = now() - interval '10 minutes' WHERE "id" = ${today._id}`;
        expect((await chat.put(`/api/sessions/by-key/${key}`, { title: 'DNS and TCP' })).body.data.session).toMatchObject({ _id: today._id, minutes: today.minutes + 10 });
        expect((await chat.put(`/api/sessions/by-key/${today.key}`, { title: 'DNS and TCP' })).body.data.session._id).toBe(today._id);
        expect(await prisma.workSession.count({ where: { userId: user.id } })).toBe(2);
    });

    it('a url must be http or https', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token);
        expect((await chat.put('/api/sessions/by-key/s_u1', { problem: 'Two sum', url: 'javascript:alert(1)' })).status).toBe(400);
        expect((await chat.put('/api/sessions/by-key/s_u1', { problem: 'Two sum', url: 'https://leetcode.com/problems/two-sum/' })).body.data.session.url).toBe('https://leetcode.com/problems/two-sum/');
    });
});

describe('by hand, and what it feeds', () => {
    it('a manual entry; the list with day totals; edit and delete by the app only; the rhythm counts the day', async () => {
        const user = await createTestUser();
        const made = await api(user).post('/api/sessions', { title: 'Graphs', minutes: 40 });
        expect(made.status).toBe(201);
        expect(made.body.data).toMatchObject({ kind: 'study', title: 'Graphs', minutes: 40, source: 'user', key: null });
        await api(user).put('/api/sessions/by-key/cc_build1', { kindIfNew: 'build', project: 'Recollect', minutes: 30, title: 'Paths UI' });

        const list = (await api(user).get('/api/sessions?days=14')).body.data;
        expect(list.sessions).toHaveLength(2);
        expect(list.days[0].minutes).toMatchObject({ study: 40, build: 30 });

        const agent = asAgent((await createTestToken(user)).token);
        expect((await agent.get('/api/sessions')).status).toBe(200);
        expect((await agent.patch(`/api/sessions/${made.body.data._id}`, { minutes: 1 })).status).toBe(403);
        expect((await agent.delete(`/api/sessions/${made.body.data._id}`)).status).toBe(403);
        expect((await api(user).patch(`/api/sessions/${made.body.data._id}`, { minutes: 45, title: 'Graphs: BFS and DFS' })).body.data).toMatchObject({ minutes: 45, title: 'Graphs: BFS and DFS' });

        const today = (await api(user).get('/api/today')).body.data;
        expect(today.stats.rhythm.last7.at(-1)).toMatchObject({ active: true });
        expect((await api(user).delete(`/api/sessions/${made.body.data._id}`)).status).toBe(200);
        expect((await api(user).get('/api/sessions')).body.data.sessions).toHaveLength(1);
    });

    it('Recall: knowing the answer to a weak spot’s question clears it; not knowing one opens a weak spot', async () => {
        // The Recall routes need a key set; a self-mark never calls the model.
        const savedKey = process.env.CLAUDE_API_KEY;
        process.env.CLAUDE_API_KEY = 'test-key-not-real';
        try {
            await recallBothWays();
        } finally {
            process.env.CLAUDE_API_KEY = savedKey ?? '';
        }
    });
});

async function recallBothWays() {
    {
        const user = await createTestUser();
        const sys = await createSubjectRow(user.id, 'System Design');
        const doc = await prisma.doc.create({ data: { userId: user.id, title: 'Caching' } });
        const topic = await prisma.topic.create({ data: { userId: user.id, subjectId: sys.id, docId: doc.id, title: 'Caching' } });
        await api(user).put('/api/sessions/by-key/s_seed', { topicId: topic.id, weakSpots: ['TTL jitter'] });
        const spot = await prisma.weakSpot.findFirstOrThrow({ where: { userId: user.id } });
        await createChainRows(user.id, { topicId: topic.id }, '2026-11-01');
        const revision = await prisma.revision.findFirstOrThrow({ where: { topicId: topic.id, cycleNumber: 1 } });
        const set = await prisma.recallSet.create({
            data: {
                userId: user.id,
                revisionId: revision.id,
                cycleNumber: 1,
                status: 'ready',
                model: 'test',
                questions: [
                    { id: 'q1', kind: 'recall', prompt: 'Why add jitter to TTLs?', answerKey: 'So keys do not expire together.', sourceQuote: '', weakSpotId: spot.id },
                    { id: 'q2', kind: 'apply', prompt: 'When does write-behind lose data?', answerKey: 'A crash before the flush.', sourceQuote: '' },
                ],
            },
        });
        expect((await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q1', selfMark: 'knew' })).status).toBe(200);
        expect((await prisma.weakSpot.findUniqueOrThrow({ where: { id: spot.id } })).status).toBe('cleared');
        expect((await api(user).post(`/api/recall/sets/${set.id}/answer`, { questionId: 'q2', selfMark: 'didnt' })).status).toBe(200);
        const opened = await prisma.weakSpot.findMany({ where: { userId: user.id, status: 'open' } });
        expect(opened).toEqual([expect.objectContaining({ text: 'When does write-behind lose data?', source: 'recall', topicId: topic.id })]);
    }
}
