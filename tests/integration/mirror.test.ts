// GET /api/mirror (LOOP_COMPLETE_SPEC 1.7): a goal's path pace from real rows, a subject's quiz scores,
// weak spots and practice outcomes; tokens with read may call it; the brief carries the path pace.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api, createSubjectRow, d } from '../helpers/learning';
import { today as todayIn } from '../../src/services/learning';
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

describe('GET /api/mirror/stand', () => {
    it('stands the last 7 days against the 7 before: a new account has nothing before, and the verdict says so', async () => {
        const user = await createTestUser();
        const sys = await createSubjectRow(user.id, 'System Design');
        const topics = (await api(user).post(`/api/subjects/${sys.id}/path`, { titles: ['Caching', 'Queues'] })).body.data.path.topics as Array<{ _id: string }>;
        await api(user).patch(`/api/topics/${topics[0]!._id}/path`, { status: 'done' });
        const chat = asAgent((await createTestToken(user)).token);
        await chat.put('/api/sessions/by-key/s_w1', { topicId: topics[1]!._id, title: 'Queues', minutes: 40 });
        await chat.put('/api/sessions/by-key/s_w2', { kind: 'build', title: 'The API', minutes: 30 });
        const focus = (await api(user).post('/api/focus', { text: 'Finish queues' })).body.data;
        await api(user).patch(`/api/focus/${focus._id}`, { done: true });
        const today = todayIn('Asia/Kolkata');
        await prisma.revision.create({ data: { userId: user.id, topicId: topics[0]!._id, cycleNumber: 1, intervalDays: 1, scheduledFor: d(today), completedAt: new Date(), status: 'done' } });

        // A token with read may call it, like the mirror.
        const res = await chat.get('/api/mirror/stand');
        expect(res.status).toBe(200);
        const s = res.body.data;
        expect(s.recordStart).toBe(today);
        expect(s.periods.week).toMatchObject({ partial: true, before: null, previous: null });
        expect(s.periods.week.current).toMatchObject({ days: 1, activeDays: 1, totalMinutes: 70, sessions: 2, topicsDone: 1, reviews: { due: 1, onDay: 1 }, focus: { set: 1, done: 1 } });
        expect(s.periods.week.verdict[0]).toBe('Active today, the first day of the record.');
        expect(s.periods.year.current.days).toBe(1);
        expect(s.days).toHaveLength(364);
        expect(s.days.at(-1)).toMatchObject({ day: today, active: true, minutes: 70, reviews: 1, focus: 1, sessions: 2 });
        expect(s).toMatchObject({ openNow: 0, weakOpenNow: 0 });
    });
});
