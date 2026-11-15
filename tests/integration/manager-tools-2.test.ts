// Stage 4 part 2's tools for the manager (MANAGER_AND_DOCS_PLAN §3.3): reminders (set on a task or
// with a new one, listed, cancelled; each undoable), a topic's Recall results, who can see a doc,
// and spreading the overdue reviews (undoable; more than 20 only asks, and his tap does it).
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { addDays, today as todayIn } from '../../src/services/learning/time';
import { reminderTime } from '../../src/services/tasks/taskReminders.service';
import { asAgent, createTestToken } from '../helpers/agent';
import { createTestUser } from '../helpers/auth';
import { api, createChainRows, createLearner, createSubjectRow, createTopicRow } from '../helpers/learning';

const IST = 'Asia/Kolkata';
const agentFor = async (user: { id: string }) => asAgent((await createTestToken(user)).token, 'Claude Code');
const lastEdit = (userId: string, kind: string) => prisma.agentEdit.findFirstOrThrow({ where: { userId, kind: kind as never }, orderBy: { createdAt: 'desc' } });

describe('reminders', () => {
    it('reads "HH:mm" as the next such time in his zone, a local day-and-time, or ISO; never in the past', () => {
        const now = new Date('2026-11-14T12:00:00Z'); // 17:30 in IST
        expect(reminderTime('19:00', IST, '2026-11-14', now).toISOString()).toBe('2026-11-14T13:30:00.000Z');
        expect(reminderTime('09:15', IST, '2026-11-14', now).toISOString()).toBe('2026-11-15T03:45:00.000Z');
        expect(reminderTime('2026-11-20T08:00', IST, '2026-11-14', now).toISOString()).toBe('2026-11-20T02:30:00.000Z');
        expect(reminderTime('2026-11-20T08:00:00Z', IST, '2026-11-14', now).toISOString()).toBe('2026-11-20T08:00:00.000Z');
        expect(() => reminderTime('2026-11-14T10:00', IST, '2026-11-14', now)).toThrow('already passed');
        expect(() => reminderTime('tomorrow', IST, '2026-11-14', now)).toThrow();
    });

    it('an agent sets one on a task and one with a new task, lists and cancels them; each Undo puts things back', async () => {
        const user = await createLearner(IST);
        const agent = await agentFor(user);
        const task = (await agent.post('/api/tasks', { title: 'Book the mock' })).body.data;
        const at = new Date(Date.now() + 3 * 3600_000).toISOString();

        const onTask = await agent.post('/api/reminders', { taskId: task._id, at });
        expect(onTask.status).toBe(201);
        expect(onTask.body.data).toMatchObject({ taskId: task._id, task: 'Book the mock', at, status: 'pending', createdTask: false });
        expect(onTask.body.data.when).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
        expect((await prisma.todo.findUniqueOrThrow({ where: { id: task._id } })).reminderDate?.toISOString()).toBe(at);

        const free = await agent.post('/api/reminders', { title: 'Call the bank', at });
        expect(free.body.data).toMatchObject({ task: 'Call the bank', createdTask: true });
        expect((await agent.get('/api/reminders')).body.data.map((r: { task: string }) => r.task).sort()).toEqual(['Book the mock', 'Call the bank']);
        expect((await agent.post('/api/reminders', { taskId: task._id, title: 'x', at })).status).toBe(400);

        // Cancel, and its Undo sets it again.
        const cancelled = await agent.post(`/api/reminders/${onTask.body.data._id}/cancel`);
        expect(cancelled.body.data.status).toBe('cancelled');
        expect((await agent.post(`/api/reminders/${onTask.body.data._id}/cancel`)).status).toBe(409);
        const cancelEdit = await lastEdit(user.id, 'reminder_cancel');
        expect(cancelEdit.summary).toBe('Cancelled the reminder for "Book the mock"');
        expect((await api(user).post(`/api/agent/edits/${cancelEdit.id}/undo`)).status).toBe(200);
        expect((await prisma.reminder.findUniqueOrThrow({ where: { id: onTask.body.data._id } })).status).toBe('pending');

        // Undo of the free one deletes the task it made (and with it the reminder).
        const setEdit = await prisma.agentEdit.findFirstOrThrow({ where: { userId: user.id, kind: 'reminder_set', entityId: free.body.data._id } });
        expect(setEdit.summary).toBe('Set a reminder for "Call the bank" (a new task)');
        expect((await api(user).post(`/api/agent/edits/${setEdit.id}/undo`)).status).toBe(200);
        expect(await prisma.todo.count({ where: { id: free.body.data.taskId } })).toBe(0);
        expect((await agent.get('/api/reminders')).body.data.map((r: { task: string }) => r.task)).toEqual(['Book the mock']);
    });
});

