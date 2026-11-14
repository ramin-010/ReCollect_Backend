// Recall mode JSON (recollect/lib/api/recallApi.ts): RecallSet and RecallAttempt rows → the API.
// A question's answerKey never leaves the server; its sourceQuote only as a self-mark's quote.
import type { RecallAttempt, RecallGrade, RecallSet } from '@prisma/client';
import { parseStoredQuestions, type RecallKind } from '../../services/recall/output';

export interface RecallAttemptJson {
    questionId: string;
    grade: RecallGrade;
    feedback: string;
    quote: string | null;
    selfMarked: boolean;
}

export interface RecallSetJson {
    id: string;
    revisionId: string;
    /** null for a capture's review. */
    docId: string | null;
    docTitle: string;
    cycleNumber: number;
    questions: Array<{ id: string; kind: RecallKind; prompt: string }>;
    attempts: RecallAttemptJson[];
    finishedAt: Date | null;
}

export function serializeRecallAttempt(a: Pick<RecallAttempt, 'questionId' | 'grade' | 'feedback' | 'quote' | 'selfMark'>): RecallAttemptJson {
    return { questionId: a.questionId, grade: a.grade, feedback: a.feedback, quote: a.quote || null, selfMarked: a.selfMark !== null };
}

export function serializeRecallSet(set: RecallSet & { attempts: RecallAttempt[] }, docTitle: string): RecallSetJson {
    const questions = parseStoredQuestions(set.questions);
    const order = new Map(questions.map((q, i) => [q.id, i]));
    const attempts = set.attempts
        .filter((a) => order.has(a.questionId))
        .sort((a, b) => (order.get(a.questionId) ?? 0) - (order.get(b.questionId) ?? 0))
        .map(serializeRecallAttempt);
    return {
        id: set.id,
        revisionId: set.revisionId,
        docId: set.docId,
        docTitle,
        cycleNumber: set.cycleNumber,
        questions: questions.map(({ id, kind, prompt }) => ({ id, kind, prompt })),
        attempts,
        finishedAt: set.finishedAt,
    };
}
