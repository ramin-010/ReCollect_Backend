// Practice notes and the weekly coach (HOME_DOCS_AGENT_PLAN §4, Phase D2 / D3), under /api/ai.
// Thin: validate, call the service, answer { success: true, data }. Errors are
// { success: false, code, message } (AiHttpError), like the rest of the AI routes.
import type { Request } from 'express';
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { handler, ok } from './learning/common';
import { parse } from './recall.controller';
import { createPracticeNote } from '../services/practice/practice.service';
import { generateCoachNote, latestCoachNote } from '../services/coach/coach.service';

const zId = z.string().trim().min(1).max(128);

const practiceNoteSchema = z
    .object({
        problem: z.string().trim().min(1).max(4000),
        solution: z
            .string()
            .max(20000)
            .refine((s) => s.trim().length > 0, { message: 'The solution is empty' }),
        language: z.string().trim().max(40).nullish(),
        struggles: z.string().trim().max(2000).nullish(),
        subjectId: zId.nullish(),
        revise: z.boolean().nullish(),
    })
    .refine((b) => !b.revise || !!b.subjectId, { message: 'revise needs a subjectId (the subject to revise it under)' });

/** POST /api/ai/practice-note { problem, solution, language?, struggles?, subjectId?, revise? } → 201 { docId, title, topicId, nextRevision } */
export const practiceNote = handler(async (req, res) => {
    const body = parse(practiceNoteSchema, req.body);
    ok(res, await createPracticeNote(requireUser(req).id, body), 201);
});

/** `?fresh=1` (or true) */
const isFresh = (req: Request): boolean => ['1', 'true'].includes(String(req.query['fresh'] ?? '').toLowerCase());

/** POST /api/ai/coach[?fresh=1] → 201 a new CoachNote, or 200 the one already written today */
export const coach = handler(async (req, res) => {
    const { note, created } = await generateCoachNote(requireUser(req).id, { fresh: isFresh(req) });
    ok(res, note, created ? 201 : 200);
});

/** GET /api/ai/coach → the latest CoachNote, or null */
export const latestCoach = handler(async (req, res) => {
    ok(res, await latestCoachNote(requireUser(req).id));
});
