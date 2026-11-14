// LEARNING_SPEC §2 #3, #25–33: settings, Day Manager save (+ actual times), debrief, catch-up,
// time blocks, the weekly-goal shift and the mentor export.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { api, createChainRows, createLearner, d } from '../helpers/learning';

// Fixed clock: 2026-10-21 10:00 IST (a Wednesday).
const NOW = new Date('2026-10-21T04:30:00Z');
const TODAY = '2026-10-21';

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});

const slotRow = (userId: string, date: string, over: Record<string, unknown> = {}) =>
    prisma.dailyScheduleSlot.create({
        data: { userId, date: d(date), title: 'Block', color: '#000', startTime: '09:00', endTime: '10:00', ...over },
    });

describe('PATCH /api/learning/settings', () => {
    it('updates timezone and routine mode; 400 INVALID_TIMEZONE', async () => {
        const user = await createLearner('Asia/Kolkata', { routineEnabled: true });
        const ok = await api(user).patch('/api/learning/settings', { timezone: 'America/New_York', routineMode: 'DAILY' });
        expect(ok.body.data).toMatchObject({ timezone: 'America/New_York', routineMode: 'DAILY' });
        expect((await api(user).get('/api/today')).body.data).toMatchObject({ today: '2026-10-21', timezone: 'America/New_York', schedule: { routineMode: 'DAILY' } });
        const bad = await api(user).patch('/api/learning/settings', { timezone: 'Mars/Olympus' });
        expect([bad.status, bad.body.code]).toEqual([400, 'INVALID_TIMEZONE']);
        expect((await api(user).patch('/api/learning/settings', { routineMode: 'WEEKLY' })).status).toBe(400);
    });
});

describe('PUT /api/schedule/today', () => {
    it('creates new-…, updates, deletes missing slots; stamps actual times; syncs block logs', async () => {
        const user = await createLearner();
        const block = await prisma.timeBlock.create({ data: { userId: user.id, title: 'Deep work', startTime: '09:00', endTime: '11:00', color: '#111' } });
        const deep = await slotRow(user.id, TODAY, { sourceBlockId: block.id, title: 'Deep work', startTime: '09:00', endTime: '11:00' });
        const gone = await slotRow(user.id, TODAY, { title: 'Drop me', sortOrder: 1 });

        const started = await api(user).put('/api/schedule/today', {
            slots: [
                { _id: deep.id, title: 'Deep work', color: '#111', startTime: '09:00', endTime: '11:00', status: 'ACTIVE', sortOrder: 0, remark: null },
                { _id: 'new-1', title: 'Walk', color: '#6b7280', startTime: '11:00', endTime: '11:30', status: 'COMPLETED', sortOrder: 1, remark: '' },
            ],
        });
        expect(started.status).toBe(200);
        expect(started.body.data.map((s: any) => [s.title, s.status, s.actualStartTime, s.actualEndTime])).toEqual([
            ['Deep work', 'ACTIVE', '10:00', null],
            ['Walk', 'UPCOMING', null, null], // new slots are created UPCOMING (as Revise)
        ]);
        expect(await prisma.dailyScheduleSlot.count({ where: { id: gone.id } })).toBe(0);

        vi.setSystemTime(new Date(NOW.getTime() + 75 * 60_000)); // 11:15 IST
        const done = await api(user).put('/api/schedule/today', {
            slots: [{ _id: deep.id, title: 'Deep work', color: '#111', startTime: '09:00', endTime: '11:00', status: 'PARTIAL', sortOrder: 0, remark: 'phone', minutesDone: 50 }],
        });
        expect(done.body.data).toEqual([
            expect.objectContaining({ _id: deep.id, status: 'PARTIAL', actualStartTime: '10:00', actualEndTime: '11:15', remark: 'phone', minutesDone: 50 }),
        ]);
        expect(await prisma.blockSessionLog.findFirst({ where: { timeBlockId: block.id } })).toMatchObject({ status: 'PARTIAL', remark: 'phone', minutesDone: 50 });
    });

    it('400 INVALID_TIME / bad status; foreign slot ids are ignored', async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        const theirs = await slotRow(stranger.id, TODAY);
        const bad = await api(user).put('/api/schedule/today', { slots: [{ _id: 'new-1', title: 'x', color: '#000', startTime: '25:00', endTime: '26:00', status: 'UPCOMING', sortOrder: 0 }] });
        expect([bad.status, bad.body.code]).toEqual([400, 'INVALID_TIME']);
        expect((await api(user).put('/api/schedule/today', { slots: [{ _id: 'new-1', title: 'x', color: '#000', startTime: '09:00', endTime: '10:00', status: 'DONE', sortOrder: 0 }] })).status).toBe(400);
        const res = await api(user).put('/api/schedule/today', {
            slots: [{ _id: theirs.id, title: 'hijack', color: '#000', startTime: '09:00', endTime: '10:00', status: 'COMPLETED', sortOrder: 0 }],
        });
        expect(res.body.data).toEqual([]);
        expect((await prisma.dailyScheduleSlot.findUniqueOrThrow({ where: { id: theirs.id } })).title).toBe('Block');
    });
});

