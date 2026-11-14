// Workspaces: CRUD, members and roles, spaces, settings, and the workspace-scoped reads
// (tasks, stats, activity). All Prisma access for these endpoints is here; the controller only
// validates input and shapes the response.
//
// Redone by hand from the Mongoose model:
//   - trim + maxlength (name 100, space name 50) with the old ValidationError messages
//   - `timestamps`: Workspace.updatedAt moved on every save that changed members/spaces/settings
//     (the list is sorted by it), so those writes touch it explicitly (Prisma only bumps
//     @updatedAt when a scalar column of the row itself changes).
// Owner + member checks come from ./workspacePermissions.ts (written once, used everywhere).
import type { Prisma, WorkspaceRole } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import {
    normalizeWorkspaceSettings,
    workspaceInclude,
    type WorkspaceWithRelations,
} from '../../db/serializers/workspace';
import ErrorResponse from '../../utils/errorResponse';
import { batchDeleteFromCloud } from '../../utils/cloudinary';
import { sendWorkspaceInviteEmail } from '../../controllers/workspace/workspaceEmails';
import { todoInclude, type TodoWithRelations } from '../todos/todoShape';
import { findOrCreatePlaceholderUser } from '../users/users.service';
import { listWorkspaceActivity, logActivity } from './workspaceActivity';
import { createWorkspaceInviteNotification, findPendingWorkspaceInvite } from './workspaceNotifications';
import {
    ANY_WORKSPACE_ROLE,
    WORKSPACE_ADMIN_ROLES,
    WORKSPACE_OWNER_ROLE,
    canManageMembers,
    canViewOverview,
    getWorkspaceRoleFromMembers,
    isMember,
    requireWorkspaceAccess,
    requireWorkspaceRole,
} from './workspacePermissions';

export const WORKSPACE_NAME_MAX_LENGTH = 100;
export const SPACE_NAME_MAX_LENGTH = 50;
export const DEFAULT_SPACE_NAME = 'Team 1';

/** The message Mongoose's maxlength validator produced (the error handler answered 400 with it). */
function maxLengthMessage(value: string, max: number): string {
    return `Path \`name\` (\`${value}\`) is longer than the maximum allowed length (${max}).`;
}

/** Trim + maxlength 100, as the Mongoose schema. "Required" is checked by the handler first. */
export function normalizeWorkspaceName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length > WORKSPACE_NAME_MAX_LENGTH) {
        throw new ErrorResponse(400, maxLengthMessage(trimmed, WORKSPACE_NAME_MAX_LENGTH));
    }
    return trimmed;
}

/** Trim + maxlength 50 (Workspace.spaces[].name). */
export function normalizeSpaceName(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length > SPACE_NAME_MAX_LENGTH) {
        throw new ErrorResponse(400, maxLengthMessage(trimmed, SPACE_NAME_MAX_LENGTH));
    }
    return trimmed;
}

// ─── Reads ─────────────────────────────────────────────────────────────

/** A workspace with owner, members (+ users) and spaces, ready for serializeWorkspace(). */
export function findWorkspaceWithRelations(workspaceId: string, db: DbClient = prisma): Promise<WorkspaceWithRelations | null> {
    return db.workspace.findUnique({ where: { id: workspaceId }, include: workspaceInclude });
}

async function findWorkspaceWithRelationsOrThrow(workspaceId: string, db: DbClient): Promise<WorkspaceWithRelations> {
    const workspace = await findWorkspaceWithRelations(workspaceId, db);
    if (!workspace) throw new ErrorResponse(404, 'Workspace not found');
    return workspace;
}

