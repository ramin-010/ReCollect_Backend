// Recall mode (HOME_DOCS_AGENT_PLAN §4): a due revision's questions, answers graded against the
// notes, and a result that moves the schedule through the existing revision services.
//
//   startRecall    the revision's ready set (pre-written by the nightly batch), else written now
//   answerRecall   "Knew it" / "Didn't know" (no model call) or a typed answer graded by Claude
//   finishRecall   counts → result → complete (strong) or reschedule (partial +2 days, weak +1)
//
// At most one unfinished set per revision: sets are created or taken over only inside a
// transaction holding the revision row (FOR UPDATE). Model calls never run inside a transaction.
// Every call is recorded in AiUsage before its output is read (the tokens are billed either way).
import type { Prisma, RecallAttempt, RecallGrade, RecallSet } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { serializeRecallAttempt, serializeRecallSet, type RecallAttemptJson, type RecallSetJson } from '../../db/serializers/recall';
import type { ChainRevisionJson } from '../../db/serializers/learning';
import { addDays, isMastered, LearningError } from '../learning';
import { loadLearningContext, toEngineRevision } from '../learningDb/common';
import { completeRevisionForUser, rescheduleRevisionForUser } from '../learningDb/revisions.service';
import { aiModel, callClaude, isAiConfigured } from '../claude/client';
import { aiBadRequest, aiConflict, aiFailed, aiNotConfigured, aiNotFound, noContent } from '../claude/errors';
import { assertUnderCap, recordAiUsage } from '../claude/usage.service';
import { earlierQuestions, findRecallRevision, itemTitle, materialOf, type RecallRevision } from './material';
import { ModelOutputError, parseGradeOutput, parseQuestionsOutput, parseStoredQuestions, responseText, type RecallQuestion } from './output';
import { AGAIN_IN_DAYS, countGrades, intendedEffect, parseStoredOutcome, recallResult, type RecallEffect, type RecallOutcome } from './outcome';
import { gradeRequest, hasEnoughContent, questionsRequest, withRefusalFallbacks, type RecallMaterial } from './prompts';

type SetWithAttempts = RecallSet & { attempts: RecallAttempt[] };

/** A response to a question-writing request (on demand or from a batch) → its questions. */
export function questionsFromMessage(message: { stop_reason: string | null; content: ReadonlyArray<{ type: string; text?: unknown }> }): RecallQuestion[] {
    return parseQuestionsOutput(responseText(message));
}

/** An unusable model output as the 502 the app answers with. */
function outputFailure(err: unknown, what: string): unknown {
    if (!(err instanceof ModelOutputError)) return err;
    console.error(`[recall] unusable ${what}: ${err.message}`);
    if (err.reason === 'refused') return aiFailed(`The AI declined to write the ${what} for these notes.`, 'AI_REFUSED');
    return aiFailed(`The AI's ${what} could not be read. Try again.`);
}

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

function liveSet(revisionId: string): Promise<SetWithAttempts | null> {
    return prisma.recallSet.findFirst({ where: { revisionId, finishedAt: null }, orderBy: { createdAt: 'desc' }, include: { attempts: true } });
}

// ─── Start ─────────────────────────────────────────────────────────────

/**
 * POST /api/recall/start { revisionId }. The revision's ready set when there is one (the nightly
 * batch wrote it, or an earlier start did); otherwise the questions are written now.
 * Errors: 404 not the user's revision, 409 NOT_PENDING (already done), 503 AI_NOT_CONFIGURED,
 * 422 NO_CONTENT (under MIN_CONTENT_CHARS), 402 AI_CAP_REACHED, 502 when the model call fails.
 */
export async function startRecall(userId: string, revisionId: string, now: Date = new Date()): Promise<RecallSetJson> {
    const rev = await findRecallRevision(userId, revisionId);
    if (!rev) throw aiNotFound();
    const live = await liveSet(rev.id);
    if (live?.status === 'ready') return serializeRecallSet(live, itemTitle(rev));
    if (rev.status !== 'pending') throw aiConflict('This review is already done.', 'NOT_PENDING');
    if (!isAiConfigured()) throw aiNotConfigured();

    const material = await materialOf(userId, rev);
    if (!hasEnoughContent(material)) throw noContent();
    await assertUnderCap(userId, now);

    const earlier = await earlierQuestions(rev, live?.id);
    const request = questionsRequest({ model: aiModel(), material, cycleNumber: rev.cycleNumber, earlier });
    const message = await callClaude(withRefusalFallbacks(request), 'recall questions');
    await recordAiUsage(userId, 'recall_questions', message);
    let questions: RecallQuestion[];
    try {
        questions = questionsFromMessage(message);
    } catch (err) {
        throw outputFailure(err, 'questions');
    }

    const setId = await storeReadySet(userId, rev, material, questions, message.model);
    const set = await prisma.recallSet.findUniqueOrThrow({ where: { id: setId }, include: { attempts: true } });
    return serializeRecallSet(set, itemTitle(rev));
}

