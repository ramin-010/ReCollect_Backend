/**
 * Today's plan (LOOP_V2_SPEC §2): a short, budgeted list of revisions for the day plus a quiet
 * backlog ("waiting"), the mode that shrinks it (busy week, coming back after days away), and the
 * "fresh start" that spreads an overdue backlog over the next days.
 *
 * Principles (recollect/PRODUCT.md): Today is short and finite, overdue items wait quietly and
 * come in as room allows, and coming back is cheap.
 *
 * Everything here is pure. The service passes revisions with their subject (any mix of items and
 * statuses; the filtering happens here) and writes the patches it gets back.
 */
import { addDays, assertDay, diffDays, type DayString } from './time';
import { earliestPendingPerItem, rescheduleRevision, revisionItemKey, type RevisionPatch } from './revisions';
import type { Revision, RevisionWithSubject } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Estimated minutes for a first-cycle revision (the first real recall takes longer). */
export const PLAN_MINUTES_FIRST_CYCLE = 8;
/** Estimated minutes for any later cycle. */
export const PLAN_MINUTES_LATER_CYCLE = 5;
/** With any candidates, a day plans at least this many items (done ones count). */
export const PLAN_MIN_ITEMS = 3;
/** Lateness counts at most this many days in the priority order. */
export const PLAN_LATENESS_CAP_DAYS = 14;

/** User.dailyBudgetMin bounds and default (minutes). */
export const DAILY_BUDGET_MIN = 5;
export const DAILY_BUDGET_MAX = 120;
export const DEFAULT_DAILY_BUDGET = 25;

/** Busy mode: at most 3 items, and the budget is capped at 10 minutes. */
export const BUSY_MAX_ITEMS = 3;
export const BUSY_MAX_BUDGET_MIN = 10;
/** "Busy week" sets busyUntil = today + 6 (a 7-day week including today). */
export const BUSY_WEEK_DAYS = 7;

/** Comeback mode: at most 5 items that day. */
export const COMEBACK_MAX_ITEMS = 5;
/** Comeback when the app was last seen this many days ago or more (lastSeenDay <= today - 3). */
export const COMEBACK_AWAY_DAYS = 3;

export type PlanMode = 'normal' | 'busy' | 'comeback';

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Estimated minutes of one revision: cycle 1 = 8, otherwise 5. */
export function revisionMinutes(r: Pick<Revision, 'cycleNumber'>): number {
  return r.cycleNumber === 1 ? PLAN_MINUTES_FIRST_CYCLE : PLAN_MINUTES_LATER_CYCLE;
}

/** A daily budget clamped to 5..120 whole minutes (anything not finite → the default 25). */
export function clampBudget(budgetMin: number): number {
  if (!Number.isFinite(budgetMin)) return DEFAULT_DAILY_BUDGET;
  return Math.min(DAILY_BUDGET_MAX, Math.max(DAILY_BUDGET_MIN, Math.round(budgetMin)));
}

/** The busyUntil a "Busy week" sets: today + 6. */
export function busyWeekUntil(today: DayString): DayString {
  return addDays(today, BUSY_WEEK_DAYS - 1);
}

export interface PlanModeInput {
  today: DayString;
  /** Busy mode is on while today <= busyUntil. */
  busyUntil: DayString | null;
  /** The last day the app was opened (ensure-today), or null if never. */
  lastSeenDay: DayString | null;
  /**
   * lastSeenDay as it was before today's first visit. Once the app is opened today,
   * lastSeenDay === today, and this is what tells whether today is a comeback day.
   */
  prevSeenDay?: DayString | null;
  /** The user did revise before (any revision completed before today). */
  hasHistory: boolean;
}

/** The last day the app was seen BEFORE today (null = unknown / never). */
export function lastSeenBefore(input: Pick<PlanModeInput, 'today' | 'lastSeenDay' | 'prevSeenDay'>): DayString | null {
  if (input.lastSeenDay !== null && input.lastSeenDay === input.today) return input.prevSeenDay ?? null;
  return input.lastSeenDay;
}

/**
 * busy    busyUntil >= today (wins over comeback: it is the user's own choice, and smaller)
 * comeback  the app was last seen on or before today - 3, or never seen while the user has history;
 *           it lasts the whole day of the return (see prevSeenDay)
 * normal  otherwise
 */
export function planMode(input: PlanModeInput): PlanMode {
  const { today } = input;
  assertDay(today);
  if (input.busyUntil !== null && input.busyUntil >= today) return 'busy';
  const seen = lastSeenBefore(input);
  const away = seen === null ? input.hasHistory : seen <= addDays(today, -COMEBACK_AWAY_DAYS);
  return away ? 'comeback' : 'normal';
}

