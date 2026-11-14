// Workspace shapes, matching what the Mongo API returned.
//
// serializeWorkspace  → a workspace after .populate('owner', 'name email avatar')
//                       .populate('members.user', 'name email avatar'):
//                       { _id, name, owner: {…}, members: [{ user: {…}, role, joinedAt }],
//                         spaces: [{ _id, name }], settings: { membersCanViewOverview }, createdAt, updatedAt }
//                       Member subdocuments had no _id (`_id: false` in Mongoose); spaces had one. No __v.
// serializeActivity   → an ActivityLog after .populate('actor' / 'targetUser', 'name email avatar'):
//                       { _id, workspace: <id>, actor: {…}, action, targetTask: <id> | null,
//                         targetUser: {…} | null, metadata, createdAt, updatedAt }
//
// Also exported from ./index.ts.
import type { Prisma } from '@prisma/client';
import { serializeUserSummary, serializeUserSummaryOrNull, userSummarySelect, type UserSummaryJson } from './user';

/** Include this in every workspace query whose result goes to serializeWorkspace(). */
export const workspaceInclude = {
    owner: { select: userSummarySelect },
    // Mongo kept members/spaces in array (insertion) order.
    members: {
        include: { user: { select: userSummarySelect } },
        orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }],
    },
    spaces: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.WorkspaceInclude;

export type WorkspaceWithRelations = Prisma.WorkspaceGetPayload<{ include: typeof workspaceInclude }>;

export interface WorkspaceMemberJson {
    user: UserSummaryJson;
    role: 'admin' | 'member' | 'viewer';
    joinedAt: Date;
}

export interface WorkspaceJson {
    _id: string;
    name: string;
    owner: UserSummaryJson;
    members: WorkspaceMemberJson[];
    spaces: Array<{ _id: string; name: string }>;
    settings: { membersCanViewOverview: boolean; [key: string]: unknown };
    createdAt: Date;
    updatedAt: Date;
}

/** The settings Json column as an object, with the Mongoose default (membersCanViewOverview: false) filled in. */
export function normalizeWorkspaceSettings(settings: Prisma.JsonValue | null | undefined): WorkspaceJson['settings'] {
    const stored =
        settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : {};
    return { ...stored, membersCanViewOverview: stored.membersCanViewOverview === true };
}

export function serializeWorkspace(ws: WorkspaceWithRelations): WorkspaceJson {
    return {
        _id: ws.id,
        name: ws.name,
        owner: serializeUserSummary(ws.owner),
        members: ws.members.map((m) => ({ user: serializeUserSummary(m.user), role: m.role, joinedAt: m.joinedAt })),
        spaces: ws.spaces.map((s) => ({ _id: s.id, name: s.name })),
        settings: normalizeWorkspaceSettings(ws.settings),
        createdAt: ws.createdAt,
        updatedAt: ws.updatedAt,
    };
}

/** Include this in activity queries whose result goes to serializeActivity(). */
export const activityInclude = {
    actor: { select: userSummarySelect },
    targetUser: { select: userSummarySelect },
} satisfies Prisma.ActivityLogInclude;

export type ActivityWithRelations = Prisma.ActivityLogGetPayload<{ include: typeof activityInclude }>;

export interface ActivityJson {
    _id: string;
    workspace: string;
    actor: UserSummaryJson | null;
    action: ActivityWithRelations['action'];
    targetTask: string | null;
    targetUser: UserSummaryJson | null;
    metadata: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export function serializeActivity(row: ActivityWithRelations): ActivityJson {
    return {
        _id: row.id,
        workspace: row.workspaceId,
        actor: serializeUserSummaryOrNull(row.actor),
        action: row.action,
        targetTask: row.targetTaskId,
        targetUser: serializeUserSummaryOrNull(row.targetUser),
        metadata: row.metadata,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
