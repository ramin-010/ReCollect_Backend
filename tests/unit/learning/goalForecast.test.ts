import { describe, expect, it } from 'vitest';
import { addDays, goalForecast, milestoneRateText, type GoalForecastInput } from '../../../src/services/learning';

// LOOP_V2_SPEC §4: goalForecast({ milestones, createdDay, deadline, today }).
const TODAY = '2026-11-14';
const ms = (done: number, total: number) => Array.from({ length: total }, (_, i) => ({ done: i < done }));
const input = (over: Partial<GoalForecastInput> & { done?: number; total?: number; createdAgo?: number; daysLeft?: number }): GoalForecastInput => ({
  milestones: over.milestones ?? ms(over.done ?? 0, over.total ?? 6),
  createdDay: over.createdDay ?? addDays(TODAY, -(over.createdAgo ?? 28)),
  deadline: over.deadline ?? addDays(TODAY, over.daysLeft ?? 60),
  today: TODAY,
  ...(over.goalDone !== undefined ? { goalDone: over.goalDone } : {}),
});

describe('goalForecast: numbers', () => {
  it('pace = done ÷ weeks since creation, projectedDay = today + remaining ÷ pace, required = remaining ÷ weeks left', () => {
    const f = goalForecast(input({ done: 2, total: 6, createdAgo: 28, daysLeft: 60 }));
    expect(f.daysLeft).toBe(60);
    expect(f.progress).toEqual({ done: 2, total: 6 });
    expect(f.pacePerWeek).toBe(0.5); // 2 in 4 weeks
    expect(f.projectedDay).toBe(addDays(TODAY, 56)); // 4 left at 0.5 a week = 8 weeks
    expect(f.requiredPerWeek).toBe(0.47); // 4 in 60/7 weeks
    expect(f.behindDays).toBe(0);
  });

  it('the pace uses at least 1 week (a goal made today with 2 done is 2 a week, not infinite)', () => {
    const f = goalForecast(input({ done: 2, total: 6, createdAgo: 0 }));
    expect(f.pacePerWeek).toBe(2);
    expect(f.projectedDay).toBe(addDays(TODAY, 14));
  });

  it('daysLeft is 0 on the deadline and negative after it', () => {
    expect(goalForecast(input({ done: 1, total: 3, daysLeft: 0 })).daysLeft).toBe(0);
    expect(goalForecast(input({ done: 1, total: 3, daysLeft: -4 })).daysLeft).toBe(-4);
  });
});

