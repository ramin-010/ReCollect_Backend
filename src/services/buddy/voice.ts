// The buddy's voice (BUDDY_MEMORY_PLAN §3.4): which line and note are current. The night step (and
// the pulses, B4) write BuddyDay rows; the newest one of his buddy day wins. Morning from 04:00,
// afternoon from 12:00, evening from 18:00, by his zone.
import { prisma } from '../../db/prisma';
import { addDays, type DayString } from '../learning';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import type { Line, Slot } from './think';
import { unlabel, unlabelOr } from './words';

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

/**
 * The line for now: the current slot's, or null when the buddy is silent for these hours (then the lock
 * picture is the dial of the day). An old step's plain line (written by code in its place) counts as silence.
 */
export async function currentLine(userId: string, now: Date = new Date()): Promise<(Line & { dayId: string }) | null> {
    const { row, slot, stale } = await latestStep(userId, now);
    if (!row || stale) return null;
    const lines = (Array.isArray(row.lines) ? row.lines : []) as unknown as Line[];
    const line = lines.find((l) => l.slot === slot);
    // Read through unlabel too: lines saved before the voice fix (11-16) still had "From your notes:".
    return line && line.text && !line.fallback ? { ...line, text: unlabel(line.text), dayId: row.id } : null;
}

/**
 * The thought for his home screen today (Ramin 11-16: the home screen shows what matters, reminders or
 * a suggestion or insight from the buddy, never the lock screen's line): only one the lock check passed.
 */
export async function currentInsight(userId: string, now: Date = new Date()): Promise<{ dayId: string; text: string } | null> {
    const { row, stale } = await latestStep(userId, now);
    if (!row || stale || !row.insight || !row.insightLockOk) return null;
    return { dayId: row.id, text: unlabel(row.insight) };
}

/** The newest note or follow-up of his buddy day not yet given to this caller (`after` = the last id it showed), or null. */
export async function nextNoteFor(userId: string, after?: string | undefined, now: Date = new Date()): Promise<BuddyNoteJson | null> {
    const { row, stale } = await latestStep(userId, now);
    if (!row || stale) return null;
    const notes: BuddyNoteJson[] = [];
    if (row.note) notes.push({ id: `${row.id}:note`, text: unlabel(row.note), kind: 'note', day: fromDbDay(row.day) });
    if (row.followUp) notes.push({ id: `${row.id}:follow`, text: unlabel(row.followUp), kind: 'followUp', day: fromDbDay(row.day) });
    return notes.find((n) => n.id !== after) ?? null;
}

/**
 * The brief's note and follow-up: today's (or last night's) step's. `noteId` is the note's id as
 * GET /api/buddy/note gives it, so the hooks don't show a note the session started with again.
 */
export async function briefNote(userId: string, now: Date = new Date()): Promise<{ note: string | null; followUp: string | null; noteId: string | null; noteDay: string | null }> {
    const { row, stale } = await latestStep(userId, now);
    if (!row || stale) return { note: null, followUp: null, noteId: null, noteDay: null };
    return { note: unlabelOr(row.note), followUp: unlabelOr(row.followUp), noteId: row.note ? `${row.id}:note` : null, noteDay: row.note ? fromDbDay(row.day) : null };
}

// ─── The phone app's screen (B4, app 0.3.0) ────────────────────────────────

export interface PhoneLine {
    dayId: string;
    slot: Slot;
    day: DayString;
    /** "This morning", "Yesterday evening", "Friday afternoon" (his zone). */
    when: string;
    text: string;
    /** The line for now (the app's card, with its thumbs). */
    current: boolean;
}

export interface PhoneBuddy {
    name: string | null;
    /** The newest step's note; `lockOk`: the lock check passed it, so a notification may show its words. */
    note: { id: string; dayId: string; text: string; lockOk: boolean; at: string } | null;
    /** The lines it has said so far, newest first (7 at most; the code's plain lines left out). */
    lines: PhoneLine[];
    /** His thumbs on those steps (the last per target counts). */
    thumbs: Array<{ dayId: string; target: string; verdict: string }>;
}

const SLOT_ORDER: readonly Slot[] = ['morning', 'afternoon', 'evening'];
export const PHONE_LINES_MAX = 7;

function whenWords(day: DayString, slot: Slot, today: DayString): string {
    if (day === today) return `This ${slot}`;
    if (day === addDays(today, -1)) return `Yesterday ${slot}`;
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
    return `${weekday} ${slot}`;
}

/**
 * What the phone app's screen shows (inside the app, behind his phone's lock): the note, the lines said
 * so far and his thumbs. The widget and the lock picture keep to the lock-safe line (`Ambient.line`).
 * Null while the buddy is off or paused.
 */
export async function phoneBuddy(userId: string, now: Date = new Date()): Promise<PhoneBuddy | null> {
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { enabled: true, paused: true, name: true } });
    if (!state?.enabled || state.paused) return null;
    const ctx = await loadLearningContext(userId, now);
    const hour = hourIn(ctx.tz, now);
    const day = buddyDayOf(ctx.today, hour);
    const slot = slotAt(hour);
    const rows = await prisma.buddyDay.findMany({ where: { userId, day: { gte: toDbDay(addDays(day, -3)), lte: toDbDay(day) } }, orderBy: { createdAt: 'desc' } });
    // The newest step of each day holds what that day showed (a pulse keeps the hours gone).
    const newest = new Map<DayString, (typeof rows)[number]>();
    for (const r of rows) if (!newest.has(fromDbDay(r.day))) newest.set(fromDbDay(r.day), r);
    const lines: PhoneLine[] = [];
    for (const d of [...newest.keys()].sort().reverse()) {
        const r = newest.get(d)!;
        const said = (Array.isArray(r.lines) ? r.lines : []) as unknown as Line[];
        for (let i = d === day ? SLOT_ORDER.indexOf(slot) : SLOT_ORDER.length - 1; i >= 0; i--) {
            const l = said.find((x) => x.slot === SLOT_ORDER[i]);
            if (l && !l.fallback && l.text) lines.push({ dayId: r.id, slot: l.slot, day: d, when: whenWords(d, l.slot, day), text: unlabel(l.text), current: d === day && l.slot === slot });
        }
    }
    const top = rows[0] && fromDbDay(rows[0].day) === day ? rows[0] : null;
    const shown = lines.slice(0, PHONE_LINES_MAX);
    const ids = [...new Set([...shown.map((l) => l.dayId), ...(top ? [top.id] : [])])];
    const thumbs = ids.length ? await prisma.buddyFeedback.findMany({ where: { userId, buddyDayId: { in: ids } }, orderBy: { createdAt: 'asc' } }) : [];
    return {
        name: state.name,
        note: top?.note ? { id: `${top.id}:note`, dayId: top.id, text: unlabel(top.note), lockOk: top.noteLockOk, at: top.createdAt.toISOString() } : null,
        lines: shown,
        thumbs: thumbs.map((t) => ({ dayId: t.buddyDayId, target: t.target, verdict: t.verdict })),
    };
}
