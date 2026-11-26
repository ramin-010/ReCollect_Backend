/**
 * Day and time helpers with a PER-USER time zone.
 *
 * Replaces revise/src/lib/date.ts, which hard-coded IST (+5:30) and encoded a
 * calendar day as "UTC midnight of that day" (a *day label*). That encoding is
 * the root of Revise's "today starts at 05:30 IST" bug: the label for IST day
 * D is the instant D 00:00Z, which is 05:30 IST, so every place that compared
 * a real instant against a label (`scheduledFor <= now`,
 * `completedAt >= today` in dashboard/page.tsx) only flipped to the new day
 * at 05:30 IST.
 *
 * The fix is a type split that makes the mistake hard to write:
 *   - a CALENDAR DAY is a `DayString`, 'YYYY-MM-DD', always meaning "that
 *     date on the wall calendar of the user's time zone";
 *   - a REAL INSTANT is a `Date`.
 * Days are compared with days (string order === date order) and instants are
 * turned into days with `dayOf(instant, tz)` before any comparison, so a day
 * starts exactly at the user's local midnight.
 *
 * Only the built-in Intl API is used (no date library). Day arithmetic is done
 * on UTC-midnight timestamps, which have no DST, so `addDays` / `diffDays` are
 * exact; only `dayOf`, `startOfDay`, `endOfDay` and `minutesOfDay` look at the
 * time zone.
 *
 * The 'HH:mm' helpers at the bottom consolidate the five copies Revise has:
 * DayManagerModal (parseTime/formatTime/format12h), ScheduleTimeline
 * (toMinutes/minToStr/format12h), MultiDayCatchUpModal (formatTime),
 * WeeklyTimetable + TasksCalendar (format12h), plus the inline parsing in
 * DayDebriefModal and mentorReport.minutesBetween.
 */
import { LearningError } from './errors';

/** A calendar day in the user's time zone: 'YYYY-MM-DD'. */
export type DayString = string;

/** Revise ran on IST only; it stays the default for users with no zone set. */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export const MINUTES_PER_DAY = 24 * 60;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Mon..Sun, indexed by `weekday()` (0 = Monday, as in Revise). */
export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Calendar-day arithmetic (no time zone involved)
// ─────────────────────────────────────────────────────────────────────────────

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** UTC-midnight timestamp of a day; throws INVALID_DAY for anything else. */
function dayToUtcMs(day: DayString): number {
  const match = typeof day === 'string' ? DAY_PATTERN.exec(day) : null;
  if (match) {
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    // setUTCFullYear avoids Date.UTC's "years 0-99 mean 1900-1999" quirk.
    const date = new Date(0);
    date.setUTCFullYear(y, m - 1, d);
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) {
      return date.getTime();
    }
  }
  throw new LearningError('INVALID_DAY', `Expected a calendar day 'YYYY-MM-DD', got ${JSON.stringify(day)}`);
}

