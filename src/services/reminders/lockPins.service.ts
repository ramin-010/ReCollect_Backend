// His own words on the lock screen (ECOSYSTEM_V2_PLAN stage 7, V1): "put this on my lock screen until 6".
// A pin has its hours (and, if he says so, its weekdays or a last day); inside them it is the lock line, over
// the buddy's words and questions (his pin wins in its window). He, the chat or an agent on his word sets one;
// clear_lock_line (or his own clear) takes it off. No model is involved.
//
//   listLockPins   GET  /api/lock-pins          read
//   setLockPin     POST /api/lock-pins          tasks:write
//   clearLockPins  POST /api/lock-pins/clear    tasks:write
import { prisma } from '../../db/prisma';
import { addDays, startOfDay, type DayString } from '../learning';
import { badRequest } from '../learning/http';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { poke } from '../scheduler/scheduler';

/** At most this many pins at once (one shows at a time; the rest wait for their hours). */
export const PINS_MAX = 4;
const TEXT_MAX = 120;

export interface LockPinJson {
    _id: string;
    text: string;
    /** "HH:mm" his time; from == to: all day; to "00:00": until midnight. */
    from: string;
    to: string;
    /** 0 Sunday to 6 Saturday; empty: every day. */
    days: number[];
    /** The last day it shows, or null (until cleared). */
    until: string | null;
    setBy: string;
    /** It is the lock line right now. */
    now: boolean;
}

export interface LockPinInput {
    text: string;
    /** "HH:mm" (his time); missing: from now. */
    from?: string | undefined;
    /** "HH:mm"; missing: until midnight. */
    to?: string | undefined;
    /** "weekdays", "weekends", or day numbers 0..6; missing: today only (unless `until` names a last day). */
    days?: 'weekdays' | 'weekends' | number[] | undefined;
    /** "YYYY-MM-DD", the last day it shows. */
    until?: string | undefined;
}

interface PinShape {
    fromMin: number;
    toMin: number;
    days: number[];
    untilDay: DayString | null;
}

const clockMin = (v: string): number => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw badRequest('Times are "HH:mm" (his time)');
    return Number(m[1]) * 60 + Number(m[2]);
};
const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const minuteOf = (at: Date, tz: string) => {
    const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(at).split(':').map(Number);
    return ((h ?? 0) % 24) * 60 + (m ?? 0);
};
const weekdayOf = (day: DayString) => new Date(`${day}T12:00:00Z`).getUTCDay();

/**
 * Inside its window now (pure): its day (its weekdays, up to its last day) and its hours. A window that crosses
 * midnight belongs to the day it began; "to 00:00" means until midnight.
 */
export function pinShowsNow(p: PinShape, today: DayString, minute: number): boolean {
    if (p.fromMin === p.toMin) return dayOk(p, today);
    if (p.toMin === 0) return minute >= p.fromMin && dayOk(p, today);
    if (p.fromMin < p.toMin) return minute >= p.fromMin && minute < p.toMin && dayOk(p, today);
    // Crosses midnight: the evening part is today's window, the small hours yesterday's.
    if (minute >= p.fromMin) return dayOk(p, today);
    return minute < p.toMin && dayOk(p, addDays(today, -1));
}

function dayOk(p: PinShape, day: DayString): boolean {
    if (p.untilDay && day > p.untilDay) return false;
    return !p.days.length || p.days.includes(weekdayOf(day));
}

/** When the window that holds `minute` ends (the phone's end time for the line). */
export function pinEnds(p: { fromMin: number; toMin: number }, today: DayString, minute: number, tz: string): Date {
    const at = (day: DayString, min: number) => new Date(startOfDay(day, tz).getTime() + min * 60_000);
    if (p.fromMin === p.toMin || p.toMin === 0) return at(addDays(today, 1), 0);
    if (p.fromMin < p.toMin) return at(today, p.toMin);
    return minute >= p.fromMin ? at(addDays(today, 1), p.toMin) : at(today, p.toMin);
}

type PinRow = Awaited<ReturnType<typeof prisma.lockPin.findMany>>[number];
const shapeOf = (p: PinRow): PinShape => ({ fromMin: p.fromMin, toMin: p.toMin, days: p.days, untilDay: p.untilDay ? fromDbDay(p.untilDay) : null });
const json = (p: PinRow, today: DayString, minute: number): LockPinJson => {
    const s = shapeOf(p);
    return { _id: p.id, text: p.text, from: clock(p.fromMin), to: clock(p.toMin), days: p.days, until: s.untilDay, setBy: p.setBy, now: pinShowsNow(s, today, minute) };
};

