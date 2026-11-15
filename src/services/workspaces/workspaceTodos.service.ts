// Workspace tasks (/api/workspace-todos): create, update, delete and the per-task activity feed.
// Assigning by email is in ./workspaceAssign.service.ts.
//
// Shared with personal todos (src/services/todos, src/services/tags, src/services/reminders): the
// body parsing + Mongoose validation messages (todoInput), the JSON shape (todoShape), tag
// resolution and reminder rows.
//
// Behaviour kept from the Mongo controller:
//   - who may edit: workspace owner/admins/members by their role now, the creator included (a
//     demoted creator no longer edits; fixed 11-15; viewers get their own 403 message);
//     non-workspace tasks: creator or assignee. Delete: owner/admin/member for
//     workspace tasks, the creator otherwise.
//   - create defaults: status 'pending', priority 'medium'; visibility is always 'workspace'.
//   - update: only title, description, status, priority, dueDate, reminderDate, subtasks, tags,
//     assignees, recurrence, references, spaceId (+ uploaded images); an empty tags list clears the
//     tags (absent = unchanged); completedAt set on → complete, cleared when it leaves complete; the reminder is
//     replaced only when the date really changed.
//   - activity entries (task_created / completed / status / priority / content / due date /
//     assigned / unassigned) with the old metadata strings, and 'task_assigned' notifications +
//     emails for new assignees.
// Now: activity rows are written in the same transaction as the change; notifications are inserted
// and emails sent after it commits (they used to be fire-and-forget after the commit).
import { Prisma } from '@prisma/client';
import type { ActivityAction } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { batchDeleteFromCloud } from '../../utils/cloudinary';
import { sendWorkspaceTaskAssignmentEmail } from '../../controllers/workspace/workspaceEmails';
import { normalizeTagNames, resolveTagIds } from '../tags/tags.service';
import { createTodoReminder, deleteTodoReminders } from '../reminders/reminders.service';
import { todoAssigneeRows, todoInclude, todoTagRows, type TodoWithRelations } from '../todos/todoShape';
import {
    castCreateDate,
    normalizeRecurrence,
    normalizeReferences,
    normalizeSubtasks,
    normalizeTitle,
    parseAssigneeIds,
    parseStringList,
    parseTodoPriority,
    parseTodoStatus,
    parseUpdateDate,
    resolveUploadedImages,
    type TodoCloudImageJson,
} from '../todos/todoInput';
import { listTaskActivity, logActivities, type ActivityInput } from './workspaceActivity';
import { createTaskAssignedNotification } from './workspaceNotifications';
import { canEditTasks, findWorkspaceAccess, isMember, requireWorkspaceAccess, workspaceTaskAccess } from './workspacePermissions';
import { cloudPublicIdsOf } from './workspaces.service';

export const TASK_NOT_FOUND = 'Task not found';

type Body = Record<string, unknown>;

/** The signed-in user, as the handlers need it (name/email for notifications and emails). */
export interface TaskActor {
    id: string;
    name: string | null | undefined;
    email: string | null | undefined;
}

/** For scheduleTodoReminder() once the transaction has committed. */
export interface ScheduledReminder {
    reminderId: string;
    remindAt: Date;
}

export interface WorkspaceTodoWriteResult {
    todo: TodoWithRelations;
    reminder: ScheduledReminder | null;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function bodyText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    return String(value);
}

/** Keep the ids that are real users, in order (Mongo stored any id; populate dropped unknown ones). */
async function existingUserIds(ids: readonly string[], db: DbClient): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await db.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
    const found = new Set(rows.map((r) => r.id));
    return ids.filter((id) => found.has(id));
}

/** A spaceId from the body: falsy (or 'null') → null; otherwise it must be a space of this workspace. */
async function resolveSpaceId(value: unknown, workspaceId: string | null, db: DbClient): Promise<string | null> {
    if (!value || value === 'null') return null;
    const space =
        typeof value === 'string' && workspaceId
            ? await db.space.findFirst({ where: { id: value, workspaceId }, select: { id: true } })
            : null;
    if (!space) {
        throw new ErrorResponse(404, 'Space not found in this workspace');
    }
    return space.id;
}

