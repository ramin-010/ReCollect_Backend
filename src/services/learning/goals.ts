/**
 * Weekly / monthly goal due-date rules (TASK captures with a goalType in
 * Revise; Recollect todos later).
 *
 * Sources (revise/src/):
 *   - lib/date.ts                       getWeeklyGoalDueDate ("Weekend Rule"), getISTEndOfMonthLabel,
 *                                       getISTStartOfWeek
 *   - app/actions/capture.actions.ts    createCapture (due date for a new goal),
 *                                       getUnresolvedWeeklyGoals, shiftWeeklyGoal
 *   - components/dashboard/WeeklyReviewModal.tsx  only checks on Mondays
 *
 * Due dates are calendar days in the user's zone. Revise stored the last
 * millisecond of that day (`getISTEndOfDayLabel`); if the todo model needs an
 * instant, store `endOfDay(dueDay, tz)`.
 */
import { addDays, endOfMonth, startOfWeek, type DayString, weekday } from './time';
import type { GoalType } from './types';

/**
 * The "Weekend Rule": a weekly goal is due on the coming Sunday, but one
 * created on Saturday or Sunday rolls to the Sunday of the following week so
 * it is not due immediately.
 */
export function weeklyGoalDueDay(today: DayString): DayString {
  const dow = weekday(today); // 0 = Mon .. 6 = Sun
  let daysUntilSunday = 6 - dow;
  if (dow >= 5) daysUntilSunday += 7;
  return addDays(today, daysUntilSunday);
}

/** A monthly goal is due on the last day of the current month. */
export function monthlyGoalDueDay(today: DayString): DayString {
  return endOfMonth(today);
}

/**
 * Due day for a new TASK with a goal type and no explicit date (createCapture);
 * null for 'NONE'. An explicit date always wins, as in Revise.
 */
export function initialGoalDueDay(goalType: GoalType, today: DayString, explicitDueDay: DayString | null = null): DayString | null {
  if (explicitDueDay !== null) return explicitDueDay;
  if (goalType === 'MONTHLY') return monthlyGoalDueDay(today);
  if (goalType === 'WEEKLY') return weeklyGoalDueDay(today);
  return null;
}

/** getUnresolvedWeeklyGoals: a WEEKLY goal, not done, due before this week's Monday. */
export function isUnresolvedWeeklyGoal(
  goal: { goalType: GoalType; isDone: boolean; dueDay: DayString | null },
  today: DayString,
): boolean {
  return goal.goalType === 'WEEKLY' && !goal.isDone && goal.dueDay !== null && goal.dueDay < startOfWeek(today);
}

/**
 * The weekly review only runs on Mondays. Revise checked the browser's
 * `getDay() === 1`; this uses the user's day.
 */
export function isWeeklyReviewDay(today: DayString): boolean {
  return weekday(today) === 0;
}

/** shiftWeeklyGoal: "Shift to This Week" (new weekly due day) or "Make it Monthly". */
export function shiftWeeklyGoal(
  target: 'THIS_WEEK' | 'MONTHLY',
  today: DayString,
): { goalType: 'WEEKLY' | 'MONTHLY'; dueDay: DayString } {
  return target === 'MONTHLY'
    ? { goalType: 'MONTHLY', dueDay: monthlyGoalDueDay(today) }
    : { goalType: 'WEEKLY', dueDay: weeklyGoalDueDay(today) };
}
