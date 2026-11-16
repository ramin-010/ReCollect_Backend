// Recall mode and the AI spend meter (HOME_DOCS_AGENT_PLAN §4). Thin: validate, call the service,
// answer { success: true, data }. Errors are { success: false, code, message } (AiHttpError).
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { handler, ok } from './learning/common';
import { aiBadRequest, aiNotConfigured } from '../services/claude/errors';
import { isAiConfigured } from '../services/claude/client';
import { aiUsageFor, MAX_MONTHLY_CAP_USD, setMonthlyCap } from '../services/claude/usage.service';
import { ownerEmail } from '../config/owner';
import { awakeSummary } from '../services/scheduler/awake';
import { answerRecall, finishRecall, startRecall } from '../services/recall/recall.service';

/** Parse with zod; the first issue becomes a 400 INVALID_INPUT (AiHttpError). Also used by ./aiNotes.controller.ts. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
    const result = schema.safeParse(value ?? {});
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw aiBadRequest(`${path}${issue?.message ?? 'Invalid input'}`);
}

function idParam(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 128) throw aiBadRequest('Missing id');
    return value;
}

/** Every AI route: 503 AI_NOT_CONFIGURED while CLAUDE_API_KEY is missing. */
export const requireAiConfigured: RequestHandler = (_req, _res, next) => (isAiConfigured() ? next() : next(aiNotConfigured()));

const zId = z.string().trim().min(1).max(128);

const startSchema = z.object({ revisionId: zId });

/** POST /api/recall/start { revisionId } → RecallSet */
export const start = handler(async (req, res) => {
    const { revisionId } = parse(startSchema, req.body);
    ok(res, await startRecall(requireUser(req).id, revisionId));
});

const answerSchema = z
    .object({
        questionId: z.string().trim().min(1).max(20),
        answer: z.string().max(4000).optional(),
        selfMark: z.enum(['knew', 'didnt']).optional(),
    })
    .refine((b) => (b.selfMark ? 1 : 0) + (b.answer?.trim() ? 1 : 0) === 1, { message: 'Send either an answer or a selfMark' });

/** POST /api/recall/sets/:id/answer { questionId, answer? | selfMark? } → RecallAttempt */
export const answer = handler(async (req, res) => {
    const body = parse(answerSchema, req.body);
    ok(res, await answerRecall(requireUser(req).id, idParam(req.params.id), body));
});

/** POST /api/recall/sets/:id/finish → RecallOutcome */
export const finish = handler(async (req, res) => {
    ok(res, await finishRecall(requireUser(req).id, idParam(req.params.id)));
});

/** GET /api/ai/usage → AiUsage (this local month) */
export const usage = handler(async (req, res) => {
    const user = requireUser(req);
    const usage = await aiUsageFor(user.id);
    // The database's awake hours this month (hosting P1-15, quiet mode only), for the owner's eyes.
    const owner = ownerEmail();
    const awake = !owner || user.email.trim().toLowerCase() === owner ? awakeSummary() : null;
    ok(res, awake ? { ...usage, awake } : usage);
});

const settingsSchema = z.object({ capUsd: z.number().finite().min(0).max(MAX_MONTHLY_CAP_USD) });

/** PATCH /api/ai/settings { capUsd } (0–1000) → AiUsage */
export const settings = handler(async (req, res) => {
    const { capUsd } = parse(settingsSchema, req.body);
    ok(res, await setMonthlyCap(requireUser(req).id, capUsd));
});
