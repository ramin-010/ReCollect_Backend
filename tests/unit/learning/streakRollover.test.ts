// The rest-day-neutral rollover (LEARNING_SPEC §1 engine follow-up 1, STATE decision 2).
import { describe, expect, it } from 'vitest';
import {
  creditDay,
  effectiveStreak,
  openDueAt,
  rollOverStreak,
  rollOverStreakDay,
  STREAK_ROLLOVER_MAX_DAYS,
  streakRolloverDays,
  type StreakState,
} from '../../../src/services/learning';
import { IST, NY, ist } from './_fixtures';

const streak = (current: number, longest: number, lastCreditDay: string | null, before: StreakState['beforeLastCredit'] = null): StreakState => ({
  current,
  longest,
  lastCreditDay,
  beforeLastCredit: before,
});

describe('rollOverStreakDay', () => {
  it('a zero streak and an already credited day are unchanged', () => {
    const zero = streak(0, 9, '2026-10-01');
    expect(rollOverStreakDay(zero, '2026-10-20', 3)).toBe(zero);
    const credited = streak(4, 9, '2026-10-20', { current: 3, longest: 9, lastCreditDay: '2026-10-19' });
    expect(rollOverStreakDay(credited, '2026-10-20', 0)).toBe(credited);
    expect(rollOverStreakDay(credited, '2026-10-19', 5)).toBe(credited); // a later credit wins
  });

  it('a rest day (nothing open at its end) is bridged: neither breaks nor adds', () => {
    const s = streak(4, 9, '2026-10-19', { current: 3, longest: 9, lastCreditDay: '2026-10-18' });
    expect(rollOverStreakDay(s, '2026-10-20', 0)).toEqual(streak(4, 9, '2026-10-20'));
  });

  it('a day that ends with something due still open breaks the streak (longest kept)', () => {
    expect(rollOverStreakDay(streak(4, 9, '2026-10-19'), '2026-10-20', 2)).toEqual(streak(0, 9, '2026-10-19'));
  });

  it('a streak already dead on that day goes to 0 whatever was due', () => {
    expect(rollOverStreakDay(streak(4, 9, '2026-10-17'), '2026-10-20', 0)).toEqual(streak(0, 9, '2026-10-17'));
  });

  it('is idempotent', () => {
    const once = rollOverStreakDay(streak(4, 9, '2026-10-19'), '2026-10-20', 0);
    expect(rollOverStreakDay(once, '2026-10-20', 0)).toBe(once);
    const broken = rollOverStreakDay(streak(4, 9, '2026-10-19'), '2026-10-20', 1);
    expect(rollOverStreakDay(broken, '2026-10-20', 1)).toBe(broken);
  });

  it('after a bridge, the next credited day continues the streak (+1, not reset)', () => {
    const bridged = rollOverStreakDay(streak(4, 9, '2026-10-19'), '2026-10-20', 0);
    expect(creditDay(bridged, '2026-10-21')).toMatchObject({ current: 5, lastCreditDay: '2026-10-21' });
    expect(effectiveStreak(bridged, '2026-10-21')).toBe(4);
  });
});

describe('openDueAt', () => {
  const rev = (scheduledFor: string, status: 'pending' | 'done', completedAt: Date | null = null) => ({ scheduledFor, status, completedAt });

  it('counts revisions due by the day that were still open when it ended (user zone)', () => {
    const revisions = [
      rev('2026-10-19', 'pending'), // overdue, open
      rev('2026-10-20', 'done', ist('2026-10-20', '22:00')), // done that day
      rev('2026-10-20', 'done', ist('2026-10-21', '00:10')), // done only after midnight IST: open at the end
      rev('2026-10-21', 'pending'), // not due yet
    ];
    expect(openDueAt(revisions, '2026-10-20', IST)).toBe(2);
    expect(openDueAt(revisions, '2026-10-18', IST)).toBe(0);
  });

  it('uses the user zone for "after the day": 23:30 in New York is still that day there', () => {
    const lateNy = new Date('2026-10-21T03:30:00Z'); // 23:30 EDT on 10-20, 09:00 IST on 10-21
    expect(openDueAt([rev('2026-10-20', 'done', lateNy)], '2026-10-20', NY)).toBe(0);
    expect(openDueAt([rev('2026-10-20', 'done', lateNy)], '2026-10-20', IST)).toBe(1);
  });
});

describe('streakRolloverDays + rollOverStreak', () => {
  it('lists the ended days from `from` to yesterday, capped to the window', () => {
    expect(streakRolloverDays('2026-10-18', '2026-10-21')).toEqual(['2026-10-18', '2026-10-19', '2026-10-20']);
    expect(streakRolloverDays('2026-10-21', '2026-10-21')).toEqual([]);
    const capped = streakRolloverDays('2026-01-01', '2026-10-21');
    expect(capped).toHaveLength(STREAK_ROLLOVER_MAX_DAYS);
    expect(capped[0]).toBe('2026-09-21');
  });

  it('3 rest days in a row keep the streak; a missed day after them breaks it', () => {
    const s = streak(6, 6, '2026-10-17');
    const rest = rollOverStreak(s, ['2026-10-18', '2026-10-19', '2026-10-20'], () => 0, '2026-10-21');
    expect(rest).toEqual(streak(6, 6, '2026-10-20'));
    const missed = rollOverStreak(s, ['2026-10-18', '2026-10-19', '2026-10-20'], (d) => (d === '2026-10-19' ? 1 : 0), '2026-10-21');
    expect(missed).toEqual(streak(0, 6, '2026-10-18'));
  });

  it('days older than the window just settle', () => {
    const s = streak(6, 6, '2026-08-01');
    expect(rollOverStreak(s, streakRolloverDays('2026-08-02', '2026-10-21'), () => 0, '2026-10-21').current).toBe(0);
  });
});
