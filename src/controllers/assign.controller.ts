// Assign Controller — handles task assignment + ghost user creation
import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import TodoModel from '../models/todoSchema';
import UserModel from '../models/userSchema';
import ErrorResponse from '../utils/errorResponse';
import { sendTaskAssignmentEmail } from '../utils/emailService';

/**
 * POST /api/todos/:id/assign
 * Body: { email: string }
 * 
 * Assigns a task to a user by email.
 * If user doesn't exist, creates a ghost user and sends invitation.
 */
export const assignTask = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const currentUserId = req.user?._id as string;
        const todoId = req.params.id;
        const { email } = req.body;

        if (!email || typeof email !== 'string') {
            throw new ErrorResponse(400, 'Email is required');
        }

        const normalizedEmail = email.toLowerCase().trim();

        // 1. Find the task (must belong to current user)
        const todo = await TodoModel.findOne({
            _id: new mongoose.Types.ObjectId(todoId),
            user: new mongoose.Types.ObjectId(currentUserId)
        });

        if (!todo) {
            throw new ErrorResponse(404, 'Task not found or you do not own it');
        }

        // 2. Find or create user
        let targetUser = await UserModel.findOne({ email: normalizedEmail });
        let isNewGhost = false;

        if (!targetUser) {
            // Create ghost user
            const emailPrefix = normalizedEmail.split('@')[0];
            targetUser = await UserModel.create({
                email: normalizedEmail,
                name: emailPrefix,
                password: `ghost_${Date.now()}_${Math.random().toString(36)}`, // placeholder
                isGhost: true,
                status: 'pending'
            });
            isNewGhost = true;
            console.log(`[assign] Created ghost user: ${normalizedEmail} (${targetUser._id})`);
        }

        // 3. Prevent self-assignment
        const targetUserIdStr = (targetUser._id as any).toString();
        if (targetUserIdStr === currentUserId) {
            throw new ErrorResponse(400, 'Cannot assign a task to yourself');
        }

        // 4. Update task — simple 1:1 assignment
        todo.assignee = targetUser._id as mongoose.Types.ObjectId;
        todo.assignedAt = new Date();
        todo.visibility = 'shared';

        await todo.save();

        // 5. Send email notification (fire and forget)
        const currentUser = await UserModel.findById(currentUserId).select('name email');
        sendTaskAssignmentEmail(
            { name: targetUser.name, email: targetUser.email },
            { name: currentUser?.name || 'Someone', email: currentUser?.email || '' },
            todo.title,
            isNewGhost
        ).catch(err => console.error('[assign] Email send failed:', err));

        // 6. Return updated task
        const updatedTodo = await TodoModel.findById(todoId)
            .populate('assignee', 'name email avatar')
            .populate('tags', 'name')
            .lean();

        res.status(200).json({
            success: true,
            data: updatedTodo,
            message: isNewGhost
                ? `Task assigned. Invitation sent to ${normalizedEmail}.`
                : `Task assigned to ${targetUser.name}.`
        });

    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/todos/:id/unassign
 * Removes the assignee from a task
 */
export const unassignTask = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const currentUserId = req.user?._id as string;
        const todoId = req.params.id;

        const todo = await TodoModel.findOne({
            _id: new mongoose.Types.ObjectId(todoId),
            user: new mongoose.Types.ObjectId(currentUserId)
        });

        if (!todo) {
            throw new ErrorResponse(404, 'Task not found or you do not own it');
        }

        todo.assignee = null as any;
        todo.assignedAt = null as any;
        todo.visibility = 'private';

        await todo.save();

        res.status(200).json({
            success: true,
            data: todo,
            message: 'Assignee removed'
        });

    } catch (err) {
        next(err);
    }
};
