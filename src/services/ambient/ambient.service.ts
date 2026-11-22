// The ambient phone (ECOSYSTEM_PLAN §10 step a; ALWAYS_ON_SPEC 6.6): a wallpaper picture and a small
// widget summary, both drawn from the brief. States, not statistics: what today holds in the morning,
// the focus line while working, one line on the day in the evening, a clean picture when the day is
// done, lighter in busy and comeback modes. Never red, never an overdue count as the headline.
import { getBrief, type Brief } from '../brief/brief.service';
import { currentInsight, currentLine } from '../buddy/voice';
import { openAsks } from '../buddy/asks';
import { activePin } from '../reminders/lockPins.service';
import { getToday } from '../learningDb/today.service';
import type { PlanMode } from '../learning/plan';
import { dayOf } from '../learning/time';
import { loadLearningContext } from '../learningDb/common';
import path from 'node:path';
import { svgToPng } from '../docs/diagram/png';
import { prisma } from '../../db/prisma';
import { aheadFor, reminderWords, remindersOfToday, type AheadRow } from '../ahead/ahead.service';
import { clockWords } from '../ahead/aheadRules';
import { cardOf, ownReminderAt, pickCard, usualEvening, type NextCard } from '../ahead/later';

/** Stage 19: the first phone app with the widget's card and Later. */
export const CARD_APP = '0.7.0';
import { poke } from '../scheduler/scheduler';
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
    /** The nearest active goal (the lock picture's last line): only with their switch on (stage 16: a goal may be private). */
    goal?: AmbientGoal | null;
    /**
     * The buddy's line for now (BUDDY_MEMORY_PLAN §3.4), only one the lock check passed (never with
     * titles hidden): the lock picture's main words and the widget's line.
     */
    line?: { dayId: string; slot: string; text: string; until?: string; key?: string; askId?: string; pinId?: string } | null;
    /**
     * Today's reminders still to come (the owner, 11-16: "the home screen could show my reminders; if there
     * are none it stays clean"), soonest first, three at most; with titles hidden, plain words.
     */
    reminders?: AmbientReminder[];
    /**
     * The buddy's thought for the home screen today (the owner, 11-16: the home screen lists what matters,
     * reminders or a suggestion or insight from the buddy; the lock screen keeps the line): only one the
     * lock check passed, never with titles hidden; none: the picture stays as it is.
     */
    insight?: string;
    /** Stage 6 (app 0.6.0): when the home thought ends (ISO; every word on a screen has an end time, §4.13). */
    insightUntil?: string;
    /** Stage 6 (app 0.6.0 and later only): the buddy's open questions for the phone, with their quick answers. */
    asks?: PhoneAsk[];
    /** Stage 16: the lock picture's rows (now): today's next scheduled things, three at most ("7 pm · Call the bank"). */
    today?: AmbientRow[];
    /** 11-21: the rows of the plain twin when Buddy's line stands in for one of them (a Later back at its time, once). */
    todayPlain?: AmbientRow[];
    /** Stage 16: the home picture's Pick up (ahead): a problem or topic left unfinished this week, or none. */
    pickUp?: AmbientRow | null;
    /** Stage 16: the home picture's Coming up (ahead): the next days' dated to-dos and events, three at most. */
    comingUp?: AmbientRow[];
    /** Stage 19 (app 0.7.0 and later): the widget's card, one item with Later; none: the widget shows the day's numbers. */
    next?: NextCard | null;
    /** Changes whenever either picture would: the phone app fetches them again only then. */
    key?: string;
    /** Stage 6: the key of the plain twins (the pictures without the buddy's words). */
    plainKey?: string;
}

/** One of the buddy's questions on the phone (app 0.6.0): a silent notification with its quick answers and a reply box. */
export interface PhoneAsk {
    _id: string;
    text: string;
    answers: Array<{ label: string; meaning: string }>;
    /** ISO: the notification removes itself then. */
    until: string;
    /** The lock check passed its words: shown on the lock screen (else the notification hides them there). */
    lockOk: boolean;
}

/** The first phone app that can drop words by itself (§4.14): questions reach the phone only from it on. */
export const ASKS_APP = '0.6.0';

/** "0.6.0", "0.6.1-qa": at least `min`? An unknown or missing version is an older app. */
export function appAtLeast(app: string | null | undefined, min: string): boolean {
    const v = /^(\d+)\.(\d+)\.(\d+)/.exec(app ?? '');
    if (!v) return false;
    const m = min.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const d = Number(v[i + 1]) - (m[i] ?? 0);
        if (d !== 0) return d > 0;
    }
    return true;
}

