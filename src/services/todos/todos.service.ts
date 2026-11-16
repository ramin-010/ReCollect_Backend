// Personal todos (/api/todos): every Prisma query of the personal task endpoints.
//
// Mongoose behaviour redone here:
//   - Todo pre('save') hook: completedAt = now when a todo is CREATED with status 'complete'.
//     Updates: completedAt is set when status becomes 'complete' and cleared when it leaves
//     'complete' for any state (the old PATCH handler cleared it only on 'pending'; fixed 11-15).
//   - trim/required/enum validators and subdocument casting: see ./todoInput.
//   - tags[] / assignees[] arrays: the TodoTag / TodoAssignee join tables, written in array order
//     (see ./todoShape). Mongo stored any ObjectId; Postgres has foreign keys, so assignee ids that
//     are not users are dropped (populate dropped them from every response anyway).
//   - $push of uploaded images onto cloudImages: an atomic jsonb append.
// The three Mongo transactions (create/update/delete) are prisma.$transaction blocks; Cloudinary
// deletes run after the delete commits.
import { Prisma } from '@prisma/client';
import type { GoalType, TodoStatus } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { containsInsensitive } from '../../db/filters';
import { isRecordNotFound } from '../../db/errors';
import ErrorResponse from '../../utils/errorResponse';
import { batchDeleteFromCloud } from '../../utils/cloudinary';
import { normalizeTagNames, resolveTagIds } from '../tags/tags.service';
import { createTodoReminder, deleteTodoReminders } from '../reminders/reminders.service';
import { createNotification } from '../notifications/notifications.service';
import { findOrCreatePlaceholderUser, findUserByEmail, findUserById } from '../users/users.service';
import { todoAssigneeRows, todoInclude, todoTagRows, type TodoWithRelations } from './todoShape';
import { initialGoalDueDay } from '../learning/goals';
import { resolveTimeZone, today as todayIn } from '../learning/time';
import { parseDateOnly } from '../../utils/timezone';
import {
    castCreateDate,
    normalizeRecurrence,
    normalizeReferences,
    normalizeSubtasks,
    normalizeTitle,
    parseAssigneeIds,
    parseGoalType,
    parseStringList,
    parseTodoPriority,
    parseTodoStatus,
    parseTodoVisibility,
    parseUpdateDate,
    resolveUploadedImages,
    TASK_REFERENCE_TYPES,
    type TodoCloudImageJson,
} from './todoInput';

/** Personal tasks never show workspace tasks (Mongo: visibility in private/shared/null). */
export const PERSONAL_VISIBILITIES = ['private', 'shared'] as const;

export const TASK_NOT_FOUND = 'Task not found';
export const TASK_NOT_OWNED = 'Task not found or you do not own it';

/** What the controller passes to scheduleTodoReminder() after the transaction committed. */
export interface ScheduledReminder {
    reminderId: string;
    remindAt: Date;
}

export interface TodoWriteResult {
    todo: TodoWithRelations;
    reminder: ScheduledReminder | null;
}

type Body = Record<string, unknown>;

// ─── Helpers ───────────────────────────────────────────────────────────

/** Keep the ids that are real users, in the given order. */
async function existingUserIds(ids: readonly string[], db: DbClient): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await db.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
    const found = new Set(rows.map((r) => r.id));
    return ids.filter((id) => found.has(id));
}

async function replaceTodoTags(todoId: string, tagIds: readonly string[], now: Date, db: DbClient): Promise<void> {
    await db.todoTag.deleteMany({ where: { todoId } });
    if (tagIds.length > 0) await db.todoTag.createMany({ data: todoTagRows(todoId, tagIds, now) });
}

async function replaceTodoAssignees(todoId: string, userIds: readonly string[], now: Date, db: DbClient): Promise<void> {
    await db.todoAssignee.deleteMany({ where: { todoId } });
    if (userIds.length > 0) await db.todoAssignee.createMany({ data: todoAssigneeRows(todoId, userIds, now) });
}

/** Mongo `$push: { cloudImages: { $each } }`, atomically. */
async function appendCloudImages(todoId: string, images: readonly TodoCloudImageJson[], db: DbClient): Promise<void> {
    if (images.length === 0) return;
    await db.$executeRaw`UPDATE "Todo" SET "cloudImages" = COALESCE("cloudImages", '[]'::jsonb) || ${JSON.stringify(images)}::jsonb WHERE "id" = ${todoId}`;
}

