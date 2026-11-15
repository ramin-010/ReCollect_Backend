// LOOP_V2_SPEC (daily loop v2): settings, GET /api/today plan / focus / goals / rhythm, routine off
// by default, ensure-today → lastSeenDay, focus + goals + milestones CRUD, fresh start, and the
// America/New_York day edge. Fixed clock: Sat 2026-11-14 10:00 IST.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { addDays } from '../../src/services/learning';
import { api, chainDays, createChainRows, createLearner, createSubjectRow, createTopicRow, d, recordSql } from '../helpers/learning';

const NOW = new Date('2026-11-14T04:30:00Z');
const TODAY = '2026-11-14';
const NY = 'America/New_York';
const ago = (n: number) => addDays(TODAY, -n);
const inDays = (n: number) => addDays(TODAY, n);
const OLD_DONE = new Date('2026-09-01T10:00:00Z');
/** Rolled over and seen today: GET /api/today needs no ensure, mode is normal. */
const SEEN = { learningRolledOverDay: d(TODAY), lastSeenDay: d(TODAY), prevSeenDay: d(ago(1)) };
const dayStr = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : null);

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});

let n = 0;
/** A capture whose earliest pending revision is `cycle` (1 = 8 min, 2 = 5 min), due on `due`. */
async function item(userId: string, due: string, opts: { cycle?: 1 | 2; subjectId?: string | null; title?: string } = {}) {
    n += 1;
    const capture = await prisma.capture.create({ data: { userId, title: opts.title ?? `Item ${n}`, content: 'x', subjectId: opts.subjectId ?? null } });
    if ((opts.cycle ?? 2) === 1) return { capture, chain: await createChainRows(userId, { captureId: capture.id }, addDays(due, -1)) };
    // Cycle 1 done long ago; cycle 2 due on `due` (cycles 3 and 4 follow 4 and 18 days later).
    const chain = await createChainRows(userId, { captureId: capture.id }, addDays(due, -3), {
        1: { status: 'done', completedAt: OLD_DONE, scheduledFor: addDays(due, -2) },
    });
    return { capture, chain };
}

describe('auth: 401 without a cookie on every loop v2 route', () => {
    it('settings, focus, goals, milestones, fresh start', async () => {
        const calls = [
            request(app).get('/api/learning/settings'),
            request(app).patch('/api/learning/settings').send({ dailyBudgetMin: 30 }),
            request(app).post('/api/focus').send({ text: 'x' }),
            request(app).patch('/api/focus/x').send({ done: true }),
            request(app).delete('/api/focus/x'),
            request(app).post('/api/focus/carry-over').send({ ids: ['x'] }),
            request(app).get('/api/goals'),
            request(app).post('/api/goals').send({ title: 'x', deadline: inDays(30) }),
            request(app).patch('/api/goals/x').send({ title: 'y' }),
            request(app).delete('/api/goals/x'),
            request(app).post('/api/goals/x/milestones').send({ title: 'm' }),
            request(app).patch('/api/goal-milestones/x').send({ done: true }),
            request(app).delete('/api/goal-milestones/x'),
            request(app).post('/api/revisions/fresh-start'),
        ];
        for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
    });
});

// ─── §1 Settings ───────────────────────────────────────────────────────

describe('GET / PATCH /api/learning/settings', () => {
    it('defaults: budget 25, routine off, no busy week, nudge on at 08:30', async () => {
        const user = await createLearner();
        const res = await api(user).get('/api/learning/settings');
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            dailyBudgetMin: 25,
            routineEnabled: false,
            busyUntil: null,
            nudgeEmailEnabled: true,
            nudgeTime: '08:30',
            lastNudgeDay: null,
            lastSeenDay: null,
            timezone: 'Asia/Kolkata',
            routineMode: 'MASTER',
            agentProfile: null,
        });
    });

    it('PATCH accepts any subset and answers with all settings; nudgeTime is stored as HH:mm', async () => {
        const user = await createLearner();
        const res = await api(user).patch('/api/learning/settings', { dailyBudgetMin: 40, busyUntil: inDays(6), nudgeTime: '7:05', nudgeEmailEnabled: false });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ dailyBudgetMin: 40, busyUntil: inDays(6), nudgeTime: '07:05', nudgeEmailEnabled: false, routineEnabled: false });
        const cleared = await api(user).patch('/api/learning/settings', { busyUntil: null });
        expect(cleared.body.data).toMatchObject({ busyUntil: null, dailyBudgetMin: 40 });
        expect((await api(user).patch('/api/learning/settings', {})).body.data.dailyBudgetMin).toBe(40);
    });

    it('lastNudgeDay / lastSeenDay are read-only (ignored by PATCH)', async () => {
        const user = await createLearner();
        const res = await api(user).patch('/api/learning/settings', { lastSeenDay: TODAY, lastNudgeDay: TODAY, dailyBudgetMin: 30 });
        expect(res.body.data).toMatchObject({ lastSeenDay: null, lastNudgeDay: null, dailyBudgetMin: 30 });
    });

    it('400 INVALID_INPUT for out-of-range or malformed values', async () => {
        const user = await createLearner();
        for (const body of [
            { dailyBudgetMin: 4 },
            { dailyBudgetMin: 121 },
            { dailyBudgetMin: 25.5 },
            { dailyBudgetMin: '25' },
            { nudgeTime: '25:00' },
            { nudgeTime: '8.30' },
            { busyUntil: '2026-02-30' },
            { routineEnabled: 'yes' },
            { nudgeEmailEnabled: 1 },
        ]) {
            const res = await api(user).patch('/api/learning/settings', body);
            expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, 'INVALID_INPUT']);
        }
        const tz = await api(user).patch('/api/learning/settings', { timezone: 'Mars/Olympus' });
        expect([tz.status, tz.body.code]).toEqual([400, 'INVALID_TIMEZONE']);
    });
});

