// Todo reminders: the rows written by the todo endpoints and the cron that emails them.
//
// The cron (src/services/cronScheduler.ts) calls processDueReminders() every minute. Same steps as
// the Mongo version:
//   1. reset 'processing' reminders stuck for more than 5 minutes back to 'pending';
//   2. take up to 50 due reminders (pending, not emailed, reminderDate <= now);
//   3. claim each one atomically (pending → processing) so two instances never send it twice;
//   4. load reminder → user (name, email) and todo → assignees (name, email) [+ workspace name];
//   5. email every assignee, or the reminder's owner when the todo has none (the workspace template
//      for workspace todos, the personal one otherwise);
//   6. mark it 'sent' (emailSent = true) if at least one email went out, else 'failed'.
// 'processing' was missing from the Mongo enum; the Postgres enum has it.
import type { Prisma, Reminder } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { sendPersonalTaskReminderEmail } from '../../controllers/personalTasks/personalEmails';
import { sendWorkspaceTaskReminderEmail } from '../../controllers/workspace/workspaceEmails';
import { poke } from '../scheduler/scheduler';
import { addDays, dayOf, startOfDay } from '../learning';

export const REMINDER_BATCH_SIZE = 50;

/** REMINDER_EMAIL=off: no reminder emails at all (his phone rings for them; app 0.5.0). Default: an email for any reminder no phone holds. */
export const reminderEmailsOff = (): boolean => /^(off|0|false|no)$/i.test(process.env['REMINDER_EMAIL'] ?? '');
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

/** The message stored with a todo reminder (unchanged). */
export function todoReminderMessage(title: string): string {
    return `Reminder: ${title.trim()}`;
}

export interface CreateTodoReminderInput {
    userId: string;
    todoId: string;
    reminderDate: Date;
    /** The todo title; the message becomes "Reminder: <title>". */
    title: string;
    /** Stage 7: no sound and no email (it shows on the home picture and in the app). */
    silent?: boolean;
    /** Stage 7: daily | weekdays | weekly | chosen days: when it passes, the next of its series is made. */
    repeat?: Repeat | null;
    /** Stage 7: the series it continues (none: a repeating one starts its own). */
    seriesId?: string | null;
}

export const REPEATS = ['daily', 'weekdays', 'weekly'] as const;
/**
 * daily | weekdays | weekly, or chosen days of the week stored as "mo,we,fr" (Monday first; the week's
 * simulation, issue 15: runs on Monday, Wednesday and Friday made three series and three tasks).
 */
export type Repeat = string;

