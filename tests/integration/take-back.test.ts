// TOOL_ACCESS_PLAN §12 (11-27): what an AI adds it can change and take back. An app takes back its own change
// (undo_edit) and nobody else's; the row stays unreviewed on Home saying who took it back. A task, a decision, an
// empty planned topic, a doc's coming reviews, a review ticked by mistake and a time entry can each be removed or
// corrected, and each has an Undo. A topic that holds anything only asks.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { api, createChainRows, createLearner, createSubjectRow, createTopicRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

const undo = (user: { id: string }, editId: string) => api(user).post(`/api/agent/edits/${editId}/undo`, {});
const today = () => new Date().toISOString().slice(0, 10);

describe('undo_edit: an app takes back its own change (§12.3)', () => {
    it('its own doc append goes back; the row says who and stays unreviewed; another app and the app itself cannot', async () => {
        const user = await createLearner();
        const claude = asAgent((await createTestToken(user, undefined, 'Claude')).token, 'Claude');
        const other = asAgent((await createTestToken(user, undefined, 'ChatGPT')).token, 'ChatGPT');
        const made = await claude.post('/api/agent/docs', { title: 'How the web works', markdown: '# How the web works\n\nDNS turns names into addresses.' });
        expect(made.status).toBe(201);
        const docId = made.body.data._id ?? made.body.data.id;
        const appended = await claude.post(`/api/agent/docs/${docId}/append`, { markdown: '## DHCP in simple words\n\nA hotel lends you a room key.' });
        expect(appended.status).toBe(200);
        const editId = appended.body.data.editId as string;
        expect(editId).toBeTruthy();

        // Not another app's, not the app's own (cookie) Undo route.
        const refused = await other.post(`/api/agent/edits/${editId}/take-back`, {});
        expect(refused.status).toBe(403);
        expect(refused.body.message).toBe('Only the app that made a change can take it back. The user can undo any change on Home → From your agent.');
        expect((await claude.post(`/api/agent/edits/${editId}/undo`, {})).status).toBe(403);

        const back = await claude.post(`/api/agent/edits/${editId}/take-back`, {});
        expect(back.status).toBe(200);
        expect(back.body.data).toMatchObject({ id: editId, undoneBy: 'Claude', seenAt: null });
        const read = await claude.get(`/api/agent/docs/${docId}`);
        expect(JSON.stringify(read.body.data)).not.toContain('DHCP');
        expect(JSON.stringify(read.body.data)).toContain('DNS turns names');
        expect((await claude.post(`/api/agent/edits/${editId}/take-back`, {})).status).toBe(409);

        // Home's list: still unreviewed, saying who took it back; `mine` lists this app's own only.
        const home = await api(user).get('/api/agent/edits?unseen=1');
        expect(home.body.data.find((e: { id: string }) => e.id === editId)).toMatchObject({ undoneBy: 'Claude', seenAt: null, canUndo: false });
        const mine = await other.get('/api/agent/edits?mine=1');
        expect(mine.body.data).toEqual([]);
        expect((await claude.get('/api/agent/edits?mine=1')).body.data.map((e: { id: string }) => e.id)).toContain(editId);
    });

    it('a change made in the app (no token) is the user’s to undo; a middleware-logged write answers its editId', async () => {
        const user = await createLearner();
        const agent = asAgent((await createTestToken(user, undefined, 'Claude')).token, 'Claude');
        const task = await agent.post('/api/tasks', { title: 'Renew passport', due: '2026-12-04' });
        expect(task.status).toBe(201);
        expect(task.body.data.editId).toBeTruthy();
        const back = await agent.post(`/api/agent/edits/${task.body.data.editId}/take-back`, {});
        expect(back.status).toBe(200);
        expect(await prisma.todo.findUnique({ where: { id: task.body.data._id } })).toBeNull();
        expect((await agent.post(`/api/agent/edits/${randomUUID()}/take-back`, {})).status).toBe(404);
    });
});