// ─── §6 Routine off by default ─────────────────────────────────────────

describe('routine off (the default)', () => {
    it('GET /api/today: schedule, triage and todayDebrief are null even with unresolved slots and a debrief', async () => {
        const user = await createLearner('Asia/Kolkata', SEEN);
        await prisma.dailyScheduleSlot.create({ data: { userId: user.id, date: d(ago(1)), title: 'Gym', color: '#0f0', startTime: '07:00', endTime: '08:00' } });
        await prisma.dayDebrief.create({ data: { userId: user.id, date: d(TODAY), narrative: 'x' } });
        const data = (await api(user).get('/api/today')).body.data;
        expect([data.schedule, data.triage, data.todayDebrief]).toEqual([null, null, null]);
        expect(data.stats).toMatchObject({ adherence: null, adherenceTotal: 0 });
    });

    it('the rollover creates and backfills no slots, but still settles the streak', async () => {
        const user = await createLearner('Asia/Kolkata', { learningRolledOverDay: d(ago(3)), globalStreak: 4, longestGlobalStreak: 4, lastGlobalStreakDay: d(ago(5)) });
        await prisma.timeBlock.create({ data: { userId: user.id, title: 'Deep work', startTime: '09:00', endTime: '11:00', color: '#111', createdAt: new Date('2026-09-01T00:00:00Z') } });
        const res = await api(user).post('/api/learning/ensure-today');
        expect(res.body.data).toEqual({ rolledOver: true, days: 3 });
        expect(await prisma.dailyScheduleSlot.count({ where: { userId: user.id } })).toBe(0);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).globalStreak).toBe(0);
    });

    it("switching it on creates today's slots at once; the days it was off are never backfilled", async () => {
        // The rollover ran every day with the routine off (last on 11-13); the last slots are from September.
        const user = await createLearner('Asia/Kolkata', { learningRolledOverDay: d(ago(1)), lastSeenDay: d(ago(1)) });
        const block = await prisma.timeBlock.create({ data: { userId: user.id, title: 'Gym', startTime: '07:00', endTime: '08:00', color: '#0f0', createdAt: new Date('2026-08-01T00:00:00Z') } });
        await prisma.dailyScheduleSlot.create({ data: { userId: user.id, sourceBlockId: block.id, date: d('2026-09-20'), title: 'Gym', color: '#0f0', startTime: '07:00', endTime: '08:00', status: 'COMPLETED' } });
        await api(user).post('/api/learning/ensure-today'); // rolls into 11-14 with the routine off: no slots

        const on = await api(user).patch('/api/learning/settings', { routineEnabled: true });
        expect(on.body.data.routineEnabled).toBe(true);
        const today = (await api(user).get('/api/today')).body.data;
        expect(today.schedule.slots.map((s: any) => [s.date, s.title])).toEqual([[TODAY, 'Gym']]);
        expect(today.triage).toEqual({ kind: 'none' });

        // Next day: today's slots, no backfill of the weeks the routine was off.
        vi.setSystemTime(new Date('2026-11-15T04:30:00Z'));
        await api(user).post('/api/learning/ensure-today');
        const slots = await prisma.dailyScheduleSlot.findMany({ where: { userId: user.id }, orderBy: { date: 'asc' } });
        expect(slots.map((s) => dayStr(s.date))).toEqual(['2026-09-20', TODAY, '2026-11-15']);
        expect((await api(user).get('/api/today')).body.data.triage).toMatchObject({ kind: 'debrief', date: TODAY });

        const off = await api(user).patch('/api/learning/settings', { routineEnabled: false });
        expect(off.body.data.routineEnabled).toBe(false);
        expect((await api(user).get('/api/today')).body.data.schedule).toBeNull();
    });
});

// ─── §1 ensure-today → lastSeenDay; needsEnsure ────────────────────────

