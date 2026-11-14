// Workspace permissions, written once. The Mongo controllers copy-pasted these checks into every
// handler (`workspace.owner.toString() === userId || workspace.members.some(...)`).
//
// Effective role of a user in a workspace:
//   'owner'   Workspace.ownerId. Outranks the owner's own member row (created as 'admin').
//   'admin' | 'member' | 'viewer'   the WorkspaceMember row's role.
//   null      neither the owner nor a member.
//
// What each role may do (unchanged from the Mongo version):
//   owner   everything, and the only one who can delete the workspace
//   admin   invite/remove members, change roles, settings, invite links, see the overview; edit tasks
//   member  create/edit/delete/assign tasks; see the overview only if settings.membersCanViewOverview
//   viewer  read tasks and activity; same overview rule as members. Can still create spaces (as before).
// Anyone with a role can read the workspace, its tasks and its activity, and create spaces.
import type { Prisma, WorkspaceRole } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { normalizeWorkspaceSettings } from '../../db/serializers/workspace';
import ErrorResponse from '../../utils/errorResponse';

export type WorkspaceAccessRole = 'owner' | WorkspaceRole;

/** Every role (= "is a member"). */
export const ANY_WORKSPACE_ROLE: readonly WorkspaceAccessRole[] = ['owner', 'admin', 'member', 'viewer'];
/** Roles that can create, edit, delete and assign tasks (everyone but viewers). */
export const TASK_EDITOR_ROLES: readonly WorkspaceAccessRole[] = ['owner', 'admin', 'member'];
/** Roles that manage members, roles, settings and invite links. */
export const WORKSPACE_ADMIN_ROLES: readonly WorkspaceAccessRole[] = ['owner', 'admin'];
export const WORKSPACE_OWNER_ROLE: readonly WorkspaceAccessRole[] = ['owner'];

/** The member roles a request may assign (the owner is not a role you can give). */
export const ASSIGNABLE_WORKSPACE_ROLES: readonly WorkspaceRole[] = ['admin', 'member', 'viewer'];

export function isAssignableWorkspaceRole(value: unknown): value is WorkspaceRole {
    return typeof value === 'string' && (ASSIGNABLE_WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** The user's effective role: 'owner' for the owner, else their member row's role, else null. */
export function getWorkspaceRole(
    ownerId: string,
    memberRole: WorkspaceRole | null | undefined,
    userId: string
): WorkspaceAccessRole | null {
    if (ownerId === userId) return 'owner';
    return memberRole ?? null;
}

/** getWorkspaceRole from a loaded member list ({ userId, role }[]). */
export function getWorkspaceRoleFromMembers(
    ownerId: string,
    members: ReadonlyArray<{ userId: string; role: WorkspaceRole }>,
    userId: string
): WorkspaceAccessRole | null {
    return getWorkspaceRole(ownerId, members.find((m) => m.userId === userId)?.role, userId);
}

export function hasWorkspaceRole(role: WorkspaceAccessRole | null, allowed: readonly WorkspaceAccessRole[]): boolean {
    return role !== null && allowed.includes(role);
}

/** Owner or any member (viewers included). */
export function isMember(role: WorkspaceAccessRole | null): boolean {
    return hasWorkspaceRole(role, ANY_WORKSPACE_ROLE);
}

export function isOwner(role: WorkspaceAccessRole | null): boolean {
    return role === 'owner';
}

/** Owner or admin. */
export function isAdmin(role: WorkspaceAccessRole | null): boolean {
    return hasWorkspaceRole(role, WORKSPACE_ADMIN_ROLES);
}

/** Invite and remove members, change roles. */
export function canManageMembers(role: WorkspaceAccessRole | null): boolean {
    return isAdmin(role);
}

/** Change workspace settings. */
export function canManageSettings(role: WorkspaceAccessRole | null): boolean {
    return isAdmin(role);
}

/** Generate, list and revoke invite links; approve join requests. */
export function canManageInviteLinks(role: WorkspaceAccessRole | null): boolean {
    return isAdmin(role);
}

/** Create, edit, delete and (un)assign workspace tasks. */
export function canEditTasks(role: WorkspaceAccessRole | null): boolean {
    return hasWorkspaceRole(role, TASK_EDITOR_ROLES);
}

/** Only the owner can delete the workspace. */
export function canDeleteWorkspace(role: WorkspaceAccessRole | null): boolean {
    return isOwner(role);
}

/** GET /:id/stats: owners and admins always; members and viewers only if the setting allows it. */
export function canViewOverview(role: WorkspaceAccessRole | null, settings: Prisma.JsonValue | null | undefined): boolean {
    if (isAdmin(role)) return true;
    return isMember(role) && normalizeWorkspaceSettings(settings).membersCanViewOverview;
}

/**
 * What a user may do with a workspace task, from their role: 'allowed' (owner/admin/member),
 * 'viewer' (read only: handlers answer with their "Viewers cannot …" message) or 'denied'
 * (not a member).
 */
export function workspaceTaskAccess(role: WorkspaceAccessRole | null): 'allowed' | 'viewer' | 'denied' {
    if (canEditTasks(role)) return 'allowed';
    return role === 'viewer' ? 'viewer' : 'denied';
}

// ─── Loading the caller's access ──────────────────────────────────────

export interface WorkspaceAccess {
    workspace: { id: string; name: string; ownerId: string; settings: Prisma.JsonValue };
    /** The caller's effective role (null: not a member). */
    role: WorkspaceAccessRole | null;
}

/** The workspace (id, name, owner, settings) plus the caller's role, or null if it does not exist. */
export async function findWorkspaceAccess(
    workspaceId: string,
    userId: string,
    db: DbClient = prisma
): Promise<WorkspaceAccess | null> {
    if (!workspaceId || !userId) return null; // never let `undefined` reach a where clause
    const row = await db.workspace.findUnique({
        where: { id: workspaceId },
        select: {
            id: true,
            name: true,
            ownerId: true,
            settings: true,
            members: { where: { userId }, select: { role: true }, take: 1 },
        },
    });
    if (!row) return null;
    const { members, ...workspace } = row;
    return { workspace, role: getWorkspaceRole(row.ownerId, members[0]?.role, userId) };
}

/** findWorkspaceAccess, or 404 with the handler's message (default 'Workspace not found'). */
export async function requireWorkspaceAccess(
    workspaceId: string,
    userId: string,
    db: DbClient = prisma,
    notFoundMessage = 'Workspace not found'
): Promise<WorkspaceAccess> {
    const access = await findWorkspaceAccess(workspaceId, userId, db);
    if (!access) throw new ErrorResponse(404, notFoundMessage);
    return access;
}

/** Throw 403 `message` unless the caller's role is one of `allowed`. Returns the role. */
export function requireWorkspaceRole(
    access: Pick<WorkspaceAccess, 'role'>,
    allowed: readonly WorkspaceAccessRole[],
    message: string
): WorkspaceAccessRole {
    if (!hasWorkspaceRole(access.role, allowed)) {
        throw new ErrorResponse(403, message);
    }
    return access.role as WorkspaceAccessRole;
}
