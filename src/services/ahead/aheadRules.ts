// What is ahead (ECOSYSTEM_V2_PLAN stage 16): the pure rules every surface reads, so the lock picture, the home picture,
// the widget, the night and the pulses say the same. Three readers:
// - todayRows (the lock picture: now): today's things with a time still to come, soonest first (their reminders and
//   Buddy's, an event with a time, a task with a real time), then today's tasks without a time, then late ones;
// - comingUp (the home picture and the night: ahead): the next seven days after today, their dated to-dos and events;
// - leftOff (the home picture's Pick up and the night): a problem or topic they stopped before finishing, this week.
// The database is read by ahead.service.ts; nothing here touches it.
import { addDays, dayOf, startOfDay, type DayString } from '../learning';

export type AheadKind = 'reminder' | 'task' | 'event' | 'pickup';

/** One row on a screen: "7 pm · Call the bank", "Sun · Sister's birthday", Pick up "3Sum". */
export interface AheadRow {
    /** rm_<reminder>, br_<Buddy's reminder>, tk_<task>, th_<event thread>, pu_<session>. */
    id: string;
    kind: AheadKind;
    /** Their words, or plain words with titles hidden. */
    text: string;
    /** Today: "7 pm", "late" or ""; ahead: "Sun", "Thu 3 pm"; Pick up: "". */
    at: string;
    /** Its moment (ISO), for order and an end time; none when it has no time. */
    when: string | null;
    day: DayString;
    /** Pick up: where they stopped. */
    detail?: string;
    /** Pick up: the problem's page, when the session had one. */
    url?: string | null;
    /** Pick up: the topic's doc. */
    docId?: string | null;
    /** Pick up: a practice problem or a study topic (the night reads it). */
    what?: 'practice' | 'study';
}

export interface ReminderIn {
    id: string;
    by: 'you' | 'buddy';
    when: Date;
    text: string;
    taskId: string | null;
}

export interface TaskIn {
    id: string;
    title: string;
    dueDate: Date | null;
    /** Its next pending reminder, when it has one (a task with no day is ahead on that reminder's day). */
    nextReminder: Date | null;
}

export interface EventIn {
    id: string;
    title: string;
    day: DayString;
    /** Its time of day in minutes, when their words gave one. */
    minute: number | null;
}

export interface SessionIn {
    id: string;
    kind: string;
    problem: string | null;
    outcome: string | null;
    topicId: string | null;
    topicTitle: string | null;
    topicDone: boolean;
    nextStep: string | null;
    url: string | null;
    docId: string | null;
    day: DayString;
    startedAt: Date;
    updatedAt: Date;
}

/** Plain words for an item when the phone hides titles (a lock screen is seen by anyone nearby). */
const PLAIN: Record<AheadKind, string> = { reminder: 'A reminder', task: 'A task', event: 'An event', pickup: 'Something you were working on' };

/** "7 pm", "6:30 pm" in their zone. */
export function clockWords(d: Date, tz: string): string {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const half = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase().replace(/\./g, '');
    return minute === '00' ? `${hour} ${half}` : `${hour}:${minute} ${half}`;
}

/** Minutes after their midnight. */
const minuteOfDay = (d: Date, tz: string): number => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    return (Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24) * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
};

/**
 * A due date that only names a day: the app stores a day-only due date at 18:00 their time (DATE_ONLY_DEFAULT_HOUR, the
 * buddy's tasks too), a goal's at the day's last millisecond. Those show no time.
 */
export function dayOnly(due: Date, tz: string): boolean {
    const m = minuteOfDay(due, tz);
    return (m === 18 * 60 && due.getUTCSeconds() === 0 && due.getUTCMilliseconds() === 0) || (m === 23 * 60 + 59 && due.getUTCMilliseconds() === 999);
}

const weekday = (day: DayString) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(new Date(`${day}T12:00:00Z`));