describe('POST /api/learning/ensure-today marks the app seen', () => {
    it('lastSeenDay = today on the first call of the day (prevSeenDay keeps the old one); later calls change nothing', async () => {
        const user = await createLearner('Asia/Kolkata', { learningRolledOverDay: d(TODAY), lastSeenDay: d(ago(4)) });
        expect((await api(user).get('/api/today')).body.data.needsEnsure).toBe(true); // rolled over, but not seen today
        await api(user).post('/api/learning/ensure-today');
        let u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect([dayStr(u.lastSeenDay), dayStr(u.prevSeenDay)]).toEqual([TODAY, ago(4)]);
        await api(user).post('/api/learning/ensure-today');
        u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect([dayStr(u.lastSeenDay), dayStr(u.prevSeenDay)]).toEqual([TODAY, ago(4)]);
        expect((await api(user).get('/api/today')).body.data.needsEnsure).toBe(false);
        expect((await api(user).get('/api/learning/settings')).body.data.lastSeenDay).toBe(TODAY);
    });

    it('the cron rollover does not mark the app seen', async () => {
        const user = await createLearner('Asia/Kolkata', { learningRolledOverDay: d(ago(1)) });
        await item(user.id, ago(1));
        const { runLearningRolloverPass } = await import('../../src/services/learningDb/rollover.service');
        await runLearningRolloverPass();
        const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect([dayStr(u.learningRolledOverDay), u.lastSeenDay]).toEqual([TODAY, null]);
    });
});

// ─── §2 Plan ───────────────────────────────────────────────────────────

describe('GET /api/today: plan', () => {
    it('a big overdue backlog: the budget plans a few, the rest waits; old revisions block kept', async () => {
        const user = await createLearner('Asia/Kolkata', SEEN);
        for (let i = 0; i < 15; i++) await item(user.id, ago(i < 4 ? 35 - i : 2 + i), { cycle: i % 5 === 0 ? 1 : 2 });
        await item(user.id, TODAY);
        await item(user.id, TODAY, { cycle: 1 });
        await item(user.id, inDays(1)); // not due yet

        const data = (await api(user).get('/api/today')).body.data;
        const plan = data.plan;
        expect(plan).toMatchObject({ mode: 'normal', budgetMin: 25 });
        expect(plan.estMinutes).toBeLessThanOrEqual(25);
        expect(plan.planned.length).toBeGreaterThanOrEqual(3);
        expect(plan.planned.length + plan.waitingCount).toBe(17);
        expect(plan.estMinutes).toBe(plan.planned.reduce((s: number, r: any) => s + r.minutes, 0));
        expect(plan.doneToday).toEqual([]);
        // Same item shape as the old buckets (+ minutes); cycle 1 (8 min) first, then the most late.
        expect(plan.planned[0]).toMatchObject({ kind: 'capture', cycleNumber: 1, minutes: 8, status: 'pending' });
        expect(plan.planned[0]).toHaveProperty('daysLate');
        expect(plan.planned.map((r: any) => r.cycleNumber)).toEqual([...plan.planned.map((r: any) => r.cycleNumber)].sort());
        expect(data.revisions.totalDue).toBe(17);
    });

    it("an active goal's subjects come first", async () => {
        const user = await createLearner('Asia/Kolkata', SEEN);
        const dsa = await createSubjectRow(user.id, 'DSA');
        const other = await createSubjectRow(user.id, 'Other');
        await item(user.id, ago(20), { cycle: 1, subjectId: other.id, title: 'Old other' });
        await item(user.id, TODAY, { cycle: 2, subjectId: dsa.id, title: 'Goal subject' });
        await api(user).post('/api/goals', { title: 'SDE role', deadline: '2027-06-30', subjectIds: [dsa.id] });
        const plan = (await api(user).get('/api/today')).body.data.plan;
        expect(plan.planned.map((r: any) => r.title)).toEqual(['Goal subject', 'Old other']);
    });

    it('busy week: mode busy, budget capped at 10, just 3 things', async () => {
        const user = await createLearner('Asia/Kolkata', { ...SEEN, busyUntil: d(inDays(6)) });
        for (let i = 1; i <= 8; i++) await item(user.id, ago(i));
        const plan = (await api(user).get('/api/today')).body.data.plan;
        expect(plan).toMatchObject({ mode: 'busy', budgetMin: 10, estMinutes: 15, waitingCount: 5 });
        expect(plan.planned).toHaveLength(3);
    });

    it('comeback after days away: at most 5 that day, before and after ensure-today, then normal the next day', async () => {
        const user = await createLearner('Asia/Kolkata', { learningRolledOverDay: d(ago(5)), lastSeenDay: d(ago(5)), dailyBudgetMin: 120 });
        for (let i = 1; i <= 9; i++) await item(user.id, ago(i));
        const before = (await api(user).get('/api/today')).body.data;
        expect([before.needsEnsure, before.plan.mode, before.plan.planned.length, before.plan.waitingCount]).toEqual([true, 'comeback', 5, 4]);
        await api(user).post('/api/learning/ensure-today');
        const after = (await api(user).get('/api/today')).body.data;
        expect([after.needsEnsure, after.plan.mode, after.plan.planned.length]).toEqual([false, 'comeback', 5]);

        vi.setSystemTime(new Date('2026-11-15T04:30:00Z'));
        await api(user).post('/api/learning/ensure-today');
        expect((await api(user).get('/api/today')).body.data.plan.mode).toBe('normal');
    });

    it('never seen (lastSeenDay null) with history = comeback; without history = normal', async () => {
        const back = await createLearner('Asia/Kolkata', { learningRolledOverDay: d(TODAY) });
        await item(back.id, ago(1)); // its cycle 1 was completed in September
        expect((await api(back).get('/api/today')).body.data.plan.mode).toBe('comeback');
        const fresh = await createLearner('Asia/Kolkata', { learningRolledOverDay: d(TODAY) });
        await item(fresh.id, TODAY, { cycle: 1 });
        expect((await api(fresh).get('/api/today')).body.data.plan.mode).toBe('normal');
    });

    it('a small budget still plans 3; completing the plan empties it instead of refilling (done items count)', async () => {
        const user = await createLearner('Asia/Kolkata', { ...SEEN, dailyBudgetMin: 5 });
        for (let i = 1; i <= 5; i++) await item(user.id, ago(i), { cycle: 1 });
        let plan = (await api(user).get('/api/today')).body.data.plan;
        expect([plan.planned.length, plan.estMinutes, plan.waitingCount]).toEqual([3, 24, 2]);
        const ids = plan.planned.map((r: any) => r._id);
        for (const id of ids) expect((await api(user).post(`/api/revisions/${id}/complete`)).status).toBe(200);
        plan = (await api(user).get('/api/today')).body.data.plan;
        expect([plan.planned.length, plan.waitingCount]).toEqual([0, 2]);
        expect(plan.doneToday.map((r: any) => r._id).sort()).toEqual([...ids].sort());
        expect(plan.doneToday[0]).toMatchObject({ status: 'done', canUndo: true, minutes: 8 });
    });
});

