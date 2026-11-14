import { describe, expect, it } from 'vitest';
import {
  endOfDay,
  initialGoalDueDay,
  isUnresolvedWeeklyGoal,
  isWeeklyReviewDay,
  monthlyGoalDueDay,
  shiftWeeklyGoal,
  today,
  weeklyGoalDueDay,
} from '../../../src/services/learning';
import { IST, NY } from './_fixtures';

// Sources: revise/src/lib/date.ts (getWeeklyGoalDueDate, getISTEndOfMonthLabel, getISTStartOfWeek),
//          revise/src/app/actions/capture.actions.ts (createCapture, getUnresolvedWeeklyGoals, shiftWeeklyGoal),
//          revise/src/components/dashboard/WeeklyReviewModal.tsx (Mondays only).
// 2026-10-19 is a Monday.

describe('weekly goals: the "Weekend Rule"', () => {
  it('Mon-Fri → the coming Sunday', () => {
    expect(weeklyGoalDueDay('2026-10-19')).toBe('2026-10-25');
    expect(weeklyGoalDueDay('2026-10-21')).toBe('2026-10-25');
    expect(weeklyGoalDueDay('2026-10-23')).toBe('2026-10-25');
  });

  it('Sat/Sun → the Sunday of the following week', () => {
    expect(weeklyGoalDueDay('2026-10-24')).toBe('2026-11-01');
    expect(weeklyGoalDueDay('2026-10-25')).toBe('2026-11-01');
  });

  it("uses the user's day, not the server's", () => {
    const instant = new Date('2026-10-23T20:00:00Z'); // Sat 01:30 in IST, Fri 16:00 in New York
    expect(weeklyGoalDueDay(today(IST, instant))).toBe('2026-11-01');
    expect(weeklyGoalDueDay(today(NY, instant))).toBe('2026-10-25');
  });

  it('as an instant: the last millisecond of that Sunday in the user zone', () => {
    // Revise stored the label 2026-10-25T23:59:59.999Z, i.e. 05:29 IST on the Monday.
    expect(endOfDay(weeklyGoalDueDay('2026-10-21'), IST).toISOString()).toBe('2026-10-25T18:29:59.999Z');
  });
});

describe('monthly goals and new goal tasks', () => {
  it('monthly → last day of the month', () => {
    expect(monthlyGoalDueDay('2026-10-21')).toBe('2026-10-31');
    expect(monthlyGoalDueDay('2026-02-03')).toBe('2026-02-28');
    expect(monthlyGoalDueDay('2028-02-03')).toBe('2028-02-29');
  });

  it('a new goal task gets its due day from its type unless a date was given', () => {
    expect(initialGoalDueDay('WEEKLY', '2026-10-21')).toBe('2026-10-25');
    expect(initialGoalDueDay('MONTHLY', '2026-10-21')).toBe('2026-10-31');
    expect(initialGoalDueDay('NONE', '2026-10-21')).toBeNull();
    expect(initialGoalDueDay('WEEKLY', '2026-10-21', '2026-10-22')).toBe('2026-10-22');
  });
});

describe('weekly review (Mondays)', () => {
  it('an unresolved weekly goal: WEEKLY, not done, due before this Monday', () => {
    const monday = '2026-10-26';
    expect(isUnresolvedWeeklyGoal({ goalType: 'WEEKLY', isDone: false, dueDay: '2026-10-25' }, monday)).toBe(true);
    expect(isUnresolvedWeeklyGoal({ goalType: 'WEEKLY', isDone: false, dueDay: '2026-11-01' }, monday)).toBe(false);
    expect(isUnresolvedWeeklyGoal({ goalType: 'WEEKLY', isDone: true, dueDay: '2026-10-25' }, monday)).toBe(false);
    expect(isUnresolvedWeeklyGoal({ goalType: 'MONTHLY', isDone: false, dueDay: '2026-10-25' }, monday)).toBe(false);
    expect(isUnresolvedWeeklyGoal({ goalType: 'WEEKLY', isDone: false, dueDay: null }, monday)).toBe(false);
    // later in the same week the Monday is still the cut-off
    expect(isUnresolvedWeeklyGoal({ goalType: 'WEEKLY', isDone: false, dueDay: '2026-10-25' }, '2026-10-29')).toBe(true);
  });

  it("runs on the user's Monday", () => {
    expect(isWeeklyReviewDay('2026-10-19')).toBe(true);
    expect(isWeeklyReviewDay('2026-10-20')).toBe(false);
    const instant = new Date('2026-10-19T20:00:00Z'); // Tue 01:30 IST, Mon 16:00 EDT
    expect(isWeeklyReviewDay(today(IST, instant))).toBe(false);
    expect(isWeeklyReviewDay(today(NY, instant))).toBe(true);
  });

  it('"Shift to This Week" / "Make it Monthly"', () => {
    expect(shiftWeeklyGoal('THIS_WEEK', '2026-10-26')).toEqual({ goalType: 'WEEKLY', dueDay: '2026-11-01' });
    expect(shiftWeeklyGoal('MONTHLY', '2026-10-26')).toEqual({ goalType: 'MONTHLY', dueDay: '2026-10-31' });
  });
});
