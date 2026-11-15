// LEARNING_SPEC §2 #1, #4–7: GET /api/today and the revision write paths (start, complete,
// uncomplete with exact undo of dates AND streaks, reschedule), plus time-zone edge cases.
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { addDays, today as todayIn } from '../../src/services/learning';
import { api, chainDays, createChainRows, createLearner, createSubjectRow, createTopicRow, d, recordSql } from '../helpers/learning';

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';

afterEach(() => {
    vi.useRealTimers();
});

describe('auth', () => {
    it('401 without a cookie on every learning route family', async () => {
        const calls = [
            request(app).get('/api/today'),
            request(app).post('/api/learning/ensure-today'),
            request(app).post('/api/revisions/start').send({ topicId: 'x' }),
            request(app).post('/api/revisions/x/complete'),
            request(app).post('/api/revisions/x/uncomplete'),
            request(app).post('/api/revisions/x/reschedule').send({ day: '2030-01-01' }),
            request(app).get('/api/subjects'),
            request(app).put('/api/schedule/today').send({ slots: [] }),
            request(app).get('/api/schedule/blocks'),
        ];
        for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
    });
});

describe('POST /api/revisions/start', () => {
    it('starts +1/+3/+7/+21 for a topic (201), then 409 ALREADY_STARTED', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id);
        const { topic } = await createTopicRow(user.id, s.id);
        const today = todayIn(IST);

        const res = await api(user).post('/api/revisions/start', { topicId: topic.id });
        expect(res.status).toBe(201);
        expect(res.body.data.chain.map((r: any) => [r.cycleNumber, r.intervalDays, r.scheduledFor, r.status])).toEqual([
            [1, 1, addDays(today, 1), 'pending'],
            [2, 3, addDays(today, 3), 'pending'],
            [3, 7, addDays(today, 7), 'pending'],
            [4, 21, addDays(today, 21), 'pending'],
        ]);
        expect(Object.keys(res.body.data.chain[0]).sort()).toEqual(['_id', 'completedAt', 'cycleNumber', 'intervalDays', 'scheduledFor', 'status']);

        const again = await api(user).post('/api/revisions/start', { topicId: topic.id });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('ALREADY_STARTED');
    });

    it("404 for another user's topic or capture; 400 for a bad body", async () => {
        const owner = await createLearner();
        const stranger = await createLearner();
        const s = await createSubjectRow(owner.id);
        const { topic } = await createTopicRow(owner.id, s.id);
        const capture = await prisma.capture.create({ data: { userId: owner.id, content: 'note' } });
        expect((await api(stranger).post('/api/revisions/start', { topicId: topic.id })).status).toBe(404);
        expect((await api(stranger).post('/api/revisions/start', { captureId: capture.id })).status).toBe(404);
        const bad = await api(owner).post('/api/revisions/start', { topicId: topic.id, captureId: capture.id });
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe('INVALID_INPUT');
        expect((await api(owner).post('/api/revisions/start', {})).status).toBe(400);
    });

    it('two concurrent starts create one chain (the unique (item, cycle) closes the race)', async () => {
        const user = await createLearner();
        const capture = await prisma.capture.create({ data: { userId: user.id, content: 'race' } });
        const [a, b] = await Promise.all([
            api(user).post('/api/revisions/start', { captureId: capture.id }),
            api(user).post('/api/revisions/start', { captureId: capture.id }),
        ]);
        expect([a.status, b.status].sort()).toEqual([201, 409]);
        expect(await prisma.revision.count({ where: { captureId: capture.id } })).toBe(4);
    });
});