/** GET /api/workspaces: every workspace the user owns or is a member of, most recently updated first. */
export function listWorkspacesForUser(userId: string, db: DbClient = prisma): Promise<WorkspaceWithRelations[]> {
    return db.workspace.findMany({
        where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
        include: workspaceInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
}

/** GET /api/workspaces/:id: 404 if missing, 403 unless the user is the owner or a member. */
export async function getWorkspaceForMember(workspaceId: string, userId: string, db: DbClient = prisma): Promise<WorkspaceWithRelations> {
    const workspace = await findWorkspaceWithRelationsOrThrow(workspaceId, db);
    if (!isMember(getWorkspaceRoleFromMembers(workspace.ownerId, workspace.members, userId))) {
        throw new ErrorResponse(403, 'You are not a member of this workspace');
    }
    return workspace;
}

// ─── Create / delete ───────────────────────────────────────────────────

/**
 * POST /api/workspaces. The creator becomes the owner AND an 'admin' member (as before), with one
 * initial space (default "Team 1"), and a 'workspace_created' activity entry.
 */
export async function createWorkspace(
    ownerId: string,
    input: { name: string; defaultSpaceName?: unknown }
): Promise<WorkspaceWithRelations> {
    const name = normalizeWorkspaceName(input.name);
    const requestedSpace = typeof input.defaultSpaceName === 'string' ? input.defaultSpaceName.trim() : '';
    const spaceName = normalizeSpaceName(requestedSpace || DEFAULT_SPACE_NAME);

    const workspaceId = await prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
            data: {
                name,
                ownerId,
                members: { create: { userId: ownerId, role: 'admin', joinedAt: new Date() } },
                spaces: { create: { name: spaceName } },
            },
            select: { id: true },
        });
        await logActivity({ workspaceId: workspace.id, actorId: ownerId, action: 'workspace_created', metadata: name }, tx);
        return workspace.id;
    });
    return findWorkspaceWithRelationsOrThrow(workspaceId, prisma);
}

/** Public ids of the Cloudinary images in todo `cloudImages` Json arrays. */
export function cloudPublicIdsOf(rows: ReadonlyArray<{ cloudImages: Prisma.JsonValue }>): string[] {
    const ids: string[] = [];
    for (const row of rows) {
        if (!Array.isArray(row.cloudImages)) continue;
        for (const image of row.cloudImages) {
            const publicId = image && typeof image === 'object' && !Array.isArray(image) ? image.cloudPublicId : undefined;
            if (typeof publicId === 'string' && publicId) ids.push(publicId);
        }
    }
    return ids;
}

/**
 * DELETE /api/workspaces/:id (owner only). Postgres cascades members, spaces, invite links,
 * activity AND the workspace's todos (with their reminders); Mongo left the todos orphaned.
 * Since the todos are gone now, their Cloudinary images are deleted too (after the commit).
 */
export async function deleteWorkspace(workspaceId: string, userId: string): Promise<void> {
    const access = await requireWorkspaceAccess(workspaceId, userId);
    requireWorkspaceRole(access, WORKSPACE_OWNER_ROLE, 'Only the workspace owner can delete it');

    const publicIds = await prisma.$transaction(async (tx) => {
        const todos = await tx.todo.findMany({ where: { workspaceId }, select: { cloudImages: true } });
        await tx.activityLog.deleteMany({ where: { workspaceId } });
        const { count } = await tx.workspace.deleteMany({ where: { id: workspaceId } });
        if (count === 0) throw new ErrorResponse(404, 'Workspace not found');
        return cloudPublicIdsOf(todos);
    });

    if (publicIds.length > 0) {
        batchDeleteFromCloud(publicIds).catch((err) => console.error('[workspace] Cloud cleanup failed:', err));
    }
}

// ─── Members ───────────────────────────────────────────────────────────

/** Workspace.updatedAt, which Mongoose's `timestamps` moved on every changed save. */
function touchWorkspace(workspaceId: string, db: DbClient) {
    return db.workspace.update({ where: { id: workspaceId }, data: { updatedAt: new Date() }, select: { id: true } });
}

export interface InviterInfo {
    id: string;
    name: string | null | undefined;
    email: string | null | undefined;
}

/**
 * POST /api/workspaces/:id/members (owner/admin). Does NOT add the user: it sends an actionable
 * 'workspace_invite' notification (accepting it adds the member) and an invite email. Unknown
 * emails get a placeholder ("ghost") account first. Returns the old success message.
 */
