// A topic's Recall results for agents and the manager (MANAGER_AND_DOCS_PLAN §3.3 get_recall): the
// finished question sets (newest first) with each answer's grade, the questions he got wrong or
// half right with the grader's words, and the topic's open weak spots. So a chat can quiz him on
// exactly what he misses. Never the answer keys.
//
//   GET /api/topics/:id/recall   read   (a topic id, or ?by=doc with the doc's id)
import { prisma } from '../../db/prisma';
import { notFound } from '../learning/http';

const SETS_MAX = 5;

export interface RecallResultsJson {
    topic: { _id: string; title: string; docId: string | null };
    sets: Array<{
        finishedAt: string;
        cycle: number;
        result: 'strong' | 'partial' | 'weak' | null;
        counts: { strong: number; partial: number; weak: number };
        missed: Array<{ question: string; grade: 'partial' | 'weak'; feedback: string }>;
    }>;
    weakSpots: Array<{ _id: string; text: string; source: string }>;
}

interface Question {
    id: string;
    prompt: string;
}

export async function recallResults(userId: string, id: string, by: 'topic' | 'doc' = 'topic'): Promise<RecallResultsJson> {
    const topic = await prisma.topic.findFirst({
        where: by === 'doc' ? { userId, docId: id } : { userId, id },
        select: { id: true, title: true, docId: true, doc: { select: { title: true } } },
    });
    if (!topic) throw notFound();
    const [sets, spots] = await Promise.all([
        prisma.recallSet.findMany({
            where: { userId, finishedAt: { not: null }, revision: { topicId: topic.id } },
            orderBy: { finishedAt: 'desc' },
            take: SETS_MAX,
            select: { finishedAt: true, cycleNumber: true, result: true, questions: true, attempts: { select: { questionId: true, grade: true, feedback: true } } },
        }),
        prisma.weakSpot.findMany({ where: { userId, topicId: topic.id, status: 'open' }, orderBy: { createdAt: 'asc' }, select: { id: true, text: true, source: true } }),
    ]);
    return {
        topic: { _id: topic.id, title: topic.doc?.title || topic.title, docId: topic.docId },
        sets: sets.map((s) => {
            const questions = (Array.isArray(s.questions) ? s.questions : []) as unknown as Question[];
            const prompt = new Map(questions.map((q) => [q.id, q.prompt]));
            const counts = { strong: 0, partial: 0, weak: 0 };
            for (const a of s.attempts) counts[a.grade] += 1;
            return {
                finishedAt: s.finishedAt!.toISOString(),
                cycle: s.cycleNumber,
                result: s.result,
                counts,
                missed: s.attempts
                    .filter((a): a is typeof a & { grade: 'partial' | 'weak' } => a.grade !== 'strong')
                    .map((a) => ({ question: prompt.get(a.questionId) ?? '(question not kept)', grade: a.grade, feedback: a.feedback })),
            };
        }),
        weakSpots: spots.map((w) => ({ _id: w.id, text: w.text, source: w.source })),
    };
}
