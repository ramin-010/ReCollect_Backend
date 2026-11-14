// Workspace Task Assignment Controller — Assign/Unassign for workspace tasks only (Postgres)
// All database work is in src/services/workspaces/workspaceAssign.service.ts.

import { Request, Response, NextFunction } from 'express';
import { requireUser } from '../../middlwares/auth';
import { serializeTodo } from '../../services/todos/todoShape';
import * as workspaceAssign from '../../services/workspaces/workspaceAssign.service';
import { routeParam } from './requestParams';

/**
 * POST /api/workspace-todos/:id/assign
 * Body: { emails: string[] }
 */
export const assignWorkspaceTask = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const user = requireUser(req);
        const { todo, ghostEmails } = await workspaceAssign.assignWorkspaceTask(
            { id: user.id, name: user.name, email: user.email },
            routeParam(req, 'id'),
            (req.body ?? {}).emails
        );

        res.status(200).json({
            success: true,
            data: serializeTodo(todo),
            message: ghostEmails.length > 0
                ? `Task assigned. Invitations sent to ${ghostEmails.join(', ')}.`
                : `Task assigned successfully.`,
        });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/workspace-todos/:id/unassign
 * Body: { email?: string }
 * Removes specific assignee, or all if no email provided.
 */
export const unassignWorkspaceTask = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const user = requireUser(req);
        const { email } = req.body ?? {};
        const todo = await workspaceAssign.unassignWorkspaceTask(
            { id: user.id, name: user.name, email: user.email },
            routeParam(req, 'id'),
            email
        );

        res.status(200).json({
            success: true,
            data: serializeTodo(todo),
            message: email ? `Assignee removed` : 'All assignees removed',
        });
    } catch (err) {
        next(err);
    }
};
