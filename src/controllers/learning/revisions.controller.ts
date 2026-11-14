// GET /api/today, ensure-today and the revision endpoints (#1, #2, #4–7). Thin: validate, call
// the learningDb service, wrap in { success, data }. Settings (#3) live in loop.controller.ts.
import { z } from 'zod';
import { isTokenRequest, requireUser } from '../../middlwares/auth';
import { getToday } from '../../services/learningDb/today.service';
import { ensureTodayForUser } from '../../services/learningDb/rollover.service';
import {
    completeRevisionForUser,
    rescheduleRevisionForUser,
    startItemRevisions,
    uncompleteRevisionForUser,
} from '../../services/learningDb/revisions.service';
import { handler, ok, param, parse, zDay, zId } from './common';

/** #1 (zero writes). Agents (access tokens) never get the pocket notes: they are private. */
export const today = handler(async (req, res) => {
    const data = await getToday(requireUser(req).id);
    if (isTokenRequest(req)) {
        const { quickNotes: _private, ...forAgents } = data;
        return ok(res, forAgents);
    }
    ok(res, data);
});

/** #2: the rollover if the day changed, and the app is marked seen today (lastSeenDay, LOOP_V2_SPEC §1). */
export const ensureToday = handler(async (req, res) => {
    const { rolledOver, days } = await ensureTodayForUser(requireUser(req).id);
    ok(res, { rolledOver, days });
});

const startSchema = z.union([z.object({ topicId: zId }).strict(), z.object({ captureId: zId }).strict()]);

/** #4 */
export const start = handler(async (req, res) => {
    const body = parse(startSchema, req.body);
    ok(res, await startItemRevisions(requireUser(req).id, 'topicId' in body ? { topicId: body.topicId } : { captureId: body.captureId }), 201);
});

/** #5 */
export const complete = handler(async (req, res) => {
    ok(res, await completeRevisionForUser(requireUser(req).id, param(req, 'id')));
});

/** #6 */
export const uncomplete = handler(async (req, res) => {
    ok(res, await uncompleteRevisionForUser(requireUser(req).id, param(req, 'id')));
});

const rescheduleSchema = z.object({ day: zDay });

/** #7 */
export const reschedule = handler(async (req, res) => {
    const { day } = parse(rescheduleSchema, req.body);
    ok(res, await rescheduleRevisionForUser(requireUser(req).id, param(req, 'id'), day));
});
