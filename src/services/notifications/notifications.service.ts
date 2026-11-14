// Notification inbox (GET/PATCH/POST/DELETE /api/notifications) and the helper other modules use
// to create notifications. Any module's rows are listed: the inbox never filters on `type`.
//
// Accepting a workspace notification adds a WorkspaceMember row and an ActivityLog row here,
// directly with Prisma (the workspace module is ported separately; same rules as the old code:
// skip when already a member, never change an existing member's role).
import type { Notification, Prisma, WorkspaceRole } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { isRecordNotFound } from '../../db/errors';
import { notificationSenderInclude } from '../../db/serializers/notification';
import ErrorResponse from '../../utils/errorResponse';

export const NOTIFICATION_PAGE_MAX = 50;
export const NOTIFICATION_PAGE_DEFAULT = 20;

export const NOTIFICATION_NOT_FOUND = 'Notification not found';
export const NOTIFICATION_NOT_FOUND_OR_HANDLED = 'Notification not found or already handled';

const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['admin', 'member', 'viewer'];

export type NotificationFilter = 'all' | 'unread' | 'actionable' | string;

/** Only notifications scheduled for now or earlier (or not scheduled). */
function visibleAt(now: Date): Prisma.NotificationWhereInput {
    return { OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] };
}

/** page ≥ 1 and 1 ≤ limit ≤ 50, defaults 1 / 20 (same expressions as before). */
export function parsePagination(pageParam: unknown, limitParam: unknown): { page: number; limit: number } {
    const page = Math.max(1, parseInt(String(pageParam)) || 1);
    const limit = Math.min(NOTIFICATION_PAGE_MAX, Math.max(1, parseInt(String(limitParam)) || NOTIFICATION_PAGE_DEFAULT));
    return { page, limit };
}

export async function listNotifications(
    userId: string,
    options: { page: number; limit: number; filter: NotificationFilter },
    now: Date = new Date(),
    db: DbClient = prisma
) {
    const where: Prisma.NotificationWhereInput = { recipientId: userId, ...visibleAt(now) };
    if (options.filter === 'unread') {
        where.isRead = false;
    } else if (options.filter === 'actionable') {
        where.category = 'actionable';
        where.status = 'pending';
    }

    const skip = (options.page - 1) * options.limit;
    const [rows, total] = await Promise.all([
        db.notification.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip,
            take: options.limit,
            include: notificationSenderInclude,
        }),
        db.notification.count({ where }),
    ]);

    return {
        rows,
        pagination: {
            page: options.page,
            limit: options.limit,
            total,
            totalPages: Math.ceil(total / options.limit),
            hasMore: skip + rows.length < total,
        },
    };
}

export function countUnreadNotifications(userId: string, now: Date = new Date(), db: DbClient = prisma): Promise<number> {
    return db.notification.count({ where: { recipientId: userId, isRead: false, ...visibleAt(now) } });
}

/**
 * "<workspaceId>:<role>" for every workspace the user is a member of, sorted, joined with "|".
 * The frontend compares it between polls to notice role changes.
 */
export async function workspaceRoleHash(userId: string, db: DbClient = prisma): Promise<string> {
    const memberships = await db.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true, role: true } });
    return memberships
        .map((m) => `${m.workspaceId}:${m.role || 'unknown'}`)
        .sort()
        .join('|');
}

/** Returns the updated notification, or null when it is not the user's. */
export async function markNotificationRead(userId: string, notificationId: string, db: DbClient = prisma): Promise<Notification | null> {
    try {
        return await db.notification.update({ where: { id: notificationId, recipientId: userId }, data: { isRead: true } });
    } catch (err) {
        if (isRecordNotFound(err)) return null;
        throw err;
    }
}

export async function markAllNotificationsRead(userId: string, db: DbClient = prisma): Promise<number> {
    const { count } = await db.notification.updateMany({ where: { recipientId: userId, isRead: false }, data: { isRead: true } });
    return count;
}

/** Pending actionable → declined (+ read). Returns null when not found or already handled. */
export async function declineNotification(userId: string, notificationId: string, db: DbClient = prisma): Promise<Notification | null> {
    try {
        return await db.notification.update({
            where: { id: notificationId, recipientId: userId, category: 'actionable', status: 'pending' },
            data: { status: 'declined', isRead: true },
        });
    } catch (err) {
        if (isRecordNotFound(err)) return null;
        throw err;
    }
}

/** True when a notification of the user was deleted. */
export async function deleteNotification(userId: string, notificationId: string, db: DbClient = prisma): Promise<boolean> {
    const { count } = await db.notification.deleteMany({ where: { id: notificationId, recipientId: userId } });
    return count > 0;
}

function metadataObject(metadata: Prisma.JsonValue): Record<string, unknown> {
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
}

function idString(value: unknown): string | null {
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number') return String(value);
    return null;
}