/** Stage 16: one row of what is ahead as the pictures draw it ("7 pm" · "Call the bank"; Pick up: its title and where they stopped). */
export interface AmbientRow {
    id: string;
    at: string;
    text: string;
    detail?: string;
}

const rowOf = (r: AheadRow): AmbientRow => ({ id: r.id, at: r.at, text: r.text, ...(r.detail ? { detail: r.detail } : {}) });

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

/** The day in numbers, as the widget says it: "3 left today", "Done for today", "A free day" (stage 16: no estimated time, the owner's word). */
export function dayNumbers(a: Pick<Ambient, 'items' | 'counts'>): string {
    const items = a.items ?? [];
    if (!items.length) return 'A free day';
    const open = items.filter((i) => !i.done).length;
    if (!open) return 'Done for today';
    return `${open} left today`;
}

/**
 * What is left by kind, in words, for the phone app's day card under its headline ("7 reviews · 2 tasks";
 * '' on a free or done day): the headline says how many and how long, this says what (B8).
 */
export function dayBreakdown(a: Pick<Ambient, 'counts'>): string {
    return kindWords(a.counts);
}

/** The drawing's version (11-16: the lock picture's full ring; B8: the type system and the home picture's zoom; stage 16: the lock is now, the home is ahead; 11-21: the lock's three groups at the left, Buddy's mark, the blue ring, sentence case). */
const DRAWING = 'type-7'; // 11-22: the lock and home layouts (glass, stack) and the lock group under the clock

/** A short fingerprint of everything the pictures draw (FNV-1a over the words). */
function pictureKey(a: Omit<Ambient, 'key' | 'updatedAt'>): string {
    // DRAWING: bumped when the drawing itself changes, so every phone fetches the new pictures.
    const rows = (list: readonly AmbientRow[] | undefined) => (list ?? []).map((r) => [r.at, r.text, r.detail ?? '']);
    const text = JSON.stringify([DRAWING, a.state, a.date, a.headline, a.lines, a.mode, a.week, a.items, a.counts, a.goal ?? null, a.line?.text ?? null, rows(a.today), a.pickUp ? rows([a.pickUp]) : null, rows(a.comingUp), ...(a.insight ? [{ insight: a.insight }] : [])]);
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
    /** The phone app's version ("0.6.0"): from 0.6.0 its day carries the questions (§4.14). */
    app?: string | null;
    /** The phone is in its quiet hours: no questions (one fetched then never showed, so it is not marked shown). */
    quiet?: boolean;
    /** Stage 19: where a card's doc opens (the web app's address). */
    appUrl?: string | null;
    /** Stage 19: a widget shows the card on the home screen, so the home picture leaves that item out (`card=0`). */
    withoutCard?: boolean;
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

    // Stage 16: no estimated time on the screens (the owner, 11-20: "the expected time doesn't make sense").
    const revise = r.planned > 0 ? plural(r.planned, 'review') : null;

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
    const left = r.planned > 0 ? `${r.planned} left` : null;
    return { ...base, state: 'evening', headline: doneWords, lines: [left].filter((x): x is string => !!x) };
}

/** The local hour and a long date ("Sunday 15 November") in the user's zone. */
function localClock(now: Date, timezone: string): { hour: number; date: string } {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }).format(now)) % 24;
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(now).replace(',', '');
    return { hour, date };
}

/** Stage 7: how long a silent reminder stays on the home picture past its time (the reader moved to ahead.service, stage 16). */
export { SILENT_STAYS_MS } from '../ahead/ahead.service';

/** His reminders still to come today (pending; a finished task's left out), soonest first, three at most; a silent one also until 2 hours past its time (the home picture). */
export async function todayReminders(userId: string, now: Date, tz: string, titles = true): Promise<AmbientReminder[]> {
    return (await remindersOfToday(userId, now, tz)).slice(0, 3).map((r) => ({ at: clockWords(r.when, tz), text: titles ? r.text : 'A reminder' }));
}

/** Stage 7 (V2): one of today's reminders on the web's Home. */
export interface HomeReminder {
    _id: string;
    /** ISO instant. */
    at: string;
    /** HH:mm, his clock. */
    time: string;
    text: string;
    /** It rings (an alarm on the phone, an email), or it is silent: it shows on his home screens, until 2 hours past its time. */
    ring: boolean;
    /** daily | weekdays | weekly, or null. */
    repeat: string | null;
    /** Its time has passed (only a silent one stays). */
    past: boolean;
    /** His own (a task's reminder) or the buddy's. */
    by: 'you' | 'buddy';
    taskId: string | null;
}
/** The web shows a few more than the picture's three. */
export const HOME_REMINDERS_MAX = 6;