/** Mongo `$push: { cloudImages: { $each } }`, as one atomic jsonb append. */
async function appendCloudImages(todoId: string, images: readonly TodoCloudImageJson[], db: DbClient): Promise<void> {
    if (images.length === 0) return;
    await db.$executeRaw`UPDATE "Todo" SET "cloudImages" = COALESCE("cloudImages", '[]'::jsonb) || ${JSON.stringify(images)}::jsonb WHERE "id" = ${todoId}`;
}

/** The todo for the response, read after the commit (relations load concurrently: not inside a transaction). */
async function loadTodo(todoId: string): Promise<TodoWithRelations> {
    const todo = await prisma.todo.findUnique({ where: { id: todoId }, include: todoInclude });
    if (!todo) throw new ErrorResponse(404, TASK_NOT_FOUND);
    return todo;
}

function isWorkspaceTask(todo: { visibility: string; workspaceId: string | null }): todo is { visibility: string; workspaceId: string } {
    return todo.visibility === 'workspace' && todo.workspaceId !== null;
}

/** The caller's role in the task's workspace (null: not a member, or the workspace is gone). */
async function roleInWorkspace(workspaceId: string, userId: string, db: DbClient) {
    return (await findWorkspaceAccess(workspaceId, userId, db))?.role ?? null;
}

export interface NewAssignee {
    id: string;
    name: string;
    email: string;
}

/** What the assignment email shows about the task. */
export interface EmailTask {
    title: string;
    description: string | null;
    priority: string;
}

/**
 * After the commit: one 'task_assigned' notification + one assignment email per new assignee (the
 * actor excluded). Failures are logged, never thrown: the task change has already been saved.
 * `notificationTitle` is the title the notification names (on update: the title before the update,
 * as before); the email shows `emailTask`.
 */
async function notifyNewAssignees(input: {
    actor: TaskActor;
    assignees: readonly NewAssignee[];
    taskId: string;
    notificationTitle: string;
    emailTask: EmailTask;
    workspaceId: string;
    workspaceName: string;
}): Promise<void> {
    for (const assignee of input.assignees) {
        try {
            await createTaskAssignedNotification({
                recipientId: assignee.id,
                senderId: input.actor.id,
                senderName: input.actor.name,
                taskId: input.taskId,
                taskTitle: input.notificationTitle,
                workspaceId: input.workspaceId,
            });
        } catch (err) {
            console.error('[workspace-todo] task_assigned notification failed:', err);
        }
        sendWorkspaceTaskAssignmentEmail(
            { name: assignee.name, email: assignee.email },
            { name: input.actor.name || 'Someone', email: input.actor.email || '' },
            input.emailTask,
            input.workspaceName || 'Workspace',
            false
        ).catch((err) => console.error('[assign] Email failed:', err));
    }
}

/** Users by id, in the order of `ids` (unknown ids dropped). */
async function usersInOrder(ids: readonly string[], db: DbClient): Promise<NewAssignee[]> {
    if (ids.length === 0) return [];
    const rows = await db.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, email: true } });
    const byId = new Map(rows.map((u) => [u.id, u]));
    return ids.map((id) => byId.get(id)).filter((u): u is NewAssignee => u !== undefined);
}

// ─── Create ────────────────────────────────────────────────────────────

/**
 * POST /api/workspace-todos (JSON, or multipart when the description has images). Owner, admins
 * and members of `body.workspace` can create; viewers and outsiders get 403.
 */