describe('complete / uncomplete', () => {
    it('complete: done, later cycles re-anchored, streak credited, history row; 409 NOT_PENDING; 404 foreign', async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        const s = await createSubjectRow(user.id);
        const { topic, doc } = await createTopicRow(user.id, s.id, 'Two pointers');
        const today = todayIn(IST);
        // Started 4 days ago: cycle 1 was due 3 days ago (late).
        const chain = await createChainRows(user.id, { topicId: topic.id }, addDays(today, -4));

        expect((await api(stranger).post(`/api/revisions/${chain[0]!.id}/complete`)).status).toBe(404);

        const res = await api(user).post(`/api/revisions/${chain[0]!.id}/complete`);
        expect(res.status).toBe(200);
        const { item, chain: after, streak, mastered } = res.body.data;
        expect(item).toMatchObject({
            _id: chain[0]!.id,
            kind: 'topic',
            itemId: topic.id,
            title: 'Two pointers',
            docId: doc.id,
            subject: { _id: s.id, name: 'DSA', color: '#007acc' },
            status: 'done',
            canUndo: true,
            tags: [],
        });
        // Re-anchored on today: +2, +6, +20 from the completion day.
        expect(after.map((r: any) => r.scheduledFor)).toEqual([addDays(today, -3), addDays(today, 2), addDays(today, 6), addDays(today, 20)]);
        expect(streak).toEqual({ current: 1, longest: 1 });
        expect(mastered).toBe(false);

        const history = await prisma.dailyHistory.findMany({ where: { userId: user.id } });
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ subjectId: s.id, revisionsDone: 1, revisionsDue: 1, streakMaintained: true });
        expect(await prisma.subjectStreak.findUnique({ where: { userId_subjectId: { userId: user.id, subjectId: s.id } } })).toMatchObject({
            currentStreak: 1,
        });

        const twice = await api(user).post(`/api/revisions/${chain[0]!.id}/complete`);
        expect(twice.status).toBe(409);
        expect(twice.body.code).toBe('NOT_PENDING');
    });

    it('uncomplete restores the dates AND the streak exactly (same-day undo), and deletes the history row', async () => {
        const today = todayIn(IST);
        const yesterday = addDays(today, -1);
        const user = await createLearner(IST, {
            globalStreak: 5,
            longestGlobalStreak: 5,
            lastGlobalStreakDay: d(yesterday),
            learningRolledOverDay: d(today),
        });
        const s = await createSubjectRow(user.id);
        await prisma.subjectStreak.create({
            data: { userId: user.id, subjectId: s.id, currentStreak: 2, longestStreak: 7, lastCreditDay: d(yesterday) },
        });
        const { topic } = await createTopicRow(user.id, s.id);
        const chain = await createChainRows(user.id, { topicId: topic.id }, addDays(today, -6), { 1: { status: 'done', completedAt: new Date(Date.now() - 5 * 86400_000) } });
        // Cycle 2 (interval 3) is 3 days late.
        const before = await chainDays({ topicId: topic.id });

        const done = await api(user).post(`/api/revisions/${chain[1]!.id}/complete`);
        expect(done.status).toBe(200);
        expect(done.body.data.streak).toEqual({ current: 6, longest: 6 });
        expect(await chainDays({ topicId: topic.id })).not.toEqual(before);
        expect((await prisma.revision.findUnique({ where: { id: chain[1]!.id } }))!.undo).toMatchObject({ revisionId: chain[1]!.id, completedDay: today });

        const undone = await api(user).post(`/api/revisions/${chain[1]!.id}/uncomplete`);
        expect(undone.status).toBe(200);
        expect(undone.body.data.streak).toEqual({ current: 5, longest: 5 });
        expect(undone.body.data.item).toMatchObject({ status: 'pending', completedAt: null });
        expect(undone.body.data.item.canUndo).toBeUndefined();
        expect(await chainDays({ topicId: topic.id })).toEqual(before);

        const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect([u.globalStreak, u.longestGlobalStreak, u.lastGlobalStreakDay?.toISOString().slice(0, 10), u.globalStreakBeforeCredit]).toEqual([5, 5, yesterday, null]);
        const ss = await prisma.subjectStreak.findUniqueOrThrow({ where: { userId_subjectId: { userId: user.id, subjectId: s.id } } });
        expect([ss.currentStreak, ss.longestStreak, ss.lastCreditDay?.toISOString().slice(0, 10)]).toEqual([2, 7, yesterday]);
        expect(await prisma.dailyHistory.count({ where: { userId: user.id } })).toBe(0);
        expect((await prisma.revision.findUnique({ where: { id: chain[1]!.id } }))!.undo).toBeNull();
    });

    it('409 NOT_DONE for a pending one, 409 LATER_CYCLE_DONE when a later cycle is done', async () => {
        const user = await createLearner();
        const today = todayIn(IST);
        const capture = await prisma.capture.create({ data: { userId: user.id, content: 'chain' } });
        const chain = await createChainRows(user.id, { captureId: capture.id }, addDays(today, -10), {
            1: { status: 'done', completedAt: new Date() },
            2: { status: 'done', completedAt: new Date() },
        });
        const notDone = await api(user).post(`/api/revisions/${chain[2]!.id}/uncomplete`);
        expect([notDone.status, notDone.body.code]).toEqual([409, 'NOT_DONE']);
        const later = await api(user).post(`/api/revisions/${chain[0]!.id}/uncomplete`);
        expect([later.status, later.body.code]).toEqual([409, 'LATER_CYCLE_DONE']);
        // An imported completion (no undo record) falls back to interval spacing.
        const ok = await api(user).post(`/api/revisions/${chain[1]!.id}/uncomplete`);
        expect(ok.status).toBe(200);
    });

    it('a capture revision item: title from content, category as tags, attachments', async () => {
        const user = await createLearner();
        const today = todayIn(IST);
        const capture = await prisma.capture.create({
            data: { userId: user.id, content: 'Consistent hashing: virtual nodes smooth the load across the ring', category: 'system-design', attachments: [{ url: 'u', publicId: 'p', fileName: 'f.pdf', fileType: 'application/pdf' }] },
        });
        const chain = await createChainRows(user.id, { captureId: capture.id }, addDays(today, -1));
        const res = await api(user).post(`/api/revisions/${chain[0]!.id}/complete`);
        expect(res.body.data.item).toMatchObject({
            kind: 'capture',
            itemId: capture.id,
            title: 'Consistent hashing: virtual nodes smooth the load',
            subject: null,
            tags: ['system-design'],
            url: null,
            attachments: [{ url: 'u', publicId: 'p', fileName: 'f.pdf', fileType: 'application/pdf' }],
        });
        expect(res.body.data.item.docId).toBeUndefined();
    });
});