/**
 * Stage 7 (V2): today's reminders for the web's Home, by the home picture's rule (a silent reminder never rings or
 * emails, so this and his phone's home screen are where he sees it), with the buddy's name for its own.
 */
export async function homeReminders(userId: string, now: Date = new Date()): Promise<{ items: HomeReminder[]; name: string | null }> {
    const [{ tz }, state] = await Promise.all([loadLearningContext(userId, now), prisma.buddyState.findUnique({ where: { userId }, select: { name: true } })]);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const items = (await remindersOfToday(userId, now, tz)).slice(0, HOME_REMINDERS_MAX).map((r) => ({
        _id: r.id,
        at: r.when.toISOString(),
        time: time.format(r.when),
        text: r.text,
        ring: r.ring,
        repeat: r.repeat,
        past: r.when.getTime() <= now.getTime(),
        by: r.by,
        taskId: r.taskId,
    }));
    return { items, name: state?.name ?? null };
}

/** A reminder's words: its task's title (the stored message is "Reminder: <title>", and the picture and the phone say "reminder" already). */
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
        // Stage 7: ringing ones only; a silent one never rings.
        where: { userId, status: 'pending', silent: false, reminderDate: { gt: now, lte: new Date(now.getTime() + ALARM_HOURS * 3600_000) }, todo: { is: { workspaceId: null } } },
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
    if (count > 0) poke('reminders'); // the phone has them: no email, so the next due one may be later
    return { held: count };
}

