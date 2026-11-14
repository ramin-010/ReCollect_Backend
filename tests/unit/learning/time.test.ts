import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertDay,
  compareDays,
  dayFromReviseLabel,
  dayFromUtcMidnight,
  dayOf,
  dayToUtcMidnight,
  DEFAULT_TIMEZONE,
  diffDays,
  durationMinutes,
  eachDay,
  endOfDay,
  endOfMonth,
  format12h,
  isValidDay,
  isValidTime,
  isValidTimeZone,
  LearningError,
  maxDay,
  minDay,
  minutesOfDay,
  minutesToTime,
  resolveTimeZone,
  startOfDay,
  startOfMonth,
  startOfWeek,
  timeToMinutes,
  today,
  weekday,
  weekdayName,
} from '../../../src/services/learning';
import { IST, NY } from './_fixtures';

const iso = (d: Date) => d.toISOString();
const HOUR = 3_600_000;

describe('today / dayOf: the user-local calendar day', () => {
  it('defaults to Asia/Kolkata (Revise was IST-only)', () => {
    expect(DEFAULT_TIMEZONE).toBe('Asia/Kolkata');
    expect(today(undefined, new Date('2026-10-20T18:30:00Z'))).toBe('2026-10-21');
  });

  it('Asia/Kolkata flips exactly at local midnight (18:30Z)', () => {
    expect(today(IST, new Date('2026-10-20T18:29:59.999Z'))).toBe('2026-10-20');
    expect(today(IST, new Date('2026-10-20T18:30:00.000Z'))).toBe('2026-10-21');
  });

  it('fixes "today starts at 05:30 IST": the day starts at IST midnight, not at the UTC-midnight label', () => {
    // Revise encoded IST day D as D 00:00Z, i.e. 05:30 IST, and compared instants against it.
    const label = new Date('2026-10-21T00:00:00Z');
    expect(dayOf(label, IST)).toBe('2026-10-21');
    expect(iso(startOfDay('2026-10-21', IST))).toBe('2026-10-20T18:30:00.000Z');
    expect(startOfDay('2026-10-21', IST).getTime()).toBe(label.getTime() - 5.5 * HOUR);
    // 00:10 IST is already the 21st here; Revise would still have treated it as before "today".
    expect(today(IST, new Date('2026-10-20T18:40:00Z'))).toBe('2026-10-21');
  });

  it('America/New_York (negative offset) flips at 04:00Z in summer and 05:00Z in winter', () => {
    expect(today(NY, new Date('2026-10-21T03:59:59Z'))).toBe('2026-10-20');
    expect(today(NY, new Date('2026-10-21T04:00:00Z'))).toBe('2026-10-21');
    expect(today(NY, new Date('2026-01-15T04:59:59Z'))).toBe('2026-01-14');
    expect(today(NY, new Date('2026-01-15T05:00:00Z'))).toBe('2026-01-15');
  });

  it('the same instant is a different day in different zones', () => {
    const instant = new Date('2026-10-21T02:00:00Z');
    expect(dayOf(instant, IST)).toBe('2026-10-21'); // 07:30 IST
    expect(dayOf(instant, NY)).toBe('2026-10-20'); // 22:00 EDT
    expect(dayOf(instant, 'UTC')).toBe('2026-10-21');
  });

  it('minutesOfDay is local wall-clock time, across the New York DST jump', () => {
    expect(minutesOfDay(new Date('2026-10-20T18:40:00Z'), IST)).toBe(10); // 00:10 IST
    expect(minutesOfDay(new Date('2026-03-08T06:59:00Z'), NY)).toBe(1 * 60 + 59); // 01:59 EST
    expect(minutesOfDay(new Date('2026-03-08T07:00:00Z'), NY)).toBe(3 * 60); // 03:00 EDT
  });
});

