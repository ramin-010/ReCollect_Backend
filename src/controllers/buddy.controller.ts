// The buddy (BUDDY_MEMORY_PLAN §7). Thin: validate, call the services in src/services/buddy/.
// Token access per route is decided by authMiddleware (src/services/apiTokens/tokenRoutes.ts); the
// router states the same rules (requireScope / cookieOnly).
import { answerAsk, openAsks } from '../services/buddy/asks';
import { aiAccessFor, aiPaused, aiWaitError } from '../services/claude/access';
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
    LINE_KEY,
    TELL_MAX,
    feedback,
    tellBuddy,
    listMemories,
    memoryCounts,
    cleanNoteText,
    rememberNotes,
    updateMemoryByUser,
    withChains,
} from '../services/buddy/memory.service';
import { dayNewsTarget, inMotionOf, markMayReplace, relatedTo, updateRecord } from '../services/buddy/record.service';
import { UPDATE_KINDS } from '../services/buddy/recordRules';
import { BUDDY_NAME_MAX, BUDDY_TONES, MAX_BUDDY_CAP_USD, buddySettings, updateBuddySettings } from '../services/buddy/state.service';
import { WORDS_PER_CHUNK, earMeter, queueWords } from '../services/buddy/capture.service';
import { buddyUsage } from '../services/buddy/spend';
import { listRoutines, setRoutineEnabled } from '../services/buddy/routines';
import { answerQuestion, searchChapters } from '../services/buddy/chapter';
import { addThreadByUser, forgetThread, searchThreads, threadDetail, updateThreadByUser } from '../services/buddy/threads';
import { prisma } from '../db/prisma';
import { currentLine, latestStep, nextNoteFor } from '../services/buddy/voice';
import { unlabel, unlabelOr } from '../services/buddy/words';

import { nightIfDue } from '../services/buddy/worker';
import { buddyMaySpend } from '../services/buddy/spend';
import { fromDbDay } from '../services/learningDb/common';
import ErrorResponse from '../utils/errorResponse';
import { aiNotAllowed } from '../config/aiAccess';
import { handler, ok, param, parse } from './learning/common';
import { LINE_KINDS, LINE_MORE_MAX, LOG_LINES_MAX, WORK_KINDS, WORK_VIEWS, changeLine, hideWorkLine, listWork, logLine, logWork, workPicture, type WorkDoor } from '../services/buddy/work';
import { ASK_AI_AGENT } from '../services/actions/actions.service';
import { approveImport, cancelImport, estimateImport, listImports } from '../services/buddy/import.service';
import { THUMB_REASONS, endScreenRule, listScreenRules } from '../services/buddy/screens';

/** A step's stored lines with their words read through unlabel. */
const unlabelLines = (lines: unknown): unknown => (Array.isArray(lines) ? lines.map((l) => (l && typeof l === 'object' && typeof (l as { text?: unknown }).text === 'string' ? { ...l, text: unlabel((l as { text: string }).text) } : l)) : lines);

const zKind = z.enum(MEMORY_KINDS);
// Longer texts are accepted and cut at a word (an agent's long note still lands).
const zText = z.string().trim().min(1).max(MEMORY_TEXT_MAX * 4);
const zTags = z.array(z.string().trim().min(1).max(TAG_MAX * 2)).max(TAGS_MAX);

/** One note, as remember sends it. */
export const zNote = z.object({ text: zText, kind: zKind.optional(), private: z.boolean().optional(), tags: zTags.optional() }).strict();
/** Checkpoint's learned: an empty note is skipped (counted), never a reason to refuse the session. */
export const zLearnedNote = zNote.extend({ text: z.string().max(MEMORY_TEXT_MAX * 4) });

/** How a write came in (MCP_MEMORY_PLAN §4.3): a signed-in app ("connector"), a token ("agent"), or the app itself. */
function viaOf(req: Parameters<typeof requireUser>[0]): string {
    if (!isTokenRequest(req)) return 'app';
    return req.auth?.via === 'token' && req.auth.connector ? 'connector' : 'agent';
}

const zSaidOn = z.string().trim().max(20);

/**
 * POST /api/buddy/remember {text, kind?, private?, tags?, sessionKey?, project?, saidOn?, inferred?}
 * → { paused, notes, related?, inMotion? } (MCP_MEMORY_PLAN §4.2: the newest related memories and what is in motion, so an
 * assistant sees what another app saved or corrected).
 */
