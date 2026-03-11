import { Request, Response, NextFunction, RequestHandler } from 'express';
import mongoose from 'mongoose';
import NotificationModel from '../models/notificationSchema';
import WorkspaceModel from '../models/workspaceSchema';
import ActivityLogModel from '../models/activityLogSchema';
import ErrorResponse from '../utils/errorResponse';

/**
 * GET /api/notifications
 * Query params: ?page=1&limit=20&filter=all|unread|actionable
 */
export const getNotifications: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const page = Math.max(1, parseInt(req.query.page as string) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
        const filter = (req.query.filter as string) || 'all';
        const skip = (page - 1) * limit;

        const query: any = {
            recipient: new mongoose.Types.ObjectId(userId),
            // Only show notifications that are scheduled for now or earlier (or not scheduled)
            $or: [
                { scheduledFor: null },
                { scheduledFor: { $lte: new Date() } },
            ],
        };

        // Apply filter
        if (filter === 'unread') {
            query.isRead = false;
        } else if (filter === 'actionable') {
            query.category = 'actionable';
            query.status = 'pending';
        }

        const [notifications, total] = await Promise.all([
            NotificationModel.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .populate('sender', 'name email avatar')
                .lean(),
            NotificationModel.countDocuments(query),
        ]);

        res.status(200).json({
            success: true,
            data: notifications,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasMore: skip + notifications.length < total,
            },
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
        const userId = String(req.user?._id);

        const count = await NotificationModel.countDocuments({
            recipient: new mongoose.Types.ObjectId(userId),
            isRead: false,
            $or: [
                { scheduledFor: null },
                { scheduledFor: { $lte: new Date() } },
            ],
        });

        res.status(200).json({ success: true, data: { count } });
    } catch (err) {
        next(err);
    }
};

/**
 * PATCH /api/notifications/:id/read
 */
export const markAsRead: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const notificationId = req.params.id;

        const notification = await NotificationModel.findOneAndUpdate(
            { _id: notificationId, recipient: new mongoose.Types.ObjectId(userId) },
            { isRead: true },
            { new: true }
        ).lean();

        if (!notification) {
            throw new ErrorResponse(404, 'Notification not found');
        }

        res.status(200).json({ success: true, data: notification });
    } catch (err) {
        next(err);
    }
};

/**
 * PATCH /api/notifications/read-all
 */
export const markAllAsRead: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);

        await NotificationModel.updateMany(
            { recipient: new mongoose.Types.ObjectId(userId), isRead: false },
            { isRead: true }
        );

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
        const userId = String(req.user?._id);
        const notificationId = req.params.id;

        const notification = await NotificationModel.findOne({
            _id: notificationId,
            recipient: new mongoose.Types.ObjectId(userId),
            category: 'actionable',
            status: 'pending',
        });

        if (!notification) {
            throw new ErrorResponse(404, 'Notification not found or already handled');
        }

        // ── Switch on type to perform the appropriate action ──
        switch (notification.type) {
            case 'workspace_invite': {
                const { workspaceId, role } = notification.metadata || {};
                if (!workspaceId) {
                    throw new ErrorResponse(400, 'Invalid notification data');
                }

                const workspace = await WorkspaceModel.findById(workspaceId);
                if (!workspace) {
                    throw new ErrorResponse(404, 'Workspace no longer exists');
                }

                // Check if already a member
                const alreadyMember = workspace.members.some(
                    m => m.user.toString() === userId
                );
                if (!alreadyMember) {
                    workspace.members.push({
                        user: new mongoose.Types.ObjectId(userId),
                        role: role || 'member',
                        joinedAt: new Date(),
                    });
                    await workspace.save();

                    // Log activity
                    await ActivityLogModel.create({
                        workspace: workspace._id,
                        actor: notification.sender || new mongoose.Types.ObjectId(userId),
                        action: 'member_joined',
                        targetUser: new mongoose.Types.ObjectId(userId),
                        metadata: `Accepted invite`,
                    });
                }
                break;
            }

            case 'workspace_join_request': {
                // Admin is approving a user's request to join
                const { workspaceId } = notification.metadata || {};
                const requesterId = notification.sender?.toString();
                if (!workspaceId || !requesterId) {
                    throw new ErrorResponse(400, 'Invalid notification data');
                }

                const workspace = await WorkspaceModel.findById(workspaceId);
                if (!workspace) {
                    throw new ErrorResponse(404, 'Workspace no longer exists');
                }

                // Check if already a member
                const alreadyMember = workspace.members.some(
                    m => m.user.toString() === requesterId
                );
                if (!alreadyMember) {
                    workspace.members.push({
                        user: new mongoose.Types.ObjectId(requesterId),
                        role: 'member',
                        joinedAt: new Date(),
                    });
                    await workspace.save();

                    // Log activity
                    await ActivityLogModel.create({
                        workspace: workspace._id,
                        actor: new mongoose.Types.ObjectId(userId),
                        action: 'member_joined',
                        targetUser: new mongoose.Types.ObjectId(requesterId),
                        metadata: `Approved join request`,
                    });

                    // Notify the requester that they've been approved
                    await NotificationModel.create({
                        recipient: new mongoose.Types.ObjectId(requesterId),
                        sender: new mongoose.Types.ObjectId(userId),
                        category: 'informational',
                        type: 'workspace_join_approved',
                        title: 'Join Request Approved',
                        message: `Your request to join "${workspace.name}" has been approved!`,
                        metadata: {
                            workspaceId: workspace._id,
                            workspaceName: workspace.name,
                        },
                        status: 'pending',
                    });
                }

                // Dismiss all duplicate join request notifications for same requester+workspace
                await NotificationModel.updateMany(
                    {
                        _id: { $ne: notification._id },
                        type: 'workspace_join_request',
                        status: 'pending',
                        'metadata.workspaceId': workspaceId,
                        sender: new mongoose.Types.ObjectId(requesterId),
                    },
                    { status: 'dismissed', isRead: true }
                );
                break;
            }

            // ── Future types can be added here ──
            // case 'doc_collab_invite': { ... break; }
            // case 'slide_collab_invite': { ... break; }

            default:
                // For unknown actionable types, just mark accepted
                break;
        }

        notification.status = 'accepted';
        notification.isRead = true;
        await notification.save();

        res.status(200).json({ success: true, data: notification, message: 'Notification accepted' });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/notifications/:id/decline
 */
export const declineNotification: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const notificationId = req.params.id;

        const notification = await NotificationModel.findOneAndUpdate(
            {
                _id: notificationId,
                recipient: new mongoose.Types.ObjectId(userId),
                category: 'actionable',
                status: 'pending',
            },
            { status: 'declined', isRead: true },
            { new: true }
        ).lean();

        if (!notification) {
            throw new ErrorResponse(404, 'Notification not found or already handled');
        }

        res.status(200).json({ success: true, data: notification, message: 'Notification declined' });
    } catch (err) {
        next(err);
    }
};

/**
 * DELETE /api/notifications/:id
 */
export const deleteNotification: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const notificationId = req.params.id;

        const notification = await NotificationModel.findOneAndDelete({
            _id: notificationId,
            recipient: new mongoose.Types.ObjectId(userId),
        });

        if (!notification) {
            throw new ErrorResponse(404, 'Notification not found');
        }

        res.status(200).json({ success: true, message: 'Notification deleted' });
    } catch (err) {
        next(err);
    }
};