export async function inviteMemberByEmail(workspaceId: string, inviter: InviterInfo, email: string): Promise<{ message: string }> {
    const normalizedEmail = email.toLowerCase().trim();

    const access = await requireWorkspaceAccess(workspaceId, inviter.id);
    requireWorkspaceRole(access, WORKSPACE_ADMIN_ROLES, 'Only admins can invite members');
    if (!normalizedEmail) {
        throw new ErrorResponse(400, 'Email is required');
    }

    const { user: target, created } = await findOrCreatePlaceholderUser(normalizedEmail);

    if (target.id === inviter.id) {
        throw new ErrorResponse(400, 'You are already in this workspace');
    }
    const membership = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: target.id } },
        select: { userId: true },
    });
    if (membership) {
        throw new ErrorResponse(400, 'User is already a member of this workspace');
    }
    if (await findPendingWorkspaceInvite(target.id, workspaceId)) {
        throw new ErrorResponse(400, 'An invite is already pending for this user');
    }

    await createWorkspaceInviteNotification({
        recipientId: target.id,
        senderId: inviter.id,
        senderName: inviter.name,
        workspaceId,
        workspaceName: access.workspace.name,
    });

    // Fire and forget, after the write (as before).
    sendWorkspaceInviteEmail(
        { name: target.name, email: target.email },
        { name: inviter.name || 'Someone', email: inviter.email || '' },
        access.workspace.name,
        created
    ).catch((err) => console.error('[workspace] Invite email failed:', err));

    return { message: created ? `Invitation sent to ${normalizedEmail}` : `Invite sent to ${target.name}` };
}

/**
 * DELETE /api/workspaces/:id/members/:userId. Owner/admins can remove anyone but the owner;
 * a member can remove themselves (leave). Logs 'member_removed' when a member was removed.
 * Returns the updated workspace.
 */
export async function removeWorkspaceMember(
    workspaceId: string,
    actorId: string,
    targetUserId: string
): Promise<WorkspaceWithRelations> {
    const access = await requireWorkspaceAccess(workspaceId, actorId);
    const leavingThemselves = targetUserId === actorId && isMember(access.role);
    if (!canManageMembers(access.role) && !leavingThemselves) {
        throw new ErrorResponse(403, 'Only admins can remove members');
    }
    if (access.workspace.ownerId === targetUserId) {
        throw new ErrorResponse(400, 'Cannot remove the workspace owner');
    }

    await prisma.$transaction(async (tx) => {
        const { count } = await tx.workspaceMember.deleteMany({ where: { workspaceId, userId: targetUserId } });
        if (count > 0) {
            await touchWorkspace(workspaceId, tx);
            await logActivity({ workspaceId, actorId, action: 'member_removed', targetUserId }, tx);
        }
    });
    // Read after the commit: Prisma loads several relations concurrently, which a transaction's
    // single connection should not be asked to do.
    return findWorkspaceWithRelationsOrThrow(workspaceId, prisma);
}

/**
 * PATCH /api/workspaces/:id/members/:userId/role (owner/admin). The owner's role cannot change.
 * `role` must already be validated (admin | member | viewer).
 */
export async function updateWorkspaceMemberRole(
    workspaceId: string,
    actorId: string,
    targetUserId: string,
    role: WorkspaceRole
): Promise<WorkspaceWithRelations> {
    const access = await requireWorkspaceAccess(workspaceId, actorId);
    requireWorkspaceRole(access, WORKSPACE_ADMIN_ROLES, 'Only admins can update roles');
    if (access.workspace.ownerId === targetUserId) {
        throw new ErrorResponse(400, 'Cannot change the role of the workspace owner');
    }

    await prisma.$transaction(async (tx) => {
        const where = { workspaceId_userId: { workspaceId, userId: targetUserId } };
        const member = await tx.workspaceMember.findUnique({ where, select: { role: true } });
        if (!member) {
            throw new ErrorResponse(400, 'User is not a member of this workspace');
        }
        if (member.role !== role) {
            await tx.workspaceMember.update({ where, data: { role } });
            await touchWorkspace(workspaceId, tx);
        }
    });
    return findWorkspaceWithRelationsOrThrow(workspaceId, prisma);
}

// ─── Spaces & settings ─────────────────────────────────────────────────