export const rememberHandler = handler(async (req, res) => {
    const input = parse(
        zNote.extend({ sessionKey: z.string().trim().max(80).optional(), project: z.string().trim().max(200).optional(), saidOn: zSaidOn.optional(), inferred: z.boolean().optional() }).strict(),
        req.body
    );
    const user = requireUser(req);
    const token = isTokenRequest(req);
    // One day's news about something already followed ("Got my steps in today", "Had two coffees today") is that thing's
    // day news, not a new memory, when the words leave no doubt (MCP_MEMORY_PLAN §4.3 after the live hour, §12.4 B1). The
    // person's word only; an older build (no `inferred`) keeps its path; a remark the assistant marked private is never
    // put on an open thing (privacy is never lowered by code).
    if (input.inferred === false && input.private !== true) {
        const text = cleanNoteText(input.text);
        const target = text ? await dayNewsTarget(user.id, text) : null;
        if (target) {
            const r = await updateRecord(
                { actor: agentActor(req), source: token ? 'agent' : 'app', via: viaOf(req), sessionKey: input.sessionKey ?? null, project: input.project ?? null },
                { on: target.id, update: target.update, text, saidOn: input.saidOn, inferred: false }
            );
            if (r.paused) return ok(res, { paused: true, notes: [] });
            const linked = { status: 'linked' as const, target: target.type, update: target.update, label: target.label, ...(r.thread ? { thread: r.thread } : {}), ...(r.memory ? { memory: r.memory } : {}) };
            return ok(res, { paused: false, notes: [linked], related: await relatedTo(user.id, text, [target.id]), inMotion: await inMotionOf(user.id) });
        }
    }
    const result = await rememberNotes(
        {
            userId: user.id,
            source: token ? 'agent' : 'app',
            agentName: token ? agentActor(req).agentName : null,
            sessionKey: input.sessionKey ?? null,
            project: input.project ?? null,
            via: viaOf(req),
        },
        [{ text: input.text, kind: input.kind, private: input.private, tags: input.tags, saidOn: input.saidOn, inferred: input.inferred }]
    );
    const first = result.notes[0];
    // §12.4 B2: new words of theirs that may replace one older memory: both kept, the older marked to check, named first.
    const mayReplace = input.inferred === false && first?.status === 'saved' ? await markMayReplace(user.id, first.memory) : null;
    if (mayReplace && first?.status === 'saved') result.notes[0] = { ...first, mayReplace };
    // The new tools say whose word it is: they get the lists; an older build's answer stays as it was.
    const lists =
        input.inferred !== undefined && first && first.status !== 'empty'
            ? {
                  related: await relatedTo(user.id, first.memory.text, [first.memory._id, ...(first.status === 'closed' && first.replacedBy ? [first.replacedBy._id] : []), ...(mayReplace ? [mayReplace._id] : [])]),
                  inMotion: await inMotionOf(user.id),
              }
            : {};
    ok(res, { ...result, ...lists }, first?.status === 'saved' ? 201 : 200);
});

/**
 * POST /api/buddy/update {on, update?, text, saidOn?, inferred?, sessionKey?, project?} (update_memory, §4.2):
 * progress on, a change to, or the end of something known → { paused, outcome, memory, replaced?, current?, editId?, related, inMotion }
 */
