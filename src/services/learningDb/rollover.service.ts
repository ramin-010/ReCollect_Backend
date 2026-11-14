// The per-user learning rollover (LEARNING_SPEC §2 "Rollover"): once per user per local day it
//   1. claims the day (User.learningRolledOverDay = today; a second run the same day stops here),
//   2. settles or bridges the global and subject streaks for every day that ended since the last
//      run (rest days are neutral: engine rollOverStreakDay), at most 30 days back,
//   3. ONLY WHEN THE ROUTINE IS ON (User.routineEnabled, LOOP_V2_SPEC §6): backfills the routine's
//      slots for days missed since the last rollover (≤ 30), creates today's slots, and heals past
//      slots whose BlockSessionLog already says how they went. With the routine off nothing
//      "missed" builds up in the background, and switching it back on never backfills those days.
// All in one transaction, so it is idempotent and safe to run concurrently (the user row is
// locked). Triggered by the cron (every 15 min + at boot) and by POST /api/learning/ensure-today,
// which also records that the app was opened today (markLearningSeen, LOOP_V2_SPEC §1).
import cron from 'node-cron';
import type { RoutineMode } from '@prisma/client';
import { prisma, type TxClient } from '../../db/prisma';
import {
    addDays,
    backfillMissedDays,
    findTriageSlots,
    openDueAt,
    planDaySlots,
    resolveTimeZone,
    rollOverStreak,
    startOfDay,
    streakRolloverDays,
    today as todayIn,
    TRIAGE_LOOKBACK_DAYS,
    type DayString,
} from '../learning';
import {
    fromDbDay,
    globalStreakData,
    globalStreakOf,
    loadBlockLogs,
    lockLearningContext,
    sameStreak,
    subjectStreakData,
    subjectStreakOf,
    toDbDay,
    toEngineBlock,
    toEngineSlot,
    type LearningContext,
} from './common';

export interface RolloverResult {
    /** False when the day had already been rolled over (nothing written). */
    rolledOver: boolean;
    /** Ended days whose streaks were settled. */
    days: number;
    /** Days that got backfilled slots (yesterday and before). */
    backfilledDays?: number;
    /** Today's slots created from the routine. */
    slotsCreated?: number;
    healed?: number;
}

/** Runs the rollover for one user if their local day changed since the last run. */
export async function runLearningRollover(userId: string, now: Date = new Date()): Promise<RolloverResult> {
    return prisma.$transaction(
        async (tx) => {
            const ctx = await lockLearningContext(tx, userId, now);
            const today = ctx.today;
            const todayDate = toDbDay(today);

            // 1. Claim the day.
            const claimed = await tx.user.updateMany({
                where: { id: userId, OR: [{ learningRolledOverDay: null }, { learningRolledOverDay: { lt: todayDate } }] },
                data: { learningRolledOverDay: todayDate },
            });
            if (claimed.count === 0) return { rolledOver: false, days: 0 };

            const previous = ctx.user.learningRolledOverDay ? fromDbDay(ctx.user.learningRolledOverDay) : null;
            const days = await settleStreaks(tx, ctx, previous);
            if (!ctx.user.routineEnabled) return { rolledOver: true, days };
            const slots = await rollSlots(tx, ctx, previous);
            return { rolledOver: true, days, ...slots };
        },
        { timeout: 60_000 }
    );
}

/**
 * The first ended day a streak still has to settle. The previous rollover ran ON `previous`
 * (it settled the days before it), so `previous` itself has ended since and is included. Without
 * a previous run: the day after the streak's last credit / bridge.
 * (LEARNING_SPEC writes `(old ?? lastDay ?? today−1) + 1`; `old + 1` would skip the day the last
 * rollover ran on, so that day is settled here as well. Days already credited are unchanged.)
 */
function firstUnsettledDay(previous: DayString | null, lastCreditDay: DayString | null, today: DayString): DayString {
    if (previous) return previous;
    if (lastCreditDay) return addDays(lastCreditDay, 1);
    return today;
}

