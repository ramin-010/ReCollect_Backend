// Today's plan (LOOP_V2_SPEC §2) on top of the pure engine (services/learning/plan.ts): the inputs
// GET /api/today and the morning nudge share, and POST /api/revisions/fresh-start.
//
// The plan is computed on every read and never stored: GET /api/today stays write-free.
import { prisma, type DbClient } from '../../db/prisma';
import {
    addDays,
    BUSY_MAX_ITEMS,
    daysLate,
    earliestPendingPerItem,
    lastSeenBefore,
    planFreshStart,
    planPriority,
    revisionItemKey,
    planMode,
    planToday,
    revisionMinutes,
    type DayString,
    type PlanMode,
    type PlanTodayResult,
    type RevisionWithSubject,
} from '../learning';
import { serializeRevisionItem } from '../../db/serializers/learning';
import { dayRange, fromDbDay, fromDbDayOrNull, lockLearningContext, toDbDay, toEngineRevision, type LearningContext, type LearningUserRow } from './common';
import { itemSource, type RevisionWithItem } from './revisions.service';
import { itemSubjects } from './rollover.service';

/** Revisions the plan needs: pending ones due by today, plus the ones completed today (user zone). */
export function planRevisionWhere(userId: string, today: DayString, tz: string) {
    return {
        userId,
        OR: [{ status: 'pending' as const, scheduledFor: { lte: toDbDay(today) } }, { status: 'done' as const, completedAt: dayRange(today, tz) }],
    };
}

/** Comeback mode needs to know whether the user ever revised before today, but only when the app was never seen before today. */
export function needsHistoryCheck(user: Pick<LearningUserRow, 'lastSeenDay' | 'prevSeenDay'>, today: DayString): boolean {
    return lastSeenBefore({ today, lastSeenDay: fromDbDayOrNull(user.lastSeenDay), prevSeenDay: fromDbDayOrNull(user.prevSeenDay) }) === null;
}

/** Any revision completed before today (user zone). */
export async function hasRevisionHistory(userId: string, today: DayString, tz: string): Promise<boolean> {
    const row = await prisma.revision.findFirst({ where: { userId, status: 'done', completedAt: { lt: dayRange(today, tz).gte } }, select: { id: true } });
    return row !== null;
}

export function modeOf(user: Pick<LearningUserRow, 'busyUntil' | 'lastSeenDay' | 'prevSeenDay'>, today: DayString, hasHistory: boolean): PlanMode {
    return planMode({
        today,
        busyUntil: fromDbDayOrNull(user.busyUntil),
        lastSeenDay: fromDbDayOrNull(user.lastSeenDay),
        prevSeenDay: fromDbDayOrNull(user.prevSeenDay),
        hasHistory,
    });
}

/** A revision row (with its topic/capture) as the engine sees it, keeping the row for serializing. */
export type PlanRow = RevisionWithSubject & { row: RevisionWithItem };

export function toPlanRow(r: RevisionWithItem): PlanRow {
    return { ...toEngineRevision(r), subjectId: r.topic?.subject?.id ?? r.capture?.subject?.id ?? null, row: r };
}

export interface ComputedPlan {
    mode: PlanMode;
    result: PlanTodayResult<PlanRow>;
    /** Revisions completed today, most recently scheduled first. */
    doneToday: PlanRow[];
}

/** planToday over the rows of `planRevisionWhere` (any order). */
export function computePlan(
    ctx: Pick<LearningContext, 'today' | 'tz'> & { user: Pick<LearningUserRow, 'busyUntil' | 'lastSeenDay' | 'prevSeenDay' | 'dailyBudgetMin'> },
    rows: readonly PlanRow[],
    goalSubjectIds: Iterable<string>,
    hasHistory: boolean
): ComputedPlan {
    const { today } = ctx;
    const mode = modeOf(ctx.user, today, hasHistory);
    const doneToday = rows
        .filter((r) => r.status === 'done')
        .sort((a, b) => (a.scheduledFor < b.scheduledFor ? 1 : a.scheduledFor > b.scheduledFor ? -1 : a.id < b.id ? -1 : 1));
    const result = planToday({ candidates: rows, today, budgetMin: ctx.user.dailyBudgetMin, mode, goalSubjectIds, doneToday });
    return { mode, result, doneToday };
}

/** A plan item: the RevisionItem shape plus `minutes` (and `daysLate` when overdue). */
export function serializePlanItem(r: PlanRow, today: DayString, extras: { canUndo?: boolean } = {}) {
    const late = r.status === 'pending' && r.scheduledFor < today;
    return serializeRevisionItem(r.row, itemSource(r.row), {
        ...(late ? { daysLate: daysLate(r.scheduledFor, today) } : {}),
        ...extras,
        minutes: revisionMinutes(r),
    });
}

/** Subjects of the user's ACTIVE goals (a relation filter, no include: safe on any client). */
export async function activeGoalSubjectIds(userId: string, db: DbClient = prisma): Promise<string[]> {
    const rows = await db.goalSubject.findMany({ where: { goal: { userId, status: 'active' } }, select: { subjectId: true } });
    return [...new Set(rows.map((r) => r.subjectId))];
}

// ─── POST /api/revisions/fresh-start ───────────────────────────────────

/**
 * Reschedules every overdue pending chain (planFreshStart): each chain's earliest pending
 * revision is spread over today and the next days at what fits the daily budget, and its later
 * cycles keep their gaps. One transaction, the user row locked (complete / reschedule lock it
 * too). `dryRun` computes the same answer without writing (for the confirmation text).
 */
