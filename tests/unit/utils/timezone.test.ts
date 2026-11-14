import { describe, expect, it } from 'vitest';
import {
    calendarDateIn,
    DEFAULT_TIME_ZONE,
    isDateOnlyString,
    parseClientDate,
    parseDateOnly,
    zonedWallTimeToDate,
} from '../../../src/utils/timezone';

describe('calendarDateIn', () => {
    it("is the user's (IST) date, which is a day ahead of UTC between 00:00 and 05:30 IST", () => {
        const at0130Ist = new Date('2026-10-21T20:00:00.000Z'); // 22 Oct, 01:30 in India
        expect(at0130Ist.toISOString().split('T')[0]).toBe('2026-10-21'); // the old, wrong "today"
        expect(calendarDateIn(at0130Ist)).toBe('2026-10-22');
        expect(calendarDateIn(at0130Ist, 'UTC')).toBe('2026-10-21');
    });

    it('defaults to Asia/Kolkata', () => {
        expect(DEFAULT_TIME_ZONE).toBe('Asia/Kolkata');
        expect(calendarDateIn(new Date('2026-12-31T18:29:59.000Z'))).toBe('2026-12-31');
        expect(calendarDateIn(new Date('2026-12-31T18:30:00.000Z'))).toBe('2027-01-01');
    });
});

describe('zonedWallTimeToDate', () => {
    it('turns an IST wall-clock time into the right instant', () => {
        expect(zonedWallTimeToDate(2026, 10, 22, 0, 0).toISOString()).toBe('2026-10-21T18:30:00.000Z');
        expect(zonedWallTimeToDate(2026, 10, 22, 18, 0).toISOString()).toBe('2026-10-22T12:30:00.000Z');
    });

    it('handles a time zone with DST', () => {
        // New York: EDT (UTC-4) in July, EST (UTC-5) in January.
        expect(zonedWallTimeToDate(2026, 7, 1, 9, 0, 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
        expect(zonedWallTimeToDate(2026, 1, 15, 9, 0, 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z');
    });
});

describe('parseDateOnly / parseClientDate', () => {
    it('reads "YYYY-MM-DD" as that day at 18:00 IST (never UTC midnight = 05:30 IST)', () => {
        const due = parseDateOnly('2026-10-22');
        expect(due?.toISOString()).toBe('2026-10-22T12:30:00.000Z');
        expect(calendarDateIn(due as Date)).toBe('2026-10-22');
        expect(new Date('2026-10-22').toISOString()).toBe('2026-10-22T00:00:00.000Z'); // what new Date() did
    });

    it('takes another hour or time zone when asked', () => {
        expect(parseDateOnly('2026-10-22', { hour: 9 })?.toISOString()).toBe('2026-10-22T03:30:00.000Z');
        expect(parseDateOnly('2026-10-22', { timeZone: 'UTC', hour: 0 })?.toISOString()).toBe('2026-10-22T00:00:00.000Z');
    });

    it('rolls an out-of-range day over like V8 did, and rejects impossible months/days', () => {
        expect(parseDateOnly('2026-02-30')?.toISOString()).toBe('2026-03-02T12:30:00.000Z');
        expect(parseDateOnly('2026-13-01')).toBeNull();
        expect(parseDateOnly('2026-10-32')).toBeNull();
        expect(parseDateOnly('2026-10-22T10:00:00Z')).toBeNull();
    });

    it('isDateOnlyString only matches a bare date', () => {
        expect(isDateOnlyString('2026-10-22')).toBe(true);
        expect(isDateOnlyString(' 2026-10-22 ')).toBe(true);
        expect(isDateOnlyString('2026-10-22T00:00:00.000Z')).toBe(false);
        expect(isDateOnlyString(20261022)).toBe(false);
    });

    it('parseClientDate keeps full timestamps exact and returns Invalid Date for garbage', () => {
        expect(parseClientDate('2026-10-22T04:15:00.000Z').toISOString()).toBe('2026-10-22T04:15:00.000Z');
        expect(parseClientDate('2026-10-22').toISOString()).toBe('2026-10-22T12:30:00.000Z');
        expect(Number.isNaN(parseClientDate('not a date').getTime())).toBe(true);
        expect(Number.isNaN(parseClientDate('2026-13-01').getTime())).toBe(true);
    });
});