// ─── §3–5 focus, goals, rhythm in GET /api/today ───────────────────────

describe('GET /api/today: focus, goals, rhythm', () => {
    it("focus: today's lines, and yesterday's unfinished ones not on today's list yet", async () => {
        const user = await createLearner('Asia/Kolkata', SEEN);
        const mk = (day: string, text: string, done = false, sortOrder = 0) => prisma.focusItem.create({ data: { userId: user.id, day: d(day), text, done, sortOrder } });
        await mk(TODAY, 'Ship the API', false, 0);
        const y1 = await mk(ago(1), 'Read DDIA ch. 5', false, 0);
        await mk(ago(1), 'Gym', true, 1);
        await mk(ago(1), 'ship the  API', false, 2); // same line as today's
        await mk(ago(2), 'Older', false, 0);
        const focus = (await api(user).get('/api/today')).body.data.focus;
        expect(focus.items.map((f: any) => [f.text, f.day, f.done])).toEqual([['Ship the API', TODAY, false]]);
        expect(focus.carryOver.map((f: any) => f._id)).toEqual([y1.id]);
        expect(focus.items[0]).toEqual({ _id: expect.any(String), day: TODAY, text: 'Ship the API', done: false, sortOrder: 0, createdAt: expect.any(String) });
    });

    it('goals: active ones only, nearest deadline first, with daysLeft, progress, forecast, nextMilestone', async () => {
        const user = await createLearner('Asia/Kolkata', SEEN);
        const later = (await api(user).post('/api/goals', { title: 'Later', deadline: '2027-06-30', milestones: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] })).body.data;
        await api(user).patch(`/api/goal-milestones/${later.milestones[0]._id}`, { done: true });
        await api(user).post('/api/goals', { title: 'Sooner', deadline: '2026-12-31' });
        const archived = (await api(user).post('/api/goals', { title: 'Shelved', deadline: '2027-01-31' })).body.data;
        await api(user).patch(`/api/goals/${archived._id}`, { status: 'archived' });

        const goals = (await api(user).get('/api/today')).body.data.goals;
        expect(goals.map((g: any) => g.title)).toEqual(['Sooner', 'Later']);
        expect(Object.keys(goals[1]).sort()).toEqual(['_id', 'daysLeft', 'deadline', 'forecast', 'nextMilestone', 'progress', 'title']);
        expect(goals[1]).toMatchObject({ deadline: '2027-06-30', daysLeft: 228, progress: { done: 1, total: 3 }, nextMilestone: { title: 'B', done: false } });
        expect(goals[1].forecast).toMatchObject({ daysLeft: 228, progress: { done: 1, total: 3 }, status: 'ahead', projectedDay: inDays(14) });
        expect(goals[0]).toMatchObject({ title: 'Sooner', nextMilestone: null, forecast: { status: 'no_data', suggestion: 'Add a few milestones to see a forecast.' } });
    });

    it('rhythm: last 7 days, active with a completed revision (user zone) or a done focus line', async () => {
        const user = await createLearner('Asia/Kolkata', SEEN);
        const { chain } = await item(user.id, ago(1));
        await api(user).post(`/api/revisions/${chain[1]!.id}/complete`); // today
        const other = await item(user.id, ago(3));
        await prisma.revision.update({ where: { id: other.chain[1]!.id }, data: { status: 'done', completedAt: new Date('2026-11-11T19:00:00Z') } }); // 00:30 IST on 11-12
        await prisma.focusItem.create({ data: { userId: user.id, day: d(ago(4)), text: 'x', done: true } });
        await prisma.focusItem.create({ data: { userId: user.id, day: d(ago(5)), text: 'not done' } });
        const stats = (await api(user).get('/api/today')).body.data.stats;
        expect(stats.rhythm.last7).toEqual([
            { day: ago(6), active: false },
            { day: ago(5), active: false },
            { day: ago(4), active: true },
            { day: ago(3), active: false },
            { day: ago(2), active: true },
            { day: ago(1), active: false },
            { day: TODAY, active: true },
        ]);
        expect(stats.rhythm.activeDays).toBe(3);
        expect(stats).toHaveProperty('streak'); // kept for back-compat
    });

    it('still zero writes with plan, focus, goals and rhythm (and the history check for comeback)', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id);
        const { topic } = await createTopicRow(user.id, s.id);
        await createChainRows(user.id, { topicId: topic.id }, ago(3), { 1: { status: 'done', completedAt: OLD_DONE } });
        await item(user.id, ago(1), { subjectId: s.id });
        await prisma.focusItem.create({ data: { userId: user.id, day: d(ago(1)), text: 'carry me' } });
        await api(user).post('/api/goals', { title: 'Goal', deadline: '2027-06-30', subjectIds: [s.id], milestones: [{ title: 'M1' }] });

        const { result: res, sql } = await recordSql(() => api(user).get('/api/today'));
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ needsEnsure: true, plan: { mode: 'comeback' }, focus: { carryOver: [expect.objectContaining({ text: 'carry me' })] } });
        const writes = sql.filter((q) => /^\s*(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i.test(q) || /\bFOR UPDATE\b/i.test(q));
        expect(writes).toEqual([]);
    });
});

