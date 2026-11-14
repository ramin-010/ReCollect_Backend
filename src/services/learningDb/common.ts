// Shared plumbing for the learning DB services (LEARNING_SPEC §2): the user's learning context
// (time zone, routine mode, streak columns), row ↔ engine mappers, row locks, and small input
// validators. The domain logic itself is the pure engine in services/learning.
//
// Days: @db.Date columns hold the user's LOCAL day. Write `dayToUtcMidnight(day)`, read
// `dayFromUtcMidnight(date)`. Day boundaries of instants (completedAt …) use the user's zone.
import { Prisma } from '@prisma/client';
import type { DailyScheduleSlot, DayDebrief, Revision as RevisionRow, RoutineMode, TimeBlock as TimeBlockRow } from '@prisma/client';
import { prisma, type DbClient, type TxClient } from '../../db/prisma';
import {
    dayFromUtcMidnight,
    dayToUtcMidnight,
    isValidDay,
    isValidTime,
    minutesOfDay,
    minutesToTime,
    resolveTimeZone,
    startOfDay,
    today as todayIn,
    addDays,
    type CompletionUndo,
    type DayDebrief as EngineDebrief,
    type DayString,
    type Revision,
    type ScheduleSlot,
    type StreakSnapshot,
    type StreakState,
    type TimeBlock,
} from '../learning';
import { badRequest } from '../learning/http';

// ─── The user's learning context ───────────────────────────────────────

export const learningUserSelect = {
    id: true,
    name: true,
    timezone: true,
    routineMode: true,
    globalStreak: true,
    longestGlobalStreak: true,
    lastGlobalStreakDay: true,
    globalStreakBeforeCredit: true,
    learningRolledOverDay: true,
    // Daily loop v2 (LOOP_V2_SPEC §1)
    dailyBudgetMin: true,
    routineEnabled: true,
    busyUntil: true,
    nudgeEmailEnabled: true,
    nudgeTime: true,
    lastNudgeDay: true,
    lastSeenDay: true,
    prevSeenDay: true,
} as const satisfies Prisma.UserSelect;

export type LearningUserRow = Prisma.UserGetPayload<{ select: typeof learningUserSelect }>;

export interface LearningContext {
    user: LearningUserRow;
    /** The user's zone (invalid / empty values fall back to Asia/Kolkata). */
    tz: string;
    /** The user's current local day. */
    today: DayString;
    now: Date;
}

export function contextOf(user: LearningUserRow, now: Date = new Date()): LearningContext {
    const tz = resolveTimeZone(user.timezone);
    return { user, tz, today: todayIn(tz, now), now };
}

export async function loadLearningContext(userId: string, now: Date = new Date(), db: DbClient = prisma): Promise<LearningContext> {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: learningUserSelect });
    return contextOf(user, now);
}

/** `SELECT … FOR UPDATE` on the user row, then its learning columns (inside a transaction). */
export async function lockLearningContext(tx: TxClient, userId: string, now: Date = new Date()): Promise<LearningContext> {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    return loadLearningContext(userId, now, tx);
}

/** The user's local wall-clock time 'HH:mm'. */
export function nowHHmm(ctx: Pick<LearningContext, 'tz' | 'now'>): string {
    return minutesToTime(minutesOfDay(ctx.now, ctx.tz));
}

/** [start of `day`, start of the next day) in the user's zone, for instant columns. */
export function dayRange(day: DayString, tz: string): { gte: Date; lt: Date } {
    return { gte: startOfDay(day, tz), lt: startOfDay(addDays(day, 1), tz) };
}

export const toDbDay = dayToUtcMidnight;
export const fromDbDay = dayFromUtcMidnight;
/** A nullable @db.Date column as a day. */
export const fromDbDayOrNull = (d: Date | null | undefined): DayString | null => (d ? dayFromUtcMidnight(d) : null);

// ─── Streaks ───────────────────────────────────────────────────────────