describe('POST /api/revisions/:id/reschedule', () => {
    it('moves the revision and every later pending cycle by the same delta', async () => {
        const user = await createLearner();
        const today = todayIn(IST);
        const capture = await prisma.capture.create({ data: { userId: user.id, content: 'move me' } });
        const chain = await createChainRows(user.id, { captureId: capture.id }, addDays(today, -1));
        const res = await api(user).post(`/api/revisions/${chain[0]!.id}/reschedule`, { day: addDays(today, 2) });
        expect(res.status).toBe(200);
        expect(res.body.data.chain.map((r: any) => r.scheduledFor)).toEqual([addDays(today, 2), addDays(today, 4), addDays(today, 8), addDays(today, 22)]);
        expect(res.body.data.item).toMatchObject({ _id: chain[0]!.id, scheduledFor: addDays(today, 2) });
    });

    it('400 for a past day or a bad day; 409 NOT_PENDING when done; 404 foreign', async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        const today = todayIn(IST);
        const capture = await prisma.capture.create({ data: { userId: user.id, content: 'x' } });
        const chain = await createChainRows(user.id, { captureId: capture.id }, addDays(today, -1), { 1: { status: 'done', completedAt: new Date() } });
        const past = await api(user).post(`/api/revisions/${chain[1]!.id}/reschedule`, { day: addDays(today, -1) });
        expect([past.status, past.body.code]).toEqual([400, 'INVALID_DAY']);
        expect((await api(user).post(`/api/revisions/${chain[1]!.id}/reschedule`, { day: '2026-02-30' })).status).toBe(400);
        const done = await api(user).post(`/api/revisions/${chain[0]!.id}/reschedule`, { day: addDays(today, 3) });
        expect([done.status, done.body.code]).toEqual([409, 'NOT_PENDING']);
        expect((await api(stranger).post(`/api/revisions/${chain[1]!.id}/reschedule`, { day: addDays(today, 3) })).status).toBe(404);
    });
});

