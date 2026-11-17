// Tasks, light (LOOP_COMPLETE_SPEC 4.1): agents list, add and change the user's **personal** tasks
// (never workspace tasks, never attachments, never a delete). The app keeps its own /api/todos.
//
//   listTasks   GET   /api/tasks?due=today|week|overdue|all   read
//   createTask  POST  /api/tasks                              tasks:write (agent: task_create, Undo deletes it)
//   updateTask  PATCH /api/tasks/:id                          tasks:write (agent: task_update, Undo restores it)
import type { Prisma, TodoPriority, TodoStatus } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { addDays, startOfDay, type DayString } from '../learning';
import { badRequest, notFound } from '../learning/http';
import { loadLearningContext } from '../learningDb/common';

export const TASK_DUE = ['today', 'week', 'overdue', 'all'] as const;
export type TaskDue = (typeof TASK_DUE)[number];
export const TASK_PRIORITIES = ['low', 'normal', 'medium', 'high', 'urgent'] as const satisfies readonly TodoPriority[];
export const TASK_STATUSES = ['pending', 'in_progress', 'review', 'blocked', 'complete'] as const satisfies readonly TodoStatus[];
const TITLE_MAX = 200;
const LIST_MAX = 100;

export interface TaskJson {
    _id: string;
    title: string;
    status: TodoStatus;
    priority: TodoPriority;
    /** ISO instant, or null. */
    due: string | null;
    completedAt: string | null;
    createdAt: string;
}

const SELECT = { id: true, title: true, status: true, priority: true, dueDate: true, completedAt: true, createdAt: true } as const;
type Row = Prisma.TodoGetPayload<{ select: typeof SELECT }>;

const json = (t: Row): TaskJson => ({
    _id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    due: t.dueDate?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
});

/** Personal tasks only: the user's own, outside any workspace. */
const personal = (userId: string): Prisma.TodoWhereInput => ({ userId, workspaceId: null });

/**
 * A due day or instant: "2026-11-20" means that day at 18:00 in the user's zone (a time of day that
 * reads as "by the evening"); an ISO instant is kept as it is; null clears it.
 */
function dueOf(value: string | null | undefined, tz: string): Date | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(startOfDay(value as DayString, tz).getTime() + 18 * 3600_000);
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw badRequest('due is a day (YYYY-MM-DD) or an ISO time');
    return d;
}

/** GET /api/tasks: open personal tasks by due window (complete ones only with `all`), soonest first. */
export async function listTasks(userId: string, due: TaskDue = 'all', now: Date = new Date()): Promise<TaskJson[]> {
    const ctx = await loadLearningContext(userId, now);
    const todayStart = startOfDay(ctx.today, ctx.tz);
    const tomorrow = startOfDay(addDays(ctx.today, 1), ctx.tz);
    const weekEnd = startOfDay(addDays(ctx.today, 7), ctx.tz);
    const open: Prisma.TodoWhereInput = { status: { not: 'complete' } };
    const where: Prisma.TodoWhereInput =
        due === 'today'
            ? { ...open, dueDate: { lt: tomorrow } }
            : due === 'week'
              ? { ...open, dueDate: { lt: weekEnd } }
              : due === 'overdue'
                ? { ...open, dueDate: { lt: todayStart } }
                : {};
    const rows = await prisma.todo.findMany({
        where: { ...personal(userId), ...where },
        select: SELECT,
        orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: LIST_MAX,
    });
    return rows.map(json);
}

export interface TaskInput {
    title: string;
    due?: string | null | undefined;
    priority?: TodoPriority | undefined;
}

export async function createTask(userId: string, input: TaskInput, now: Date = new Date()): Promise<TaskJson> {
    const ctx = await loadLearningContext(userId, now);
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
    if (!title) throw badRequest('title cannot be empty');
    const row = await prisma.todo.create({
        data: { userId, title, priority: input.priority ?? 'normal', dueDate: dueOf(input.due, ctx.tz) ?? null, status: 'pending', visibility: 'private' },
        select: SELECT,
    });
    return json(row);
}

export interface TaskPatch {
    title?: string | undefined;
    due?: string | null | undefined;
    priority?: TodoPriority | undefined;
    status?: TodoStatus | undefined;
}

export async function updateTask(userId: string, id: string, patch: TaskPatch, now: Date = new Date()): Promise<TaskJson> {
    const found = await prisma.todo.findFirst({ where: { id, ...personal(userId) }, select: { id: true, status: true } });
    if (!found) throw notFound();
    const ctx = await loadLearningContext(userId, now);
    const title = patch.title !== undefined ? patch.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) : undefined;
    if (title !== undefined && !title) throw badRequest('title cannot be empty');
    const dueDate = dueOf(patch.due, ctx.tz);
    const row = await prisma.todo.update({
        where: { id },
        data: {
            ...(title !== undefined ? { title } : {}),
            ...(dueDate !== undefined ? { dueDate } : {}),
            ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            // Completed now on the first tick; an untick clears it; ticking a done task keeps its day.
            ...(patch.status !== undefined && !(patch.status === 'complete' && found.status === 'complete') ? { completedAt: patch.status === 'complete' ? now : null } : {}),
        },
        select: SELECT,
    });
    return json(row);
}

/** What an agent's change touched, for its Undo. */
export async function taskBefore(userId: string, id: string): Promise<{ id: string; title: string; status: TodoStatus; priority: TodoPriority; dueDate: Date | null; completedAt: Date | null } | null> {
    return prisma.todo.findFirst({ where: { id, ...personal(userId) }, select: { id: true, title: true, status: true, priority: true, dueDate: true, completedAt: true } });
}

/** The brief's tasks: how many are due today and overdue, and up to 3 titles (overdue first). */
export async function taskSummary(userId: string, now: Date = new Date()): Promise<{ dueToday: number; overdue: number; titles: string[] }> {
    const ctx = await loadLearningContext(userId, now);
    const todayStart = startOfDay(ctx.today, ctx.tz);
    const tomorrow = startOfDay(addDays(ctx.today, 1), ctx.tz);
    const rows = await prisma.todo.findMany({
        where: { ...personal(userId), status: { not: 'complete' }, dueDate: { lt: tomorrow } },
        select: { title: true, dueDate: true },
        orderBy: { dueDate: 'asc' },
        take: 50,
    });
    const overdue = rows.filter((r) => r.dueDate! < todayStart);
    return { dueToday: rows.length - overdue.length, overdue: overdue.length, titles: rows.slice(0, 3).map((r) => r.title) };
}
