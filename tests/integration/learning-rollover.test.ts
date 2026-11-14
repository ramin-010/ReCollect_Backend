// LEARNING_SPEC §2 "Rollover": POST /api/learning/ensure-today and the cron pass. Idempotent,
// catches up after missed days (backfill + streak settling), rest days neutral, missed days break.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { runLearningRolloverPass } from '../../src/services/learningDb/rollover.service';
import { api, createChainRows, createLearner, createSubjectRow, createTopicRow, d } from '../helpers/learning';

const NOW = new Date('2026-10-21T04:30:00Z'); // Wed 2026-10-21 10:00 IST
/** Slots are only made with the routine on (LOOP_V2_SPEC §6; it is off by default). */
const ROUTINE = { routineEnabled: true };
const TODAY = '2026-10-21';
const OLD = new Date('2026-09-01T00:00:00Z');

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => {
    vi.useRealTimers();
});

const dayStr = (x: Date | null) => (x ? x.toISOString().slice(0, 10) : null);
const block = (userId: string, over: Record<string, unknown> = {}) =>
    prisma.timeBlock.create({ data: { userId, title: 'Deep work', startTime: '09:00', endTime: '11:00', color: '#111', createdAt: OLD, ...over } });

describe('POST /api/learning/ensure-today', () => {
    it("creates today's slots from the routine (blocks made today: nothing to backfill), then is a no-op the same day", async () => {
        const user = await createLearner('Asia/Kolkata', ROUTINE);
        const fresh = { createdAt: NOW };
        await block(user.id, { title: 'Read', startTime: '20:00', endTime: '21:00', ...fresh });
        await block(user.id, fresh);
        await block(user.id, { title: 'Mon only', dayOfWeek: 0, ...fresh }); // DAILY template: ignored in MASTER mode
        await block(user.id, { title: 'One-off tomorrow', date: d('2026-10-22'), ...fresh });

        const first = await api(user).post('/api/learning/ensure-today');
        expect(first.body.data).toEqual({ rolledOver: true, days: 0 });
        const today = (await api(user).get('/api/today')).body.data;
        expect(today.needsEnsure).toBe(false);
        expect(today.schedule.slots.map((s: any) => [s.title, s.sortOrder, s.status])).toEqual([
            ['Deep work', 0, 'UPCOMING'],
            ['Read', 1, 'UPCOMING'],
        ]);

        const second = await api(user).post('/api/learning/ensure-today');
        expect(second.body.data).toEqual({ rolledOver: false, days: 0 });
        expect(await prisma.dailyScheduleSlot.count({ where: { userId: user.id } })).toBe(2);
        expect(dayStr((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).learningRolledOverDay)).toBe(TODAY);
    });

    it('concurrent ensures roll over once', async () => {
        const user = await createLearner('Asia/Kolkata', ROUTINE);
        await block(user.id, { createdAt: NOW });
        const results = await Promise.all([1, 2, 3].map(() => api(user).post('/api/learning/ensure-today')));
        expect(results.map((r) => r.body.data.rolledOver).filter(Boolean)).toHaveLength(1);
        expect(await prisma.dailyScheduleSlot.count({ where: { userId: user.id } })).toBe(1);
    });

    it('catches up after 3 missed days: backfills their slots, triage asks about them, rest days keep the streak', async () => {
        const user = await createLearner('Asia/Kolkata', {
            ...ROUTINE,
            learningRolledOverDay: d('2026-10-18'), // last ran on 10-18: 10-18, 10-19, 10-20 ended since
            globalStreak: 4,
            longestGlobalStreak: 4,
            lastGlobalStreakDay: d('2026-10-17'),
        });
        const b = await block(user.id);
        await prisma.dailyScheduleSlot.create({ data: { userId: user.id, sourceBlockId: b.id, date: d('2026-10-17'), title: 'Deep work', color: '#111', startTime: '09:00', endTime: '11:00', status: 'COMPLETED' } });
        // 10-19's block was logged in advance (vacation pre-skip): the backfilled slot starts SKIPPED.
        await prisma.blockSessionLog.create({ data: { timeBlockId: b.id, date: d('2026-10-19'), status: 'SKIPPED', remark: 'trip' } });
        // A revision done early, nothing due on 10-18..10-20: all three are rest days.
        const capture = await prisma.capture.create({ data: { userId: user.id, content: 'x' } });
        await createChainRows(user.id, { captureId: capture.id }, '2026-10-20');

        const res = await api(user).post('/api/learning/ensure-today');
        expect(res.body.data).toEqual({ rolledOver: true, days: 3 });

        const slots = await prisma.dailyScheduleSlot.findMany({ where: { userId: user.id }, orderBy: { date: 'asc' } });
        expect(slots.map((s) => [dayStr(s.date), s.status, s.remark])).toEqual([
            ['2026-10-17', 'COMPLETED', null],
            ['2026-10-18', 'UPCOMING', null],
            ['2026-10-19', 'SKIPPED', 'trip'],
            ['2026-10-20', 'UPCOMING', null],
            ['2026-10-21', 'UPCOMING', null],
        ]);
        const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect([u.globalStreak, u.longestGlobalStreak, dayStr(u.lastGlobalStreakDay)]).toEqual([4, 4, '2026-10-20']);

        const today = (await api(user).get('/api/today')).body.data;
        expect(today.stats.streak).toBe(4);
        expect(today.triage.kind).toBe('catch-up');
        expect(today.triage.days.map((x: any) => x.date)).toEqual(['2026-10-18', '2026-10-20']);
    });

    it('a day that ended with a revision still due breaks the global and that subject streak at its midnight', async () => {
        const user = await createLearner('Asia/Kolkata', {
            learningRolledOverDay: d('2026-10-19'),
            globalStreak: 6,
            longestGlobalStreak: 8,
            lastGlobalStreakDay: d('2026-10-18'),
        });
        const missed = await createSubjectRow(user.id, 'Missed');
        const rested = await createSubjectRow(user.id, 'Rested');
        for (const s of [missed, rested]) {
            await prisma.subjectStreak.create({ data: { userId: user.id, subjectId: s.id, currentStreak: 3, longestStreak: 3, lastCreditDay: d('2026-10-18') } });
        }
        const { topic } = await createTopicRow(user.id, missed.id);
        await createChainRows(user.id, { topicId: topic.id }, '2026-10-19'); // cycle 1 due 10-20, never done

        const res = await api(user).post('/api/learning/ensure-today');
        expect(res.body.data).toMatchObject({ rolledOver: true });
        const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        expect([u.globalStreak, u.longestGlobalStreak]).toEqual([0, 8]);
        const streaks = await prisma.subjectStreak.findMany({ where: { userId: user.id } });
        const by = new Map(streaks.map((s) => [s.subjectId, s]));
        expect(by.get(missed.id)!.currentStreak).toBe(0);
        expect([by.get(rested.id)!.currentStreak, dayStr(by.get(rested.id)!.lastCreditDay)]).toEqual([3, '2026-10-20']);
        expect((await api(user).get('/api/today')).body.data.stats.streak).toBe(0);
    });

    it('a revision completed only after midnight still counts as open for the day before', async () => {
        const user = await createLearner('Asia/Kolkata', {
            learningRolledOverDay: d('2026-10-20'),
            globalStreak: 2,
            longestGlobalStreak: 2,
            lastGlobalStreakDay: d('2026-10-19'),
        });
        const capture = await prisma.capture.create({ data: { userId: user.id, content: 'late' } });
        await createChainRows(user.id, { captureId: capture.id }, '2026-10-19', {
            1: { status: 'done', completedAt: new Date('2026-10-20T18:45:00Z') }, // 00:15 IST on 10-21
        });
        await api(user).post('/api/learning/ensure-today');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).globalStreak).toBe(0);
    });
});

