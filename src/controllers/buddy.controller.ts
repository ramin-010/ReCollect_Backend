// The buddy (BUDDY_MEMORY_PLAN §7). Thin: validate, call the services in src/services/buddy/.
// Token access per route is decided by authMiddleware (src/services/apiTokens/tokenRoutes.ts); the
// router states the same rules (requireScope / cookieOnly).
import { z } from 'zod';
import { isTokenRequest, requireUser } from '../middlwares/auth';
import { agentActor } from '../services/agent/agentEditLog';
import {
    LIST_LIMIT_MAX,
    MEMORY_KINDS,
    MEMORY_STATUSES,
    MEMORY_TEXT_MAX,
    TAG_MAX,
    TAGS_MAX,
    closeMemoryByAgent,
    createMemoryByUser,
    deleteMemory,
    exportBuddy,
    FEEDBACK_TARGETS,
    TELL_MAX,
    feedback,
    tellBuddy,
    listMemories,
    memoryCounts,
    rememberNotes,
    updateMemoryByUser,
} from '../services/buddy/memory.service';
import { BUDDY_NAME_MAX, BUDDY_TONES, MAX_BUDDY_CAP_USD, buddySettings, updateBuddySettings } from '../services/buddy/state.service';
import { WORDS_PER_CHUNK, queueWords } from '../services/buddy/capture.service';
import { buddyUsage } from '../services/buddy/spend';
import { listRoutines, setRoutineEnabled } from '../services/buddy/routines';
import { answerQuestion } from '../services/buddy/chapter';
import { prisma } from '../db/prisma';
import { currentLine, latestStep, nextNoteFor } from '../services/buddy/voice';
import { nightIfDue } from '../services/buddy/worker';
import { buddyMaySpend } from '../services/buddy/spend';
import { fromDbDay } from '../services/learningDb/common';
import ErrorResponse from '../utils/errorResponse';
import { handler, ok, param, parse } from './learning/common';

const zKind = z.enum(MEMORY_KINDS);
// Longer texts are accepted and cut at a word (an agent's long note still lands).
const zText = z.string().trim().min(1).max(MEMORY_TEXT_MAX * 4);
const zTags = z.array(z.string().trim().min(1).max(TAG_MAX * 2)).max(TAGS_MAX);

/** One note, as remember sends it. */
export const zNote = z.object({ text: zText, kind: zKind.optional(), private: z.boolean().optional(), tags: zTags.optional() }).strict();
/** Checkpoint's learned: an empty note is skipped (counted), never a reason to refuse the session. */
export const zLearnedNote = zNote.extend({ text: z.string().max(MEMORY_TEXT_MAX * 4) });

/** POST /api/buddy/remember {text, kind?, private?, tags?, sessionKey?, project?} → { paused, notes } */
export const rememberHandler = handler(async (req, res) => {
    const input = parse(zNote.extend({ sessionKey: z.string().trim().max(80).optional(), project: z.string().trim().max(200).optional() }).strict(), req.body);
    const user = requireUser(req);
    const token = isTokenRequest(req);
    const result = await rememberNotes(
        {
            userId: user.id,
            source: token ? 'agent' : 'app',
            agentName: token ? agentActor(req).agentName : null,
            sessionKey: input.sessionKey ?? null,
            project: input.project ?? null,
        },
        [{ text: input.text, kind: input.kind, private: input.private, tags: input.tags }]
    );
    ok(res, result, result.notes[0]?.status === 'saved' ? 201 : 200);
});

/** GET /api/buddy/memories?q=&kind=&status=active|faded|closed|wrong|all&limit= */
export const listMemoriesHandler = handler(async (req, res) => {
    const q = parse(
        z.object({
            q: z.string().max(200).optional(),
            kind: zKind.optional(),
            status: z.enum([...MEMORY_STATUSES, 'all']).optional(),
            limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
        }),
        req.query
    );
    ok(res, await listMemories(requireUser(req).id, { q: q.q, kind: q.kind, status: q.status === 'active' ? 'mind' : q.status, limit: q.limit }));
});

