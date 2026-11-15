// The decision journal (LOOP_COMPLETE_SPEC 4.2). Thin: validate, call the service.
import { z } from 'zod';
import { requireUser } from '../../middlwares/auth';
import { DECISION_STATUSES, DECISION_VERDICTS, createDecision, listDecisions, updateDecision } from '../../services/learningDb/decisions.service';
import { handler, ok, param, parse, zId } from './common';

/** GET /api/decisions?status=open|reviewed&project=&due=1 */
export const listDecisionsHandler = handler(async (req, res) => {
    const q = parse(z.object({ status: z.enum(DECISION_STATUSES).optional(), project: z.string().trim().max(200).optional(), due: z.enum(['1', 'true']).optional() }), req.query);
    ok(res, await listDecisions(requireUser(req).id, { status: q.status, project: q.project, due: !!q.due }));
});

/** POST /api/decisions (201) */
export const createDecisionHandler = handler(async (req, res) => {
    const input = parse(
        z
            .object({
                title: z.string().trim().min(1).max(400),
                why: z.string().trim().min(1).max(1200),
                expect: z.string().max(800).nullable().optional(),
                lookAgain: z.string().trim().min(2).max(20),
                subjectId: zId.nullable().optional(),
                project: z.string().trim().max(200).nullable().optional(),
            })
            .strict(),
        req.body
    );
    ok(res, await createDecision(requireUser(req).id, input), 201);
});

/** PATCH /api/decisions/:id: change it, look again later, or answer "Was this right?" */
export const updateDecisionHandler = handler(async (req, res) => {
    const patch = parse(
        z
            .object({
                title: z.string().trim().min(1).max(400).optional(),
                why: z.string().trim().min(1).max(1200).optional(),
                expect: z.string().max(800).nullable().optional(),
                lookAgain: z.string().trim().min(2).max(20).optional(),
                verdict: z.enum(DECISION_VERDICTS).optional(),
                verdictNote: z.string().max(800).nullable().optional(),
            })
            .strict()
            .refine((p) => Object.keys(p).length > 0, 'Send what changes'),
        req.body
    );
    ok(res, await updateDecision(requireUser(req).id, param(req, 'id'), patch));
});