describe('GET /api/today', () => {
    it('issues SELECTs only (zero writes), even for a user who needs a rollover', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id);
        await prisma.timeBlock.create({ data: { userId: user.id, title: 'Deep work', startTime: '09:00', endTime: '11:00', color: '#000' } });
        const { topic } = await createTopicRow(user.id, s.id);
        await createChainRows(user.id, { topicId: topic.id }, addDays(todayIn(IST), -2));

        const { result: res, sql } = await recordSql(() => api(user).get('/api/today'));
        expect(res.status).toBe(200);
        expect(res.body.data.needsEnsure).toBe(true);
        const writes = sql.filter((q) => /^\s*(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i.test(q) || /\bFOR UPDATE\b/i.test(q));
        expect(writes).toEqual([]);
        expect(sql.filter((q) => /^\s*SELECT/i.test(q)).length).toBeGreaterThan(5);
        expect(await prisma.dailyScheduleSlot.count({ where: { userId: user.id } })).toBe(0);
    });

    it('returns the Home payload: buckets, stats, tasks, inbox, quick notes', async () => {
        const today = todayIn(IST);
        // Routine on (the old Home payload) and the app already seen today (needsEnsure false).
        const user = await createLearner(IST, { learningRolledOverDay: d(today), lastSeenDay: d(today), routineEnabled: true, globalStreak: 3, longestGlobalStreak: 9, lastGlobalStreakDay: d(addDays(today, -1)) });
        const s = await createSubjectRow(user.id, 'Graphs');
        const due = await createTopicRow(user.id, s.id, 'BFS');
        const late = await createTopicRow(user.id, s.id, 'Dijkstra');
        const finished = await createTopicRow(user.id, s.id, 'Topo sort');
        await createTopicRow(user.id, s.id, 'Not started');
        const dueChain = await createChainRows(user.id, { topicId: due.topic.id }, addDays(today, -1));
        await createChainRows(user.id, { topicId: late.topic.id }, addDays(today, -4));
        const mastered = new Date(Date.now() - 1000);
        await createChainRows(user.id, { topicId: finished.topic.id }, addDays(today, -40), {
            1: { status: 'done', completedAt: mastered },
            2: { status: 'done', completedAt: mastered },
            3: { status: 'done', completedAt: mastered },
            4: { status: 'done', completedAt: mastered, scheduledFor: today },
        });

        const inboxNote = await prisma.capture.create({ data: { userId: user.id, content: 'loose thought', isPinned: true } });
        const filed = await prisma.capture.create({ data: { userId: user.id, content: 'filed', subjectId: s.id, createdAt: new Date(Date.now() - 60_000) } });
        await prisma.quickNote.create({ data: { id: '6f1c2b8e-0e0e-4c1b-9a51-1b2c3d4e5f60', userId: user.id, content: 'scratch' } });
        const dated = await prisma.todo.create({ data: { userId: user.id, title: 'Dated', dueDate: new Date(Date.now() + 86400_000) } });
        await prisma.todo.create({ data: { userId: user.id, title: 'No date' } });
        const goal = await prisma.todo.create({ data: { userId: user.id, title: 'Goal', goalType: 'WEEKLY' } });
        await prisma.todo.create({ data: { userId: user.id, title: 'Done long ago', status: 'complete', completedAt: new Date('2020-01-01'), dueDate: new Date('2020-01-01') } });

        const res = await api(user).get('/api/today');
        expect(res.status).toBe(200);
        const data = res.body.data;
        expect(data).toMatchObject({ today, timezone: IST, needsEnsure: false, user: { _id: user.id } });
        expect(data.revisions.totalDue).toBe(2);
        expect(data.revisions.dueToday.map((r: any) => r._id)).toEqual([dueChain[0]!.id]);
        expect(data.revisions.overdue).toHaveLength(1);
        expect(data.revisions.overdue[0]).toMatchObject({ title: 'Dijkstra', daysLate: 3 });
        expect(data.revisions.doneToday).toHaveLength(4);
        expect(data.revisions.doneToday.find((r: any) => r.cycleNumber === 4).canUndo).toBe(true);
        expect(data.revisions.doneToday.find((r: any) => r.cycleNumber === 1).canUndo).toBe(false);
        expect(data.stats).toMatchObject({ streak: 3, longestStreak: 9, totalTopics: 4, mastered: 1, inProgress: 2, notStarted: 1, adherence: null });
        expect(data.tasks.map((t: any) => t.title).sort()).toEqual(['Dated', 'Goal']);
        expect(data.tasks.find((t: any) => t._id === goal.id).goalType).toBe('WEEKLY');
        expect(data.tasks.find((t: any) => t._id === dated.id).user._id).toBe(user.id);
        expect(data.inbox.count).toBe(2);
        expect(data.inbox.items[0]).toMatchObject({ _id: inboxNote.id, isPinned: true, subject: null, attachments: [] });
        expect(data.inbox.items[1]).toMatchObject({ _id: filed.id, subject: { _id: s.id } });
        expect(data.quickNotes).toEqual([expect.objectContaining({ _id: '6f1c2b8e-0e0e-4c1b-9a51-1b2c3d4e5f60', content: 'scratch', category: 'PRIMARY' })]);
        expect(data.triage).toEqual({ kind: 'none' });
        expect(data.todayDebrief).toBeNull();
        expect(data.schedule).toEqual({ routineMode: 'MASTER', slots: [] });
    });

    it('shows healed slots as resolved without writing, and triage for unresolved past slots', async () => {
        const today = todayIn(IST);
        const user = await createLearner(IST, { learningRolledOverDay: d(today), routineEnabled: true });
        const block = await prisma.timeBlock.create({ data: { userId: user.id, title: 'Gym', startTime: '07:00', endTime: '08:00', color: '#0f0' } });
        const y = addDays(today, -1);
        const healed = await prisma.dailyScheduleSlot.create({ data: { userId: user.id, sourceBlockId: block.id, date: d(y), title: 'Gym', color: '#0f0', startTime: '07:00', endTime: '08:00' } });
        const open = await prisma.dailyScheduleSlot.create({ data: { userId: user.id, date: d(y), title: 'Read', color: '#00f', startTime: '20:00', endTime: '21:00', sortOrder: 1 } });
        await prisma.blockSessionLog.create({ data: { timeBlockId: block.id, date: d(y), status: 'SKIPPED' } });

        const res = await api(user).get('/api/today');
        expect(res.body.data.triage).toMatchObject({ kind: 'debrief', date: y, existingDebrief: null });
        expect(res.body.data.triage.slots.map((s: any) => s._id)).toEqual([open.id]);
        expect((await prisma.dailyScheduleSlot.findUniqueOrThrow({ where: { id: healed.id } })).status).toBe('UPCOMING');
    });
});

