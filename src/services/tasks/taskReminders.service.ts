// Reminders for agents and the manager (MANAGER_AND_DOCS_PLAN §3.3): a reminder is a personal task
// with a time. On a task, or free-standing ("remind me at 7 pm to call the bank" makes that task).
// The existing todo-reminder rows and their cron deliver them (an email at the time).
//
//   listReminders   GET  /api/reminders               read
//   setReminder     POST /api/reminders               tasks:write (agent: reminder_set, Undo cancels it)
//   cancelReminder  POST /api/reminders/:id/cancel    tasks:write (agent: reminder_cancel, Undo sets it again)
import type { ReminderStatus } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { startOfDay, addDays, type DayString } from '../learning';
import { badRequest, conflict, notFound } from '../learning/http';
import { loadLearningContext } from '../learningDb/common';
import { REPEATS, createTodoReminder, daysOfRepeat, firstOccurrence, followsItsReminders, normalizeRepeat, repeatOfDays } from '../reminders/reminders.service';
import { createTask } from './tasks.service';
import { poke } from '../scheduler/scheduler';

const LIST_MAX = 50;
const YEAR_MS = 366 * 86_400_000;

export interface ReminderJson {
    _id: string;
    taskId: string;
    task: string;
    /** ISO instant. */
    at: string;
    /** The time in his zone, in words ("Sat 15 Nov, 19:00"). */
    when: string;
    status: ReminderStatus;
    /** Stage 7: it rings (an alarm on the phone, an email) or it is silent (it shows on the home picture). */
    ring: boolean;
    /** Stage 7: daily | weekdays | weekly, or null. */
    repeat: string | null;
}

export { REPEATS };

/**
 * When to remind: an ISO instant with a zone; "YYYY-MM-DDTHH:mm" in his time zone; or "HH:mm"
 * (today in his zone, tomorrow when that time has passed). Always ahead of now, within a year.
 */
export function reminderTime(value: string, tz: string, today: DayString, now: Date): Date {
    const v = value.trim();
    let at: Date;
    const local = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})$/);
    const clock = v.match(/^(\d{1,2}):(\d{2})$/);
    const at_ = (day: DayString, h: number, m: number) => new Date(startOfDay(day, tz).getTime() + (h * 60 + m) * 60_000);
    if (local) at = at_(local[1] as DayString, Number(local[2]), Number(local[3]));
    else if (clock) {
        at = at_(today, Number(clock[1]), Number(clock[2]));
        if (at.getTime() <= now.getTime()) at = at_(addDays(today, 1), Number(clock[1]), Number(clock[2]));
    } else if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(v)) at = new Date(v);
    else throw badRequest('at is "HH:mm", "YYYY-MM-DDTHH:mm" (his time zone) or an ISO time with a zone');
    if (Number.isNaN(at.getTime())) throw badRequest('at is not a real time');
    if (at.getTime() <= now.getTime()) throw badRequest('That time has already passed');
    if (at.getTime() > now.getTime() + YEAR_MS) throw badRequest('A reminder can be at most a year ahead');
    return at;
}

const json = (r: { id: string; todoId: string; reminderDate: Date; status: ReminderStatus; silent: boolean; repeat: string | null; todo: { title: string } }, tz: string): ReminderJson => ({
    _id: r.id,
    taskId: r.todoId,
    task: r.todo.title,
    at: r.reminderDate.toISOString(),
    when: reminderWhen(r.reminderDate.toISOString(), tz),
    status: r.status,
    ring: !r.silent,
    repeat: r.repeat,
});
const zoneOf = async (userId: string) => (await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } }))?.timezone || 'UTC';
const SELECT = { id: true, todoId: true, reminderDate: true, status: true, silent: true, repeat: true, todo: { select: { title: true } } } as const;

