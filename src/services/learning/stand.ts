/**
 * Where you stand (WHERE_YOU_STAND_PLAN §5), pure: no DB, no clock. A person's record over a window
 * (the last 7 days, 4 weeks or 52 weeks, ending today) against the same span before it, in three
 * dimensions: consistency, effort and what it is paying off; and the verdict at the top of the page,
 * two or three sentences written by code from the same numbers (never a model).
 *
 *   spanEnding / spanBefore   the rolling windows (multiples of 7 days, so weekdays line up)
 *   recordStartOf             the first day the record holds anything
 *   activeDaySet              the rhythm's rule (rhythm.ts) over any span
 *   measures                  every number of one span
 *   compareWords              "2 more than", "1 h 10 min less than", "the same as"
 *   goalLineOf                the goal the verdict speaks about
 *   verdictLines              the sentences
 *   buildStand                all three windows and the last 364 days, in one object
 *
 * A comparison is only ever made against a span the record covers in full: when the record starts
 * inside the span before, `before` is null and the page says where the record starts.
 *
 * PERSONAL_OFFICE_PLAN (11-23): a lens picks the sessions (personal, work or all). The service hands in only the
 * rows its lens sees (the Work lens: work sessions and nothing else, since reviews, focus lines and goals are
 * learning); here the lens only changes the words: "worked" for the Work lens, the split for All.
 * STUDY_FLOW_PLAN §4.5: Learning (the Personal record without build sessions) says "studied"; Building (build
 * sessions only, as Work) says "built" and where most of the time went.
 */
import { addDays, diffDays, type DayString } from './time';
import type { MinutesByKind, PaceStatus } from './pace';

/** Which sessions the record is read through (PERSONAL_OFFICE_PLAN; services/learningDb/lens.ts). */
export type StandLens = 'personal' | 'learning' | 'building' | 'work' | 'all' | 'learning_work' | 'building_work';
export type StandArea = 'personal' | 'work';
/** A day's tooltip names at most this many places its time went. */
export const DAY_PLACES = 3;

export type StandWindow = 'week' | 'month' | 'year';
export const STAND_WINDOWS: readonly StandWindow[] = ['week', 'month', 'year'];
export const WINDOW_DAYS: Record<StandWindow, number> = { week: 7, month: 28, year: 364 };
/** How far back the record is read: the year and the year before it. */
export const STAND_LOOKBACK_DAYS = 2 * WINDOW_DAYS.year;
/** The day grid and the hours: the last 52 weeks. */
export const STAND_GRID_DAYS = WINDOW_DAYS.year;
/** A day with at least this many minutes logged is a day with a sitting. */
export const SITTING_MINUTES = 30;
/** Minutes this close read as "about the same" in words. */
export const SAME_MINUTES = 15;
/** Titles in the verdict are clipped to this many characters. */
const TITLE_CHARS = 40;

export type StandKind = keyof MinutesByKind;
const KINDS: readonly StandKind[] = ['study', 'practice', 'build', 'review'];

export interface Span {
    /** Inclusive. */
    from: DayString;
    /** Inclusive; today for the current span. */
    to: DayString;
}

/** What the service loads, every instant already turned into the user's local day. */
export interface StandRows {
    /** `area`: personal or work; `place`: where the time went (its folder, else its subject), for a day's words. */
    sessions: ReadonlyArray<{ day: DayString; kind: StandKind; minutes: number | null; outcome: 'alone' | 'hints' | 'after_answer' | null; area?: StandArea; place?: string | null }>;
    revisions: ReadonlyArray<{ scheduledFor: DayString; completedDay: DayString | null; status: 'pending' | 'done' | 'missed' }>;
    topicsDone: ReadonlyArray<{ doneDay: DayString; subjectId: string }>;
    focus: ReadonlyArray<{ day: DayString; done: boolean }>;
    targets: ReadonlyArray<{ weekStart: DayString; status: 'open' | 'done' | 'dropped' }>;
    milestonesDone: readonly DayString[];
    weakSpots: ReadonlyArray<{ createdDay: DayString; clearedDay: DayString | null }>;
    recallSets: ReadonlyArray<{ finishedDay: DayString; result: 'strong' | 'partial' | 'weak' }>;
    /** Not trashed, not archived. */
    docs: ReadonlyArray<{ createdDay: DayString; updatedDay: DayString }>;
    subjects: ReadonlyArray<{ id: string; name: string }>;
}

