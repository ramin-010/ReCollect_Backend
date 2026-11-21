// What is ahead (ECOSYSTEM_V2_PLAN stage 16): the one reader of today's rows (the lock picture), Coming up and Pick up
// (the home picture), which the widget, the night and the pulses read too (aheadRules.ts holds the rules). No model: an
// account with no AI gets all of it. Their own words show as written ("Hide titles" makes them plain words); an event
// that is private or off their screens never shows.
import { prisma } from '../../db/prisma';
import { addDays, dayOf, startOfDay } from '../learning';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { OPEN_STAGES } from '../buddy/threads';
import { AHEAD_DAYS, LEFT_OFF_DAYS, comingUp, leftOff, todayRows, type AheadRow, type EventIn, type ReminderIn, type SessionIn, type TaskIn } from './aheadRules';

export type { AheadRow } from './aheadRules';

/** Stage 7: how long a silent reminder stays on a picture past its time (it never rang: the picture is where they see it). */
export const SILENT_STAYS_MS = 2 * 3600_000;

/** One of today's reminders as the screens show it (stage 7). */
export interface TodayReminder extends ReminderIn {
    ring: boolean;
    repeat: string | null;
}

export function reminderWords(r: { message: string | null; todo: { title: string | null } | null }): string {
    return r.todo?.title?.trim() || r.message?.replace(/^\s*reminder:\s*/i, '').trim() || 'A reminder';
}

/**
 * Today's reminders as the screens show them: their own still to come today (pending; a finished task's left out), a
 * silent one also until 2 hours past its time, and Buddy's own the same way; soonest first.
 */
export async function remindersOfToday(userId: string, now: Date, tz: string): Promise<TodayReminder[]> {
    const rows = await prisma.reminder.findMany({
        where: {
            userId,
            OR: [
                { status: 'pending', reminderDate: { gte: now, lt: new Date(now.getTime() + 24 * 3600_000) } },
                { silent: true, status: { in: ['pending', 'sent'] }, reminderDate: { gte: new Date(now.getTime() - SILENT_STAYS_MS), lt: now } },
            ],
        },
        include: { todo: { select: { title: true, status: true } } },
        orderBy: { reminderDate: 'asc' },
        take: 8,
    });
    const today = dayOf(now, tz);
    // A Later that keeps their own reminder's time ('defer', 11-21) is no reminder: their own one is the row.
    const buddy = await prisma.buddyReminder.findMany({ where: { userId, status: 'pending', OR: [{ origin: null }, { origin: { not: 'defer' } }], at: { gte: new Date(now.getTime() - SILENT_STAYS_MS), lt: new Date(now.getTime() + 24 * 3600_000) } }, orderBy: { at: 'asc' }, take: 6 });
    return [
        ...rows
            .filter((r) => r.todo?.status !== 'complete' && dayOf(r.reminderDate, tz) === today)
            .map((r): TodayReminder => ({ id: r.id, when: r.reminderDate, text: reminderWords(r), ring: !r.silent, repeat: r.repeat, by: 'you', taskId: r.todoId })),
        // Stage 19: a Later on a task is that task's reminder (the task's own row is not shown beside it).
        ...buddy.filter((b) => dayOf(b.at, tz) === today).map((b): TodayReminder => ({ id: b.id, when: b.at, text: b.text, ring: false, repeat: b.repeat, by: 'buddy', taskId: b.refKind === 'tk' ? b.refId : null })),
    ].sort((a, b) => a.when.getTime() - b.when.getTime());
}

/** Stage 19 (and the owner's word, 11-21): where each item under a Later stands now. */
export interface LaterState {
    /** Under a pending Later: left out of every list until its time (then it comes back once). */
    hidden: Set<string>;
    /**
     * Under a Later that keeps their own reminder's time ('defer'): off the widget, the home picture and Buddy's words
     * until then; their own reminder, its row and its alarm stay as they were.
     */
    deferred: Set<string>;
    /** A Later whose time has come (until 2 hours past, or done): its row on the lock picture; the item shows there once. */
    returned: Array<{ rowId: string; ref: string }>;
    /** A 'defer' whose time has come (until 2 hours past): while their own reminder's row is still on the lock, not on Home too. */
    deferBack: Array<{ ref: string; at: Date }>;
}