describe('PUT /api/debriefs/:day', () => {
    const form = { energy: 4, focus: 3, mood: 5, tags: ['Focused'], narrative: ' Good day ', tomorrowIntent: '', freeWrite: '' };

    it('counts ALL of the day\'s slots, merges the client edits, writes slots + logs; upserts', async () => {
        const user = await createLearner();
        const block = await prisma.timeBlock.create({ data: { userId: user.id, title: 'Gym', startTime: '07:00', endTime: '08:00', color: '#0f0' } });
        const y = '2026-10-20';
        const gym = await slotRow(user.id, y, { sourceBlockId: block.id, startTime: '07:00', endTime: '08:00' });
        await slotRow(user.id, y, { status: 'COMPLETED', startTime: '09:00', endTime: '10:30', sortOrder: 1 });
        await slotRow(user.id, y, { status: 'SKIPPED', sortOrder: 2 });

        const res = await api(user).put(`/api/debriefs/${y}`, { form, slots: [{ _id: gym.id, status: 'COMPLETED', remark: ' early ', minutesDone: 45, actualStartTime: null, actualEndTime: null }] });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ date: y, blocksPlanned: 3, blocksCompleted: 2, blocksSkipped: 1, totalFocusedMin: 45 + 90, energy: 4, narrative: 'Good day', tomorrowIntent: null, tags: ['Focused'] });
        expect(await prisma.dailyScheduleSlot.findUniqueOrThrow({ where: { id: gym.id } })).toMatchObject({ status: 'COMPLETED', remark: 'early', minutesDone: 45 });
        expect(await prisma.blockSessionLog.findFirst({ where: { timeBlockId: block.id } })).toMatchObject({ status: 'COMPLETED', minutesDone: 45 });

        const again = await api(user).put(`/api/debriefs/${y}`, { form: { ...form, mood: 2 }, slots: [] });
        expect(again.body.data).toMatchObject({ _id: res.body.data._id, mood: 2 });
        expect(await prisma.dayDebrief.count({ where: { userId: user.id } })).toBe(1);
    });

    it('400: a future day, an invalid day, missing ratings (DEBRIEF_INVALID), a bad actual time', async () => {
        const user = await createLearner();
        expect((await api(user).put('/api/debriefs/2026-10-22', { form, slots: [] })).body.code).toBe('INVALID_DAY');
        expect((await api(user).put('/api/debriefs/2026-13-01', { form, slots: [] })).status).toBe(400);
        const invalid = await api(user).put(`/api/debriefs/${TODAY}`, { form: { ...form, energy: null }, slots: [] });
        expect([invalid.status, invalid.body.code]).toEqual([400, 'DEBRIEF_INVALID']);
        const s = await slotRow(user.id, TODAY);
        const badTime = await api(user).put(`/api/debriefs/${TODAY}`, { form, slots: [{ _id: s.id, status: 'COMPLETED', actualStartTime: '9am' }] });
        expect([badTime.status, badTime.body.code]).toEqual([400, 'INVALID_TIME']);
    });

    it('a New York user: "today" there is still 2026-10-20 at 00:30 IST... and 10-21 is the future', async () => {
        vi.setSystemTime(new Date('2026-10-20T19:00:00Z')); // 15:00 EDT 10-20, 00:30 IST 10-21
        const ny = await createLearner('America/New_York');
        expect((await api(ny).put('/api/debriefs/2026-10-21', { form, slots: [] })).body.code).toBe('INVALID_DAY');
        expect((await api(ny).put('/api/debriefs/2026-10-20', { form, slots: [] })).status).toBe(200);
    });
});

