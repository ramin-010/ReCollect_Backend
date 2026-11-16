// The ambient phone (ECOSYSTEM_PLAN §10 step a; ALWAYS_ON_SPEC 6.6): a wallpaper picture and a small
// widget summary, both drawn from the brief. States, not statistics: what today holds in the morning,
// the focus line while working, one line on the day in the evening, a clean picture when the day is
// done, lighter in busy and comeback modes. Never red, never an overdue count as the headline.
import { getBrief, type Brief } from '../brief/brief.service';
import { currentInsight, currentLine } from '../buddy/voice';
import { getToday } from '../learningDb/today.service';
import type { PlanMode } from '../learning/plan';
import { dayOf } from '../learning/time';
import path from 'node:path';
import { svgToPng } from '../docs/diagram/png';
import { prisma } from '../../db/prisma';
import { drawLock, drawWallpaper, kindWords } from './wallpaperArt';

export type AmbientState = 'morning' | 'working' | 'evening' | 'done' | 'rest';

export interface Ambient {
    state: AmbientState;
    /** e.g. "Sunday 15 November" */
    date: string;
    /** The one line that matters now; empty on a done day (the picture is the reward). */
    headline: string;
    /** Up to three quieter lines under it. */
    lines: string[];
    mode: PlanMode;
    updatedAt: string;
    /** The last seven days, oldest first: studied or not (Home's rhythm). The wallpaper draws them as dots. */
    week?: Array<{ day: string; active: boolean }>;
    /** Today's things, open first then done: the home picture's list and the lock picture's dial. */
    items?: AmbientItem[];
    counts?: AmbientCounts;
    /** The nearest active goal (the lock picture's last line). */
    goal?: AmbientGoal | null;
    /**
     * The buddy's line for now (BUDDY_MEMORY_PLAN §3.4), only one the lock check passed (never with
     * titles hidden): the lock picture's main words and the widget's line.
     */
    line?: { dayId: string; slot: string; text: string } | null;
    /**
     * Today's reminders still to come (Ramin 11-16: "the home screen could show my reminders; if there
     * are none it stays clean"), soonest first, three at most; with titles hidden, plain words.
     */
    reminders?: AmbientReminder[];
    /**
     * The buddy's thought for the home screen today (Ramin 11-16: the home screen lists what matters,
     * reminders or a suggestion or insight from the buddy; the lock screen keeps the line): only one the
     * lock check passed, never with titles hidden; none: the picture stays as it is.
     */
    insight?: string;
    /** Changes whenever either picture would: the phone app fetches them again only then. */
    key?: string;
}

export interface AmbientReminder {
    /** "7 pm", "6:30 pm" (his zone). */
    at: string;
    text: string;
}

export type AmbientItemKind = 'review' | 'focus' | 'task';

export interface AmbientItem {
    kind: AmbientItemKind;
    /** The topic, focus line or task, or plain words when titles are hidden. */
    title: string;
    /** "8 min", "5 pm", "1 day late"; empty when there is nothing to add. */
    meta: string;
    done: boolean;
}

export interface AmbientCounts {
    reviews: { done: number; total: number };
    focus: { done: number; total: number };
    tasks: { done: number; total: number };
    /** About how long the open reviews take. */
    minutesLeft: number;
}

export interface AmbientGoal {
    title: string;
    daysLeft: number;
    /** Milestones done and planned. */
    done: number;
    total: number;
}

type TodayPayload = Awaited<ReturnType<typeof getToday>>;

function clockWords(d: Date, tz: string): string {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const half = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase().replace(/\./g, '');
    return minute === '00' ? `${hour} ${half}` : `${hour}:${minute} ${half}`;
}

/**
 * Today's things for the phone pictures (pure): the reviews planned and done today, the focus lines,
 * and the personal tasks due today or late (with those finished today), open first in their own
 * order, then done. With titles hidden every title is plain words ("A review"), as on the widget.
 */
