// GET /api/mirror (LOOP_COMPLETE_SPEC 1.7): where the user stands per goal and subject, numbers by code.
import { requireUser } from '../../middlwares/auth';
import { getMirror } from '../../services/mirror/mirror.service';
import { handler, ok } from './common';

export const getMirrorHandler = handler(async (req, res) => {
    ok(res, await getMirror(requireUser(req).id));
});
