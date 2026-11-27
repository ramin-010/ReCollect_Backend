// Personal access tokens (/api/tokens), token auth in authMiddleware (scopes, refused endpoints,
// revoked tokens), and agents on the learning routes: provenance, the AgentEdit log, Undo and
// Idempotency-Key. Docs for agents: agent-docs.test.ts.
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { authCookie, createTestUser } from '../helpers/auth';
import { api, createSubjectRow, createTopicRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

const FAR = '2031-06-30';
const uuid = () => crypto.randomUUID();
const edits = (userId: string) => prisma.agentEdit.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

describe('/api/tokens (cookie only)', () => {
    it('creates a token, shows it once, and stores only its SHA-256', async () => {
        const user = await createTestUser();
        const res = await api(user).post('/api/tokens', { name: '  Laptop  ', scopes: ['learning:write', 'read'] });
        expect(res.status).toBe(201);
        const { token, ...rest } = res.body.data;
        expect(token).toMatch(/^rcl_[A-Za-z0-9_-]{43}$/);
        expect(rest).toEqual({
            _id: expect.any(String),
            name: 'Laptop',
            prefix: token.slice(0, 12),
            scopes: ['read', 'learning:write'],
            lastUsedAt: null,
            revokedAt: null,
            createdAt: expect.any(String),
            signIn: false,
        });
        const row = await prisma.apiToken.findUniqueOrThrow({ where: { id: rest._id } });
        expect(row.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
        expect(JSON.stringify(row)).not.toContain(token);

        const list = await api(user).get('/api/tokens');
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual([rest]);
        expect(JSON.stringify(list.body)).not.toContain(row.tokenHash);
    });

    it('validates the name and scopes; 401 without a cookie', async () => {
        const user = await createTestUser();
        expect((await api(user).post('/api/tokens', { scopes: ['read'] })).body.message).toBe('A token needs a name');
        expect((await api(user).post('/api/tokens', { name: 'x', scopes: [] })).status).toBe(400);
        expect((await api(user).post('/api/tokens', { name: 'x', scopes: ['admin'] })).body.message).toMatch(/Unknown scope "admin"/);
        expect((await request(app).get('/api/tokens')).status).toBe(401);
        expect((await request(app).post('/api/tokens').send({ name: 'x', scopes: ['read'] })).status).toBe(401);
    });

    it("revokes (idempotent); another user's token is a 404", async () => {
        const [user, other] = await Promise.all([createTestUser(), createTestUser()]);
        const { id } = await createTestToken(user);
        expect((await api(other).delete(`/api/tokens/${id}`)).status).toBe(404);
        const first = await api(user).delete(`/api/tokens/${id}`);
        expect(first.status).toBe(200);
        expect(first.body.data.revokedAt).toEqual(expect.any(String));
        const again = await api(user).delete(`/api/tokens/${id}`);
        expect(again.body.data.revokedAt).toBe(first.body.data.revokedAt);
    });
});

describe('token authentication', () => {
    it('authenticates like the cookie, sets lastUsedAt, and works without any cookie', async () => {
        const user = await createTestUser();
        await api(user).post('/api/goals', { title: 'Ship it', deadline: FAR });
        const { token, id } = await createTestToken(user, ['read']);

        const viaToken = await asAgent(token).get('/api/goals');
        const viaCookie = await api(user).get('/api/goals');
        expect(viaToken.status).toBe(200);
        expect(viaToken.body).toEqual(viaCookie.body);
        expect((await prisma.apiToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).toBeInstanceOf(Date);
    });

    it('401 for a revoked, unknown or malformed token', async () => {
        const user = await createTestUser();
        const { token, id } = await createTestToken(user);
        await api(user).delete(`/api/tokens/${id}`);
        const revoked = await asAgent(token).get('/api/goals');
        expect(revoked.status).toBe(401);
        expect(revoked.body.message).toBe('This access token was revoked');

        const unknown = await asAgent(`rcl_${'A'.repeat(43)}`).get('/api/goals');
        expect(unknown.status).toBe(401);
        expect(unknown.body.message).toBe('Invalid access token');
        expect((await asAgent('rcl_short').get('/api/goals')).status).toBe(401);
    });

    it('403 when the token lacks the scope', async () => {
        const user = await createTestUser();
        const readOnly = await createTestToken(user, ['read']);
        const writeOnly = await createTestToken(user, ['learning:write']);

        const write = await asAgent(readOnly.token).post('/api/goals', { title: 'x', deadline: FAR });
        expect(write.status).toBe(403);
        expect(write.body.message).toBe('This access token lacks the "learning:write" scope');
        expect(await prisma.goal.count({ where: { userId: user.id } })).toBe(0);

        const read = await asAgent(writeOnly.token).get('/api/goals');
        expect(read.status).toBe(403);
        expect(read.body.message).toBe('This access token lacks the "read" scope');

        const docWrite = await asAgent(writeOnly.token).post('/api/agent/docs', { title: 'x', markdown: 'y' });
        expect(docWrite.body.message).toBe('This access token lacks the "docs:write" scope');
    });

    it('a token can never reach tokens, account, auth or other modules (403)', async () => {
        const user = await createTestUser();
        const { token, id } = await createTestToken(user);
        const agent = asAgent(token);
        const refused = [
            await agent.get('/api/tokens'),
            await agent.post('/api/tokens', { name: 'more', scopes: ['read'] }),
            await agent.delete(`/api/tokens/${id}`),
            await agent.get('/api/get-me'),
            await agent.get('/api/profile'),
            await agent.patch('/api/update-profile', { name: 'Hacked' }),
            await agent.delete('/api/account'),
            await agent.get('/api/todos'),
            await agent.get('/api/workspaces'),
            await agent.get('/api/notifications'),
            await agent.post('/api/docs', { title: 'x' }),
            await agent.get('/api/docs/shared-by-me'),
            await agent.post('/api/learning/ensure-today'),
            // (PATCH /api/learning/settings is open to agents since stage 4: a few fields, logged; manager-tools.test.ts.)
            await agent.post('/api/docs/trash/empty'),
            await agent.post('/api/agent/edits/seen', { ids: ['x'] }),
            await agent.post('/api/agent/edits/x/undo'),
        ];
        for (const [i, res] of refused.entries()) {
            expect(res.status, `request #${i + 1}`).toBe(403);
            expect(res.body.message, `request #${i + 1}`).toBe('Access tokens cannot be used for this endpoint');
        }
        // Nothing happened.
        expect((await prisma.apiToken.findUniqueOrThrow({ where: { id } })).revokedAt).toBeNull();
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).name).not.toBe('Hacked');
        expect(await prisma.doc.count({ where: { userId: user.id } })).toBe(0);
    });

    it('agents add and edit but never delete (403)', async () => {
        const user = await createTestUser();
        const goal = (await api(user).post('/api/goals', { title: 'Keep me', deadline: FAR })).body.data;
        const { token } = await createTestToken(user);
        expect((await asAgent(token).delete(`/api/goals/${goal._id}`)).status).toBe(403);
        expect(await prisma.goal.count({ where: { id: goal._id } })).toBe(1);
    });

    it('the cookie works as before; a non-rcl Bearer header is ignored', async () => {
        const user = await createTestUser();
        const res = await request(app).get('/api/get-me').set('Cookie', authCookie(user)).set('Authorization', 'Bearer some.jwt.value');
        expect(res.status).toBe(200);
        expect((await request(app).get('/api/get-me').set('Authorization', 'Bearer some.jwt.value')).status).toBe(401);
    });
});

describe('agents on the learning routes', () => {
    it('GET /api/today hides pocket (quick) notes from agents', async () => {
        const user = await createTestUser();
        await api(user).put(`/api/quick-notes/${uuid()}`, { content: 'private thought', category: 'PRIMARY' });
        const { token } = await createTestToken(user);
        const asApp = await api(user).get('/api/today');
        const asAgentRes = await asAgent(token).get('/api/today');
        expect(asApp.body.data.quickNotes).toHaveLength(1);
        expect(asAgentRes.status).toBe(200);
        expect(asAgentRes.body.data).not.toHaveProperty('quickNotes');
        expect(JSON.stringify(asAgentRes.body)).not.toContain('private thought');
        expect(asAgentRes.body.data.goals).toEqual(asApp.body.data.goals);
    });

    it('goal + milestones by an agent: provenance, the log line, Undo deletes it', async () => {
        const user = await createTestUser();
        const { token, id: tokenId } = await createTestToken(user, undefined, 'laptop token');
        const res = await asAgent(token, 'Claude Code').post('/api/goals', {
            title: 'Product-company SDE role',
            deadline: '2027-06-30',
            milestones: [{ title: 'DSA patterns' }, { title: 'System design' }],
        });
        expect(res.status).toBe(201);
        const goalId = res.body.data._id;

        const goal = await prisma.goal.findUniqueOrThrow({ where: { id: goalId }, include: { milestones: true } });
        expect(goal).toMatchObject({ createdBy: 'agent', agentName: 'Claude Code' });
        expect(goal.milestones.map((m) => m.createdBy)).toEqual(['agent', 'agent']);

        const listed = (await api(user).get('/api/goals')).body.data[0];
        expect(listed).toMatchObject({ _id: goalId, createdBy: 'agent', agentName: 'Claude Code' });
        expect(listed.milestones[0]).toMatchObject({ createdBy: 'agent', agentName: 'Claude Code' });

        const [edit] = await edits(user.id);
        expect(edit).toMatchObject({
            kind: 'goal_create',
            agentName: 'Claude Code',
            tokenId,
            entityId: goalId,
            summary: 'Created goal "Product-company SDE role" (due 2027-06-30, 2 milestones)',
            seenAt: null,
            undoneAt: null,
        });

        const undo = await api(user).post(`/api/agent/edits/${edit!.id}/undo`);
        expect(undo.status).toBe(200);
        expect(undo.body.data).toMatchObject({ id: edit!.id, undoneAt: expect.any(String), canUndo: false });
        expect(await prisma.goal.count({ where: { id: goalId } })).toBe(0);
        expect((await api(user).post(`/api/agent/edits/${edit!.id}/undo`)).status).toBe(409);
    });

    it("the user's own goals carry no provenance fields; cookie writes are not logged", async () => {
        const user = await createTestUser();
        const res = await api(user).post('/api/goals', { title: 'Mine', deadline: FAR });
        expect(res.body.data).not.toHaveProperty('createdBy');
        expect(res.body.data).not.toHaveProperty('agentName');
        expect(await edits(user.id)).toEqual([]);
    });

    it('goal update by an agent: Undo puts the previous fields back', async () => {
        const user = await createTestUser();
        const subject = await createSubjectRow(user.id, 'DSA');
        const goal = (await api(user).post('/api/goals', { title: 'Old title', why: 'because', deadline: '2030-01-01', subjectIds: [subject.id] })).body.data;
        const { token } = await createTestToken(user);

        const res = await asAgent(token).patch(`/api/goals/${goal._id}`, { title: 'New title', deadline: '2031-01-01', subjectIds: [] });
        expect(res.status).toBe(200);
        const [edit] = await edits(user.id);
        expect(edit).toMatchObject({ kind: 'goal_update', summary: 'Updated goal "New title" (title, deadline, subjectIds)' });

        expect((await api(user).post(`/api/agent/edits/${edit!.id}/undo`)).status).toBe(200);
        const restored = (await api(user).get('/api/goals')).body.data[0];
        expect(restored).toMatchObject({ title: 'Old title', why: 'because', deadline: '2030-01-01' });
        expect(restored.subjects.map((s: { _id: string }) => s._id)).toEqual([subject.id]);
    });

    it('milestones: add and complete by an agent, each undoable', async () => {
        const user = await createTestUser();
        const goal = (await api(user).post('/api/goals', { title: 'G', deadline: FAR })).body.data;
        const { token } = await createTestToken(user);

        const added = await asAgent(token).post(`/api/goals/${goal._id}/milestones`, { title: 'Arrays' });
        expect(added.status).toBe(201);
        const milestoneId = added.body.data.milestone._id;
        const done = await asAgent(token).patch(`/api/goal-milestones/${milestoneId}`, { done: true });
        expect(done.body.data.milestone.done).toBe(true);

        const [addEdit, doneEdit] = await edits(user.id);
        expect(addEdit).toMatchObject({ kind: 'milestone_add', entityId: milestoneId, summary: 'Added milestone "Arrays" to "G"' });
        expect(doneEdit).toMatchObject({ kind: 'milestone_update', entityId: milestoneId, summary: 'Completed milestone "Arrays"' });
        expect(await prisma.goalMilestone.findUniqueOrThrow({ where: { id: milestoneId } })).toMatchObject({ createdBy: 'agent', agentName: 'Claude Code' });

        await api(user).post(`/api/agent/edits/${doneEdit!.id}/undo`);
        expect(await prisma.goalMilestone.findUniqueOrThrow({ where: { id: milestoneId } })).toMatchObject({ done: false, doneAt: null });
        await api(user).post(`/api/agent/edits/${addEdit!.id}/undo`);
        expect(await prisma.goalMilestone.count({ where: { id: milestoneId } })).toBe(0);
    });

    it('focus line by an agent: provenance in GET /api/today, Undo deletes it', async () => {
        const user = await createTestUser();
        const { token } = await createTestToken(user);
        const res = await asAgent(token, 'Claude Code').post('/api/focus', { text: 'Two graph problems' });
        expect(res.status).toBe(201);
        const today = (await api(user).get('/api/today')).body.data;
        expect(today.focus.items).toEqual([expect.objectContaining({ text: 'Two graph problems', createdBy: 'agent', agentName: 'Claude Code' })]);

        const [edit] = await edits(user.id);
        expect(edit).toMatchObject({ kind: 'focus_add', summary: 'Added focus "Two graph problems"' });
        await api(user).post(`/api/agent/edits/${edit!.id}/undo`);
        expect(await prisma.focusItem.count({ where: { userId: user.id } })).toBe(0);
    });

    it('milestones: an agent un-ticks, renames and removes one; each is undoable, and Undo of the removal brings it back with its id', async () => {
        const user = await createTestUser();
        const goal = (await api(user).post('/api/goals', { title: 'G', deadline: FAR })).body.data;
        const m = (await api(user).post(`/api/goals/${goal._id}/milestones`, { title: 'Arrays', dueDay: '2031-01-15' })).body.data.milestone;
        await api(user).patch(`/api/goal-milestones/${m._id}`, { done: true });
        const { token } = await createTestToken(user);

        expect((await asAgent(token).patch(`/api/goal-milestones/${m._id}`, { done: false })).status).toBe(200);
        expect((await asAgent(token).patch(`/api/goal-milestones/${m._id}`, { title: 'Arrays and strings' })).status).toBe(200);
        expect((await asAgent(token).delete(`/api/goal-milestones/${m._id}`)).status).toBe(200);
        expect(await prisma.goalMilestone.count({ where: { id: m._id } })).toBe(0);

        const [untick, rename, removal] = await edits(user.id);
        expect(untick).toMatchObject({ kind: 'milestone_update', summary: 'Reopened milestone "Arrays"' });
        expect(rename).toMatchObject({ kind: 'milestone_update', summary: 'Updated milestone "Arrays and strings"' });
        expect(removal).toMatchObject({ kind: 'milestone_remove', entityId: m._id, summary: 'Removed milestone "Arrays and strings" from "G"' });

        expect((await api(user).post(`/api/agent/edits/${removal!.id}/undo`)).status).toBe(200);
        expect(await prisma.goalMilestone.findUniqueOrThrow({ where: { id: m._id } })).toMatchObject({ goalId: goal._id, title: 'Arrays and strings', done: false });
        await api(user).post(`/api/agent/edits/${rename!.id}/undo`);
        await api(user).post(`/api/agent/edits/${untick!.id}/undo`);
        expect(await prisma.goalMilestone.findUniqueOrThrow({ where: { id: m._id } })).toMatchObject({ title: 'Arrays', done: true });
    });

    it('focus lines: an agent changes, ticks and removes one; each is undoable', async () => {
        const user = await createTestUser();
        const f = (await api(user).post('/api/focus', { text: 'Two graph problems' })).body.data;
        const { token } = await createTestToken(user);

        expect((await asAgent(token).patch(`/api/focus/${f._id}`, { text: 'Three graph problems' })).status).toBe(200);
        expect((await asAgent(token).patch(`/api/focus/${f._id}`, { done: true })).status).toBe(200);
        expect((await asAgent(token).delete(`/api/focus/${f._id}`)).status).toBe(200);

        const [change, tick, removal] = await edits(user.id);
        expect(change).toMatchObject({ kind: 'focus_update', summary: 'Changed focus "Two graph problems" to "Three graph problems"' });
        expect(tick).toMatchObject({ kind: 'focus_update', summary: 'Ticked focus "Three graph problems"' });
        expect(removal).toMatchObject({ kind: 'focus_remove', entityId: f._id, summary: 'Removed focus "Three graph problems"' });

        await api(user).post(`/api/agent/edits/${removal!.id}/undo`);
        expect(await prisma.focusItem.findUniqueOrThrow({ where: { id: f._id } })).toMatchObject({ text: 'Three graph problems', done: true });
        await api(user).post(`/api/agent/edits/${tick!.id}/undo`);
        await api(user).post(`/api/agent/edits/${change!.id}/undo`);
        expect(await prisma.focusItem.findUniqueOrThrow({ where: { id: f._id } })).toMatchObject({ text: 'Two graph problems', done: false });
    });

    it('pocket notes: an agent can add (and pin) but never overwrite one', async () => {
        const user = await createTestUser();
        const mine = uuid();
        await api(user).put(`/api/quick-notes/${mine}`, { content: 'my secret', category: 'PRIMARY' });
        const { token } = await createTestToken(user);

        const overwrite = await asAgent(token).put(`/api/quick-notes/${mine}`, { content: 'agent text', category: 'PRIMARY' });
        expect(overwrite.status).toBe(409);
        expect(overwrite.body.code).toBe('NOTE_EXISTS');
        expect((await prisma.quickNote.findUniqueOrThrow({ where: { id: mine } })).content).toBe('my secret');

        const id = uuid();
        const added = await asAgent(token).put(`/api/quick-notes/${id}`, { content: 'Read the MVCC chapter\nlater', category: 'PRIMARY', isPinned: true });
        expect(added.status).toBe(201);
        expect(added.body.data).toMatchObject({ _id: id, isPinned: true });
        expect((await prisma.quickNote.findUniqueOrThrow({ where: { id } })).isPinned).toBe(true);
        expect((await asAgent(token).patch(`/api/quick-notes/${id}`, { isPinned: false })).status).toBe(403);

        const [edit] = await edits(user.id);
        expect(edit).toMatchObject({ kind: 'pocket_add', entityId: id, summary: 'Added a pocket note (pinned): "Read the MVCC chapter"' });
        await api(user).post(`/api/agent/edits/${edit!.id}/undo`);
        expect(await prisma.quickNote.count({ where: { id } })).toBe(0);
        expect(await prisma.quickNote.count({ where: { id: mine } })).toBe(1);
    });

    it('subject + topic by an agent: scheduled for revision; Undo unschedules, then removes the empty subject', async () => {
        const user = await createTestUser();
        const doc = await prisma.doc.create({ data: { userId: user.id, title: 'Postgres locks' } });
        const { token } = await createTestToken(user);

        const subject = (await asAgent(token).post('/api/subjects', { name: 'Databases' })).body.data;
        const topic = await asAgent(token).post('/api/topics', { docId: doc.id, subjectId: subject._id });
        expect(topic.status).toBe(201);
        expect(topic.body.data.chain).toHaveLength(4);

        const [subjectEdit, topicEdit] = await edits(user.id);
        expect(subjectEdit).toMatchObject({ kind: 'subject_create', summary: 'Created subject "Databases"' });
        expect(topicEdit).toMatchObject({ kind: 'revision_schedule', docId: doc.id, summary: 'Scheduled "Postgres locks" for revision' });

        // The subject holds the topic: not undoable yet.
        expect((await api(user).post(`/api/agent/edits/${subjectEdit!.id}/undo`)).status).toBe(409);
        expect((await api(user).post(`/api/agent/edits/${topicEdit!.id}/undo`)).status).toBe(200);
        expect(await prisma.topic.count({ where: { docId: doc.id } })).toBe(0);
        expect(await prisma.revision.count({ where: { userId: user.id } })).toBe(0);
        expect((await api(user).post(`/api/agent/edits/${subjectEdit!.id}/undo`)).status).toBe(200);
        expect(await prisma.subject.count({ where: { id: subject._id } })).toBe(0);
    });

    it('revisions/start by an agent: Undo removes only the revisions it created, and not once one was done', async () => {
        const user = await createTestUser();
        const subject = await createSubjectRow(user.id);
        const { topic } = await createTopicRow(user.id, subject.id, 'Binary search');
        const { token } = await createTestToken(user);

        const started = await asAgent(token).post('/api/revisions/start', { topicId: topic.id });
        expect(started.status).toBe(201);
        const [edit] = await edits(user.id);
        expect(edit).toMatchObject({ kind: 'revision_schedule', summary: 'Scheduled "Binary search" for revision', entityId: topic.id });

        await prisma.revision.updateMany({ where: { topicId: topic.id, cycleNumber: 1 }, data: { status: 'done', completedAt: new Date() } });
        const refused = await api(user).post(`/api/agent/edits/${edit!.id}/undo`);
        expect(refused.status).toBe(409);
        expect(refused.body.message).toBe("Can't undo: it was already revised");
        expect((await prisma.agentEdit.findUniqueOrThrow({ where: { id: edit!.id } })).undoneAt).toBeNull();

        await prisma.revision.updateMany({ where: { topicId: topic.id }, data: { status: 'pending', completedAt: null } });
        expect((await api(user).post(`/api/agent/edits/${edit!.id}/undo`)).status).toBe(200);
        expect(await prisma.revision.count({ where: { topicId: topic.id } })).toBe(0);
        expect(await prisma.topic.count({ where: { id: topic.id } })).toBe(1);
    });

    it('Idempotency-Key: a retry gets the first response and creates nothing new', async () => {
        const user = await createTestUser();
        const { token } = await createTestToken(user);
        const key = { 'Idempotency-Key': `goal-${uuid()}` };
        const body = { title: 'Once', deadline: FAR };

        const first = await asAgent(token).post('/api/goals', body, key);
        const second = await asAgent(token).post('/api/goals', body, key);
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(second.headers['idempotent-replayed']).toBe('true');
        expect(second.body).toEqual(first.body);
        expect(await prisma.goal.count({ where: { userId: user.id } })).toBe(1);
        expect(await edits(user.id)).toHaveLength(1);

        const changed = await asAgent(token).post('/api/goals', { ...body, title: 'Twice' }, key);
        expect(changed.status).toBe(422);
        // Keys are per user.
        const other = await createTestUser();
        const { token: otherToken } = await createTestToken(other);
        expect((await asAgent(otherToken).post('/api/goals', body, key)).headers['idempotent-replayed']).toBeUndefined();
    });

    it('GET /api/agent/edits lists newest first; "seen" is cookie only', async () => {
        const user = await createTestUser();
        const { token } = await createTestToken(user);
        await asAgent(token).post('/api/focus', { text: 'one' });
        await asAgent(token).post('/api/focus', { text: 'two' });

        const viaAgent = await asAgent(token).get('/api/agent/edits');
        expect(viaAgent.status).toBe(200);
        expect(viaAgent.body.data.map((e: { summary: string }) => e.summary)).toEqual(['Added focus "two"', 'Added focus "one"']);
        expect(viaAgent.body.data[0]).toEqual({
            id: expect.any(String),
            kind: 'focus_add',
            agentName: 'Claude Code',
            summary: 'Added focus "two"',
            docId: null,
            entityId: expect.any(String),
            createdAt: expect.any(String),
            seenAt: null,
            undoneAt: null,
            undoneBy: null,
            canUndo: true,
        });

        const seen = await api(user).post('/api/agent/edits/seen', { ids: [viaAgent.body.data[1].id] });
        expect(seen.body.data).toEqual({ updated: 1 });
        const unseen = await api(user).get('/api/agent/edits?unseen=true');
        expect(unseen.body.data.map((e: { summary: string }) => e.summary)).toEqual(['Added focus "two"']);
        const since = await api(user).get(`/api/agent/edits?since=${encodeURIComponent(viaAgent.body.data[1].createdAt)}`);
        expect(since.body.data).toHaveLength(1);
        expect((await api(user).get('/api/agent/edits?since=yesterday')).status).toBe(400);

        // Someone else's edits: invisible, not markable, not undoable.
        const stranger = await createTestUser();
        expect((await api(stranger).get('/api/agent/edits')).body.data).toEqual([]);
        expect((await api(stranger).post('/api/agent/edits/seen', { ids: [viaAgent.body.data[0].id] })).body.data).toEqual({ updated: 0 });
        expect((await api(stranger).post(`/api/agent/edits/${viaAgent.body.data[0].id}/undo`)).status).toBe(404);
    });

    it('GET /api/agent/doc-activity: the docs agents changed (still standing), latest first; cookie only, owner only', async () => {
        const user = await createTestUser();
        const { token } = await createTestToken(user);
        const docA = await prisma.doc.create({ data: { userId: user.id, title: 'A' } });
        const docB = await prisma.doc.create({ data: { userId: user.id, title: 'B' } });
        const docC = await prisma.doc.create({ data: { userId: user.id, title: 'C' } });
        const at = (s: number) => new Date(Date.now() - s * 1000);
        const edit = (docId: string, agentName: string, createdAt: Date, undoneAt: Date | null = null) =>
            prisma.agentEdit.create({ data: { userId: user.id, docId, kind: 'doc_append', agentName, summary: 'x', createdAt, undoneAt } });
        await edit(docA.id, 'Claude Code', at(300));
        await edit(docA.id, 'Claude Code', at(100));
        await edit(docB.id, 'study-chat', at(200));
        await edit(docC.id, 'Claude Code', at(50), at(40)); // undone: not from an agent any more
        await edit(docC.id, 'You', at(30)); // the app acting for him

        const res = await api(user).get('/api/agent/doc-activity');
        expect(res.status).toBe(200);
        expect(res.body.data.map((r: { docId: string; edits: number }) => [r.docId, r.edits])).toEqual([
            [docA.id, 2],
            [docB.id, 1],
        ]);
        expect(new Date(res.body.data[0].lastAt).getTime()).toBeGreaterThan(new Date(res.body.data[1].lastAt).getTime());
        expect((await asAgent(token).get('/api/agent/doc-activity')).status).toBe(403);
        expect((await api(await createTestUser()).get('/api/agent/doc-activity')).body.data).toEqual([]);
    });
});
