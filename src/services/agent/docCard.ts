// STUDY_FLOW_PLAN §4.4 (11-23): a lesson's revision card. It is the doc's last section, under its own heading
// ("Revision card"), written by an agent's set_revision_card when the lesson is complete; Doc.cardBlockId points at
// that heading, so the person reads, edits, renames or moves it like any section. A review shows the card first (Home's
// dialog: "Done" opens the doc). Setting a card never starts reviews: the chat asks, then schedule_revision.
//
//   PUT /api/agent/docs/:id/card { markdown }   (docs:write)  write or replace it; logged doc_blocks, Undo
//   GET /api/docs/:id/card                       (cookie)      the card as the editor draws it, read-only
import { prisma } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { writeBoards } from '../docs/canvas';
import * as ops from '../docs/blocks/docOps';
import { markdownToBlocks } from '../docs/blocks/markdown';
import { onNewEditor } from '../docs/blocks/newDocState';
import { stateOfBlocks } from '../docs/blocks/publicState';
import { readBlocks, type DocBlock, type NewBlock } from '../docs/blocks/serverEditor';
import { findAccessibleDoc } from '../docs/docs.service';
import { fromDbDay, loadLearningContext } from '../learningDb/common';
import { blockText, canvasIdsOf, headingText, readable, renameCanvases, takenCanvasIds } from './agentBlocks.service';
import { logDocChange, normalizeHeading, requireEditableDoc } from './agentDocs.service';
import { quoted, type AgentActor } from './agentEditLog';
import { withLiveDoc } from './liveDoc';

export const CARD_TITLE = 'Revision card';
/** A card is a page: key points, one diagram, a handful of questions. */
export const CARD_MAX = 12_000;

const OLD_EDITOR = 'This doc is still on the old editor: a revision card needs the new one (open the doc once in Recollect)';

const levelOf = (b: DocBlock | NewBlock): number => Number(b.props?.['level']) || 1;
const isHeading = (b: DocBlock | NewBlock): boolean => b.type === 'heading';

/** The card's heading among the doc's top-level blocks: by its id, else the last heading named "Revision card"; -1 = none. */
export function findCard(top: readonly DocBlock[], cardBlockId: string | null | undefined): number {
    if (cardBlockId) {
        const i = top.findIndex((b) => b.id === cardBlockId && isHeading(b));
        if (i >= 0) return i;
    }
    const want = normalizeHeading(CARD_TITLE);
    for (let i = top.length - 1; i >= 0; i -= 1) {
        if (isHeading(top[i]!) && normalizeHeading(headingText(top[i]!)) === want) return i;
    }
    return -1;
}

/** A new card's heading level: the doc's section level (a lone title at the top doesn't count), else 2. */
export function cardLevel(top: readonly DocBlock[]): number {
    const levels = top.filter(isHeading).map(levelOf);
    const titled = levels.length > 1 && levels[0] === 1 && levels.filter((l) => l === 1).length === 1;
    const sections = titled ? levels.slice(1) : levels;
    return sections.length ? Math.min(Math.max(Math.min(...sections), 1), 6) : 2;
}

/** The card's blocks after its heading: up to the next heading of the same or a higher level (exclusive). */
export function cardSection(top: readonly DocBlock[], at: number): { at: number; end: number } {
    const level = levelOf(top[at]!);
    let end = at + 1;
    while (end < top.length && !(isHeading(top[end]!) && levelOf(top[end]!) <= level)) end += 1;
    // The editor keeps an empty paragraph at a doc's end: it isn't the card's.
    const last = top[end - 1];
    if (end === top.length && end - 1 > at && last && last.type === 'paragraph' && !blockText(last).trim() && !last.children.length) end -= 1;
    return { at, end };
}

/** Headings in the card sit below its own heading (one of the same level would end the card). */
export function underCard(blocks: readonly NewBlock[], level: number): NewBlock[] {
    return blocks.map((b) => (isHeading(b) && levelOf(b) <= level ? { ...b, props: { ...b.props, level: Math.min(level + 1, 6) } } : b));
}

/** The card's Markdown without a heading of its own name at the top (the tool writes that heading). */
function withoutOwnTitle(blocks: NewBlock[]): NewBlock[] {
    const first = blocks[0];
    if (!first || !isHeading(first)) return blocks;
    const text = Array.isArray(first.content) ? first.content.map((n) => ('text' in n ? n.text : '')).join('') : '';
    return normalizeHeading(text) === normalizeHeading(CARD_TITLE) ? blocks.slice(1) : blocks;
}

