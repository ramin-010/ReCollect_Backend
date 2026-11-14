// A subject's path (BUDDY_PLAN B1): planned topics in order, what comes next, status changes with
// their dates, moves, and an agent's path writes logged and undoable.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api, createSubjectRow, createTopicRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

const titles = (path: { topics: Array<{ title: string; status: string }> }) => path.topics.map((t) => `${t.title}:${t.status}`);

describe('a subject’s path', () => {
    it('plans topics in order after what is learned; next is the first in progress, else the first planned', async () => {
        const user = await createTestUser();
        const subject = await createSubjectRow(user.id, 'System Design');
        await createTopicRow(user.id, subject.id, '01 · How the web works');

        const planned = await api(user).post(`/api/subjects/${subject.id}/path`, { titles: ['02 · Caching', '03 · Queues', '04 · Sharding'] });
        expect(planned.status).toBe(201);
        expect(planned.body.data.created).toHaveLength(3);
        const path = planned.body.data.path;
        expect(titles(path)).toEqual(['01 · How the web works:done', '02 · Caching:planned', '03 · Queues:planned', '04 · Sharding:planned']);
        expect(path.topics.map((t: { position: number }) => t.position)).toEqual([1, 2, 3, 4]);
        expect(path.next).toMatchObject({ title: '02 · Caching', position: 2 });
        expect(path).toMatchObject({ done: 1, total: 4 });

        // Insert after the first planned one, then start the third: it becomes next.
        const caching = path.topics[1]._id;
        const more = (await api(user).post(`/api/subjects/${subject.id}/path`, { titles: ['02b · Consistent hashing'], after: caching })).body.data.path;
        expect(titles(more).slice(1, 4)).toEqual(['02 · Caching:planned', '02b · Consistent hashing:planned', '03 · Queues:planned']);
        const queues = more.topics[3]._id;
        const started = await api(user).patch(`/api/topics/${queues}/path`, { status: 'in_progress', nextStep: 'Do the outbox exercise' });
        expect(started.status).toBe(200);
        expect(started.body.data.path.next).toMatchObject({ _id: queues, nextStep: 'Do the outbox exercise' });
        expect(started.body.data.topic.startedAt).toEqual(expect.any(String));

        // Done stamps doneAt; next falls back to the first planned one.
        const finished = (await api(user).patch(`/api/topics/${queues}/path`, { status: 'done' })).body.data;
        expect(finished.topic).toMatchObject({ status: 'done', doneAt: expect.any(String) });
        expect(finished.path.next).toMatchObject({ title: '02 · Caching' });

        // Move to the front.
        const moved = (await api(user).patch(`/api/topics/${queues}/path`, { after: null })).body.data.path;
        expect(moved.topics[0]).toMatchObject({ _id: queues, position: 1 });
    });

    it('refuses what it can not do, with reasons', async () => {
        const user = await createTestUser();
        const other = await createTestUser();
        const subject = await createSubjectRow(user.id);
        const { topic } = await createTopicRow(user.id, subject.id, 'Binary search');
        expect((await api(other).get(`/api/subjects/${subject.id}/path`)).status).toBe(404);
        expect((await api(user).post(`/api/subjects/${subject.id}/path`, { titles: [] })).status).toBe(400);
        expect((await api(user).post(`/api/subjects/${subject.id}/path`, { titles: ['x'], after: 'nope-not-a-topic' })).status).toBe(400);
        const rename = await api(user).patch(`/api/topics/${topic.id}/path`, { title: 'Bisection' });
        expect(rename.status).toBe(400);
        expect(rename.body.message).toMatch(/its doc's title/);
    });

    it('an agent plans and changes the path; both are logged, and Undo takes each back', async () => {
        const user = await createTestUser();
        const subject = await createSubjectRow(user.id, 'System Design');
        const first = (await api(user).post(`/api/subjects/${subject.id}/path`, { titles: ['A', 'B'] })).body.data.path.topics;
        const { token } = await createTestToken(user, ['read', 'learning:write']);

        const read = await asAgent(token).get(`/api/subjects/${subject.id}/path`);
        expect(read.status).toBe(200);
        const plan = await asAgent(token).post(`/api/subjects/${subject.id}/path`, { titles: ['C', 'D'] });
        expect(plan.status).toBe(201);
        const move = await asAgent(token).patch(`/api/topics/${first[1]._id}/path`, { after: null, status: 'in_progress' });
        expect(move.status).toBe(200);

        const [planEdit, moveEdit] = await prisma.agentEdit.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        expect(planEdit).toMatchObject({ kind: 'path_plan', summary: 'Planned 2 topics in "System Design"' });
        expect(moveEdit).toMatchObject({ kind: 'topic_update', summary: 'Started topic "B"' });

        expect((await api(user).post(`/api/agent/edits/${moveEdit!.id}/undo`)).status).toBe(200);
        expect(titles((await api(user).get(`/api/subjects/${subject.id}/path`)).body.data)).toEqual(['A:planned', 'B:planned', 'C:planned', 'D:planned']);
        expect((await api(user).post(`/api/agent/edits/${planEdit!.id}/undo`)).status).toBe(200);
        expect(titles((await api(user).get(`/api/subjects/${subject.id}/path`)).body.data)).toEqual(['A:planned', 'B:planned']);
    });
});
