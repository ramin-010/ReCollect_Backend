// Personal Todo Controller — CRUD operations for personal (non-workspace) tasks only
// No workspace logic. No cross-linking with workspace code.
// All database work is in src/services/todos/todos.service.ts; responses use serializeTodo().

import { Request, Response, NextFunction } from 'express';
import { requireUser } from '../../middlwares/auth';
import { scheduleTodoReminder } from '../../services/reminderService';
import { serializeTodo, serializeTodos } from '../../services/todos/todoShape';
import {
    createPersonalTodo,
    deletePersonalTodo,
    listPersonalTodos,
    searchTodoReferences,
    updatePersonalTodo,
} from '../../services/todos/todos.service';

// Kept for compatibility: these used to live here.
export { deleteFromCloud, batchDeleteFromCloud } from '../../utils/cloudinary';

export const createTodo = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const user = requireUser(req);
        const { todo, reminder } = await createPersonalTodo(user.id, req.body ?? {}, req.files);

        if (reminder) {
            scheduleTodoReminder(reminder).catch(err => {
                console.error("Failed to schedule todo reminder:", err);
            });
        }

        res.status(201).json({
            success: true,
            data: serializeTodo(todo),
            message: 'Task created successfully'
        });
    } catch (err) {
        next(err);
    }
};


export const getTodos = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const user = requireUser(req);
        const { status, priority, refType, refId } = req.query;

        const todos = await listPersonalTodos(user.id, { status, priority, refType, refId });

        res.status(200).json({
            success: true,
            data: serializeTodos(todos),
            count: todos.length
        });
    } catch (err) {
        next(err);
    }
};


export const updateTodo = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const user = requireUser(req);
        const { todo, reminder } = await updatePersonalTodo(user.id, String(req.params.id), req.body ?? {}, req.files);

        if (reminder) {
            scheduleTodoReminder(reminder).catch(err => console.error(err));
        }

        res.status(200).json({
            success: true,
            data: serializeTodo(todo),
            message: 'Task updated successfully'
        });
    } catch (err) {
        next(err);
    }
};


export const deleteTodo = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const user = requireUser(req);
        await deletePersonalTodo(user.id, String(req.params.id));

        res.status(200).json({
            success: true,
            message: 'Task deleted successfully'
        });
    } catch (err) {
        next(err);
    }
};

/**
 * Search user's docs by title (for @ mention in personal tasks). Slides were cut, so only docs are returned.
 * Returns a lean list of { type, refId, title } — nothing more.
 */
export const searchReferences = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const user = requireUser(req);
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

        const results = await searchTodoReferences(user.id, q);

        res.status(200).json({ success: true, data: results });
    } catch (err) {
        next(err);
    }
};