async function settleStreaks(tx: TxClient, ctx: LearningContext, previous: DayString | null): Promise<number> {
    const { tz, today } = ctx;
    const global = globalStreakOf(ctx.user);
    const subjectRows = await tx.subjectStreak.findMany({ where: { userId: ctx.user.id, currentStreak: { gt: 0 } } });
    const globalDays = global.current > 0 ? streakRolloverDays(firstUnsettledDay(previous, global.lastCreditDay, today), today) : [];
    const subjectPlans = subjectRows.map((row) => {
        const state = subjectStreakOf(row);
        return { row, state, days: streakRolloverDays(firstUnsettledDay(previous, state.lastCreditDay, today), today) };
    });

    const allDays = [...globalDays, ...subjectPlans.flatMap((p) => p.days)];
    let revisions: Array<{ scheduledFor: DayString; status: 'pending' | 'done' | 'missed'; completedAt: Date | null; subjectId: string | null }> = [];
    if (allDays.length > 0) {
        const earliest = allDays.reduce((a, b) => (a < b ? a : b));
        const rows = await tx.revision.findMany({
            where: {
                userId: ctx.user.id,
                scheduledFor: { lt: toDbDay(today) },
                OR: [{ status: 'pending' }, { status: 'done', completedAt: { gte: startOfDay(addDays(earliest, 1), tz) } }],
            },
            select: { scheduledFor: true, status: true, completedAt: true, topicId: true, captureId: true },
        });
        const subjectOf = await itemSubjects(tx, ctx.user.id, rows);
        revisions = rows.map((r) => ({
            scheduledFor: fromDbDay(r.scheduledFor),
            status: r.status,
            completedAt: r.completedAt,
            subjectId: subjectOf(r),
        }));
    }

    const nextGlobal = rollOverStreak(global, globalDays, (d) => openDueAt(revisions, d, tz), today);
    if (!sameStreak(global, nextGlobal)) {
        await tx.user.update({ where: { id: ctx.user.id }, data: globalStreakData(nextGlobal), select: { id: true } });
    }

    for (const plan of subjectPlans) {
        const mine = revisions.filter((r) => r.subjectId === plan.row.subjectId);
        const next = rollOverStreak(plan.state, plan.days, (d) => openDueAt(mine, d, tz), today);
        if (!sameStreak(plan.state, next)) {
            await tx.subjectStreak.update({
                where: { userId_subjectId: { userId: ctx.user.id, subjectId: plan.row.subjectId } },
                data: subjectStreakData(next),
                select: { userId: true },
            });
        }
    }
    return new Set(allDays).size;
}

/** subjectId of each revision via its topic or capture (two plain queries; no relation includes on tx). */
export async function itemSubjects(
    tx: TxClient,
    userId: string,
    rows: ReadonlyArray<{ topicId: string | null; captureId: string | null }>
): Promise<(r: { topicId: string | null; captureId: string | null }) => string | null> {
    const topicIds = [...new Set(rows.map((r) => r.topicId).filter((x): x is string => !!x))];
    const captureIds = [...new Set(rows.map((r) => r.captureId).filter((x): x is string => !!x))];
    const topics = topicIds.length
        ? await tx.topic.findMany({ where: { userId, id: { in: topicIds } }, select: { id: true, subjectId: true } })
        : [];
    const captures = captureIds.length
        ? await tx.capture.findMany({ where: { userId, id: { in: captureIds } }, select: { id: true, subjectId: true } })
        : [];
    const byTopic = new Map(topics.map((t) => [t.id, t.subjectId]));
    const byCapture = new Map(captures.map((c) => [c.id, c.subjectId]));
    return (r) => (r.topicId ? byTopic.get(r.topicId) ?? null : r.captureId ? byCapture.get(r.captureId) ?? null : null);
}