describe('Recall results and sharing (reads)', () => {
    it("get_recall's route: the finished sets, the missed questions with the grader's words, open weak spots; his own topics only", async () => {
        const [user, other] = await Promise.all([createLearner(IST), createTestUser()]);
        const subject = await createSubjectRow(user.id);
        const { doc, topic } = await createTopicRow(user.id, subject.id, 'Heaps');
        const [rev] = await createChainRows(user.id, { topicId: topic.id }, addDays(todayIn(IST), -3));
        const set = await prisma.recallSet.create({
            data: {
                userId: user.id,
                revisionId: rev!.id,
                docId: doc.id,
                cycleNumber: 1,
                status: 'ready',
                model: 'claude-opus-5-5',
                finishedAt: new Date(),
                result: 'partial',
                questions: [
                    { id: 'q1', kind: 'explain', prompt: 'Why is heapify O(n)?', answerKey: 'secret', sourceQuote: '' },
                    { id: 'q2', kind: 'recall', prompt: 'What does a max-heap keep at the root?', answerKey: 'secret', sourceQuote: '' },
                ],
            },
        });
        await prisma.recallAttempt.createMany({
            data: [
                { setId: set.id, questionId: 'q1', answer: 'not sure', grade: 'weak', feedback: 'Most nodes sit near the bottom.' },
                { setId: set.id, questionId: 'q2', answer: 'the largest', grade: 'strong', feedback: '' },
            ],
        });
        await prisma.weakSpot.create({ data: { userId: user.id, topicId: topic.id, subjectId: subject.id, text: 'heapify cost', textKey: 'heapify cost' } });

        const agent = await agentFor(user);
        const res = await agent.get(`/api/topics/${topic.id}/recall`);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            topic: { _id: topic.id, title: 'Heaps', docId: doc.id },
            sets: [{ cycle: 1, result: 'partial', counts: { strong: 1, partial: 0, weak: 1 }, missed: [{ question: 'Why is heapify O(n)?', grade: 'weak', feedback: 'Most nodes sit near the bottom.' }] }],
            weakSpots: [{ text: 'heapify cost' }],
        });
        expect(JSON.stringify(res.body)).not.toContain('secret');
        expect((await agent.get(`/api/topics/${doc.id}/recall?by=doc`)).body.data.topic._id).toBe(topic.id);
        expect((await api(other).get(`/api/topics/${topic.id}/recall`)).status).toBe(404);
    });

    it("get_sharing's route: published or not, the people added, who asks; only for the owner", async () => {
        const [owner, friend, reader] = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
        const doc = await prisma.doc.create({ data: { userId: owner.id, title: 'Kafka notes' } });
        await prisma.docCollaborator.create({ data: { docId: doc.id, userId: friend.id, role: 'editor' } });
        const unpublished = await (await agentFor(owner)).get(`/api/agent/docs/${doc.id}/sharing`);
        expect(unpublished.status).toBe(200);
        expect(unpublished.body.data).toMatchObject({ title: 'Kafka notes', published: null, people: [{ name: friend.name, role: 'editor' }], requests: [] });

        await prisma.doc.update({ where: { id: doc.id }, data: { publicSlug: `kafka-notes-${doc.id.slice(-12)}`, publishedAt: new Date() } });
        await prisma.accessRequest.create({ data: { docId: doc.id, userId: reader.id } });
        const res = await (await agentFor(owner)).get(`/api/agent/docs/${doc.id}/sharing`);
        expect(res.body.data.published.url).toBe(`http://localhost:3005/p/kafka-notes-${doc.id.slice(-12)}`);
        expect(res.body.data.requests).toEqual([{ name: reader.name, requestedAt: expect.any(String) }]);
        expect((await (await agentFor(friend)).get(`/api/agent/docs/${doc.id}/sharing`)).status).toBe(404);
    });
});