/** A Json StreakSnapshot, validated (anything malformed → null, i.e. "no snapshot"). */
export function parseSnapshot(value: Prisma.JsonValue | null | undefined): StreakSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (!Number.isInteger(v.current) || !Number.isInteger(v.longest)) return null;
    const last = v.lastCreditDay;
    if (last !== null && !isValidDay(last)) return null;
    return { current: v.current as number, longest: v.longest as number, lastCreditDay: (last as DayString | null) ?? null };
}

const snapshotJson = (s: StreakSnapshot | null): Prisma.InputJsonValue | typeof Prisma.DbNull =>
    s ? { current: s.current, longest: s.longest, lastCreditDay: s.lastCreditDay } : Prisma.DbNull;

export function globalStreakOf(user: Pick<LearningUserRow, 'globalStreak' | 'longestGlobalStreak' | 'lastGlobalStreakDay' | 'globalStreakBeforeCredit'>): StreakState {
    return {
        current: user.globalStreak,
        longest: user.longestGlobalStreak,
        lastCreditDay: user.lastGlobalStreakDay ? fromDbDay(user.lastGlobalStreakDay) : null,
        beforeLastCredit: parseSnapshot(user.globalStreakBeforeCredit),
    };
}

export function globalStreakData(s: StreakState): Prisma.UserUpdateInput {
    return {
        globalStreak: s.current,
        longestGlobalStreak: s.longest,
        lastGlobalStreakDay: s.lastCreditDay ? toDbDay(s.lastCreditDay) : null,
        globalStreakBeforeCredit: snapshotJson(s.beforeLastCredit),
    };
}

export interface SubjectStreakRowLike {
    currentStreak: number;
    longestStreak: number;
    lastCreditDay: Date | null;
    beforeLastCredit: Prisma.JsonValue | null;
}

export function subjectStreakOf(row: SubjectStreakRowLike): StreakState {
    return {
        current: row.currentStreak,
        longest: row.longestStreak,
        lastCreditDay: row.lastCreditDay ? fromDbDay(row.lastCreditDay) : null,
        beforeLastCredit: parseSnapshot(row.beforeLastCredit),
    };
}

export function subjectStreakData(s: StreakState) {
    return {
        currentStreak: s.current,
        longestStreak: s.longest,
        lastCreditDay: s.lastCreditDay ? toDbDay(s.lastCreditDay) : null,
        beforeLastCredit: snapshotJson(s.beforeLastCredit),
    };
}

export const sameStreak = (a: StreakState, b: StreakState): boolean =>
    a.current === b.current &&
    a.longest === b.longest &&
    a.lastCreditDay === b.lastCreditDay &&
    JSON.stringify(a.beforeLastCredit) === JSON.stringify(b.beforeLastCredit);

// ─── Revisions ─────────────────────────────────────────────────────────

export function toEngineRevision(r: Pick<RevisionRow, 'id' | 'topicId' | 'captureId' | 'cycleNumber' | 'intervalDays' | 'scheduledFor' | 'completedAt' | 'status'>): Revision {
    return {
        id: r.id,
        topicId: r.topicId,
        captureId: r.captureId,
        cycleNumber: r.cycleNumber,
        intervalDays: r.intervalDays,
        scheduledFor: fromDbDay(r.scheduledFor),
        completedAt: r.completedAt,
        status: r.status,
    };
}

/** A stored CompletionUndo, validated; an invalid record counts as null (interval-spacing fallback). */
export function parseUndo(value: Prisma.JsonValue | null | undefined): CompletionUndo | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.revisionId !== 'string' || !isValidDay(v.completedDay) || !Array.isArray(v.shifts)) return null;
    const shifts: CompletionUndo['shifts'] = [];
    for (const s of v.shifts) {
        if (!s || typeof s !== 'object') return null;
        const x = s as Record<string, unknown>;
        if (typeof x.revisionId !== 'string' || !isValidDay(x.from) || !isValidDay(x.to)) return null;
        shifts.push({ revisionId: x.revisionId, from: x.from, to: x.to });
    }
    return { revisionId: v.revisionId, completedDay: v.completedDay, shifts };
}

export function undoJson(undo: CompletionUndo): Prisma.InputJsonValue {
    return { revisionId: undo.revisionId, completedDay: undo.completedDay, shifts: undo.shifts.map((s) => ({ ...s })) };
}