export interface Measures {
    /** The span's days the record covers (the span's length unless the record starts inside it). */
    days: number;
    activeDays: number;
    /** Days with SITTING_MINUTES or more logged. */
    daysWithSitting: number;
    minutes: MinutesByKind;
    totalMinutes: number;
    /** The same minutes by area (PERSONAL_OFFICE_PLAN): the All lens's split. */
    minutesByArea: Record<StandArea, number>;
    /** Where most of the minutes went (a folder, else a subject), when the sessions name one (the Building words). */
    topPlace: { name: string; minutes: number } | null;
    sessions: number;
    /** Reviews scheduled in the span: done on their day, done later, still open now; and catch-ups (due before the span, done in it). */
    reviews: { due: number; onDay: number; late: number; open: number; catchUps: number };
    focus: { set: number; done: number };
    /** The targets of the weeks whose Monday is in the span. */
    targets: { set: number; done: number; dropped: number };
    topicsDone: number;
    topicsBySubject: Array<{ subjectId: string; name: string; done: number }>;
    milestonesDone: number;
    weakSpots: { found: number; cleared: number };
    recall: { sets: number; strong: number; partial: number; weak: number };
    practice: { total: number; alone: number; hints: number; afterAnswer: number };
    /** Docs created in the span; older docs edited in it. */
    notes: { written: number; workedOn: number };
}

export interface StandPeriod {
    window: StandWindow;
    span: Span;
    /** The record starts inside the span: its numbers cover `current.days` days, not the whole span. */
    partial: boolean;
    /** The span before, when the record covers all of it; null otherwise (never compared with less). */
    before: Span | null;
    current: Measures;
    previous: Measures | null;
    /** 0-3 sentences (§5.4). */
    verdict: string[];
    /** COVERAGE_PLAN: the four rates of this window (the service adds them; every lens answers the same). */
    coverage?: Coverage;
}

export interface StandDay {
    day: DayString;
    active: boolean;
    /** Minutes logged that day, all kinds. */
    minutes: number;
    byKind: MinutesByKind;
    /** The same minutes by area (PERSONAL_OFFICE_PLAN). */
    byArea: Record<StandArea, number>;
    /** Where the time went, most first (at most DAY_PLACES): a folder, a subject. Absent on a day without minutes. */
    places?: Array<{ name: string; minutes: number; area: StandArea }>;
    /** Reviews done, focus lines done and sessions logged that day (what made it active). */
    reviews: number;
    focus: number;
    sessions: number;
}

export interface Stand {
    today: DayString;
    recordStart: DayString;
    periods: Record<StandWindow, StandPeriod>;
    /** The last STAND_GRID_DAYS days, oldest first (days before recordStart included, empty). */
    days: StandDay[];
}

/** The goal the verdict speaks about: the active goal with the nearest deadline that has a path in motion. */
export interface GoalLine {
    title: string;
    deadline: DayString;
    paths: ReadonlyArray<{ subject: string; perWeek: number; requiredPerWeek: number | null; remaining: number; status: PaceStatus }>;
}

// ─── Spans ─────────────────────────────────────────────────────────────

export function spanEnding(today: DayString, window: StandWindow): Span {
    return { from: addDays(today, -(WINDOW_DAYS[window] - 1)), to: today };
}

/** The span of the same length that ends the day before `span` begins. */
export function spanBefore(span: Span): Span {
    const length = diffDays(span.to, span.from) + 1;
    const to = addDays(span.from, -1);
    return { from: addDays(to, -(length - 1)), to };
}

const within = (day: DayString, s: Span): boolean => day >= s.from && day <= s.to;
const inSpan = (day: DayString | null | undefined, s: Span): day is DayString => !!day && within(day, s);
const zeroKinds = (): MinutesByKind => ({ study: 0, practice: 0, build: 0, review: 0 });
const zeroAreas = (): Record<StandArea, number> => ({ personal: 0, work: 0 });

