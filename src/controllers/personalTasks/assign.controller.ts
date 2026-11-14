// Personal Task Assignment Controller — Assign/Unassign for personal (non-workspace) tasks only
// No workspace logic. No cross-linking with workspace code.

import { Request, Response, NextFunction } from 'express';
import { requireUser } from '../../middlwares/auth';
import { serializeTodo } from '../../services/todos/todoShape';
import { assignPersonalTodo, unassignPersonalTodo } from '../../services/todos/todos.service';

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
        const user = requireUser(req);
        const { todo, ghostEmails } = await assignPersonalTodo(user.id, String(req.params.id), req.body?.emails);

        res.status(200).json({
            success: true,
            data: serializeTodo(todo),
            message: ghostEmails.length > 0
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
        const user = requireUser(req);
        const email = req.body?.email;
        const todo = await unassignPersonalTodo(user.id, String(req.params.id), email);

        res.status(200).json({
            success: true,
            data: serializeTodo(todo),
            message: email ? `Assignee removed` : 'All assignees removed'
        });

    } catch (err) {
        next(err);
    }
};
