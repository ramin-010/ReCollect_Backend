// GET /api/brief (SYNC_SPINE_SPEC 1.3): where the user stands, in one call (any token with read).
import { z } from 'zod';
import { requireUser } from '../../middlwares/auth';
import { getBrief } from '../../services/brief/brief.service';
import { SESSION_KEY_RE } from '../../services/learningDb/sessions.service';
import { handler, ok, parse } from './common';

const zBrief = z.object({
    project: z.string().trim().min(1).max(200).optional(),
    key: z.string().regex(SESSION_KEY_RE, 'a session key is 1 to 80 letters, digits, _ . : or -').optional(),
    /** A work folder (BUDDY_MEMORY_PLAN §4.3): his goals, profile, plan and the buddy stay out. */
    work: z.enum(['1', 'true']).optional(),
});

/** GET /api/brief?project=&key= → the brief (see services/brief/brief.service.ts) */
export const getBriefHandler = handler(async (req, res) => {
    const q = parse(zBrief, req.query);
    ok(res, await getBrief(requireUser(req).id, { project: q.project, key: q.key, work: !!q.work }));
});
