// Assigning workspace tasks by email (/api/workspace-todos/:id/assign | unassign).
//
// Same rules as the Mongo controller:
//   - only tasks with visibility 'workspace'; owner/admins/members of the task's workspace may
//     (un)assign, viewers and outsiders get 'Viewers cannot modify task assignments';
//   - unknown emails get a placeholder ("ghost") user (findOrCreatePlaceholderUser);
//   - the actor and existing assignees are skipped;
//   - per new assignee: a 'task_assigned' activity entry, a 'workspace_invite' notification when they
//     are not a member yet (unless one is pending), a 'task_assigned' notification and an email
//     (the sign-up variant for a new ghost).
// Now: the users, assignee rows and activity are written in one transaction; the notifications and
// emails follow after it commits.
import { prisma } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { sendWorkspaceTaskAssignmentEmail } from '../../controllers/workspace/workspaceEmails';
import { todoAssigneeRows, todoInclude, type TodoWithRelations } from '../todos/todoShape';
import { findOrCreatePlaceholderUser, findUserByEmail } from '../users/users.service';
import { logActivities } from './workspaceActivity';
import {
    createTaskAssignedNotification,
    createWorkspaceInviteNotification,
    findPendingWorkspaceInvite,
} from './workspaceNotifications';
import { canEditTasks, findWorkspaceAccess, isMember, type WorkspaceAccess } from './workspacePermissions';
import type { TaskActor } from './workspaceTodos.service';

const VIEWERS_CANNOT_ASSIGN = 'Viewers cannot modify task assignments';

interface AssignableTask {
    id: string;
    userId: string;
    title: string;
    description: string | null;
    priority: string;
    workspaceId: string | null;
}

/**
 * The task (visibility 'workspace') and the caller's access to its workspace, or the old 404/403.
 * A task without a workspace can only be (un)assigned by its creator (the Mongo code did no check).
 */
async function loadAssignableTask(
    todoId: string,
    actorId: string,
    notFoundMessage: string
): Promise<{ todo: AssignableTask; access: WorkspaceAccess | null }> {
    const todo = await prisma.todo.findFirst({
        where: { id: todoId, visibility: 'workspace' },
        select: { id: true, userId: true, title: true, description: true, priority: true, workspaceId: true },
    });
    if (!todo) throw new ErrorResponse(404, notFoundMessage);

    if (!todo.workspaceId) {
        if (todo.userId !== actorId) throw new ErrorResponse(403, VIEWERS_CANNOT_ASSIGN);
        return { todo, access: null };
    }
    const access = await findWorkspaceAccess(todo.workspaceId, actorId);
    if (access && !canEditTasks(access.role)) {
        throw new ErrorResponse(403, VIEWERS_CANNOT_ASSIGN);
    }
    return { todo, access };
}

async function loadTodoWithRelations(todoId: string): Promise<TodoWithRelations> {
    const todo = await prisma.todo.findUnique({ where: { id: todoId }, include: todoInclude });
    if (!todo) throw new ErrorResponse(404, 'Task not found');
    return todo;
}

export interface AssignResult {
    todo: TodoWithRelations;
    /** Emails that got a new placeholder account (the response message lists them). */
    ghostEmails: string[];
}

