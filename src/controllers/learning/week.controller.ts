// The week and suggestions (LOOP_COMPLETE_SPEC 1.6). Thin: validate, call the service.
// Tokens: GET /api/week, POST/PATCH /api/week/targets, GET/POST /api/suggestions
// (src/services/apiTokens/tokenRoutes.ts). Accepting or dismissing a suggestion is the app's only.
import { z } from 'zod';
import { isTokenRequest, requireUser } from '../../middlwares/auth';
import { agentActor } from '../../services/agent/agentEditLog';
import { WEEK_MEASURES, WEEK_TARGET_STATUSES, addWeekTarget, getWeek, updateWeekTarget } from '../../services/learningDb/week.service';
import { SUGGESTION_KINDS, acceptSuggestion, decideSuggestions, dismissSuggestion, listSuggestions, proposeSuggestion } from '../../services/learningDb/suggestions.service';
import { handler, ok, param, parse, zDay, zId } from './common';

const zTarget = z
    .object({
        text: z.string().trim().min(1).max(400),
        weekStart: zDay.optional(),
        topicId: zId.nullable().optional(),
        milestoneId: zId.nullable().optional(),
        todoId: zId.nullable().optional(),
        measure: z.enum(WEEK_MEASURES).nullable().optional(),
        amount: z.number().int().min(1).max(10_000).nullable().optional(),
        subjectId: zId.nullable().optional(),
        projectId: zId.nullable().optional(),
    })
    .strict();

const zTargetPatch = z
    .object({
        text: z.string().trim().min(1).max(400).optional(),
        status: z.enum(WEEK_TARGET_STATUSES).optional(),
        sortOrder: z.number().int().min(0).max(100).optional(),
    })
    .strict()
    .refine((p) => Object.keys(p).length > 0, 'Send text, status or sortOrder');

/** GET /api/week?start=<any day of the week> → the week, its targets, last week, the review */
export const getWeekHandler = handler(async (req, res) => {
    const start = typeof req.query['start'] === 'string' ? req.query['start'] : undefined;
    ok(res, await getWeek(requireUser(req).id, { start }));
});

/** POST /api/week/targets → the target (201) */
export const addWeekTargetHandler = handler(async (req, res) => {
    ok(res, await addWeekTarget(requireUser(req).id, parse(zTarget, req.body)), 201);
});

/** PATCH /api/week/targets/:id → the target */
export const updateWeekTargetHandler = handler(async (req, res) => {
    ok(res, await updateWeekTarget(requireUser(req).id, param(req, 'id'), parse(zTargetPatch, req.body)));
});

const zSuggestion = z
    .object({
        kind: z.enum(SUGGESTION_KINDS),
        text: z.string().trim().min(1).max(400),
        reason: z.string().max(400).nullable().optional(),
        payload: z.record(z.string(), z.unknown()),
    })
    .strict();

/** GET /api/suggestions?status=pending|accepted|dismissed */
export const listSuggestionsHandler = handler(async (req, res) => {
    const status = z.enum(['pending', 'accepted', 'dismissed']).optional().parse(req.query['status'] || undefined);
    ok(res, await listSuggestions(requireUser(req).id, { status }));
});

/** POST /api/suggestions → the suggestion (201). An agent proposes; the app may too. */
export const proposeSuggestionHandler = handler(async (req, res) => {
    const input = parse(zSuggestion, req.body);
    const agentName = isTokenRequest(req) ? agentActor(req).agentName : null;
    ok(res, await proposeSuggestion(requireUser(req).id, agentName, input), 201);
});

/** POST /api/suggestions/:id/accept (the app only) */
export const acceptSuggestionHandler = handler(async (req, res) => {
    ok(res, await acceptSuggestion(requireUser(req).id, param(req, 'id')));
});

/** POST /api/suggestions/:id/dismiss (the app only) */
export const dismissSuggestionHandler = handler(async (req, res) => {
    ok(res, await dismissSuggestion(requireUser(req).id, param(req, 'id')));
});

const zDecide = z.object({ accept: z.array(zId).max(20).optional(), dismiss: z.array(zId).max(50).optional() }).strict();

/** POST /api/suggestions/decide { accept, dismiss } (the app only): "Accept all", "Skip this week" */
export const decideSuggestionsHandler = handler(async (req, res) => {
    ok(res, await decideSuggestions(requireUser(req).id, parse(zDecide, req.body)));
});