export const updateHandler = handler(async (req, res) => {
    const input = parse(
        z
            .object({
                on: z.string().trim().min(1).max(60),
                update: z.enum(UPDATE_KINDS).optional(),
                text: zText,
                saidOn: zSaidOn.optional(),
                inferred: z.boolean().optional(),
                sessionKey: z.string().trim().max(80).optional(),
                project: z.string().trim().max(200).optional(),
            })
            .strict(),
        req.body
    );
    const actor = agentActor(req);
    const token = isTokenRequest(req);
    const result = await updateRecord(
        { actor, source: token ? 'agent' : 'app', via: viaOf(req), sessionKey: input.sessionKey ?? null, project: input.project ?? null },
        { on: input.on, update: input.update ?? 'said', text: input.text, saidOn: input.saidOn, inferred: input.inferred }
    );
    if (result.paused) return ok(res, result);
    const exclude = [result.memory?._id, result.replaced?._id].filter((x): x is string => !!x);
    ok(res, { ...result, related: await relatedTo(actor.userId, input.text, exclude), inMotion: await inMotionOf(actor.userId) });
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
    const userId = requireUser(req).id;
    ok(res, await withChains(userId, await listMemories(userId, { q: q.q, kind: q.kind, status: q.status === 'active' ? 'mind' : q.status, limit: q.limit })));
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
                settle: z.literal(true).optional(),
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

/** PATCH /api/buddy/settings {enabled?, paused?, name?, tone?, capUsd?, workLog?} */
export const patchSettingsHandler = handler(async (req, res) => {
    const patch = parse(
        z
            .object({
                enabled: z.boolean().optional(),
                paused: z.boolean().optional(),
                name: z.string().max(BUDDY_NAME_MAX * 2).nullable().optional(),
                tone: z.enum(BUDDY_TONES).optional(),
                capUsd: z.number().min(0).max(MAX_BUDDY_CAP_USD).optional(),
                workLog: z.boolean().optional(),
                /** Stage 12: connected chats see what work folders logged. */
                shareOfficeWork: z.boolean().optional(),
                goalOnScreens: z.boolean().optional(),
                /** ECOSYSTEM_V2_PLAN stage 3: the loop (threads, questions, the check when words show). */
                loop: z.boolean().optional(),
                asksOn: z.boolean().optional(),
            })
            .strict()
            .refine((p) => Object.keys(p).length > 0, 'Send what changes'),
        req.body
    );
    ok(res, await updateBuddySettings(requireUser(req).id, patch));
});

/**
 * The health numbers (BUDDY_MEMORY_PLAN §3.7.5): the last 30 days (the share of memories he confirmed, his
 * thumbs, what the guards threw out), the memories by age, and the last three months (a falling thumbs
 * ratio or a rising drop rate is the sign to look at the prompts; the cost per month).
 */
async function buddyHealth(userId: string) {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [active, confirmed, more, less, steps] = await Promise.all([
        prisma.memory.count({ where: { userId, status: 'active' } }),
        prisma.memory.count({ where: { userId, status: 'active', byUser: true } }),
        prisma.buddyFeedback.count({ where: { userId, verdict: 'more', createdAt: { gte: since } } }),
        prisma.buddyFeedback.count({ where: { userId, verdict: 'less', createdAt: { gte: since } } }),
        prisma.buddyDay.findMany({ where: { userId, createdAt: { gte: since } }, select: { dropped: true } }),
    ]);
    const dropped = steps.reduce((n, s) => n + (Array.isArray(s.dropped) ? s.dropped.length : 0), 0);
    // Memories by age (their first day): this month, the two before it, older.
    const day = 86_400_000;
    const at = (days: number) => new Date(Date.now() - days * day);
    const [young, mid, old] = await Promise.all([
        prisma.memory.count({ where: { userId, status: 'active', firstSeenDay: { gte: at(30) } } }),
        prisma.memory.count({ where: { userId, status: 'active', firstSeenDay: { lt: at(30), gte: at(90) } } }),
        prisma.memory.count({ where: { userId, status: 'active', firstSeenDay: { lt: at(90) } } }),
    ]);
    // The last three calendar months: his thumbs, what the checks threw out, what the buddy cost.
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    const [fb, days, usage] = await Promise.all([
        prisma.buddyFeedback.findMany({ where: { userId, createdAt: { gte: start } }, select: { verdict: true, createdAt: true } }),
        prisma.buddyDay.findMany({ where: { userId, createdAt: { gte: start } }, select: { dropped: true, createdAt: true } }),
        prisma.aiUsage.findMany({ where: { userId, createdAt: { gte: start }, feature: { in: ['buddy_gate', 'buddy_digest', 'buddy_think', 'buddy_pulse', 'buddy_check'] } }, select: { costUsd: true, createdAt: true } }),
    ]);
    const monthOf = (d: Date) => d.toISOString().slice(0, 7);
    const months = [0, 1, 2].map((i) => {
        const month = monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
        const inMonth = <T extends { createdAt: Date }>(rows: T[]) => rows.filter((r) => monthOf(r.createdAt) === month);
        return {
            month,
            more: inMonth(fb).filter((f) => f.verdict === 'more').length,
            less: inMonth(fb).filter((f) => f.verdict === 'less').length,
            dropped: inMonth(days).reduce((n, s) => n + (Array.isArray(s.dropped) ? s.dropped.length : 0), 0),
            costUsd: Math.round(inMonth(usage).reduce((a, u) => a + Number(u.costUsd), 0) * 100) / 100,
        };
    });
    return { confirmedShare: active ? Math.round((confirmed / active) * 100) : 0, thumbs: { more, less }, dropped, steps: steps.length, byAge: { month: young, quarter: mid, older: old }, months };
}

/** GET /api/buddy/you → what /you draws: settings, counts and every memory (newest first, at most 500) */
export const youHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const [settings, counts, memories, routines, chapters] = await Promise.all([
        buddySettings(userId),
        memoryCounts(userId),
        listMemories(userId, { status: 'all', limit: LIST_LIMIT_MAX }).then((rows) => withChains(userId, rows)),
        listRoutines(userId),
        prisma.buddyChapter.findMany({ where: { userId }, orderBy: { period: 'desc' }, take: 24, select: { id: true, period: true, text: true, questions: true } }),
    ]);
    // MCP_MEMORY_PLAN §4.7: the latest catch-up, for "How your buddy learns".
    const run = await prisma.buddyCatchUp.findFirst({ where: { userId }, orderBy: { startedAt: 'desc' } });
    const catchUp = run ? { state: run.state, notes: run.notes, things: run.things, firstDay: run.firstDay ? fromDbDay(run.firstDay) : null, lastDay: run.lastDay ? fromDbDay(run.lastDay) : null, finishedAt: run.finishedAt?.toISOString() ?? null } : null;
    ok(res, {
        settings,
        counts,
        memories,
        routines,
        chapters: chapters.map((c) => ({ _id: c.id, period: c.period, text: c.text, questions: c.questions })),
        health: await buddyHealth(userId),
        sources: await earMeter(userId),
        catchUp,
        // Stage 5b: what it learned about his screens (On my screens).
        screenRules: await listScreenRules(userId),
    });
});

