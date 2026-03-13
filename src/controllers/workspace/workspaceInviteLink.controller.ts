import { Request, Response, NextFunction, RequestHandler } from 'express';
import mongoose from 'mongoose';
import WorkspaceModel from '../../models/workspaceSchema';
import WorkspaceInviteLinkModel from '../../models/workspaceInviteLinkSchema';
import UserModel from '../../models/userSchema';
import NotificationModel from '../../models/notificationSchema';
import ActivityLogModel from '../../models/activityLogSchema';
import ErrorResponse from '../../utils/errorResponse';

// ─────────────────────────────────────────────────────────────
// POST /api/workspaces/:id/invite-link
// Generate (or return existing) invite link for a workspace/space
// Body: { spaceId?: string, expiresInDays?: number }
// ─────────────────────────────────────────────────────────────
export const generateInviteLink: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const workspaceId = req.params.id;
        const { spaceId, expiresInDays } = req.body;

        const workspace = await WorkspaceModel.findById(workspaceId);
        if (!workspace) {
            throw new ErrorResponse(404, 'Workspace not found');
        }

        // Only owner or admin can generate links
        const isAdmin = workspace.owner.toString() === userId ||
            workspace.members.some(m => m.user.toString() === userId && m.role === 'admin');
        if (!isAdmin) {
            throw new ErrorResponse(403, 'Only admins can generate invite links');
        }

        // Validate spaceId if provided
        if (spaceId) {
            const spaceExists = workspace.spaces.some(s => s._id.toString() === spaceId);
            if (!spaceExists) {
                throw new ErrorResponse(404, 'Space not found in this workspace');
            }
        }

        // Check for existing active link for same workspace+space
        let existingLink = await WorkspaceInviteLinkModel.findOne({
            workspace: workspaceId,
            space: spaceId || null,
            isActive: true,
            $or: [
                { expiresAt: null },
                { expiresAt: { $gt: new Date() } },
            ],
        });

        if (existingLink) {
            return res.status(200).json({
                success: true,
                data: {
                    token: existingLink.token,
                    expiresAt: existingLink.expiresAt,
                    useCount: existingLink.useCount,
                },
                message: 'Existing invite link returned',
            });
        }

        // Create new link
        const expiresAt = expiresInDays
            ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
            : null;

        const link = await WorkspaceInviteLinkModel.create({
            workspace: workspaceId,
            space: spaceId || null,
            createdBy: new mongoose.Types.ObjectId(userId),
            expiresAt,
        });

        res.status(201).json({
            success: true,
            data: {
                token: link.token,
                expiresAt: link.expiresAt,
                useCount: 0,
            },
            message: 'Invite link generated',
        });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// GET /api/workspaces/invite-link/:token/info