/** Store freshly written questions as the revision's live set (taking over a pending/failed one). */
async function storeReadySet(userId: string, rev: RecallRevision, material: RecallMaterial, questions: RecallQuestion[], model: string): Promise<string> {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Revision" WHERE "id" = ${rev.id} FOR UPDATE`;
        const live = await tx.recallSet.findFirst({
            where: { revisionId: rev.id, finishedAt: null },
            orderBy: { createdAt: 'desc' },
            select: { id: true, status: true },
        });
        // A concurrent start stored its questions first: use those (this call's usage is recorded).
        if (live?.status === 'ready') return live.id;
        const data = {
            status: 'ready' as const,
            questions: asJson(questions),
            model: model.slice(0, 100),
            batchId: null,
            error: null,
            docId: material.docId,
            cycleNumber: rev.cycleNumber,
        };
        if (live) {
            await tx.recallSet.update({ where: { id: live.id }, data, select: { id: true } });
            return live.id;
        }
        const created = await tx.recallSet.create({ data: { userId, revisionId: rev.id, ...data }, select: { id: true } });
        return created.id;
    });
}

// ─── Answer ────────────────────────────────────────────────────────────

export interface RecallAnswerInput {
    questionId: string;
    answer?: string | undefined;
    selfMark?: 'knew' | 'didnt' | undefined;
}

interface AttemptData {
    answer: string | null;
    selfMark: 'knew' | 'didnt' | null;
    grade: RecallGrade;
    feedback: string;
    quote: string | null;
}

async function materialForSet(userId: string, set: Pick<RecallSet, 'revisionId'>): Promise<RecallMaterial | null> {
    const rev = await findRecallRevision(userId, set.revisionId);
    return rev ? materialOf(userId, rev) : null;
}

/**
 * POST /api/recall/sets/:id/answer. A self-mark grades without a model call (knew → strong,
 * didnt → weak; the quote is the question's source passage). A typed answer is graded by Claude.
 * Re-answering a question replaces its attempt. 409 once the set is finished.
 */
export async function answerRecall(userId: string, setId: string, input: RecallAnswerInput, now: Date = new Date()): Promise<RecallAttemptJson> {
    const set = await prisma.recallSet.findFirst({ where: { id: setId, userId } });
    if (!set) throw aiNotFound();
    if (set.finishedAt) throw aiConflict('This review is finished.', 'FINISHED');
    if (set.status !== 'ready') throw aiConflict('This review has no questions yet.', 'NOT_READY');
    const question = parseStoredQuestions(set.questions).find((q) => q.id === input.questionId);
    if (!question) throw aiBadRequest('There is no such question in this review.', 'UNKNOWN_QUESTION');

    let attempt: AttemptData;
    if (input.selfMark) {
        attempt = {
            answer: null,
            selfMark: input.selfMark,
            grade: input.selfMark === 'knew' ? 'strong' : 'weak',
            feedback: '',
            quote: question.sourceQuote || null,
        };
    } else {
        const answer = input.answer?.trim() ?? '';
        if (!answer) throw aiBadRequest('Send an answer or a self-mark.');
        if (!isAiConfigured()) throw aiNotConfigured();
        await assertUnderCap(userId, now);
        const material = await materialForSet(userId, set);
        const message = await callClaude(withRefusalFallbacks(gradeRequest({ model: aiModel(), material, question, answer })), 'recall grading');
        await recordAiUsage(userId, 'recall_grade', message);
        try {
            attempt = { answer, selfMark: null, ...parseGradeOutput(responseText(message), question.sourceQuote) };
        } catch (err) {
            throw outputFailure(err, 'grade');
        }
    }

    await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ finishedAt: Date | null }>>`SELECT "finishedAt" FROM "RecallSet" WHERE "id" = ${setId} FOR UPDATE`;
        if (!rows[0]) throw aiNotFound();
        if (rows[0].finishedAt) throw aiConflict('This review is finished.', 'FINISHED');
        await tx.recallAttempt.upsert({
            where: { setId_questionId: { setId, questionId: question.id } },
            create: { setId, questionId: question.id, ...attempt },
            update: { ...attempt, createdAt: now },
            select: { id: true },
        });
    });
    return serializeRecallAttempt({ questionId: question.id, ...attempt });
}