describe('time zones', () => {
    it('a New York user at 23:30 local is still on the previous day (IST user is on the next)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-21T03:30:00Z')); // 23:30 EDT on 10-20, 09:00 IST on 10-21
        const ny = await createLearner(NY);
        const ist = await createLearner(IST);
        for (const u of [ny, ist]) {
            const c = await prisma.capture.create({ data: { userId: u.id, content: 'tz' } });
            await createChainRows(u.id, { captureId: c.id }, '2026-10-19'); // cycle 1 due 2026-10-20
        }
        const nyToday = (await api(ny).get('/api/today')).body.data;
        expect(nyToday.today).toBe('2026-10-20');
        expect(nyToday.revisions.dueToday).toHaveLength(1);
        expect(nyToday.revisions.overdue).toHaveLength(0);

        const istToday = (await api(ist).get('/api/today')).body.data;
        expect(istToday.today).toBe('2026-10-21');
        expect(istToday.revisions.overdue[0]).toMatchObject({ scheduledFor: '2026-10-20', daysLate: 1 });

        // Completing at 23:30 New York time counts for 10-20 there: re-anchored on 10-20, streak credited on 10-20.
        const id = nyToday.revisions.dueToday[0]._id;
        const done = await api(ny).post(`/api/revisions/${id}/complete`);
        expect(done.body.data.chain.map((r: any) => r.scheduledFor)).toEqual(['2026-10-20', '2026-10-22', '2026-10-26', '2026-11-09']);
        const u = await prisma.user.findUniqueOrThrow({ where: { id: ny.id } });
        expect(u.lastGlobalStreakDay?.toISOString().slice(0, 10)).toBe('2026-10-20');
        // Still "done today" for the NY user until their midnight.
        expect((await api(ny).get('/api/today')).body.data.revisions.doneToday).toHaveLength(1);
        vi.setSystemTime(new Date('2026-10-21T04:30:00Z')); // 00:30 EDT on 10-21
        expect((await api(ny).get('/api/today')).body.data.revisions.doneToday).toHaveLength(0);
    });
});