/** GET /api/reminders: the ones still to come on his personal tasks, soonest first. */
export async function listReminders(userId: string, now: Date = new Date()): Promise<ReminderJson[]> {
    const tz = await zoneOf(userId);
    const rows = await prisma.reminder.findMany({
        // A past one his phone held has rung there, though its row is marked sent only by the next pass.
        where: { userId, status: { in: ['pending', 'processing'] }, todo: { workspaceId: null }, NOT: { phoneAt: { not: null }, reminderDate: { lte: now } } },
        select: SELECT,
        orderBy: [{ reminderDate: 'asc' }, { id: 'asc' }],
        take: LIST_MAX,
    });
    return rows.map((r) => json(r, tz));
}

export interface ReminderInput {
    taskId?: string | undefined;
    /** For a free-standing reminder: the task it makes. */
    title?: string | undefined;
    at: string;
    /** Stage 7: true rings (an alarm on the phone, an email); otherwise silent (the chat and agents' default). */
    ring?: boolean | undefined;
    /** Stage 7: repeats daily, on weekdays, weekly or on chosen days ("mon,wed,fri") until cancelled. */
    repeat?: string | undefined;
}

/** How a reminder was before a set changed it (its Undo puts it back instead of cancelling it). */
export interface ReminderBefore {
    at: string;
    ring: boolean;
    repeat: string | null;
}

const REMINDER_STOPWORDS = new Set(['a', 'an', 'the', 'to', 'my', 'me', 'for', 'and', 'of', 'at', 'on', 'in', 'before', 'after', 'reminder', 'remind']);
const reminderWords = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !REMINDER_STOPWORDS.has(w)));
/** Two titles that say the same thing (most of the shorter one's words in the other). Also the buddy's tasks from words (stage 5b). */
export function sameWords(a: string, b: string): boolean {
    const mine = reminderWords(a);
    const theirs = reminderWords(b);
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    return mine.size > 0 && theirs.size > 0 && shared / Math.min(mine.size, theirs.size) >= 0.6;
}

const PENDING_SELECT = { id: true, todoId: true, silent: true, repeat: true, reminderDate: true, todo: { select: { title: true, dueDate: true } } } as const;

/** A pending reminder at the same minute on that task, or on a task whose title says the same thing. */
async function sameReminder(userId: string, at: Date, input: ReminderInput) {
    const rows = await prisma.reminder.findMany({ where: { userId, status: 'pending', reminderDate: at, todo: { workspaceId: null } }, select: PENDING_SELECT });
    if (input.taskId) return rows.find((r) => r.todoId === input.taskId) ?? null;
    return rows.find((r) => sameWords(input.title ?? '', r.todo.title)) ?? null;
}

/** A repeating series at the same clock time about the same thing (that task, or a task whose title says the same). */
async function sameSeries(userId: string, at: Date, tz: string, input: ReminderInput) {
    const rows = await prisma.reminder.findMany({ where: { userId, status: 'pending', repeat: { not: null }, todo: { workspaceId: null, status: { not: 'complete' } } }, select: PENDING_SELECT });
    const clock = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    const same = rows.filter((r) => clock(r.reminderDate) === clock(at));
    if (input.taskId) return same.find((r) => r.todoId === input.taskId) ?? null;
    return same.find((r) => sameWords(input.title ?? '', r.todo.title)) ?? null;
}

const beforeOf = (r: { reminderDate: Date; silent: boolean; repeat: string | null }): ReminderBefore => ({ at: r.reminderDate.toISOString(), ring: !r.silent, repeat: r.repeat });

