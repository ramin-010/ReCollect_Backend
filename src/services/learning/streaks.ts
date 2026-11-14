/**
 * Revision streaks: the global streak (User.globalStreak), per-subject streaks
 * (SubjectStreak) and per-subject daily history (DailyHistory).
 *
 * Ported from revise/src/app/actions/revision.actions.ts completeRevision,
 * steps 4 (DailyHistory + SubjectStreak) and 5 (global streak), with the
 * "streak never drops" bug fixed and an exact same-day undo added.
 *
 * THE RULE
 * ────────
 * 1. A day is CREDITED when the user completes a revision and, right after
 *    that completion, nothing is left due: no pending revision scheduled on
 *    or before that day. Credit is only ever evaluated at a completion, as in
 *    Revise.
 *      - Global streak: counts all of the user's revisions.
 *      - Subject streak: counts only that subject's revisions (topics and
 *        captures); evaluated only when the completed revision has a subject.
 * 2. Crediting day D: if D (or a later day) is already credited, nothing
 *    changes; if the last credited day is D - 1, current + 1; otherwise
 *    current = 1. longest = max(longest, current).
 * 3. A streak is ALIVE on day T when its last credited day is T or T - 1 (it
 *    can still be extended today). Otherwise at least one whole day passed
 *    without credit, the streak is BROKEN and its current value is 0.
 * 4. REST DAYS ARE NEUTRAL (changed from Revise, which broke the streak on
 *    them). When a day D ends, the per-user rollover calls
 *    `rollOverStreakDay(state, D, openDueAt(revisions, D, tz))`:
 *      - D already credited → nothing changes;
 *      - D ended with nothing open (nothing was due, or everything due was
 *        done) and the streak was alive on D → D is BRIDGED: lastCreditDay
 *        moves to D, but `current` does not grow;
 *      - D ended with something due still open → the streak breaks (0).
 *    So a day with nothing due and nothing done neither breaks nor adds; a
 *    missed day breaks the streak at its midnight.
 *
 * THE FIX
 * ───────
 * Revise stored `current` and only rewrote it at the next credit, so after
 * missed days the dashboard kept showing the old number, and only the next
 * cleared day reset it to 1. Display `effectiveStreak(state, today)`; the
 * rollover (rule 4, plus `settleStreak` for anything older than its window)
 * writes the 0 back so the stored number is honest too. Neither changes
 * `longest`.
 *
 * UNDO
 * ────
 * Crediting keeps a snapshot of the values it replaced (`beforeLastCredit`).
 * When a completion made today is undone, today's credit is taken back
 * (restored from that snapshot) unless it is still earned: at least one
 * revision is still completed today and nothing is pending due. Undoing a
 * completion from an earlier day restores the revision but does not rewrite
 * that day's streak or history.
 */
import { addDays, assertDay, DEFAULT_TIMEZONE, diffDays, startOfDay, type DayString } from './time';
import type { DailyHistoryEntry, Revision, StreakSnapshot, StreakState } from './types';

/** A streak that was never credited (Revise defaults: 0, 0, null / epoch). */
export const EMPTY_STREAK: Readonly<StreakState> = Object.freeze({
  current: 0,
  longest: 0,
  lastCreditDay: null,
  beforeLastCredit: null,
});

const snapshotOf = (s: StreakSnapshot): StreakSnapshot => ({
  current: s.current,
  longest: s.longest,
  lastCreditDay: s.lastCreditDay,
});

/**
 * Credits `today` (rule 2). Mirrors both Revise branches: the global one
 * (`diffDays === 1 ? +1 : diffDays > 1 ? 1`, first ever credit = 1) and the
 * subject one (`isConsecutive ? current + 1 : 1` when lastCalculated < today).
 *
 * Unified edge case: when the last credit is AFTER today (the user moved to a
 * zone that is behind), nothing changes; Revise's global branch kept the
 * number but moved the credit day back.
 */
export function creditDay(state: StreakState, today: DayString): StreakState {
  assertDay(today);
  if (state.lastCreditDay !== null && state.lastCreditDay >= today) return state;
  const consecutive = state.lastCreditDay !== null && state.lastCreditDay === addDays(today, -1);
  const current = consecutive ? state.current + 1 : 1;
  return {
    current,
    longest: Math.max(state.longest, current),
    lastCreditDay: today,
    beforeLastCredit: snapshotOf(state),
  };
}

/** Rule 1: credit only when nothing is left due after the completion. */
export function applyCompletionToStreak(state: StreakState, today: DayString, pendingDueAfter: number): StreakState {
  return pendingDueAfter === 0 ? creditDay(state, today) : state;
}

