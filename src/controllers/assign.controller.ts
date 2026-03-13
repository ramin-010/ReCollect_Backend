// Assign Controller — handles task assignment + ghost user creation + workspace auto-invite
import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import TodoModel from '../models/todoSchema';
import UserModel from '../models/userSchema';
import WorkspaceModel from '../models/workspaceSchema';
import NotificationModel from '../models/notificationSchema';
import ActivityLogModel from '../models/activityLogSchema';
import ErrorResponse from '../utils/errorResponse';
import { sendTaskAssignmentEmail } from '../utils/emailService';

/**
 * POST /api/todos/:id/assign
 * Body: { emails: string[] }
 * 
 * Assigns a task to users by email.
 * If user doesn't exist → creates ghost user.
 * If task belongs to a workspace and assignee is NOT a member → auto-sends workspace_invite.
 * Always sends a task_assigned notification.
 */
export const assignTask = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const currentUserId = req.user?._id ? req.user._id.toString() : '';
        const todoId = req.params.id;
        const { emails } = req.body;

        if (!emails || !Array.isArray(emails)) {
            throw new ErrorResponse(400, 'Emails array is required');
        }

        const normalizedEmails = emails.map(email => email.toLowerCase().trim()).filter(Boolean);

        if (normalizedEmails.length === 0) {
            throw new ErrorResponse(400, 'At least one valid email is required');
        }

        // 1. Find the task (must belong to current user or a workspace the user is part of)
        const todo = await TodoModel.findOne({
            _id: new mongoose.Types.ObjectId(todoId),
            $or: [
                { user: new mongoose.Types.ObjectId(currentUserId) },
                { workspace: { $exists: true, $ne: null } }
            ]
        });

        if (!todo) {
            throw new ErrorResponse(404, 'Task not found or you do not own it');
        }

        // If workspace task, verify current user is a member
        if (todo.workspace) {
            const ws = await WorkspaceModel.findById(todo.workspace).lean();
            if (ws) {
                const isMember = ws.owner.toString() === currentUserId ||
                    ws.members.some((m: any) => m.user.toString() === currentUserId);
                if (!isMember) {
                    throw new ErrorResponse(403, 'You are not a member of this workspace');
                }
            }
        }

        const currentUser = await UserModel.findById(currentUserId).select('name email');
        let workspace: any = null;
        if (todo.workspace) {
            workspace = await WorkspaceModel.findById(todo.workspace);
        }

        const assignedUsers: any[] = [];
        const ghostEmails: string[] = [];

        // Ensure assignees array exists
        if (!todo.assignees) todo.assignees = [];
        const existingAssigneeStrs = todo.assignees.map(a => a.toString());

        // Process each email
        for (const normalizedEmail of normalizedEmails) {
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
                ghostEmails.push(normalizedEmail);
                console.log(`[assign] Created ghost user: ${normalizedEmail} (${targetUser._id})`);
            }

            const targetUserIdStr = (targetUser._id as any).toString();

            // Prevent self-assignment (optional: maybe allow it if they want to assign multiple? Let's skip self)
            if (targetUserIdStr === currentUserId) {
                continue;
            }

            // Prevent duplicate assignment
            if (existingAssigneeStrs.includes(targetUserIdStr)) {
                continue;
            }

            todo.assignees.push(targetUser._id as mongoose.Types.ObjectId);
            assignedUsers.push(targetUser);

            // Workspace-specific logic: auto-invite if not a member
            if (workspace) {
                const isAlreadyMember = workspace.members.some(
                    (m: any) => m.user.toString() === targetUserIdStr
                );

                if (!isAlreadyMember) {
                    // Check if there's already a pending invite
                    const existingInvite = await NotificationModel.findOne({
                        recipient: targetUser._id,
                        type: 'workspace_invite',
                        status: 'pending',
                        'metadata.workspaceId': workspace._id,
                    });

                    if (!existingInvite) {
                        // Auto-send workspace invite notification
                        await NotificationModel.create({
                            recipient: targetUser._id,
                            sender: new mongoose.Types.ObjectId(currentUserId),
                            category: 'actionable',
                            type: 'workspace_invite',
                            title: 'Workspace Invite',
                            message: `${currentUser?.name || 'Someone'} invited you to join "${workspace.name}"`,
                            metadata: {
                                workspaceId: workspace._id,
                                workspaceName: workspace.name,
                                role: 'member',
                            },
                            status: 'pending',
                        });
                    }
                }

                // Log workspace activity
                ActivityLogModel.create({
                    workspace: workspace._id,
                    actor: new mongoose.Types.ObjectId(currentUserId),
                    action: 'task_assigned',
                    targetTask: todo._id,
                    targetUser: targetUser._id,
                    metadata: todo.title,
                }).catch(err => console.error('[activity]', err));
            }

            // Send task_assigned notification (always)
            await NotificationModel.create({
                recipient: targetUser._id,
                sender: new mongoose.Types.ObjectId(currentUserId),
                category: 'informational',
                type: 'task_assigned',
                title: 'Task Assigned',
                message: `${currentUser?.name || 'Someone'} assigned you "${todo.title}"`,
                metadata: {
                    taskId: todo._id,
                    taskTitle: todo.title,
                    workspaceId: todo.workspace || null,
                },
            });

            // Send email notification (fire and forget)
            sendTaskAssignmentEmail(
                { name: targetUser.name, email: targetUser.email },
                { name: currentUser?.name || 'Someone', email: currentUser?.email || '' },
                todo.title,
                isNewGhost,
                workspace?.name
            ).catch(err => console.error('[assign] Email send failed:', err));
        }

        if (assignedUsers.length > 0) {
            todo.assignedAt = new Date();
            if (todo.workspace) {
                todo.visibility = 'workspace';
            } else {
                todo.visibility = 'shared';
            }
            await todo.save();
        }

        // Return updated task
        const updatedTodo = await TodoModel.findById(todoId)
            .populate('assignees', 'name email avatar')
            .populate('tags', 'name')
            .lean();

        res.status(200).json({
            success: true,
            data: updatedTodo,
            message: Object.keys(ghostEmails).length > 0
                ? `Task assigned. Invitations sent to ${ghostEmails.join(', ')}.`
                : `Task assigned successfully.`
        });

    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/todos/:id/unassign
 * Body: { email?: string }
 * Removes specific assignee, or all if no email provided.
 */
