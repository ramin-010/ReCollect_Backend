// Notification shape, matching the Mongo API. Works for ANY Notification row, whichever module
// created it (todos, workspaces, …): `metadata` is passed through untouched.
//
//   _id, recipient (bare id: it was never populated), sender, category, type, title, message, icon,
//   metadata, status, isRead, scheduledFor, expiresAt, createdAt, updatedAt (no __v).
//
// `sender`: GET /notifications populated it ('name email avatar') → { _id, name, email, avatar } or
// null; the other endpoints returned the bare id. So: include `sender` (notificationSenderInclude)
// to get the object; without it the serializer returns `senderId`, exactly as before.
import type { Notification, Prisma } from '@prisma/client';
import { serializeUserSummaryOrNull, userSummarySelect, type UserSummaryJson, type UserSummaryRow } from './user';

/** include this to get the populated sender. */
export const notificationSenderInclude = {
    sender: { select: userSummarySelect },
} satisfies Prisma.NotificationInclude;

export type NotificationRowForJson = Notification & { sender?: UserSummaryRow | null };

export interface NotificationJson {
    _id: string;
    recipient: string;
    sender: UserSummaryJson | string | null;
    category: Notification['category'];
    type: string;
    title: string;
    message: string;
    icon: string | null;
    metadata: Prisma.JsonValue;
    status: Notification['status'];
    isRead: boolean;
    scheduledFor: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export function serializeNotification(row: NotificationRowForJson): NotificationJson {
    const sender = row.sender !== undefined ? serializeUserSummaryOrNull(row.sender) : row.senderId;
    return {
        _id: row.id,
        recipient: row.recipientId,
        sender,
        category: row.category,
        type: row.type,
        title: row.title,
        message: row.message,
        icon: row.icon,
        metadata: row.metadata,
        status: row.status,
        isRead: row.isRead,
        scheduledFor: row.scheduledFor,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