/** Rule 3: is the streak still alive on `today`? */
export function isStreakAlive(state: StreakSnapshot, today: DayString): boolean {
  if (state.lastCreditDay === null || state.current === 0) return false;
  return diffDays(today, state.lastCreditDay) <= 1;
}

/** THE FIX, for display: the stored streak if alive on `today`, else 0. */
export function effectiveStreak(state: StreakSnapshot, today: DayString): number {
  return isStreakAlive(state, today) ? state.current : 0;
}

/**
 * THE FIX, for storage: zero the current value of a broken streak. Keeps
 * `longest` and `lastCreditDay`, so the next credit starts again at 1.
 * Idempotent; safe to run every night.
 */
export function settleStreak(state: StreakState, today: DayString): StreakState {
  if (state.current === 0 || isStreakAlive(state, today)) return state;
  return { ...state, current: 0, beforeLastCredit: null };
}

/**
 * Rule 4, the end of day `endedDay` (run by the rollover for every day that
 * ended since the last run, oldest first; `openDueAtEnd` = `openDueAt(...)`):
 *   - current 0, or `endedDay` already credited/bridged → unchanged;
 *   - the streak was not alive on `endedDay` (last credit before D - 1) → 0;
 *   - nothing open at the end of the day → bridged (lastCreditDay = D, the
 *     undo snapshot is dropped: a bridge is not a credit);
 *   - otherwise → 0 (something due was left open).
 * `longest` never changes. Idempotent: running a day twice changes nothing.
 */
export function rollOverStreakDay(state: StreakState, endedDay: DayString, openDueAtEnd: number): StreakState {
  assertDay(endedDay);
  if (state.current === 0) return state;
  if (state.lastCreditDay !== null && state.lastCreditDay >= endedDay) return state;
  if (state.lastCreditDay !== addDays(endedDay, -1)) return { ...state, current: 0, beforeLastCredit: null };
  if (openDueAtEnd === 0) return { ...state, lastCreditDay: endedDay, beforeLastCredit: null };
  return { ...state, current: 0, beforeLastCredit: null };
}

/** The rollover looks back at most this many ended days; anything older just settles. */
export const STREAK_ROLLOVER_MAX_DAYS = 30;

/**
 * The ended days a rollover on `today` must settle: from `from` (inclusive) to
 * yesterday, capped to the last STREAK_ROLLOVER_MAX_DAYS days. Empty when
 * `from` is today or later.
 */
export function streakRolloverDays(from: DayString, today: DayString): DayString[] {
  assertDay(from);
  const cap = addDays(today, -STREAK_ROLLOVER_MAX_DAYS);
  const days: DayString[] = [];
  for (let d = from < cap ? cap : from; d < today; d = addDays(d, 1)) days.push(d);
  return days;
}

/**
 * Runs `rollOverStreakDay` for each ended day in order, then `settleStreak`
 * on `today` (which only matters when days older than the window were
 * skipped). `openDueAtEndOf(day)` is usually `openDueAt(revisions, day, tz)`.
 */
export function rollOverStreak(
  state: StreakState,
  endedDays: readonly DayString[],
  openDueAtEndOf: (day: DayString) => number,
  today: DayString,
): StreakState {
  let next = state;
  for (const day of endedDays) next = rollOverStreakDay(next, day, openDueAtEndOf(day));
  return settleStreak(next, today);
}

/**
 * How many revisions were still open when `day` ended in `tz`: scheduled on or
 * before `day` and either still pending, or completed only after the day
 * (completedAt >= start of the next day). Pass one subject's revisions for a
 * subject streak. Revisions rescheduled past `day` no longer count for it.
 */
export function openDueAt(
  revisions: ReadonlyArray<Pick<Revision, 'scheduledFor' | 'status' | 'completedAt'>>,
  day: DayString,
  tz: string = DEFAULT_TIMEZONE,
): number {
  const nextDayStart = startOfDay(addDays(day, 1), tz).getTime();
  let n = 0;
  for (const r of revisions) {
    if (r.scheduledFor > day) continue;
    if (r.status === 'pending') n++;
    else if (r.status === 'done' && r.completedAt !== null && r.completedAt.getTime() >= nextDayStart) n++;
  }
  return n;
}

/**
 * Undo support: takes back today's credit when it is no longer earned, i.e.
 * no revision is still completed today, or something is pending due again.
 * Only a credit given today can be taken back, and only when the snapshot is
 * there (states written before this field existed keep their credit).
 */
