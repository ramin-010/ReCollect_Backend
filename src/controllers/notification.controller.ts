import { RequestHandler } from 'express';
import { requireUser } from '../middlwares/auth';
import ErrorResponse from '../utils/errorResponse';
import { serializeNotification } from '../db/serializers/notification';
import {
    acceptNotification as acceptNotificationRow,
    countUnreadNotifications,
    declineNotification as declineNotificationRow,
    deleteNotification as deleteNotificationRow,
    listNotifications,
    markAllNotificationsRead,
    markNotificationRead,
    NOTIFICATION_NOT_FOUND,
    NOTIFICATION_NOT_FOUND_OR_HANDLED,
    parsePagination,
    workspaceRoleHash,
} from '../services/notifications/notifications.service';

/**
 * GET /api/notifications
 * Query params: ?page=1&limit=20&filter=all|unread|actionable
 */
export const getNotifications: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const { page, limit } = parsePagination(req.query.page, req.query.limit);
        const filter = (req.query.filter as string) || 'all';

        const { rows, pagination } = await listNotifications(user.id, { page, limit, filter });

        res.status(200).json({
            success: true,
            data: rows.map(serializeNotification),
            pagination,
        });
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/notifications/unread-count
 */
export const getUnreadCount: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const [count, roleHash] = await Promise.all([countUnreadNotifications(user.id), workspaceRoleHash(user.id)]);
        res.status(200).json({ success: true, data: { count, workspaceRoleHash: roleHash } });
    } catch (err) {
        next(err);
    }
};

/**
 * PATCH /api/notifications/:id/read
 */
export const markAsRead: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const notification = await markNotificationRead(user.id, String(req.params.id));

        if (!notification) {
            throw new ErrorResponse(404, NOTIFICATION_NOT_FOUND);
        }

        res.status(200).json({ success: true, data: serializeNotification(notification) });
    } catch (err) {
        next(err);
    }
};

/**
 * PATCH /api/notifications/read-all
 */
export const markAllAsRead: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        await markAllNotificationsRead(user.id);
        res.status(200).json({ success: true, message: 'All notifications marked as read' });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/notifications/:id/accept
 * Handle acceptance of actionable notifications (workspace_invite, etc.)
 */
export const acceptNotification: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const notification = await acceptNotificationRow(user.id, String(req.params.id));
        res.status(200).json({ success: true, data: serializeNotification(notification), message: 'Notification accepted' });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/notifications/:id/decline
 */
export const declineNotification: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const notification = await declineNotificationRow(user.id, String(req.params.id));

        if (!notification) {
            throw new ErrorResponse(404, NOTIFICATION_NOT_FOUND_OR_HANDLED);
        }

        res.status(200).json({ success: true, data: serializeNotification(notification), message: 'Notification declined' });
    } catch (err) {
        next(err);
    }
};

/**
 * DELETE /api/notifications/:id
 */
export const deleteNotification: RequestHandler = async (req, res, next) => {
    try {
        const user = requireUser(req);
        const deleted = await deleteNotificationRow(user.id, String(req.params.id));

        if (!deleted) {
            throw new ErrorResponse(404, NOTIFICATION_NOT_FOUND);
        }

        res.status(200).json({ success: true, message: 'Notification deleted' });
    } catch (err) {
        next(err);
    }
};
