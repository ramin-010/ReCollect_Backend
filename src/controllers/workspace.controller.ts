import { Request, Response, NextFunction, RequestHandler } from 'express';
import mongoose from 'mongoose';
import WorkspaceModel from '../models/workspaceSchema';
import UserModel from '../models/userSchema';
import TodoModel from '../models/todoSchema';
import ActivityLogModel from '../models/activityLogSchema';
import NotificationModel from '../models/notificationSchema';
import ErrorResponse from '../utils/errorResponse';
import { sendTaskAssignmentEmail } from '../utils/emailService';

/**
 * POST /api/workspaces
 * Body: { name: string, defaultSpaceName?: string }
 */
export const createWorkspace: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const { name, defaultSpaceName } = req.body;

        if (!name || typeof name !== 'string' || !name.trim()) {
            throw new ErrorResponse(400, 'Workspace name is required');
        }

        const initialSpaceName = defaultSpaceName?.trim() || 'Team 1';

        const workspace = await WorkspaceModel.create({
            name: name.trim(),
            owner: new mongoose.Types.ObjectId(userId),
            members: [{ user: new mongoose.Types.ObjectId(userId), role: 'admin', joinedAt: new Date() }],
            spaces: [{ name: initialSpaceName }]
        });

        // Log activity
        await ActivityLogModel.create({
            workspace: workspace._id,
            actor: new mongoose.Types.ObjectId(userId),
            action: 'workspace_created',
            metadata: name.trim(),
        });

        const populated = await WorkspaceModel.findById(workspace._id)
            .populate('owner', 'name email avatar')
            .populate('members.user', 'name email avatar')
            .lean();

        res.status(201).json({ success: true, data: populated });
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/workspaces
 * Returns all workspaces the user is a member of or owns
 */
export const getWorkspaces: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const oid = new mongoose.Types.ObjectId(userId);

        const workspaces = await WorkspaceModel.find({
            $or: [{ owner: oid }, { 'members.user': oid }]
        })
            .populate('owner', 'name email avatar')
            .populate('members.user', 'name email avatar')
            .sort({ updatedAt: -1 })
            .lean();

        res.status(200).json({ success: true, data: workspaces });
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/workspaces/:id
 */
export const getWorkspace: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const workspaceId = req.params.id;

        const workspace = await WorkspaceModel.findById(workspaceId)
            .populate('owner', 'name email avatar')
            .populate('members.user', 'name email avatar')
            .lean();

        if (!workspace) {
            throw new ErrorResponse(404, 'Workspace not found');
        }

        // Verify user is a member
        const isMember = workspace.owner._id.toString() === userId ||
            workspace.members.some((m: any) => m.user._id.toString() === userId);

        if (!isMember) {
            throw new ErrorResponse(403, 'You are not a member of this workspace');
        }

        res.status(200).json({ success: true, data: workspace });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/workspaces/:id/members
 * Body: { email: string }
 * Sends an invite notification to the user instead of directly adding them
 */