/** POST /api/workspaces/:id/spaces: any member (viewers included, as before) can add a space. */
export async function createSpace(workspaceId: string, userId: string, rawName: string): Promise<WorkspaceWithRelations> {
    const access = await requireWorkspaceAccess(workspaceId, userId);
    requireWorkspaceRole(access, ANY_WORKSPACE_ROLE, 'Not a member of this workspace');
    const name = normalizeSpaceName(rawName);

    await prisma.workspace.update({
        where: { id: workspaceId },
        data: { updatedAt: new Date(), spaces: { create: { name } } },
        select: { id: true },
    });
    return findWorkspaceWithRelationsOrThrow(workspaceId, prisma);
}

/**
 * PATCH /api/workspaces/:id/settings (owner/admin). Only a boolean `membersCanViewOverview` is
 * applied; anything else leaves the settings unchanged (and still answers 200).
 */
export async function updateWorkspaceSettings(
    workspaceId: string,
    userId: string,
    input: { membersCanViewOverview?: unknown }
): Promise<WorkspaceWithRelations> {
    const access = await requireWorkspaceAccess(workspaceId, userId);
    requireWorkspaceRole(access, WORKSPACE_ADMIN_ROLES, 'Only admins can update workspace settings');

    const current = normalizeWorkspaceSettings(access.workspace.settings);
    const value = input.membersCanViewOverview;
    if (typeof value === 'boolean' && value !== current.membersCanViewOverview) {
        await prisma.workspace.update({
            where: { id: workspaceId },
            data: { settings: { ...current, membersCanViewOverview: value } as Prisma.InputJsonObject },
            select: { id: true },
        });
    }
    return findWorkspaceWithRelationsOrThrow(workspaceId, prisma);
}

// ─── Workspace-scoped data ─────────────────────────────────────────────

function workspaceTaskWhere(workspaceId: string, spaceId: string | undefined): Prisma.TodoWhereInput {
    return { workspaceId, visibility: 'workspace', ...(spaceId ? { spaceId } : {}) };
}

/** GET /api/workspaces/:id/tasks (any member): the workspace's tasks, newest first. */
export async function listWorkspaceTasks(
    workspaceId: string,
    userId: string,
    spaceId?: string
): Promise<TodoWithRelations[]> {
    const access = await requireWorkspaceAccess(workspaceId, userId);
    requireWorkspaceRole(access, ANY_WORKSPACE_ROLE, 'Not a member');
    return prisma.todo.findMany({
        where: workspaceTaskWhere(workspaceId, spaceId),
        include: todoInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
}

export interface WorkspaceStats {
    totalMembers: number;
    totalTasks: number;
    pending: number;
    inProgress: number;
    completed: number;
    overdue: number;
}

/**
 * GET /api/workspaces/:id/stats: owners/admins always; members and viewers only when
 * settings.membersCanViewOverview is true.
 */
export async function getWorkspaceStats(workspaceId: string, userId: string, spaceId?: string): Promise<WorkspaceStats> {
    const access = await requireWorkspaceAccess(workspaceId, userId);
    requireWorkspaceRole(access, ANY_WORKSPACE_ROLE, 'Not a member');
    if (!canViewOverview(access.role, access.workspace.settings)) {
        throw new ErrorResponse(403, 'You do not have permission to view the workspace overview.');
    }

    const where = workspaceTaskWhere(workspaceId, spaceId);
    const [byStatus, overdue, totalMembers] = await Promise.all([
        prisma.todo.groupBy({ by: ['status'], where, _count: { _all: true } }),
        prisma.todo.count({ where: { ...where, status: { not: 'complete' }, dueDate: { lt: new Date() } } }),
        prisma.workspaceMember.count({ where: { workspaceId } }),
    ]);
    const countOf = (status: string) => byStatus.find((g) => g.status === status)?._count._all ?? 0;

    return {
        totalMembers,
        totalTasks: byStatus.reduce((sum, g) => sum + g._count._all, 0),
        pending: countOf('pending'),
        inProgress: countOf('in_progress'),
        completed: countOf('complete'),
        overdue,
    };
}

/** GET /api/workspaces/:id/activity (any member): the last 30 entries. */
export async function getWorkspaceActivity(workspaceId: string, userId: string) {
    const access = await requireWorkspaceAccess(workspaceId, userId);
    requireWorkspaceRole(access, ANY_WORKSPACE_ROLE, 'Not a member');
    return listWorkspaceActivity(workspaceId);
}