// ─── §3 Focus endpoints ────────────────────────────────────────────────

describe('focus lines', () => {
    it('POST creates a line for today (201, trimmed); PATCH text / done; DELETE', async () => {
        const user = await createLearner();
        const res = await api(user).post('/api/focus', { text: '  Ship the plan API  ' });
        expect(res.status).toBe(201);
        expect(res.body.data).toEqual({ _id: expect.any(String), day: TODAY, text: 'Ship the plan API', done: false, sortOrder: 0, createdAt: expect.any(String) });
        const id = res.body.data._id;
        expect((await api(user).patch(`/api/focus/${id}`, { done: true })).body.data).toMatchObject({ _id: id, done: true, text: 'Ship the plan API' });
        expect((await api(user).patch(`/api/focus/${id}`, { text: 'Ship it' })).body.data).toMatchObject({ text: 'Ship it', done: true });
        expect((await api(user).delete(`/api/focus/${id}`)).body.data).toEqual({ deleted: true });
        expect(await prisma.focusItem.count({ where: { userId: user.id } })).toBe(0);
    });

    it('a 4th line the same day → 409 FOCUS_LIMIT; sortOrder counts up', async () => {
        const user = await createLearner();
        for (const text of ['one', 'two', 'three']) expect((await api(user).post('/api/focus', { text })).status).toBe(201);
        const fourth = await api(user).post('/api/focus', { text: 'four' });
        expect([fourth.status, fourth.body.code]).toEqual([409, 'FOCUS_LIMIT']);
        const rows = await prisma.focusItem.findMany({ where: { userId: user.id }, orderBy: { sortOrder: 'asc' } });
        expect(rows.map((r) => [r.text, r.sortOrder])).toEqual([['one', 0], ['two', 1], ['three', 2]]);
    });

    it('five quick adds at once still make exactly 3 (the user row is locked)', async () => {
        const user = await createLearner();
        const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((text) => api(user).post('/api/focus', { text })));
        expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 409, 409]);
        expect(await prisma.focusItem.count({ where: { userId: user.id } })).toBe(3);
    });

    it("400 for empty / too long text or an empty PATCH; 404 for another user's line", async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        for (const body of [{ text: '   ' }, { text: 'x'.repeat(141) }, {}, { text: 5 }]) {
            const res = await api(user).post('/api/focus', body);
            expect([res.status, res.body.code], JSON.stringify(body)).toEqual([400, 'INVALID_INPUT']);
        }
        expect((await api(user).post('/api/focus', { text: 'x'.repeat(140) })).status).toBe(201);
        const id = (await api(user).post('/api/focus', { text: 'mine' })).body.data._id;
        expect((await api(user).patch(`/api/focus/${id}`, {})).status).toBe(400);
        expect((await api(stranger).patch(`/api/focus/${id}`, { done: true })).status).toBe(404);
        expect((await api(stranger).delete(`/api/focus/${id}`)).status).toBe(404);
        expect((await prisma.focusItem.findUniqueOrThrow({ where: { id } })).done).toBe(false);
    });

    it("carry-over copies earlier unfinished lines to today within the limit, skipping done and duplicate ones", async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        const mk = (day: string, text: string, done = false, sortOrder = 0) => prisma.focusItem.create({ data: { userId: user.id, day: d(day), text, done, sortOrder } });
        const a = await mk(ago(1), 'Read DDIA', false, 0);
        const b = await mk(ago(1), 'Gym', true, 1);
        const c = await mk(ago(1), 'Mock interview', false, 2);
        const e = await mk(ago(1), 'Fix the nudge', false, 3);
        await mk(TODAY, 'Today one');

        const res = await api(user).post('/api/focus/carry-over', { ids: [c.id, a.id, b.id, e.id] });
        expect(res.status).toBe(200);
        expect(res.body.data.carried).toBe(2); // room for 2: a and c (in their order); b is done; e does not fit
        expect(res.body.data.items.map((f: any) => [f.text, f.day, f.sortOrder])).toEqual([
            ['Today one', TODAY, 0],
            ['Read DDIA', TODAY, 1],
            ['Mock interview', TODAY, 2],
        ]);
        // Today is full and e could still be carried → 409; already-carried ones alone → nothing to do.
        expect((await api(user).post('/api/focus/carry-over', { ids: [e.id] })).body.code).toBe('FOCUS_LIMIT');
        expect((await api(user).post('/api/focus/carry-over', { ids: [a.id, c.id] })).body.data.carried).toBe(0);
        // Yesterday's rows stay as they were.
        expect(await prisma.focusItem.count({ where: { userId: user.id, day: d(ago(1)) } })).toBe(4);

        const foreign = await prisma.focusItem.create({ data: { userId: stranger.id, day: d(ago(1)), text: 'theirs' } });
        expect((await api(user).post('/api/focus/carry-over', { ids: [foreign.id] })).status).toBe(404);
        expect((await api(user).post('/api/focus/carry-over', { ids: [] })).status).toBe(400);
    });
});