/** The first day the record holds anything: the earliest of the given days (null ones skipped). */
export function recordStartOf(days: ReadonlyArray<DayString | null | undefined>, fallback: DayString): DayString {
    let first: DayString | null = null;
    for (const d of days) if (d && (first === null || d < first)) first = d;
    return first ?? fallback;
}

// ─── Measures ──────────────────────────────────────────────────────────

/**
 * The active days of a span, by the rhythm's rule (rhythm.ts, Home's strip): a review completed on it,
 * a focus line of that day done, or a session logged on it.
 */
export function activeDaySet(rows: StandRows, span: Span): Set<DayString> {
    const active = new Set<DayString>();
    for (const r of rows.revisions) if (r.status === 'done' && inSpan(r.completedDay, span)) active.add(r.completedDay);
    for (const f of rows.focus) if (f.done && inSpan(f.day, span)) active.add(f.day);
    for (const s of rows.sessions) if (inSpan(s.day, span)) active.add(s.day);
    return active;
}

export function measures(rows: StandRows, span: Span, recordStart: DayString): Measures {
    const coveredFrom = recordStart > span.from ? recordStart : span.from;
    const days = coveredFrom > span.to ? 0 : diffDays(span.to, coveredFrom) + 1;

    const minutes = zeroKinds();
    const minutesByArea = zeroAreas();
    const perDay = new Map<DayString, number>();
    const perPlace = new Map<string, number>();
    let sessions = 0;
    const practice = { total: 0, alone: 0, hints: 0, afterAnswer: 0 };
    for (const s of rows.sessions) {
        if (!inSpan(s.day, span)) continue;
        sessions += 1;
        const m = s.minutes ?? 0;
        minutes[s.kind] += m;
        minutesByArea[s.area ?? 'personal'] += m;
        perDay.set(s.day, (perDay.get(s.day) ?? 0) + m);
        const place = s.place?.trim();
        if (place && m > 0) perPlace.set(place, (perPlace.get(place) ?? 0) + m);
        if (s.kind === 'practice' && s.outcome) {
            practice.total += 1;
            if (s.outcome === 'alone') practice.alone += 1;
            else if (s.outcome === 'hints') practice.hints += 1;
            else practice.afterAnswer += 1;
        }
    }

    const reviews = { due: 0, onDay: 0, late: 0, open: 0, catchUps: 0 };
    for (const r of rows.revisions) {
        const done = r.status === 'done' && r.completedDay !== null;
        if (within(r.scheduledFor, span)) {
            reviews.due += 1;
            if (done && r.completedDay! <= r.scheduledFor) reviews.onDay += 1;
            else if (done) reviews.late += 1;
            else if (r.status === 'pending') reviews.open += 1;
        } else if (done && r.scheduledFor < span.from && inSpan(r.completedDay, span)) {
            reviews.catchUps += 1;
        }
    }

    const focus = { set: 0, done: 0 };
    for (const f of rows.focus) {
        if (!inSpan(f.day, span)) continue;
        focus.set += 1;
        if (f.done) focus.done += 1;
    }

    const targets = { set: 0, done: 0, dropped: 0 };
    for (const t of rows.targets) {
        if (!inSpan(t.weekStart, span)) continue;
        targets.set += 1;
        if (t.status === 'done') targets.done += 1;
        if (t.status === 'dropped') targets.dropped += 1;
    }

    const bySubject = new Map<string, number>();
    let topicsDone = 0;
    for (const t of rows.topicsDone) {
        if (!inSpan(t.doneDay, span)) continue;
        topicsDone += 1;
        bySubject.set(t.subjectId, (bySubject.get(t.subjectId) ?? 0) + 1);
    }
    const names = new Map(rows.subjects.map((s) => [s.id, s.name]));
    const topicsBySubject = [...bySubject.entries()]
        .map(([subjectId, done]) => ({ subjectId, name: names.get(subjectId) ?? 'Untitled subject', done }))
        .sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));

    const recall = { sets: 0, strong: 0, partial: 0, weak: 0 };
    for (const r of rows.recallSets) {
        if (!inSpan(r.finishedDay, span)) continue;
        recall.sets += 1;
        recall[r.result] += 1;
    }

    return {
        days,
        activeDays: activeDaySet(rows, span).size,
        daysWithSitting: [...perDay.values()].filter((m) => m >= SITTING_MINUTES).length,
        minutes,
        totalMinutes: KINDS.reduce((a, k) => a + minutes[k], 0),
        minutesByArea,
        topPlace: [...perPlace.entries()].reduce<{ name: string; minutes: number } | null>((best, [name, minutes]) => (!best || minutes > best.minutes || (minutes === best.minutes && name.localeCompare(best.name) < 0) ? { name, minutes } : best), null),
        sessions,
        reviews,
        focus,
        targets,
        topicsDone,
        topicsBySubject,
        milestonesDone: rows.milestonesDone.filter((d) => inSpan(d, span)).length,
        weakSpots: {
            found: rows.weakSpots.filter((w) => inSpan(w.createdDay, span)).length,
            cleared: rows.weakSpots.filter((w) => inSpan(w.clearedDay, span)).length,
        },
        recall,
        practice,
        notes: {
            written: rows.docs.filter((d) => inSpan(d.createdDay, span)).length,
            workedOn: rows.docs.filter((d) => d.createdDay < span.from && inSpan(d.updatedDay, span)).length,
        },
    };
}