// ─── Finish ────────────────────────────────────────────────────────────

/** The day the item comes back after a completion: its earliest pending cycle. */
function nextPendingDay(chain: readonly ChainRevisionJson[]): string | null {
    const pending = chain.filter((r) => r.status === 'pending').sort((a, b) => (a.scheduledFor < b.scheduledFor ? -1 : a.scheduledFor > b.scheduledFor ? 1 : a.cycleNumber - b.cycleNumber));
    return pending[0]?.scheduledFor ?? null;
}

/** The schedule as it stands (the revision was marked revised elsewhere during the review). */
async function currentEffect(revisionId: string): Promise<RecallEffect> {
    const rev = await prisma.revision.findUnique({ where: { id: revisionId }, select: { topicId: true, captureId: true } });
    if (!rev) return { kind: 'advanced', nextDay: null };
    const rows = await prisma.revision.findMany({ where: rev.topicId ? { topicId: rev.topicId } : { captureId: rev.captureId }, orderBy: { cycleNumber: 'asc' } });
    const chain = rows.map(toEngineRevision);
    if (isMastered(chain)) return { kind: 'mastered', nextDay: null };
    const next = chain
        .filter((r) => r.status === 'pending')
        .sort((a, b) => (a.scheduledFor < b.scheduledFor ? -1 : a.scheduledFor > b.scheduledFor ? 1 : a.cycleNumber - b.cycleNumber))[0];
    return { kind: 'advanced', nextDay: next?.scheduledFor ?? null };
}

/** Moves the revision with the existing services (streaks, history and undo stay right). */
async function applyResult(userId: string, revisionId: string, result: RecallGrade, now: Date): Promise<RecallEffect> {
    try {
        if (result === 'strong') {
            const done = await completeRevisionForUser(userId, revisionId, now);
            return done.mastered ? { kind: 'mastered', nextDay: null } : { kind: 'advanced', nextDay: nextPendingDay(done.chain) };
        }
        const { today } = await loadLearningContext(userId, now);
        const day = addDays(today, AGAIN_IN_DAYS[result]);
        await rescheduleRevisionForUser(userId, revisionId, day, now);
        return { kind: intendedEffect(result), nextDay: day };
    } catch (err) {
        // Already marked revised (another tab, or "Mark as revised"): leave the schedule alone.
        if (err instanceof LearningError && err.code === 'NOT_PENDING') return currentEffect(revisionId);
        throw err;
    }
}

/**
 * POST /api/recall/sets/:id/finish. Unanswered questions count as weak. Idempotent: the outcome is
 * stored on the set and a second finish returns it (a concurrent second finish re-applies the
 * same effect, which the revision services make a no-op, and gets the first outcome back).
 */
export async function finishRecall(userId: string, setId: string, now: Date = new Date()): Promise<RecallOutcome> {
    const set = await prisma.recallSet.findFirst({ where: { id: setId, userId }, include: { attempts: true } });
    if (!set) throw aiNotFound();
    const stored = parseStoredOutcome(set.outcome);
    if (stored) return stored;
    if (set.status !== 'ready') throw aiConflict('This review has no questions yet.', 'NOT_READY');

    const counts = countGrades(
        parseStoredQuestions(set.questions).map((q) => q.id),
        set.attempts
    );
    const result = recallResult(counts);
    const effect = await applyResult(userId, set.revisionId, result, now);
    const outcome: RecallOutcome = { result, effect, counts };

    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "RecallSet" WHERE "id" = ${setId} FOR UPDATE`;
        const current = await tx.recallSet.findUnique({ where: { id: setId }, select: { outcome: true } });
        if (!current) throw aiNotFound();
        const first = parseStoredOutcome(current.outcome);
        if (first) return first;
        await tx.recallSet.update({ where: { id: setId }, data: { finishedAt: now, result, outcome: asJson(outcome) }, select: { id: true } });
        return outcome;
    });
}