// ─── §4 Goals + milestones ─────────────────────────────────────────────

describe('goals', () => {
    it('POST creates a goal with subjects and milestones (201, full shape); GET lists active first', async () => {
        const user = await createLearner();
        const dsa = await createSubjectRow(user.id, 'DSA');
        const res = await api(user).post('/api/goals', {
            title: '  Product-company SDE role ',
            why: 'Bigger problems, better pay',
            deadline: '2027-06-30',
            subjectIds: [dsa.id],
            milestones: [{ title: 'NeetCode 150', dueDay: '2026-12-31' }, { title: 'System design basics' }],
        });
        expect(res.status).toBe(201);
        const goal = res.body.data;
        expect(goal).toMatchObject({
            _id: expect.any(String),
            title: 'Product-company SDE role',
            why: 'Bigger problems, better pay',
            deadline: '2027-06-30',
            status: 'active',
            subjects: [{ _id: dsa.id, name: 'DSA', color: '#007acc' }],
            daysLeft: 228,
            progress: { done: 0, total: 2 },
            nextMilestone: { title: 'NeetCode 150', dueDay: '2026-12-31', done: false, sortOrder: 0 },
        });
        expect(goal.milestones.map((m: any) => [m.title, m.dueDay, m.sortOrder, m.goalId])).toEqual([
            ['NeetCode 150', '2026-12-31', 0, goal._id],
            ['System design basics', null, 1, goal._id],
        ]);
        expect(goal.forecast).toMatchObject({ status: 'no_data', pacePerWeek: 0, projectedDay: null, behindDays: 0 });
        expect(goal.forecast.suggestion).toMatch(/gets you there\.$/);

        const done = (await api(user).post('/api/goals', { title: 'Done one', deadline: '2026-12-01' })).body.data;
        await api(user).patch(`/api/goals/${done._id}`, { status: 'done' });
        const list = (await api(user).get('/api/goals')).body.data;
        expect(list.map((g: any) => [g.title, g.status, g.forecast.status])).toEqual([
            ['Product-company SDE role', 'active', 'no_data'],
            ['Done one', 'done', 'done'],
        ]);
    });

    it('a 4th active goal → 409 GOAL_LIMIT (done / archived ones do not count); re-activating one too', async () => {
        const user = await createLearner();
        const ids: string[] = [];
        for (const title of ['A', 'B', 'C']) ids.push((await api(user).post('/api/goals', { title, deadline: inDays(30) })).body.data._id);
        const fourth = await api(user).post('/api/goals', { title: 'D', deadline: inDays(30) });
        expect([fourth.status, fourth.body.code]).toEqual([409, 'GOAL_LIMIT']);
        await api(user).patch(`/api/goals/${ids[0]}`, { status: 'archived' });
        const d4 = await api(user).post('/api/goals', { title: 'D', deadline: inDays(30) });
        expect(d4.status).toBe(201);
        const back = await api(user).patch(`/api/goals/${ids[0]}`, { status: 'active' });
        expect([back.status, back.body.code]).toEqual([409, 'GOAL_LIMIT']);
        // Editing an active goal without changing its status is fine.
        expect((await api(user).patch(`/api/goals/${ids[1]}`, { title: 'B2', status: 'active' })).status).toBe(200);
    });

    it('PATCH updates fields and replaces the subjects; DELETE removes milestones too', async () => {
        const user = await createLearner();
        const s1 = await createSubjectRow(user.id, 'S1');
        const s2 = await createSubjectRow(user.id, 'S2');
        const goal = (await api(user).post('/api/goals', { title: 'G', deadline: inDays(60), subjectIds: [s1.id], milestones: [{ title: 'M' }] })).body.data;
        const res = await api(user).patch(`/api/goals/${goal._id}`, { title: 'G2', why: '  ', deadline: inDays(90), subjectIds: [s2.id] });
        expect(res.body.data).toMatchObject({ title: 'G2', why: null, deadline: inDays(90), subjects: [{ _id: s2.id }] });
        expect((await api(user).patch(`/api/goals/${goal._id}`, { subjectIds: [] })).body.data.subjects).toEqual([]);
        expect((await api(user).delete(`/api/goals/${goal._id}`)).body.data).toEqual({ deleted: true });
        expect(await prisma.goalMilestone.count({ where: { goalId: goal._id } })).toBe(0);
        expect((await api(user).delete(`/api/goals/${goal._id}`)).status).toBe(404);
    });

    it("400 for bad input; 404 for another user's goal or subject", async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        const theirSubject = await createSubjectRow(stranger.id, 'Theirs');
        for (const body of [
            { title: '', deadline: inDays(10) },
            { title: 'x'.repeat(121), deadline: inDays(10) },
            { title: 'ok', why: 'x'.repeat(501), deadline: inDays(10) },
            { title: 'ok', deadline: '2027-02-30' },
            { title: 'ok' },
            { title: 'ok', deadline: inDays(10), milestones: [{ title: 'x'.repeat(141) }] },
        ]) {
            const res = await api(user).post('/api/goals', body);
            expect([res.status, res.body.code], JSON.stringify(body).slice(0, 80)).toEqual([400, 'INVALID_INPUT']);
        }
        const past = await api(user).post('/api/goals', { title: 'ok', deadline: ago(1) });
        expect([past.status, past.body.code]).toEqual([400, 'INVALID_DAY']);
        expect((await api(user).post('/api/goals', { title: 'ok', deadline: TODAY })).status).toBe(201);
        expect((await api(user).post('/api/goals', { title: 'ok', deadline: inDays(5), subjectIds: [theirSubject.id] })).status).toBe(404);

        const goal = (await api(user).post('/api/goals', { title: 'Mine', deadline: inDays(10) })).body.data;
        expect((await api(user).patch(`/api/goals/${goal._id}`, { status: 'paused' })).status).toBe(400);
        expect((await api(user).patch(`/api/goals/${goal._id}`, { deadline: ago(2) })).body.code).toBe('INVALID_DAY');
        expect((await api(stranger).get('/api/goals')).body.data).toEqual([]);
        expect((await api(stranger).patch(`/api/goals/${goal._id}`, { title: 'hijack' })).status).toBe(404);
        expect((await api(stranger).delete(`/api/goals/${goal._id}`)).status).toBe(404);
        expect((await api(stranger).post(`/api/goals/${goal._id}/milestones`, { title: 'm' })).status).toBe(404);
        expect((await api(user).patch(`/api/goals/${goal._id}`, { subjectIds: [theirSubject.id] })).status).toBe(404);
        expect((await prisma.goal.findUniqueOrThrow({ where: { id: goal._id } })).title).toBe('Mine');
    });

    it('milestones: POST appends (201 { milestone, goal }), PATCH done sets doneAt and moves the forecast, DELETE', async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        const goal = (await api(user).post('/api/goals', { title: 'G', deadline: inDays(70), milestones: [{ title: 'one' }] })).body.data;
        const created = await api(user).post(`/api/goals/${goal._id}/milestones`, { title: ' two ', dueDay: inDays(30) });
        expect(created.status).toBe(201);
        expect(created.body.data.milestone).toEqual({ _id: expect.any(String), goalId: goal._id, title: 'two', dueDay: inDays(30), done: false, doneAt: null, sortOrder: 1 });
        expect(created.body.data.goal.progress).toEqual({ done: 0, total: 2 });
        const two = created.body.data.milestone._id;

        const done = await api(user).patch(`/api/goal-milestones/${two}`, { done: true });
        expect(done.body.data.milestone).toMatchObject({ done: true, doneAt: NOW.toISOString() });
        expect(done.body.data.goal).toMatchObject({ progress: { done: 1, total: 2 }, nextMilestone: { title: 'one' } });
        expect(done.body.data.goal.forecast).toMatchObject({ pacePerWeek: 1, status: 'ahead' });
        const undone = await api(user).patch(`/api/goal-milestones/${two}`, { done: false, title: 'two!', dueDay: null, sortOrder: 5 });
        expect(undone.body.data.milestone).toMatchObject({ done: false, doneAt: null, title: 'two!', dueDay: null, sortOrder: 5 });

        expect((await api(user).patch(`/api/goal-milestones/${two}`, { title: '' })).status).toBe(400);
        expect((await api(user).post(`/api/goals/${goal._id}/milestones`, { title: 'x'.repeat(141) })).status).toBe(400);
        expect((await api(stranger).patch(`/api/goal-milestones/${two}`, { done: true })).status).toBe(404);
        expect((await api(stranger).delete(`/api/goal-milestones/${two}`)).status).toBe(404);
        const del = await api(user).delete(`/api/goal-milestones/${two}`);
        expect(del.body.data).toMatchObject({ deleted: true, goal: { progress: { done: 0, total: 1 } } });
        expect((await api(user).delete(`/api/goal-milestones/${two}`)).status).toBe(404);
    });
});