/** DELETE /api/buddy/screens/:id (stage 5b, cookie only): Remove on /you › On my screens. */
export const endScreenRuleHandler = handler(async (req, res) => {
    ok(res, await endScreenRule(requireUser(req).id, param(req, 'id')));
});

/** POST /api/buddy/words {sessionKey, seq, project?, messages} (the hooks) → 202 { queued } */
export const wordsHandler = handler(async (req, res) => {
    const input = parse(
        z
            .object({
                sessionKey: z.string().trim().min(1).max(80),
                seq: z.number().int().min(0).max(1_000_000),
                project: z.string().trim().max(200).nullable().optional(),
                office: z.boolean().optional(),
                // Stage 4: message numbers, context, and a hook that can hold its words.
                v: z.literal(2).optional(),
                canHold: z.boolean().optional(),
                messages: z
                    .array(
                        z
                            .object({
                                at: z.string().max(40).optional(),
                                text: z.string().max(20_000),
                                reply: z.string().max(4000).optional(),
                                n: z.number().int().min(1).max(1_000_000).optional(),
                                context: z.boolean().optional(),
                            })
                            .strict()
                    )
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
    if (may === 'not_allowed') throw aiNotAllowed(); // 403 (hosting P1-5)
    if (may === 'ai_paused') throw aiPaused((await aiAccessFor(userId)).state === 'bad_key' ? 'bad_key' : 'no_credit'); // 503, shown calmly
    if (may === 'allowance') throw aiWaitError(await aiAccessFor(userId)) ?? aiPaused('no_credit'); // stage 11: a friend's free AI waits
    if (may !== 'ok') throw new ErrorResponse(409, may === 'off' ? 'Turn your buddy on first' : may === 'paused' ? 'Your buddy is paused' : may === 'no_ai' ? 'The AI is not set up' : 'Your buddy has reached its monthly cap');
    ok(res, await nightIfDue(userId, new Date(), { fresh: true }));
});

/** GET /api/buddy/today (the app): the current line, the day's three lines, the note and the follow-up. */
export const todayHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const [step, line, settings] = await Promise.all([latestStep(userId), currentLine(userId), buddySettings(userId)]);
    // Stage 3: the buddy's open questions, still true now (the loop on).
    const asks = settings.loop && settings.enabled && !settings.paused ? await openAsks(userId, 'web') : [];
    const row = step.row && !step.stale ? step.row : null;
    ok(res, {
        enabled: settings.enabled,
        paused: settings.paused,
        name: settings.name,
        // Stage 5: the loop on (Home's "Tell" is then a message in the buddy's chat).
        loop: settings.loop,
        slot: step.slot,
        line,
        // The words read through unlabel (lines saved before the voice fix still had "From your notes:").
        asks,
        day: row ? { _id: row.id, day: fromDbDay(row.day), kind: row.kind, lines: unlabelLines(row.lines), note: unlabelOr(row.note), followUp: unlabelOr(row.followUp), createdAt: row.createdAt.toISOString() } : null,
    });
});

/** POST /api/buddy/tell {text} (the app, the phone app): straight in as a note for tonight */
export const tellHandler = handler(async (req, res) => {
    const input = parse(z.object({ text: z.string().trim().min(1).max(TELL_MAX) }).strict(), req.body);
    ok(res, await tellBuddy(requireUser(req).id, input.text), 201);
});

/** POST /api/buddy/asks/:id/answer {choice? | text? | thumb? (+ reason, stage 5b)} (stage 3): his answer to one of the buddy's questions; safe to send twice */
export const answerAskHandler = handler(async (req, res) => {
    const input = parse(z.object({ choice: z.number().int().min(0).max(2).optional(), text: z.string().trim().min(1).max(1000).optional(), thumb: z.literal('less').optional(), reason: z.enum(THUMB_REASONS).optional() }).strict(), req.body);
    if (input.choice === undefined && !input.text && !input.thumb) throw new ErrorResponse(400, 'Send a choice, your words, or a thumb');
    ok(res, await answerAsk(requireUser(req).id, param(req, 'id'), input));
});

/** POST /api/buddy/feedback {buddyDayId, target, verdict, reason?, words?} (the app, the phone app): a thumb; stage 5b: why a "not this" */
export const feedbackHandler = handler(async (req, res) => {
    const input = parse(
        z.object({ buddyDayId: z.string().trim().min(1).max(64), target: z.union([z.enum(FEEDBACK_TARGETS), z.string().regex(LINE_KEY)]), verdict: z.enum(['more', 'less']), reason: z.enum(THUMB_REASONS).optional(), words: z.string().trim().max(200).optional() }).strict(),
        req.body
    );
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

/** GET /api/buddy/chapters?q= (read): his months that hold the words (recall_memory) */
export const chaptersHandler = handler(async (req, res) => {
    const q = parse(z.object({ q: z.string().max(200).optional() }), req.query);
    ok(res, await searchChapters(requireUser(req).id, q.q ?? ''));
});

/** GET /api/buddy/threads?q=&limit= (read): what is going on in his life that holds the words (recall_memory); without words, the open ones */
export const threadsHandler = handler(async (req, res) => {
    const q = parse(z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }), req.query);
    ok(res, await searchThreads(requireUser(req).id, q.q ?? '', q.limit ?? 10));
});

/** GET /api/buddy/threads/:id (the app): one thread with its whole history and his controls */
export const threadHandler = handler(async (req, res) => {
    const t = await threadDetail(requireUser(req).id, param(req, 'id'));
    if (!t) throw new ErrorResponse(404, 'Not found');
    ok(res, t);
});

/** PATCH /api/buddy/threads/:id {askLess?, noAsk?, onScreens?, stage?: dropped|paused|active} (the app): his controls */
export const updateThreadHandler = handler(async (req, res) => {
    const patch = parse(
        z.object({ askLess: z.literal(true).optional(), noAsk: z.boolean().optional(), onScreens: z.boolean().optional(), stage: z.enum(['dropped', 'paused', 'active']).optional() }).strict().refine((p) => Object.keys(p).length > 0, 'Change something'),
        req.body
    );
    const t = await updateThreadByUser(requireUser(req).id, param(req, 'id'), patch);
    if (!t) throw new ErrorResponse(404, 'Not found');
    ok(res, t);
});

/** POST /api/buddy/threads {title} (the app): he adds one himself; it is committed at once */
export const addThreadHandler = handler(async (req, res) => {
    const input = parse(z.object({ title: z.string().trim().min(2).max(120) }).strict(), req.body);
    ok(res, await addThreadByUser(requireUser(req).id, input.title), 201);
});

/** DELETE /api/buddy/threads/:id (the app): forget it for good */
export const forgetThreadHandler = handler(async (req, res) => {
    if (!(await forgetThread(requireUser(req).id, param(req, 'id')))) throw new ErrorResponse(404, 'Not found');
    ok(res, { deleted: true });
});

/** GET /api/buddy/reminders (stage 7): the buddy's own reminders still to come or within 2 hours past, soonest first. */
export const buddyRemindersHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const rows = await prisma.buddyReminder.findMany({ where: { userId, status: 'pending', at: { gte: new Date(Date.now() - 2 * 3600_000) } }, orderBy: { at: 'asc' }, take: 20, include: { thread: { select: { title: true } } } });
    ok(res, rows.map((r) => ({ _id: r.id, text: r.text, at: r.at.toISOString(), thread: r.thread?.title ?? null })));
});