export interface PlanLimits {
  /** The budget the plan fills (busy caps it at 10). */
  budgetMin: number;
  /** Most items the day may hold (done ones count), null = only the budget limits it. */
  maxItems: number | null;
}

export function planLimits(mode: PlanMode, budgetMin: number): PlanLimits {
  const budget = clampBudget(budgetMin);
  if (mode === 'busy') return { budgetMin: Math.min(budget, BUSY_MAX_BUDGET_MIN), maxItems: BUSY_MAX_ITEMS };
  if (mode === 'comeback') return { budgetMin: budget, maxItems: COMEBACK_MAX_ITEMS };
  return { budgetMin: budget, maxItems: null };
}

/** Days late counted for the priority order: 0 for today, at most 14. */
export function cappedLateness(scheduledFor: DayString, today: DayString): number {
  return Math.min(PLAN_LATENESS_CAP_DAYS, Math.max(0, diffDays(today, scheduledFor)));
}

/**
 * The plan's priority order (most important first):
 *   1. linked to an active goal's subjects
 *   2. lower cycle first
 *   3. more days late first (capped at 14)
 *   4. scheduledFor ascending
 *   5. id ascending (stable)
 * (3 and 4 together amount to "oldest first"; the cap only makes items 14+ days late tie on 3.)
 */