export interface FreshStartResult {
    moved: number;
    spreadDays: number;
    /** Each review moved, from its old day to its new one (for an agent's Undo). */
    changes: Array<{ id: string; from: DayString; to: DayString }>;
}

/**
 * The busy-day routine (BUDDY_MEMORY_PLAN §3.6, B6): while he is busy (his busyUntil), each busy day
 * keeps its most important reviews (as many as busy mode plans: 3, fewer today by what he has done)
 * and the rest move to the days after the busy stretch, spread by his budget the way a fresh start
 * spreads them (a moved review's later cycles move with it). Answers the moves, for its Undo.
 */
export async function moveOffBusyDays(userId: string, now: Date = new Date()): Promise<{ moved: number; until: DayString | null; changes: Array<{ id: string; from: DayString; to: DayString }> }> {
    return prisma.$transaction(
        async (tx) => {
            const ctx = await lockLearningContext(tx, userId, now);
            const { today, tz } = ctx;
            const until = fromDbDayOrNull(ctx.user.busyUntil);
            if (!until || until < today) return { moved: 0, until: null, changes: [] };
            const pending = await tx.revision.findMany({
                where: { userId, status: 'pending' },
                select: { id: true, topicId: true, captureId: true, cycleNumber: true, intervalDays: true, scheduledFor: true, completedAt: true, status: true },
            });
            const subjectOf = await itemSubjects(tx, userId, pending);
            const goals = new Set(await activeGoalSubjectIds(userId, tx));
            const all = pending.map((r) => ({ ...toEngineRevision(r), subjectId: subjectOf(r) }));
            const firsts = earliestPendingPerItem(all);
            const doneToday = await tx.revision.count({ where: { userId, status: 'done', completedAt: dayRange(today, tz) } });
            const overflow: typeof all = [];
            for (let d = today; d <= until; d = addDays(d, 1)) {
                const own = firsts.filter((r) => r.scheduledFor === d).sort(planPriority(d, goals));
                overflow.push(...own.slice(Math.max(0, BUSY_MAX_ITEMS - (d === today ? doneToday : 0))));
            }
            if (!overflow.length) return { moved: 0, until, changes: [] };
            // From the first free day: the moving reviews' whole chains, and what already sits after the
            // busy stretch (its load; it stays where it is). The busy days' kept reviews are not touched.
            const after = addDays(until, 1);
            const moving = new Set(overflow.map((r) => revisionItemKey(r)));
            const plan = planFreshStart({
                revisions: all.filter((r) => moving.has(revisionItemKey(r)) || r.scheduledFor >= after),
                today: after,
                budgetMin: ctx.user.dailyBudgetMin,
                goalSubjectIds: [...goals],
                doneToday: [],
            });
            const dayOf = new Map(all.map((r) => [r.id, r.scheduledFor]));
            const changes: Array<{ id: string; from: DayString; to: DayString }> = [];
            for (const p of plan.patches) {
                const from = dayOf.get(p.id);
                if (p.scheduledFor === undefined || !from || from === p.scheduledFor) continue;
                changes.push({ id: p.id, from, to: p.scheduledFor });
                await tx.revision.update({ where: { id: p.id }, data: { scheduledFor: toDbDay(p.scheduledFor) }, select: { id: true } });
            }
            return { moved: overflow.length, until, changes };
        },
        { timeout: 60_000 }
    );
}

export async function freshStart(userId: string, opts: { dryRun?: boolean | undefined } = {}, now: Date = new Date()): Promise<FreshStartResult> {
    return prisma.$transaction(
        async (tx) => {
            const ctx = await lockLearningContext(tx, userId, now);
            const { today, tz } = ctx;
            const pending = await tx.revision.findMany({
                where: { userId, status: 'pending' },
                select: { id: true, topicId: true, captureId: true, cycleNumber: true, intervalDays: true, scheduledFor: true, completedAt: true, status: true },
            });
            if (!pending.some((r) => fromDbDay(r.scheduledFor) < today)) return { moved: 0, spreadDays: 0, changes: [] };
            const dayOf = new Map(pending.map((r) => [r.id, fromDbDay(r.scheduledFor)]));
            const doneToday = await tx.revision.findMany({ where: { userId, status: 'done', completedAt: dayRange(today, tz) }, select: { cycleNumber: true } });
            const subjectOf = await itemSubjects(tx, userId, pending);
            const goalSubjectIds = await activeGoalSubjectIds(userId, tx);

            const plan = planFreshStart({
                revisions: pending.map((r) => ({ ...toEngineRevision(r), subjectId: subjectOf(r) })),
                today,
                budgetMin: ctx.user.dailyBudgetMin,
                goalSubjectIds,
                doneToday,
            });
            const changes: FreshStartResult['changes'] = [];
            for (const p of plan.patches) {
                const from = dayOf.get(p.id);
                if (p.scheduledFor === undefined || !from || from === p.scheduledFor) continue;
                changes.push({ id: p.id, from, to: p.scheduledFor });
                if (!opts.dryRun) await tx.revision.update({ where: { id: p.id }, data: { scheduledFor: toDbDay(p.scheduledFor) }, select: { id: true } });
            }
            return { moved: plan.moved, spreadDays: plan.spreadDays, changes };
        },
        { timeout: 60_000 }
    );
}
