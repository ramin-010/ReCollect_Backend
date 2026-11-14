// Notification rows written by workspace flows (invites, join requests, task assignment).
// The notification READ endpoints live in the notifications module; this file only inserts and
// looks up the workspace-specific ones. Fields, types, titles, messages and metadata keys are
// exactly what the Mongo controllers wrote; ids inside `metadata` are plain strings now.
import type { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';

export const WORKSPACE_INVITE = 'workspace_invite';
export const WORKSPACE_JOIN_REQUEST = 'workspace_join_request';
export const TASK_ASSIGNED = 'task_assigned';

/** `{ metadata: { path: ['workspaceId'], equals } }` (Mongo: 'metadata.workspaceId': id). */
function metadataWorkspaceId(workspaceId: string): Prisma.NotificationWhereInput {
    return { metadata: { path: ['workspaceId'], equals: workspaceId } };
}

/** A pending workspace invite for this user + workspace, if any. */
export function findPendingWorkspaceInvite(recipientId: string, workspaceId: string, db: DbClient = prisma) {
    return db.notification.findFirst({
        where: { recipientId, type: WORKSPACE_INVITE, status: 'pending', ...metadataWorkspaceId(workspaceId) },
        select: { id: true },
    });
}

/** The actionable invite that POST /:id/members and task assignment send to a non-member. */
export function createWorkspaceInviteNotification(
    input: { recipientId: string; senderId: string; senderName: string | null | undefined; workspaceId: string; workspaceName: string },
    db: DbClient = prisma
) {
    return db.notification.create({
        data: {
            recipientId: input.recipientId,
            senderId: input.senderId,
            category: 'actionable',
            type: WORKSPACE_INVITE,
            title: 'Workspace Invite',
            message: `${input.senderName || 'Someone'} invited you to join "${input.workspaceName}"`,
            metadata: { workspaceId: input.workspaceId, workspaceName: input.workspaceName, role: 'member' },
            status: 'pending',
        },
    });
}

/** The informational "Task Assigned" notification (status keeps the schema default, as before). */
export function createTaskAssignedNotification(
    input: {
        recipientId: string;
        senderId: string;
        senderName: string | null | undefined;
        taskId: string;
        taskTitle: string;
        workspaceId: string | null;
    },
    db: DbClient = prisma
) {
    return db.notification.create({
        data: {
            recipientId: input.recipientId,
            senderId: input.senderId,
            category: 'informational',
            type: TASK_ASSIGNED,
            title: 'Task Assigned',
            message: `${input.senderName || 'Someone'} assigned you "${input.taskTitle}"`,
            metadata: { taskId: input.taskId, taskTitle: input.taskTitle, workspaceId: input.workspaceId },
        },
    });
}

/** A pending join request this user already sent for this workspace (to any admin), if any. */
export function findPendingJoinRequest(senderId: string, workspaceId: string, db: DbClient = prisma) {
    return db.notification.findFirst({
        where: { senderId, type: WORKSPACE_JOIN_REQUEST, status: 'pending', ...metadataWorkspaceId(workspaceId) },
        select: { id: true },
    });
}

export interface JoinRequestInput {
    recipientIds: readonly string[];
    requester: { id: string; name: string | null | undefined; email: string | null | undefined; avatar: string | null | undefined };
    workspaceId: string;
    workspaceName: string;
    spaceId: string | null;
    /** '' or ` (<space name>)`, appended to the message. */
    spaceSuffix: string;
    inviteLinkId: string;
}

/** One actionable "Join Request" per admin (the old insertMany). */
export function createJoinRequestNotifications(input: JoinRequestInput, db: DbClient = prisma) {
    const metadata: Prisma.InputJsonObject = {
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        spaceId: input.spaceId,
        inviteLinkId: input.inviteLinkId,
        requesterName: input.requester.name || 'Unknown',
        requesterEmail: input.requester.email || '',
        requesterAvatar: input.requester.avatar || null,
    };
    return db.notification.createMany({
        data: input.recipientIds.map((recipientId) => ({
            recipientId,
            senderId: input.requester.id,
            category: 'actionable' as const,
            type: WORKSPACE_JOIN_REQUEST,
            title: 'Join Request',
            message: `${input.requester.name || 'Someone'} wants to join "${input.workspaceName}"${input.spaceSuffix}`,
            metadata,
            status: 'pending' as const,
        })),
    });
}
