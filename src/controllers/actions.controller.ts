// POST /api/actions (level 3, MANAGER_AND_DOCS_PLAN §3.2): an agent or the manager asks for an
// action that needs Ramin's tap; it is checked and kept as a pending suggestion (Home → Suggested,
// "Do it"). Accepting it (POST /api/suggestions/:id/accept, cookie only) runs it.
import { z } from 'zod';
import { isTokenRequest, requireUser } from '../middlwares/auth';
import { agentActor } from '../services/agent/agentEditLog';
import { requestAction } from '../services/actions/actions.service';
import { serializeSuggestion } from '../services/learningDb/suggestions.service';
import { handler, ok, parse } from './learning/common';

const actionSchema = z.object({
    action: z.string().trim().min(1).max(60),
    input: z.record(z.string(), z.unknown()).optional(),
    reason: z.string().max(200).nullable().optional(),
});

/** → 201 the pending suggestion { _id, kind: 'action', text, … } */
export const requestActionHandler = handler(async (req, res) => {
    const body = parse(actionSchema, req.body);
    const user = requireUser(req);
    // An action is an agent's request for his tap; from the app itself there is nothing to ask.
    if (!isTokenRequest(req)) return void res.status(400).json({ success: false, message: 'Actions are asked for by agents; in the app, do it yourself' });
    const agentName = agentActor(req).agentName;
    ok(res, serializeSuggestion(await requestAction(user.id, agentName, body)), 201);
});