/** Nothing at all in the span: no active day, no minutes, nothing due, set or finished. */
export function isEmpty(m: Measures): boolean {
    return (
        m.activeDays === 0 &&
        m.totalMinutes === 0 &&
        m.sessions === 0 &&
        m.reviews.due === 0 &&
        m.reviews.catchUps === 0 &&
        m.focus.set === 0 &&
        m.targets.set === 0 &&
        m.topicsDone === 0 &&
        m.milestonesDone === 0 &&
        m.weakSpots.found + m.weakSpots.cleared === 0 &&
        m.recall.sets === 0 &&
        m.notes.written + m.notes.workedOn === 0
    );
}

// ─── Words ─────────────────────────────────────────────────────────────

/** '40 min', '2 h', '6 h 20 min' (the frontend's formatMinutes). */
export function formatMinutes(total: number): string {
    if (total < 60) return `${total} min`;
    const h = Math.floor(total / 60);
    const min = total % 60;
    return min ? `${h} h ${min} min` : `${h} h`;
}

const DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
/** '16 May', or '16 May 2027' outside today's year (the frontend's shortDay). */
export function shortDay(day: DayString, today: DayString): string {
    const base = DAY_MONTH.format(new Date(`${day}T00:00:00Z`));
    return day.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${day.slice(0, 4)}`;
}

const clipTitle = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS - 1).trimEnd()}…` : t;
};
const decimal = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How `now` compares with `before`, as words that read before a span: "2 more than", "the same as". */
export function compareWords(now: number, before: number, unit: 'count' | 'minutes'): string {
    const d = now - before;
    if (unit === 'minutes') {
        if (Math.abs(d) < SAME_MINUTES) return 'about the same as';
        return `${formatMinutes(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than`;
    }
    if (d === 0) return 'the same as';
    return `${Math.abs(d)} ${d > 0 ? 'more' : 'fewer'} than`;
}

const PHRASES: Record<StandWindow, { now: string; before: string }> = {
    week: { now: 'the last 7 days', before: 'the 7 days before' },
    month: { now: 'the last 4 weeks', before: 'the 4 weeks before' },
    year: { now: 'the last year', before: 'the year before' },
};
const KIND_WORDS: Record<StandKind, string> = { study: 'study', practice: 'practice', build: 'build work', review: 'review' };

/** The goal the verdict speaks about: the nearest deadline (the goals come nearest first) with a path in motion. */
export function goalLineOf(goals: readonly GoalLine[]): GoalLine | null {
    const moving: readonly PaceStatus[] = ['behind', 'overdue', 'on_track', 'ahead'];
    return goals.find((g) => g.paths.some((p) => moving.includes(p.status))) ?? null;
}

/**
 * The verdict (§5.4): at most three sentences, each only when its facts exist. It states the gap;
 * it never says "work harder": the reader judges.
 */