describe('the Move calendar', () => {
    it("gives each day's pending reviews (with minutes) and open tasks, against his budget", async () => {
        const user = await createLearner(IST);
        const subject = await createSubjectRow(user.id);
        const { topic } = await createTopicRow(user.id, subject.id, 'Heaps');
        const today = todayIn(IST);
        await createChainRows(user.id, { topicId: topic.id }, addDays(today, 1)); // reviews on +2, +4, +8, +22
        await (await agentFor(user)).post('/api/tasks', { title: 'Book the mock', due: addDays(today, 2) });
        const res = await api(user).get(`/api/revisions/calendar?from=${today}&days=7`);
        expect(res.status).toBe(200);
        const cal = res.body.data;
        expect(cal.days).toHaveLength(7);
        expect(cal.budgetMin).toEqual(expect.any(Number));
        const day2 = cal.days.find((d: { day: string }) => d.day === addDays(today, 2));
        expect(day2).toMatchObject({ revisions: [{ title: 'Heaps', cycleNumber: 1 }], tasks: [{ title: 'Book the mock' }] });
        expect(day2.minutes).toBeGreaterThan(0);
        expect(cal.days.find((d: { day: string }) => d.day === addDays(today, 4)).revisions[0].cycleNumber).toBe(2);
        expect((await api(user).get(`/api/revisions/calendar?from=${today}&days=99`)).status).toBe(400);
    });
});

describe('spreading the overdue reviews', () => {
    async function overdue(userId: string, n: number) {
        const subject = await createSubjectRow(userId);
        for (let i = 0; i < n; i++) {
            const { topic } = await createTopicRow(userId, subject.id, `Topic ${i + 1}`);
            await createChainRows(userId, { topicId: topic.id }, addDays(todayIn(IST), -10));
        }
    }

    it('up to 20: spread at once and logged; Undo puts each back on its old day', async () => {
        const user = await createLearner(IST);
        await overdue(user.id, 3);
        const late = async () => prisma.revision.count({ where: { userId: user.id, status: 'pending', scheduledFor: { lt: new Date(`${todayIn(IST)}T00:00:00Z`) } } });
        const lateBefore = await late();
        expect(lateBefore).toBeGreaterThan(0);

        const agent = await agentFor(user);
        const res = await agent.post('/api/revisions/spread', { reason: 'he is back' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ moved: 3, asked: false, card: null });
        expect(await late()).toBe(0);
        const edit = await lastEdit(user.id, 'revisions_spread');
        expect(edit.summary).toMatch(/^Spread 3 overdue reviews over \d+ days?$/);

        expect((await api(user).post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(200);
        expect(await late()).toBe(lateBefore);
        // Nothing overdue now? The second spread says so and logs nothing.
        expect((await agent.post('/api/revisions/spread')).body.data.moved).toBe(3);
        expect((await agent.post('/api/revisions/spread')).body.data).toMatchObject({ moved: 0, asked: false });
    });

    it('over 20: only asks (a card with "Do it"); his tap spreads them', async () => {
        const user = await createLearner(IST);
        await overdue(user.id, 21);
        const res = await (await agentFor(user)).post('/api/revisions/spread');
        expect(res.body.data).toMatchObject({ moved: 21, asked: true, card: { text: expect.stringMatching(/^Spread 21 overdue reviews over the next \d+ days?, as your daily budget allows$/) } });
        expect(await prisma.agentEdit.count({ where: { userId: user.id, kind: 'revisions_spread' } })).toBe(0);
        const accepted = await api(user).post(`/api/suggestions/${res.body.data.card._id}/accept`);
        expect(accepted.status).toBe(200);
        expect(accepted.body.data.result).toMatch(/^Moved 21 reviews over \d+ days?$/);
        expect((await (await agentFor(user)).post('/api/revisions/spread')).body.data.moved).toBe(0);
    });
});