// ─── §2 Fresh start ────────────────────────────────────────────────────

describe('POST /api/revisions/fresh-start', () => {
    it('spreads every overdue chain over the next days at the budget; later cycles keep their gaps; nothing due today moves', async () => {
        const user = await createLearner('Asia/Kolkata', { ...SEEN, dailyBudgetMin: 10 });
        const stranger = await createLearner();
        const late = await item(user.id, ago(35));
        const others = [];
        for (let i = 1; i <= 4; i++) others.push(await item(user.id, ago(i)));
        const dueToday = await item(user.id, TODAY);
        const theirs = await item(stranger.id, ago(10));
        const before = await chainDays({ captureId: dueToday.capture.id });

        const bad = await api(user).post('/api/revisions/fresh-start', { dryRun: 'yes' });
        expect([bad.status, bad.body.code]).toEqual([400, 'INVALID_INPUT']);
        const dry = await api(user).post('/api/revisions/fresh-start', { dryRun: true });
        expect(dry.body.data).toEqual({ moved: 5, spreadDays: 3 });
        expect(await chainDays({ captureId: late.capture.id })).toContain(`2:${ago(35)}:pending`);

        const res = await api(user).post('/api/revisions/fresh-start');
        expect(res.status).toBe(200);
        // Budget 10: today already has 5 min due → 1 moved item (the most late); then 2 a day.
        expect(res.body.data).toEqual({ moved: 5, spreadDays: 3 });
        expect(await chainDays({ captureId: late.capture.id })).toEqual([`1:${ago(37)}:done`, `2:${TODAY}:pending`, `3:${inDays(4)}:pending`, `4:${inDays(18)}:pending`]);
        expect(await chainDays({ captureId: dueToday.capture.id })).toEqual(before);
        expect(await chainDays({ captureId: theirs.capture.id })).toContain(`2:${addDays(TODAY, -10)}:pending`);

        const data = (await api(user).get('/api/today')).body.data;
        expect(data.revisions.overdue).toEqual([]);
        expect(data.plan.planned.length + data.plan.waitingCount).toBe(2);
        expect((await api(user).post('/api/revisions/fresh-start')).body.data).toEqual({ moved: 0, spreadDays: 0 });
    });
});

