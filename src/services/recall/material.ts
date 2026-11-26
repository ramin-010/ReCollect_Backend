// What Recall asks about, read from the database: a revision with its item, the item's text
// (a topic's doc as Markdown, live if an editor has it open; a capture's title, text and link),
// and the questions of earlier reviews of the same item.
import { pagesInside } from '../docs/docTree.service';
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

/** Past this many added characters the pages' text stops (the lesson's own text is never cut here). */
export const PAGES_MATERIAL_MAX = 12_000;

/** A lesson's text, then each page inside it under `## <title>` in tree order, until PAGES_MATERIAL_MAX added characters. */
export function withPages(body: string, pages: ReadonlyArray<{ title: string; markdown: string }>): string {
    let out = body;
    let added = 0;
    for (const p of pages) {
        const part = `\n\n## ${p.title.trim() || 'Untitled'}\n\n${p.markdown.trim()}`;
        if (added + part.length > PAGES_MATERIAL_MAX) {
            const room = PAGES_MATERIAL_MAX - added;
            if (room > 200) out += part.slice(0, room);
            break;
        }
        out += part;
        added += part.length;
    }
    return out;
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
        // DOC_PAGES_PLAN §8.2: the pages inside a lesson are revised with it: their text follows the lesson's.
        const pages = await pagesInside(doc.id, userId);
        const parts: Array<{ title: string; markdown: string }> = [];
        for (const p of pages) {
            const row = await prisma.doc.findUnique({ where: { id: p.id }, select: { id: true, title: true, yjsState: true } });
            if (!row) continue;
            const page = currentContent(row);
            parts.push({ title: page.title, markdown: docJsonToMarkdown(page.json) });
        }
        return { kind: 'doc', title, body: withPages(docJsonToMarkdown(json), parts), url: null, docId: doc.id };
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
