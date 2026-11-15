/**
 * Goal forecast (LOOP_V2_SPEC §4): an honest, calm read of a goal with a deadline and milestones.
 * "A goal without a deadline is just a fantasy": the deadline stays fixed, the forecast says how
 * the current pace compares, and the suggestion names the smallest next step. It never scolds.
 *
 * Not to be confused with goals.ts (the weekly / monthly todo items, "This week" / "This month").
 *
 * Definitions:
 *   pacePerWeek     milestones done ÷ weeks since the goal was created (at least 1 week)
 *   projectedDay    today + remaining ÷ pace (null while the pace is 0)
 *   requiredPerWeek remaining ÷ weeks left until the deadline (at least 1 day left)
 *   behindDays      projectedDay − deadline when behind; days past the deadline when overdue
 *
 * Status, in this order:
 *   done      every milestone is done (or the goal itself was marked done)
 *   overdue   the deadline has passed
 *   no_data   no milestones yet, or nothing done and fewer than 7 days since creation
 *   behind    no pace yet, or the projection lands after the deadline
 *   ahead     the pace is at least 1.25 × the required pace
 *   on_track  otherwise
 */
import { addDays, assertDay, diffDays, type DayString } from './time';

export type GoalForecastStatus = 'on_track' | 'ahead' | 'behind' | 'no_data' | 'overdue' | 'done';

/** Nothing done and fewer than this many days since creation → no_data. */
export const GOAL_NO_DATA_DAYS = 7;
/** Pace ≥ this × the required pace → ahead. */
export const GOAL_AHEAD_RATIO = 1.25;

export interface GoalForecastInput {
  milestones: ReadonlyArray<{ done: boolean }>;
  /** The goal's creation day (user zone). */
  createdDay: DayString;
  deadline: DayString;
  today: DayString;
  /** The goal itself is marked done (status 'done'). */
  goalDone?: boolean;
}

export interface GoalForecast {
  /** Days from today to the deadline: 0 on the deadline, negative after it. */
  daysLeft: number;
  progress: { done: number; total: number };
  /** Rounded to 2 decimals. */
  pacePerWeek: number;
  projectedDay: DayString | null;
  status: GoalForecastStatus;
  /** 0 unless behind or overdue; null when behind with no pace to project from. */
  behindDays: number | null;
  /** Rounded to 2 decimals; 0 when nothing remains; null once the deadline has passed. */
  requiredPerWeek: number | null;
  /** One calm sentence with the smallest next step. */
  suggestion: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A pace as friendly words, rounded so it is enough: 0.3/week → "1 milestone every 3 weeks",
 * 1/week → "1 milestone a week", 1.2/week → "2 milestones a week". `more` adds "more".
 */
export function milestoneRateText(perWeek: number, more = false): string {
  const word = more ? 'more milestone' : 'milestone';
  if (!(perWeek > 0)) return `1 ${word} a week`;
  if (perWeek > 1 + 1e-9) {
    const n = Math.ceil(perWeek - 1e-9);
    return `${n} ${word}s a week`;
  }
  const everyWeeks = Math.max(1, Math.floor(1 / perWeek + 1e-9));
  return everyWeeks === 1 ? `1 ${word} a week` : `1 ${word} every ${everyWeeks} weeks`;
}

function suggestionFor(
  status: GoalForecastStatus,
  f: { total: number; remaining: number; daysLeft: number; requiredPerWeek: number | null; allMilestonesDone: boolean },
): string {
  const { total, remaining, daysLeft } = f;
  const required = f.requiredPerWeek ?? 0;
  const lastWeek = daysLeft < 7;
  switch (status) {
    case 'done':
      return f.allMilestonesDone ? 'All milestones done.' : 'Marked as done.';
    case 'overdue':
      return 'The deadline has passed. Pick a new date that fits.';
    case 'no_data':
      if (total === 0) return 'Add a few milestones to see a forecast.';
      if (lastWeek) return `${plural(remaining, 'milestone')} to go before the deadline.`;
      return `About ${milestoneRateText(required)} gets you there.`;
    case 'ahead':
      // The status already says "ahead": the suggestion is only the next step (it never repeats it).
      if (lastWeek) return `${plural(remaining, 'more milestone')} by the deadline keeps you on track.`;
      return `${milestoneRateText(required, true)} keeps you on track.`;
    case 'on_track':
    case 'behind':
    default:
      if (lastWeek) return `${plural(remaining, 'more milestone')} by the deadline keeps you on track.`;
      return `${milestoneRateText(required, true)} keeps you on track.`;
  }
}

export function goalForecast(input: GoalForecastInput): GoalForecast {
  const { today, deadline, createdDay } = input;
  assertDay(today);
  assertDay(deadline);
  assertDay(createdDay);

  const total = input.milestones.length;
  const done = input.milestones.filter((m) => m.done).length;
  const remaining = total - done;
  const daysLeft = diffDays(deadline, today);
  const elapsedDays = Math.max(0, diffDays(today, createdDay));
  const weeks = Math.max(1, elapsedDays / 7);
  const pace = done / weeks;
  const projectedDay = remaining === 0 ? today : pace > 0 ? addDays(today, Math.ceil((remaining / pace) * 7)) : null;
  const required = remaining === 0 ? 0 : daysLeft < 0 ? null : remaining / (Math.max(daysLeft, 1) / 7);
  const allMilestonesDone = total > 0 && remaining === 0;

  let status: GoalForecastStatus;
  if (input.goalDone || allMilestonesDone) status = 'done';
  else if (daysLeft < 0) status = 'overdue';
  else if (total === 0 || (done === 0 && elapsedDays < GOAL_NO_DATA_DAYS)) status = 'no_data';
  else if (projectedDay === null || projectedDay > deadline) status = 'behind';
  else if (required !== null && pace >= required * GOAL_AHEAD_RATIO) status = 'ahead';
  else status = 'on_track';

  const behindDays =
    status === 'behind' ? (projectedDay === null ? null : diffDays(projectedDay, deadline)) : status === 'overdue' ? -daysLeft : 0;

  return {
    daysLeft,
    progress: { done, total },
    pacePerWeek: round2(pace),
    projectedDay,
    status,
    behindDays,
    requiredPerWeek: required === null ? null : round2(required),
    suggestion: suggestionFor(status, { total, remaining, daysLeft, requiredPerWeek: required, allMilestonesDone }),
  };
}
