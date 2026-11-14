import { describe, expect, it } from 'vitest';
import { rhythmLast7, rhythmStart } from '../../../src/services/learning';
import { IST, NY } from './_fixtures';

// LOOP_V2_SPEC §5: stats.rhythm = { last7: [{ day, active }], activeDays }.
const TODAY = '2026-11-14';

describe('rhythmLast7', () => {
  it('the last 7 days, oldest first, all inactive without activity', () => {
    const r = rhythmLast7({ today: TODAY, tz: IST });
    expect(r.last7.map((d) => d.day)).toEqual(['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    expect(r.last7.every((d) => !d.active)).toBe(true);
    expect(r.activeDays).toBe(0);
    expect(rhythmStart(TODAY)).toBe('2026-11-08');
  });

  it('a day is active with a completed revision (in the user zone) or a done focus item', () => {
    const r = rhythmLast7({
      today: TODAY,
      tz: IST,
      completions: [new Date('2026-11-13T19:00:00Z'), new Date('2026-11-10T06:00:00Z'), new Date('2026-11-10T07:00:00Z')],
      focusDoneDays: ['2026-11-08', '2026-11-12'],
    });
    // 2026-11-13T19:00Z is 00:30 on the 14th in IST.
    expect(r.last7.filter((d) => d.active).map((d) => d.day)).toEqual(['2026-11-08', '2026-11-10', '2026-11-12', '2026-11-14']);
    expect(r.activeDays).toBe(4);
  });

  it('the same instant counts for the previous day in New York', () => {
    const r = rhythmLast7({ today: '2026-11-13', tz: NY, completions: [new Date('2026-11-13T19:00:00Z'), new Date('2026-11-14T04:30:00Z')] });
    // 19:00Z = 14:00 EST on the 13th; 04:30Z on the 14th = 23:30 EST on the 13th.
    expect(r.last7.filter((d) => d.active).map((d) => d.day)).toEqual(['2026-11-13']);
  });

  it('activity outside the window is ignored', () => {
    const r = rhythmLast7({ today: TODAY, tz: IST, completions: [new Date('2026-11-01T06:00:00Z')], focusDoneDays: ['2026-11-07', '2026-11-15'] });
    expect(r.activeDays).toBe(0);
  });
});
