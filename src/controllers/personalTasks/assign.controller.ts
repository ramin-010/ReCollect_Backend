// Personal Task Assignment Controller — Assign/Unassign for personal (non-workspace) tasks only
// No workspace logic. No cross-linking with workspace code.

import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import TodoModel from '../../models/todoSchema';
import UserModel from '../../models/userSchema';
import NotificationModel from '../../models/notificationSchema';
import ErrorResponse from '../../utils/errorResponse';

/**
 * POST /api/todos/:id/assign
 * Body: { emails: string[] }
 * 
 * Assigns a personal task to users by email.
 * If user doesn't exist → creates ghost user.
 * Always sends a task_assigned notification.
 * Personal tasks don't have workspace invite logic.
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

        // Find the task (must belong to current user, personal only)
        const todo = await TodoModel.findOne({
            _id: new mongoose.Types.ObjectId(todoId),
            user: new mongoose.Types.ObjectId(currentUserId),
            visibility: { $in: ['private', 'shared', null, undefined] }
        });

        if (!todo) {
            throw new ErrorResponse(404, 'Task not found or you do not own it');
        }

        const currentUser = await UserModel.findById(currentUserId).select('name email');

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

            // Prevent self-assignment
            if (targetUserIdStr === currentUserId) {
                continue;
            }

            // Prevent duplicate assignment
            if (existingAssigneeStrs.includes(targetUserIdStr)) {
                continue;
            }

            todo.assignees.push(targetUser._id as mongoose.Types.ObjectId);
            assignedUsers.push(targetUser);

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
                    workspaceId: null,
                },
            });
        }

        if (assignedUsers.length > 0) {
            todo.assignedAt = new Date();
            todo.visibility = 'shared';
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