export const inviteMember: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const workspaceId = req.params.id;
        const { email } = req.body;

        if (!email || typeof email !== 'string') {
            throw new ErrorResponse(400, 'Email is required');
        }

        const normalizedEmail = email.toLowerCase().trim();

        const workspace = await WorkspaceModel.findById(workspaceId);
        if (!workspace) {
            throw new ErrorResponse(404, 'Workspace not found');
        }

        // Only owner or admin can invite
        const isAdmin = workspace.owner.toString() === userId ||
            workspace.members.some(m => m.user.toString() === userId && m.role === 'admin');

        if (!isAdmin) {
            throw new ErrorResponse(403, 'Only admins can invite members');
        }

        // Find or create user
        let targetUser = await UserModel.findOne({ email: normalizedEmail });
        let isNewGhost = false;

        if (!targetUser) {
            const emailPrefix = normalizedEmail.split('@')[0];
            targetUser = await UserModel.create({
                email: normalizedEmail,
                name: emailPrefix,
                password: `ghost_${Date.now()}_${Math.random().toString(36)}`,
                isGhost: true,
                status: 'pending'
            });
            isNewGhost = true;
        }

        const targetId = (targetUser._id as any).toString();

        // Prevent self-invite
        if (targetId === userId) {
            throw new ErrorResponse(400, 'You are already in this workspace');
        }

        // Check if already a member
        const alreadyMember = workspace.members.some(m => m.user.toString() === targetId);
        if (alreadyMember) {
            throw new ErrorResponse(400, 'User is already a member of this workspace');
        }

        // Check if there's already a pending invite for this user + workspace
        const existingInvite = await NotificationModel.findOne({
            recipient: targetUser._id,
            type: 'workspace_invite',
            status: 'pending',
            'metadata.workspaceId': workspace._id,
        });

        if (existingInvite) {
            throw new ErrorResponse(400, 'An invite is already pending for this user');
        }

        // Get sender info
        const currentUser = await UserModel.findById(userId).select('name email');

        // ── Create a notification instead of directly adding ──
        await NotificationModel.create({
            recipient: targetUser._id,
            sender: new mongoose.Types.ObjectId(userId),
            category: 'actionable',
            type: 'workspace_invite',
            title: `Workspace Invite`,
            message: `${currentUser?.name || 'Someone'} invited you to join "${workspace.name}"`,
            metadata: {
                workspaceId: workspace._id,
                workspaceName: workspace.name,
                role: 'member',
            },
            status: 'pending',
        });

        // Send invitation email (fire and forget)
        sendTaskAssignmentEmail(
            { name: targetUser.name, email: targetUser.email },
            { name: currentUser?.name || 'Someone', email: currentUser?.email || '' },
            `Join workspace: ${workspace.name}`,
            isNewGhost,
            workspace.name
        ).catch(err => console.error('[workspace] Invite email failed:', err));

        res.status(200).json({
            success: true,
            message: isNewGhost
                ? `Invitation sent to ${normalizedEmail}`
                : `Invite sent to ${targetUser.name}`,
        });
    } catch (err) {
        next(err);
    }
};

/**
 * DELETE /api/workspaces/:id/members/:userId
 * Remove a member from the workspace
 */
export const removeMember: RequestHandler = async (req, res, next) => {
    try {
        const currentUserId = String(req.user?._id);
        const { id: workspaceId, userId: targetUserId } = req.params;

        const workspace = await WorkspaceModel.findById(workspaceId);
        if (!workspace) {
            throw new ErrorResponse(404, 'Workspace not found');
        }

        // Only owner or admin can remove, or user can remove themselves
        const isAdmin = workspace.owner.toString() === currentUserId ||
            workspace.members.some(m => m.user.toString() === currentUserId && m.role === 'admin');
        const isSelf = targetUserId === currentUserId;

        if (!isAdmin && !isSelf) {
            throw new ErrorResponse(403, 'Only admins can remove members');
        }

        // Can't remove the owner
        if (workspace.owner.toString() === targetUserId) {
            throw new ErrorResponse(400, 'Cannot remove the workspace owner');
        }

        workspace.members = workspace.members.filter(
            m => m.user.toString() !== targetUserId
        );

        await workspace.save();

        // Log activity
        await ActivityLogModel.create({
            workspace: workspace._id,
            actor: new mongoose.Types.ObjectId(currentUserId),
            action: 'member_removed',
            targetUser: new mongoose.Types.ObjectId(targetUserId),
        });

        const updated = await WorkspaceModel.findById(workspaceId)
            .populate('owner', 'name email avatar')
            .populate('members.user', 'name email avatar')
            .lean();

        res.status(200).json({ success: true, data: updated, message: 'Member removed' });
    } catch (err) {
        next(err);
    }
};

/**
 * PATCH /api/workspaces/:id/members/:userId/role
 * Update a member's role (Owner or Admin only, but Admin cannot modify Owner)
 */
