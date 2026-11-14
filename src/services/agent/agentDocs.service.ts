// Docs for agents (GET/POST /api/agent/docs…): search, read as Markdown, create, append, replace a
// section, and the doc side of Undo. Small answers on purpose (agents pay per token).
//
// Reads use the live doc when an editor has it open (it is ahead of Doc.yjsState by up to 10 s),
// else the stored state. Writes to existing docs go through ./liveDoc.ts (Hocuspocus): only the
// affected top-level blocks are inserted/deleted, in one transaction, and the whole state before
// the change is kept as a DocSnapshot with the change itself, for Undo. A new doc is a plain row
// (nobody can have it open yet).
//
// Canvas blocks (../docs/canvas.ts): reads inject each board into its block (so the Markdown shows
// the ```canvas fence), writes lay out the diagrams of the text form first (../docs/diagram), then
// absorb each board into the doc's canvas maps in the same transaction as the blocks, so Undo
// takes both back. A write that makes canvases answers with a report per canvas (`canvases`).
import type { AgentEdit } from '@prisma/client';
import type { JSONContent } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { prisma } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { generatePreviewState } from '../../utils/previewUtils';
import { canvasIdsIn, canvasTexts, giveCanvasIds, liveCanvasTarget, readBoard, takeCanvasData, withCanvasData, writeBoardDiff, writeBoards } from '../docs/canvas';
import { resolveDiagrams, withCanvasIds, type CanvasReport } from '../docs/diagram/resolve';
import { updateInPlace } from '../docs/diagram/update';
import { accessibleDocWhere, canEditDoc, getDocRole } from '../docs/docPermissions';
import { findAccessibleDoc, normalizeDocTitle } from '../docs/docs.service';
import { yjsStateToDocJson } from '../docs/docContent';
import { DOC_YJS_FRAGMENT } from '../docs/docSchema';
import { docJsonToMarkdown, docJsonToYElements, docJsonToYjsState, markdownToBlocks, markdownToDocJson, nodePlainText } from '../docs/markdown/docMarkdown';
import { createTopic } from '../learningDb/items.service';
import { plural, quoted, recordAgentEdit, type AgentActor } from './agentEditLog';
import { fromBase64, liveDocument, toBase64, undoChange, withLiveDoc, type LiveChange, type LiveDoc } from './liveDoc';

export const SEARCH_LIMIT_DEFAULT = 10;
export const SEARCH_LIMIT_MAX = 50;
/** Docs looked at per search (newest first). */
const SEARCH_SCAN = 1000;
const SNIPPET_LENGTH = 160;
export const AGENT_TITLE_MAX = 200;

// ─── Plain text (search, snippets) ─────────────────────────────────────

/** Each textblock of a doc on its own line (and the words on a canvas board, when injected). */
export function docPlainText(doc: JSONContent): string {
    const lines: string[] = [];
    const walk = (node: JSONContent | undefined) => {
        if (!node || typeof node !== 'object') return;
        const content = Array.isArray(node.content) ? node.content : [];
        if (content.some((child) => child.type === 'text' || child.type === 'hardBreak')) {
            lines.push(nodePlainText(node));
            return;
        }
        if (node.type === 'embed' && node.attrs?.['url']) lines.push(String(node.attrs['url']));
        if (node.type === 'canvas') lines.push(...canvasTexts(node.attrs?.['data']));
        content.forEach(walk);
    };
    walk(doc);
    return lines.filter((line) => line.trim()).join('\n');
}

function storedText(yjsState: string | null): string {
    if (!yjsState) return '';
    try {
        return docPlainText(yjsStateToDocJson(yjsState) as JSONContent);
    } catch {
        return '';
    }
}

/** docId → plain text, valid while Doc.updatedAt is unchanged (decoding Yjs states is the cost). */
const textCache = new Map<string, { updatedAt: number; text: string }>();
const TEXT_CACHE_MAX = 1000;

async function docTexts(rows: ReadonlyArray<{ id: string; updatedAt: Date }>): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    const missing: string[] = [];
    for (const row of rows) {
        const hit = textCache.get(row.id);
        if (hit && hit.updatedAt === row.updatedAt.getTime()) texts.set(row.id, hit.text);
        else missing.push(row.id);
    }
    for (let i = 0; i < missing.length; i += 50) {
        const batch = await prisma.doc.findMany({ where: { id: { in: missing.slice(i, i + 50) } }, select: { id: true, yjsState: true, updatedAt: true } });
        for (const doc of batch) {
            const text = storedText(doc.yjsState);
            textCache.delete(doc.id);
            textCache.set(doc.id, { updatedAt: doc.updatedAt.getTime(), text });
            if (textCache.size > TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value!);
            texts.set(doc.id, text);
        }
    }
    return texts;
}