/** POST /api/buddy/memories (the app: a memory he writes) → 201 the memory */
export const createMemoryHandler = handler(async (req, res) => {
    const input = parse(z.object({ text: zText, kind: zKind, private: z.boolean().optional(), tags: zTags.optional(), lasting: z.boolean().optional(), pinned: z.boolean().optional() }).strict(), req.body);
    ok(res, await createMemoryByUser(requireUser(req).id, input), 201);
});

/** PATCH /api/buddy/memories/:id (the app: edit, pin, private, wrong, closed, back) */
export const updateMemoryHandler = handler(async (req, res) => {
    const patch = parse(
        z
            .object({
                text: zText.optional(),
                kind: zKind.optional(),
                private: z.boolean().optional(),
                pinned: z.boolean().optional(),
                lasting: z.boolean().optional(),
                tags: zTags.optional(),
                status: z.enum(['active', 'wrong', 'closed']).optional(),
            })
            .strict()
            .refine((p) => Object.keys(p).length > 0, 'Send what changes'),
        req.body
    );
    ok(res, await updateMemoryByUser(requireUser(req).id, param(req, 'id'), patch));
});

/** DELETE /api/buddy/memories/:id (the app: forget for good, the notes behind it too) */
export const deleteMemoryHandler = handler(async (req, res) => {
    ok(res, await deleteMemory(requireUser(req).id, param(req, 'id')));
});

/** POST /api/buddy/memories/:id/close {reason?} (an agent's forget: closed, logged with Undo) → { memory, editId } */
export const closeMemoryHandler = handler(async (req, res) => {
    const input = parse(z.object({ reason: z.string().trim().max(400).optional() }).strict(), req.body);
    ok(res, await closeMemoryByAgent(agentActor(req), param(req, 'id'), input.reason));
});

/** GET /api/buddy/settings → settings + the memory counts */
export const getSettingsHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const [settings, counts] = await Promise.all([buddySettings(userId), memoryCounts(userId)]);
    ok(res, { ...settings, counts });
});

/** PATCH /api/buddy/settings {enabled?, paused?, name?, tone?, capUsd?} */
export const patchSettingsHandler = handler(async (req, res) => {
    const patch = parse(
        z
            .object({
                enabled: z.boolean().optional(),
                paused: z.boolean().optional(),
                name: z.string().max(BUDDY_NAME_MAX * 2).nullable().optional(),
                tone: z.enum(BUDDY_TONES).optional(),
                capUsd: z.number().min(0).max(MAX_BUDDY_CAP_USD).optional(),
            })
            .strict()
            .refine((p) => Object.keys(p).length > 0, 'Send what changes'),
        req.body
    );
    ok(res, await updateBuddySettings(requireUser(req).id, patch));
});

/** GET /api/buddy/you → what /you draws: settings, counts and every memory (newest first, at most 500) */
export const youHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const [settings, counts, memories, routines, chapters] = await Promise.all([
        buddySettings(userId),
        memoryCounts(userId),
        listMemories(userId, { status: 'all', limit: LIST_LIMIT_MAX }),
        listRoutines(userId),
        prisma.buddyChapter.findMany({ where: { userId }, orderBy: { period: 'desc' }, take: 24, select: { id: true, period: true, text: true, questions: true } }),
    ]);
    ok(res, { settings, counts, memories, routines, chapters: chapters.map((c) => ({ _id: c.id, period: c.period, text: c.text, questions: c.questions })) });
});

/** POST /api/buddy/words {sessionKey, seq, project?, messages} (the hooks) → 202 { queued } */
export const wordsHandler = handler(async (req, res) => {
    const input = parse(
        z
            .object({
                sessionKey: z.string().trim().min(1).max(80),
                seq: z.number().int().min(0).max(1_000_000),
                project: z.string().trim().max(200).nullable().optional(),
                messages: z
                    .array(z.object({ at: z.string().max(40).optional(), text: z.string().max(20_000), reply: z.string().max(4000).optional() }).strict())
                    .min(1)
                    .max(WORDS_PER_CHUNK),
            })
            .strict(),
        req.body
    );
    ok(res, await queueWords(requireUser(req).id, input), 202);
});