export function dayItems(t: Pick<TodayPayload, 'plan' | 'focus' | 'tasks' | 'goals' | 'timezone' | 'today'>, now: Date, titles = true): { items: AmbientItem[]; counts: AmbientCounts; goal: AmbientGoal | null } {
    const tz = t.timezone;
    const today = t.today;
    const plan = t.plan;
    const open: AmbientItem[] = [];
    const done: AmbientItem[] = [];
    for (const r of plan?.planned ?? []) open.push({ kind: 'review', title: titles ? r.title : 'A review', meta: r.minutes ? `${r.minutes} min` : '', done: false });
    for (const r of plan?.doneToday ?? []) done.push({ kind: 'review', title: titles ? r.title : 'A review', meta: '', done: true });
    const focus = t.focus?.items ?? [];
    for (const f of focus) (f.done ? done : open).push({ kind: 'focus', title: titles ? f.text : 'A focus line', meta: '', done: f.done });

    const tasks = (t.tasks ?? [])
        .filter((x) => {
            if (x.status === 'complete') return !!x.completedAt && dayOf(new Date(x.completedAt), tz) === today;
            return !!x.dueDate && dayOf(new Date(x.dueDate), tz) <= today;
        })
        .sort((a, b) => new Date(a.dueDate ?? 0).getTime() - new Date(b.dueDate ?? 0).getTime());
    let tasksDone = 0;
    for (const x of tasks) {
        const finished = x.status === 'complete';
        if (finished) tasksDone++;
        let meta = '';
        if (!finished && x.dueDate) {
            const due = new Date(x.dueDate);
            const mins = Math.floor((now.getTime() - due.getTime()) / 60_000);
            const dayDiff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dayOf(due, tz)}T00:00:00Z`)) / 86_400_000);
            if (dayDiff > 0) meta = `${dayDiff} ${dayDiff === 1 ? 'day' : 'days'} late`;
            else if (mins > 0) meta = 'late';
            else meta = clockWords(due, tz);
        }
        (finished ? done : open).push({ kind: 'task', title: titles ? x.title : 'A task', meta, done: finished });
    }

    const g = t.goals?.[0];
    return {
        items: [...open, ...done],
        counts: {
            reviews: { done: plan?.doneToday?.length ?? 0, total: (plan?.planned?.length ?? 0) + (plan?.doneToday?.length ?? 0) },
            focus: { done: focus.filter((f) => f.done).length, total: focus.length },
            tasks: { done: tasksDone, total: tasks.length },
            minutesLeft: plan?.estMinutes ?? 0,
        },
        goal: g ? { title: titles ? g.title : 'Your goal', daysLeft: g.daysLeft, done: g.progress?.done ?? 0, total: g.progress?.total ?? 0 } : null,
    };
}

/** The day in numbers, as the pictures say it: "3 left today · about 21 min", "Done for today", "A free day". */
export function dayNumbers(a: Pick<Ambient, 'items' | 'counts'>): string {
    const items = a.items ?? [];
    if (!items.length) return 'A free day';
    const open = items.filter((i) => !i.done).length;
    if (!open) return 'Done for today';
    const minutes = a.counts?.minutesLeft ?? 0;
    return `${open} left today${minutes ? ` · about ${minutes} min` : ''}`;
}

/**
 * What is left by kind, in words, for the phone app's day card under its headline ("7 reviews · 2 tasks";
 * '' on a free or done day): the headline says how many and how long, this says what (B8).
 */
export function dayBreakdown(a: Pick<Ambient, 'counts'>): string {
    return kindWords(a.counts);
}

/** The drawing's version (11-16: the lock picture's full ring; B8: the type system and the home picture's zoom). */
const DRAWING = 'type-2';

/** A short fingerprint of everything the pictures draw (FNV-1a over the words). */
function pictureKey(a: Omit<Ambient, 'key' | 'updatedAt'>): string {
    // DRAWING: bumped when the drawing itself changes, so every phone fetches the new pictures.
    const text = JSON.stringify([DRAWING, a.state, a.date, a.headline, a.lines, a.mode, a.week, a.items, a.counts, a.goal, a.line?.text ?? null, ...(a.reminders?.length ? [a.reminders] : []), ...(a.insight ? [{ insight: a.insight }] : [])]);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface AmbientOptions {
    /**
     * false: no topic or focus names, only counts and plain words (the phone app's "Hide titles":
     * a lock screen is seen by anyone who picks the phone up). Default true.
     */
    titles?: boolean;
}

/** What to show, from the brief, the plan mode and the local hour (0–23). Pure: tested directly. */
export function ambientFor(b: Brief, mode: PlanMode, hour: number, date: string, now: Date = new Date(), options: AmbientOptions = {}): Ambient {
    const titles = options.titles !== false;
    const r = b.today.revisions;
    const openFocus = b.today.focus.filter((f) => !f.done);
    // His focus lines, or with titles hidden one count line in their place.
    const focusTexts = titles ? openFocus.map((f) => f.text) : openFocus.length ? [`Focus: ${openFocus.length} open`] : [];
    const next = b.next[0];
    const nextLine = next && titles ? `Next: ${next.topic.title}` : null;
    const tasksDue = b.tasks.dueToday + b.tasks.overdue;
    const base = { date, mode, updatedAt: now.toISOString() };

    const nothingLeft = r.planned === 0 && openFocus.length === 0 && tasksDue === 0;
    if (nothingLeft && (r.done > 0 || b.today.focus.length > 0 || hour >= 12)) {
        return { ...base, state: 'done', headline: '', lines: [] };
    }

    const revise = r.planned > 0 ? `${plural(r.planned, 'review')} · about ${r.estMinutes} min` : null;

    if (mode === 'busy' || mode === 'comeback') {
        const headline = mode === 'busy' ? (revise ? `A light day: ${revise}` : 'A light day') : revise ? `Welcome back: ${revise}` : 'Welcome back';
        return { ...base, state: 'rest', headline, lines: nextLine ? [nextLine] : [] };
    }

    if (hour < 12) {
        const lines = [nextLine, ...focusTexts.slice(0, 2), tasksDue > 0 ? `${plural(tasksDue, 'task')} due` : null].filter((x): x is string => !!x).slice(0, 3);
        return { ...base, state: 'morning', headline: revise ?? (focusTexts[0] ?? 'A free morning'), lines: revise ? lines : lines.filter((l) => l !== focusTexts[0]) };
    }
    if (hour < 18) {
        const focus = focusTexts[0];
        return { ...base, state: 'working', headline: focus ?? revise ?? 'Keep going', lines: focus && revise ? [revise] : [] };
    }
    const doneWords = r.done > 0 ? `${plural(r.done, 'review')} done today` : 'Nothing revised yet today';
    const left = r.planned > 0 ? `${r.planned} left · about ${r.estMinutes} min` : null;
    return { ...base, state: 'evening', headline: doneWords, lines: [left].filter((x): x is string => !!x) };
}

/** The local hour and a long date ("Sunday 15 November") in the user's zone. */
function localClock(now: Date, timezone: string): { hour: number; date: string } {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }).format(now)) % 24;
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(now).replace(',', '');
    return { hour, date };
}

/** His reminders still to come today (pending; a finished task's left out), soonest first, three at most. */
export async function todayReminders(userId: string, now: Date, tz: string, titles = true): Promise<AmbientReminder[]> {
    const rows = await prisma.reminder.findMany({
        where: { userId, status: 'pending', reminderDate: { gte: now, lt: new Date(now.getTime() + 24 * 3600_000) } },
        include: { todo: { select: { title: true, status: true } } },
        orderBy: { reminderDate: 'asc' },
        take: 8,
    });
    const today = dayOf(now, tz);
    return rows
        .filter((r) => r.todo?.status !== 'complete' && dayOf(r.reminderDate, tz) === today)
        .slice(0, 3)
        .map((r) => ({ at: clockWords(r.reminderDate, tz), text: titles ? reminderWords(r) : 'A reminder' }));
}

/** A reminder's words: its task's title (the stored message is "Reminder: <title>", and the picture and the phone say "reminder" already). */
function reminderWords(r: { message: string | null; todo: { title: string | null } | null }): string {
    return r.todo?.title?.trim() || r.message?.replace(/^\s*reminder:\s*/i, '').trim() || 'A reminder';
}

/** One reminder for the phone to ring (app 0.5.0). */
export interface AmbientAlarm {
    id: string;
    /** ISO */
    when: string;
    text: string;
}

/** How far ahead the phone sets alarms: past the next refresh by a margin, so a day's reminders are held all day. */
export const ALARM_HOURS = 26;

/**
 * His reminders still to come in the next 26 hours that the phone app rings for: his own (not a workspace task's, which emails
 * its assignees), pending, a finished task's left out; 20 at most. With titles hidden, plain words.
 */
export async function upcomingAlarms(userId: string, now: Date, titles = true): Promise<AmbientAlarm[]> {
    const rows = await prisma.reminder.findMany({
        where: { userId, status: 'pending', reminderDate: { gt: now, lte: new Date(now.getTime() + ALARM_HOURS * 3600_000) }, todo: { is: { workspaceId: null } } },
        include: { todo: { select: { title: true, status: true } } },
        orderBy: { reminderDate: 'asc' },
        take: 24,
    });
    return rows
        .filter((r) => r.todo?.status !== 'complete')
        .slice(0, 20)
        .map((r) => ({ id: r.id, when: r.reminderDate.toISOString(), text: titles ? reminderWords(r) : 'A reminder' }));
}

/** The phone app holds these reminders (it set their alarms): no email goes for them. His own pending future ones only. */
export async function markPhoneHeld(userId: string, ids: readonly string[], now: Date = new Date()): Promise<{ held: number }> {
    if (!ids.length) return { held: 0 };
    const { count } = await prisma.reminder.updateMany({
        where: { id: { in: [...ids] }, userId, status: 'pending', reminderDate: { gt: now }, todo: { is: { workspaceId: null } } },
        data: { phoneAt: now },
    });
    return { held: count };
}

export async function getAmbient(userId: string, now: Date = new Date(), options: AmbientOptions = {}): Promise<Ambient> {
    const titles = options.titles !== false;
    const [brief, today, line, insight] = await Promise.all([
        getBrief(userId, {}, now),
        getToday(userId, now),
        titles ? currentLine(userId, now) : Promise.resolve(null),
        titles ? currentInsight(userId, now) : Promise.resolve(null),
    ]);
    const reminders = await todayReminders(userId, now, brief.now.timezone, titles);
    const { hour, date } = localClock(now, brief.now.timezone);
    const mode = (today.plan?.mode ?? 'normal') as PlanMode;
    const week = today.stats?.rhythm?.last7?.map((d) => ({ day: d.day, active: d.active }));
    const day = dayItems(today, now, titles);
    const buddyLine = line && line.lockOk && !line.fallback ? { dayId: line.dayId, slot: line.slot, text: line.text } : null;
    const a = { ...ambientFor(brief, mode, hour, date, now, options), ...(week?.length === 7 ? { week } : {}), ...day, line: buddyLine, ...(reminders.length ? { reminders } : {}), ...(insight ? { insight: insight.text } : {}) };
    return { ...a, key: pictureKey(a) };
}

// ── The wallpaper ────────────────────────────────────────────────────────────────────────

/** Inter (SIL OFL 1.1, assets/fonts): the picture looks the same on any server, with or without fonts of its own. */
export const WALLPAPER_FONTS = ['Regular', 'Medium', 'SemiBold', 'Bold'].map((w) => path.resolve(__dirname, '..', '..', '..', 'assets', 'fonts', `Inter-${w}.ttf`));

export type WallpaperScreen = 'home' | 'lock';

/** How a picture is drawn beyond the day: its style and colour, and the zoom the phone shows it at (B8). */
export interface PictureLook {
    style?: string;
    color?: string;
    zoom?: number;
    /** The live lock screen's band for the phone's notification icons (app 0.4.0). */
    iconSlot?: boolean;
}

/** The wallpaper as SVG (wallpaperArt.ts): the home picture (the day in numbers) or the lock picture (the ring and the buddy's line, or the dial). */
export function wallpaperSvg(a: Ambient, width: number, height: number, theme: 'light' | 'dark', screen: WallpaperScreen = 'home', look: PictureLook = {}): string {
    const input = {
        ...(look.style ? { style: look.style } : {}),
        ...(look.color ? { color: look.color } : {}),
        ...(look.zoom && look.zoom !== 1 ? { zoom: look.zoom } : {}),
        ...(look.iconSlot ? { iconSlot: true } : {}),
        state: a.state,
        date: a.date,
        headline: a.headline,
        lines: a.lines,
        ...(a.week ? { week: a.week } : {}),
        ...(a.items ? { items: a.items } : {}),
        ...(a.counts ? { counts: a.counts } : {}),
        ...(a.goal !== undefined ? { goal: a.goal } : {}),
        line: a.line?.text ?? null,
        ...(a.reminders?.length ? { reminders: a.reminders } : {}),
        ...(a.insight ? { insight: a.insight } : {}),
    };
    return screen === 'lock' ? drawLock(input, width, height, theme) : drawWallpaper(input, width, height, theme);
}

/** The wallpaper as a PNG, sized for the phone (pixels, not CSS px). */
/** The picture with the place of the notification icons' band when one was asked for ("cy,size,#AARRGGBB"), else null. */
export function wallpaperPngWithSlot(a: Ambient, width: number, height: number, theme: 'light' | 'dark', screen: WallpaperScreen = 'home', look: PictureLook = {}): { png: Buffer; slot: string | null } {
    const svg = wallpaperSvg(a, width, height, theme, screen, look);
    const slot = /^<svg [^>]*data-icons="([^"]+)"/.exec(svg)?.[1] ?? null;
    return { png: svgToPng(svg, width, height, 1, Math.max(width, height), WALLPAPER_FONTS).png, slot };
}

export function wallpaperPng(a: Ambient, width: number, height: number, theme: 'light' | 'dark', screen: WallpaperScreen = 'home', look: PictureLook = {}): Buffer {
    return svgToPng(wallpaperSvg(a, width, height, theme, screen, look), width, height, 1, Math.max(width, height), WALLPAPER_FONTS).png;
}
