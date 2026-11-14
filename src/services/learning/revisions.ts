/**
 * Spaced-repetition engine, ported from Revise.
 *
 * Sources (all under revise/src/):
 *   - app/actions/revision.actions.ts  startTopicRevisions, startCaptureRevisions, completeRevision
 *   - app/actions/planner.actions.ts   toggleRevision (unmark), rescheduleRevision
 *   - app/(protected)/dashboard/page.tsx          which revisions the dashboard shows, mastered count
 *   - app/(protected)/dashboard/DashboardClient.tsx  the today / overdue / done buckets
 *   - app/(protected)/dashboard/dashComponents/RevisionsList.tsx  daysLate
 *   - app/(protected)/topic/[id]/hooks/useTopicRevisions.ts  start / early / due button state
 *
 * Everything here is pure: functions take an item's revision chain (all
 * revisions sharing one topicId or captureId) and return the new chain plus a
 * minimal list of patches for the database layer. Inputs are never mutated.
 * Completing is one click (done / undone); there is no rating step.
 *
 * Time zone: a revision is due on a calendar day (`DayString`) in the user's
 * zone; `completedAt` is a real instant, turned into a day with `dayOf`. This
 * removes Revise's "today starts at 05:30 IST" bug (see time.ts).
 */
import { LearningError } from './errors';
import { addDays, assertDay, dayOf, DEFAULT_TIMEZONE, diffDays, type DayString } from './time';
import type { Revision, RevisionStatus, RevisionWithSubject } from './types';

/** Revise's fixed schedule: cycles at +1, +3, +7 and +21 days. */
export const REVISION_INTERVALS: readonly number[] = Object.freeze([1, 3, 7, 21]);

/** "Cycle k of 4". */
export const REVISION_CYCLES = REVISION_INTERVALS.length;

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

/** A row to insert when revisions start. */
export interface PlannedRevision {
  cycleNumber: number;
  intervalDays: number;
  scheduledFor: DayString;
  status: 'pending';
  completedAt: null;
}

/** The fields of one revision row that an operation changed. */
export interface RevisionPatch {
  id: string;
  status?: RevisionStatus;
  completedAt?: Date | null;
  scheduledFor?: DayString;
}

/** One date move made by a completion. */
export interface ScheduleShift {
  revisionId: string;
  from: DayString;
  to: DayString;
}

/**
 * Everything a completion changed in the chain, so `uncompleteRevision` can
 * put it back. Persist it with the completed revision (e.g. a JSON column) and
 * delete it once the completion is undone.
 */
export interface CompletionUndo {
  revisionId: string;
  completedDay: DayString;
  shifts: ScheduleShift[];
}

export interface CompleteRevisionResult<T extends Revision> {
  /** The whole chain after the completion, ordered by cycle. */
  revisions: T[];
  patches: RevisionPatch[];
  /** The user-local day the completion counts for (streaks, DailyHistory, "done today"). */
  completedDay: DayString;
  undo: CompletionUndo;
  /** True when this completion finished cycle 4. */
  mastered: boolean;
}

export interface UncompleteRevisionResult<T extends Revision> {
  revisions: T[];
  patches: RevisionPatch[];
  /** The day the undone completion had counted for, or null if unknown. */
  completedDay: DayString | null;
  /** How the later dates were restored (see `uncompleteRevision`). */
  restoredWith: 'undo-record' | 'interval-spacing';
}