describe('goalForecast: status', () => {
  it('done: every milestone done (even past the deadline), or the goal marked done', () => {
    const all = goalForecast(input({ done: 3, total: 3, daysLeft: -2 }));
    expect([all.status, all.requiredPerWeek, all.behindDays, all.projectedDay, all.suggestion]).toEqual(['done', 0, 0, TODAY, 'All milestones done.']);
    const marked = goalForecast(input({ done: 1, total: 3, goalDone: true }));
    expect([marked.status, marked.suggestion]).toEqual(['done', 'Marked as done.']);
  });

  it('overdue: the deadline passed with milestones left; behindDays = days past it', () => {
    const f = goalForecast(input({ done: 1, total: 3, daysLeft: -5 }));
    expect([f.status, f.behindDays, f.requiredPerWeek]).toEqual(['overdue', 5, null]);
    expect(f.suggestion).toBe('The deadline has passed. Pick a new date that fits.');
  });

  it('no_data: no milestones, or nothing done in the first 7 days', () => {
    const none = goalForecast(input({ total: 0 }));
    expect([none.status, none.suggestion]).toEqual(['no_data', 'Add a few milestones to see a forecast.']);
    const fresh = goalForecast(input({ done: 0, total: 4, createdAgo: 6, daysLeft: 56 }));
    expect([fresh.status, fresh.projectedDay, fresh.behindDays]).toEqual(['no_data', null, 0]);
    expect(fresh.suggestion).toBe('About 1 milestone every 2 weeks gets you there.');
  });

  it('behind with no pace yet after 7 days: no projection, behindDays null', () => {
    const f = goalForecast(input({ done: 0, total: 4, createdAgo: 7, daysLeft: 28 }));
    expect([f.status, f.projectedDay, f.behindDays, f.requiredPerWeek]).toEqual(['behind', null, null, 1]);
    expect(f.suggestion).toBe('1 more milestone a week keeps you on track.');
  });

  it('behind: the projection lands after the deadline; behindDays = projectedDay − deadline', () => {
    const f = goalForecast(input({ done: 1, total: 6, createdAgo: 28, daysLeft: 70 }));
    expect(f.pacePerWeek).toBe(0.25);
    expect(f.projectedDay).toBe(addDays(TODAY, 140));
    expect([f.status, f.behindDays, f.requiredPerWeek]).toEqual(['behind', 70, 0.5]);
    expect(f.suggestion).toBe('1 more milestone every 2 weeks keeps you on track.');
  });

  it('on_track: the projection makes the deadline, pace below 1.25 × required', () => {
    const f = goalForecast(input({ done: 2, total: 6, createdAgo: 28, daysLeft: 60 }));
    expect(f.status).toBe('on_track');
    expect(f.suggestion).toBe('1 more milestone every 2 weeks keeps you on track.');
  });

  it('ahead: pace at least 1.25 × the required pace', () => {
    const f = goalForecast(input({ done: 4, total: 6, createdAgo: 14, daysLeft: 70 }));
    expect([f.status, f.pacePerWeek, f.requiredPerWeek]).toEqual(['ahead', 2, 0.2]);
    expect(f.suggestion).toBe('Ahead of plan. 1 more milestone every 5 weeks keeps you on track.');
  });

  it('the last week talks about the deadline, not a weekly rate', () => {
    const f = goalForecast(input({ done: 4, total: 6, createdAgo: 56, daysLeft: 3 }));
    expect([f.status, f.behindDays]).toEqual(['behind', 25]); // 2 left at 0.5 a week = 28 days
    expect(f.suggestion).toBe('2 more milestones by the deadline keeps you on track.');
    const fresh = goalForecast(input({ done: 0, total: 1, createdAgo: 1, daysLeft: 2 }));
    expect([fresh.status, fresh.suggestion]).toEqual(['no_data', '1 milestone to go before the deadline.']);
  });

  it('the spec example: 6 milestones, 2 done, deadline 2027-06-30', () => {
    const f = goalForecast({ milestones: ms(2, 6), createdDay: '2026-10-03', deadline: '2027-06-30', today: TODAY });
    expect(f.daysLeft).toBe(228);
    expect(f.progress).toEqual({ done: 2, total: 6 });
    expect(f.status).toBe('ahead');
  });
});

describe('goalForecast: the suggestion never scolds', () => {
  it('no exclamation marks, no guilt words, one calm sentence, for every status and shape', () => {
    const seen = new Set<string>();
    for (const total of [0, 1, 3, 6, 12]) {
      for (let done = 0; done <= total; done += Math.max(1, Math.floor(total / 3))) {
        for (const createdAgo of [0, 3, 7, 30, 120]) {
          for (const daysLeft of [-30, -1, 0, 3, 10, 60, 70, 365]) {
            const f = goalForecast(input({ done, total, createdAgo, daysLeft }));
            seen.add(f.status);
            expect(f.suggestion).not.toMatch(/!|miss|fail|lazy|should have|behind|late|again|only\b|still not/i);
            expect(f.suggestion).toMatch(/^[A-Z0-9].*\.$/);
            expect(f.suggestion.length).toBeLessThanOrEqual(90);
          }
        }
      }
    }
    expect([...seen].sort()).toEqual(['ahead', 'behind', 'done', 'no_data', 'on_track', 'overdue']);
  });
});

describe('milestoneRateText', () => {
  it('rounds to a pace that is enough', () => {
    expect(milestoneRateText(1)).toBe('1 milestone a week');
    expect(milestoneRateText(0.5)).toBe('1 milestone every 2 weeks');
    expect(milestoneRateText(0.3)).toBe('1 milestone every 3 weeks');
    expect(milestoneRateText(0.12)).toBe('1 milestone every 8 weeks');
    expect(milestoneRateText(1.2)).toBe('2 milestones a week');
    expect(milestoneRateText(2, true)).toBe('2 more milestones a week');
    expect(milestoneRateText(0.9, true)).toBe('1 more milestone a week');
  });
});