/** "Sun", "Thu 3 pm" (a time in their zone when the item has one). */
export function aheadWords(day: DayString, at: Date | null, tz: string): string {
    return at ? `${weekday(day)} ${clockWords(at, tz)}` : weekday(day);
}

const minuteAt = (day: DayString, minute: number, tz: string) => new Date(startOfDay(day, tz).getTime() + minute * 60_000);

/**
 * The lock picture's rows (now): today's things with a time still to come, soonest first; then today's tasks without a
 * time; then late tasks (the newest first). A task shown through its own reminder today appears once; anything under
 * a pending Later is left out until its time; at most `max`.
 */
export function todayRows(input: { now: Date; tz: string; reminders: readonly ReminderIn[]; tasks: readonly TaskIn[]; events: readonly EventIn[]; hidden?: ReadonlySet<string> }, titles = true, max = 3): AheadRow[] {
    const { now, tz } = input;
    const today = dayOf(now, tz);
    const hidden = input.hidden ?? new Set<string>();
    const word = (kind: AheadKind, text: string) => (titles ? text : PLAIN[kind]);
    const timed: Array<AheadRow & { t: number }> = [];
    for (const r of input.reminders) {
        if (dayOf(r.when, tz) !== today) continue;
        timed.push({ id: `${r.by === 'buddy' ? 'br' : 'rm'}_${r.id}`, kind: 'reminder', text: word('reminder', r.text), at: clockWords(r.when, tz), when: r.when.toISOString(), day: today, t: r.when.getTime() });
    }
    for (const e of input.events) {
        if (e.day !== today || e.minute == null) continue;
        const at = minuteAt(e.day, e.minute, tz);
        if (at.getTime() <= now.getTime()) continue;
        timed.push({ id: `th_${e.id}`, kind: 'event', text: word('event', e.title), at: clockWords(at, tz), when: at.toISOString(), day: today, t: at.getTime() });
    }
    const throughReminder = new Set(input.reminders.filter((r) => r.taskId && dayOf(r.when, tz) === today).map((r) => r.taskId!));
    const untimed: AheadRow[] = [];
    const late: Array<AheadRow & { t: number }> = [];
    for (const k of input.tasks) {
        if (!k.dueDate || throughReminder.has(k.id)) continue;
        const day = dayOf(k.dueDate, tz);
        if (day > today) continue;
        const row = { id: `tk_${k.id}`, kind: 'task' as const, text: word('task', k.title), day };
        if (day < today) late.push({ ...row, at: 'late', when: k.dueDate.toISOString(), t: k.dueDate.getTime() });
        else if (dayOnly(k.dueDate, tz)) untimed.push({ ...row, at: '', when: null });
        else if (k.dueDate.getTime() > now.getTime()) timed.push({ ...row, at: clockWords(k.dueDate, tz), when: k.dueDate.toISOString(), t: k.dueDate.getTime() });
        else late.push({ ...row, at: 'late', when: k.dueDate.toISOString(), t: k.dueDate.getTime() });
    }
    timed.sort((a, b) => a.t - b.t);
    late.sort((a, b) => b.t - a.t);
    const strip = ({ t: _t, ...row }: AheadRow & { t: number }): AheadRow => row;
    return [...timed.map(strip), ...untimed, ...late.map(strip)].filter((r) => !hidden.has(r.id)).slice(0, max);
}

/** How far ahead "Coming up" looks: the seven days after today. */
export const AHEAD_DAYS = 7;

/**
 * Coming up (the home picture, the night): their open dated to-dos (the due day, else the day of their next reminder)
 * and event threads in the seven days after today, soonest first (a day-only item before the timed ones of its day).
 */