/** DELETE /api/buddy/reminders/:id (stage 7): he takes one of the buddy's reminders back. */
export const cancelBuddyReminderHandler = handler(async (req, res) => {
    const r = await prisma.buddyReminder.updateMany({ where: { id: param(req, 'id'), userId: requireUser(req).id, status: 'pending' }, data: { status: 'cancelled' } });
    if (!r.count) throw new ErrorResponse(404, 'Not found');
    ok(res, { cancelled: true });
});

/** POST /api/buddy/import {export, fileName?} (stage 8): an export's estimate; nothing is read until he approves. */
export const importHandler = handler(async (req, res) => {
    const input = parse(z.object({ export: z.unknown(), fileName: z.string().trim().max(200).optional() }).strict(), req.body);
    ok(res, await estimateImport(requireUser(req).id, input.export, input.fileName ?? null), 201);
});

/** GET /api/buddy/imports: his imports, newest first, and how far each got. */
export const importsHandler = handler(async (req, res) => {
    ok(res, await listImports(requireUser(req).id));
});

/** POST /api/buddy/imports/:id/approve {limitUsd}: his yes, up to the limit he names (at most $20). */
export const approveImportHandler = handler(async (req, res) => {
    const input = parse(z.object({ limitUsd: z.number().min(0).max(20) }).strict(), req.body);
    ok(res, await approveImport(requireUser(req).id, param(req, 'id'), input.limitUsd));
});