/** His pins not cleared and not past their last day, newest first. */
export async function listLockPins(userId: string, now: Date = new Date()): Promise<LockPinJson[]> {
    const { today, tz } = await loadLearningContext(userId, now);
    const rows = await prisma.lockPin.findMany({ where: { userId, clearedAt: null, OR: [{ untilDay: null }, { untilDay: { gte: toDbDay(addDays(today, -1)) } }] }, orderBy: { createdAt: 'desc' }, take: PINS_MAX * 2 });
    const minute = minuteOf(now, tz);
    return rows.map((p) => json(p, today, minute));
}

/** The pin that is the lock line now (the newest in its window), with its end time; null when none. */
export async function activePin(userId: string, now: Date = new Date()): Promise<{ id: string; text: string; until: string } | null> {
    const rows = await prisma.lockPin.findMany({ where: { userId, clearedAt: null }, orderBy: { createdAt: 'desc' }, take: PINS_MAX * 2 });
    if (!rows.length) return null;
    const { today, tz } = await loadLearningContext(userId, now);
    const minute = minuteOf(now, tz);
    for (const p of rows) if (pinShowsNow(shapeOf(p), today, minute)) return { id: p.id, text: p.text, until: pinEnds(p, today, minute, tz).toISOString() };
    return null;
}

/** A pin: his words in a window. With no weekdays and no last day it is for today only, so a pin never stays by mistake. */
export async function setLockPin(userId: string, input: LockPinInput, by: { setBy: 'you' | 'agent' | 'ask_ai'; agentName?: string | null | undefined }, now: Date = new Date()): Promise<LockPinJson> {
    const text = input.text.replace(/\s+/g, ' ').trim();
    if (!text) throw badRequest('Give the words to show');
    if (text.length > TEXT_MAX) throw badRequest(`At most ${TEXT_MAX} characters fit on the lock screen`);
    const { today, tz } = await loadLearningContext(userId, now);
    const minute = minuteOf(now, tz);
    const fromMin = input.from ? clockMin(input.from) : minute;
    const toMin = input.to ? clockMin(input.to) : 0;
    // "Until 6" said at 7 pm, with no start of its own, has already passed.
    if (!input.from && input.to && toMin !== 0 && toMin <= minute) throw badRequest('That time has already passed today');
    const days = input.days === 'weekdays' ? [1, 2, 3, 4, 5] : input.days === 'weekends' ? [0, 6] : Array.isArray(input.days) ? [...new Set(input.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b) : [];
    let untilDay: DayString | null = null;
    if (input.until) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.until) || input.until < today) throw badRequest('until is a day to come, "YYYY-MM-DD"');
        untilDay = input.until as DayString;
    } else if (!days.length) untilDay = today;
    if ((await prisma.lockPin.count({ where: { userId, clearedAt: null, OR: [{ untilDay: null }, { untilDay: { gte: toDbDay(today) } }] } })) >= PINS_MAX) throw badRequest(`At most ${PINS_MAX} pins at once: clear one first`);
    const row = await prisma.lockPin.create({ data: { userId, text, fromMin, toMin, days, untilDay: untilDay ? toDbDay(untilDay) : null, setBy: by.setBy, agentName: by.agentName?.slice(0, 60) ?? null } });
    poke('buddy');
    return json(row, today, minute);
}

/** Takes pins off: one by id, else the one showing now, else (all) every pin. */
export async function clearLockPins(userId: string, opts: { id?: string | undefined; all?: boolean | undefined } = {}, now: Date = new Date()): Promise<{ cleared: number }> {
    let ids: string[] = [];
    if (opts.id) ids = [opts.id];
    else if (opts.all) ids = (await prisma.lockPin.findMany({ where: { userId, clearedAt: null }, select: { id: true } })).map((p) => p.id);
    else {
        const active = await activePin(userId, now);
        if (active) ids = [active.id];
    }
    if (!ids.length) return { cleared: 0 };
    const { count } = await prisma.lockPin.updateMany({ where: { userId, id: { in: ids }, clearedAt: null }, data: { clearedAt: now } });
    return { cleared: count };
}
