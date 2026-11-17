import { describe, expect, it } from 'vitest';
import { isDeliverableEmail, isNudgeDue, nudgeSubject } from '../../../src/services/learning';
import { IST, NY } from './_fixtures';

// LOOP_V2_SPEC §7: the morning nudge (due check + subject line).
describe('isNudgeDue', () => {
  const at = (iso: string) => new Date(iso);

  it("due at or after the user's local nudgeTime, once per local day", () => {
    const base = { tz: IST, nudgeTime: '08:30', lastNudgeDay: null };
    expect(isNudgeDue({ ...base, now: at('2026-11-14T02:59:00Z') })).toBe(false); // 08:29 IST
    expect(isNudgeDue({ ...base, now: at('2026-11-14T03:00:00Z') })).toBe(true); // 08:30 IST
    expect(isNudgeDue({ ...base, now: at('2026-11-14T15:00:00Z') })).toBe(true); // 20:30 IST, not sent yet
    expect(isNudgeDue({ ...base, now: at('2026-11-14T03:00:00Z'), lastNudgeDay: '2026-11-14' })).toBe(false);
    expect(isNudgeDue({ ...base, now: at('2026-11-14T03:00:00Z'), lastNudgeDay: '2026-11-13' })).toBe(true);
  });

  it('uses the zone: 08:30 in New York is 13:30Z in November', () => {
    const base = { tz: NY, nudgeTime: '08:30', lastNudgeDay: '2026-11-13' };
    expect(isNudgeDue({ ...base, now: at('2026-11-14T13:29:00Z') })).toBe(false);
    expect(isNudgeDue({ ...base, now: at('2026-11-14T13:30:00Z') })).toBe(true);
    // 03:00Z on 11-14 is still 11-13 in New York: already sent that day.
    expect(isNudgeDue({ ...base, now: at('2026-11-14T03:00:00Z') })).toBe(false);
  });

  it('an invalid stored time falls back to 08:30', () => {
    expect(isNudgeDue({ tz: IST, nudgeTime: 'soon', lastNudgeDay: null, now: at('2026-11-14T02:00:00Z') })).toBe(false);
    expect(isNudgeDue({ tz: IST, nudgeTime: 'soon', lastNudgeDay: null, now: at('2026-11-14T03:00:00Z') })).toBe(true);
  });
});

describe('nudgeSubject', () => {
  it('the three subjects of the spec (+ a plan already done)', () => {
    expect(nudgeSubject({ mode: 'normal', plannedCount: 6, estMinutes: 25, waitingCount: 12 })).toBe('Today: 6 revisions · ~25 min');
    expect(nudgeSubject({ mode: 'comeback', plannedCount: 1, estMinutes: 8, waitingCount: 0 })).toBe('Today: 1 revision · ~8 min');
    expect(nudgeSubject({ mode: 'busy', plannedCount: 3, estMinutes: 15, waitingCount: 9 })).toBe('Busy week: just 3 things today');
    expect(nudgeSubject({ mode: 'busy', plannedCount: 1, estMinutes: 5, waitingCount: 0 })).toBe('Busy week: just 1 thing today');
    expect(nudgeSubject({ mode: 'normal', plannedCount: 0, estMinutes: 0, waitingCount: 0 })).toBe('Nothing due today');
    expect(nudgeSubject({ mode: 'busy', plannedCount: 0, estMinutes: 0, waitingCount: 0 })).toBe('Nothing due today');
    expect(nudgeSubject({ mode: 'normal', plannedCount: 0, estMinutes: 0, waitingCount: 4 })).toBe("Today's plan is done");
  });
});

describe('isDeliverableEmail', () => {
  it('reserved top-level domains are never mailed', () => {
    for (const ok of ['alex@gmail.com', 'a@example.org', 'x@sub.domain.dev']) expect(isDeliverableEmail(ok)).toBe(true);
    for (const bad of ['dev@recollect.local', 'u@test.local', 'a@b.test', 'a@b.invalid', 'a@localhost', 'a@b.example', 'A@B.LOCAL', '', null, undefined, 'no-at-sign', '@x.com', 'x@']) {
      expect(isDeliverableEmail(bad)).toBe(false);
    }
  });
});
