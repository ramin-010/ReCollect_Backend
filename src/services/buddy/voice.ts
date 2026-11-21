// The buddy's voice (BUDDY_MEMORY_PLAN §3.4): which line and note are current. The night step (and
// the pulses, B4) write BuddyDay rows; the newest one of his buddy day wins. Morning from 04:00,
// afternoon from 12:00, evening from 18:00, by his zone.
import { prisma } from '../../db/prisma';
import { addDays, startOfDay, type DayString } from '../learning';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import type { Line, Slot } from './think';
import { unlabel, unlabelOr } from './words';
import { stillTrue, type Surface } from './asks';
import { parseAbout, type About } from './threads';
import { parseRefs } from './aheadBlocks';
import { instantOf, lineAt, lineKey, lineWindow, minuteOf } from './lineTimes';

/**
 * True when shown (ECOSYSTEM_V2_PLAN §4.5, stage 3): words tied to threads show only while each thread still
 * has the revision their writer saw, is open and not quiet, and (on a screen others see) not private.
 * Words tied to nothing pass (they end with their part of the day).
 */
/**
 * Stage 17: a nudge to pick something up is moot once a study or practice session started in the hour before its
 * hours or since (they are on it, or on something else tonight).
 */
export const refsSince = (start: Date): Date => new Date(start.getTime() - 60 * 60_000);

async function trueNow(userId: string, about: readonly About[] | undefined, surface: Surface, now: Date, more: { refs?: readonly string[] | undefined; since?: Date | undefined } = {}): Promise<boolean> {
    // Stage 17: words may rest on a left-off item or a to-do too (refs); one that closed takes them off.
    if (!about?.length && !more.refs?.length) return true;
    return (await stillTrue(userId, [{ about: about ?? [], refs: more.refs ?? null, since: more.since ?? null }], surface, now))[0] === true;
}

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

/**
 * When a slot's words end (§4.13: every word on a screen has an end time): the morning at 12:00, the afternoon at
 * 18:00, the evening at 04:00 the next day, his clock, on his buddy day.
 */