export async function getAmbient(userId: string, now: Date = new Date(), options: AmbientOptions = {}): Promise<Ambient> {
    const titles = options.titles !== false;
    // Stage 6 (§4.14): questions reach the phone only from app 0.6.0, which drops them by itself at their end
    // time, in quiet hours and offline; never with titles hidden. The notification's surface rules apply.
    const withAsks = titles && appAtLeast(options.app, ASKS_APP) && !options.quiet;
    const [brief, today, line, insight, asks, pin, ahead, state] = await Promise.all([
        getBrief(userId, {}, now),
        getToday(userId, now),
        titles ? currentLine(userId, now) : Promise.resolve(null),
        titles ? currentInsight(userId, now) : Promise.resolve(null),
        withAsks ? openAsks(userId, 'notification', now) : Promise.resolve([]),
        // Stage 7 (V1): his own pin, his words for the lock screen: it shows whatever "Hide titles" says.
        activePin(userId, now),
        // Stage 16: what is ahead (the lock's rows, Pick up, Coming up): code only, so an account with no AI has it too.
        // One row more than shown: a row Buddy's line covers (below) leaves room for the next.
        aheadFor(userId, now, { titles, leftMax: 3, todayMax: TODAY_ROWS + 1 }),
        prisma.buddyState.findUnique({ where: { userId }, select: { goalOnScreens: true } }),
    ]);
    const reminders = await todayReminders(userId, now, brief.now.timezone, titles);
    const { hour, date } = localClock(now, brief.now.timezone);
    const mode = (today.plan?.mode ?? 'normal') as PlanMode;
    const week = today.stats?.rhythm?.last7?.map((d) => ({ day: d.day, active: d.active }));
    const day = dayItems(today, now, titles);
    // App 0.6.0: its end time, and its key for his thumbs (stage 7: a timed line's start; two may share a part of the day).
    const buddyLine = line && line.lockOk && !line.fallback ? { dayId: line.dayId, slot: line.slot, text: line.text, ...(withAsks ? { until: line.until, key: line.key } : {}) } : null;
    // App 0.6.0: a question the lock check passed is the lock line while it is open (it beats a line: never both about one thread on a day).
    const lockAsk = asks.find((q) => q.lockOk);
    const askLine = lockAsk ? { dayId: buddyLine?.dayId ?? '', slot: buddyLine?.slot ?? line?.slot ?? 'evening', text: lockAsk.text, until: lockAsk.until, askId: lockAsk._id } : buddyLine;
    // His pin wins in its window (stage 7); the phone drops it at its end time (app 0.6.0).
    const shownLine = pin ? { dayId: '', slot: line?.slot ?? 'evening', text: pin.text, until: pin.until, pinId: pin.id } : askLine;
    const lineRefs = line?.refs ?? [];
    // Once (the owner, 11-21): a Later whose time has come shows on the lock screen once: as Buddy's line when the line
    // shown rests on it (its row then goes), else as its row; never on the home picture or the widget.
    const lineShown = !pin && !lockAsk && !!buddyLine;
    const covered = new Set(lineShown ? ahead.returned.filter((r) => lineRefs.includes(r.ref)).map((r) => r.rowId) : []);
    const backRows = new Set(ahead.returned.map((r) => r.rowId));
    const rowsShown = ahead.today.filter((r) => !covered.has(r.id)).slice(0, TODAY_ROWS);
    // The plain twin has no line, so a covered row is back there.
    const rowsPlain = ahead.today.slice(0, TODAY_ROWS);
    // Stage 19 (app 0.7.0): the widget's card, one item with Later (the one Buddy's line rests on first); never what a
    // Later brought back to the lock screen.
    const cardRow = pickCard({ today: rowsShown.filter((r) => !backRows.has(r.id) && !ahead.deferred.has(r.id) && !ahead.deferRows.has(r.id)), comingUp: ahead.comingUp, leftOff: ahead.leftOff, lineRefs, todayDay: dayOf(now, brief.now.timezone) });
    const withCard = appAtLeast(options.app, CARD_APP);
    // Their own reminder for the card's item still ahead: Later keeps its time (the owner, 11-21).
    const own = withCard && cardRow ? await ownReminderAt(userId, cardRow.id, now) : null;
    const next = withCard && cardRow ? cardOf(cardRow, { now, tz: brief.now.timezone, usual: await usualEvening(userId, now, brief.now.timezone), appUrl: options.appUrl ?? null, own }) : null;
    const notCard = (r: AheadRow) => !(options.withoutCard && cardRow && r.id === cardRow.id);
    const phoneAsks: PhoneAsk[] = asks.map((q) => ({ _id: q._id, text: q.text, answers: q.answers, until: q.until, lockOk: q.lockOk }));
    const a = {
        ...ambientFor(brief, mode, hour, date, now, options),
        ...(week?.length === 7 ? { week } : {}),
        ...day,
        // Stage 16: the goal on the pictures only with their switch on (the owner, 11-20: a goal may be private).
        goal: state?.goalOnScreens ? day.goal : null,
        today: rowsShown.map(rowOf),
        ...(covered.size ? { todayPlain: rowsPlain.map(rowOf) } : {}),
        pickUp: ahead.leftOff.filter(notCard)[0] ? rowOf(ahead.leftOff.filter(notCard)[0]!) : null,
        comingUp: ahead.comingUp.filter(notCard).map(rowOf),
        ...(withCard ? { next } : {}),
        line: shownLine,
        ...(reminders.length ? { reminders } : {}),
        ...(insight ? { insight: insight.text, ...(withAsks ? { insightUntil: insight.until } : {}) } : {}),
        ...(withAsks ? { asks: phoneAsks } : {}),
    };
    // The plain twins (stage 6): the same pictures without the buddy's words; their own key.
    const { insight: _insight, insightUntil: _until, asks: _asks, todayPlain: _plainRows, ...rest } = a as typeof a & { insight?: string; insightUntil?: string; asks?: PhoneAsk[]; todayPlain?: AmbientRow[] };
    void _insight;
    void _until;
    void _asks;
    void _plainRows;
    return { ...a, key: pictureKey(a), ...(withAsks ? { plainKey: pictureKey({ ...rest, line: null, today: rowsPlain.map(rowOf) }) } : {}) };
}

/** The lock picture's rows: today's next things, three at most (stage 16). */
export const TODAY_ROWS = 3;

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
    /** The picture's layout (the owner, 11-22: his choice per screen in the app): 'glass' or 'stack'; none: the classic one. */
    layout?: 'glass' | 'stack';
}

/** The wallpaper as SVG (wallpaperArt.ts): the home picture (the day in numbers) or the lock picture (the ring and the buddy's line, or the dial). */
export function wallpaperSvg(a: Ambient, width: number, height: number, theme: 'light' | 'dark', screen: WallpaperScreen = 'home', look: PictureLook = {}): string {
    const input = {
        ...(look.style ? { style: look.style } : {}),
        ...(look.color ? { color: look.color } : {}),
        ...(look.zoom && look.zoom !== 1 ? { zoom: look.zoom } : {}),
        ...(look.iconSlot ? { iconSlot: true } : {}),
        ...(look.layout ? { layout: look.layout } : {}),
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
        // Stage 16: the lock is now (today's rows), the home is ahead (Pick up, Coming up).
        ...(a.today?.length ? { today: a.today } : {}),
        ...(a.pickUp ? { pickUp: a.pickUp } : {}),
        ...(a.comingUp?.length ? { comingUp: a.comingUp } : {}),
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
