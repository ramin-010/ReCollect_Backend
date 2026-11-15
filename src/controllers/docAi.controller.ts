// POST /api/docs/ai/generate: the old "Ask AI to write" (Groq / Gemini / Cohere) is gone
// (LOOP_COMPLETE_SPEC 4.1, ECOSYSTEM_PLAN change 11). Docs that still hold its node load fine; the node
// and its view leave with the old editor (stage 5). Ask AI comes back on the tool catalogue (stage 4).
import { Request, Response } from 'express';

export const generateDocContent = (_req: Request, res: Response) => {
    res.status(410).json({ message: 'Ask AI to write was removed. Ask AI comes back as the manager, on the same tools as your agents.' });
};