describe('removing and correcting what an AI added (§12.4)', () => {
    it('delete_task: the task and its reminder go; Undo brings both back with their ids', async () => {
        const user = await createLearner();
        const agent = asAgent((await createTestToken(user)).token, 'Claude');
        const t = (await agent.post('/api/tasks', { title: 'Buy milk' })).body.data;
        const at = new Date(Date.now() + 3 * 86400_000).toISOString();
        expect((await agent.post('/api/reminders', { taskId: t._id, at })).status).toBe(201);
        const del = await agent.post(`/api/agent/tasks/${t._id}/delete`, {});
        expect(del.status).toBe(200);
        expect(del.body.data).toMatchObject({ id: t._id, deleted: true, reminders: 1 });
        expect(await prisma.todo.findUnique({ where: { id: t._id } })).toBeNull();
        expect((await undo(user, del.body.data.editId)).status).toBe(200);
        expect(await prisma.todo.findUniqueOrThrow({ where: { id: t._id } })).toMatchObject({ title: 'Buy milk', userId: user.id });
        expect(await prisma.reminder.count({ where: { todoId: t._id, status: 'pending' } })).toBe(1);
        expect((await agent.post(`/api/agent/tasks/nope/delete`, {})).body.message).toBe('No task with that id. list_tasks shows their tasks with ids.');
    });

    it('a decision changed (the existing route) and removed; Undo brings it back', async () => {
        const user = await createLearner();
        const agent = asAgent((await createTestToken(user)).token, 'Claude');
        const d = (await agent.post('/api/decisions', { title: 'Use Postgres', why: 'Relational data', lookAgain: '3m' })).body.data;
        const del = await agent.post(`/api/agent/decisions/${d._id}/delete`, {});
        expect(del.body.data).toMatchObject({ id: d._id, deleted: true });
        expect(await prisma.decision.findUnique({ where: { id: d._id } })).toBeNull();
        expect((await undo(user, del.body.data.editId)).status).toBe(200);
        expect(await prisma.decision.findUniqueOrThrow({ where: { id: d._id } })).toMatchObject({ title: 'Use Postgres', why: 'Relational data' });
    });

    it('remove_topic: a planned empty topic goes at once (Undo back in its place); one with a doc and reviews only asks', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id, 'System Design');
        const agent = asAgent((await createTestToken(user)).token, 'Claude');
        const planned = await prisma.topic.create({ data: { userId: user.id, subjectId: s.id, title: 'Sharding', status: 'planned', sortOrder: 3 } });
        const gone = await agent.post(`/api/agent/topics/${planned.id}/remove`, {});
        expect(gone.body.data).toMatchObject({ id: planned.id, title: 'Sharding', removed: true, asked: false });
        expect(await prisma.topic.findUnique({ where: { id: planned.id } })).toBeNull();
        expect((await undo(user, gone.body.data.editId)).status).toBe(200);
        expect(await prisma.topic.findUniqueOrThrow({ where: { id: planned.id } })).toMatchObject({ title: 'Sharding', status: 'planned', sortOrder: 3, subjectId: s.id });

        const { topic } = await createTopicRow(user.id, s.id, 'Caching');
        await createChainRows(user.id, { topicId: topic.id }, today());
        const asked = await agent.post(`/api/agent/topics/${topic.id}/remove`, { reason: 'They want it off the path.' });
        expect(asked.body.data).toMatchObject({ removed: false, asked: true });
        expect(asked.body.data.text).toBe('Take "Caching" off its path (a lesson doc, 4 reviews): its 4 reviews go for good; the doc stays');
        expect(await prisma.topic.findUnique({ where: { id: topic.id } })).not.toBeNull();
        // Their tap runs it.
        expect((await api(user).post(`/api/suggestions/${asked.body.data.suggestionId}/accept`, {})).status).toBe(200);
        expect(await prisma.topic.findUnique({ where: { id: topic.id } })).toBeNull();
    });

    it('stop_revision: the coming reviews go, done ones stay; Undo puts them back', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id);
        const { doc, topic } = await createTopicRow(user.id, s.id, 'Old Redis notes');
        await createChainRows(user.id, { topicId: topic.id }, today(), { 1: { status: 'done', completedAt: new Date() } });
        const agent = asAgent((await createTestToken(user)).token, 'Claude');
        const stop = await agent.post(`/api/agent/docs/${doc.id}/stop-revision`, {});
        expect(stop.body.data).toMatchObject({ docId: doc.id, removed: 3, kept: 1 });
        expect(await prisma.revision.count({ where: { topicId: topic.id } })).toBe(1);
        expect((await agent.post(`/api/agent/docs/${doc.id}/stop-revision`, {})).status).toBe(409);
        expect((await undo(user, stop.body.data.editId)).status).toBe(200);
        expect(await prisma.revision.count({ where: { topicId: topic.id, status: 'pending' } })).toBe(3);
    });

    it('uncomplete_revision: a review ticked by mistake is waiting again; Undo ticks it again', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id);
        const { topic } = await createTopicRow(user.id, s.id, 'Caching');
        const [first] = await createChainRows(user.id, { topicId: topic.id }, new Date(Date.now() - 86400_000).toISOString().slice(0, 10));
        const agent = asAgent((await createTestToken(user)).token, 'Claude');
        expect((await agent.post(`/api/revisions/${first!.id}/complete`, {})).status).toBe(200);
        const un = await agent.post(`/api/agent/revisions/${first!.id}/uncomplete`, {});
        expect(un.status).toBe(200);
        expect(un.body.data).toMatchObject({ revisionId: first!.id, title: 'Caching' });
        expect((await prisma.revision.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe('pending');
        expect((await agent.post(`/api/agent/revisions/${first!.id}/uncomplete`, {})).status).toBe(409);
        expect((await undo(user, un.body.data.editId)).status).toBe(200);
        expect((await prisma.revision.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe('done');
    });

    it('update_session and delete: a time entry corrected (minutes, day) and removed, each undoable', async () => {
        const user = await createLearner();
        const agent = asAgent((await createTestToken(user)).token, 'Claude');
        const day = today();
        const s = await prisma.workSession.create({ data: { userId: user.id, key: `s_${randomUUID().slice(0, 8)}`, kind: 'study', day: new Date(`${day}T00:00:00Z`), startedAt: new Date(), minutes: 133, title: 'How the web works', source: 'agent' } });
        const fix = await agent.patch(`/api/agent/sessions/${s.id}`, { minutes: 40, day: '2026-11-25' });
        expect(fix.status).toBe(200);
        expect(fix.body.data.changed).toEqual(['40 min (was 2 h 13 min)', `on 2026-11-25 (was ${day})`]);
        expect(await prisma.workSession.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ minutes: 40 });
        expect((await undo(user, fix.body.data.editId)).status).toBe(200);
        const back = await prisma.workSession.findUniqueOrThrow({ where: { id: s.id } });
        expect(back.minutes).toBe(133);
        expect(back.day.toISOString().slice(0, 10)).toBe(day);

        const del = await agent.post(`/api/agent/sessions/${s.id}/delete`, {});
        expect(del.body.data).toMatchObject({ id: s.id, deleted: true });
        expect(await prisma.workSession.findUnique({ where: { id: s.id } })).toBeNull();
        expect((await undo(user, del.body.data.editId)).status).toBe(200);
        expect(await prisma.workSession.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ minutes: 133, title: 'How the web works', key: s.key });
    });
});