export function verdictLines(p: Omit<StandPeriod, 'verdict'>, goal: GoalLine | null, ctx: { today: DayString; recordStart: DayString; lens?: StandLens }): string[] {
    if (ctx.lens === 'work') return workVerdictLines(p, ctx);
    if (ctx.lens === 'building') return buildVerdictLines(p, ctx);
    const learning = ctx.lens === 'learning';
    // Learning and work (their ticks): the split names the learning part.
    const mixed = ctx.lens === 'all' || ctx.lens === 'learning_work';
    const words = PHRASES[p.window];
    const c = p.current;
    const prev = p.previous;
    const start = shortDay(ctx.recordStart, ctx.today);
    const lines: string[] = [];

    if (isEmpty(c) && (!prev || isEmpty(prev))) {
        lines.push(`${p.partial ? 'Nothing in the record yet.' : `Nothing in the record for ${words.now}.`} Reviews, focus lines and ${learning ? 'study sessions' : 'logged sessions'} fill this in.`);
    } else {
        // 1. Consistency.
        const a = c.activeDays;
        if (p.partial) {
            const did = learning ? 'Studied' : 'Active';
            lines.push(c.days <= 1 ? (a ? `${did} today, the first day of the record.` : 'Nothing yet today, the first day of the record.') : `${did} ${learning ? 'on ' : ''}${a} of the ${c.days} days since the record started on ${start}.`);
        } else {
            const head = learning
                ? p.window === 'week' ? `Studied on ${a} of the last 7 days` : `Studied on ${plural(a, 'day')} in ${words.now}`
                : p.window === 'week' ? `Active ${a} of the last 7 days` : `Active ${plural(a, 'day')} in ${words.now}`;
            lines.push(prev ? `${head}, ${compareWords(a, prev.activeDays, 'count')} ${words.before}.` : `${head}.`);
        }
        // 2. Effort.
        const total = c.totalMinutes;
        const span = p.partial ? `since ${start}` : `in ${words.now}`;
        if (total === 0) {
            lines.push(prev && prev.totalMinutes > 0 ? `Nothing logged ${span}; ${formatMinutes(prev.totalMinutes)} ${words.before}.` : `Nothing logged ${span}.`);
        } else {
            const top = KINDS.reduce((best, k) => (c.minutes[k] > c.minutes[best] ? k : best), KINDS[0]!);
            const most = c.minutes[top] === total ? `; all of it ${KIND_WORDS[top]}` : c.minutes[top] * 2 >= total ? `; most of it ${KIND_WORDS[top]}` : '';
            const vs = prev ? `, ${compareWords(total, prev.totalMinutes, 'minutes')} ${words.before}` : '';
            // The All lens says how the time split (PERSONAL_OFFICE_PLAN §5 stage 3), when both areas have some.
            const split =
                mixed && c.minutesByArea.personal > 0 && c.minutesByArea.work > 0
                    ? `; ${formatMinutes(c.minutesByArea.personal)} ${ctx.lens === 'learning_work' ? 'learning' : 'personal'}, ${formatMinutes(c.minutesByArea.work)} work`
                    : most;
            lines.push(`${formatMinutes(total)} logged${p.partial ? ` ${span}` : ''}${vs}${split}.`);
        }
    }

    // 3. The goal.
    if (goal) {
        const title = clipTitle(goal.title);
        const by = shortDay(goal.deadline, ctx.today);
        const behind = goal.paths.filter((x) => x.status === 'behind' && x.requiredPerWeek !== null);
        const onPace = goal.paths.filter((x) => x.status === 'on_track' || x.status === 'ahead');
        if (goal.deadline < ctx.today) {
            const left = goal.paths.reduce((n, x) => n + x.remaining, 0);
            lines.push(`${title} passed its deadline on ${by} with ${plural(left, 'topic')} left.`);
        } else if (behind.length) {
            const worst = behind.reduce((w, x) => (x.requiredPerWeek! - x.perWeek > w.requiredPerWeek! - w.perWeek ? x : w));
            const need = worst.requiredPerWeek!;
            const so = worst.perWeek === 0 ? 'none were finished in the last 4 weeks' : `the last 4 weeks averaged ${decimal(worst.perWeek)}`;
            lines.push(`${clipTitle(worst.subject)} needs ${decimal(need)} ${need === 1 ? 'topic' : 'topics'} a week to make ${title} by ${by}; ${so}.`);
        } else if (onPace.length === 1) {
            lines.push(`${clipTitle(onPace[0]!.subject)} is on pace to make ${title} by ${by}.`);
        } else if (onPace.length > 1) {
            lines.push(`${onPace.length} paths are on pace to make ${title} by ${by}.`);
        }
    }
    return lines;
}