// ─── Schedule ──────────────────────────────────────────────────────────

export function toEngineSlot(s: DailyScheduleSlot): ScheduleSlot {
    return {
        id: s.id,
        sourceBlockId: s.sourceBlockId,
        date: fromDbDay(s.date),
        title: s.title,
        color: s.color,
        startTime: s.startTime,
        endTime: s.endTime,
        status: s.status,
        actualStartTime: s.actualStartTime,
        actualEndTime: s.actualEndTime,
        remark: s.remark,
        minutesDone: s.minutesDone,
        sortOrder: s.sortOrder,
    };
}

export function toEngineBlock(b: TimeBlockRow): TimeBlock {
    return {
        id: b.id,
        title: b.title,
        startTime: b.startTime,
        endTime: b.endTime,
        color: b.color,
        dayOfWeek: b.dayOfWeek,
        date: b.date ? fromDbDay(b.date) : null,
        createdAt: b.createdAt,
    };
}

export function toEngineDebrief(d: DayDebrief): EngineDebrief {
    return {
        date: fromDbDay(d.date),
        blocksPlanned: d.blocksPlanned,
        blocksCompleted: d.blocksCompleted,
        blocksSkipped: d.blocksSkipped,
        totalFocusedMin: d.totalFocusedMin,
        energy: d.energy,
        focus: d.focus,
        mood: d.mood,
        tags: d.tags,
        narrative: d.narrative,
        tomorrowIntent: d.tomorrowIntent,
        freeWrite: d.freeWrite,
    };
}

/** Debrief columns from an engine DayDebrief (for create/update). */
export function debriefData(d: EngineDebrief) {
    return {
        blocksPlanned: d.blocksPlanned,
        blocksCompleted: d.blocksCompleted,
        blocksSkipped: d.blocksSkipped,
        totalFocusedMin: d.totalFocusedMin,
        energy: d.energy,
        focus: d.focus,
        mood: d.mood,
        tags: [...d.tags],
        narrative: d.narrative,
        tomorrowIntent: d.tomorrowIntent,
        freeWrite: d.freeWrite,
    };
}

/** Logs of the user's blocks between two days (inclusive). BlockSessionLog has no userId. */
export async function loadBlockLogs(userId: string, from: DayString, to: DayString, db: DbClient) {
    const rows = await db.blockSessionLog.findMany({
        where: { timeBlock: { userId }, date: { gte: toDbDay(from), lte: toDbDay(to) } },
    });
    return rows.map((l) => ({
        timeBlockId: l.timeBlockId,
        date: fromDbDay(l.date),
        status: l.status,
        remark: l.remark,
        minutesDone: l.minutesDone,
    }));
}

export async function upsertBlockLog(
    log: { timeBlockId: string; date: DayString; status: 'COMPLETED' | 'SKIPPED' | 'PARTIAL'; remark: string | null; minutesDone?: number | null },
    db: DbClient
): Promise<void> {
    const data = { status: log.status, remark: log.remark, ...(log.minutesDone !== undefined ? { minutesDone: log.minutesDone } : {}) };
    await db.blockSessionLog.upsert({
        where: { timeBlockId_date: { timeBlockId: log.timeBlockId, date: toDbDay(log.date) } },
        create: { timeBlockId: log.timeBlockId, date: toDbDay(log.date), ...data },
        update: data,
        select: { id: true },
    });
}

export type { RoutineMode };

// ─── Input validation ──────────────────────────────────────────────────

/** A 'YYYY-MM-DD' day or a 400 INVALID_DAY. */
export function requireDay(value: unknown, field = 'day'): DayString {
    if (!isValidDay(value)) throw badRequest(`${field} must be a calendar day 'YYYY-MM-DD'`, 'INVALID_DAY');
    return value;
}

/** An 'HH:mm' time or a 400 INVALID_TIME. */
export function requireTime(value: unknown, field: string): string {
    if (!isValidTime(value)) throw badRequest(`${field} must be a time 'HH:mm'`, 'INVALID_TIME');
    return value;
}
