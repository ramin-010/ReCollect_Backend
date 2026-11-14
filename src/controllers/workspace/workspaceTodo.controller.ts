// Workspace Todo Controller — CRUD operations for workspace tasks only (Postgres)
// Assignment logic is in workspaceAssign.controller.ts.
// All database work is in src/services/workspaces/workspaceTodos.service.ts; responses use the
// shared todo shape (src/services/todos/todoShape.ts).

import { Request, Response, NextFunction } from 'express';
import { requireUser } from '../../middlwares/auth';
import { scheduleTodoReminder } from '../../services/reminderService';
import { serializeActivity } from '../../db/serializers/workspace';
import { serializeTodo } from '../../services/todos/todoShape';
import * as workspaceTodos from '../../services/workspaces/workspaceTodos.service';
import { routeParam } from './requestParams';

// Kept for compatibility: these used to live here.
export { deleteFromCloud, batchDeleteFromCloud } from '../../utils/cloudinary';

function actorOf(req: Request): workspaceTodos.TaskActor {
    const user = requireUser(req);
    return { id: user.id, name: user.name, email: user.email };
}

/** POST /api/workspace-todos (JSON, or multipart with image_<id> files) */
export const createWorkspaceTodo = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { todo, reminder } = await workspaceTodos.createWorkspaceTodo(actorOf(req), req.body ?? {}, req.files);

        if (reminder) {
            scheduleTodoReminder(reminder).catch((err) => {
                console.error('Failed to schedule todo reminder:', err);
            });
        }

        res.status(201).json({
            success: true,
            data: serializeTodo(todo),
            message: 'Task created successfully',
        });
    } catch (err) {
        next(err);
    }
};

/** PATCH /api/workspace-todos/:id */
export const updateWorkspaceTodo = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { todo, reminder } = await workspaceTodos.updateWorkspaceTodo(actorOf(req), routeParam(req, 'id'), req.body ?? {}, req.files);

        if (reminder) {
            scheduleTodoReminder(reminder).catch((err) => console.error(err));
        }

        res.status(200).json({
            success: true,
            data: serializeTodo(todo),
            message: 'Task updated successfully',
        });
    } catch (err) {
        next(err);
    }
};

/** DELETE /api/workspace-todos/:id */
export const deleteWorkspaceTodo = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        await workspaceTodos.deleteWorkspaceTodo(actorOf(req), routeParam(req, 'id'));
        res.status(200).json({
            success: true,
            message: 'Task deleted successfully',
        });
    } catch (err) {
        next(err);
    }
};

/** GET /api/workspace-todos/:id/activity */
export const getTaskActivity = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const activities = await workspaceTodos.getTaskActivity(actorOf(req), routeParam(req, 'id'));
        res.status(200).json({
            success: true,
            data: activities.map(serializeActivity),
        });
    } catch (err) {
        next(err);
    }
};
