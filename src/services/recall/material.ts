// What Recall asks about, read from the database: a revision with its item, the item's text
// (a topic's doc as Markdown, live if an editor has it open; a capture's title, text and link),
// and the questions of earlier reviews of the same item.
import type { Prisma, RecallGrade } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { captureTitle } from '../../db/serializers/learning';
import { findAccessibleDoc } from '../docs/docs.service';
import { docJsonToMarkdown } from '../docs/markdown/docMarkdown';
import { currentContent } from '../agent/agentDocs.service';
import { parseStoredQuestions } from './output';
import type { EarlierQuestion, RecallMaterial } from './prompts';

export const recallRevisionInclude = {
    topic: { select: { id: true, title: true, docId: true, doc: { select: { title: true } } } },
    capture: { select: { id: true, title: true, content: true, url: true } },
} satisfies Prisma.RevisionInclude;

export type RecallRevision = Prisma.RevisionGetPayload<{ include: typeof recallRevisionInclude }>;

/** The user's revision with its topic or capture, or null (another user's id is "not found"). */
export function findRecallRevision(userId: string, revisionId: string): Promise<RecallRevision | null> {
    return prisma.revision.findFirst({ where: { id: revisionId, userId }, include: recallRevisionInclude });
}

/** The title the review shows: the doc's title, the topic's, or the capture's label. */
export function itemTitle(rev: RecallRevision): string {
    if (rev.topic) return rev.topic.doc?.title ?? rev.topic.title;
    if (rev.capture) return captureTitle(rev.capture);
    return 'Review';
}

/**
 * The text to ask about, or null when there is none: the topic has no doc (or the user can no
 * longer see it), or the capture is gone.
 */
export async function materialOf(userId: string, rev: RecallRevision): Promise<RecallMaterial | null> {
    if (rev.topic) {
        if (!rev.topic.docId) return null;
        const doc = await findAccessibleDoc(rev.topic.docId, userId);
        if (!doc) return null;
        const { json, title } = currentContent(doc);
        return { kind: 'doc', title, body: docJsonToMarkdown(json), url: null, docId: doc.id };
    }
    if (rev.capture) {
        const c = rev.capture;
        // The raw title: captureTitle() falls back to the text's start, which would count twice.
        return { kind: 'capture', title: c.title?.trim() ?? '', body: c.content ?? '', url: c.url?.trim() || null, docId: null };
    }
    return null;
}

/**
 * Questions from the latest earlier sets of the same item (any of its revisions), newest first,
 * with the grade each got (null = not answered). Feeds "ask again what was missed".
 */
export async function earlierQuestions(rev: Pick<RecallRevision, 'topicId' | 'captureId'>, excludeSetId?: string): Promise<EarlierQuestion[]> {
    const item: Prisma.RevisionWhereInput = rev.topicId ? { topicId: rev.topicId } : { captureId: rev.captureId };
    const sets = await prisma.recallSet.findMany({
        where: { status: 'ready', revision: item, ...(excludeSetId ? { id: { not: excludeSetId } } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { questions: true, attempts: { select: { questionId: true, grade: true } } },
    });
    const out: EarlierQuestion[] = [];
    for (const set of sets) {
        const grades = new Map<string, RecallGrade>(set.attempts.map((a) => [a.questionId, a.grade]));
        for (const q of parseStoredQuestions(set.questions)) out.push({ kind: q.kind, prompt: q.prompt, grade: grades.get(q.id) ?? null });
    }
    return out;
}