// ─── Time zones ────────────────────────────────────────────────────────

describe('America/New_York day edge', () => {
    it('at 22:30 EST on 11-13 a New York user is still on 11-13: plan, focus, rhythm and goals use that day', async () => {
        vi.setSystemTime(new Date('2026-11-14T03:30:00Z')); // 22:30 EST 11-13, 09:00 IST 11-14
        const ny = await createLearner(NY, { learningRolledOverDay: d('2026-11-13'), lastSeenDay: d('2026-11-13'), prevSeenDay: d('2026-11-12') });
        const ist = await createLearner('Asia/Kolkata', SEEN);
        for (const u of [ny, ist]) await item(u.id, '2026-11-14'); // due on 11-14

        const nyToday = (await api(ny).get('/api/today')).body.data;
        expect([nyToday.today, nyToday.needsEnsure, nyToday.plan.planned.length, nyToday.plan.waitingCount]).toEqual(['2026-11-13', false, 0, 0]);
        expect(nyToday.stats.rhythm.last7.at(-1)).toEqual({ day: '2026-11-13', active: false });
        const istToday = (await api(ist).get('/api/today')).body.data;
        expect([istToday.today, istToday.plan.planned.length]).toEqual(['2026-11-14', 1]);

        const focus = await api(ny).post('/api/focus', { text: 'Late-night line' });
        expect(focus.body.data.day).toBe('2026-11-13');
        const goal = await api(ny).post('/api/goals', { title: 'NY goal', deadline: '2026-11-13' });
        expect([goal.status, goal.body.data.daysLeft]).toEqual([201, 0]);
        // The item due 11-14 is not overdue in New York yet: fresh start moves nothing.
        expect((await api(ny).post('/api/revisions/fresh-start')).body.data).toEqual({ moved: 0, spreadDays: 0 });

        // 00:30 EST on 11-14: the item is due for New York now, and yesterday's line can be carried over.
        vi.setSystemTime(new Date('2026-11-14T05:30:00Z'));
        const next = (await api(ny).get('/api/today')).body.data;
        expect([next.today, next.needsEnsure, next.plan.planned.length]).toEqual(['2026-11-14', true, 1]);
        expect(next.focus.carryOver.map((f: any) => f.text)).toEqual(['Late-night line']);
    });
});