/** POST /api/workspace-todos/:id/assign { emails: string[] } */
export async function assignWorkspaceTask(actor: TaskActor, todoId: string, emails: unknown, now: Date = new Date()): Promise<AssignResult> {
    if (!emails || !Array.isArray(emails)) {
        throw new ErrorResponse(400, 'Emails array is required');
    }
    const normalizedEmails = [
        ...new Set(emails.filter((e): e is string => typeof e === 'string').map((e) => e.toLowerCase().trim()).filter(Boolean)),
    ];
    if (normalizedEmails.length === 0) {
        throw new ErrorResponse(400, 'At least one valid email is required');
    }

    const { todo, access } = await loadAssignableTask(todoId, actor.id, 'Task not found or you do not own it');
    const workspace = access?.workspace ?? null;

    const assigned = await prisma.$transaction(async (tx) => {
        const current = await tx.todoAssignee.findMany({ where: { todoId: todo.id }, select: { userId: true } });
        const assignees = new Set(current.map((a) => a.userId));
        const added: Array<{ id: string; name: string; email: string; isNewGhost: boolean }> = [];

        for (const email of normalizedEmails) {
            const { user: target, created } = await findOrCreatePlaceholderUser(email, tx);
            if (created) console.log(`[assign] Created ghost user: ${email} (${target.id})`);
            // No self-assignment, no duplicates.
            if (target.id === actor.id || assignees.has(target.id)) continue;
            assignees.add(target.id);
            added.push({ id: target.id, name: target.name, email: target.email, isNewGhost: created });
        }

        if (added.length > 0) {
            await tx.todoAssignee.createMany({
                data: todoAssigneeRows(todo.id, added.map((u) => u.id), now),
                skipDuplicates: true,
            });
            await tx.todo.update({
                where: { id: todo.id },
                data: { assignedAt: now, visibility: 'workspace', updatedAt: now },
                select: { id: true },
            });
            if (workspace) {
                await logActivities(
                    added.map((u) => ({
                        workspaceId: workspace.id,
                        actorId: actor.id,
                        action: 'task_assigned' as const,
                        targetTaskId: todo.id,
                        targetUserId: u.id,
                        metadata: todo.title,
                    })),
                    tx
                );
            }
        }
        return added;
    });

    // After the commit: invites for non-members, the 'task_assigned' notification, the email.
    for (const target of assigned) {
        try {
            if (workspace) {
                const role = (await findWorkspaceAccess(workspace.id, target.id))?.role ?? null;
                if (!isMember(role) && !(await findPendingWorkspaceInvite(target.id, workspace.id))) {
                    await createWorkspaceInviteNotification({
                        recipientId: target.id,
                        senderId: actor.id,
                        senderName: actor.name,
                        workspaceId: workspace.id,
                        workspaceName: workspace.name,
                    });
                }
            }
            await createTaskAssignedNotification({
                recipientId: target.id,
                senderId: actor.id,
                senderName: actor.name,
                taskId: todo.id,
                taskTitle: todo.title,
                workspaceId: todo.workspaceId,
            });
        } catch (err) {
            console.error('[assign] Notification failed:', err);
        }
        sendWorkspaceTaskAssignmentEmail(
            { name: target.name, email: target.email },
            { name: actor.name || 'Someone', email: actor.email || '' },
            todo,
            workspace?.name || 'Workspace',
            target.isNewGhost
        ).catch((err) => console.error('[assign] Email send failed:', err));
    }

    return {
        todo: await loadTodoWithRelations(todo.id),
        ghostEmails: assigned.filter((u) => u.isNewGhost).map((u) => u.email),
    };
}

/**
 * POST /api/workspace-todos/:id/unassign { email? }: remove one assignee (by email) or, without an
 * email, all of them. With none left, assignedAt is cleared (the task stays a workspace task).
 */
export async function unassignWorkspaceTask(actor: TaskActor, todoId: string, email: unknown, now: Date = new Date()): Promise<TodoWithRelations> {
    const { todo } = await loadAssignableTask(todoId, actor.id, 'Task not found');

    await prisma.$transaction(async (tx) => {
        let removed = 0;
        if (email) {
            const target = await findUserByEmail(String(email).toLowerCase().trim(), tx);
            if (target) {
                removed = (await tx.todoAssignee.deleteMany({ where: { todoId: todo.id, userId: target.id } })).count;
            }
        } else {
            removed = (await tx.todoAssignee.deleteMany({ where: { todoId: todo.id } })).count;
        }

        const remaining = await tx.todoAssignee.count({ where: { todoId: todo.id } });
        if (removed > 0) {
            await tx.todo.updateMany({
                where: { id: todo.id },
                data: remaining === 0 ? { assignedAt: null, updatedAt: now } : { updatedAt: now },
            });
        } else if (remaining === 0) {
            // Nothing removed: only clear a leftover assignedAt (Mongoose skipped no-op saves).
            await tx.todo.updateMany({ where: { id: todo.id, NOT: { assignedAt: null } }, data: { assignedAt: null, updatedAt: now } });
        }
    });

    return loadTodoWithRelations(todo.id);
}
