// TOOL_ACCESS_PLAN §12.4 (11-27): what an AI added, it can take back or correct (agentLifecycle.service.ts).
// Thin: validate with zod, call the service.
import { z } from 'zod';
import { agentActor } from '../services/agent/agentEditLog';
import {
    deleteDecisionForAgent,
    deleteSessionForAgent,
    deleteTaskForAgent,
    removeTopicForAgent,
    stopRevisionForAgent,
    uncompleteRevisionForAgent,
    updateSessionForAgent,
} from '../services/agent/agentLifecycle.service';
import { MINUTES_MAX } from '../services/learningDb/sessions.service';
import { handler, ok, param, parse } from './learning/common';

/** POST /api/agent/tasks/:id/delete */
export const deleteTask = handler(async (req, res) => {
    ok(res, await deleteTaskForAgent(agentActor(req), param(req, 'id')));
});

/** POST /api/agent/decisions/:id/delete */
export const deleteDecision = handler(async (req, res) => {
    ok(res, await deleteDecisionForAgent(agentActor(req), param(req, 'id')));
});

/** POST /api/agent/topics/:id/remove { reason? } */
export const removeTopic = handler(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().max(200).nullable().optional() }).strict(), req.body ?? {});
    ok(res, await removeTopicForAgent(agentActor(req), param(req, 'id'), { reason }));
});

/** POST /api/agent/docs/:id/stop-revision */
export const stopRevision = handler(async (req, res) => {
    ok(res, await stopRevisionForAgent(agentActor(req), param(req, 'id')));
});

/** POST /api/agent/revisions/:id/uncomplete */
export const uncompleteRevision = handler(async (req, res) => {
    ok(res, await uncompleteRevisionForAgent(agentActor(req), param(req, 'id')));
});

const sessionPatch = z
    .object({
        minutes: z.number().int().min(0).max(MINUTES_MAX).optional(),
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        kind: z.enum(['study', 'practice', 'build', 'review']).optional(),
    })
    .strict()
    .refine((p) => Object.keys(p).length > 0, 'Send what changes: minutes, day, title or kind');

/** PATCH /api/agent/sessions/:id { minutes?, day?, title?, kind? } */
export const updateSession = handler(async (req, res) => {
    ok(res, await updateSessionForAgent(agentActor(req), param(req, 'id'), parse(sessionPatch, req.body)));
});

/** POST /api/agent/sessions/:id/delete */
export const deleteSession = handler(async (req, res) => {
    ok(res, await deleteSessionForAgent(agentActor(req), param(req, 'id')));
});