export const unassignTask = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const currentUserId = req.user?._id ? req.user._id.toString() : '';
        const todoId = req.params.id;
        const { email } = req.body;

        const todo = await TodoModel.findOne({
            _id: new mongoose.Types.ObjectId(todoId),
            user: new mongoose.Types.ObjectId(currentUserId)
        });

        if (!todo) {
            throw new ErrorResponse(404, 'Task not found or you do not own it');
        }

        if (!todo.assignees) todo.assignees = [];

        if (email) {
            // Remove specific user
            const normalizedEmail = email.toLowerCase().trim();
            const targetUser = await UserModel.findOne({ email: normalizedEmail });
            if (targetUser) {
                todo.assignees = todo.assignees.filter(
                    id => id.toString() !== (targetUser._id as any).toString()
                );
            }
        } else {
            // Clear all
            todo.assignees = [];
        }

        if (todo.assignees.length === 0) {
            todo.assignedAt = null as any;
            todo.visibility = 'private';
        }

        await todo.save();

        const updatedTodo = await TodoModel.findById(todoId)
            .populate('assignees', 'name email avatar')
            .populate('tags', 'name')
            .lean();

        res.status(200).json({
            success: true,
            data: updatedTodo,
            message: email ? `Assignee removed` : 'All assignees removed'
        });

    } catch (err) {
        next(err);
    }
};