/** Add a member unless already one. Returns true when a row was inserted. */
async function addWorkspaceMemberIfMissing(
    workspaceId: string,
    userId: string,
    role: unknown,
    now: Date,
    tx: DbClient
): Promise<boolean> {
    const existing = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { userId: true },
    });
    if (existing) return false;

    const memberRole = role || 'member';
    if (!WORKSPACE_ROLES.includes(memberRole as WorkspaceRole)) {
        // Mongoose validated the enum when the member was pushed and saved.
        throw new ErrorResponse(400, `\`${String(memberRole)}\` is not a valid enum value for path \`role\`.`);
    }
    // skipDuplicates: a concurrent accept must not abort the transaction.
    const { count } = await tx.workspaceMember.createMany({
        data: [{ workspaceId, userId, role: memberRole as WorkspaceRole, joinedAt: now }],
        skipDuplicates: true,
    });
    return count === 1;
}

/**
 * POST /:id/accept. Claims the pending actionable notification, does what its type means, and
 * returns it (status 'accepted', read). Errors roll everything back (the notification stays pending).
 *   workspace_invite        → the recipient joins metadata.workspaceId with metadata.role (default member)
 *   workspace_join_request  → the sender (requester) joins as member, gets a 'workspace_join_approved'
 *                             notification, and the other pending copies of the request are dismissed
 *   anything else           → only marked accepted
 */
export async function acceptNotification(userId: string, notificationId: string, now: Date = new Date()): Promise<Notification> {
    return prisma.$transaction(async (tx) => {
        const claimed = await tx.notification.updateMany({
            where: { id: notificationId, recipientId: userId, category: 'actionable', status: 'pending' },
            data: { status: 'accepted', isRead: true },
        });
        if (claimed.count === 0) {
            throw new ErrorResponse(404, NOTIFICATION_NOT_FOUND_OR_HANDLED);
        }
        const notification = await tx.notification.findUniqueOrThrow({ where: { id: notificationId } });
        const metadata = metadataObject(notification.metadata);

        switch (notification.type) {
            case 'workspace_invite': {
                const workspaceId = idString(metadata.workspaceId);
                if (!workspaceId) throw new ErrorResponse(400, 'Invalid notification data');

                const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
                if (!workspace) throw new ErrorResponse(404, 'Workspace no longer exists');

                if (await addWorkspaceMemberIfMissing(workspace.id, userId, metadata.role, now, tx)) {
                    await tx.activityLog.create({
                        data: {
                            workspaceId: workspace.id,
                            actorId: notification.senderId || userId,
                            action: 'member_joined',
                            targetUserId: userId,
                            metadata: 'Accepted invite',
                        },
                    });
                }
                break;
            }

            case 'workspace_join_request': {
                // The admin approves the request of the notification's sender.
                const workspaceId = idString(metadata.workspaceId);
                const requesterId = notification.senderId;
                if (!workspaceId || !requesterId) throw new ErrorResponse(400, 'Invalid notification data');

                const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } });
                if (!workspace) throw new ErrorResponse(404, 'Workspace no longer exists');

                if (await addWorkspaceMemberIfMissing(workspace.id, requesterId, 'member', now, tx)) {
                    await tx.activityLog.create({
                        data: {
                            workspaceId: workspace.id,
                            actorId: userId,
                            action: 'member_joined',
                            targetUserId: requesterId,
                            metadata: 'Approved join request',
                        },
                    });
                    await createNotification(
                        {
                            recipientId: requesterId,
                            senderId: userId,
                            category: 'informational',
                            type: 'workspace_join_approved',
                            title: 'Join Request Approved',
                            message: `Your request to join "${workspace.name}" has been approved!`,
                            metadata: { workspaceId: workspace.id, workspaceName: workspace.name },
                            status: 'pending',
                        },
                        tx
                    );
                }

                // Dismiss the other pending copies of this request (one was sent to every admin).
                await tx.notification.updateMany({
                    where: {
                        id: { not: notification.id },
                        type: 'workspace_join_request',
                        status: 'pending',
                        metadata: { path: ['workspaceId'], equals: workspaceId },
                        senderId: requesterId,
                    },
                    data: { status: 'dismissed', isRead: true },
                });
                break;
            }

            default:
                // For unknown actionable types, just mark accepted
                break;
        }

        return notification;
    });
}

// ─── For other modules ─────────────────────────────────────────────────

export interface CreateNotificationInput {
    recipientId: string;
    senderId?: string | null;
    category: Notification['category'];
    type: string;
    title: string;
    message?: string;
    icon?: string | null;
    /** Plain JSON; ids inside are plain strings. */
    metadata?: Prisma.InputJsonValue;
    status?: Notification['status'];
    scheduledFor?: Date | null;
    expiresAt?: Date | null;
}

/** Create one notification (Mongo defaults: message '', metadata {}, status pending, unread). */
export function createNotification(input: CreateNotificationInput, db: DbClient = prisma): Promise<Notification> {
    const data: Prisma.NotificationUncheckedCreateInput = {
        recipientId: input.recipientId,
        category: input.category,
        type: input.type,
        title: input.title,
    };
    if (input.senderId !== undefined) data.senderId = input.senderId;
    if (input.message !== undefined) data.message = input.message;
    if (input.icon !== undefined) data.icon = input.icon;
    if (input.metadata !== undefined) data.metadata = input.metadata;
    if (input.status !== undefined) data.status = input.status;
    if (input.scheduledFor !== undefined) data.scheduledFor = input.scheduledFor;
    if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt;
    return db.notification.create({ data });
}
