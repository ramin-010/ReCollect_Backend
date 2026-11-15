// GET /api/mirror (LOOP_COMPLETE_SPEC 1.7): a goal's path pace from real rows, a subject's quiz scores,
// weak spots and practice outcomes; tokens with read may call it; the brief carries the path pace.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api, createSubjectRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

describe('GET /api/mirror', () => {
    it('paces a goal’s path from finished topics and reads the record of a subject', async () => {
        const user = await createTestUser();
        const sys = await createSubjectRow(user.id, 'System Design');
        const topics = (await api(user).post(`/api/subjects/${sys.id}/path`, { titles: ['Caching', 'Queues', 'Sharding', 'Consensus'] })).body.data.path.topics as Array<{ _id: string }>;
        await api(user).patch(`/api/topics/${topics[0]!._id}/path`, { status: 'done' });
        await api(user).post('/api/goals', { title: 'Offer', deadline: '2027-05-16', subjectIds: [sys.id] });
        const chat = asAgent((await createTestToken(user)).token);
        await chat.put('/api/sessions/by-key/s_m1', { topicId: topics[1]!._id, title: 'Queues', score: { done: 3, total: 4 }, weakSpots: ['exactly-once'] });
        await chat.put('/api/sessions/by-key/s_m2:1', { problem: 'Design a queue', outcome: 'hints', subjectId: sys.id });

        const res = await chat.get('/api/mirror');
        expect(res.status).toBe(200);
        const m = res.body.data;
        expect(m.goals).toHaveLength(1);
        expect(m.goals[0].paths[0]).toMatchObject({ subject: { name: 'System Design' }, done: 1, total: 4, remaining: 3, perWeek: 0.3 });
        expect(m.goals[0].hoursPerWeek).toHaveLength(6);
        const s = m.subjects.find((x: { name: string }) => x.name === 'System Design');
        expect(s).toMatchObject({ quiz: [{ done: 3, total: 4 }], weakSpots: { open: 1, clearedIn30: 0 }, practice: { alone: 0, hints: 1, after_answer: 0 }, minutesPerTopic: null });
        expect(m.weeks).toHaveLength(6);

        const brief = (await chat.get('/api/brief')).body.data;
        expect(brief.goals[0].paths[0]).toMatchObject({ subject: 'System Design', done: 1, total: 4, perWeek: 0.3 });
        expect(await prisma.workSession.count({ where: { userId: user.id } })).toBe(2);
    });
});