export function findTodoWithRelations(todoId: string, db: DbClient = prisma): Promise<TodoWithRelations | null> {
    return db.todo.findUnique({ where: { id: todoId }, include: todoInclude });
}

/**
 * The todo for the response, read AFTER the transaction committed: Prisma runs the include's
 * relation queries in parallel, which a single transaction connection would have to serialize.
 */
async function loadTodoOrThrow(todoId: string, db: DbClient = prisma): Promise<TodoWithRelations> {
    const todo = await findTodoWithRelations(todoId, db);
    if (!todo) throw new ErrorResponse(404, TASK_NOT_FOUND);
    return todo;
}

/**
 * Due date for a weekly / monthly goal that has none (LEARNING_SPEC §2 "Changes to /api/todos"):
 * the engine's goal due day (this / next Sunday, or the end of the month) in the user's zone, at
 * 18:00 local (Recollect's date-only rule). Null for NONE.
 */
async function goalDueDate(userId: string, goalType: GoalType, now: Date, db: DbClient): Promise<Date | null> {
    if (goalType === 'NONE') return null;
    const user = await db.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    const tz = resolveTimeZone(user?.timezone);
    const day = initialGoalDueDay(goalType, todayIn(tz, now));
    return day ? parseDateOnly(day, { timeZone: tz }) : null;
}

function bodyText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    return String(value);
}

// ─── List / search ─────────────────────────────────────────────────────

export interface ListTodosQuery {
    status?: unknown;
    priority?: unknown;
    refType?: unknown;
    refId?: unknown;
}

/**
 * GET /todos: the user's own and assigned personal tasks, newest update first. Optional filters
 * (other values are ignored, as before): status pending|complete, priority low|medium|high, and
 * refType doc|content|slide + refId (both needed).
 */
export function listPersonalTodos(userId: string, query: ListTodosQuery, db: DbClient = prisma): Promise<TodoWithRelations[]> {
    const where: Prisma.TodoWhereInput = {
        OR: [{ userId }, { assignees: { some: { userId } } }],
        visibility: { in: [...PERSONAL_VISIBILITIES] },
    };

    const { status, priority, refType, refId } = query;
    if (status === 'pending' || status === 'complete') {
        where.status = status;
    }
    if (priority === 'low' || priority === 'medium' || priority === 'high') {
        where.priority = priority;
    }
    if (
        typeof refType === 'string' &&
        typeof refId === 'string' &&
        refId &&
        (TASK_REFERENCE_TYPES as readonly string[]).includes(refType)
    ) {
        // Mongo: references: { $elemMatch: { type, refId } }
        where.references = { array_contains: [{ type: refType, refId }] };
    }

    return db.todo.findMany({ where, include: todoInclude, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }] });
}

export interface ReferenceSearchResult {
    type: 'doc';
    refId: string;
    title: string;
}

/**
 * GET /todos/search-references (the @ mention picker): the user's own and shared docs whose title
 * contains q (case-insensitive, matched literally; the old RegExp was not escaped), not archived,
 * newest update first, at most 10. Slides were cut, so only docs are returned.
 */