describe('POST /api/schedule/catch-up', () => {
    const context = { energy: 2, focus: 2, mood: 3, tags: ['Sick'], narrative: 'Flu' };

    it('heals from logs first, skips the unresolved, keeps exceptions, one debrief per day with focus minutes', async () => {
        const user = await createLearner('Asia/Kolkata', { routineEnabled: true });
        const block = await prisma.timeBlock.create({ data: { userId: user.id, title: 'Gym', startTime: '07:00', endTime: '08:00', color: '#0f0' } });
        const healed = await slotRow(user.id, '2026-10-18', { sourceBlockId: block.id });
        await prisma.blockSessionLog.create({ data: { timeBlockId: block.id, date: d('2026-10-18'), status: 'COMPLETED', remark: 'logged' } });
        const skipped = await slotRow(user.id, '2026-10-18', { sortOrder: 1 });
        const exception = await slotRow(user.id, '2026-10-19', { startTime: '10:00', endTime: '10:40' });

        const res = await api(user).post('/api/schedule/catch-up', {
            dates: ['2026-10-19', '2026-10-18'],
            context,
            decisions: [{ slotId: exception.id, status: 'COMPLETED', remark: 'did it' }],
        });
        expect(res.status).toBe(200);
        expect(res.body.data.debriefs.map((x: any) => [x.date, x.blocksPlanned, x.blocksCompleted, x.blocksSkipped, x.totalFocusedMin, x.narrative])).toEqual([
            ['2026-10-18', 2, 1, 1, 60, 'Flu'],
            ['2026-10-19', 1, 1, 0, 40, 'Flu'],
        ]);
        expect((await prisma.dailyScheduleSlot.findUniqueOrThrow({ where: { id: healed.id } })).status).toBe('COMPLETED');
        expect((await prisma.dailyScheduleSlot.findUniqueOrThrow({ where: { id: skipped.id } })).status).toBe('SKIPPED');
        expect(await prisma.dailyScheduleSlot.findUniqueOrThrow({ where: { id: exception.id } })).toMatchObject({ status: 'COMPLETED', remark: 'did it' });
        // Triage is cleared.
        expect((await api(user).get('/api/today')).body.data.triage).toEqual({ kind: 'none' });
    });

    it('400 CATCH_UP_INVALID without a narrative, for today, or with no dates', async () => {
        const user = await createLearner();
        expect((await api(user).post('/api/schedule/catch-up', { dates: ['2026-10-19'], context: { ...context, narrative: ' ' } })).body.code).toBe('CATCH_UP_INVALID');
        expect((await api(user).post('/api/schedule/catch-up', { dates: [TODAY], context })).body.code).toBe('CATCH_UP_INVALID');
        expect((await api(user).post('/api/schedule/catch-up', { dates: [], context })).status).toBe(400);
    });
});

describe('time blocks (#30–33)', () => {
    it('CRUD, scoped to the owner; 400 bad times', async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        const created = await api(user).post('/api/schedule/blocks', { title: 'Deep work', startTime: '09:00', endTime: '11:00', color: '#123456' });
        expect(created.status).toBe(201);
        expect(created.body.data).toMatchObject({ title: 'Deep work', dayOfWeek: null, date: null });
        const id = created.body.data._id;
        await api(user).post('/api/schedule/blocks', { title: 'Mon gym', startTime: '07:00', endTime: '08:00', dayOfWeek: 0 });
        expect((await api(user).get('/api/schedule/blocks')).body.data.map((b: any) => b.title)).toEqual(['Deep work', 'Mon gym']);
        expect((await api(user).patch(`/api/schedule/blocks/${id}`, { endTime: '12:00' })).body.data.endTime).toBe('12:00');
        expect((await api(user).patch(`/api/schedule/blocks/${id}`, { endTime: '12:61' })).body.code).toBe('INVALID_TIME');
        expect((await api(user).post('/api/schedule/blocks', { title: 'x', startTime: '9', endTime: '10:00' })).status).toBe(400);
        expect((await api(stranger).patch(`/api/schedule/blocks/${id}`, { title: 'x' })).status).toBe(404);
        expect((await api(stranger).delete(`/api/schedule/blocks/${id}`)).status).toBe(404);
        expect((await api(stranger).get('/api/schedule/blocks')).body.data).toEqual([]);
        expect((await api(user).delete(`/api/schedule/blocks/${id}`)).body.data).toEqual({ deleted: true });
    });
});