export interface RescheduleRevisionResult<T extends Revision> {
  revisions: T[];
  patches: RevisionPatch[];
  deltaDays: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identity of the item a revision belongs to: `topic_<id>` or `capture_<id>`,
 * exactly the key dashboard/page.tsx uses to keep one pending revision per item.
 */
export function revisionItemKey(r: Pick<Revision, 'topicId' | 'captureId'>): string {
  return r.topicId ? `topic_${r.topicId}` : `capture_${r.captureId}`;
}

function assertSingleItem(chain: readonly Revision[]): void {
  const first = chain[0];
  if (!first) return;
  const key = revisionItemKey(first);
  for (const r of chain) {
    if (revisionItemKey(r) !== key) {
      throw new LearningError('MIXED_CHAIN', `Revision ${r.id} belongs to ${revisionItemKey(r)}, not ${key}`);
    }
  }
}

function findRevision<T extends Revision>(chain: readonly T[], revisionId: string): T {
  const found = chain.find((r) => r.id === revisionId);
  if (!found) throw new LearningError('REVISION_NOT_FOUND', `Revision ${revisionId} is not in this chain`);
  return found;
}

const byCycle = (a: Revision, b: Revision): number => a.cycleNumber - b.cycleNumber;

/** Order used for "earliest": scheduled day, then cycle (Revise: orderBy scheduledFor asc; ties were DB order). */
const bySchedule = (a: Revision, b: Revision): number =>
  a.scheduledFor < b.scheduledFor ? -1 : a.scheduledFor > b.scheduledFor ? 1 : a.cycleNumber - b.cycleNumber;

function applyDates<T extends Revision>(chain: readonly T[], dates: ReadonlyMap<string, DayString>): { revisions: T[]; patches: RevisionPatch[] } {
  const patches: RevisionPatch[] = [];
  const revisions = [...chain].sort(byCycle).map((r) => {
    const next = dates.get(r.id);
    if (next === undefined || next === r.scheduledFor) return r;
    patches.push({ id: r.id, scheduledFor: next });
    return { ...r, scheduledFor: next };
  });
  return { revisions, patches };
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four revisions for an item started on `startDay` (the user's today).
 *
 * Mirrors revision.actions.ts startTopicRevisions / startCaptureRevisions:
 * `tomorrow = addDays(getISTMidnight(now), 1)` and
 * `scheduledFor = addDays(tomorrow, intervalDays - 1)`, i.e. startDay + 1, +3,
 * +7 and +21, all pending.
 *
 * Added guard: throws ALREADY_STARTED if the item already has revisions.
 * Revise's createMany would add a second set of four; only the topic page's
 * button state prevented that.
 */
export function startRevisions(startDay: DayString, existing: readonly Revision[] = []): PlannedRevision[] {
  assertDay(startDay);
  if (existing.length > 0) {
    throw new LearningError('ALREADY_STARTED', 'This item already has revisions');
  }
  return REVISION_INTERVALS.map((intervalDays, index) => ({
    cycleNumber: index + 1,
    intervalDays,
    scheduledFor: addDays(startDay, intervalDays),
    status: 'pending' as const,
    completedAt: null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Complete / uncomplete / reschedule
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Completes one cycle (a single click; no rating).
 *
 * Mirrors revision.actions.ts completeRevision steps 1-2: the revision becomes
 * done with `completedAt`, and every LATER PENDING cycle j of the same item is
 * re-snapped to `completedDay + (interval_j - interval_k)`, where k is the
 * completed cycle and the intervals are the rows' stored `intervalDays`.
 * Completing early or late therefore re-anchors the rest of the chain on the
 * day you actually revised: complete cycle 1 (interval 1) three days late on
 * D and cycle 2 moves to D + 2, cycle 3 to D + 6, cycle 4 to D + 20.
 *
 * Step 3 of Revise's completeRevision (an ActivityLog row, action
 * 'COMPLETED_REVISION', details `Cycle <k> for <title>`) is the service's
 * write; steps 4-5 (DailyHistory, SubjectStreak, global streak) are
 * `streakEffectsOfCompletion` in streaks.ts, fed with `result.completedDay`.
 *
 * Added guard: throws NOT_PENDING if the revision is not pending. Revise would
 * re-run every side effect on a double click.
 */
export function completeRevision<T extends Revision>(
  chain: readonly T[],
  revisionId: string,
  completedAt: Date,
  tz: string = DEFAULT_TIMEZONE,
): CompleteRevisionResult<T> {
  assertSingleItem(chain);
  const target = findRevision(chain, revisionId);
  if (target.status !== 'pending') {
    throw new LearningError('NOT_PENDING', `Revision ${revisionId} is ${target.status}, not pending`);
  }
  const completedDay = dayOf(completedAt, tz);

  const shifts: ScheduleShift[] = [];
  const patches: RevisionPatch[] = [{ id: target.id, status: 'done', completedAt }];
  const revisions = [...chain].sort(byCycle).map((r): T => {
    if (r.id === target.id) return { ...r, status: 'done', completedAt };
    if (r.cycleNumber > target.cycleNumber && r.status === 'pending') {
      const to = addDays(completedDay, r.intervalDays - target.intervalDays);
      if (to === r.scheduledFor) return r;
      shifts.push({ revisionId: r.id, from: r.scheduledFor, to });
      patches.push({ id: r.id, scheduledFor: to });
      return { ...r, scheduledFor: to };
    }
    return r;
  });

  return {
    revisions,
    patches,
    completedDay,
    undo: { revisionId: target.id, completedDay, shifts },
    mastered: isMastered(revisions),
  };
}

/**
 * Undoes a completion ("Unmark"). This is the CORRECT undo that Revise lacks.
 *
 * Revise's planner.actions.ts toggleRevision(id, false) only sets the row back
 * to pending with completedAt null; the later cycles stay where the
 * completion moved them, and the streak, DailyHistory and ActivityLog stay
 * credited. Here an undo restores the state from before the completion:
 *
 *  1. The revision goes back to pending, completedAt null. Its own
 *     scheduledFor is untouched (a completion never changes it).
 *  2. Later cycles get their pre-completion dates back:
 *     - with the `undo` record from `completeRevision`: each shifted revision
 *       that is still pending moves by the inverse of its shift
 *       (`current + (from - to)`). If nothing touched it since, that is
 *       exactly `from`; if the user rescheduled it in between, that
 *       reschedule's offset is kept.
 *     - without a record (e.g. a completion imported from Revise): each later
 *       pending cycle j is re-spaced from the restored cycle k as
 *       `scheduledFor_k + (interval_j - interval_k)`. Start, complete and
 *       reschedule all preserve that spacing between the earliest pending
 *       cycle and the later ones, so this equals the pre-completion dates for
 *       any chain worked in order.
 *  3. Streaks and DailyHistory: call `streakEffectsOfUncompletion`
 *     (streaks.ts) with `result.completedDay`; it takes back today's credit
 *     when it is no longer earned.
 *  4. The service also deletes the COMPLETED_REVISION ActivityLog row and the
 *     stored undo record (Revise keeps the log, inflating totalRevisionsDone).
 *
 * Guards: NOT_DONE if the revision is not done; LATER_CYCLE_DONE if a later
 * cycle of the same item is done (undo that one first: the later dates now
 * belong to its completion); UNDO_MISMATCH if `undo` is for another revision.
 */
export function uncompleteRevision<T extends Revision>(
  chain: readonly T[],
  revisionId: string,
  undo: CompletionUndo | null = null,
  tz: string = DEFAULT_TIMEZONE,
): UncompleteRevisionResult<T> {
  assertSingleItem(chain);
  const target = findRevision(chain, revisionId);
  if (target.status !== 'done') {
    throw new LearningError('NOT_DONE', `Revision ${revisionId} is ${target.status}, not done`);
  }
  const laterDone = chain.find((r) => r.cycleNumber > target.cycleNumber && r.status === 'done');
  if (laterDone) {
    throw new LearningError('LATER_CYCLE_DONE', `Cycle ${laterDone.cycleNumber} is already done; undo it first`);
  }
  if (undo && undo.revisionId !== target.id) {
    throw new LearningError('UNDO_MISMATCH', `Undo record is for ${undo.revisionId}, not ${revisionId}`);
  }

  const dates = new Map<string, DayString>();
  if (undo) {
    for (const shift of undo.shifts) {
      const r = chain.find((x) => x.id === shift.revisionId);
      if (!r || r.status !== 'pending') continue;
      dates.set(r.id, addDays(r.scheduledFor, diffDays(shift.from, shift.to)));
    }
  } else {
    for (const r of chain) {
      if (r.cycleNumber > target.cycleNumber && r.status === 'pending') {
        dates.set(r.id, addDays(target.scheduledFor, r.intervalDays - target.intervalDays));
      }
    }
  }

  const { revisions: moved, patches } = applyDates(chain, dates);
  const revisions = moved.map((r): T => (r.id === target.id ? { ...r, status: 'pending', completedAt: null } : r));
  patches.unshift({ id: target.id, status: 'pending', completedAt: null });

  return {
    revisions,
    patches,
    completedDay: undo?.completedDay ?? (target.completedAt ? dayOf(target.completedAt, tz) : null),
    restoredWith: undo ? 'undo-record' : 'interval-spacing',
  };
}

/**
 * Moves a pending revision to `newDay` and shifts every LATER PENDING cycle of
 * the same item by the same number of days.
 *
 * Mirrors planner.actions.ts rescheduleRevision (daysDiff between the IST days,
 * then `addDays(rev.scheduledFor, daysDiff)` for each later cycle). Two
 * deliberate differences for rows Revise should never have touched:
 *   - Revise shifted later cycles whatever their status; a later cycle that is
 *     already done keeps its scheduledFor here (it feeds lateness history).
 *   - Revise also forced `status: 'pending'`, silently un-completing a done
 *     revision while leaving its completedAt set. Here a non-pending revision
 *     throws NOT_PENDING; unmark it first.
 */
export function rescheduleRevision<T extends Revision>(
  chain: readonly T[],
  revisionId: string,
  newDay: DayString,
): RescheduleRevisionResult<T> {
  assertSingleItem(chain);
  assertDay(newDay);
  const target = findRevision(chain, revisionId);
  if (target.status !== 'pending') {
    throw new LearningError('NOT_PENDING', `Revision ${revisionId} is ${target.status}, not pending`);
  }
  const deltaDays = diffDays(newDay, target.scheduledFor);
  const dates = new Map<string, DayString>();
  if (deltaDays !== 0) {
    dates.set(target.id, newDay);
    for (const r of chain) {
      if (r.cycleNumber > target.cycleNumber && r.status === 'pending') {
        dates.set(r.id, addDays(r.scheduledFor, deltaDays));
      }
    }
  }
  return { ...applyDates(chain, dates), deltaDays };
}

// ─────────────────────────────────────────────────────────────────────────────
// Status questions
// ─────────────────────────────────────────────────────────────────────────────

/** Mastered = the item's cycle 4 is done (page.tsx: `cycleNumber >= 4, status 'done'`). */
export function isMastered(chain: readonly Revision[]): boolean {
  return chain.some((r) => r.cycleNumber >= REVISION_CYCLES && r.status === 'done');
}

/** Pending and scheduled on or before `today`. */
export function isDue(r: Revision, today: DayString): boolean {
  return r.status === 'pending' && r.scheduledFor <= today;
}

/** Pending and scheduled strictly before `today` (page.tsx: `scheduledFor < today ? 'overdue'`). */
export function isOverdue(r: Revision, today: DayString): boolean {
  return r.status === 'pending' && r.scheduledFor < today;
}

/** "N days late", never below 1 (RevisionsList.tsx `daysLate`: `Math.max(1, differenceInISTDays(now, scheduledFor))`). */
export function daysLate(scheduledFor: DayString, today: DayString): number {
  return Math.max(1, diffDays(today, scheduledFor));
}

/** How many revisions are pending and due by `today` (the count completeRevision uses for streaks). */
export function countDue(revisions: readonly Revision[], today: DayString): number {
  return revisions.reduce((n, r) => (isDue(r, today) ? n + 1 : n), 0);
}

/** Done, with completedAt on `day` in the user's zone. */
export function isCompletedOn(r: Revision, day: DayString, tz: string = DEFAULT_TIMEZONE): boolean {
  return r.status === 'done' && r.completedAt !== null && dayOf(r.completedAt, tz) === day;
}

/**
 * The earliest pending revision of every item, in schedule order (page.tsx:
 * `seenPendingIds` over revisions ordered by scheduledFor). Ties on the same
 * day go to the lower cycle.
 */
export function earliestPendingPerItem<T extends Revision>(revisions: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of [...revisions].sort(bySchedule)) {
    if (r.status !== 'pending') continue;
    const key = revisionItemKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** The topic page's revision button (useTopicRevisions.ts). */
export type NextRevisionAction<T extends Revision> =
  | { kind: 'start' }
  | { kind: 'completed' }
  | { kind: 'wait'; next: T; inDays: number }
  | { kind: 'early'; next: T }
  | { kind: 'due'; next: T };

/**
 * Mirrors useTopicRevisions.ts: no revisions → 'start' ("Start Revisions");
 * nothing pending → 'completed'; the next pending one due in 2+ days →
 * 'wait'; due tomorrow → 'early' ("Revise Early", completes it a day early);
 * due today or overdue → 'due' ("Mark as Revised").
 */
export function nextRevisionAction<T extends Revision>(chain: readonly T[], today: DayString): NextRevisionAction<T> {
  if (chain.length === 0) return { kind: 'start' };
  const next = [...chain].filter((r) => r.status === 'pending').sort(bySchedule)[0];
  if (!next) return { kind: 'completed' };
  const inDays = diffDays(next.scheduledFor, today);
  if (inDays >= 2) return { kind: 'wait', next, inDays };
  if (inDays === 1) return { kind: 'early', next };
  return { kind: 'due', next };
}

/** Topic progress counters from page.tsx (only topics count; captures do not). */
export interface RevisionProgress {
  totalTopics: number;
  topicsWithRevisions: number;
  mastered: number;
  /** max(0, topicsWithRevisions - mastered) */
  inProgress: number;
  /** max(0, totalTopics - topicsWithRevisions) */
  notStarted: number;
}

/** `chainsByTopic`: one chain per topic, empty for a topic that never started revisions. */
export function revisionProgress(chainsByTopic: ReadonlyArray<readonly Revision[]>): RevisionProgress {
  const totalTopics = chainsByTopic.length;
  const topicsWithRevisions = chainsByTopic.filter((c) => c.length > 0).length;
  const mastered = chainsByTopic.filter((c) => isMastered(c)).length;
  return {
    totalTopics,
    topicsWithRevisions,
    mastered,
    inProgress: Math.max(0, topicsWithRevisions - mastered),
    notStarted: Math.max(0, totalTopics - topicsWithRevisions),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard list
// ─────────────────────────────────────────────────────────────────────────────

export interface RevisionBuckets<T extends RevisionWithSubject> {
  /** Not done, due today, in schedule order. */
  dueToday: T[];
  /** `dueToday` grouped by subject, groups in order of first appearance ('general' when there is no subject). */
  dueTodayBySubject: Array<{ subjectId: string; revisions: T[] }>;
  /** Not done, scheduled before today ("N days late"). */
  overdue: Array<T & { daysLate: number }>;
  /** Completed today (user zone), most recently scheduled first; shown dimmed with "Unmark". */
  doneToday: T[];
  /** The badge next to "Revisions Due": dueToday + overdue. */
  totalDue: number;
}

/**
 * Builds the "Revisions Due" widget from a flat list of revisions (any mix of
 * items and statuses; anything not shown is filtered out here).
 *
 * Mirrors dashboard/page.tsx + DashboardClient.tsx:
 *   1. keep pending revisions due by today, plus done revisions completed today;
 *   2. order by scheduledFor; keep only the earliest pending revision per item
 *      (done ones are always kept);
 *   3. pending on today → dueToday (grouped by subjectId); pending before
 *      today → overdue with daysLate; done → doneToday, sorted by
 *      scheduledFor descending;
 *   4. totalDue = dueToday + overdue.
 *
 * Fixed: Revise selected these with `scheduledFor <= now` and
 * `completedAt >= todayLabel`, so between 00:00 and 05:30 IST today's
 * revisions were hidden and revisions completed in that window did not count
 * as done today. Here both sides are user-local calendar days.
 */
export function buildRevisionBuckets<T extends RevisionWithSubject>(
  revisions: readonly T[],
  today: DayString,
  tz: string = DEFAULT_TIMEZONE,
): RevisionBuckets<T> {
  assertDay(today);
  const visible = revisions
    .filter((r) => isDue(r, today) || isCompletedOn(r, today, tz))
    .sort(bySchedule);

  const seen = new Set<string>();
  const shown = visible.filter((r) => {
    if (r.status === 'done') return true;
    const key = revisionItemKey(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const dueToday = shown.filter((r) => r.status === 'pending' && r.scheduledFor >= today);
  const overdue = shown
    .filter((r) => r.status === 'pending' && r.scheduledFor < today)
    .map((r) => ({ ...r, daysLate: daysLate(r.scheduledFor, today) }));
  const doneToday = shown
    .filter((r) => r.status === 'done')
    .sort((a, b) => (a.scheduledFor < b.scheduledFor ? 1 : a.scheduledFor > b.scheduledFor ? -1 : 0));

  const groups = new Map<string, T[]>();
  for (const r of dueToday) {
    const subjectId = r.subjectId || 'general';
    const list = groups.get(subjectId);
    if (list) list.push(r);
    else groups.set(subjectId, [r]);
  }

  return {
    dueToday,
    dueTodayBySubject: [...groups.entries()].map(([subjectId, list]) => ({ subjectId, revisions: list })),
    overdue,
    doneToday,
    totalDue: dueToday.length + overdue.length,
  };
}
