// Stage 4's backend for the manager (MANAGER_AND_DOCS_PLAN §3.2–3.3): the trash, actions that need
// Ramin's tap (level 3), and the agent writes it opened (revisions done or moved, a few settings,
// projects), each logged with an Undo.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { addDays, today as todayIn } from '../../src/services/learning/time';
import { purgeTrash, TRASH_DAYS } from '../../src/services/docs/trash.service';
import { docJsonToYjsState } from '../../src/services/docs/docContent';
import { markdownToDocJson } from '../../src/services/docs/markdown/docMarkdown';
import { searchDocs } from '../../src/services/docs/docSearch.service';
import { asAgent, createTestToken } from '../helpers/agent';
import { createTestUser } from '../helpers/auth';
import { api, chainDays, createChainRows, createLearner, createSubjectRow, createTopicRow } from '../helpers/learning';

const IST = 'Asia/Kolkata';

async function agentFor(user: { id: string }, name = 'Claude Code') {
    const { token } = await createTestToken(user);
    return asAgent(token, name);
}

const lastEdit = (userId: string, kind: string) => prisma.agentEdit.findFirstOrThrow({ where: { userId, kind: kind as never }, orderBy: { createdAt: 'desc' } });

describe('the trash', () => {
    it('moves a doc out of lists and search and back; only the owner; agents logged with Undo; 30 days, then gone', async () => {
        const [owner, friend] = await Promise.all([createTestUser(), createTestUser()]);
        const doc = await prisma.doc.create({ data: { userId: owner.id, title: 'Kafka notes', yjsState: docJsonToYjsState(markdownToDocJson('Partitions and offsets.')) } });
        await prisma.docCollaborator.create({ data: { docId: doc.id, userId: friend.id, role: 'editor' } });
        const before = (await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).updatedAt;

        expect((await api(friend).post(`/api/docs/${doc.id}/trash`)).status).toBe(403);
        const trashed = await api(owner).post(`/api/docs/${doc.id}/trash`);
        expect(trashed.status).toBe(200);
        expect(trashed.body.data).toMatchObject({ _id: doc.id, title: 'Kafka notes', trashedAt: expect.any(String) });
        const listed = (await api(owner).get('/api/docs')).body.data.find((d: { _id: string }) => d._id === doc.id);
        expect(listed.trashedAt).toEqual(expect.any(String));
        expect(await searchDocs(owner.id, { query: 'offsets' })).toEqual([]);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).updatedAt).toEqual(before);

        expect((await api(owner).post(`/api/docs/${doc.id}/restore`)).body.data.trashedAt).toBeNull();
        expect((await searchDocs(owner.id, { query: 'offsets' })).map((h) => h.id)).toEqual([doc.id]);

        // An agent: logged, and Undo takes it out of the trash again.
        const agent = await agentFor(owner);
        const res = await agent.post(`/api/agent/docs/${doc.id}/trash`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ id: doc.id, trashedAt: expect.any(String), editId: expect.any(String) });
        expect((await agent.post(`/api/agent/docs/${doc.id}/trash`)).body.data.editId).toBeNull();
        expect((await prisma.agentEdit.findUniqueOrThrow({ where: { id: res.body.data.editId } })).summary).toBe('Moved "Kafka notes" to the trash');
        expect((await api(owner).post(`/api/agent/edits/${res.body.data.editId}/undo`)).status).toBe(200);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).trashedAt).toBeNull();

        // 30 days in the trash: deleted for good by the hourly job.
        await prisma.$executeRaw`UPDATE "Doc" SET "trashedAt" = ${new Date(Date.now() - (TRASH_DAYS + 1) * 86_400_000)} WHERE "id" = ${doc.id}`;
        expect(await purgeTrash()).toBe(1);
        expect(await prisma.doc.count({ where: { id: doc.id } })).toBe(0);
    });
});