export async function laterState(userId: string, now: Date): Promise<LaterState> {
    const rows = await prisma.buddyReminder.findMany({
        where: { userId, origin: { in: ['later', 'defer'] }, status: 'pending', at: { gt: new Date(now.getTime() - SILENT_STAYS_MS) } },
        select: { id: true, refKind: true, refId: true, origin: true, at: true },
    });
    const out: LaterState = { hidden: new Set(), deferred: new Set(), returned: [], deferBack: [] };
    for (const r of rows) {
        if (!r.refKind || !r.refId) continue;
        const ref = `${r.refKind}_${r.refId}`;
        if (r.at > now && r.origin === 'defer') out.deferred.add(ref);
        else if (r.at > now) {
            // Snoozed: the item and the Later's own row stay off the lock screen until its time (11-21: it comes back then, once).
            out.hidden.add(ref);
            out.hidden.add(`br_${r.id}`);
        } else if (r.origin === 'later') out.returned.push({ rowId: `br_${r.id}`, ref });
        else out.deferBack.push({ ref, at: r.at });
    }
    return out;
}

/** Stage 19: the items under a pending Later (or one keeping their own reminder's time): Buddy's words resting on them wait. */
export async function laterHidden(userId: string, now: Date): Promise<Set<string>> {
    const s = await laterState(userId, now);
    return new Set([...s.hidden, ...s.deferred]);
}

/** Their open personal to-dos from 30 days back to the days ahead: with a due day, or none and a reminder ahead. */
async function openTasks(userId: string, now: Date, tz: string): Promise<TaskIn[]> {
    const today = dayOf(now, tz);
    const until = startOfDay(addDays(today, AHEAD_DAYS + 1), tz);
    const rows = await prisma.todo.findMany({
        where: {
            userId,
            workspaceId: null,
            goalType: 'NONE',
            status: { not: 'complete' },
            OR: [{ dueDate: { gte: startOfDay(addDays(today, -30), tz), lt: until } }, { dueDate: null, reminders: { some: { status: 'pending', reminderDate: { gt: now, lt: until } } } }],
        },
        select: { id: true, title: true, dueDate: true, reminders: { where: { status: 'pending', reminderDate: { gt: now } }, orderBy: { reminderDate: 'asc' }, take: 1, select: { reminderDate: true } } },
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        take: 80,
    });
    return rows.map((t) => ({ id: t.id, title: t.title.trim(), dueDate: t.dueDate, nextReminder: t.reminders[0]?.reminderDate ?? null }));
}

/** Their event threads from today to the days ahead that may show on a screen (open, not private, not off their screens, not quiet). */
async function screenEvents(userId: string, now: Date, tz: string): Promise<EventIn[]> {
    const today = dayOf(now, tz);
    const rows = await prisma.buddyThread.findMany({
        where: {
            userId,
            event: true,
            stage: { in: [...OPEN_STAGES] },
            sensitive: false,
            onScreens: true,
            noAsk: false,
            OR: [{ quietUntil: null }, { quietUntil: { lte: now } }],
            lookAgainOn: { gte: toDbDay(today), lte: toDbDay(addDays(today, AHEAD_DAYS)) },
        },
        select: { id: true, title: true, lookAgainOn: true, eventMinute: true },
        take: 20,
    });
    return rows.map((t) => ({ id: t.id, title: t.title, day: fromDbDay(t.lookAgainOn!), minute: t.eventMinute }));
}