export function revokeCreditIfUnearned(
  state: StreakState,
  today: DayString,
  facts: { completedToday: number; pendingDue: number },
): StreakState {
  if (state.lastCreditDay !== today || state.beforeLastCredit === null) return state;
  if (facts.completedToday > 0 && facts.pendingDue === 0) return state;
  return { ...snapshotOf(state.beforeLastCredit), beforeLastCredit: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// DailyHistory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors completeRevision step 4: the first completion of the day creates the
 * row with `revisionsDue: pendingDue + 1` ("we know at least one was due"),
 * `revisionsDone: 1`; later ones add 1 to revisionsDone. Both set
 * `streakMaintained = pendingDue === 0`.
 */
export function recordCompletionInHistory(
  entry: DailyHistoryEntry | null,
  subjectId: string,
  today: DayString,
  pendingDueAfter: number,
): DailyHistoryEntry {
  if (!entry || entry.day !== today) {
    return {
      subjectId,
      day: today,
      revisionsDue: pendingDueAfter + 1,
      revisionsDone: 1,
      streakMaintained: pendingDueAfter === 0,
    };
  }
  return { ...entry, revisionsDone: entry.revisionsDone + 1, streakMaintained: pendingDueAfter === 0 };
}

/**
 * Inverse of `recordCompletionInHistory` for an undo: one completion fewer,
 * streakMaintained re-evaluated. Returns null (delete the row) when no
 * completion is left, since the row only existed because of completions.
 */
export function revertCompletionInHistory(entry: DailyHistoryEntry, pendingDueAfter: number): DailyHistoryEntry | null {
  const revisionsDone = Math.max(0, entry.revisionsDone - 1);
  if (revisionsDone === 0) return null;
  return { ...entry, revisionsDone, streakMaintained: pendingDueAfter === 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// One-call orchestration for the service layer
// ─────────────────────────────────────────────────────────────────────────────

export interface SubjectStreakInput {
  subjectId: string;
  /** null when the SubjectStreak row does not exist yet. */
  streak: StreakState | null;
  /** Today's DailyHistory row for this subject, if any. */
  history: DailyHistoryEntry | null;
  /** Pending revisions of this subject due by today, counted AFTER the change. */
  pendingDue: number;
}

export interface CompletionStreakInput {
  /** `completeRevision(...).completedDay` */
  today: DayString;
  global: StreakState;
  /** Pending revisions of the user due by today, counted AFTER the completion. */
  pendingDueGlobal: number;
  /** Omit when the revision has no subject (Revise skips step 4 then). */
  subject?: SubjectStreakInput;
}

export interface StreakEffects {
  global: StreakState;
  /** Present when a subject was given. `streak: null` = still no row; `history: null` = delete/no row. */
  subject?: { subjectId: string; streak: StreakState | null; history: DailyHistoryEntry | null };
}

/**
 * Streak side effects of a completion (completeRevision steps 4-5). The
 * subject streak row is only created when it is credited, as Revise's upsert
 * only ran when the subject had nothing left due.
 */
export function streakEffectsOfCompletion(input: CompletionStreakInput): StreakEffects {
  const { today } = input;
  const global = applyCompletionToStreak(input.global, today, input.pendingDueGlobal);
  if (!input.subject) return { global };
  const s = input.subject;
  return {
    global,
    subject: {
      subjectId: s.subjectId,
      history: recordCompletionInHistory(s.history, s.subjectId, today, s.pendingDue),
      streak: s.pendingDue === 0 ? creditDay(s.streak ?? EMPTY_STREAK, today) : s.streak,
    },
  };
}

export interface UncompletionStreakInput {
  /** The user's current day. */
  today: DayString;
  /** `uncompleteRevision(...).completedDay`: the day the undone completion counted for. */
  completedDay: DayString | null;
  global: StreakState;
  /** Pending revisions of the user due by today, counted AFTER the undo. */
  pendingDueGlobal: number;
  /** Revisions of the user still completed today, AFTER the undo. */
  completedTodayGlobal: number;
  subject?: SubjectStreakInput & { completedToday: number };
}

/**
 * Streak side effects of an undo (see UNDO in the header). Nothing changes
 * unless the undone completion counted for today.
 */
export function streakEffectsOfUncompletion(input: UncompletionStreakInput): StreakEffects {
  const { today } = input;
  const countsToday = input.completedDay === today;
  const global = countsToday
    ? revokeCreditIfUnearned(input.global, today, {
        completedToday: input.completedTodayGlobal,
        pendingDue: input.pendingDueGlobal,
      })
    : input.global;
  if (!input.subject) return { global };
  const s = input.subject;
  if (!countsToday) {
    return { global, subject: { subjectId: s.subjectId, streak: s.streak, history: s.history } };
  }
  return {
    global,
    subject: {
      subjectId: s.subjectId,
      history: s.history && s.history.day === today ? revertCompletionInHistory(s.history, s.pendingDue) : s.history,
      streak: s.streak
        ? revokeCreditIfUnearned(s.streak, today, { completedToday: s.completedToday, pendingDue: s.pendingDue })
        : null,
    },
  };
}
