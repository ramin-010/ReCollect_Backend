// Timed lines (ECOSYSTEM_V2_PLAN V1, stage 7; his point 4: "up to the buddy whether it shows 2, 3 or 4 at
// most, and if it doesn't want to show anything, that's its choice"). With the loop on, the night and the
// pulses write 0 to 6 lines (4 before 11-22) for his lock screen, each with its own hours (`from`, `until`: HH:mm, his clock)
// inside his buddy day, which runs from 04:00 to 04:00. A line without hours (the loop off, and every step
// before this) holds its part of the day: the morning 04:00-12:00, the afternoon 12:00-18:00, the evening
// 18:00-04:00. Pure: every reader of the lines goes through these, so both kinds read the same way.
import { startOfDay, type DayString } from '../learning';
import type { Slot } from './think';

/** At most this many lines a day (11-22, the owner: "more active during the day"; before, 4). */
export const LINES_MAX = 6;
/** A line shows for at least half an hour. */
export const LINE_MIN_MINUTES = 30;

/** His buddy day starts at 04:00 (minute 0) and ends at 04:00 the next morning (minute 1440). */
const DAY_START = 4 * 60;
const DAY = 24 * 60;
const SLOT_HOURS: Record<Slot, [number, number]> = { morning: [0, 480], afternoon: [480, 840], evening: [840, DAY] };

const pad = (n: number) => String(n).padStart(2, '0');

/** "7:05" or "07:05" → "07:05"; null when it is not a time of day. */
export function normTime(text: string | null | undefined): string | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec((text ?? '').trim());
    if (!m) return null;
    const [h, min] = [Number(m[1]), Number(m[2])];
    if (h > 23 || min > 59) return null;
    return `${pad(h)}:${m[2]}`;
}

/** Minutes into his buddy day of an HH:mm time: 04:00 is 0, 23:00 is 1140, 01:00 the next morning is 1260. */
export function dayMinute(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number) as [number, number];
    return (h * 60 + m - DAY_START + DAY) % DAY;
}

/** The HH:mm of a minute into his buddy day. */
export function clockOf(minute: number): string {
    const t = (((minute + DAY_START) % DAY) + DAY) % DAY;
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

/** The part of the day a minute of his buddy day falls in (a timed line's `slot`: how it is named, "This evening"). */
export function slotOfMinute(minute: number): Slot {
    return minute < 480 ? 'morning' : minute < 840 ? 'afternoon' : 'evening';
}

export interface LineHours {
    slot: Slot;
    from?: string | undefined;
    until?: string | undefined;
}

/** Whether a line has its own hours (a stored timed line has both; a model's line may carry broken ones). */
export const hasHours = (l: { from?: string | undefined; until?: string | undefined }): boolean => l.from !== undefined || l.until !== undefined;

/** A line's hours as minutes into his buddy day, [start, end): its own, else its part of the day's. An end at 04:00 is the day's end. */
export function lineWindow(l: LineHours): [number, number] {
    const from = normTime(l.from);
    const until = normTime(l.until);
    if (from && until) {
        const end = dayMinute(until);
        return [dayMinute(from), end === 0 ? DAY : end];
    }
    return SLOT_HOURS[l.slot] ?? [0, 0];
}

/** A line's name among the day's lines: its start for a timed line, else its part of the day (thumbs, the lock check and what it rests on go by it). */
export function lineKey(l: { slot?: string | undefined; from?: string | undefined }): string {
    return normTime(l.from) ?? l.slot ?? '';
}

/** How a line is named in a prompt: its hours ("07:30-09:00") or its part of the day. */
export function lineLabel(l: LineHours): string {
    if (!normTime(l.from)) return l.slot;
    const [s, e] = lineWindow(l);
    return `${clockOf(s)}-${clockOf(e)}`;
}

/** Minutes into his buddy day `day` at `now` (0 at 04:00 on `day`; outside 0-1439 when `now` is outside that day). */
export function minuteOf(day: DayString, tz: string, now: Date): number {
    return Math.floor((now.getTime() - startOfDay(day, tz).getTime()) / 60_000) - DAY_START;
}

/** The instant a minute of his buddy day `day` falls at (1440 is 04:00 the next morning). */
export function instantOf(day: DayString, tz: string, minute: number): Date {
    return new Date(startOfDay(day, tz).getTime() + (DAY_START + minute) * 60_000);
}

/** The line whose hours hold this minute of the day (the earliest such), or undefined: then the lock screen shows the day's dial. */
export function lineAt<T extends LineHours>(lines: readonly T[], minute: number): T | undefined {
    return lines.find((l) => {
        const [s, e] = lineWindow(l);
        return s <= minute && minute < e;
    });
}