/** The Work lens's verdict: days at work and hours against the span before. No goal: work is not judged here. */
function workVerdictLines(p: Omit<StandPeriod, 'verdict'>, ctx: { today: DayString; recordStart: DayString }): string[] {
    const words = PHRASES[p.window];
    const c = p.current;
    const prev = p.previous;
    const start = shortDay(ctx.recordStart, ctx.today);
    if (c.activeDays === 0 && c.totalMinutes === 0 && (!prev || (prev.activeDays === 0 && prev.totalMinutes === 0))) {
        return [`${p.partial ? 'No work tracked yet.' : `No work tracked in ${words.now}.`} Claude Code in a folder marked Work fills this in.`];
    }
    const lines: string[] = [];
    const a = c.activeDays;
    if (p.partial) lines.push(c.days <= 1 ? (a ? 'Worked today, the first day of the record.' : 'No work yet today, the first day of the record.') : `Worked ${a} of the ${c.days} days since the record started on ${start}.`);
    else {
        const head = p.window === 'week' ? `Worked ${a} of the last 7 days` : `Worked on ${plural(a, 'day')} in ${words.now}`;
        lines.push(prev ? `${head}, ${compareWords(a, prev.activeDays, 'count')} ${words.before}.` : `${head}.`);
    }
    const total = c.totalMinutes;
    const span = p.partial ? `since ${start}` : `in ${words.now}`;
    if (total === 0) lines.push(prev && prev.totalMinutes > 0 ? `No time tracked ${span}; ${formatMinutes(prev.totalMinutes)} ${words.before}.` : `No time tracked ${span}.`);
    else lines.push(`${formatMinutes(total)} at work${p.partial ? ` ${span}` : ''}${prev ? `, ${compareWords(total, prev.totalMinutes, 'minutes')} ${words.before}` : ''}.`);
    return lines;
}

/**
 * The Building lens's verdict (STUDY_FLOW_PLAN §4.5): days spent building their own projects and the hours against the
 * span before, with where most of it went. No goal: a goal is learning's.
 */
function buildVerdictLines(p: Omit<StandPeriod, 'verdict'>, ctx: { today: DayString; recordStart: DayString }): string[] {
    const words = PHRASES[p.window];
    const c = p.current;
    const prev = p.previous;
    const start = shortDay(ctx.recordStart, ctx.today);
    if (c.activeDays === 0 && c.totalMinutes === 0 && (!prev || (prev.activeDays === 0 && prev.totalMinutes === 0))) {
        return [`${p.partial ? 'Nothing built yet.' : `Nothing built in ${words.now}.`} Claude Code in a folder of your own fills this in.`];
    }
    const lines: string[] = [];
    const a = c.activeDays;
    if (p.partial) lines.push(c.days <= 1 ? (a ? 'Built today, the first day of the record.' : 'Nothing built yet today, the first day of the record.') : `Built on ${a} of the ${c.days} days since the record started on ${start}.`);
    else {
        const head = p.window === 'week' ? `Built on ${a} of the last 7 days` : `Built on ${plural(a, 'day')} in ${words.now}`;
        lines.push(prev ? `${head}, ${compareWords(a, prev.activeDays, 'count')} ${words.before}.` : `${head}.`);
    }
    const total = c.totalMinutes;
    const span = p.partial ? `since ${start}` : `in ${words.now}`;
    if (total === 0) lines.push(prev && prev.totalMinutes > 0 ? `No time logged ${span}; ${formatMinutes(prev.totalMinutes)} ${words.before}.` : `No time logged ${span}.`);
    else {
        const top = c.topPlace;
        const most = top && top.minutes === total ? `; all of it on ${clipTitle(top.name)}` : top && top.minutes * 2 >= total ? `; most of it on ${clipTitle(top.name)}` : '';
        lines.push(`${formatMinutes(total)} on your own projects${p.partial ? ` ${span}` : ''}${prev ? `, ${compareWords(total, prev.totalMinutes, 'minutes')} ${words.before}` : ''}${most}.`);
    }
    return lines;
}