describe('POST /api/learning/goals/:todoId/shift', () => {
    it('THIS_WEEK → weekly due Sunday 18:00 local; MONTHLY → end of month; 404 foreign', async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        const todo = await prisma.todo.create({ data: { userId: user.id, title: 'Old goal', goalType: 'WEEKLY', dueDate: new Date('2026-10-11T12:30:00Z') } });
        const week = await api(user).post(`/api/learning/goals/${todo.id}/shift`, { target: 'THIS_WEEK' });
        expect(week.body.data).toMatchObject({ _id: todo.id, goalType: 'WEEKLY', dueDate: '2026-10-25T12:30:00.000Z' });
        const month = await api(user).post(`/api/learning/goals/${todo.id}/shift`, { target: 'MONTHLY' });
        expect(month.body.data).toMatchObject({ goalType: 'MONTHLY', dueDate: '2026-10-31T12:30:00.000Z' });
        expect((await api(stranger).post(`/api/learning/goals/${todo.id}/shift`, { target: 'MONTHLY' })).status).toBe(404);
        expect((await api(user).post(`/api/learning/goals/${todo.id}/shift`, { target: 'YEAR' })).status).toBe(400);
    });

    it('the Monday weekly review lists unresolved weekly goals from earlier weeks', async () => {
        vi.setSystemTime(new Date('2026-10-19T04:30:00Z')); // Monday 10:00 IST
        const user = await createLearner();
        const stale = await prisma.todo.create({ data: { userId: user.id, title: 'Stale', goalType: 'WEEKLY', dueDate: new Date('2026-10-18T12:30:00Z') } });
        await prisma.todo.create({ data: { userId: user.id, title: 'This week', goalType: 'WEEKLY', dueDate: new Date('2026-10-25T12:30:00Z') } });
        const review = (await api(user).get('/api/today')).body.data.weeklyReview;
        expect(review.isReviewDay).toBe(true);
        expect(review.goals.map((g: any) => g._id)).toEqual([stale.id]);
    });
});

describe('GET /api/learning/export/mentor', () => {
    it('builds the prompt from the range; 400 INVALID_RANGE / bad days', async () => {
        const user = await createLearner();
        await slotRow(user.id, '2026-10-20', { title: 'DSA practice', status: 'COMPLETED', remark: 'two mediums' });
        const capture = await prisma.capture.create({ data: { userId: user.id, title: 'Segment trees' } });
        await createChainRows(user.id, { captureId: capture.id }, '2026-10-18', { 1: { status: 'done', completedAt: new Date('2026-10-20T06:00:00Z') } });
        const res = await api(user).get('/api/learning/export/mentor?from=2026-10-14&to=2026-10-20');
        expect(res.status).toBe(200);
        expect(typeof res.body.data.prompt).toBe('string');
        expect(res.body.data.prompt).toContain('DSA practice');
        expect(res.body.data.prompt).toContain('Segment trees');

        expect((await api(user).get('/api/learning/export/mentor?from=2026-10-20&to=2026-10-14')).body.code).toBe('INVALID_RANGE');
        expect((await api(user).get('/api/learning/export/mentor?from=2026-01-01&to=2026-10-14')).body.code).toBe('INVALID_RANGE');
        expect((await api(user).get('/api/learning/export/mentor?from=yesterday&to=2026-10-14')).status).toBe(400);
    });
});
