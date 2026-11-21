// GET /api/brief (SYNC_SPINE_SPEC 1.3): where the user stands, in one call (any token with read).
import { z } from 'zod';
import { isTokenRequest, requireUser } from '../../middlwares/auth';
import { queueRelayedWords } from '../../services/buddy/capture.service';
import { getBrief } from '../../services/brief/brief.service';
import { buddyView } from '../../services/buddy/record.service';
import { SESSION_KEY_RE } from '../../services/learningDb/sessions.service';
import { handler, ok, parse } from './common';

const zBrief = z.object({
    project: z.string().trim().min(1).max(200).optional(),
    key: z.string().regex(SESSION_KEY_RE, 'a session key is 1 to 80 letters, digits, _ . : or -').optional(),
    /** A work folder (BUDDY_MEMORY_PLAN §4.3): his goals, profile, plan and the buddy stay out. */
    work: z.enum(['1', 'true']).optional(),
    /** Stage 8 (E3): what this chat is for, in his words, passed on by the agent (never from a work folder). */
    about: z.string().trim().max(300).optional(),
    /** MCP_MEMORY_PLAN §4.6: the small buddy brief the web's get_brief returns. */
    view: z.enum(['buddy']).optional(),
});

/** GET /api/brief?project=&key= → the brief (see services/brief/brief.service.ts) */
export const getBriefHandler = handler(async (req, res) => {
    const q = parse(zBrief, req.query);
    const userId = requireUser(req).id;
    if (q.view === 'buddy') return ok(res, await buddyView(userId));
    // An agent's brief reads the buddy's open questions (and marks them shown there); the app's own uses don't.
    const brief = await getBrief(userId, { project: q.project, key: q.key, work: !!q.work, asks: true });
    // E3: his words about this chat, for his buddy: only from a token that may write sessions, never at work.
    if (q.about && !q.work && (!isTokenRequest(req) || req.auth?.scopes?.includes('sessions:write'))) await queueRelayedWords(userId, brief.session.key, [q.about]);
    ok(res, brief);
});