export async function createWorkspaceTodo(actor: TaskActor, body: Body, files: unknown, now: Date = new Date()): Promise<WorkspaceTodoWriteResult> {
    if (typeof body.title !== 'string' || !body.title.trim()) {
        throw new ErrorResponse(400, 'Task title is required');
    }
    if (!body.workspace) {
        throw new ErrorResponse(400, 'Workspace ID is required for a workspace task');
    }
    const access = await requireWorkspaceAccess(typeof body.workspace === 'string' ? body.workspace : '', actor.id);
    if (!canEditTasks(access.role)) {
        throw new ErrorResponse(403, 'Viewers cannot create tasks in this workspace');
    }
    const workspaceId = access.workspace.id;

    // Mongoose validation (after the permission check, as before).
    const title = normalizeTitle(body.title);
    const status = parseTodoStatus(body.status || 'pending');
    const priority = parseTodoPriority(body.priority || 'medium');
    const subtasks = normalizeSubtasks(body.subtasks);
    const references = normalizeReferences(body.references);
    const recurrence = normalizeRecurrence(body.recurrence);
    const tagNames = normalizeTagNames(parseStringList(body.tags));
    const requestedAssignees = parseAssigneeIds(body.assignees) ?? [];
    const dueDate = castCreateDate(body.dueDate, 'dueDate');
    const reminderDate = castCreateDate(body.reminderDate, 'reminderDate');
    const spaceId = await resolveSpaceId(body.spaceId, workspaceId, prisma);

    const rawDescription = body.description ? bodyText(body.description) : '';
    const { description, cloudImages } = resolveUploadedImages(rawDescription, body.imageNodeIds, files);

    const created = await prisma.$transaction(async (tx) => {
        const tagIds = await resolveTagIds(tagNames, tx);
        const assigneeIds = await existingUserIds(requestedAssignees, tx);

        const todo = await tx.todo.create({
            data: {
                userId: actor.id,
                title,
                description: description || null,
                status,
                priority,
                dueDate,
                reminderDate,
                // Todo pre('save') hook: creating it complete stamps completedAt.
                completedAt: status === 'complete' ? now : null,
                subtasks,
                cloudImages,
                recurrence: recurrence ?? Prisma.DbNull,
                assignedAt: assigneeIds.length > 0 ? now : null,
                references,
                workspaceId,
                spaceId,
                visibility: 'workspace',
                createdAt: now,
            },
            select: { id: true },
        });
        if (tagIds.length > 0) await tx.todoTag.createMany({ data: todoTagRows(todo.id, tagIds, now) });
        if (assigneeIds.length > 0) await tx.todoAssignee.createMany({ data: todoAssigneeRows(todo.id, assigneeIds, now) });

        let reminder: ScheduledReminder | null = null;
        if (reminderDate) {
            const row = await createTodoReminder({ userId: actor.id, todoId: todo.id, reminderDate, title }, tx);
            reminder = { reminderId: row.id, remindAt: reminderDate };
        }

        // The creator is never notified about assigning themselves (and no activity for it, as before).
        const others = assigneeIds.filter((id) => id !== actor.id);
        await logActivities(
            [
                { workspaceId, actorId: actor.id, action: 'task_created', targetTaskId: todo.id, metadata: title },
                ...others.map((targetUserId) => ({
                    workspaceId,
                    actorId: actor.id,
                    action: 'task_assigned' as const,
                    targetTaskId: todo.id,
                    targetUserId,
                    metadata: title,
                })),
            ],
            tx
        );
        return { id: todo.id, reminder, newAssignees: await usersInOrder(others, tx) };
    });

    await notifyNewAssignees({
        actor,
        assignees: created.newAssignees,
        taskId: created.id,
        notificationTitle: title,
        emailTask: { title, description: description || null, priority },
        workspaceId,
        workspaceName: access.workspace.name,
    });

    return { todo: await loadTodo(created.id), reminder: created.reminder };
}

// ─── Update ────────────────────────────────────────────────────────────

const NO_UPDATE_PERMISSION = "You don't have permission to update this workspace task";