describe('actions that need his tap (level 3)', () => {
    it('emptying the trash: an agent only asks; the card says what; his tap deletes; nothing to do is a 400', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        expect((await agent.post('/api/actions', { action: 'empty_trash' })).status).toBe(400);
        const doc = await prisma.doc.create({ data: { userId: user.id, title: 'Old draft' } });
        await api(user).post(`/api/docs/${doc.id}/trash`);

        const asked = await agent.post('/api/actions', { action: 'empty_trash', reason: 'Ramin asked to clean up' });
        expect(asked.status).toBe(201);
        expect(asked.body.data).toMatchObject({ kind: 'action', text: 'Empty the trash: delete 1 doc for good ("Old draft")', proposedBy: 'agent', agentName: 'Claude Code' });
        expect(await prisma.doc.count({ where: { id: doc.id } })).toBe(1);
        // Asked again: still one card.
        expect((await agent.post('/api/actions', { action: 'empty_trash' })).body.data._id).toBe(asked.body.data._id);
        expect(await prisma.suggestion.count({ where: { userId: user.id, kind: 'action', status: 'pending' } })).toBe(1);
        // An agent can't tap it; unknown actions and suggest() can't make one either.
        expect((await agent.post(`/api/suggestions/${asked.body.data._id}/accept`)).status).toBe(403);
        expect((await agent.post('/api/actions', { action: 'send_email' })).body.code).toBe('UNKNOWN_ACTION');
        expect((await agent.post('/api/suggestions', { kind: 'action', text: 'x', payload: {} })).status).toBe(400);
        expect((await api(user).post('/api/actions', { action: 'empty_trash' })).status).toBe(400);

        expect((await api(user).post(`/api/suggestions/${asked.body.data._id}/accept`)).status).toBe(200);
        expect(await prisma.doc.count({ where: { id: doc.id } })).toBe(0);
    });
});

describe('revisions, settings and projects for agents', () => {
    it('a review marked done or moved, each undone', async () => {
        const user = await createLearner(IST);
        const subject = await createSubjectRow(user.id);
        const { topic } = await createTopicRow(user.id, subject.id, 'Heaps');
        const today = todayIn(IST);
        const [first, second] = await createChainRows(user.id, { topicId: topic.id }, addDays(today, -1));
        const agent = await agentFor(user);

        expect((await agent.post(`/api/revisions/${first!.id}/complete`)).status).toBe(200);
        const done = await lastEdit(user.id, 'revision_complete');
        expect(done.summary).toBe('Marked the review of "Heaps" done (review 1)');
        expect((await api(user).post(`/api/agent/edits/${done.id}/undo`)).status).toBe(200);
        expect((await prisma.revision.findUniqueOrThrow({ where: { id: first!.id } })).status).toBe('pending');

        const daysBefore = await chainDays({ topicId: topic.id });
        const moved = await agent.post(`/api/revisions/${second!.id}/reschedule`, { day: addDays(today, 3) });
        expect(moved.status).toBe(200);
        const edit = await lastEdit(user.id, 'revision_reschedule');
        expect(edit.summary).toBe(`Moved the review of "Heaps" from ${addDays(today, 2)} to ${addDays(today, 3)}`);
        expect((await api(user).post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(200);
        expect(await chainDays({ topicId: topic.id })).toEqual(daysBefore);
    });

    it('settings: only the budget, busy days, the morning email and the profile; Undo puts them back', async () => {
        const user = await createLearner(IST, { dailyBudgetMin: 30 });
        const agent = await agentFor(user);
        const refused = await agent.patch('/api/learning/settings', { timezone: 'UTC' });
        expect([refused.status, refused.body.code]).toEqual([403, 'SETTING_NOT_ALLOWED']);
        expect((await agent.patch('/api/learning/settings', { dailyBudgetMin: 45 })).status).toBe(200);
        const edit = await lastEdit(user.id, 'settings_update');
        expect(edit.summary).toBe('Changed the settings: daily budget 30 → 45');
        expect((await api(user).post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(200);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).dailyBudgetMin).toBe(30);
    });

    it('a project renamed and given a next step; Undo puts both back', async () => {
        const user = await createTestUser();
        const project = await prisma.project.create({ data: { userId: user.id, key: 'second_brain', name: 'second_brain', nextStep: 'ship search' } });
        const agent = await agentFor(user);
        expect((await agent.patch(`/api/projects/${project.id}`, { name: 'Recollect', nextStep: 'build the manager' })).status).toBe(200);
        const edit = await lastEdit(user.id, 'project_update');
        expect(edit.summary).toBe('Changed the project "second_brain": renamed it "Recollect", set its next step');
        expect((await api(user).post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(200);
        expect(await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).toMatchObject({ name: 'second_brain', nextStep: 'ship search' });
    });
});
