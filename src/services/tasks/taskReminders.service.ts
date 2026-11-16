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
import { createTodoReminder } from '../reminders/reminders.service';
import { createTask } from './tasks.service';

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
}

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

const json = (r: { id: string; todoId: string; reminderDate: Date; status: ReminderStatus; todo: { title: string } }, tz: string): ReminderJson => ({
    _id: r.id,
    taskId: r.todoId,
    task: r.todo.title,
    at: r.reminderDate.toISOString(),
    when: reminderWhen(r.reminderDate.toISOString(), tz),
    status: r.status,
});
const zoneOf = async (userId: string) => (await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } }))?.timezone || 'UTC';
const SELECT = { id: true, todoId: true, reminderDate: true, status: true, todo: { select: { title: true } } } as const;

/** GET /api/reminders: the ones still to come on his personal tasks, soonest first. */
export async function listReminders(userId: string): Promise<ReminderJson[]> {
    const tz = await zoneOf(userId);
    const rows = await prisma.reminder.findMany({
        where: { userId, status: { in: ['pending', 'processing'] }, todo: { workspaceId: null } },
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
}

/** POST /api/reminders: on his task, or a new task with that title (due at the reminder's time). */
export async function setReminder(userId: string, input: ReminderInput, now: Date = new Date()): Promise<ReminderJson & { createdTask: boolean }> {
    const ctx = await loadLearningContext(userId, now);
    const at = reminderTime(input.at, ctx.tz, ctx.today, now);
    let taskId = input.taskId;
    let title: string;
    if (taskId) {
        const task = await prisma.todo.findFirst({ where: { id: taskId, userId, workspaceId: null }, select: { title: true, status: true } });
        if (!task) throw notFound();
        if (task.status === 'complete') throw conflict('That task is done; a reminder would never matter', 'TASK_DONE');
        title = task.title;
    } else {
        if (!input.title?.trim()) throw badRequest('Give a taskId, or a title for the task to remind about');
        const task = await createTask(userId, { title: input.title, due: at.toISOString() }, now);
        taskId = task._id;
        title = task.title;
    }
    const row = await createTodoReminder({ userId, todoId: taskId, reminderDate: at, title });
    await prisma.todo.update({ where: { id: taskId }, data: { reminderDate: at }, select: { id: true } });
    return { _id: row.id, taskId, task: title, at: at.toISOString(), when: reminderWhen(at.toISOString(), ctx.tz), status: row.status, createdTask: !input.taskId };
}

/** POST /api/reminders/:id/cancel: one still to come. */
export async function cancelReminder(userId: string, id: string): Promise<ReminderJson> {
    const row = await prisma.reminder.findFirst({ where: { id, userId, todo: { workspaceId: null } }, select: SELECT });
    if (!row) throw notFound();
    if (row.status !== 'pending') throw conflict(`That reminder is ${row.status === 'cancelled' ? 'already cancelled' : 'already sent'}`, 'NOT_PENDING');
    await prisma.reminder.update({ where: { id }, data: { status: 'cancelled' }, select: { id: true } });
    await prisma.todo.updateMany({ where: { id: row.todoId, reminderDate: row.reminderDate }, data: { reminderDate: null } });
    return json({ ...row, status: 'cancelled' }, await zoneOf(userId));
}

/** Undo of a cancel: the reminder is set again while its time is still ahead. */
export async function restoreReminder(userId: string, id: string, now: Date = new Date()): Promise<void> {
    const row = await prisma.reminder.findFirst({ where: { id, userId }, select: { status: true, reminderDate: true, todoId: true } });
    if (!row || row.status !== 'cancelled') throw conflict("Can't undo: that reminder has changed since", 'CHANGED');
    if (row.reminderDate.getTime() <= now.getTime()) throw conflict("Can't undo: that reminder's time has passed", 'PASSED');
    await prisma.reminder.update({ where: { id }, data: { status: 'pending', emailSent: false, phoneAt: null }, select: { id: true } });
    await prisma.todo.updateMany({ where: { id: row.todoId }, data: { reminderDate: row.reminderDate } });
}

/** Undo of a set: the reminder is cancelled; a task made for it is deleted too. */
export async function unsetReminder(userId: string, id: string, createdTaskId: string | null): Promise<void> {
    const row = await prisma.reminder.findFirst({ where: { id, userId }, select: { status: true, todoId: true, reminderDate: true } });
    if (!row) return;
    if (createdTaskId && createdTaskId === row.todoId) {
        await prisma.todo.deleteMany({ where: { id: createdTaskId, userId, workspaceId: null } });
        return;
    }
    if (row.status === 'pending') await prisma.reminder.update({ where: { id }, data: { status: 'cancelled' }, select: { id: true } });
    await prisma.todo.updateMany({ where: { id: row.todoId, reminderDate: row.reminderDate }, data: { reminderDate: null } });
}

/** The words for a reminder's time in his zone ("Sat 15 Nov, 19:00"). */
export function reminderWhen(at: string, tz: string): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(at));
}