/** GET /api/buddy/note?after=<id> (the hooks, the phone app): the buddy's newest note for a chat, or 204 */
export const noteHandler = handler(async (req, res) => {
    const q = parse(z.object({ after: z.string().max(80).optional() }), req.query);
    const note = await nextNoteFor(requireUser(req).id, q.after);
    if (!note) {
        res.status(204).end();
        return;
    }
    ok(res, note);
});

/** GET /api/buddy/usage → this month's spend and cap, and the last 30 days (counts and cost, never words) */
export const usageHandler = handler(async (req, res) => {
    ok(res, await buddyUsage(requireUser(req).id));
});

/** POST /api/buddy/think (the app): think now (the night step again today). */
export const thinkHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const may = await buddyMaySpend(userId);
    if (may !== 'ok') throw new ErrorResponse(409, may === 'off' ? 'Turn your buddy on first' : may === 'paused' ? 'Your buddy is paused' : may === 'no_ai' ? 'The AI is not set up' : 'Your buddy has reached its monthly cap');
    ok(res, await nightIfDue(userId, new Date(), { fresh: true }));
});

/** GET /api/buddy/today (the app): the current line, the day's three lines, the note and the follow-up. */
export const todayHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const [step, line, settings] = await Promise.all([latestStep(userId), currentLine(userId), buddySettings(userId)]);
    const row = step.row && !step.stale ? step.row : null;
    ok(res, {
        enabled: settings.enabled,
        paused: settings.paused,
        name: settings.name,
        slot: step.slot,
        line,
        day: row ? { _id: row.id, day: fromDbDay(row.day), kind: row.kind, lines: row.lines, note: row.note, followUp: row.followUp, createdAt: row.createdAt.toISOString() } : null,
    });
});

/** POST /api/buddy/tell {text} (the app, the phone app): straight in as a note for tonight */
export const tellHandler = handler(async (req, res) => {
    const input = parse(z.object({ text: z.string().trim().min(1).max(TELL_MAX) }).strict(), req.body);
    ok(res, await tellBuddy(requireUser(req).id, input.text), 201);
});

/** POST /api/buddy/feedback {buddyDayId, target, verdict} (the app, the phone app): a thumb */
export const feedbackHandler = handler(async (req, res) => {
    const input = parse(z.object({ buddyDayId: z.string().trim().min(1).max(64), target: z.enum(FEEDBACK_TARGETS), verdict: z.enum(['more', 'less']) }).strict(), req.body);
    ok(res, await feedback(requireUser(req).id, input), 201);
});

/** PATCH /api/buddy/routines/:id {enabled} (the app): a routine's switch */
export const routineHandler = handler(async (req, res) => {
    const input = parse(z.object({ enabled: z.boolean() }).strict(), req.body);
    ok(res, await setRoutineEnabled(requireUser(req).id, param(req, 'id'), input.enabled));
});

/** POST /api/buddy/questions {memoryId, answer: yes|no} (the app): his answer to a chapter's "Still true?" */
export const questionHandler = handler(async (req, res) => {
    const input = parse(z.object({ memoryId: z.string().trim().min(1).max(64), answer: z.enum(['yes', 'no']) }).strict(), req.body);
    ok(res, await answerQuestion(requireUser(req).id, input.memoryId, input.answer));
});

/** GET /api/buddy/export → everything as JSON (a file download) */
export const exportHandler = handler(async (req, res) => {
    const data = await exportBuddy(requireUser(req).id);
    res.setHeader('Content-Disposition', `attachment; filename="recollect-buddy-${data.exportedAt.slice(0, 10)}.json"`);
    ok(res, data);
});
