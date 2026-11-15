// The buddy's voice (BUDDY_MEMORY_PLAN §3.4): which line and note are current. The night step (and
// the pulses, B4) write BuddyDay rows; the newest one of his buddy day wins. Morning from 04:00,
// afternoon from 12:00, evening from 18:00, by his zone.
import { prisma } from '../../db/prisma';
import { addDays, type DayString } from '../learning';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import type { Line, Slot } from './think';

export interface BuddyNoteJson {
    id: string;
    text: string;
    kind: 'note' | 'followUp';
    day: string;
}

/** The slot his clock is in (before 04:00 it is still last night's evening). */
export function slotAt(hour: number): Slot {
    return hour >= 4 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : 'evening';
}

/** His buddy day: the local day, but before 04:00 still yesterday's. */
export function buddyDayOf(today: DayString, hour: number): DayString {
    return hour < 4 ? addDays(today, -1) : today;
}

const hourIn = (tz: string, now: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now)) % 24;

/** The newest step of his buddy day (yesterday's when today's hasn't run yet). */
export async function latestStep(userId: string, now: Date = new Date()) {
    const ctx = await loadLearningContext(userId, now);
    const hour = hourIn(ctx.tz, now);
    const day = buddyDayOf(ctx.today, hour);
    const row = await prisma.buddyDay.findFirst({ where: { userId, day: { gte: toDbDay(addDays(day, -1)), lte: toDbDay(day) } }, orderBy: { createdAt: 'desc' } });
    return { row, day, slot: slotAt(hour), stale: !!row && fromDbDay(row.day) !== day };
}

/** The line for now: the current slot's, or null (then the picture says the day in plain words). */
export async function currentLine(userId: string, now: Date = new Date()): Promise<(Line & { dayId: string }) | null> {
    const { row, slot, stale } = await latestStep(userId, now);
    if (!row || stale) return null;
    const lines = (Array.isArray(row.lines) ? row.lines : []) as unknown as Line[];
    const line = lines.find((l) => l.slot === slot);
    return line ? { ...line, dayId: row.id } : null;
}

/** The newest note or follow-up of his buddy day not yet given to this caller (`after` = the last id it showed), or null. */
export async function nextNoteFor(userId: string, after?: string | undefined, now: Date = new Date()): Promise<BuddyNoteJson | null> {
    const { row, stale } = await latestStep(userId, now);
    if (!row || stale) return null;
    const notes: BuddyNoteJson[] = [];
    if (row.note) notes.push({ id: `${row.id}:note`, text: row.note, kind: 'note', day: fromDbDay(row.day) });
    if (row.followUp) notes.push({ id: `${row.id}:follow`, text: row.followUp, kind: 'followUp', day: fromDbDay(row.day) });
    return notes.find((n) => n.id !== after) ?? null;
}

/** The brief's note and follow-up: today's (or last night's) step's. */
export async function briefNote(userId: string, now: Date = new Date()): Promise<{ note: string | null; followUp: string | null }> {
    const { row, stale } = await latestStep(userId, now);
    if (!row || stale) return { note: null, followUp: null };
    return { note: row.note, followUp: row.followUp };
}