describe('startOfDay / endOfDay as UTC instants', () => {
  it('Asia/Kolkata', () => {
    expect(iso(startOfDay('2026-10-21', IST))).toBe('2026-10-20T18:30:00.000Z');
    expect(iso(endOfDay('2026-10-21', IST))).toBe('2026-10-21T18:29:59.999Z');
  });

  it('America/New_York, ordinary summer day', () => {
    expect(iso(startOfDay('2026-10-21', NY))).toBe('2026-10-21T04:00:00.000Z');
    expect(iso(endOfDay('2026-10-21', NY))).toBe('2026-10-22T03:59:59.999Z');
  });

  it('New York spring-forward day (2026-03-08) is 23 hours long', () => {
    const start = startOfDay('2026-03-08', NY);
    const end = endOfDay('2026-03-08', NY);
    expect(iso(start)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(end)).toBe('2026-03-09T03:59:59.999Z');
    expect(end.getTime() + 1 - start.getTime()).toBe(23 * HOUR);
  });

  it('New York fall-back day (2026-11-01) is 25 hours long', () => {
    const start = startOfDay('2026-11-01', NY);
    const end = endOfDay('2026-11-01', NY);
    expect(iso(start)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(end)).toBe('2026-11-02T04:59:59.999Z');
    expect(end.getTime() + 1 - start.getTime()).toBe(25 * HOUR);
  });

  it('a day whose midnight is skipped by DST starts at the jump (America/Santiago 2026-09-06, Havana 2026-03-08)', () => {
    const santiago = startOfDay('2026-09-06', 'America/Santiago');
    expect(iso(santiago)).toBe('2026-09-06T04:00:00.000Z'); // 01:00 -03
    expect(dayOf(santiago, 'America/Santiago')).toBe('2026-09-06');
    expect(dayOf(new Date(santiago.getTime() - 1), 'America/Santiago')).toBe('2026-09-05');
    expect(iso(startOfDay('2026-03-08', 'America/Havana'))).toBe('2026-03-08T05:00:00.000Z');
  });

  it('a day after an hour repeated before midnight (America/Santiago 2026-04-05)', () => {
    expect(iso(startOfDay('2026-04-04', 'America/Santiago'))).toBe('2026-04-04T03:00:00.000Z');
    expect(iso(startOfDay('2026-04-05', 'America/Santiago'))).toBe('2026-04-05T04:00:00.000Z');
    expect(endOfDay('2026-04-04', 'America/Santiago').getTime() + 1 - startOfDay('2026-04-04', 'America/Santiago').getTime()).toBe(25 * HOUR);
  });

  it('round-trips every day of 2026 in several zones', () => {
    for (const tz of [IST, NY, 'UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Australia/Lord_Howe', 'America/Santiago']) {
      for (const day of eachDay('2026-01-01', '2026-12-31')) {
        const start = startOfDay(day, tz);
        const end = endOfDay(day, tz);
        expect(dayOf(start, tz)).toBe(day);
        expect(dayOf(new Date(start.getTime() - 1), tz)).toBe(addDays(day, -1));
        expect(dayOf(end, tz)).toBe(day);
        expect(dayOf(new Date(end.getTime() + 1), tz)).toBe(addDays(day, 1));
      }
    }
  });
});