// Public — returns workspace name, space name, creator name
// No auth required (landing page uses this)
// ─────────────────────────────────────────────────────────────
export const getInviteLinkInfo: RequestHandler = async (req, res, next) => {
    try {
        const { token } = req.params;

        const link = await WorkspaceInviteLinkModel.findOne({ token, isActive: true })
            .populate('createdBy', 'name avatar')
            .populate('workspace', 'name');

        if (!link) {
            throw new ErrorResponse(404, 'Invite link is invalid or has been revoked');
        }

        // Check expiry
        if (link.expiresAt && link.expiresAt < new Date()) {
            throw new ErrorResponse(410, 'This invite link has expired');
        }

        // Check max uses
        if (link.maxUses && link.useCount >= link.maxUses) {
            throw new ErrorResponse(410, 'This invite link has reached its usage limit');
        }

        const workspace = link.workspace as any;

        // Get space name if applicable
        let spaceName: string | null = null;
        if (link.space) {
            const fullWorkspace = await WorkspaceModel.findById(workspace._id);
            const space = fullWorkspace?.spaces.find(s => s._id.toString() === link.space?.toString());
            spaceName = space?.name || null;
        }

        const inviter = link.createdBy as any;

        res.status(200).json({
            success: true,
            data: {
                workspaceName: workspace.name,
                spaceName,
                invitedBy: {
                    name: inviter?.name || 'Someone',
                    avatar: inviter?.avatar || null,
                },
            },
        });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// POST /api/workspaces/invite-link/:token/request
// Authenticated user requests to join via invite token
// ─────────────────────────────────────────────────────────────
export const requestToJoinViaLink: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const { token } = req.params;

        const link = await WorkspaceInviteLinkModel.findOne({ token, isActive: true });
        if (!link) {
            throw new ErrorResponse(404, 'Invite link is invalid or has been revoked');
        }

        // Check expiry
        if (link.expiresAt && link.expiresAt < new Date()) {
            throw new ErrorResponse(410, 'This invite link has expired');
        }

        // Check max uses
        if (link.maxUses && link.useCount >= link.maxUses) {
            throw new ErrorResponse(410, 'This invite link has reached its usage limit');
        }

        const workspace = await WorkspaceModel.findById(link.workspace);
        if (!workspace) {
            throw new ErrorResponse(404, 'Workspace no longer exists');
        }

        // Check if already a member
        const alreadyMember = workspace.members.some(m => m.user.toString() === userId);
        if (alreadyMember || workspace.owner.toString() === userId) {
            throw new ErrorResponse(400, 'You are already a member of this workspace');
        }

        // Check for existing pending join request for this user + workspace
        const existingRequest = await NotificationModel.findOne({
            sender: new mongoose.Types.ObjectId(userId),
            type: 'workspace_join_request',
            status: 'pending',
            'metadata.workspaceId': workspace._id,
        });

        if (existingRequest) {
            throw new ErrorResponse(400, 'You already have a pending join request for this workspace');
        }

        // Get requester info
        const requester = await UserModel.findById(userId).select('name email avatar');

        // Create a notification for the workspace OWNER (and all admins)
        const adminUserIds: mongoose.Types.ObjectId[] = [workspace.owner];
        workspace.members.forEach(m => {
            if (m.role === 'admin') {
                adminUserIds.push(m.user);
            }
        });

        // Deduplicate
        const uniqueAdminIds = [...new Set(adminUserIds.map(id => id.toString()))];

        // Space name for the notification message
        let spaceName = '';
        if (link.space) {
            const space = workspace.spaces.find(s => s._id.toString() === link.space?.toString());
            spaceName = space ? ` (${space.name})` : '';
        }

        // Create notifications for all admins
        const notifications = uniqueAdminIds.map(adminId => ({
            recipient: new mongoose.Types.ObjectId(adminId),
            sender: new mongoose.Types.ObjectId(userId),
            category: 'actionable' as const,
            type: 'workspace_join_request',
            title: 'Join Request',
            message: `${requester?.name || 'Someone'} wants to join "${workspace.name}"${spaceName}`,
            metadata: {
                workspaceId: workspace._id,
                workspaceName: workspace.name,
                spaceId: link.space || null,
                inviteLinkId: link._id,
                requesterName: requester?.name || 'Unknown',
                requesterEmail: requester?.email || '',
                requesterAvatar: requester?.avatar || null,
            },
            status: 'pending' as const,
        }));

        await NotificationModel.insertMany(notifications);

        // Increment use count
        link.useCount += 1;
        await link.save();

        res.status(200).json({
            success: true,
            message: 'Your request has been sent to the workspace admins. You\'ll be notified once approved.',
        });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// DELETE /api/workspaces/:id/invite-link/:linkId
// Revoke an invite link (admin only)
// ─────────────────────────────────────────────────────────────
export const revokeInviteLink: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const { id: workspaceId, linkId } = req.params;

        const workspace = await WorkspaceModel.findById(workspaceId);
        if (!workspace) {
            throw new ErrorResponse(404, 'Workspace not found');
        }

        const isAdmin = workspace.owner.toString() === userId ||
            workspace.members.some(m => m.user.toString() === userId && m.role === 'admin');
        if (!isAdmin) {
            throw new ErrorResponse(403, 'Only admins can revoke invite links');
        }

        const link = await WorkspaceInviteLinkModel.findOneAndUpdate(
            { _id: linkId, workspace: workspaceId },
            { isActive: false },
            { new: true }
        );

        if (!link) {
            throw new ErrorResponse(404, 'Invite link not found');
        }

        res.status(200).json({ success: true, message: 'Invite link revoked' });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// GET /api/workspaces/:id/invite-links
// Get all active invite links for a workspace (admin only)
// ─────────────────────────────────────────────────────────────
export const getInviteLinks: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const workspaceId = req.params.id;

        const workspace = await WorkspaceModel.findById(workspaceId);
        if (!workspace) {
            throw new ErrorResponse(404, 'Workspace not found');
        }

        const isAdmin = workspace.owner.toString() === userId ||
            workspace.members.some(m => m.user.toString() === userId && m.role === 'admin');
        if (!isAdmin) {
            throw new ErrorResponse(403, 'Only admins can view invite links');
        }

        const links = await WorkspaceInviteLinkModel.find({
            workspace: workspaceId,
            isActive: true,
            $or: [
                { expiresAt: null },
                { expiresAt: { $gt: new Date() } },
            ],
        }).sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            data: links.map(l => ({
                _id: l._id,
                token: l.token,
                spaceId: l.space,
                expiresAt: l.expiresAt,
                useCount: l.useCount,
                createdAt: l.createdAt,
            })),
        });
    } catch (err) {
        next(err);
    }
};
