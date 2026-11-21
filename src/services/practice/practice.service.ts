// Practice log → note (HOME_DOCS_AGENT_PLAN §4, Phase D2): the learner pastes a solved problem (a
// link and/or the statement), their code and what tripped them up; Claude writes the DSA note
// (./prompts.ts) and it becomes a normal doc, made exactly like an agent's doc
// (createDocFromMarkdown: filed under a subject as a topic, `revise` starts the 1/3/7/21 schedule)
// but without an agent edit log line. The learner's code goes into the note verbatim (./output.ts).
//
// Checks before any spend: the subject (404) and `revise` without one (400), then the cap (402).
// The call is recorded in AiUsage before its output is read (the tokens are billed either way).
import { prisma } from '../../db/prisma';
import { aiModel, callClaude, isAiConfigured } from '../claude/client';
import { aiBadRequest, aiFailed, aiNotConfigured, aiNotFound } from '../claude/errors';
import { assertUnderCap, recordAiUsage } from '../claude/usage.service';
import { createDocFromMarkdown } from '../agent/agentDocs.service';
import { ModelOutputError, responseText } from '../recall/output';
import { withRefusalFallbacks } from '../recall/prompts';
import { codeLanguage, parsePracticeNoteOutput, type PracticeNote } from './output';
import { practiceNoteRequest } from './prompts';

/** POST /api/ai/practice-note */
export interface PracticeNoteInput {
    /** A link and/or the statement (1–4000 characters). */
    problem: string;
    /** The learner's code (1–20000 characters), kept verbatim. */
    solution: string;
    language?: string | null | undefined;
    /** What tripped them up (≤ 2000 characters). */
    struggles?: string | null | undefined;
    subjectId?: string | null | undefined;
    /** Start the revision schedule; needs subjectId. */
    revise?: boolean | null | undefined;
}

export interface PracticeNoteJson {
    docId: string;
    title: string;
    topicId: string | null;
    /** 'YYYY-MM-DD' of the first revision when `revise` started the schedule. */
    nextRevision: string | null;
}

/** An unusable model output as the 502 the app answers with. */
function outputFailure(err: unknown): unknown {
    if (!(err instanceof ModelOutputError)) return err;
    console.error(`[practice] unusable note: ${err.message}`);
    if (err.reason === 'refused') return aiFailed('The AI declined to write a note for this problem.', 'AI_REFUSED');
    return aiFailed("The AI's note could not be read. Try again.");
}

/**
 * POST /api/ai/practice-note → 201 { docId, title, topicId, nextRevision }.
 * Errors: 400 revise without a subjectId, 404 unknown subject, 503 AI_NOT_CONFIGURED,
 * 402 AI_CAP_REACHED, 502 AI_REFUSED / AI_BUSY / AI_FAILED.
 */
export async function createPracticeNote(userId: string, input: PracticeNoteInput, now: Date = new Date()): Promise<PracticeNoteJson> {
    const subjectId = input.subjectId || undefined;
    if (input.revise && !subjectId) throw aiBadRequest('revise needs a subjectId (the subject to revise it under)');
    if (subjectId) {
        const subject = await prisma.subject.findFirst({ where: { id: subjectId, userId }, select: { id: true } });
        if (!subject) throw aiNotFound('Subject not found');
    }
    if (!isAiConfigured()) throw aiNotConfigured();
    await assertUnderCap(userId, now);

    const language = codeLanguage(input.language);
    const request = practiceNoteRequest({ model: aiModel(), problem: input.problem, solution: input.solution, language, struggles: input.struggles });
    const message = await callClaude(userId, withRefusalFallbacks(request), 'practice note');
    await recordAiUsage(userId, 'practice_note', message);
    let note: PracticeNote;
    try {
        note = parsePracticeNoteOutput(responseText(message), { solution: input.solution, language });
    } catch (err) {
        throw outputFailure(err);
    }

    const doc = await createDocFromMarkdown(userId, { title: note.title, markdown: note.markdown, subjectId, revise: input.revise === true, checkMermaid: false });
    return { docId: doc.id, title: doc.title, topicId: doc.topicId, nextRevision: doc.nextRevision };
}
