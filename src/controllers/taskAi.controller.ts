// POST /api/todos/ai/generate: the `@ai` task line (LOOP_COMPLETE_SPEC 4.1). The fields come from the
// Claude client on Haiku 5.5 (services/tasks/taskAi.service.ts); when that fails the line is kept as a
// plain task (provider "plain"), so the answer is always 200 for a valid line.
import { Request, Response, NextFunction } from 'express';
import { requireUser } from '../middlwares/auth';
import { generateTaskLine } from '../services/tasks/taskAi.service';

const people = (value: unknown): Array<{ name: string; email: string }> =>
    Array.isArray(value)
        ? value
              .filter((m): m is { name?: unknown; email?: unknown } => !!m && typeof m === 'object')
              .filter((m) => typeof m.email === 'string')
              .map((m) => ({ name: typeof m.name === 'string' ? m.name : '', email: String(m.email) }))
        : [];

export const generateTaskContent = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { prompt, workspaceMembers, availableTags, preSelectedAssignees } = req.body ?? {};
        if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
            return res.status(400).json({ message: 'A prompt is required.' });
        }
        const user = requireUser(req);
        const out = await generateTaskLine(user.id, {
            prompt,
            workspaceMembers: people(workspaceMembers),
            availableTags: Array.isArray(availableTags) ? availableTags.filter((t): t is string => typeof t === 'string') : [],
            preSelectedAssignees: people(preSelectedAssignees),
        });
        const { provider, ...data } = out;
        return res.status(200).json({ success: true, data, provider });
    } catch (err) {
        next(err);
    }
};