/** PUT /api/agent/docs/:id/card { markdown } → { id, heading, replaced, blocks, editId, canvases? } */
export async function setRevisionCard(actor: AgentActor, docId: string, markdown: string) {
    const doc = await requireEditableDoc(docId, actor.userId);
    if (markdown.trim().length > CARD_MAX) throw new ErrorResponse(400, `A revision card is at most ${CARD_MAX.toLocaleString('en')} characters: the key points, one diagram, the questions.`);
    const parsed = await markdownToBlocks(markdown, {});
    const body = withoutOwnTitle(parsed.blocks);
    if (!body.length) throw new ErrorResponse(400, 'The card is empty: send its key points, a diagram and its questions as Markdown.');

    const out = await withLiveDoc(docId, actor.agentName, (live) => {
        if (!onNewEditor(live.doc)) throw new ErrorResponse(409, OLD_EDITOR);
        const top = readBlocks(live.doc);
        const at = findCard(top, doc.cardBlockId);
        const level = at >= 0 ? levelOf(top[at]!) : cardLevel(top);
        const { blocks, boards } = renameCanvases(underCard(body, level), parsed.boards, takenCanvasIds(live.doc));
        let headingId = at >= 0 ? top[at]!.id : '';
        const change = live.apply(() => {
            if (at >= 0) {
                // Replace the card's content; its heading (and so its place and any rename) stays.
                const section = cardSection(top, at);
                const gone = [...top[at]!.children.map((c) => c.id), ...top.slice(at + 1, section.end).map((b) => b.id)];
                if (gone.length) ops.remove(live.doc, gone);
                ops.insert(live.doc, blocks, { after: headingId });
            } else {
                const heading: NewBlock = { type: 'heading', props: { level }, content: [{ type: 'text', text: CARD_TITLE, styles: {} }] };
                headingId = ops.insert(live.doc, [heading, ...blocks], { at: 'end' })[0] ?? '';
            }
            writeBoards(live.doc, boards);
        });
        return { change, replaced: at >= 0, headingId, heading: at >= 0 ? headingText(top[at]!).trim() || CARD_TITLE : CARD_TITLE, canvasIds: canvasIdsOf(blocks) };
    });

    const before = doc.cardBlockId ?? null;
    if (out.headingId && out.headingId !== before) await prisma.doc.update({ where: { id: docId }, data: { cardBlockId: out.headingId }, select: { id: true } });
    const editId = await logDocChange(
        actor,
        docId,
        out.change,
        'doc_blocks',
        `${out.replaced ? 'Rewrote' : 'Wrote'} the revision card in ${quoted(doc.title)}`,
        { card: { before, after: out.headingId } }
    );
    const canvases = parsed.canvases.map((c, i) => ({ ...c, canvasId: out.canvasIds[i] ?? c.canvasId ?? null }));
    return { id: docId, heading: out.heading, replaced: out.replaced, blocks: body.length, editId, ...(canvases.length ? { canvases } : {}) };
}

/** Whether the doc holds a revision card (read_doc's header). */
export function hasRevisionCard(doc: { id: string; yjsState: Uint8Array | null; cardBlockId: string | null }): boolean {
    const { ydoc, done } = readable(doc);
    try {
        return onNewEditor(ydoc) && findCard(readBlocks(ydoc), doc.cardBlockId) >= 0;
    } finally {
        done();
    }
}

/** Undo of a card edit (agentEdits.service.ts, doc_blocks): the pointer goes back with the blocks. */
export async function undoCardPointer(docId: string | null, data: Record<string, unknown>): Promise<void> {
    const card = data['card'] as { before?: unknown; after?: unknown } | undefined;
    if (!docId || !card || typeof card.after !== 'string') return;
    const before = typeof card.before === 'string' ? card.before : null;
    if (before === card.after) return;
    await prisma.doc.updateMany({ where: { id: docId, cardBlockId: card.after }, data: { cardBlockId: before } });
}

/**
 * GET /api/docs/:id/card → the card as a Y.Doc state the editor draws read-only (its heading, its blocks and their
 * boards), and the review it belongs to: the doc's next pending review (Home's dialog says "Review 2 of 4"; Mark as
 * revised completes it when it is due). 404 when the doc has no card.
 */
export async function readRevisionCard(userId: string, docId: string, now: Date = new Date()) {
    const doc = await findAccessibleDoc(docId, userId);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');
    const { ydoc, done } = readable(doc);
    let card: { heading: string; state: string } | null = null;
    try {
        if (onNewEditor(ydoc)) {
            const top = readBlocks(ydoc);
            const at = findCard(top, doc.cardBlockId);
            if (at >= 0) {
                const section = cardSection(top, at);
                const blocks = top.slice(at, section.end);
                card = { heading: headingText(top[at]!).trim() || CARD_TITLE, state: Buffer.from(stateOfBlocks(ydoc, blocks)).toString('base64') };
            }
        }
    } finally {
        done();
    }
    if (!card) throw new ErrorResponse(404, 'This doc has no revision card');

    const topic = await prisma.topic.findFirst({
        where: { userId, docId },
        select: { id: true, revisions: { orderBy: { cycleNumber: 'asc' }, select: { id: true, cycleNumber: true, scheduledFor: true, status: true } } },
    });
    let review: { revisionId: string; cycle: number; of: number; scheduledFor: string; due: boolean } | null = null;
    const next = topic?.revisions.find((r) => r.status === 'pending');
    if (topic && next) {
        const { today } = await loadLearningContext(userId, now);
        const day = fromDbDay(next.scheduledFor);
        review = { revisionId: next.id, cycle: next.cycleNumber, of: topic.revisions.length, scheduledFor: day, due: day <= today };
    }
    return { docId, title: doc.title, heading: card.heading, state: card.state, topicId: topic?.id ?? null, review };
}
