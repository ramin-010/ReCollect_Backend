// Calendar dates in the user's time zone.
//
// Per-user time zones are not stored yet, so everything uses DEFAULT_TIME_ZONE (the app's users are
// in India). Two places need it:
//   - a date-only value ("2026-10-22", what the task AI returns) must mean that day in the user's
//     time zone, not UTC midnight (05:30 IST);
//   - "today" for the task AI prompt must be the user's date, not the UTC date (they differ between
//     00:00 and 05:30 IST).

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

/**
 * The time a date-only due date gets: 18:00, the same default the frontend's smart date parser uses
 * for a date typed without a time (recollect/lib/utils/smartDateParser.ts, "default to 6 PM").
 */
export const DATE_ONLY_DEFAULT_HOUR = 18;

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface WallClock {
    year: number;
    month: number; // 1-12
    day: number;
    hour: number;
    minute: number;
    second: number;
}

function wallClockIn(date: Date, timeZone: string): WallClock {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
    return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Offset of `timeZone` from UTC at `date`, in ms (IST: +5:30 → 19_800_000). */
function offsetMs(date: Date, timeZone: string): number {
    const c = wallClockIn(date, timeZone);
    const wallAsUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
    const instant = date.getTime() - date.getUTCMilliseconds();
    return wallAsUtc - instant;
}

/** The instant at which the wall-clock time year-month-day hour:minute happens in `timeZone`. */
export function zonedWallTimeToDate(
    year: number,
    month: number,
    day: number,
    hour = 0,
    minute = 0,
    timeZone: string = DEFAULT_TIME_ZONE
): Date {
    const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    // Two passes handle a DST change between the guess and the result (no DST in Asia/Kolkata).
    const first = wallAsUtc - offsetMs(new Date(wallAsUtc), timeZone);
    const second = wallAsUtc - offsetMs(new Date(first), timeZone);
    return new Date(second);
}

/** "YYYY-MM-DD" of `date` as seen in `timeZone`. */
export function calendarDateIn(date: Date, timeZone: string = DEFAULT_TIME_ZONE): string {
    const c = wallClockIn(date, timeZone);
    return `${String(c.year).padStart(4, '0')}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
}

/** True for a "YYYY-MM-DD" string (no time part). */
export function isDateOnlyString(value: unknown): value is string {
    return typeof value === 'string' && DATE_ONLY_RE.test(value.trim());
}

/**
 * "YYYY-MM-DD" → that calendar day in `timeZone` at `hour`:00 (default 18:00 Asia/Kolkata).
 * Returns null when the value is not date-only. An out-of-range day rolls over the way
 * `new Date('2026-02-30')` always did in V8 (→ 2 March).
 */
export function parseDateOnly(
    value: string,
    options: { hour?: number; timeZone?: string } = {}
): Date | null {
    const match = DATE_ONLY_RE.exec(value.trim());
    if (!match) return null;
    const month = Number(match[2]);
    const dayOfMonth = Number(match[3]);
    if (month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > 31) return null;
    const day = new Date(Date.UTC(Number(match[1]), month - 1, dayOfMonth));
    return zonedWallTimeToDate(
        day.getUTCFullYear(),
        day.getUTCMonth() + 1,
        day.getUTCDate(),
        options.hour ?? DATE_ONLY_DEFAULT_HOUR,
        0,
        options.timeZone ?? DEFAULT_TIME_ZONE
    );
}

/**
 * Parse a date sent by a client: a date-only string is the user's local day (parseDateOnly);
 * anything else goes through `new Date(value)` as before. Returns an Invalid Date for garbage, so
 * callers keep their old handling of bad input.
 */
export function parseClientDate(value: unknown): Date {
    if (isDateOnlyString(value)) {
        return parseDateOnly(value) ?? new Date(NaN);
    }
    return new Date(value as string | number | Date);
}