/** POST /api/buddy/imports/:id/cancel: what waits is dropped; what was read stays. */
export const cancelImportHandler = handler(async (req, res) => {
    ok(res, await cancelImport(requireUser(req).id, param(req, 'id')));
});

/** GET /api/buddy/export → everything as JSON (a file download) */
export const exportHandler = handler(async (req, res) => {
    const data = await exportBuddy(requireUser(req).id);
    res.setHeader('Content-Disposition', `attachment; filename="recollect-buddy-${data.exportedAt.slice(0, 10)}.json"`);
    ok(res, data);
});

/**
 * Who reads the work log (stage 12): a work folder's chat (`work=1`: its own project), Recollect itself (the app,
 * Ask AI), or a connected chat (ChatGPT, Claude, Claude Code outside a work folder: a work folder's lines only while
 * the person shares them).
 */
function workDoorOf(req: Parameters<typeof requireUser>[0], work: boolean, project: string | undefined): WorkDoor {
    if (work) return { folder: project ?? '' };
    if (!isTokenRequest(req)) return 'app';
    return req.auth?.via === 'token' && req.auth.agentName === ASK_AI_AGENT ? 'app' : 'connected';
}

const zWorkFlag = z.enum(['0', '1', 'true', 'false']).optional();
const isOn = (v: string | undefined) => v === '1' || v === 'true';

/**
 * GET /api/buddy/work?project=&from=&to=&q=&limit=&view=&work=1 (read: the app, agents, Ask AI): their work as one
 * picture, newest day first (B9, stage 12). `view`: all, done, decided, open. `work=1` is a work folder's question: one
 * project only, and it must be named.
 */
export const workHandler = handler(async (req, res) => {
    const q = parse(
        z
            .object({
                project: z.string().trim().max(100).optional(),
                from: z.string().trim().max(10).optional(),
                to: z.string().trim().max(10).optional(),
                q: z.string().trim().max(200).optional(),
                limit: z.coerce.number().int().min(1).max(500).optional(),
                view: z.enum(WORK_VIEWS).optional(),
                work: zWorkFlag,
            })
            .strict(),
        req.query
    );
    const officeOnly = isOn(q.work);
    if (officeOnly && !q.project) throw new ErrorResponse(400, 'A work chat asks about its own project: send project');
    ok(res, await listWork(requireUser(req).id, { project: q.project, from: q.from, to: q.to, q: q.q, limit: q.limit, view: q.view }, workDoorOf(req, officeOnly, q.project)));
});