/**
 * `previous` = the day the last rollover ran (null = never). Backfill never fills a day before it:
 * the rollover runs every day (cron) even while the routine is off, so only days nobody rolled over
 * (e.g. the server was down) are "missed".
 */
async function rollSlots(
    tx: TxClient,
    ctx: LearningContext,
    previous: DayString | null
): Promise<{ backfilledDays: number; slotsCreated: number; healed: number }> {
    const userId = ctx.user.id;
    const { today, tz } = ctx;
    const blockRows = await tx.timeBlock.findMany({ where: { userId } });
    const blocks = blockRows.map(toEngineBlock);
    const windowStart = addDays(today, -TRIAGE_LOOKBACK_DAYS);
    const logs = blocks.length > 0 ? await loadBlockLogs(userId, windowStart, today, tx) : [];
    const mode = ctx.user.routineMode;

    // 1. backfillMissedDays (days before today only, never before the last rollover day).
    let backfilledDays = 0;
    if (blocks.length > 0) {
        const last = await tx.dailyScheduleSlot.findFirst({
            where: { userId, date: { lt: toDbDay(today) } },
            orderBy: { date: 'desc' },
            select: { date: true },
        });
        const backfill = backfillMissedDays({ lastSlotDay: last ? fromDbDay(last.date) : null, blocks, logs, mode, today, tz, notBefore: previous });
        if (backfill.slots.length > 0) {
            await tx.dailyScheduleSlot.createMany({
                data: backfill.slots.map((s) => ({ ...s, userId, date: toDbDay(s.date) })),
                skipDuplicates: true,
            });
        }
        backfilledDays = backfill.backfilledDays;
    }

    // 2. ensureTodaySlots.
    const slotsCreated = await ensureTodaySlots(tx, userId, today, mode, { blocks, logs });

    // 3. Heal past slots whose log already says how they went.
    const pastRows = await tx.dailyScheduleSlot.findMany({
        where: { userId, status: 'UPCOMING', date: { gte: toDbDay(windowStart), lt: toDbDay(today) } },
    });
    const { heal } = findTriageSlots(pastRows.map(toEngineSlot), logs, today);
    for (const h of heal) {
        await tx.dailyScheduleSlot.update({ where: { id: h.slotId }, data: { status: h.status, remark: h.remark }, select: { id: true } });
    }
    return { backfilledDays, slotsCreated, healed: heal.length };
}

/**
 * Creates today's slots from the routine (Revise ensureTodaySlots): nothing when today already
 * has slots. Used by the rollover and when the routine is switched on (settings), so today's
 * timeline shows at once. Returns the number of slots created.
 */
export async function ensureTodaySlots(
    tx: TxClient,
    userId: string,
    today: DayString,
    mode: RoutineMode,
    loaded?: { blocks: ReturnType<typeof toEngineBlock>[]; logs: Awaited<ReturnType<typeof loadBlockLogs>> }
): Promise<number> {
    const blocks = loaded?.blocks ?? (await tx.timeBlock.findMany({ where: { userId } })).map(toEngineBlock);
    if (blocks.length === 0) return 0;
    const logs = loaded?.logs ?? (await loadBlockLogs(userId, addDays(today, -TRIAGE_LOOKBACK_DAYS), today, tx));
    const existingToday = await tx.dailyScheduleSlot.findMany({ where: { userId, date: toDbDay(today) }, select: { date: true } });
    const planned = planDaySlots(existingToday.map((s) => ({ date: fromDbDay(s.date) })), blocks, today, mode, logs);
    if (planned.length === 0) return 0;
    const created = await tx.dailyScheduleSlot.createMany({
        data: planned.map((s) => ({ ...s, userId, date: toDbDay(s.date) })),
        skipDuplicates: true,
    });
    return created.count;
}