/** POST /api/reminders: on his task, or a new task with that title (due at the reminder's time). */
export async function setReminder(userId: string, input: ReminderInput, now: Date = new Date()): Promise<ReminderJson & { createdTask: boolean; before?: ReminderBefore }> {
    const ctx = await loadLearningContext(userId, now);
    const repeat = input.repeat === undefined ? undefined : normalizeRepeat(input.repeat);
    if (repeat === null) throw badRequest('repeat is daily, weekdays, weekly or days of the week, like "mon,wed,fri"');
    // A weekly one names its day by its first time: a bare "06:30" would pick today or tomorrow, whatever day that
    // is (the week's simulation, issue 14: Monday's run landed on Tuesday). The caller says the day. (The words
    // "ring" and "repeat" stay out of this message: the MCP takes a 400 naming them for an older server and drops both.)
    if (repeat === 'weekly' && /^\s*\d{1,2}:\d{2}\s*$/.test(input.at)) throw badRequest('A weekly reminder needs its first day: give at as "YYYY-MM-DDTHH:mm", the first time it comes');
    let at = reminderTime(input.at, ctx.tz, ctx.today, now);
    // A series starts on its first day: "every weekday at 9" asked on a Saturday starts on Monday.
    if (repeat) at = firstOccurrence(at, repeat, ctx.tz);
    // The same reminder asked for again (a model that set it twice, a retry): the one already there at that minute,
    // brought up to date (a ring asked for wins; a repeat stays), never a second one. The week's simulation (11-18)
    // ended with three tasks and two alarms for one 6:30 run.
    const twin = await sameReminder(userId, at, input);
    if (twin) {
        const row = await prisma.reminder.update({ where: { id: twin.id }, data: { silent: twin.silent && input.ring !== true, repeat: repeat ?? twin.repeat }, select: SELECT });
        return { ...json(row, ctx.tz), createdTask: false, before: beforeOf(twin) };
    }
    // Another day for a series at the same clock time about the same thing joins it (issue 15: runs on Monday,
    // Wednesday and Friday at 6:30 made three weekly series and three tasks). Its next time comes forward when the
    // new day comes first.
    if (repeat) {
        const series = await sameSeries(userId, at, ctx.tz, input);
        if (series) {
            const days = daysOfRepeat(series.repeat!, series.reminderDate, ctx.tz);
            const had = days.size;
            for (const d of daysOfRepeat(repeat, at, ctx.tz)) days.add(d);
            const sooner = at.getTime() < series.reminderDate.getTime();
            const row = await prisma.reminder.update({
                where: { id: series.id },
                data: { silent: series.silent && input.ring !== true, repeat: days.size === had ? series.repeat : repeatOfDays(days), ...(sooner ? { reminderDate: at, phoneAt: null } : {}) },
                select: SELECT,
            });
            // A habit's day follows its reminders: it comes forward with them.
            if (sooner) await prisma.todo.update({ where: { id: series.todoId }, data: { reminderDate: at, ...(followsItsReminders(series.todo.dueDate, series.reminderDate) ? { dueDate: at } : {}) }, select: { id: true } });
            poke('reminders');
            return { ...json(row, ctx.tz), createdTask: false, before: beforeOf(series) };
        }
    }
    let taskId = input.taskId;
    let title: string;
    let createdTask = false;
    if (taskId) {
        const task = await prisma.todo.findFirst({ where: { id: taskId, userId, workspaceId: null }, select: { title: true, status: true } });
        if (!task) throw notFound();
        if (task.status === 'complete') throw conflict('That task is done; a reminder would never matter', 'TASK_DONE');
        title = task.title;
    } else {
        if (!input.title?.trim()) throw badRequest('Give a taskId, or a title for the task to remind about');
        // An open task made for an earlier reminder that says the same thing (one cancelled to be set again, another
        // time for the same habit) takes this one too: one task, never three "Run (3k, easy pace)" (issue 15).
        const made = await prisma.todo.findMany({ where: { userId, workspaceId: null, status: { not: 'complete' }, reminders: { some: {} } }, select: { id: true, title: true, dueDate: true }, orderBy: { createdAt: 'desc' }, take: 50 });
        const earlier = made.find((t) => sameWords(input.title!, t.title));
        if (earlier) {
            taskId = earlier.id;
            title = earlier.title;
            // Its day moves to this reminder's when it had passed (an overdue habit task would only nag).
            if (!earlier.dueDate || earlier.dueDate.getTime() < now.getTime()) await prisma.todo.update({ where: { id: earlier.id }, data: { dueDate: at }, select: { id: true } });
        } else {
            const task = await createTask(userId, { title: input.title, due: at.toISOString() }, now);
            taskId = task._id;
            title = task.title;
            createdTask = true;
        }
    }
    const row = await createTodoReminder({ userId, todoId: taskId, reminderDate: at, title, silent: input.ring !== true, repeat: repeat ?? null });
    await prisma.todo.update({ where: { id: taskId }, data: { reminderDate: at }, select: { id: true } });
    return { _id: row.id, taskId, task: title, at: at.toISOString(), when: reminderWhen(at.toISOString(), ctx.tz), status: row.status, ring: !row.silent, repeat: row.repeat, createdTask };
}