describe('cron pass', () => {
    it('rolls over every user whose day changed, once; a second pass changes nothing', async () => {
        const a = await createLearner('Asia/Kolkata', ROUTINE);
        const b = await createLearner('America/New_York', ROUTINE);
        const idle = await createLearner(); // no blocks, no revisions: not picked up
        const done = await createLearner('Asia/Kolkata', { ...ROUTINE, learningRolledOverDay: d(TODAY) });
        await block(a.id);
        await block(b.id);
        await block(done.id);
        const capture = await prisma.capture.create({ data: { userId: b.id, content: 'x' } });
        await createChainRows(b.id, { captureId: capture.id }, '2026-10-30');

        const first = await runLearningRolloverPass();
        expect(first).toMatchObject({ rolledOver: 2, failed: 0 });
        const countAfterFirst = await prisma.dailyScheduleSlot.count();
        const second = await runLearningRolloverPass();
        expect(second).toMatchObject({ rolledOver: 0, failed: 0 });
        expect(await prisma.dailyScheduleSlot.count()).toBe(countAfterFirst);

        // NOW is 04:30Z = 00:30 EDT on 10-21, so the New York user rolls into 10-21 too.
        expect(dayStr((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).learningRolledOverDay)).toBe('2026-10-21');
        expect((await prisma.user.findUniqueOrThrow({ where: { id: idle.id } })).learningRolledOverDay).toBeNull();
        expect(await prisma.dailyScheduleSlot.count({ where: { userId: done.id } })).toBe(0);
    });

    it('a New York user rolls over at THEIR midnight, not IST midnight', async () => {
        vi.setSystemTime(new Date('2026-10-21T03:30:00Z')); // 23:30 EDT on 10-20
        const ny = await createLearner('America/New_York', { learningRolledOverDay: d('2026-10-20') });
        await block(ny.id);
        expect((await runLearningRolloverPass()).rolledOver).toBe(0);
        vi.setSystemTime(new Date('2026-10-21T04:05:00Z')); // 00:05 EDT on 10-21
        expect((await runLearningRolloverPass()).rolledOver).toBe(1);
        expect(dayStr((await prisma.user.findUniqueOrThrow({ where: { id: ny.id } })).learningRolledOverDay)).toBe('2026-10-21');
    });
});

describe('backfill cap', () => {
    it('a routine with no slots yet backfills from the block creation day, at most 30 days (as Revise)', async () => {
        const user = await createLearner('Asia/Kolkata', ROUTINE);
        await block(user.id); // created 2026-09-01
        await api(user).post('/api/learning/ensure-today');
        const slots = await prisma.dailyScheduleSlot.findMany({ where: { userId: user.id }, orderBy: { date: 'asc' } });
        expect(slots).toHaveLength(31);
        expect(dayStr(slots[0]!.date)).toBe('2026-09-21');
        expect(dayStr(slots[30]!.date)).toBe(TODAY);
    });
});