/**
 * POST /api/learning/ensure-today also records that the app was opened (LOOP_V2_SPEC §1): on the
 * first call of a new local day, prevSeenDay = the old lastSeenDay and lastSeenDay = today (one
 * atomic UPDATE; later calls the same day change nothing). Comeback mode reads prevSeenDay for the
 * rest of that day. The cron never calls this: only opening the app counts.
 */
export async function markLearningSeen(userId: string, now: Date = new Date()): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    if (!user) return;
    const today = todayIn(resolveTimeZone(user.timezone), now);
    await prisma.$executeRaw`
        UPDATE "User" SET "prevSeenDay" = "lastSeenDay", "lastSeenDay" = ${today}::date
        WHERE "id" = ${userId} AND ("lastSeenDay" IS NULL OR "lastSeenDay" < ${today}::date)`;
}

/** What POST /api/learning/ensure-today does: the rollover if the day changed, then markLearningSeen. */
export async function ensureTodayForUser(userId: string, now: Date = new Date()): Promise<RolloverResult> {
    const result = await runLearningRollover(userId, now);
    await markLearningSeen(userId, now);
    return result;
}

/** True when the user's day changed since the last rollover. */
export function needsRollover(user: { timezone: string; learningRolledOverDay: Date | null }, now: Date = new Date()): boolean {
    if (!user.learningRolledOverDay) return true;
    return fromDbDay(user.learningRolledOverDay) < todayIn(resolveTimeZone(user.timezone), now);
}

/**
 * GET /api/today's `needsEnsure`: the rollover is due, or the app was not marked seen today yet
 * (lastSeenDay before today). The client then calls ensure-today once and refetches.
 */
export function needsEnsure(
    user: { timezone: string; learningRolledOverDay: Date | null; lastSeenDay: Date | null },
    now: Date = new Date()
): boolean {
    if (needsRollover(user, now)) return true;
    if (!user.lastSeenDay) return true;
    return fromDbDay(user.lastSeenDay) < todayIn(resolveTimeZone(user.timezone), now);
}

/** Runs the rollover only when needed (cheap check first). Used before completions. */
export async function ensureLearningRollover(userId: string, now: Date = new Date()): Promise<RolloverResult> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true, learningRolledOverDay: true } });
    if (!user || !needsRollover(user, now)) return { rolledOver: false, days: 0 };
    return runLearningRollover(userId, now);
}

// ─── Cron ──────────────────────────────────────────────────────────────

/**
 * One cron pass: every user with a time block or a revision whose local day is after their
 * learningRolledOverDay gets a rollover (sequentially; one user's failure is logged and skipped).
 */
export async function runLearningRolloverPass(now: Date = new Date()): Promise<{ checked: number; rolledOver: number; failed: number }> {
    const users = await prisma.user.findMany({
        where: { OR: [{ timeBlocks: { some: {} } }, { revisions: { some: {} } }] },
        select: { id: true, timezone: true, learningRolledOverDay: true },
    });
    let rolledOver = 0;
    let failed = 0;
    for (const user of users) {
        if (!needsRollover(user, now)) continue;
        try {
            const result = await runLearningRollover(user.id, now);
            if (result.rolledOver) rolledOver++;
        } catch (err) {
            failed++;
            console.error(`[learning] rollover failed for user ${user.id}:`, err);
        }
    }
    return { checked: users.length, rolledOver, failed };
}

let passRunning = false;

/** Every 15 minutes (and once at boot): the learning rollover for users whose day changed. */
export function startLearningCron(): void {
    const tick = async () => {
        if (passRunning) return; // a slow pass never overlaps the next one
        passRunning = true;
        try {
            const r = await runLearningRolloverPass();
            if (r.rolledOver > 0 || r.failed > 0) console.log(`[learning] rollover: ${r.rolledOver} rolled over, ${r.failed} failed`);
        } catch (err) {
            console.error('[learning] rollover pass failed:', err);
        } finally {
            passRunning = false;
        }
    };
    cron.schedule('*/15 * * * *', () => void tick());
    void tick();
}