// ─── The whole stand ───────────────────────────────────────────────────

function periodOf(rows: StandRows, window: StandWindow, ctx: { today: DayString; recordStart: DayString; goal: GoalLine | null; lens?: StandLens }): StandPeriod {
    const span = spanEnding(ctx.today, window);
    const partial = span.from < ctx.recordStart;
    const prior = spanBefore(span);
    const before = prior.from < ctx.recordStart ? null : prior;
    const current = measures(rows, span, ctx.recordStart);
    const previous = before ? measures(rows, before, ctx.recordStart) : null;
    const base = { window, span, partial, before, current, previous };
    return { ...base, verdict: verdictLines(base, ctx.goal, ctx) };
}

/** The last STAND_GRID_DAYS days, oldest first: what made each one active and its minutes by kind. */
export function standDays(rows: StandRows, today: DayString): StandDay[] {
    const from = addDays(today, -(STAND_GRID_DAYS - 1));
    const out = new Map<DayString, StandDay>();
    for (let d = from; d <= today; d = addDays(d, 1)) out.set(d, { day: d, active: false, minutes: 0, byKind: zeroKinds(), byArea: zeroAreas(), reviews: 0, focus: 0, sessions: 0 });
    const places = new Map<DayString, Map<string, { minutes: number; area: StandArea }>>();
    for (const s of rows.sessions) {
        const e = out.get(s.day);
        if (!e) continue;
        const m = s.minutes ?? 0;
        e.sessions += 1;
        e.minutes += m;
        e.byKind[s.kind] += m;
        e.byArea[s.area ?? 'personal'] += m;
        e.active = true;
        if (m > 0) {
            const name = s.place?.trim() || KIND_PLACE[s.kind];
            const day = places.get(s.day) ?? new Map<string, { minutes: number; area: StandArea }>();
            const had = day.get(name);
            day.set(name, { minutes: (had?.minutes ?? 0) + m, area: had?.area ?? s.area ?? 'personal' });
            places.set(s.day, day);
        }
    }
    for (const [day, byName] of places) {
        const e = out.get(day);
        if (e) e.places = [...byName.entries()].map(([name, v]) => ({ name, minutes: v.minutes, area: v.area })).sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)).slice(0, DAY_PLACES);
    }
    for (const r of rows.revisions) {
        const e = r.status === 'done' && r.completedDay ? out.get(r.completedDay) : undefined;
        if (!e) continue;
        e.reviews += 1;
        e.active = true;
    }
    for (const f of rows.focus) {
        const e = f.done ? out.get(f.day) : undefined;
        if (!e) continue;
        e.focus += 1;
        e.active = true;
    }
    return [...out.values()];
}

/** A session with no folder or subject, by its kind, in a day's words. */
const KIND_PLACE: Record<StandKind, string> = { study: 'Study', practice: 'Practice', build: 'Building', review: 'Review' };

export function buildStand(rows: StandRows, ctx: { today: DayString; recordStart: DayString; goal: GoalLine | null; lens?: StandLens }): Stand {
    const periods = {} as Record<StandWindow, StandPeriod>;
    for (const w of STAND_WINDOWS) periods[w] = periodOf(rows, w, ctx);
    return { today: ctx.today, recordStart: ctx.recordStart, periods, days: standDays(rows, ctx.today) };
}

// ─── Coverage (COVERAGE_PLAN, 11-23) ───────────────────────────────────
// Four rates, none of them minutes: on how many days they learned, built, worked (of weekdays), and how much of
// what came due was done by its day. A day counts once however much happened on it: showing up, not volume.
// Lens-free: the chart always shows every part the record holds.

/** Something with a day it was due and the day it was done (null: not done). */
export interface DueItem {
    due: DayString;
    done: DayString | null;
}