export function planPriority(
  today: DayString,
  goalSubjectIds: ReadonlySet<string>,
): (a: RevisionWithSubject, b: RevisionWithSubject) => number {
  const linked = (r: RevisionWithSubject): boolean => r.subjectId !== null && goalSubjectIds.has(r.subjectId);
  return (a, b) => {
    const la = linked(a);
    const lb = linked(b);
    if (la !== lb) return la ? -1 : 1;
    if (a.cycleNumber !== b.cycleNumber) return a.cycleNumber - b.cycleNumber;
    const lateA = cappedLateness(a.scheduledFor, today);
    const lateB = cappedLateness(b.scheduledFor, today);
    if (lateA !== lateB) return lateB - lateA;
    if (a.scheduledFor !== b.scheduledFor) return a.scheduledFor < b.scheduledFor ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** The earliest pending revision of every item that is due by `today` (scheduledFor <= today). */
export function planCandidates<T extends RevisionWithSubject>(revisions: readonly T[], today: DayString): T[] {
  return earliestPendingPerItem(revisions).filter((r) => r.scheduledFor <= today);
}

// ─────────────────────────────────────────────────────────────────────────────
// planToday
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanTodayInput<T extends RevisionWithSubject> {
  /** Revisions to plan from: any statuses and days; only the earliest pending one per item due by today counts. */
  candidates: readonly T[];
  today: DayString;
  /** User.dailyBudgetMin. */
  budgetMin: number;
  mode: PlanMode;
  /** Subjects linked to the user's ACTIVE goals. */
  goalSubjectIds: Iterable<string>;
  /**
   * Revisions already completed today. They use up the budget and count toward the item limits
   * (min 3, busy 3, comeback 5), so finishing the plan empties it instead of refilling it.
   */
  doneToday?: ReadonlyArray<Pick<Revision, 'cycleNumber'>>;
}

export interface PlanTodayResult<T> {
  /** In priority order. */
  planned: T[];
  /** Candidates that wait (the quiet backlog). */
  waitingCount: number;
  /** Minutes of `planned`. */
  estMinutes: number;
  /** The budget that was filled (after the mode's cap). */
  budgetMin: number;
}

/**
 * Fills today: candidates in priority order (`planPriority`) are added while they fit the budget
 * (minus what was done today); the plan is a prefix of that order, so a lower-priority item never
 * jumps a higher one. With any candidates the day holds at least 3 items (so one big item never
 * leaves Today empty), and never more than the mode allows (busy 3, comeback 5).
 */
export function planToday<T extends RevisionWithSubject>(input: PlanTodayInput<T>): PlanTodayResult<T> {
  const { today } = input;
  assertDay(today);
  const limits = planLimits(input.mode, input.budgetMin);
  const goals = new Set(input.goalSubjectIds);
  const ordered = planCandidates(input.candidates, today).sort(planPriority(today, goals));

  const done = input.doneToday ?? [];
  const usedMin = done.reduce((sum, r) => sum + revisionMinutes(r), 0);
  const maxPlanned = limits.maxItems === null ? Infinity : Math.max(0, limits.maxItems - done.length);

  const planned: T[] = [];
  let minutes = usedMin;
  for (const r of ordered) {
    if (planned.length >= maxPlanned) break;
    const m = revisionMinutes(r);
    if (minutes + m > limits.budgetMin) break;
    planned.push(r);
    minutes += m;
  }
  // The minimum: the day (done + planned) holds at least 3 items when there are candidates.
  const minPlanned = Math.min(ordered.length, maxPlanned, Math.max(0, PLAN_MIN_ITEMS - done.length));
  while (planned.length < minPlanned) planned.push(ordered[planned.length]!);

  return {
    planned,
    waitingCount: ordered.length - planned.length,
    estMinutes: planned.reduce((sum, r) => sum + revisionMinutes(r), 0),
    budgetMin: limits.budgetMin,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fresh start
// ─────────────────────────────────────────────────────────────────────────────

export interface FreshStartInput<T extends RevisionWithSubject> {
  /** The user's revisions (pending ones matter; pass every chain, also the ones not overdue). */
  revisions: readonly T[];
  today: DayString;
  /** User.dailyBudgetMin: what fits in one day. */
  budgetMin: number;
  goalSubjectIds?: Iterable<string>;
  /** Revisions completed today: they already used part of today's budget. */
  doneToday?: ReadonlyArray<Pick<Revision, 'cycleNumber'>>;
}

export interface FreshStartDay {
  day: DayString;
  /** The moved revisions (each chain's earliest pending one) placed on this day, in priority order. */
  revisionIds: string[];
  /** Minutes of the moved revisions on this day. */
  minutes: number;
}

export interface FreshStartResult {
  /** scheduledFor changes: each moved revision plus its chain's later pending cycles (same delta). */
  patches: RevisionPatch[];
  /** Chains moved (= overdue chains). */
  moved: number;
  /** Days the moved chains were spread over, counting from today (0 when nothing was overdue). */
  spreadDays: number;
  days: FreshStartDay[];
}

/**
 * "Fresh start": every overdue chain (its earliest pending revision is scheduled before today)
 * gets that revision moved to today or a following day, and its later pending cycles move by the
 * same number of days, so they keep their gaps (`rescheduleRevision`).
 *
 * Spreading: overdue chains are taken in the plan's priority order and placed day by day starting
 * today. A day takes moved items while its load fits the budget: the load is what is already due
 * that day (the earliest pending revision of chains scheduled on it, plus today's completions)
 * and the moved items so far. Every day takes at least one moved item, so the spread always ends.
 * Nothing that is due today or later moves.
 */
export function planFreshStart<T extends RevisionWithSubject>(input: FreshStartInput<T>): FreshStartResult {
  const { today } = input;
  assertDay(today);
  const budget = clampBudget(input.budgetMin);
  const goals = new Set(input.goalSubjectIds ?? []);
  const pending = input.revisions.filter((r) => r.status === 'pending');

  const chains = new Map<string, T[]>();
  for (const r of pending) {
    const key = revisionItemKey(r);
    const list = chains.get(key);
    if (list) list.push(r);
    else chains.set(key, [r]);
  }

  const firsts = earliestPendingPerItem(pending);
  const overdue = firsts.filter((r) => r.scheduledFor < today).sort(planPriority(today, goals));
  const load = new Map<DayString, number>();
  const addLoad = (day: DayString, minutes: number) => load.set(day, (load.get(day) ?? 0) + minutes);
  for (const r of firsts) if (r.scheduledFor >= today) addLoad(r.scheduledFor, revisionMinutes(r));
  for (const r of input.doneToday ?? []) addLoad(today, revisionMinutes(r));

  const days: FreshStartDay[] = [];
  const patches: RevisionPatch[] = [];
  let current: FreshStartDay = { day: today, revisionIds: [], minutes: 0 };
  for (const r of overdue) {
    const m = revisionMinutes(r);
    while (current.revisionIds.length > 0 && (load.get(current.day) ?? 0) + m > budget) {
      days.push(current);
      current = { day: addDays(current.day, 1), revisionIds: [], minutes: 0 };
    }
    current.revisionIds.push(r.id);
    current.minutes += m;
    addLoad(current.day, m);
    patches.push(...rescheduleRevision(chains.get(revisionItemKey(r)) ?? [r], r.id, current.day).patches);
  }
  if (current.revisionIds.length > 0) days.push(current);

  return {
    patches,
    moved: overdue.length,
    spreadDays: days.length === 0 ? 0 : diffDays(days[days.length - 1]!.day, today) + 1,
    days,
  };
}
