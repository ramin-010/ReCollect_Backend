// A subject's path (BUDDY_PLAN B1): services/learningDb/path.service.ts.
import { z } from 'zod';
import { requireUser } from '../../middlwares/auth';
import { NEXT_STEP_MAX, PATH_TITLE_MAX, PLAN_MAX, planTopics, readPath, updateTopicOnPath } from '../../services/learningDb/path.service';
import { handler, ok, param, parse, zId } from './common';

const planSchema = z
    .object({
        titles: z.array(z.string().trim().min(1, 'a topic title cannot be empty').max(PATH_TITLE_MAX)).min(1).max(PLAN_MAX),
        after: zId.nullable().optional(),
    })
    .strict();

const topicPathSchema = z
    .object({
        title: z.string().trim().min(1).max(PATH_TITLE_MAX).optional(),
        status: z.enum(['planned', 'in_progress', 'done', 'skipped']).optional(),
        nextStep: z.string().max(NEXT_STEP_MAX).nullable().optional(),
        after: zId.nullable().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, { message: 'Send title, status, nextStep or after' });

/** GET /api/subjects/:id/path → { subject, topics, next, done, total } */
export const readPathHandler = handler(async (req, res) => {
    ok(res, await readPath(requireUser(req).id, param(req, 'id')));
});

/** POST /api/subjects/:id/path {titles, after?} → { created, path } (201) */
export const planTopicsHandler = handler(async (req, res) => {
    ok(res, await planTopics(requireUser(req).id, param(req, 'id'), parse(planSchema, req.body)), 201);
});

/** PATCH /api/topics/:id/path {title?, status?, nextStep?, after?} → { topic, path } */
export const updateTopicOnPathHandler = handler(async (req, res) => {
    ok(res, await updateTopicOnPath(requireUser(req).id, param(req, 'id'), parse(topicPathSchema, req.body)));
});