export function comingUp(input: { now: Date; tz: string; tasks: readonly TaskIn[]; events: readonly EventIn[]; hidden?: ReadonlySet<string> }, titles = true, max = 3): AheadRow[] {
    const { now, tz } = input;
    const today = dayOf(now, tz);
    const last = addDays(today, AHEAD_DAYS);
    const hidden = input.hidden ?? new Set<string>();
    const rows: Array<AheadRow & { key: string }> = [];
    for (const k of input.tasks) {
        const at = k.dueDate ?? k.nextReminder;
        if (!at) continue;
        const day = dayOf(at, tz);
        if (day <= today || day > last) continue;
        const timed = k.dueDate ? !dayOnly(k.dueDate, tz) : true;
        rows.push({ id: `tk_${k.id}`, kind: 'task', text: titles ? k.title : PLAIN.task, at: aheadWords(day, timed ? at : null, tz), when: timed ? at.toISOString() : null, day, key: `${day} ${timed ? String(minuteOfDay(at, tz)).padStart(4, '0') : '0000'}` });
    }
    for (const e of input.events) {
        if (e.day <= today || e.day > last) continue;
        const at = e.minute != null ? minuteAt(e.day, e.minute, tz) : null;
        rows.push({ id: `th_${e.id}`, kind: 'event', text: titles ? e.title : PLAIN.event, at: aheadWords(e.day, at, tz), when: at?.toISOString() ?? null, day: e.day, key: `${e.day} ${e.minute != null ? String(e.minute).padStart(4, '0') : '0000'}` });
    }
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return rows.filter((r) => !hidden.has(r.id)).slice(0, max).map(({ key: _key, ...r }) => r);
}

/** A left-off item is this week's (the seven days to today). */
export const LEFT_OFF_DAYS = 7;
/** A session touched this recently is still going: not left off yet. */
export const STILL_GOING_MS = 45 * 60_000;

/**
 * Left off (Pick up; the night): per problem or topic, its newest session of the last seven days when it is unfinished:
 * a practice problem with no outcome, or a study topic not done with a next step. Never a build or review session
 * (work folders' sessions are builds). A later session on the same problem or topic replaces it; solved or done, it
 * is gone. Newest first.
 */
export function leftOff(input: { now: Date; tz: string; sessions: readonly SessionIn[]; hidden?: ReadonlySet<string> }, titles = true, max = 3): AheadRow[] {
    const { now, tz } = input;
    const from = addDays(dayOf(now, tz), -(LEFT_OFF_DAYS - 1));
    const hidden = input.hidden ?? new Set<string>();
    const newest = new Map<string, SessionIn>();
    for (const s of input.sessions) {
        if (s.day < from) continue;
        const key = s.kind === 'practice' && s.problem?.trim() ? `p:${s.problem.trim().toLowerCase()}` : s.kind === 'study' && s.topicId ? `t:${s.topicId}` : null;
        if (!key) continue;
        const had = newest.get(key);
        if (!had || s.startedAt.getTime() > had.startedAt.getTime()) newest.set(key, s);
    }
    const rows: Array<AheadRow & { t: number }> = [];
    for (const s of newest.values()) {
        const unfinished = s.kind === 'practice' ? !s.outcome : !s.topicDone && !!s.nextStep?.trim();
        if (!unfinished || now.getTime() - s.updatedAt.getTime() < STILL_GOING_MS) continue;
        const title = (s.kind === 'practice' ? s.problem : s.topicTitle)?.trim() || '';
        if (!title) continue;
        rows.push({
            id: `pu_${s.id}`,
            kind: 'pickup',
            text: titles ? title : PLAIN.pickup,
            at: '',
            when: null,
            day: s.day,
            detail: titles ? (s.nextStep?.trim() ?? '') : '',
            url: s.url,
            docId: s.docId,
            what: s.kind === 'practice' ? 'practice' : 'study',
            t: s.startedAt.getTime(),
        });
    }
    rows.sort((a, b) => b.t - a.t);
    return rows.filter((r) => !hidden.has(r.id)).slice(0, max).map(({ t: _t, ...r }) => r);
}