function snippetOf(text: string, terms: readonly string[]): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    const lower = flat.toLowerCase();
    const first = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    const start = first === undefined ? 0 : Math.max(0, first - 50);
    const end = Math.min(flat.length, start + SNIPPET_LENGTH);
    return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/** The subject of each doc the user filed as a topic. */
async function subjectsOf(userId: string, docIds: readonly string[]): Promise<Map<string, { id: string; name: string }>> {
    if (docIds.length === 0) return new Map();
    const topics = await prisma.topic.findMany({
        where: { userId, docId: { in: [...docIds] } },
        select: { docId: true, subject: { select: { id: true, name: true } } },
    });
    return new Map(topics.filter((t) => t.docId).map((t) => [t.docId!, t.subject]));
}

// ─── Search + read ─────────────────────────────────────────────────────

export interface AgentDocListItem {
    id: string;
    title: string;
    subject: string | null;
    updatedAt: Date;
    snippet: string;
}

/**
 * GET /api/agent/docs?query=&limit=: the user's own and shared-with-them docs (not archived) whose
 * title or text contains every word of the query (case-insensitive). Title matches first, then
 * newest. No query: the most recently updated docs.
 */
export async function searchDocsForAgent(userId: string, options: { query?: string | undefined; limit?: number | undefined }): Promise<AgentDocListItem[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? SEARCH_LIMIT_DEFAULT), 1), SEARCH_LIMIT_MAX);
    const terms = [...new Set((options.query ?? '').toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
    const rows = await prisma.doc.findMany({
        where: { ...accessibleDocWhere(userId), isArchived: false },
        select: { id: true, title: true, updatedAt: true },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: SEARCH_SCAN,
    });
    const candidates = terms.length === 0 ? rows.slice(0, limit) : rows;
    const texts = await docTexts(candidates);

    const matches: Array<{ row: (typeof rows)[number]; text: string; score: number }> = [];
    for (const row of candidates) {
        const text = texts.get(row.id) ?? '';
        const title = row.title.toLowerCase();
        const haystack = `${title}\n${text.toLowerCase()}`;
        if (!terms.every((t) => haystack.includes(t))) continue;
        matches.push({ row, text, score: terms.filter((t) => title.includes(t)).length });
    }
    matches.sort((a, b) => b.score - a.score || b.row.updatedAt.getTime() - a.row.updatedAt.getTime() || (a.row.id < b.row.id ? 1 : -1));
    const top = matches.slice(0, limit);
    const subjects = await subjectsOf(userId, top.map((m) => m.row.id));
    return top.map(({ row, text }) => ({
        id: row.id,
        title: row.title,
        subject: subjects.get(row.id)?.name ?? null,
        updatedAt: row.updatedAt,
        snippet: snippetOf(text, terms),
    }));
}

/**
 * The doc's current content (the live doc when it is open) and title, canvas boards injected.
 * Recall mode reads docs this way too.
 */
export function currentContent(doc: { id: string; title: string; yjsState: string | null }): { json: JSONContent; title: string } {
    const live = liveDocument(doc.id);
    if (live) {
        const metaTitle = live.getMap('metadata').get('title');
        return {
            json: withCanvasData(yXmlFragmentToProsemirrorJSON(live.getXmlFragment(DOC_YJS_FRAGMENT)) as JSONContent, live),
            title: typeof metaTitle === 'string' && metaTitle.trim() ? metaTitle.trim() : doc.title,
        };
    }
    return { json: doc.yjsState ? (yjsStateToDocJson(doc.yjsState) as JSONContent) : { type: 'doc', content: [] }, title: doc.title };
}

/** GET /api/agent/docs/:id → { id, title, markdown, subject, topicId, updatedAt, canEdit }. */
export async function readDocForAgent(userId: string, docId: string) {
    const doc = await findAccessibleDoc(docId, userId);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');
    const role = getDocRole(doc, userId);
    const { json, title } = currentContent(doc);
    const subject = (await subjectsOf(userId, [doc.id])).get(doc.id) ?? null;
    const topic = await prisma.topic.findUnique({ where: { userId_docId: { userId, docId: doc.id } }, select: { id: true } });
    return {
        id: doc.id,
        title,
        markdown: docJsonToMarkdown(json),
        subject,
        topicId: topic?.id ?? null,
        updatedAt: doc.updatedAt,
        canEdit: role === 'owner' || role === 'editor',
    };
}

// ─── Create ────────────────────────────────────────────────────────────

export interface CreateAgentDocInput {
    title: string;
    markdown: string;
    subjectId?: string | undefined;
    /** Start the revision schedule (1, 3, 7, 21 days); needs subjectId. */
    revise?: boolean | undefined;
    /** false: don't refuse a ```mermaid block Mermaid can't parse (AI practice notes; agents always check). */
    checkMermaid?: boolean | undefined;
}

/** A doc made by createDocFromMarkdown. */
export interface CreatedDoc {
    id: string;
    title: string;
    subject: { id: string; name: string } | null;
    topicId: string | null;
    /** The first revision's day ('YYYY-MM-DD') when `revise` started the schedule. */
    nextRevision: string | null;
    /** A report per canvas in the Markdown (only when it has canvases). */
    canvases?: CanvasReport[];
}

/** `{ canvases }` for an answer, or nothing when the Markdown made no canvas. */
const canvasesField = (reports: readonly CanvasReport[], ids: readonly string[]): { canvases?: CanvasReport[] } =>
    reports.length > 0 ? { canvases: withCanvasIds(reports, ids) } : {};

/**
 * A new doc from Markdown, made as the app makes docs (a plain row: nobody can have it open yet).
 * With subjectId it is filed under that subject (a Topic, created by the learning service exactly
 * as the app does); with revise it also enters the revision schedule. `then` runs last (the agent
 * API logs its edit there). All or nothing: if anything fails, the doc and its topic go again.
 * Errors: 400 (empty or long title, revise without a subject, Markdown a doc can't hold), 404 subject.
 * Used by POST /api/agent/docs and by practice notes (src/services/practice).
 */
export async function createDocFromMarkdown(userId: string, input: CreateAgentDocInput, then?: (doc: CreatedDoc) => Promise<void>): Promise<CreatedDoc> {
    const title = normalizeDocTitle(input.title);
    if (title.length > AGENT_TITLE_MAX) throw new ErrorResponse(400, `A title is at most ${AGENT_TITLE_MAX} characters`);
    if (input.revise && !input.subjectId) throw new ErrorResponse(400, 'revise needs a subjectId (the subject to revise it under)');
    const json = markdownToDocJson(input.markdown);
    const subject = input.subjectId
        ? await prisma.subject.findFirst({ where: { id: input.subjectId, userId }, select: { id: true, name: true } })
        : null;
    if (input.subjectId && !subject) throw new ErrorResponse(404, 'Subject not found');
    const reports = await resolveDiagrams(json, { checkMermaid: input.checkMermaid !== false });
    // Ids now (a new doc keeps them), so the reports can name their canvases.
    const canvasIds = giveCanvasIds(json);

    // The title also goes into the doc's metadata map, as the editor keeps it.
    const yjsState = docJsonToYjsState(json, { title, coverImage: null });
    const doc = await prisma.doc.create({
        data: { userId, title, docType: 'notes', yjsState, previewState: generatePreviewState(yjsState), cloudImages: [] },
        select: { id: true, title: true },
    });

    let topicId: string | null = null;
    try {
        let nextRevision: string | null = null;
        if (subject) {
            const created = await createTopic(userId, { docId: doc.id, subjectId: subject.id, startRevisions: input.revise === true });
            topicId = created.topic._id;
            nextRevision = created.chain.find((r) => r.status === 'pending')?.scheduledFor ?? null;
        }
        const made: CreatedDoc = { id: doc.id, title: doc.title, subject, topicId, nextRevision, ...canvasesField(reports, canvasIds) };
        if (then) await then(made);
        return made;
    } catch (err) {
        // No half-made doc without its topic (or its log line). The topic goes first (deleting a
        // doc only unlinks its topic: Topic.docId is SET NULL).
        if (topicId) await prisma.topic.deleteMany({ where: { id: topicId, userId } });
        await prisma.doc.deleteMany({ where: { id: doc.id } });
        throw err;
    }
}

/** POST /api/agent/docs: createDocFromMarkdown plus the agent edit log line (Undo archives it). */
export async function createDocForAgent(actor: AgentActor, input: CreateAgentDocInput) {
    let editId = '';
    // Agents always get the Mermaid check, whatever the request carried.
    const doc = await createDocFromMarkdown(actor.userId, { ...input, checkMermaid: true }, async (made) => {
        const summary = `Created ${quoted(made.title)}${made.subject ? ` in ${made.subject.name}` : ''}${input.revise ? ' and scheduled it for revision' : ''}`;
        editId = await recordAgentEdit(actor, { kind: 'doc_create', summary, docId: made.id, entityId: made.id, undoData: { topicId: made.topicId } });
    });
    return { ...doc, editId };
}

// ─── Append / replace a section ───────────────────────────────────────

export async function requireEditableDoc(docId: string, userId: string) {
    const doc = await findAccessibleDoc(docId, userId);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');
    if (!canEditDoc(doc, userId)) throw new ErrorResponse(403, 'Viewers cannot edit this document');
    return doc;
}

function blocksOrThrow(markdown: string): JSONContent[] {
    const blocks = markdownToBlocks(markdown);
    if (blocks.length === 0) throw new ErrorResponse(400, 'markdown is empty');
    return blocks;
}

function describeBlocks(blocks: readonly JSONContent[]): string {
    return plural(blocks.length, blocks.every((b) => b.type === 'paragraph') ? 'paragraph' : 'block');
}

/** Keep the snapshot + log line; if that fails, take the live change back and fail. */
export async function logDocChange(
    actor: AgentActor,
    docId: string,
    change: LiveChange,
    kind: 'doc_append' | 'doc_replace_section' | 'doc_canvas_update',
    summary: string
): Promise<string> {
    try {
        return await prisma.$transaction(async (tx) => {
            const snapshot = await tx.docSnapshot.create({
                data: { docId, yjsState: toBase64(change.before), agentUpdate: change.update ? toBase64(change.update) : null },
                select: { id: true },
            });
            return recordAgentEdit(actor, { kind, summary, docId, entityId: docId, snapshotId: snapshot.id }, tx);
        });
    } catch (err) {
        await withLiveDoc(docId, actor.agentName, (live) => undoChange(live, change.before, change.update)).catch((revertErr) =>
            console.error(`[agent] could not take back an unlogged change to doc ${docId}:`, revertErr)
        );
        throw err;
    }
}

/** An empty paragraph (the editor keeps one at the end of a doc). */
function isEmptyParagraph(node: JSONContent | undefined): boolean {
    return node?.type === 'paragraph' && !nodePlainText(node).trim() && !(node.content ?? []).some((c) => c.type !== 'text');
}

/**
 * New blocks for a live doc: canvas boards absorbed against it (fresh ids; the boards to write in
 * the same transaction as the blocks), then encoded as Y elements. `reuse`: canvas ids the blocks
 * take over from blocks they replace (an update in place keeps its board's id).
 */
function liveBlocks(live: LiveDoc, current: readonly JSONContent[], blocks: JSONContent[], reuse: ReadonlySet<string> = new Set()) {
    const target = liveCanvasTarget(live.doc, current);
    const seen = [...(target.seen ?? [])].filter((id) => !reuse.has(id));
    const { json, boards } = takeCanvasData<JSONContent>({ type: 'doc', content: blocks }, { ...target, seen });
    return { elements: docJsonToYElements(json), boards, canvasIds: canvasIdsIn(json) };
}

/**
 * POST /api/agent/docs/:id/append: the blocks go at the end of the doc (before its trailing empty
 * paragraph, if any), live.
 */
export async function appendToDocForAgent(actor: AgentActor, docId: string, markdown: string) {
    const doc = await requireEditableDoc(docId, actor.userId);
    const blocks = blocksOrThrow(markdown);
    const reports = await resolveDiagrams({ type: 'doc', content: blocks });

    const { change, canvasIds } = await withLiveDoc(docId, actor.agentName, (live) => {
        const current = (yXmlFragmentToProsemirrorJSON(live.fragment) as JSONContent).content ?? [];
        const at = isEmptyParagraph(current[current.length - 1]) ? current.length - 1 : current.length;
        const { elements, boards, canvasIds } = liveBlocks(live, current, blocks);
        const change = live.apply((fragment) => {
            fragment.insert(at, elements);
            writeBoards(fragment.doc!, boards);
        });
        return { change, canvasIds };
    });
    const editId = await logDocChange(actor, docId, change, 'doc_append', `Appended ${describeBlocks(blocks)} to ${quoted(doc.title)}`);
    return { id: docId, appended: blocks.length, editId, ...canvasesField(reports, canvasIds) };
}

/** Heading text as matched: no leading #'s, no emphasis marks, single spaces, lower case. */
export function normalizeHeading(text: string): string {
    return text
        .replace(/^\s*#{1,6}\s*/, '')
        .replace(/\s+#+\s*$/, '')
        .replace(/[*_`~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

export interface SectionRange {
    /** Index of the heading among the doc's top-level blocks. */
    heading: number;
    /** First block after the section (the next heading of the same or a higher level, or the end). */
    end: number;
    level: number;
    text: string;
}

/** The first top-level heading whose text matches, and the blocks under it. */
export function findSection(blocks: readonly JSONContent[], heading: string): SectionRange | null {
    const target = normalizeHeading(heading);
    for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i]!;
        if (block.type !== 'heading' || normalizeHeading(nodePlainText(block)) !== target) continue;
        const level = Number(block.attrs?.['level']) || 1;
        let end = i + 1;
        while (end < blocks.length) {
            const next = blocks[end]!;
            if (next.type === 'heading' && (Number(next.attrs?.['level']) || 1) <= level) break;
            end += 1;
        }
        return { heading: i, end, level, text: nodePlainText(block).trim() };
    }
    return null;
}

const IMAGE_TYPES = new Set(['resizableImage', 'image']);
/** Attrs Markdown can't carry: they tie an image node to its uploaded file (Doc.cloudImages). */
const IMAGE_TRACKING = ['imageId', 'cloudPublicId', 'cloudProvider', 'width', 'height'] as const;

function imagesBySrc(blocks: readonly JSONContent[]): Map<string, Record<string, unknown>> {
    const found = new Map<string, Record<string, unknown>>();
    const walk = (node: JSONContent) => {
        const src = node.attrs?.['src'];
        if (IMAGE_TYPES.has(node.type ?? '') && typeof src === 'string' && src && !found.has(src)) found.set(src, node.attrs!);
        (node.content ?? []).forEach(walk);
    };
    blocks.forEach(walk);
    return found;
}

/**
 * An image the agent kept (same src) keeps its upload tracking, so the orphan cleanup never
 * deletes a file the doc still shows.
 */
function keepImageTracking(blocks: readonly JSONContent[], removed: readonly JSONContent[]): JSONContent[] {
    const old = imagesBySrc(removed);
    if (old.size === 0) return [...blocks];
    const visit = (node: JSONContent): JSONContent => {
        const src = node.attrs?.['src'];
        const previous = IMAGE_TYPES.has(node.type ?? '') && typeof src === 'string' ? old.get(src) : undefined;
        const attrs = previous && !node.attrs?.['imageId'] ? { ...node.attrs, ...Object.fromEntries(IMAGE_TRACKING.map((k) => [k, previous[k] ?? node.attrs?.[k] ?? null])) } : node.attrs;
        return { ...node, ...(attrs ? { attrs } : {}), ...(node.content ? { content: node.content.map(visit) } : {}) };
    };
    return blocks.map(visit);
}

function headingNotFound(heading: string, blocks: readonly JSONContent[]): ErrorResponse {
    const headings = blocks.filter((b) => b.type === 'heading').map((b) => quoted(nodePlainText(b), 60)).slice(0, 30);
    const list = headings.length > 0 ? ` Its headings: ${headings.join(', ')}.` : ' It has no headings.';
    return new ErrorResponse(404, `Heading ${quoted(heading.replace(/^\s*#{1,6}\s*/, ''), 100)} not found in this doc.${list}`);
}

/**
 * POST /api/agent/docs/:id/replace-section {heading, markdown}: replaces the section under the
 * first top-level heading with that text (case-insensitive, trimmed) up to the next heading of
 * the same or a higher level. When `markdown` starts with a heading of the same or a higher level,
 * it replaces the heading too (so it can rename it); otherwise the heading stays and only the
 * body is replaced. 404 (listing the doc's headings) when there is no such heading.
 * A canvas fence whose `%% id` names a canvas of the replaced section updates that board in
 * place (same id, Ramin's arrangement kept; ../docs/diagram/update.ts); other canvases are new.
 */
export async function replaceSectionForAgent(actor: AgentActor, docId: string, heading: string, markdown: string) {
    if (!normalizeHeading(heading)) throw new ErrorResponse(400, 'heading is required');
    const doc = await requireEditableDoc(docId, actor.userId);
    const blocks = blocksOrThrow(markdown);
    // Checked on the current content first, so a wrong heading never opens (or stores) the doc.
    const before = currentContent(doc).json.content ?? [];
    if (!findSection(before, heading)) throw headingNotFound(heading, before);
    const reports = await resolveDiagrams({ type: 'doc', content: blocks });
    const first = blocks[0]!;

    const { change, section, removed, canvasIds, updates } = await withLiveDoc(docId, actor.agentName, (live) => {
        const current = (yXmlFragmentToProsemirrorJSON(live.fragment) as JSONContent).content ?? [];
        const section = findSection(current, heading);
        if (!section) throw headingNotFound(heading, current);
        const replacesHeading = first.type === 'heading' && (Number(first.attrs?.['level']) || 1) <= section.level;
        const from = replacesHeading ? section.heading : section.heading + 1;
        const removed = section.end - from;
        const replaced = current.slice(from, section.end);
        // A fence naming a board of this section updates it in place (its id, as a diff, merged
        // with the board as it is right now). Any other canvas is a new board (fresh id); the old
        // block's board stays in its maps, so Undo brings the old canvas back whole.
        const updates = updateInPlace(blocks, replaced, (canvasId) => readBoard(live.doc, canvasId));
        const reuse = new Set(updates.map((u) => u.canvasId));
        const { elements, boards, canvasIds } = liveBlocks(live, current, keepImageTracking(blocks, replaced), reuse);
        const change = live.apply((fragment) => {
            if (removed > 0) fragment.delete(from, removed);
            fragment.insert(from, elements);
            writeBoards(fragment.doc!, boards);
            for (const u of updates) writeBoardDiff(fragment.doc!, u.canvasId, u.board);
        });
        return { change, section, removed, canvasIds, updates };
    });
    const editId = await logDocChange(actor, docId, change, 'doc_replace_section', `Rewrote section ${quoted(section.text)} in ${quoted(doc.title)}`);
    const final = reports.map((report, i) => updates.find((u) => u.index === i)?.report ?? report);
    return { id: docId, heading: section.text, removed, inserted: blocks.length, editId, ...canvasesField(final, canvasIds) };
}

// ─── Undo (doc kinds) ──────────────────────────────────────────────────

/** Undo an append / replace-section, live: exactly the agent's change goes (later typing stays). */
export async function undoDocChange(userId: string, edit: Pick<AgentEdit, 'docId' | 'snapshotId'>): Promise<void> {
    if (!edit.docId || !edit.snapshotId) throw new ErrorResponse(409, 'This edit cannot be undone (no snapshot)');
    const doc = await findAccessibleDoc(edit.docId, userId);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');
    if (!canEditDoc(doc, userId)) throw new ErrorResponse(403, 'Viewers cannot edit this document');
    const snapshot = await prisma.docSnapshot.findFirst({ where: { id: edit.snapshotId, docId: edit.docId } });
    if (!snapshot) throw new ErrorResponse(409, 'This edit cannot be undone (no snapshot)');
    await withLiveDoc(edit.docId, 'undo', (live) =>
        undoChange(live, fromBase64(snapshot.yjsState), snapshot.agentUpdate ? fromBase64(snapshot.agentUpdate) : null)
    );
}

/** Undo a doc the agent created: archive it, and drop its topic unless it was already revised. */
export async function undoDocCreate(userId: string, edit: Pick<AgentEdit, 'docId' | 'undoData'>, now: Date = new Date()): Promise<void> {
    if (!edit.docId) return;
    await prisma.doc.updateMany({ where: { id: edit.docId, userId }, data: { isArchived: true, updatedAt: now } });
    const topicId = (edit.undoData as { topicId?: unknown } | null)?.topicId;
    if (typeof topicId === 'string') {
        const revised = await prisma.revision.count({ where: { topicId, status: 'done' } });
        if (revised === 0) await prisma.topic.deleteMany({ where: { id: topicId, userId } });
    }
}