/**
 * PATCH /api/workspace-todos/:id. A workspace task: its owner/admins/members, by their role now
 * (viewers: 'Viewers cannot edit tasks in this workspace'; a demoted or removed creator too). A
 * non-workspace task: its creator or an assignee. Any task id is accepted here, as before.
 */
export async function updateWorkspaceTodo(
    actor: TaskActor,
    todoId: string,
    body: Body,
    files: unknown,
    now: Date = new Date()
): Promise<WorkspaceTodoWriteResult> {
    const outcome = await prisma.$transaction(async (tx) => {
        const existing = await tx.todo.findUnique({
            where: { id: todoId },
            select: {
                id: true,
                userId: true,
                title: true,
                description: true,
                status: true,
                priority: true,
                dueDate: true,
                reminderDate: true,
                visibility: true,
                workspaceId: true,
                assignees: { select: { userId: true }, orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }] },
            },
        });
        if (!existing) throw new ErrorResponse(404, TASK_NOT_FOUND);

        const existingAssignees = existing.assignees.map((a) => a.userId);
        const workspaceTask = isWorkspaceTask(existing);
        if (workspaceTask) {
            // The role decides, the creator's included: a creator made a viewer, or removed from the
            // workspace, can no longer change the task (the Mongo handler let a creator always edit).
            const access = workspaceTaskAccess(await roleInWorkspace(existing.workspaceId!, actor.id, tx));
            if (access === 'viewer') throw new ErrorResponse(403, 'Viewers cannot edit tasks in this workspace');
            if (access === 'denied') throw new ErrorResponse(403, NO_UPDATE_PERMISSION);
        } else if (existing.userId !== actor.id && !existingAssignees.includes(actor.id)) {
            throw new ErrorResponse(403, NO_UPDATE_PERMISSION);
        }

        // 1. Parse and validate everything before writing anything.
        const data: Prisma.TodoUncheckedUpdateManyInput = {};
        let newCloudImages: TodoCloudImageJson[] = [];
        let newDescription: string | null | undefined;

        if (body.description !== undefined) {
            if (typeof body.description === 'string' && body.description) {
                const resolved = resolveUploadedImages(body.description, body.imageNodeIds, files);
                newDescription = resolved.description;
                newCloudImages = resolved.cloudImages;
            } else {
                newDescription = body.description === null ? null : bodyText(body.description);
            }
            data.description = newDescription;
        }
        const newTitle = body.title !== undefined ? normalizeTitle(body.title) : undefined;
        if (newTitle !== undefined) data.title = newTitle;
        const newStatus = body.status !== undefined ? parseTodoStatus(body.status) : undefined;
        if (newStatus !== undefined) data.status = newStatus;
        const newPriority = body.priority !== undefined ? parseTodoPriority(body.priority) : undefined;
        if (newPriority !== undefined) data.priority = newPriority;
        const newDueDate = body.dueDate !== undefined ? parseUpdateDate(body.dueDate) : undefined;
        if (newDueDate !== undefined) data.dueDate = newDueDate;
        const newReminderDate = body.reminderDate !== undefined ? parseUpdateDate(body.reminderDate) : undefined;
        if (newReminderDate !== undefined) data.reminderDate = newReminderDate;
        if (body.subtasks !== undefined) data.subtasks = normalizeSubtasks(body.subtasks);
        if (body.recurrence !== undefined) data.recurrence = normalizeRecurrence(body.recurrence) ?? Prisma.DbNull;
        if (body.references !== undefined) data.references = normalizeReferences(body.references);
        if (body.spaceId !== undefined) data.spaceId = await resolveSpaceId(body.spaceId, existing.workspaceId, tx);

        // tags: a list replaces them; an empty list (or null) clears them. Absent = unchanged.
        const tagNames = body.tags !== undefined ? normalizeTagNames(parseStringList(body.tags)) : null;

        // assignees: a list (of ids or { _id } objects, or its JSON string) replaces them; anything else clears them.
        let newAssignees: string[] | null = null;
        if (body.assignees !== undefined) {
            const requested = parseAssigneeIds(body.assignees);
            newAssignees = requested ? await existingUserIds(requested, tx) : [];
            data.assignedAt = requested && requested.length > 0 ? now : null;
        }

        // completedAt: stamped when it becomes complete, cleared when it leaves complete for any state
        // (the old handler cleared it only on 'pending'; fixed 11-15, as for personal tasks).
        if (newStatus === 'complete' && existing.status !== 'complete') {
            data.completedAt = now;
        } else if (newStatus !== undefined && newStatus !== 'complete' && existing.status === 'complete') {
            data.completedAt = null;
        }

        // 2. Write.
        if (tagNames !== null) {
            const tagIds = await resolveTagIds(tagNames, tx);
            await tx.todoTag.deleteMany({ where: { todoId } });
            if (tagIds.length > 0) await tx.todoTag.createMany({ data: todoTagRows(todoId, tagIds, now) });
        }
        if (newAssignees) {
            await tx.todoAssignee.deleteMany({ where: { todoId } });
            if (newAssignees.length > 0) await tx.todoAssignee.createMany({ data: todoAssigneeRows(todoId, newAssignees, now) });
        }

        // The reminder is replaced only when the date really changed.
        let reminder: ScheduledReminder | null = null;
        if (newReminderDate !== undefined && (newReminderDate?.getTime() ?? null) !== (existing.reminderDate?.getTime() ?? null)) {
            await deleteTodoReminders(todoId, tx);
            if (newReminderDate) {
                const row = await createTodoReminder(
                    { userId: actor.id, todoId, reminderDate: newReminderDate, title: newTitle ?? existing.title },
                    tx
                );
                reminder = { reminderId: row.id, remindAt: newReminderDate };
            }
        }

        await appendCloudImages(todoId, newCloudImages, tx);
        const { count } = await tx.todo.updateMany({ where: { id: todoId }, data: { ...data, updatedAt: now } });
        if (count === 0) throw new ErrorResponse(404, TASK_NOT_FOUND);

        // 3. Activity (workspace tasks only), with the old metadata strings.
        const added: string[] = [];
        if (workspaceTask) {
            const wsId = existing.workspaceId!;
            const entry = (action: ActivityAction, extra: Partial<ActivityInput> = {}): ActivityInput => ({
                workspaceId: wsId,
                actorId: actor.id,
                action,
                targetTaskId: existing.id,
                ...extra,
            });
            const entries: ActivityInput[] = [];

            if (newStatus === 'complete' && existing.status !== 'complete') {
                entries.push(entry('task_completed', { metadata: existing.title }));
            } else if (newStatus && newStatus !== existing.status) {
                entries.push(entry('task_status_changed', { metadata: `${existing.status} → ${newStatus}` }));
            }
            if (newPriority && newPriority !== existing.priority) {
                entries.push(entry('task_priority_changed', { metadata: `${existing.priority || 'none'} → ${newPriority}` }));
            }
            const titleChanged = newTitle !== undefined && newTitle !== existing.title;
            const descriptionChanged = newDescription !== undefined && newDescription !== existing.description;
            if (titleChanged || descriptionChanged) {
                entries.push(entry('task_content_changed', { metadata: 'updated the content' }));
            }
            if (newDueDate !== undefined && (newDueDate?.getTime() ?? 0) !== (existing.dueDate?.getTime() ?? 0)) {
                const from = existing.dueDate ? existing.dueDate.toISOString() : 'none';
                const to = newDueDate ? newDueDate.toISOString() : 'none';
                entries.push(entry('task_due_date_changed', { metadata: `${from} → ${to}` }));
            }
            if (newAssignees) {
                for (const removedId of existingAssignees.filter((id) => !newAssignees!.includes(id))) {
                    entries.push(entry('task_unassigned', { targetUserId: removedId, metadata: existing.title }));
                }
                for (const addedId of newAssignees.filter((id) => !existingAssignees.includes(id))) {
                    // Assigning yourself is logged (target = you) but not notified, as before.
                    entries.push(entry('task_assigned', { targetUserId: addedId, metadata: existing.title }));
                    if (addedId !== actor.id) added.push(addedId);
                }
            }
            await logActivities(entries, tx);
        }

        return {
            existing,
            reminder,
            newAssignees: await usersInOrder(added, tx),
            // The email shows the task as updated ({ ...existing, ...updates } before).
            emailTask: {
                title: newTitle ?? existing.title,
                description: newDescription !== undefined ? newDescription : existing.description,
                priority: newPriority ?? existing.priority,
            },
        };
    });

    if (outcome.newAssignees.length > 0 && isWorkspaceTask(outcome.existing)) {
        const workspace = await prisma.workspace.findUnique({ where: { id: outcome.existing.workspaceId }, select: { name: true } });
        await notifyNewAssignees({
            actor,
            assignees: outcome.newAssignees,
            taskId: outcome.existing.id,
            // The notification names the title the task had before this update (as before).
            notificationTitle: outcome.existing.title,
            emailTask: outcome.emailTask,
            workspaceId: outcome.existing.workspaceId,
            workspaceName: workspace?.name || 'Workspace',
        });
    }

    return { todo: await loadTodo(todoId), reminder: outcome.reminder };
}