/** GET /api/buddy/work/picture?project=&day=&work=1 (read): what a writer is shown (W5); null while the work log is off. */
export const workPictureHandler = handler(async (req, res) => {
    const q = parse(
        z.object({ project: z.string().trim().max(100).optional(), day: z.string().trim().max(10).optional(), work: zWorkFlag }).strict(),
        req.query
    );
    const officeOnly = isOn(q.work);
    if (officeOnly && !q.project) throw new ErrorResponse(400, 'A work chat asks about its own project: send project');
    ok(res, await workPicture(requireUser(req).id, { day: q.day, project: q.project, door: workDoorOf(req, officeOnly, q.project) }));
});

const zWorkId = z.string().trim().min(1).max(40);

/**
 * POST /api/buddy/work {key, project, day?, office?, lines} (a chat's list for a day: Claude Code's log_work,
 * /log-work; B10; stage 12: a line may be news `on` a known one)
 * → { status: saved, day, project, saved, skipped } | { status: off } | { status: paused }
 */
export const logWorkHandler = handler(async (req, res) => {
    const input = parse(
        z
            .object({
                key: z.string().trim().min(1).max(80),
                project: z.string().trim().min(1).max(100),
                day: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
                office: z.boolean().optional(),
                lines: z
                    .array(z.object({ kind: z.enum(WORK_KINDS), text: z.string().trim().min(1).max(400), at: z.string().trim().max(40).optional(), on: zWorkId.optional() }).strict())
                    .min(1)
                    .max(LOG_LINES_MAX),
            })
            .strict(),
        req.body
    );
    ok(res, await logWork(requireUser(req).id, { ...input, app: agentActor(req).agentName }), 201);
});

/**
 * POST /api/buddy/work/line {text, kind?, project?, on?, day?, more?} (one outcome from a connected chat: claude.ai and
 * ChatGPT's log_work; stage 12; stage 13: `more`, up to 2 other results of the same message) → saved | already |
 * removed | full | off | paused for the first line, with the picture (W5); with `more`, every line's outcome in `lines`.
 */
export const logLineHandler = handler(async (req, res) => {
    const input = parse(
        z
            .object({
                text: z.string().trim().min(1).max(400),
                kind: z.enum(LINE_KINDS).optional(),
                project: z.string().trim().max(100).optional(),
                on: zWorkId.optional(),
                day: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
                more: z
                    .array(z.object({ text: z.string().trim().min(1).max(400), kind: z.enum(LINE_KINDS).optional(), on: zWorkId.optional() }).strict())
                    .max(LINE_MORE_MAX)
                    .optional(),
            })
            .strict(),
        req.body
    );
    const r = await logLine(requireUser(req).id, { app: agentActor(req).agentName }, { ...input, kind: input.kind ?? 'did' });
    const savedAny = r.status === 'saved' || ('lines' in r && !!r.lines?.some((l) => l.status === 'saved'));
    ok(res, r, savedAny ? 201 : 200);
});

/**
 * PATCH /api/buddy/work/line/:id {sameAs} | {text} | {on} | {remove: true} (the app that wrote the line, W6): fold it
 * into the line it repeats, reword it the same day, make it news on a known line, or remove it on the person's word.
 */
export const changeLineHandler = handler(async (req, res) => {
    const input = parse(
        z
            .object({ sameAs: zWorkId.optional(), text: z.string().trim().min(1).max(400).optional(), on: zWorkId.optional(), remove: z.literal(true).optional() })
            .strict()
            .refine((x) => Object.keys(x).length === 1, 'Send one change: sameAs, text, on or remove'),
        req.body
    );
    const change = input.sameAs ? { sameAs: input.sameAs } : input.text ? { text: input.text } : input.on ? { on: input.on } : { remove: true as const };
    ok(res, await changeLine(requireUser(req).id, { app: agentActor(req).agentName }, param(req, 'id'), change));
});

/** DELETE /api/buddy/work/:id (the app): he removes a line; it stays hidden and is never written again. */
export const hideWorkHandler = handler(async (req, res) => {
    ok(res, await hideWorkLine(requireUser(req).id, param(req, 'id')));
});
