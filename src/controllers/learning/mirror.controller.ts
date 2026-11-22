// GET /api/mirror (LOOP_COMPLETE_SPEC 1.7): where the user stands per goal and subject, numbers by code.
import { requireUser } from '../../middlwares/auth';
import { getMirror } from '../../services/mirror/mirror.service';
import { getStand } from '../../services/mirror/stand.service';
import { askStandTake, isStandWindow, standTakes } from '../../services/mirror/standTake.service';
import { aiBadRequest } from '../../services/claude/errors';
import { handler, ok } from './common';

export const getMirrorHandler = handler(async (req, res) => {
    ok(res, await getMirror(requireUser(req).id));
});

// GET /api/mirror/stand (WHERE_YOU_STAND_PLAN §5.5): the record of the last week, month and year against the span before.
export const getStandHandler = handler(async (req, res) => {
    ok(res, await getStand(requireUser(req).id));
});

// GET /api/mirror/stand/takes (§9): today's takes by the buddy, and whether it can be asked now.
export const getStandTakesHandler = handler(async (req, res) => {
    ok(res, await standTakes(requireUser(req).id));
});

// POST /api/mirror/stand/takes {window} (§9): the buddy's take on that window, today's or a new one.
export const askStandTakeHandler = handler(async (req, res) => {
    const window: unknown = (req.body as { window?: unknown } | undefined)?.window;
    if (!isStandWindow(window)) throw aiBadRequest('window must be week, month or year');
    ok(res, await askStandTake(requireUser(req).id, window));
});