describe('calendar-day arithmetic', () => {
  it('addDays across month, year and leap-day boundaries (lib/date.ts addDays)', () => {
    expect(addDays('2026-10-21', 1)).toBe('2026-10-22');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-10-21', 0)).toBe('2026-10-21');
    expect(addDays('2026-10-21', -30)).toBe('2026-09-21');
    expect(() => addDays('2026-10-21', 1.5)).toThrow(LearningError);
  });

  it('day arithmetic ignores DST (a day is a day)', () => {
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(diffDays('2026-03-09', '2026-03-07')).toBe(2);
    expect(diffDays('2026-11-02', '2026-10-31')).toBe(2);
  });

  it('diffDays matches differenceInISTDays (positive when later is after)', () => {
    expect(diffDays('2026-09-06', '2026-09-05')).toBe(1);
    expect(diffDays('2026-09-05', '2026-09-06')).toBe(-1);
    expect(diffDays('2027-01-01', '2026-01-01')).toBe(365);
  });

  it('weekday uses 0 = Monday (getISTDayOfWeek / TimeBlock.dayOfWeek)', () => {
    expect(weekday('2026-10-19')).toBe(0); // Monday
    expect(weekday('2026-10-21')).toBe(2); // Wednesday
    expect(weekday('2026-10-25')).toBe(6); // Sunday
    expect(weekdayName('2026-10-25')).toBe('Sun');
  });

  it('eachDay, startOfWeek, startOfMonth, endOfMonth, compare/min/max', () => {
    expect(eachDay('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(eachDay('2026-10-21', '2026-10-20')).toEqual([]);
    expect(startOfWeek('2026-10-25')).toBe('2026-10-19');
    expect(startOfWeek('2026-10-19')).toBe('2026-10-19');
    expect(startOfMonth('2026-10-21')).toBe('2026-10-01');
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
    expect(endOfMonth('2028-02-10')).toBe('2028-02-29');
    expect(endOfMonth('2026-12-05')).toBe('2026-12-31');
    expect(compareDays('2026-10-20', '2026-10-21')).toBe(-1);
    expect(minDay('2026-10-20', '2026-10-21')).toBe('2026-10-20');
    expect(maxDay('2026-10-20', '2026-10-21')).toBe('2026-10-21');
  });

  it('rejects anything that is not a real YYYY-MM-DD day', () => {
    expect(isValidDay('2026-10-21')).toBe(true);
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-05', '2026-10-21T00:00', '', 'tomorrow']) {
      expect(isValidDay(bad)).toBe(false);
      expect(() => assertDay(bad)).toThrow(expect.objectContaining({ code: 'INVALID_DAY' }));
    }
    expect(isValidDay(20261021)).toBe(false);
  });
});

describe('time zones and storage interop', () => {
  it('validates IANA zones', () => {
    expect(isValidTimeZone(IST)).toBe(true);
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(() => today('Mars/Olympus_Mons')).toThrow(expect.objectContaining({ code: 'INVALID_TIMEZONE' }));
    expect(resolveTimeZone(null)).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimeZone('nope')).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimeZone(NY)).toBe(NY);
  });

  it('rejects invalid instants', () => {
    expect(() => dayOf(new Date(Number.NaN), IST)).toThrow(expect.objectContaining({ code: 'INVALID_INSTANT' }));
  });

  it('Postgres date columns round-trip through UTC midnight', () => {
    expect(iso(dayToUtcMidnight('2026-10-21'))).toBe('2026-10-21T00:00:00.000Z');
    expect(dayFromUtcMidnight(new Date('2026-10-21T00:00:00Z'))).toBe('2026-10-21');
  });

  it('reads Revise day labels, including legacy 18:30Z rows (for the import)', () => {
    expect(dayFromReviseLabel(new Date('2026-09-05T00:00:00Z'))).toBe('2026-09-05');
    expect(dayFromReviseLabel(new Date('2026-09-04T18:30:00Z'))).toBe('2026-09-05');
  });
});

describe("'HH:mm' helpers (the five Revise copies)", () => {
  it('timeToMinutes = h * 60 + m (DayManagerModal parseTime, ScheduleTimeline toMinutes)', () => {
    expect(timeToMinutes('09:30')).toBe(570);
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('23:59')).toBe(1439);
    expect(timeToMinutes('7:05')).toBe(425);
  });

  it('throws INVALID_TIME instead of returning NaN', () => {
    for (const bad of ['24:00', '12:60', '9:5', 'aa:bb', '', '0930']) {
      expect(isValidTime(bad)).toBe(false);
      expect(() => timeToMinutes(bad)).toThrow(expect.objectContaining({ code: 'INVALID_TIME' }));
    }
    expect(() => minutesToTime(Number.NaN)).toThrow(LearningError);
  });

  it('minutesToTime floors and wraps into one day (ScheduleTimeline minToStr)', () => {
    expect(minutesToTime(570)).toBe('09:30');
    expect(minutesToTime(1440)).toBe('00:00');
    expect(minutesToTime(1500)).toBe('01:00');
    expect(minutesToTime(-30)).toBe('23:30');
    expect(minutesToTime(90.7)).toBe('01:30');
    expect(minutesToTime(2900)).toBe('00:20'); // DayManagerModal formatTime would give '24:20'
  });

  it('durationMinutes crosses midnight; equal times are 0 or a full day by choice', () => {
    expect(durationMinutes('09:00', '10:30')).toBe(90);
    expect(durationMinutes('23:00', '01:00')).toBe(120);
    expect(durationMinutes('09:00', '09:00')).toBe(0); // DayDebriefModal / mentorReport
    expect(durationMinutes('09:00', '09:00', 'fullDay')).toBe(1440); // DayManagerModal init / ScheduleTimeline
  });

  it('format12h in both Revise styles', () => {
    expect(format12h('13:05')).toBe('01:05 PM');
    expect(format12h('00:00')).toBe('12:00 AM');
    expect(format12h('12:00')).toBe('12:00 PM');
    expect(format12h('09:05', false)).toBe('9:05 AM');
  });
});