/** POST /api/reminders/:id/cancel: one still to come (a repeating one: its series ends with it). */
export async function cancelReminder(userId: string, id: string): Promise<ReminderJson> {
    const row = await prisma.reminder.findFirst({ where: { id, userId, todo: { workspaceId: null } }, select: SELECT });
    if (!row) throw notFound();
    if (row.status !== 'pending') throw conflict(`That reminder is ${row.status === 'cancelled' ? 'already cancelled' : 'already sent'}`, 'NOT_PENDING');
    await prisma.reminder.update({ where: { id }, data: { status: 'cancelled' }, select: { id: true } });
    await prisma.todo.updateMany({ where: { id: row.todoId, reminderDate: row.reminderDate }, data: { reminderDate: null } });
    poke('reminders');
    return json({ ...row, status: 'cancelled' }, await zoneOf(userId));
}

/** Undo of a cancel: the reminder is set again while its time is still ahead. */
export async function restoreReminder(userId: string, id: string, now: Date = new Date()): Promise<void> {
    const row = await prisma.reminder.findFirst({ where: { id, userId }, select: { status: true, reminderDate: true, todoId: true } });
    if (!row || row.status !== 'cancelled') throw conflict("Can't undo: that reminder has changed since", 'CHANGED');
    if (row.reminderDate.getTime() <= now.getTime()) throw conflict("Can't undo: that reminder's time has passed", 'PASSED');
    await prisma.reminder.update({ where: { id }, data: { status: 'pending', emailSent: false, phoneAt: null }, select: { id: true } });
    await prisma.todo.updateMany({ where: { id: row.todoId }, data: { reminderDate: row.reminderDate } });
    poke('reminders');
}

/** Undo of a set: the reminder is cancelled; a task made for it is deleted too. */
export async function unsetReminder(userId: string, id: string, createdTaskId: string | null, before: ReminderBefore | null = null): Promise<void> {
    const row = await prisma.reminder.findFirst({ where: { id, userId }, select: { status: true, todoId: true, reminderDate: true } });
    if (!row) return;
    // A set that changed a reminder already there (the same one again, or a day added to a series): put it back as it was.
    if (before) {
        const at = new Date(before.at);
        if (row.status === 'pending') {
            const moved = at.getTime() !== row.reminderDate.getTime();
            await prisma.reminder.update({ where: { id }, data: { silent: !before.ring, repeat: before.repeat, ...(moved ? { reminderDate: at, phoneAt: null } : {}) }, select: { id: true } });
            if (moved) {
                await prisma.todo.updateMany({ where: { id: row.todoId, reminderDate: row.reminderDate }, data: { reminderDate: at } });
                await prisma.todo.updateMany({ where: { id: row.todoId, dueDate: row.reminderDate }, data: { dueDate: at } });
            }
        }
        poke('reminders');
        return;
    }
    if (createdTaskId && createdTaskId === row.todoId) {
        await prisma.todo.deleteMany({ where: { id: createdTaskId, userId, workspaceId: null } });
        poke('reminders');
        return;
    }
    if (row.status === 'pending') await prisma.reminder.update({ where: { id }, data: { status: 'cancelled' }, select: { id: true } });
    await prisma.todo.updateMany({ where: { id: row.todoId, reminderDate: row.reminderDate }, data: { reminderDate: null } });
    poke('reminders');
}

/** The words for a reminder's time in his zone ("Sat 15 Nov, 19:00"). */
export function reminderWhen(at: string, tz: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(at));
}