/** The days of the week by two letters, as JavaScript counts them (0 is Sunday). */
const DAY_CODES = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'] as const;
const DAY_WORDS: Record<string, number> = {
    ...Object.fromEntries(DAY_CODES.map((c, i) => [c, i])),
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

/** The stored form of a set of weekdays: every day is daily, Monday to Friday weekdays, else "mo,we,fr". */
export function repeatOfDays(days: ReadonlySet<number>): Repeat {
    if (days.size === 7) return 'daily';
    if (days.size === 5 && [1, 2, 3, 4, 5].every((d) => days.has(d))) return 'weekdays';
    return MONDAY_FIRST.filter((d) => days.has(d)).map((d) => DAY_CODES[d]).join(',');
}

/**
 * A repeat as asked ("daily", "weekdays", "weekly", or days: "mon, wed and fri", "MO,WE,FR") in its stored
 * form; null when it is none of these.
 */
export function normalizeRepeat(input: string): Repeat | null {
    const v = input.trim().toLowerCase();
    if ((REPEATS as readonly string[]).includes(v)) return v;
    const words = v.replace(/\band\b/g, ' ').split(/[^a-z]+/).filter(Boolean);
    const days = new Set<number>();
    for (const w of words) {
        const d = DAY_WORDS[w];
        if (d === undefined) return null;
        days.add(d);
    }
    return days.size ? repeatOfDays(days) : null;
}

/** The weekdays a series falls on (0 is Sunday); a weekly one, on the weekday of its time in his zone. */
export function daysOfRepeat(repeat: Repeat, at: Date, tz: string): Set<number> {
    if (repeat === 'daily') return new Set([0, 1, 2, 3, 4, 5, 6]);
    if (repeat === 'weekdays') return new Set([1, 2, 3, 4, 5]);
    if (repeat === 'weekly') return new Set([weekdayOf(at, tz)]);
    return new Set(repeat.split(',').map((c) => DAY_WORDS[c.trim()]).filter((d): d is number => d !== undefined));
}

const weekdayOf = (at: Date, tz: string): number => new Date(`${dayOf(at, tz)}T12:00:00Z`).getUTCDay();

/** A series' first time: the time asked, or the first of its days after it at the same clock time (a weekday series asked for a Saturday starts on Monday). */
export function firstOccurrence(at: Date, repeat: Repeat, tz: string): Date {
    if (repeat === 'weekly' || daysOfRepeat(repeat, at, tz).has(weekdayOf(at, tz))) return at;
    return nextOccurrence(at, repeat, tz, at);
}

/**
 * A pending, not-yet-emailed todo reminder. Every writer of a reminder pokes the quiet scheduler
 * (hosting P1-11), which re-reads the next due one a moment later (after a caller's transaction).
 */
export async function createTodoReminder(input: CreateTodoReminderInput, db: DbClient = prisma): Promise<Reminder> {
    const row = await db.reminder.create({
        data: {
            userId: input.userId,
            type: 'todo',
            todoId: input.todoId,
            reminderDate: input.reminderDate,
            message: todoReminderMessage(input.title),
            emailSent: false,
            status: 'pending',
            silent: input.silent === true,
            repeat: input.repeat ?? null,
            seriesId: input.seriesId ?? null,
        },
    });
    // A repeating one starts its own series (its id names it).
    const out = input.repeat && !input.seriesId ? await db.reminder.update({ where: { id: row.id }, data: { seriesId: row.id } }) : row;
    poke('reminders');
    return out;
}

/** Delete every reminder of a todo (before replacing it, or when the todo is deleted). */
export async function deleteTodoReminders(todoId: string, db: DbClient = prisma) {
    const result = await db.reminder.deleteMany({ where: { todoId } });
    if (result.count > 0) poke('reminders');
    return result;
}

/**
 * The quiet scheduler's next moment for reminder emails (hosting P1-11): the earliest pending one
 * that needs an email (a phone that holds one rings it), or a stale claim's reset. None with
 * REMINDER_EMAIL=off (the sweep marks the past ones).
 */
export async function nextReminderDue(_now: Date = new Date(), db: DbClient = prisma): Promise<Date | null> {
    if (reminderEmailsOff()) return null;
    const pending = await db.reminder.findFirst({
        where: { status: 'pending', emailSent: false, phoneAt: null, silent: false },
        orderBy: { reminderDate: 'asc' },
        select: { reminderDate: true },
    });
    // Stage 7: a repeating one (of any kind) makes its next when it passes.
    const repeating = await db.reminder.findFirst({ where: { status: 'pending', repeat: { not: null } }, orderBy: { reminderDate: 'asc' }, select: { reminderDate: true } });
    const claimed = await db.reminder.findFirst({ where: { status: 'processing' }, orderBy: { updatedAt: 'asc' }, select: { updatedAt: true } });
    const times = [pending?.reminderDate.getTime(), repeating?.reminderDate.getTime(), claimed ? claimed.updatedAt.getTime() + STALE_PROCESSING_MS : undefined].filter((t): t is number => t !== undefined);
    return times.length ? new Date(Math.min(...times)) : null;
}

// ─── Cron ──────────────────────────────────────────────────────────────

// The old populate: user 'email name'; todoId 'title status description priority labels workspace
// assignees' with assignees 'email name' (+ the workspace name for the workspace template).
const deliveryInclude = {
    user: { select: { id: true, name: true, email: true } },
    todo: {
        select: {
            id: true,
            title: true,
            status: true,
            description: true,
            priority: true,
            workspaceId: true,
            workspace: { select: { name: true } },
            assignees: {
                select: { user: { select: { id: true, name: true, email: true } } },
                orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
            },
        },
    },
} satisfies Prisma.ReminderInclude;

/** 'processing' rows older than STALE_PROCESSING_MS go back to 'pending' (a crashed run). */
export async function resetStaleProcessingReminders(now: Date, db: DbClient = prisma): Promise<number> {
    const { count } = await db.reminder.updateMany({
        where: { status: 'processing', updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } },
        data: { status: 'pending' },
    });
    return count;
}

