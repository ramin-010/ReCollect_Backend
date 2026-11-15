// Personal tasks for agents (LOOP_COMPLETE_SPEC 4.1). Thin: validate, call the service.
import { z } from 'zod';
import { requireUser } from '../../middlwares/auth';
import { TASK_DUE, TASK_PRIORITIES, TASK_STATUSES, createTask, listTasks, updateTask } from '../../services/tasks/tasks.service';
import { handler, ok, param, parse } from './common';

const zDue = z.string().max(40).nullable().optional();

/** GET /api/tasks?due=today|week|overdue|all */
export const listTasksHandler = handler(async (req, res) => {
    const due = z.enum(TASK_DUE).optional().parse(req.query['due'] || undefined);
    ok(res, await listTasks(requireUser(req).id, due));
});

/** POST /api/tasks { title, due?, priority? } (201) */
export const createTaskHandler = handler(async (req, res) => {
    const input = parse(z.object({ title: z.string().trim().min(1).max(400), due: zDue, priority: z.enum(TASK_PRIORITIES).optional() }).strict(), req.body);
    ok(res, await createTask(requireUser(req).id, input), 201);
});

/** PATCH /api/tasks/:id { title?, due?, priority?, status? } */
export const updateTaskHandler = handler(async (req, res) => {
    const patch = parse(
        z
            .object({ title: z.string().trim().min(1).max(400).optional(), due: zDue, priority: z.enum(TASK_PRIORITIES).optional(), status: z.enum(TASK_STATUSES).optional() })
            .strict()
            .refine((p) => Object.keys(p).length > 0, 'Send title, due, priority or status'),
        req.body
    );
    ok(res, await updateTask(requireUser(req).id, param(req, 'id'), patch));
});