export const updateWorkspaceRole: RequestHandler = async (req, res, next) => {
    try {
        const currentUserId = String(req.user?._id);
        const { id: workspaceId, userId: targetUserId } = req.params;
        const { role } = req.body;

        if (!['admin', 'member', 'viewer'].includes(role)) {
            throw new ErrorResponse(400, 'Invalid role');
        }

        const workspace = await WorkspaceModel.findById(workspaceId);
        if (!workspace) throw new ErrorResponse(404, 'Workspace not found');

        const isOwner = workspace.owner.toString() === currentUserId;
        const isAdmin = workspace.members.some((m: any) => m.user.toString() === currentUserId && m.role === 'admin');

        if (!isOwner && !isAdmin) {
            throw new ErrorResponse(403, 'Only admins can update roles');
        }

        if (workspace.owner.toString() === targetUserId) {
            throw new ErrorResponse(400, 'Cannot change the role of the workspace owner');
        }

        const memberIndex = workspace.members.findIndex((m: any) => m.user.toString() === targetUserId);
        if (memberIndex === -1) {
            throw new ErrorResponse(400, 'User is not a member of this workspace');
        }

        const member = workspace.members[memberIndex];
        if (member) member.role = role as 'admin' | 'member' | 'viewer';
        await workspace.save();

        const updated = await WorkspaceModel.findById(workspaceId)
            .populate('owner', 'name email avatar')
            .populate('members.user', 'name email avatar')
            .lean();

        res.status(200).json({ success: true, data: updated, message: 'Role updated' });
    } catch (err) {
        next(err);
    }
};

/**
 * DELETE /api/workspaces/:id
 * Delete workspace (owner only)
 */
export const deleteWorkspace: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const workspaceId = req.params.id;

        const workspace = await WorkspaceModel.findById(workspaceId);
        if (!workspace) {
            throw new ErrorResponse(404, 'Workspace not found');
        }

        if (workspace.owner.toString() !== userId) {
            throw new ErrorResponse(403, 'Only the workspace owner can delete it');
        }

        // Clean up: delete activity logs for this workspace
        await ActivityLogModel.deleteMany({ workspace: workspace._id });
        await WorkspaceModel.findByIdAndDelete(workspaceId);

        res.status(200).json({ success: true, message: 'Workspace deleted' });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/workspaces/:id/spaces
 * Add a new space to the workspace
 */
export const createSpace: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const workspaceId = req.params.id;
        const { name } = req.body;

        if (!name || typeof name !== 'string' || !name.trim()) {
            throw new ErrorResponse(400, 'Space name is required');
        }

        const workspace = await WorkspaceModel.findById(workspaceId);
        if (!workspace) throw new ErrorResponse(404, 'Workspace not found');

        const isMember = workspace.owner.toString() === userId ||
            workspace.members.some((m: any) => m.user.toString() === userId);
        if (!isMember) throw new ErrorResponse(403, 'Not a member of this workspace');

        workspace.spaces.push({ name: name.trim() } as any);
        await workspace.save();

        const updated = await WorkspaceModel.findById(workspaceId)
            .populate('owner', 'name email avatar')
            .populate('members.user', 'name email avatar')
            .lean();

        res.status(201).json({ success: true, data: updated, message: 'Space created' });
    } catch (err) {
        next(err);
    }
};

// ─────────────────────────────────────────────────────────────
// NEW ENDPOINTS: Tasks, Stats, Activity
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/workspaces/:id/tasks
 * Returns all tasks belonging to this workspace
 */
export const getWorkspaceTasks: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const workspaceId = req.params.id;

        // Verify membership
        const workspace = await WorkspaceModel.findById(workspaceId).lean();
        if (!workspace) throw new ErrorResponse(404, 'Workspace not found');

        const isMember = workspace.owner.toString() === userId ||
            workspace.members.some((m: any) => m.user.toString() === userId);
        if (!isMember) throw new ErrorResponse(403, 'Not a member');

        const { spaceId } = req.query;
        const query: any = {
            workspace: new mongoose.Types.ObjectId(workspaceId),
            visibility: 'workspace',
        };

        if (spaceId && typeof spaceId === 'string' && spaceId !== 'all') {
            query.spaceId = new mongoose.Types.ObjectId(spaceId);
        }

        const tasks = await TodoModel.find(query)
            .sort({ createdAt: -1 })
            .populate('tags', 'name')
            .populate('assignees', 'name email avatar')
            .populate('user', 'name email avatar')
            .lean();

        res.status(200).json({ success: true, data: tasks, count: tasks.length });
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/workspaces/:id/stats
 * Returns aggregate stats for the workspace dashboard
 */