// ─── Delete ────────────────────────────────────────────────────────────

/**
 * DELETE /api/workspace-todos/:id. Workspace tasks: owner/admins/members (viewers get their own
 * 403, the creator alone is not enough); other tasks: the creator. Reminders, tag links and
 * assignees go with the task; its Cloudinary images are deleted after the commit.
 */
export async function deleteWorkspaceTodo(actor: TaskActor, todoId: string): Promise<void> {
    const publicIds = await prisma.$transaction(async (tx) => {
        const todo = await tx.todo.findUnique({
            where: { id: todoId },
            select: { id: true, userId: true, visibility: true, workspaceId: true, cloudImages: true },
        });
        if (!todo) throw new ErrorResponse(404, TASK_NOT_FOUND);

        if (isWorkspaceTask(todo)) {
            const access = workspaceTaskAccess(await roleInWorkspace(todo.workspaceId, actor.id, tx));
            if (access === 'viewer') throw new ErrorResponse(403, 'Viewers cannot delete tasks in this workspace');
            if (access === 'denied') throw new ErrorResponse(403, "You don't have permission to delete this workspace task");
        } else if (todo.userId !== actor.id) {
            throw new ErrorResponse(403, "You don't have permission to delete this workspace task");
        }

        await deleteTodoReminders(todo.id, tx);
        await tx.todo.deleteMany({ where: { id: todo.id } });
        return cloudPublicIdsOf([todo]);
    });

    if (publicIds.length > 0) {
        await batchDeleteFromCloud(publicIds);
    }
}

// ─── Activity ──────────────────────────────────────────────────────────

/**
 * GET /api/workspace-todos/:id/activity: every activity entry about the task, newest first.
 * New: the caller must be able to see the task (a member of its workspace, else 403 'Not a member';
 * for a non-workspace task its creator or an assignee, else 404). The Mongo handler had no check.
 */
export async function getTaskActivity(actor: TaskActor, todoId: string) {
    const todo = await prisma.todo.findUnique({
        where: { id: todoId },
        select: { id: true, userId: true, visibility: true, workspaceId: true, assignees: { select: { userId: true } } },
    });
    if (!todo) throw new ErrorResponse(404, TASK_NOT_FOUND);

    if (todo.workspaceId) {
        if (!isMember(await roleInWorkspace(todo.workspaceId, actor.id, prisma))) {
            throw new ErrorResponse(403, 'Not a member');
        }
    } else if (todo.userId !== actor.id && !todo.assignees.some((a) => a.userId === actor.id)) {
        throw new ErrorResponse(404, TASK_NOT_FOUND);
    }

    return listTaskActivity(todo.id);
}