export interface CoverageInput {
    /** Every session, whatever the page's lens. */
    sessions: ReadonlyArray<{ day: DayString; kind: StandKind; area?: StandArea }>;
    reviewsDone: readonly DayString[];
    topicsDone: readonly DayString[];
    recallSets: readonly DayString[];
    /** Notes and links on a subject or a lesson (not the Inbox). */
    captures: readonly DayString[];
    docs: ReadonlyArray<{ createdDay: DayString; updatedDay: DayString }>;
    workLines: ReadonlyArray<{ day: DayString; office: boolean }>;
    reviews: ReadonlyArray<DueItem & { missed?: boolean }>;
    tasks: readonly DueItem[];
    milestones: readonly DueItem[];
    /** A week target is due at its week's Sunday; a dropped one is left out by the caller. */
    targets: ReadonlyArray<{ weekStart: DayString; status: 'open' | 'done' | 'dropped'; doneDay: DayString | null }>;
    focus: ReadonlyArray<{ day: DayString; done: boolean }>;
    hasBuilding: boolean;
    hasWork: boolean;
}

export interface Tally {
    done: number;
    due: number;
}

export interface Coverage {
    learning: { days: number; of: number };
    building: { days: number; of: number } | null;
    /** `of`: the weekdays the record covers. */
    work: { days: number; of: number } | null;
    onTime: Tally & { by: { reviews: Tally; tasks: Tally; milestones: Tally; targets: Tally; focus: Tally } };
}

const isWeekday = (day: DayString): boolean => {
    const w = new Date(`${day}T00:00:00Z`).getUTCDay();
    return w >= 1 && w <= 5;
};

/** Things due in the span: one due before today counts; one due today only once done (today isn't over). */
function tally(items: readonly DueItem[], span: Span, today: DayString): Tally {
    const t = { done: 0, due: 0 };
    for (const i of items) {
        if (!within(i.due, span)) continue;
        if (i.due >= today && !i.done) continue;
        t.due += 1;
        if (i.done && i.done <= i.due) t.done += 1;
    }
    return t;
}

export function coverageOf(input: CoverageInput, span: Span, recordStart: DayString, today: DayString): Coverage {
    const covered: Span = { from: recordStart > span.from ? recordStart : span.from, to: span.to };
    const days: DayString[] = [];
    for (let d = covered.from; d <= covered.to; d = addDays(d, 1)) days.push(d);
    const learned = new Set<DayString>();
    const built = new Set<DayString>();
    const worked = new Set<DayString>();
    for (const s of input.sessions) {
        if (!inSpan(s.day, covered)) continue;
        const area = s.area ?? 'personal';
        if (area === 'work') worked.add(s.day);
        else if (s.kind === 'build') built.add(s.day);
        else learned.add(s.day);
    }
    for (const list of [input.reviewsDone, input.topicsDone, input.recallSets, input.captures]) for (const d of list) if (inSpan(d, covered)) learned.add(d);
    for (const d of input.docs) {
        if (inSpan(d.createdDay, covered)) learned.add(d.createdDay);
        if (inSpan(d.updatedDay, covered)) learned.add(d.updatedDay);
    }
    for (const l of input.workLines) if (inSpan(l.day, covered)) (l.office ? worked : built).add(l.day);

    const weekdays = days.filter(isWeekday).length;
    const by = {
        reviews: tally(input.reviews.map((r) => (r.missed ? { due: r.due, done: null } : r)), covered, today),
        tasks: tally(input.tasks, covered, today),
        milestones: tally(input.milestones, covered, today),
        targets: { done: 0, due: 0 },
        focus: tally(input.focus.map((f) => ({ due: f.day, done: f.done ? f.day : null })), covered, today),
    };
    // A week target counts in the span its Monday is in (its due day, the Sunday, may fall after the span).
    by.targets = tally(
        input.targets.filter((t) => t.status !== 'dropped' && within(t.weekStart, covered)).map((t) => ({ due: addDays(t.weekStart, 6), done: t.status === 'done' ? (t.doneDay ?? t.weekStart) : null })),
        { from: covered.from, to: addDays(covered.to, 6) },
        today
    );
    const parts = Object.values(by);
    return {
        learning: { days: learned.size, of: days.length },
        building: input.hasBuilding ? { days: built.size, of: days.length } : null,
        work: input.hasWork ? { days: Math.min(worked.size, weekdays), of: weekdays } : null,
        onTime: { done: parts.reduce((n, t) => n + t.done, 0), due: parts.reduce((n, t) => n + t.due, 0), by },
    };
}