/** Ids of due reminders, oldest due first, at most `limit`. */
export async function findDueReminderIds(now: Date, db: DbClient = prisma, limit = REMINDER_BATCH_SIZE): Promise<string[]> {
    const rows = await db.reminder.findMany({
        // A reminder his phone holds rings there (app 0.5.0): no email for it; nor for a silent one (stage 7).
        where: { status: 'pending', emailSent: false, reminderDate: { lte: now }, phoneAt: null, silent: false },
        select: { id: true },
        orderBy: [{ reminderDate: 'asc' }, { id: 'asc' }],
        take: limit,
    });
    return rows.map((r) => r.id);
}

/** Atomically move one reminder from pending to processing. False if another run claimed it. */
export async function claimReminder(reminderId: string, db: DbClient = prisma): Promise<boolean> {
    const { count } = await db.reminder.updateMany({
        where: { id: reminderId, status: 'pending', emailSent: false },
        data: { status: 'processing' },
    });
    return count === 1;
}

async function setReminderOutcome(reminderId: string, sent: boolean, db: DbClient): Promise<void> {
    // updateMany: no error if the todo (and with it the reminder) was deleted meanwhile.
    await db.reminder.updateMany({
        where: { id: reminderId },
        data: sent ? { status: 'sent', emailSent: true } : { status: 'failed', emailSent: false },
    });
}

export interface ReminderEmailSenders {
    personal: (user: { name: string; email: string }, todo: any, reminder: any) => Promise<boolean>;
    workspace: (user: { name: string; email: string }, todo: any, reminder: any, workspaceName: string) => Promise<boolean>;
}

const defaultSenders: ReminderEmailSenders = {
    personal: sendPersonalTaskReminderEmail,
    workspace: sendWorkspaceTaskReminderEmail,
};

/** Email one claimed reminder. Returns true when at least one email was sent. */
async function deliverReminder(reminderId: string, senders: ReminderEmailSenders, db: DbClient): Promise<boolean | null> {
    const reminder = await db.reminder.findUnique({ where: { id: reminderId }, include: deliveryInclude });
    if (!reminder) {
        console.error(`Reminder ${reminderId} vanished`);
        return null;
    }

    const { todo } = reminder;
    const recipients = todo.assignees.length > 0 ? todo.assignees.map((a) => a.user) : [reminder.user];
    // The email templates read todo.title / description / priority (old populated shape).
    const todoForEmail = { ...todo, _id: todo.id, workspace: todo.workspaceId };

    if (todo.workspaceId) {
        const wsName = todo.workspace?.name || 'Workspace';
        console.log(`📧 Sending workspace task reminder email(s) for ${reminderId}...`);
        const results = await Promise.all(recipients.map((r) => senders.workspace(r, todoForEmail, reminder, wsName)));
        return results.some((ok) => ok === true);
    }

    console.log(`📧 Sending personal task reminder email(s) for ${reminderId}...`);
    const results = await Promise.all(recipients.map((r) => senders.personal(r, todoForEmail, reminder)));
    return results.some((ok) => ok === true);
}

export interface ReminderRunResult {
    due: number;
    sent: number;
    failed: number;
    skipped: number;
}

/** The next time of a series after `now`, at the same clock time in his zone: every day, every weekday (Mon to Fri), every week or on its chosen days. */
export function nextOccurrence(prev: Date, repeat: Repeat, tz: string, now: Date): Date {
    const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(prev).split(':').map(Number);
    const minute = ((h ?? 0) % 24) * 60 + (m ?? 0);
    const days = daysOfRepeat(repeat, prev, tz);
    let day = dayOf(prev, tz);
    for (let i = 0; i < 400; i++) {
        day = addDays(day, repeat === 'weekly' ? 7 : 1);
        if (!days.has(new Date(`${day}T12:00:00Z`).getUTCDay())) continue;
        const at = new Date(startOfDay(day, tz).getTime() + minute * 60_000);
        if (at.getTime() > now.getTime()) return at;
    }
    throw new Error('no next time within the loop');
}

/**
 * A task whose day follows its reminders (a habit: the chat and agents make one due at the reminder's own time, and
 * each next time moves it on), as against a task with a day of its own that a reminder only points at.
 */