export function slotEnd(day: DayString, slot: Slot, tz: string): Date {
    const hour = slot === 'morning' ? 12 : slot === 'afternoon' ? 18 : 28;
    return new Date(startOfDay(day, tz).getTime() + hour * 3600_000);
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
 * The line for now: the one whose hours hold this moment (a timed line's own, stage 7; else its part of the
 * day), or null when the buddy is silent for these hours (then the lock picture is the dial of the day). An old
 * step's plain line (written by code in its place) counts as silence. `key` names it for his thumbs.
 */
export async function currentLine(userId: string, now: Date = new Date()): Promise<(Line & { dayId: string; until: string; key: string }) | null> {
    const { row, stale, day } = await latestStep(userId, now);
    if (!row || stale) return null;
    const { tz } = await loadLearningContext(userId, now);
    const lines = (Array.isArray(row.lines) ? row.lines : []) as unknown as Line[];
    const line = lineAt(lines, minuteOf(day, tz, now));
    // Read through unlabel too: lines saved before the voice fix (11-16) still had "From your notes:".
    if (!line || !line.text || line.fallback) return null;
    if (!(await trueNow(userId, line.about, 'lock', now, { refs: line.refs, since: refsSince(instantOf(day, tz, lineWindow(line)[0])) }))) return null;
    return { ...line, text: unlabel(line.text), dayId: row.id, until: instantOf(day, tz, lineWindow(line)[1]).toISOString(), key: lineKey(line) };
}

/**
 * The thought for his home screen today (the owner, 11-16: the home screen shows what matters, reminders or
 * a suggestion or insight from the buddy, never the lock screen's line): only one the lock check passed.
 */
export async function currentInsight(userId: string, now: Date = new Date()): Promise<{ dayId: string; text: string; until: string } | null> {
    const { row, stale, day } = await latestStep(userId, now);
    if (!row || stale || !row.insight || !row.insightLockOk) return null;
    if (!(await trueNow(userId, parseAbout(row.insightAbout), 'home', now, { refs: parseRefs(row.insightAbout), since: row.createdAt }))) return null;
    // The thought stays all his day: until 04:00 the next morning.
    const { tz } = await loadLearningContext(userId, now);
    return { dayId: row.id, text: unlabel(row.insight), until: slotEnd(day, 'evening', tz).toISOString() };
}

/** The newest note or follow-up of his buddy day not yet given to this caller (`after` = the last id it showed), or null. */
export async function nextNoteFor(userId: string, after?: string | undefined, now: Date = new Date()): Promise<BuddyNoteJson | null> {
    const { row, stale } = await latestStep(userId, now);
    if (!row || stale) return null;
    const notes: BuddyNoteJson[] = [];
    const noteTrue = await trueNow(userId, parseAbout(row.noteAbout), 'brief', now, { refs: parseRefs(row.noteAbout), since: row.createdAt });
    if (row.note && noteTrue) notes.push({ id: `${row.id}:note`, text: unlabel(row.note), kind: 'note', day: fromDbDay(row.day) });
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
    // Only a note the lock check passed (it names nothing private): an agent's brief is not a place for his health,
    // money or family (the week's simulation, 11-18: "go easy on that back" and an old chest-pain worry reached briefs).
    const note = row.note && row.noteLockOk && (await trueNow(userId, parseAbout(row.noteAbout), 'brief', now, { refs: parseRefs(row.noteAbout), since: row.createdAt })) ? row.note : null;
    return { note: unlabelOr(note), followUp: unlabelOr(row.followUp), noteId: note ? `${row.id}:note` : null, noteDay: note ? fromDbDay(row.day) : null };
}

// ─── The phone app's screen (B4, app 0.3.0) ────────────────────────────────

export interface PhoneLine {
    dayId: string;
    slot: Slot;
    /** Stage 7: what his thumb on it names (a timed line's start, else its part of the day). */
    key: string;
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
    const minute = minuteOf(day, ctx.tz, now);
    const rows = await prisma.buddyDay.findMany({ where: { userId, day: { gte: toDbDay(addDays(day, -3)), lte: toDbDay(day) } }, orderBy: { createdAt: 'desc' } });
    // The newest step of each day holds what that day showed (a pulse keeps the hours gone).
    const newest = new Map<DayString, (typeof rows)[number]>();
    for (const r of rows) if (!newest.has(fromDbDay(r.day))) newest.set(fromDbDay(r.day), r);
    const lines: PhoneLine[] = [];
    for (const d of [...newest.keys()].sort().reverse()) {
        const r = newest.get(d)!;
        // Newest first; today only the lines whose hours have begun (stage 7: by each line's hours).
        const said = ((Array.isArray(r.lines) ? r.lines : []) as unknown as Line[]).filter((l) => d !== day || lineWindow(l)[0] <= minute).sort((a, b) => lineWindow(b)[0] - lineWindow(a)[0]);
        for (const l of said) {
            const [start, end] = lineWindow(l);
            if (!l.fallback && l.text && (await trueNow(userId, l.about, 'web', now, { refs: l.refs }))) lines.push({ dayId: r.id, slot: l.slot, key: lineKey(l), day: d, when: whenWords(d, l.slot, day), text: unlabel(l.text), current: d === day && start <= minute && minute < end });
        }
    }
    const top = rows[0] && fromDbDay(rows[0].day) === day ? rows[0] : null;
    const shown = lines.slice(0, PHONE_LINES_MAX);
    const ids = [...new Set([...shown.map((l) => l.dayId), ...(top ? [top.id] : [])])];
    const thumbs = ids.length ? await prisma.buddyFeedback.findMany({ where: { userId, buddyDayId: { in: ids } }, orderBy: { createdAt: 'asc' } }) : [];
    return {
        name: state.name,
        note: top?.note && (await trueNow(userId, parseAbout(top.noteAbout), 'notification', now, { refs: parseRefs(top.noteAbout), since: top.createdAt })) ? { id: `${top.id}:note`, dayId: top.id, text: unlabel(top.note), lockOk: top.noteLockOk, at: top.createdAt.toISOString() } : null,
        lines: shown,
        thumbs: thumbs.map((t) => ({ dayId: t.buddyDayId, target: t.target, verdict: t.verdict })),
    };
}