export async function searchTodoReferences(userId: string, q: string, db: DbClient = prisma): Promise<ReferenceSearchResult[]> {
    const docs = await db.doc.findMany({
        where: {
            OR: [{ userId }, { collaborators: { some: { userId } } }],
            isArchived: false,
            ...(q ? { title: containsInsensitive(q) } : {}),
        },
        select: { id: true, title: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 10,
    });
    return docs.map((d) => ({ type: 'doc' as const, refId: d.id, title: d.title || 'Untitled Doc' }));
}

// ─── Create ────────────────────────────────────────────────────────────

/**
 * POST /todos. `body` is the JSON or multipart body, `files` what upfly put on req.files.
 * Throws 400 "Task title is required" first, then the Mongoose validation messages.
 */
export async function createPersonalTodo(userId: string, body: Body, files: unknown, now: Date = new Date()): Promise<TodoWriteResult> {
    if (typeof body.title !== 'string' || !body.title.trim()) {
        throw new ErrorResponse(400, 'Task title is required');
    }
    const title = normalizeTitle(body.title);

    // Same defaults as the old controller (note: 'medium', not the schema's 'low').
    const status: TodoStatus = parseTodoStatus(body.status || 'pending');
    const priority = parseTodoPriority(body.priority || 'medium');
    const subtasks = normalizeSubtasks(body.subtasks);
    const references = normalizeReferences(body.references);
    const recurrence = normalizeRecurrence(body.recurrence);
    const tagNames = normalizeTagNames(parseStringList(body.tags));
    const requestedAssignees = parseAssigneeIds(body.assignees) ?? [];
    let dueDate = castCreateDate(body.dueDate, 'dueDate');
    const goalType = parseGoalType(body.goalType);
    const reminderDate = castCreateDate(body.reminderDate, 'reminderDate');

    const rawDescription = body.description ? bodyText(body.description) : '';
    const { description, cloudImages } = resolveUploadedImages(rawDescription, body.imageNodeIds, files);

    const { todoId, reminder } = await prisma.$transaction(async (tx) => {
        const tagIds = await resolveTagIds(tagNames, tx);
        const assigneeIds = await existingUserIds(requestedAssignees, tx);
        // A new weekly / monthly goal with no date gets the goal's due day.
        if (!dueDate && goalType !== 'NONE') dueDate = await goalDueDate(userId, goalType, now, tx);

        const created = await tx.todo.create({
            data: {
                userId,
                title,
                description: description || null,
                status,
                priority,
                dueDate,
                reminderDate,
                // Todo pre('save') hook: completing on creation stamps completedAt.
                completedAt: status === 'complete' ? now : null,
                subtasks,
                cloudImages,
                recurrence: recurrence ?? Prisma.DbNull,
                assignedAt: assigneeIds.length > 0 ? now : null,
                references,
                goalType,
                workspaceId: null, // Personal tasks have no workspace
                spaceId: null,
                visibility: body.visibility === 'shared' ? 'shared' : 'private',
                createdAt: now,
            },
            select: { id: true },
        });

        if (tagIds.length > 0) await tx.todoTag.createMany({ data: todoTagRows(created.id, tagIds, now) });
        if (assigneeIds.length > 0) await tx.todoAssignee.createMany({ data: todoAssigneeRows(created.id, assigneeIds, now) });

        let reminder: ScheduledReminder | null = null;
        if (reminderDate) {
            const row = await createTodoReminder({ userId, todoId: created.id, reminderDate, title }, tx);
            reminder = { reminderId: row.id, remindAt: reminderDate };
        }

        return { todoId: created.id, reminder };
    });

    return { todo: await loadTodoOrThrow(todoId), reminder };
}

// ─── Update ────────────────────────────────────────────────────────────

/** Owner or assignee, and never a workspace task (403 otherwise). */
function assertCanUpdate(todo: { userId: string; visibility: string; assignees: Array<{ userId: string }> }, userId: string): void {
    const allowed = todo.userId === userId || todo.assignees.some((a) => a.userId === userId);
    if (!allowed || todo.visibility === 'workspace') {
        throw new ErrorResponse(403, "You don't have permission to update this personal task");
    }
}

/**
 * PATCH /todos/:id. Only these body keys are applied: title, description, status, priority,
 * dueDate, reminderDate, subtasks, tags, assignees, recurrence, references, visibility, goalType
 * (+ imageNodeIds with the uploaded files). When reminderDate is present the todo's reminders are
 * replaced (deleted, and re-created if the new date is set).
 */
export async function updatePersonalTodo(
    userId: string,
    todoId: string,
    body: Body,
    files: unknown,
    now: Date = new Date()
): Promise<TodoWriteResult> {
    const reminder = await prisma.$transaction(async (tx) => {
        const existing = await tx.todo.findUnique({
            where: { id: todoId },
            select: {
                id: true,
                userId: true,
                title: true,
                status: true,
                visibility: true,
                dueDate: true,
                assignees: { select: { userId: true } },
            },
        });
        if (!existing) throw new ErrorResponse(404, TASK_NOT_FOUND);
        assertCanUpdate(existing, userId);

        // 1. Parse and validate everything before writing anything.
        const data: Prisma.TodoUncheckedUpdateInput = {};
        let newCloudImages: TodoCloudImageJson[] = [];

        if (body.description !== undefined) {
            if (typeof body.description === 'string' && body.description) {
                const resolved = resolveUploadedImages(body.description, body.imageNodeIds, files);
                data.description = resolved.description;
                newCloudImages = resolved.cloudImages;
            } else {
                data.description = body.description === null ? null : bodyText(body.description);
            }
        }
        if (body.title !== undefined) data.title = normalizeTitle(body.title);
        if (body.status !== undefined) data.status = parseTodoStatus(body.status);
        if (body.priority !== undefined) data.priority = parseTodoPriority(body.priority);
        if (body.dueDate !== undefined) data.dueDate = parseUpdateDate(body.dueDate);
        const newReminderDate = body.reminderDate !== undefined ? parseUpdateDate(body.reminderDate) : null;
        if (body.reminderDate !== undefined) data.reminderDate = newReminderDate;
        if (body.subtasks !== undefined) data.subtasks = normalizeSubtasks(body.subtasks);
        if (body.recurrence !== undefined) data.recurrence = normalizeRecurrence(body.recurrence) ?? Prisma.DbNull;
        if (body.references !== undefined) data.references = normalizeReferences(body.references);
        if (body.visibility !== undefined) data.visibility = parseTodoVisibility(body.visibility);
        if (body.goalType !== undefined) {
            const goalType = parseGoalType(body.goalType);
            data.goalType = goalType;
            // Turning a dateless todo into a goal gives it the goal's due day.
            const resultingDue = data.dueDate !== undefined ? data.dueDate : existing.dueDate;
            if (goalType !== 'NONE' && !resultingDue) data.dueDate = await goalDueDate(userId, goalType, now, tx);
        }

        // tags: a list replaces the tags; an empty list (or null) clears them. Absent = unchanged.
        const tagNames = body.tags !== undefined ? normalizeTagNames(parseStringList(body.tags)) : null;

        // assignees: a list replaces them; anything else clears them.
        let assigneeIds: string[] | null = null;
        if (body.assignees !== undefined) {
            const requested = parseAssigneeIds(body.assignees);
            assigneeIds = requested ? await existingUserIds(requested, tx) : [];
            data.assignedAt = requested && requested.length > 0 ? now : null;
        }

        // completedAt: stamped when it becomes complete, cleared when it leaves complete for any state
        // (the old handler cleared it only on 'pending', so a task moved back to review or in progress
        // still read as completed: fixed 11-15, the builder's call).
        if (data.status === 'complete' && existing.status !== 'complete') {
            data.completedAt = now;
        } else if (data.status !== undefined && data.status !== 'complete' && existing.status === 'complete') {
            data.completedAt = null;
        }

        // 2. Write.
        if (tagNames !== null) {
            await replaceTodoTags(todoId, await resolveTagIds(tagNames, tx), now, tx);
        }
        if (assigneeIds) {
            await replaceTodoAssignees(todoId, assigneeIds, now, tx);
        }

        let reminder: ScheduledReminder | null = null;
        if (body.reminderDate !== undefined) {
            await deleteTodoReminders(todoId, tx);
            if (newReminderDate) {
                const reminderTitle = typeof data.title === 'string' ? data.title : existing.title;
                const row = await createTodoReminder({ userId, todoId, reminderDate: newReminderDate, title: reminderTitle }, tx);
                reminder = { reminderId: row.id, remindAt: newReminderDate };
            }
        }

        await appendCloudImages(todoId, newCloudImages, tx);
        try {
            await tx.todo.update({ where: { id: todoId }, data: { ...data, updatedAt: now } });
        } catch (err) {
            if (isRecordNotFound(err)) throw new ErrorResponse(404, TASK_NOT_FOUND);
            throw err;
        }

        return reminder;
    });

    return { todo: await loadTodoOrThrow(todoId), reminder };
}

// ─── Delete ────────────────────────────────────────────────────────────

/**
 * DELETE /todos/:id: only the owner, never a workspace task. Reminders, tag links and assignees
 * go with the todo; its Cloudinary images are deleted after the transaction (failures are logged).
 */
export async function deletePersonalTodo(userId: string, todoId: string): Promise<void> {
    const publicIds = await prisma.$transaction(async (tx) => {
        const todo = await tx.todo.findUnique({
            where: { id: todoId },
            select: { id: true, userId: true, visibility: true, cloudImages: true },
        });
        if (!todo) throw new ErrorResponse(404, TASK_NOT_FOUND);
        if (todo.userId !== userId || todo.visibility === 'workspace') {
            throw new ErrorResponse(403, "You don't have permission to delete this personal task");
        }

        await deleteTodoReminders(todo.id, tx);
        await tx.todo.deleteMany({ where: { id: todo.id } });
        return cloudPublicIds(todo.cloudImages);
    });

    if (publicIds.length > 0) {
        await batchDeleteFromCloud(publicIds);
    }
}

/** cloudPublicId of every [{ imageId, cloudPublicId }] entry. */
export function cloudPublicIds(cloudImages: Prisma.JsonValue): string[] {
    if (!Array.isArray(cloudImages)) return [];
    return cloudImages
        .map((img) => (img && typeof img === 'object' && !Array.isArray(img) ? (img as Record<string, unknown>).cloudPublicId : null))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

// ─── Assign / unassign ─────────────────────────────────────────────────

export interface AssignResult {
    todo: TodoWithRelations;
    ghostEmails: string[];
}

/**
 * POST /todos/:id/assign { emails }: the owner assigns a personal task by email. Unknown emails get
 * a placeholder ("ghost") user. The owner and existing assignees are skipped. Every new assignee
 * gets a 'task_assigned' notification; the task becomes 'shared'.
 */
export async function assignPersonalTodo(userId: string, todoId: string, emails: unknown, now: Date = new Date()): Promise<AssignResult> {
    if (!emails || !Array.isArray(emails)) {
        throw new ErrorResponse(400, 'Emails array is required');
    }
    const normalizedEmails = [
        ...new Set(emails.filter((e): e is string => typeof e === 'string').map((e) => e.toLowerCase().trim()).filter(Boolean)),
    ];
    if (normalizedEmails.length === 0) {
        throw new ErrorResponse(400, 'At least one valid email is required');
    }

    const ghostEmails = await prisma.$transaction(async (tx) => {
        const todo = await tx.todo.findFirst({
            where: { id: todoId, userId, visibility: { in: [...PERSONAL_VISIBILITIES] } },
            select: { id: true, title: true, assignees: { select: { userId: true } } },
        });
        if (!todo) throw new ErrorResponse(404, TASK_NOT_OWNED);

        const currentUser = await findUserById(userId, tx);
        const existingAssignees = new Set(todo.assignees.map((a) => a.userId));
        const assigned: string[] = [];
        const ghostEmails: string[] = [];

        for (const email of normalizedEmails) {
            const { user: target, created } = await findOrCreatePlaceholderUser(email, tx);
            if (created) {
                ghostEmails.push(email);
                console.log(`[assign] Created ghost user: ${target.id}`);
            }
            // No self-assignment, no duplicates.
            if (target.id === userId || existingAssignees.has(target.id)) continue;

            existingAssignees.add(target.id);
            assigned.push(target.id);

            await createNotification(
                {
                    recipientId: target.id,
                    senderId: userId,
                    category: 'informational',
                    type: 'task_assigned',
                    title: 'Task Assigned',
                    message: `${currentUser?.name || 'Someone'} assigned you "${todo.title}"`,
                    metadata: { taskId: todo.id, taskTitle: todo.title, workspaceId: null },
                },
                tx
            );
        }

        if (assigned.length > 0) {
            await tx.todoAssignee.createMany({ data: todoAssigneeRows(todo.id, assigned, now), skipDuplicates: true });
            await tx.todo.update({ where: { id: todo.id }, data: { assignedAt: now, visibility: 'shared', updatedAt: now } });
        }

        return ghostEmails;
    });

    return { todo: await loadTodoOrThrow(todoId), ghostEmails };
}

/**
 * POST /todos/:id/unassign { email? }: the owner removes one assignee (by email) or all of them.
 * With none left, assignedAt is cleared and the task goes back to 'private'.
 */
export async function unassignPersonalTodo(userId: string, todoId: string, email: unknown, now: Date = new Date()): Promise<TodoWithRelations> {
    await prisma.$transaction(async (tx) => {
        // Personal tasks only, as assign: a workspace task's assignees are the workspace's to change
        // (before 2026-11-15 this route could unassign them and turn the task private, out of its workspace).
        const todo = await tx.todo.findFirst({ where: { id: todoId, userId, visibility: { in: [...PERSONAL_VISIBILITIES] } }, select: { id: true } });
        if (!todo) throw new ErrorResponse(404, TASK_NOT_OWNED);

        if (email) {
            const target = await findUserByEmail(String(email).toLowerCase().trim(), tx);
            if (target) {
                await tx.todoAssignee.deleteMany({ where: { todoId: todo.id, userId: target.id } });
            }
        } else {
            await tx.todoAssignee.deleteMany({ where: { todoId: todo.id } });
        }

        const remaining = await tx.todoAssignee.count({ where: { todoId: todo.id } });
        await tx.todo.update({
            where: { id: todo.id },
            data: remaining === 0 ? { assignedAt: null, visibility: 'private', updatedAt: now } : { updatedAt: now },
        });
    });

    return loadTodoOrThrow(todoId);
}