function utcMsToDay(ms: number): DayString {
  const date = new Date(ms);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

/** True for a real calendar day in 'YYYY-MM-DD' form (rejects 2026-02-30). */
export function isValidDay(value: unknown): value is DayString {
  if (typeof value !== 'string') return false;
  try {
    dayToUtcMs(value);
    return true;
  } catch {
    return false;
  }
}

/** Returns `value` if it is a valid day, else throws INVALID_DAY. */
export function assertDay(value: unknown): DayString {
  dayToUtcMs(value as DayString);
  return value as DayString;
}

/** `day` plus `days` (negative to go back). Mirrors lib/date.ts `addDays`. */
export function addDays(day: DayString, days: number): DayString {
  if (!Number.isInteger(days)) {
    throw new LearningError('INVALID_DAY', `addDays needs a whole number of days, got ${days}`);
  }
  return utcMsToDay(dayToUtcMs(day) + days * DAY_MS);
}

/**
 * Whole days from `earlier` to `later` (positive when `later` is after).
 * Mirrors lib/date.ts `differenceInISTDays`: diffDays('2026-09-06', '2026-09-05') === 1.
 */
export function diffDays(later: DayString, earlier: DayString): number {
  return Math.round((dayToUtcMs(later) - dayToUtcMs(earlier)) / DAY_MS);
}

/** -1 / 0 / 1. Plain string comparison works too; this one validates. */
export function compareDays(a: DayString, b: DayString): number {
  const d = dayToUtcMs(a) - dayToUtcMs(b);
  return d < 0 ? -1 : d > 0 ? 1 : 0;
}

/**
 * Day of week in the app's convention, 0 = Monday ... 6 = Sunday (lib/date.ts
 * `getISTDayOfWeek`). This is what `TimeBlock.dayOfWeek` stores. It is NOT
 * JavaScript's `getDay()` (0 = Sunday).
 */
export function weekday(day: DayString): number {
  const jsDay = new Date(dayToUtcMs(day)).getUTCDay(); // 0 = Sun .. 6 = Sat
  return jsDay === 0 ? 6 : jsDay - 1;
}

/** 'Mon'..'Sun' for a day. */
export function weekdayName(day: DayString): (typeof WEEKDAY_NAMES)[number] {
  return WEEKDAY_NAMES[weekday(day)] ?? 'Mon';
}

/** Inclusive list of days from `from` to `to`; empty if `from` > `to` (lib/date.ts `eachISTDayInRange`). */
export function eachDay(from: DayString, to: DayString): DayString[] {
  const out: DayString[] = [];
  const last = dayToUtcMs(to);
  for (let ms = dayToUtcMs(from); ms <= last; ms += DAY_MS) out.push(utcMsToDay(ms));
  return out;
}

/** The Monday starting the week that contains `day` (lib/date.ts `getISTStartOfWeek`). */
export function startOfWeek(day: DayString): DayString {
  return addDays(day, -weekday(day));
}

/** First day of the month containing `day`. */
export function startOfMonth(day: DayString): DayString {
  return `${assertDay(day).slice(0, 7)}-01`;
}

/** Last day of the month containing `day` (lib/date.ts `getISTEndOfMonthLabel`, as a day). */
export function endOfMonth(day: DayString): DayString {
  const date = new Date(dayToUtcMs(day));
  // Day 0 of the next month is the last day of this month.
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return utcMsToDay(date.getTime());
}

/** Earlier / later of two days. */
export function minDay(a: DayString, b: DayString): DayString {
  return compareDays(a, b) <= 0 ? a : b;
}
export function maxDay(a: DayString, b: DayString): DayString {
  return compareDays(a, b) >= 0 ? a : b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage interop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A day as a UTC-midnight `Date`, which is how Prisma reads and writes a
 * Postgres `date` (`@db.Date`) column.
 */
export function dayToUtcMidnight(day: DayString): Date {
  return new Date(dayToUtcMs(day));
}

/** Inverse of `dayToUtcMidnight`: the UTC calendar date of a `@db.Date` value. */
export function dayFromUtcMidnight(date: Date): DayString {
  assertInstant(date);
  return utcMsToDay(date.getTime());
}

/**
 * Reads a Revise day label (`getISTMidnight` output, i.e. UTC midnight of an
 * IST day) as a DayString. Also handles the legacy rows that export.actions
 * mentions, stored at 18:30Z of the previous UTC day (true IST midnight).
 * Use this in the Revise → Kaaga import, never `dayFromUtcMidnight`.
 */
export function dayFromReviseLabel(label: Date): DayString {
  return dayOf(label, DEFAULT_TIMEZONE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Time-zone aware conversions (Intl only)
// ─────────────────────────────────────────────────────────────────────────────

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new LearningError('INVALID_TIMEZONE', `Expected an IANA time zone, got ${JSON.stringify(timeZone)}`);
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new LearningError('INVALID_TIMEZONE', `Unknown IANA time zone ${JSON.stringify(timeZone)}`);
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function assertInstant(instant: Date): number {
  const ms = instant instanceof Date ? instant.getTime() : NaN;
  if (!Number.isFinite(ms)) {
    throw new LearningError('INVALID_INSTANT', `Expected a valid Date, got ${String(instant)}`);
  }
  return ms;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts: ZonedParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    switch (part.type) {
      case 'year': parts.year = Number(part.value); break;
      case 'month': parts.month = Number(part.value); break;
      case 'day': parts.day = Number(part.value); break;
      case 'hour': parts.hour = Number(part.value) % 24; break; // defensive: old ICU printed midnight as "24"
      case 'minute': parts.minute = Number(part.value); break;
      case 'second': parts.second = Number(part.value); break;
      default: break;
    }
  }
  return parts;
}

const partsToDay = (p: ZonedParts): DayString => `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`;

/** True if `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string') return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** `tz` if valid, otherwise DEFAULT_TIMEZONE. Use for user-profile values. */
export function resolveTimeZone(tz?: string | null): string {
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

/** The calendar day an instant falls on in `tz` (lib/date.ts `getISTMidnight` / `toISTDateString`). */
export function dayOf(instant: Date, tz: string = DEFAULT_TIMEZONE): DayString {
  return partsToDay(zonedParts(assertInstant(instant), tz));
}

/**
 * The user's current calendar day. Flips at the user's local midnight (not at
 * 05:30 IST as Revise's label comparisons did).
 */
export function today(tz: string = DEFAULT_TIMEZONE, now: Date = new Date()): DayString {
  return dayOf(now, tz);
}

/** Local wall-clock minutes since midnight (0..1439) of an instant in `tz`. */
export function minutesOfDay(instant: Date, tz: string = DEFAULT_TIMEZONE): number {
  const p = zonedParts(assertInstant(instant), tz);
  return p.hour * 60 + p.minute;
}

/** UTC offset of `tz` at an instant, in ms (positive east of Greenwich). */
function offsetMs(timeZone: string, ms: number): number {
  const p = zonedParts(ms, timeZone);
  const date = new Date(0);
  date.setUTCFullYear(p.year, p.month - 1, p.day);
  date.setUTCHours(p.hour, p.minute, p.second, 0);
  return date.getTime() - Math.floor(ms / 1000) * 1000;
}

/**
 * The first instant of `day` in `tz`, as a UTC `Date`.
 *
 * Usually local midnight. Where a DST jump skips midnight (e.g.
 * America/Santiago on 2026-09-06, America/Havana on 2026-03-08) the day
 * starts at the jump, e.g. 01:00 local.
 */
export function startOfDay(day: DayString, tz: string = DEFAULT_TIMEZONE): Date {
  const wall = dayToUtcMs(day); // local midnight written as if it were UTC
  // Fast path: two-pass offset correction. Exact unless a DST change sits on midnight.
  let t = wall - offsetMs(tz, wall);
  t = wall - offsetMs(tz, t);
  if (isFirstInstantOf(t, day, tz)) return new Date(t);

  // Slow path: binary search for the first instant whose local day is >= `day`.
  // The local day never decreases as time moves forward, and every real
  // offset lies within ±15 h, so the answer is inside [wall - 15h, wall + 15h].
  let lo = wall - 15 * HOUR_MS; // local day < `day`
  let hi = wall + 15 * HOUR_MS; // local day >= `day`
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (partsToDay(zonedParts(mid, tz)) >= day) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

function isFirstInstantOf(ms: number, day: DayString, tz: string): boolean {
  const p = zonedParts(ms, tz);
  return (
    partsToDay(p) === day &&
    p.hour === 0 &&
    p.minute === 0 &&
    p.second === 0 &&
    partsToDay(zonedParts(ms - 1, tz)) < day
  );
}

/**
 * The last millisecond of `day` in `tz` (inclusive end, like lib/date.ts
 * `getISTEndOfDayLabel`, but a real instant). For an exclusive bound use
 * `startOfDay(addDays(day, 1), tz)`.
 */
export function endOfDay(day: DayString, tz: string = DEFAULT_TIMEZONE): Date {
  return new Date(startOfDay(addDays(day, 1), tz).getTime() - 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 'HH:mm' wall-clock helpers (the five Revise copies, consolidated)
// ─────────────────────────────────────────────────────────────────────────────

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** True for 'H:mm' / 'HH:mm' with 0-23 hours and 0-59 minutes. */
export function isValidTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = TIME_PATTERN.exec(value);
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

/**
 * 'HH:mm' → minutes since midnight. Same result as Revise's
 * `parseTime`/`toMinutes` (`h * 60 + m`) for valid input; unlike them it
 * throws INVALID_TIME instead of returning NaN.
 */
export function timeToMinutes(value: string): number {
  if (!isValidTime(value)) {
    throw new LearningError('INVALID_TIME', `Expected a time 'HH:mm', got ${JSON.stringify(value)}`);
  }
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Minutes → 'HH:mm', floored and wrapped into one day (ScheduleTimeline
 * `minToStr`; DayManagerModal `formatTime` wrapped only once, which matters
 * only for values beyond ±24 h).
 */
export function minutesToTime(minutes: number): string {
  if (!Number.isFinite(minutes)) {
    throw new LearningError('INVALID_TIME', `Expected a finite number of minutes, got ${minutes}`);
  }
  const m = ((Math.floor(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad(Math.floor(m / 60), 2)}:${pad(m % 60, 2)}`;
}

/**
 * Length of a block from `start` to `end`, crossing midnight when `end` is
 * earlier. Revise disagrees about equal times, so the caller picks:
 *   - 'zero' (default): DayDebriefModal stats and mentorReport `minutesBetween`
 *     (`if (dur < 0) dur += 1440`);
 *   - 'fullDay': DayManagerModal init and ScheduleTimeline (`<= 0` / `endMin <= startMin`).
 */
export function durationMinutes(start: string, end: string, zeroLength: 'zero' | 'fullDay' = 'zero'): number {
  let d = timeToMinutes(end) - timeToMinutes(start);
  if (d < 0 || (d === 0 && zeroLength === 'fullDay')) d += MINUTES_PER_DAY;
  return d;
}

/**
 * '13:05' → '01:05 PM' (DayManagerModal / WeeklyTimetable / TasksCalendar /
 * ScheduleTimeline style), or '1:05 PM' with `padHour = false`
 * (MultiDayCatchUpModal style).
 */
export function format12h(time: string, padHour = true): string {
  const total = timeToMinutes(time);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const h12 = h % 12 || 12;
  return `${padHour ? pad(h12, 2) : String(h12)}:${pad(m, 2)} ${h >= 12 ? 'PM' : 'AM'}`;
}