/** This week's practice and study sessions (Pick up). */
async function weekSessions(userId: string, now: Date, tz: string): Promise<SessionIn[]> {
    const from = addDays(dayOf(now, tz), -(LEFT_OFF_DAYS - 1));
    const rows = await prisma.workSession.findMany({
        where: { userId, kind: { in: ['practice', 'study'] }, day: { gte: toDbDay(from) } },
        select: { id: true, kind: true, problem: true, outcome: true, topicId: true, nextStep: true, url: true, day: true, startedAt: true, updatedAt: true, topic: { select: { title: true, status: true, docId: true, nextStep: true } } },
        orderBy: { startedAt: 'desc' },
        take: 60,
    });
    return rows.map((s) => ({
        id: s.id,
        kind: s.kind,
        problem: s.problem,
        outcome: s.outcome,
        topicId: s.topicId,
        topicTitle: s.topic?.title ?? null,
        topicDone: s.topic?.status === 'done' || s.topic?.status === 'skipped',
        nextStep: s.nextStep ?? s.topic?.nextStep ?? null,
        url: s.url,
        docId: s.topic?.docId ?? null,
        day: fromDbDay(s.day),
        startedAt: s.startedAt,
        updatedAt: s.updatedAt,
    }));
}

export interface Ahead {
    /** The lock picture's rows (now). */
    today: AheadRow[];
    /** The next seven days. */
    comingUp: AheadRow[];
    /** Problems and topics left unfinished this week, newest first. */
    leftOff: AheadRow[];
    /** Laters whose time has come: their row among today's (`rowId`) and the item (`ref`), shown there once. */
    returned: Array<{ rowId: string; ref: string }>;
    /** Items whose Later keeps their own reminder's time: their row stays on the lock, never the widget's card until then. */
    deferred: Set<string>;
    /** Their own reminders' rows for those items (before its time, and while it stays on the lock after): never the card. */
    deferRows: Set<string>;
}

/** What is ahead for this person now (one reader for every surface). */
export async function aheadFor(userId: string, now: Date = new Date(), opts: { titles?: boolean; tz?: string; todayMax?: number; aheadMax?: number; leftMax?: number } = {}): Promise<Ahead> {
    const tz = opts.tz ?? (await loadLearningContext(userId, now)).tz;
    const titles = opts.titles !== false;
    const [reminders, tasks, events, sessions, later] = await Promise.all([remindersOfToday(userId, now, tz), openTasks(userId, now, tz), screenEvents(userId, now, tz), weekSessions(userId, now, tz), laterState(userId, now)]);
    // Off the home picture and the widget: under a Later, keeping their own reminder's time, or back on the lock now (once:
    // the owner, 11-21). Today's rows hide only what a Later took off (their own reminder's row stays). A 'defer' whose time
    // has come stays off Home while that reminder's row is still on the lock (a silent one stays two hours; a ringing one
    // leaves the rows when it rings, and the item is back on Home at once).
    const own = (m: TodayReminder, ref: string) => m.by === 'you' && (ref === `rm_${m.id}` || (!!m.taskId && ref === `tk_${m.taskId}`));
    const backOnLock = later.deferBack.filter((d) => reminders.some((m) => m.when.getTime() === d.at.getTime() && own(m, d.ref))).map((d) => d.ref);
    const offHome = new Set([...later.hidden, ...later.deferred, ...later.returned.map((r) => r.ref), ...backOnLock]);
    const deferRefs = [...later.deferred, ...backOnLock];
    const deferRows = new Set(reminders.filter((m) => deferRefs.some((ref) => own(m, ref))).map((m) => `rm_${m.id}`));
    return {
        today: todayRows({ now, tz, reminders, tasks, events, hidden: later.hidden }, titles, opts.todayMax ?? 3),
        comingUp: comingUp({ now, tz, tasks, events, hidden: offHome }, titles, opts.aheadMax ?? 3),
        leftOff: leftOff({ now, tz, sessions, hidden: offHome }, titles, opts.leftMax ?? 1),
        returned: later.returned,
        deferred: later.deferred,
        deferRows,
    };
}