export const followsItsReminders = (dueDate: Date | null, reminderDate: Date): boolean => !!dueDate && dueDate.getTime() === reminderDate.getTime();

/**
 * Stage 7: a repeating reminder that passed (rang, sent, showed or failed) makes the next of its series, once; a
 * cancelled one ends the series. A task with a day of its own that is done ends it too; a habit's task (its day
 * follows its reminders) is ticked for that day only: the next time moves its day on and opens it again (his
 * call, 11-18: only a cancel ends a habit's reminders; ticking Monday's run must not stop Wednesday's). Looks
 * back 8 days (a series whose server was down longer starts again at the next set).
 */
export async function rollRepeats(now: Date, db: DbClient = prisma): Promise<number> {
    const passed = await db.reminder.findMany({
        where: { repeat: { not: null }, status: { not: 'cancelled' }, reminderDate: { lte: now, gte: new Date(now.getTime() - 8 * 86_400_000) } },
        include: { user: { select: { timezone: true } }, todo: { select: { title: true, status: true, dueDate: true } } },
        orderBy: { reminderDate: 'desc' },
        take: 200,
    });
    const seen = new Set<string>();
    let made = 0;
    for (const r of passed) {
        const series = r.seriesId ?? r.id;
        if (seen.has(series)) continue; // the newest passed one of each series speaks for it
        seen.add(series);
        const habit = followsItsReminders(r.todo.dueDate, r.reminderDate);
        if (r.todo.status === 'complete' && !habit) continue;
        const later = await db.reminder.findFirst({ where: { seriesId: series, reminderDate: { gt: r.reminderDate } }, select: { id: true } });
        if (later) continue;
        const next = nextOccurrence(r.reminderDate, r.repeat as Repeat, r.user.timezone || 'UTC', now);
        await createTodoReminder({ userId: r.userId, todoId: r.todoId, reminderDate: next, title: r.todo.title, silent: r.silent, repeat: r.repeat as Repeat, seriesId: series }, db);
        await db.todo.updateMany({
            where: { id: r.todoId },
            data: { reminderDate: next, ...(habit ? { dueDate: next, ...(r.todo.status === 'complete' ? { status: 'pending' as const, completedAt: null } : {}) } : {}) },
        });
        made++;
    }
    return made;
}

/** One cron tick. Never throws for a single reminder: it is marked 'failed' and the loop goes on. */
export async function processDueReminders(
    now: Date = new Date(),
    senders: ReminderEmailSenders = defaultSenders,
    db: DbClient = prisma
): Promise<ReminderRunResult> {
    await resetStaleProcessingReminders(now, db);
    // Past reminders his phone held rang there, and silent ones showed (stage 7): done (lists show them sent).
    await db.reminder.updateMany({ where: { status: 'pending', reminderDate: { lte: now }, OR: [{ phoneAt: { not: null } }, { silent: true }] }, data: { status: 'sent' } });
    // Stage 7: each repeating one that passed makes the next of its series.
    await rollRepeats(now, db);
    if (reminderEmailsOff()) {
        // No emails: a past reminder no phone held is marked failed, so turning emails on later sends no flood of old ones.
        const { count } = await db.reminder.updateMany({ where: { status: 'pending', reminderDate: { lte: now } }, data: { status: 'failed' } });
        return { due: count, sent: 0, failed: count, skipped: 0 };
    }

    const dueIds = await findDueReminderIds(now, db);
    if (dueIds.length > 0) {
        console.log(`📧 Found ${dueIds.length} due reminders...`);
    }

    const result: ReminderRunResult = { due: dueIds.length, sent: 0, failed: 0, skipped: 0 };
    for (const reminderId of dueIds) {
        try {
            if (!(await claimReminder(reminderId, db))) {
                result.skipped += 1; // another cron instance already picked it up
                continue;
            }
            const sent = await deliverReminder(reminderId, senders, db);
            if (sent === null) {
                result.skipped += 1;
                continue;
            }
            await setReminderOutcome(reminderId, sent, db);
            if (sent) result.sent += 1;
            else result.failed += 1;
        } catch (error) {
            console.error(`Error processing reminder ${reminderId}:`, error);
            result.failed += 1;
            await setReminderOutcome(reminderId, false, db).catch(() => {});
        }
    }
    return result;
}