export const getWorkspaceStats: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const workspaceId = req.params.id;

        const workspace = await WorkspaceModel.findById(workspaceId).lean();
        if (!workspace) throw new ErrorResponse(404, 'Workspace not found');

        const isOwner = workspace.owner.toString() === userId;
        const isAdmin = workspace.members.some((m: any) => m.user.toString() === userId && m.role === 'admin');
        const isMember = isOwner || workspace.members.some((m: any) => m.user.toString() === userId);
        if (!isMember) throw new ErrorResponse(403, 'Not a member');

        // Check Overview Access
        if (!isOwner && !isAdmin) {
            const canView = workspace.settings?.membersCanViewOverview === true;
            if (!canView) {
                throw new ErrorResponse(403, 'You do not have permission to view the workspace overview.');
            }
        }

        const wsOid = new mongoose.Types.ObjectId(workspaceId);
        const { spaceId } = req.query;
        
        const baseQuery: any = { workspace: wsOid, visibility: 'workspace' };
        if (spaceId && typeof spaceId === 'string' && spaceId !== 'all') {
            baseQuery.spaceId = new mongoose.Types.ObjectId(spaceId);
        }

        const [totalTasks, pending, inProgress, completed, overdue] = await Promise.all([
            TodoModel.countDocuments(baseQuery),
            TodoModel.countDocuments({ ...baseQuery, status: 'pending' }),
            TodoModel.countDocuments({ ...baseQuery, status: 'in_progress' }),
            TodoModel.countDocuments({ ...baseQuery, status: 'complete' }),
            TodoModel.countDocuments({
                ...baseQuery,
                status: { $ne: 'complete' },
                dueDate: { $lt: new Date() },
            }),
        ]);

        res.status(200).json({
            success: true,
            data: {
                totalMembers: workspace.members.length,
                totalTasks,
                pending,
                inProgress,
                completed,
                overdue,
            },
        });
    } catch (err) {
        next(err);
    }
};

/**
 * GET /api/workspaces/:id/activity
 * Returns the last 30 activity log entries for a workspace
 */
export const getWorkspaceActivity: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const workspaceId = req.params.id;

        const workspace = await WorkspaceModel.findById(workspaceId).lean();
        if (!workspace) throw new ErrorResponse(404, 'Workspace not found');

        const isMember = workspace.owner.toString() === userId ||
            workspace.members.some((m: any) => m.user.toString() === userId);
        if (!isMember) throw new ErrorResponse(403, 'Not a member');

        const activity = await ActivityLogModel.find({
            workspace: new mongoose.Types.ObjectId(workspaceId),
        })
            .sort({ createdAt: -1 })
            .limit(30)
            .populate('actor', 'name email avatar')
            .populate('targetUser', 'name email avatar')
            .lean();

        res.status(200).json({ success: true, data: activity });
    } catch (err) {
        next(err);
    }
};

/**
 * PATCH /api/workspaces/:id/settings
 * Update workspace settings (only owner or admins)
 */
export const updateWorkspaceSettings: RequestHandler = async (req, res, next) => {
    try {
        const userId = String(req.user?._id);
        const workspaceId = req.params.id;
        const { membersCanViewOverview } = req.body;

        const workspace = await WorkspaceModel.findById(workspaceId);
        if (!workspace) throw new ErrorResponse(404, 'Workspace not found');

        const isOwner = workspace.owner.toString() === userId;
        const isAdmin = workspace.members.some((m: any) => m.user.toString() === userId && m.role === 'admin');
        
        if (!isOwner && !isAdmin) {
            throw new ErrorResponse(403, 'Only admins can update workspace settings');
        }

        if (typeof membersCanViewOverview === 'boolean') {
            if (!workspace.settings) {
                workspace.settings = { membersCanViewOverview: false };
            }
            workspace.settings.membersCanViewOverview = membersCanViewOverview;
        }

        await workspace.save();

        const updated = await WorkspaceModel.findById(workspaceId)
            .populate('owner', 'name email avatar')
            .populate('members.user', 'name email avatar')
            .lean();

        res.status(200).json({ success: true, data: updated, message: 'Settings updated' });
    } catch (err) {
        next(err);
    }
};
