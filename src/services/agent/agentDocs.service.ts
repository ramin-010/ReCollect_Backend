// Docs for agents (GET/POST /api/agent/docs…): search (on ../docs/docSearch.service.ts), read as
// Markdown, create, append, replace a section, and the doc side of Undo. Small answers on purpose
// (agents pay per token).
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
import { assertParentForNewPage, lessonOf, moveDoc, nextPosition, pagesInside, pagesOf, placeAt, trailFor, type MoveResult } from '../docs/docTree.service';
import { accessibleDocWhere } from '../docs/docPermissions';
import { searchTextOf } from '../docs/docSearch.service';
import type { AgentEdit, Prisma } from '@prisma/client';
import { hasRevisionCard } from './docCard';
import type { JSONContent } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { prisma } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { generatePreviewState } from '../../utils/previewUtils';
import { canvasIdsIn, giveCanvasIds, liveCanvasTarget, readBoard, takeCanvasData, withCanvasData, writeBoardDiff, writeBoards } from '../docs/canvas';
import { resolveDiagrams, withCanvasIds, type CanvasReport } from '../docs/diagram/resolve';
import { updateInPlace } from '../docs/diagram/update';
import { canEditDoc, getDocRole } from '../docs/docPermissions';
import { findAccessibleDoc, normalizeDocTitle } from '../docs/docs.service';
import { searchDocs } from '../docs/docSearch.service';
import { restoreDoc, trashDoc } from '../docs/trash.service';
import { yjsStateToDocJson } from '../docs/docContent';
import { DOC_YJS_FRAGMENT } from '../docs/docSchema';
import { docJsonToMarkdown, docJsonToYElements, docJsonToYjsState, markdownToBlocks, markdownToDocJson, nodePlainText } from '../docs/markdown/docMarkdown';
import { createTopic } from '../learningDb/items.service';
import { attachDocToTopic, detachDocFromTopic, type TopicBeforeAttach } from '../learningDb/path.service';
import { plural, quoted, recordAgentEdit, type AgentActor } from './agentEditLog';
import { hasBlocks, readBlocks } from '../docs/blocks/serverEditor';
import { blocksToOldJson } from '../docs/blocks/toOldJson';
import { appendBlocksForAgent, appendNoteInBlocks, canvasIdsOf, docUsesBlocks, renameCanvases, replaceSectionInBlocks } from './agentBlocks.service';
import { loadLearningContext } from '../learningDb/common';
import { NOTE_MAX, afterIndex, footerDay, noteFooter, noteRepeats, noteTooLong } from './docNotes';
import { markdownToBlocks as markdownToEditorBlocks } from '../docs/blocks/markdown';
import { blocksDocState } from '../docs/blocks/newDocState';
import { liveDocument, undoChange, withLiveDoc, type LiveChange, type LiveDoc } from './liveDoc';
import { stateBytes, type DocState } from '../docs/docState';

export { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX } from '../docs/docSearch.service';
export const AGENT_TITLE_MAX = 200;

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
    /** DOC_PAGES_PLAN §3.4: the titles of the docs above it, root first. */
    path: string[];
}

/**
 * GET /api/agent/docs?query=&limit=: the user's own and shared-with-them docs (not archived) that
 * match the query on Postgres full-text, best first (../docs/docSearch.service.ts). No query: the
 * most recently updated docs.
 */
export async function searchDocsForAgent(userId: string, options: { query?: string | undefined; limit?: number | undefined }): Promise<AgentDocListItem[]> {
    const hits = await searchDocs(userId, options);
    const subjects = await subjectsOf(userId, hits.map((h) => h.id));
    return hits.map((hit) => ({
        id: hit.id,
        title: hit.title,
        subject: subjects.get(hit.id)?.name ?? null,
        updatedAt: hit.updatedAt,
        snippet: hit.snippet,
        path: hit.path,
    }));
}

/**
 * The doc's current content (the live doc when it is open) and title, canvas boards injected.
 * Recall mode reads docs this way too.
 */
export function currentContent(doc: { id: string; title: string; yjsState: DocState | null }): { json: JSONContent; title: string } {
    const live = liveDocument(doc.id);
    if (live) {
        const metaTitle = live.getMap('metadata').get('title');
        // A doc on the new editor reads from its blocks (as old JSON, for every reader written for it).
        const content = hasBlocks(live) ? blocksToOldJson(readBlocks(live)) : (yXmlFragmentToProsemirrorJSON(live.getXmlFragment(DOC_YJS_FRAGMENT)) as JSONContent);
        return {
            json: withCanvasData(content, live),
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
    // STUDY_FLOW_PLAN: whether it has a revision card, and how many notes and links its lesson holds.
    // DOC_PAGES_PLAN §3.4 (D5): a page inside a lesson is revised with it; its notes are the lesson's.
    const lesson = topic ? null : await lessonOf(doc.id, userId);
    const notes = topic || lesson ? await prisma.capture.count({ where: { userId, topicId: topic?.id ?? lesson!.topicId } }) : 0;
    // DOC_PAGES_PLAN §3.4: where it sits (the docs above it they can open) and the pages inside it.
    const [path, pages] = await Promise.all([trailFor(doc.id, userId), pagesOf(doc.id, userId)]);
    return {
        id: doc.id,
        title,
        path,
        pages: pages.map((p) => ({ id: p.id, title: p.title, pages: p.pages })),
        lesson: lesson ? { docId: lesson.docId, title: lesson.title } : null,
        markdown: docJsonToMarkdown(json),
        subject,
        topicId: topic?.id ?? null,
        updatedAt: doc.updatedAt,
        canEdit: role === 'owner' || role === 'editor',
        card: hasRevisionCard(doc),
        notes,
    };
}

// ─── Create ────────────────────────────────────────────────────────────

export interface CreateAgentDocInput {
    title: string;
    markdown: string;
    subjectId?: string | undefined;
    /** A topic planned on a path: the doc becomes its note instead of a new topic (its subject is the topic's). */
    topicId?: string | undefined;
    /** Start the revision schedule (1, 3, 7, 21 days); needs subjectId or topicId. */
    revise?: boolean | undefined;
    /** false: don't refuse a ```mermaid block Mermaid can't parse (AI practice notes; agents always check). */
    checkMermaid?: boolean | undefined;
    /** DOC_PAGES_PLAN: a page inside this doc (the user's own, not in the trash). */
    parentId?: string | undefined;
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
    /** With topicId: the topic's status now ('in_progress', or 'done' with revise). */
    topicStatus?: string;
}

/** createDocFromMarkdown's result, with what Undo needs (never sent to a client). */
type MadeDoc = CreatedDoc & { attached?: TopicBeforeAttach };

/** `{ canvases }` for an answer, or nothing when the Markdown made no canvas. */
const canvasesField = (reports: readonly CanvasReport[], ids: readonly string[]): { canvases?: CanvasReport[] } =>
    reports.length > 0 ? { canvases: withCanvasIds(reports, ids) } : {};

/**
 * A new doc from Markdown, made as the app makes docs (a plain row: nobody can have it open yet).
 * With subjectId it is filed under that subject (a Topic, created by the learning service exactly
 * as the app does); with topicId it becomes the note of that planned topic instead (path.service
 * attachDocToTopic); with revise it also enters the revision schedule. `then` runs last (the agent
 * API logs its edit there). All or nothing: if anything fails, the doc goes again and its topic is
 * deleted (a new one) or put back as it was (an attached one).
 * Errors: 400 (empty or long title, revise without a subject or topic, Markdown a doc can't hold,
 * a topic with a doc or in another subject), 404 subject or topic.
 * Used by POST /api/agent/docs and by practice notes (src/services/practice).
 */
export async function createDocFromMarkdown(userId: string, input: CreateAgentDocInput, then?: (doc: MadeDoc) => Promise<void>): Promise<MadeDoc> {
    const title = normalizeDocTitle(input.title);
    if (title.length > AGENT_TITLE_MAX) throw new ErrorResponse(400, `A title is at most ${AGENT_TITLE_MAX} characters`);
    if (input.revise && !input.subjectId && !input.topicId) throw new ErrorResponse(400, 'revise needs a subjectId (the subject to revise it under) or a topicId');
    // DOC_PAGES_PLAN §3.4 (D5): a page inside a lesson has no schedule of its own.
    if (input.parentId && (input.subjectId || input.topicId || input.revise)) {
        const lesson = await lessonOf(input.parentId, userId);
        if (lesson) throw new ErrorResponse(400, `A page inside the lesson ${quoted(lesson.title)} is revised with it: leave out subject, topicId and revise.`);
    }
    const subject = input.subjectId
        ? await prisma.subject.findFirst({ where: { id: input.subjectId, userId }, select: { id: true, name: true } })
        : null;
    if (input.subjectId && !subject) throw new ErrorResponse(404, 'Subject not found');
    if (input.topicId) {
        // Refuse a wrong topic before anything is made (attachDocToTopic checks again under a lock).
        const topic = await prisma.topic.findFirst({ where: { id: input.topicId, userId, isArchived: false }, select: { docId: true, subjectId: true } });
        if (!topic) throw new ErrorResponse(404, `No topic with id ${input.topicId} (get_path shows them)`);
        if (topic.docId) throw new ErrorResponse(400, `Topic ${input.topicId} already has a doc (${topic.docId}): write into that doc, or plan a new topic`);
        if (subject && topic.subjectId !== subject.id) throw new ErrorResponse(400, `Topic ${input.topicId} is not on the path of "${subject.name}"`);
    }
    // Since the switch (DOCS_EDITOR_V2_PLAN phase 4) a new doc is made on the new editor: its blocks,
    // their boards and the title in the metadata map. A bad diagram or Markdown is a 400 here, before
    // anything is made. Canvas ids now (a new doc keeps them), so the reports can name their canvases.
    const parsed = await markdownToEditorBlocks(input.markdown, {}, { checkMermaid: input.checkMermaid !== false });
    const { blocks, boards } = renameCanvases(parsed.blocks, parsed.boards, new Set());
    const reports = parsed.canvases;
    const canvasIds = canvasIdsOf(blocks);
    const yjsState = blocksDocState(blocks, boards, { title, coverImage: null });
    // DOC_PAGES_PLAN §3.4: a page goes after its parent's last page, shared with the parent's people (D6).
    const parent = input.parentId ? await assertParentForNewPage(userId, input.parentId) : null;
    const doc = await prisma.doc.create({
        data: { userId, title, yjsState, previewState: generatePreviewState(yjsState), cloudImages: [], ...(parent ? { parentId: parent.id, position: await nextPosition(parent.id) } : {}) },
        select: { id: true, title: true },
    });
    if (parent) {
        const people = await prisma.docCollaborator.findMany({ where: { docId: parent.id }, select: { userId: true, role: true } });
        if (people.length) await prisma.docCollaborator.createMany({ data: people.map((p) => ({ docId: doc.id, userId: p.userId, role: p.role })), skipDuplicates: true });
    }

    let topicId: string | null = null;
    let attached: TopicBeforeAttach | undefined;
    try {
        let nextRevision: string | null = null;
        let filedUnder = subject;
        let topicStatus: string | undefined;
        if (input.topicId) {
            const result = await attachDocToTopic(userId, { topicId: input.topicId, docId: doc.id, title: doc.title, revise: input.revise === true, subjectId: subject?.id });
            attached = result.before;
            topicId = input.topicId;
            filedUnder = result.subject;
            nextRevision = result.nextRevision;
            topicStatus = result.status;
        } else if (subject) {
            const created = await createTopic(userId, { docId: doc.id, subjectId: subject.id, startRevisions: input.revise === true });
            topicId = created.topic._id;
            nextRevision = created.chain.find((r) => r.status === 'pending')?.scheduledFor ?? null;
        }
        const made: MadeDoc = {
            id: doc.id,
            title: doc.title,
            subject: filedUnder,
            topicId,
            nextRevision,
            ...(topicStatus ? { topicStatus } : {}),
            ...canvasesField(reports, canvasIds),
            ...(attached ? { attached } : {}),
        };
        if (then) await then(made);
        return made;
    } catch (err) {
        // No half-made doc without its topic (or its log line). The topic goes first (deleting a
        // doc only unlinks its topic: Topic.docId is SET NULL); an attached one is put back.
        if (attached) await detachDocFromTopic(userId, attached).catch(() => {});
        else if (topicId) await prisma.topic.deleteMany({ where: { id: topicId, userId } });
        await prisma.doc.deleteMany({ where: { id: doc.id } });
        throw err;
    }
}

/** POST /api/agent/docs: createDocFromMarkdown plus the agent edit log line (Undo archives it). */
export async function createDocForAgent(actor: AgentActor, input: CreateAgentDocInput) {
    let editId = '';
    let parentTitle: string | null = null;
    // Agents always get the Mermaid check, whatever the request carried.
    const { attached: _undoOnly, ...doc } = await createDocFromMarkdown(actor.userId, { ...input, checkMermaid: true }, async (made) => {
        const onPath = made.attached ? ' as a topic of its path' : '';
        const inside = input.parentId ? (await prisma.doc.findUnique({ where: { id: input.parentId }, select: { title: true } }))?.title : null;
        parentTitle = inside ?? null;
        const summary = `Created ${quoted(made.title)}${inside ? ` inside ${quoted(inside, 60)}` : ''}${made.subject ? ` in ${made.subject.name}` : ''}${onPath}${input.revise ? ' and scheduled it for revision' : ''}`;
        const undoData = made.attached ? { topicId: made.topicId, attached: { ...made.attached } } : { topicId: made.topicId };
        editId = await recordAgentEdit(actor, { kind: 'doc_create', summary, docId: made.id, entityId: made.id, undoData });
    });
    // DOC_PAGES_PLAN §6.2: the doc it went inside, so the answer can name it.
    return { ...doc, editId, ...(input.parentId ? { parent: { id: input.parentId, title: parentTitle } } : {}) };
}

// ─── Update: title, subject, topic (update_doc) ───────────────────────

export interface UpdateAgentDocInput {
    title?: string | undefined;
    /** File it under this subject (a topic made, or its topic moved there). */
    subjectId?: string | undefined;
    /** Make it the note of this planned topic (see attachDocToTopic). */
    topicId?: string | undefined;
    /** DOC_PAGES_PLAN §3.4: move it inside this doc (null: the top level). */
    parentId?: string | null | undefined;
    /** A page of the parent to go after, or 'start'. */
    after?: string | undefined;
}

/** What Undo of a doc_update puts back. */
interface DocUpdateUndo {
    /** The title before and after: Undo restores `from` only while the doc still has `to`. */
    title?: { from: string; to: string };
    /** A topic made to file the doc (Undo deletes it while it has no revisions). */
    createdTopic?: string;
    /** A topic moved to another subject (Undo moves it back to its old place). */
    moved?: { topicId: string; subjectId: string; sortOrder: number | null };
    /** A planned topic the doc became the note of. */
    attached?: TopicBeforeAttach;
    /** A move (DOC_PAGES_PLAN §3.4): Undo puts it back while it is still where the move put it. */
    parent?: { from: { parentId: string | null; position: number }; to: { parentId: string | null } };
}

/** The doc's title, live: an open editor shows it at once; the store copies it to the row. */
async function setDocTitle(docId: string, actor: string, title: string): Promise<void> {
    await withLiveDoc(docId, actor, (live) => live.apply(() => live.doc.getMap('metadata').set('title', title)));
    await prisma.doc.updateMany({ where: { id: docId }, data: { title } });
}

/**
 * PATCH /api/agent/docs/:id {title?, subjectId?, topicId?}: rename a doc (live), file it under a
 * subject, or make it the note of a planned topic. Everything is checked before anything changes.
 * Nothing to change answers editId null. 400 / 404 / 409 as attachDocToTopic and createTopic.
 */
export async function updateDocForAgent(actor: AgentActor, docId: string, input: UpdateAgentDocInput) {
    const userId = actor.userId;
    const doc = await requireEditableDoc(docId, userId);
    const current = currentContent(doc).title;
    const title = input.title !== undefined ? normalizeDocTitle(input.title) : undefined;
    if (title !== undefined && !title) throw new ErrorResponse(400, 'title cannot be empty');
    if (title !== undefined && title.length > AGENT_TITLE_MAX) throw new ErrorResponse(400, `A title is at most ${AGENT_TITLE_MAX} characters`);

    const existing = await prisma.topic.findUnique({
        where: { userId_docId: { userId, docId } },
        select: { id: true, subjectId: true, sortOrder: true, subject: { select: { name: true } } },
    });
    const subject = input.subjectId ? await prisma.subject.findFirst({ where: { id: input.subjectId, userId }, select: { id: true, name: true } }) : null;
    if (input.subjectId && !subject) throw new ErrorResponse(404, 'Subject not found');
    if (input.topicId && existing && existing.id !== input.topicId) {
        throw new ErrorResponse(409, `This doc is already topic ${existing.id} in "${existing.subject.name}" (a doc is on one path once)`);
    }

    const undo: DocUpdateUndo = {};
    const parts: string[] = [];
    const finalTitle = title ?? current;
    // DOC_PAGES_PLAN §3.4: the move first (its checks refuse most often), taken back if what follows fails.
    let moved: MoveResult | null = null;
    if (input.parentId !== undefined || input.after !== undefined) {
        const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId }, select: { parentId: true } });
        const parentId = input.parentId !== undefined ? input.parentId : row.parentId;
        if (input.parentId === undefined && !parentId) throw new ErrorResponse(400, '`after` orders the pages inside a doc, and this one is at the top level: give parentId too');
        moved = await moveDoc(userId, docId, { parentId, ...(input.after !== undefined ? { after: input.after } : {}) });
        undo.parent = { from: moved.before, to: { parentId: moved.after.parentId } };
        const into = quoted(moved.parentTitle?.trim() || 'Untitled');
        parts.push(!moved.after.parentId ? 'moved it to the top level' : moved.before.parentId === moved.after.parentId ? `moved it to a new place among the pages of ${into}` : `moved it inside ${into}`);
    }
    try {
        if (input.topicId && !existing) {
            const attached = await attachDocToTopic(userId, { topicId: input.topicId, docId, title: finalTitle, revise: false, subjectId: subject?.id });
            undo.attached = attached.before;
            parts.push(`made it a topic of the ${attached.subject.name} path`);
        } else if (subject && !input.topicId) {
            if (!existing) {
                const created = await createTopic(userId, { docId, subjectId: subject.id, startRevisions: false });
                undo.createdTopic = created.topic._id;
                parts.push(`filed it under ${subject.name}`);
            } else if (existing.subjectId !== subject.id) {
                await prisma.topic.update({ where: { id: existing.id }, data: { subjectId: subject.id, sortOrder: null }, select: { id: true } });
                undo.moved = { topicId: existing.id, subjectId: existing.subjectId, sortOrder: existing.sortOrder };
                parts.push(`moved it from ${existing.subject.name} to ${subject.name}`);
            }
        }
        if (title !== undefined && title !== current) {
            await setDocTitle(docId, actor.agentName, title);
            undo.title = { from: current, to: title };
            parts.unshift(`renamed it ${quoted(title)}`);
        }
    } catch (err) {
        if (moved) await placeAt(docId, moved.before).catch(() => {});
        throw err;
    }

    const after = (await subjectsOf(userId, [docId])).get(docId) ?? null;
    const topic = await prisma.topic.findUnique({ where: { userId_docId: { userId, docId } }, select: { id: true } });
    const result = {
        id: docId,
        title: finalTitle,
        subject: after,
        topicId: topic?.id ?? null,
        changes: parts,
        ...(moved ? { parent: moved.after.parentId ? { id: moved.after.parentId, title: moved.parentTitle } : null } : {}),
    };
    if (parts.length === 0) return { ...result, editId: null };
    const editId = await recordAgentEdit(actor, {
        kind: 'doc_update',
        summary: `Changed ${quoted(current)}: ${parts.join(', ')}`,
        docId,
        entityId: docId,
        undoData: undo as Prisma.InputJsonValue,
    });
    return { ...result, editId };
}

/** Undo of update_doc: the topic change first (it may refuse: 409), then the title. */
export async function undoDocUpdate(userId: string, edit: Pick<AgentEdit, 'docId' | 'undoData'>): Promise<void> {
    if (!edit.docId) return;
    const data = (edit.undoData ?? {}) as Record<string, unknown>;
    const attached = topicBeforeOf(data['attached']);
    if (attached) await detachDocFromTopic(userId, attached);
    if (typeof data['createdTopic'] === 'string') {
        const id = data['createdTopic'];
        const revised = await prisma.revision.count({ where: { topicId: id } });
        if (revised > 0) throw new ErrorResponse(409, "Can't undo: the doc's topic has revisions now");
        await prisma.topic.deleteMany({ where: { id, userId } });
    }
    const moved = data['moved'] as { topicId?: unknown; subjectId?: unknown; sortOrder?: unknown } | undefined;
    if (moved && typeof moved.topicId === 'string' && typeof moved.subjectId === 'string') {
        const subject = await prisma.subject.findFirst({ where: { id: moved.subjectId, userId }, select: { id: true } });
        if (subject) {
            await prisma.topic.updateMany({
                where: { id: moved.topicId, userId },
                data: { subjectId: subject.id, sortOrder: typeof moved.sortOrder === 'number' ? moved.sortOrder : null },
            });
        }
    }
    // A move goes back while the doc is still where it put it; with its old parent gone or in the trash, to the top.
    const parent = data['parent'] as { from?: { parentId?: unknown; position?: unknown }; to?: { parentId?: unknown } } | undefined;
    if (parent?.from && parent.to) {
        const to = typeof parent.to.parentId === 'string' ? parent.to.parentId : null;
        const from = typeof parent.from.parentId === 'string' ? parent.from.parentId : null;
        const row = await prisma.doc.findUnique({ where: { id: edit.docId }, select: { parentId: true, userId: true, trashedAt: true } });
        if (row && row.userId === userId && !row.trashedAt && row.parentId === to) {
            const old = from ? await prisma.doc.findUnique({ where: { id: from }, select: { trashedAt: true } }) : null;
            const back = old && !old.trashedAt ? from : null;
            await moveDoc(userId, edit.docId, { parentId: back });
            if (back && typeof parent.from.position === 'number') await placeAt(edit.docId, { parentId: back, position: parent.from.position });
        }
    }
    const title = data['title'] as { from?: unknown; to?: unknown } | undefined;
    if (title && typeof title.from === 'string' && typeof title.to === 'string') {
        const doc = await findAccessibleDoc(edit.docId, userId);
        // Renamed again since (by the user): his title stays.
        if (doc && currentContent(doc).title === title.to) await setDocTitle(edit.docId, 'undo', title.from);
    }
}

// ─── Trash (MANAGER_AND_DOCS_PLAN §3.2) ────────────────────────────────

/** POST /api/agent/docs/:id/trash: the doc goes to the trash for 30 days (Undo takes it out). */
export async function trashDocForAgent(actor: AgentActor, docId: string) {
    const state = await trashDoc(actor.userId, docId);
    // DOC_PAGES_PLAN §3.4: the pages inside it go with it.
    const withPages = state.pages > 0 ? ` and the ${plural(state.pages, 'page')} inside it` : '';
    const editId = state.changed ? await recordAgentEdit(actor, { kind: 'doc_trash', summary: `Moved ${quoted(state.title)}${withPages} to the trash`, docId, entityId: docId }) : null;
    return { id: docId, title: state.title, trashedAt: state.trashedAt, pages: state.pages, editId };
}

/** POST /api/agent/docs/:id/restore: the doc comes out of the trash (Undo puts it back). */
export async function restoreDocForAgent(actor: AgentActor, docId: string) {
    const state = await restoreDoc(actor.userId, docId);
    const withPages = state.pages > 0 ? ` with the ${plural(state.pages, 'page')} inside it` : '';
    const top = state.detached ? ' (back at the top level: the doc it was in is still in the trash)' : '';
    const editId = state.changed ? await recordAgentEdit(actor, { kind: 'doc_restore', summary: `Took ${quoted(state.title)} out of the trash${withPages}${top}`, docId, entityId: docId }) : null;
    return { id: docId, title: state.title, trashedAt: state.trashedAt, pages: state.pages, detached: state.detached, editId };
}

// ─── The tree (DOC_PAGES_PLAN §3.4) ───────────────────────────────────

/** With content: the pages' Markdown, in tree order, up to this many characters; the rest are named. */
export const TREE_CONTENT_MAX = 60_000;
/** Without a doc: at most this many top-level docs. */
export const TREE_TOP_MAX = 200;

export interface AgentTreeNode {
    id: string;
    parentId: string | null;
    depth: number;
    title: string;
    /** How many pages it holds (that this user reaches). */
    pages: number;
    /** About how long its text is (characters). */
    chars: number;
    updatedAt: Date;
    /** Filed under a subject (a lesson with its own reviews). */
    lesson: boolean;
    markdown?: string;
}

/** Sizes and update times of these docs (one query; a doc whose search words are not written yet is measured now). */
async function sizesOf(ids: readonly string[]): Promise<Map<string, { chars: number; updatedAt: Date }>> {
    if (!ids.length) return new Map();
    const rows = await prisma.$queryRaw<Array<{ id: string; updatedAt: Date; chars: number | null }>>`
        SELECT "id", "updatedAt", length("searchText") AS "chars" FROM "Doc" WHERE "id" = ANY(${[...ids]}::text[])`;
    const missing = rows.filter((r) => r.chars === null).map((r) => r.id);
    const measured = new Map<string, number>();
    if (missing.length) {
        for (const d of await prisma.doc.findMany({ where: { id: { in: missing } }, select: { id: true, yjsState: true } })) measured.set(d.id, searchTextOf(d.yjsState).length);
    }
    return new Map(rows.map((r) => [r.id, { chars: r.chars ?? measured.get(r.id) ?? 0, updatedAt: r.updatedAt }]));
}

/**
 * GET /api/agent/docs/tree ?docId= &depth= &content=1 → { root, nodes, left }. With docId: that doc (depth 0) and the
 * pages inside it this user reaches, depth-first, at most `depth` levels down; `content` adds each one's Markdown in
 * tree order until TREE_CONTENT_MAX characters are used (the rest named in `left`). Without docId: their top-level docs
 * (and docs whose parent they can't open), most recently updated first, no content.
 */
export async function docTreeForAgent(userId: string, input: { docId?: string | undefined; depth?: number | undefined; content?: boolean | undefined }) {
    if (!input.docId) {
        const tops = await prisma.doc.findMany({
            where: {
                trashedAt: null,
                AND: [accessibleDocWhere(userId), { OR: [{ parentId: null }, { parentId: { not: null }, parent: { isNot: accessibleDocWhere(userId) } }] }],
            },
            select: { id: true, title: true, _count: { select: { pages: { where: { trashedAt: null } } } } },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: TREE_TOP_MAX,
        });
        const sizes = await sizesOf(tops.map((t) => t.id));
        const lessons = new Set((await prisma.topic.findMany({ where: { userId, docId: { in: tops.map((t) => t.id) } }, select: { docId: true } })).map((t) => t.docId));
        const nodes: AgentTreeNode[] = tops.map((t) => ({
            id: t.id,
            parentId: null,
            depth: 0,
            title: t.title,
            pages: t._count.pages,
            chars: sizes.get(t.id)?.chars ?? 0,
            updatedAt: sizes.get(t.id)?.updatedAt ?? new Date(0),
            lesson: lessons.has(t.id),
        }));
        return { root: null, nodes, left: [] as Array<{ id: string; title: string; chars: number }> };
    }
    const doc = await findAccessibleDoc(input.docId, userId);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');
    const path = await trailFor(doc.id, userId);
    const reached = await pagesInside(doc.id, userId);
    const kids = new Map<string, number>();
    for (const r of reached) if (r.parentId) kids.set(r.parentId, (kids.get(r.parentId) ?? 0) + 1);
    const shown = reached.filter((r) => !input.depth || r.depth <= input.depth);
    const ids = [doc.id, ...shown.map((r) => r.id)];
    const sizes = await sizesOf(ids);
    const lessons = new Set((await prisma.topic.findMany({ where: { userId, docId: { in: ids } }, select: { docId: true } })).map((t) => t.docId));
    const title = currentContent(doc).title;
    const nodes: AgentTreeNode[] = [
        { id: doc.id, parentId: null, depth: 0, title },
        ...shown.map((r) => ({ id: r.id, parentId: r.parentId, depth: r.depth, title: r.title })),
    ].map((n) => ({ ...n, pages: kids.get(n.id) ?? 0, chars: sizes.get(n.id)?.chars ?? 0, updatedAt: sizes.get(n.id)?.updatedAt ?? doc.updatedAt, lesson: lessons.has(n.id) }));
    const left: Array<{ id: string; title: string; chars: number }> = [];
    if (input.content) {
        const rows = new Map((await prisma.doc.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, yjsState: true } })).map((d) => [d.id, d]));
        let used = 0;
        let full = false;
        for (const n of nodes) {
            const row = rows.get(n.id);
            const markdown = row ? docJsonToMarkdown(currentContent(row).json) : '';
            if (!full && used + markdown.length <= TREE_CONTENT_MAX) {
                n.markdown = markdown;
                n.chars = markdown.length;
                used += markdown.length;
            } else {
                full = true;
                left.push({ id: n.id, title: n.title, chars: markdown.length || n.chars });
            }
        }
    }
    return { root: { id: doc.id, title, path }, nodes, left };
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
    kind: 'doc_append' | 'doc_replace_section' | 'doc_canvas_update' | 'doc_blocks',
    summary: string,
    undoData?: Prisma.InputJsonValue
): Promise<string> {
    try {
        return await prisma.$transaction(async (tx) => {
            const snapshot = await tx.docSnapshot.create({
                data: { docId, yjsState: stateBytes(change.before), agentUpdate: change.update ? stateBytes(change.update) : null },
                select: { id: true },
            });
            return recordAgentEdit(actor, { kind, summary, docId, entityId: docId, snapshotId: snapshot.id, ...(undoData !== undefined ? { undoData } : {}) }, tx);
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
    // A doc on the new editor: the same Markdown becomes blocks at its end (DOCS_EDITOR_V2_PLAN phase 4).
    if (await docUsesBlocks(docId)) return appendBlocksForAgent(actor, docId, markdown);
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

/**
 * Stage 14 (ECOSYSTEM_V2_PLAN): POST /api/agent/docs/:id/append with a heading: a note inside that section, on the
 * person's yes (agentBlocks.service.ts appendNoteInBlocks for a doc on the new editor; the same rules here for one on
 * the old editor): after the block holding `after`, else at the section's end, with its quiet last line; a note the
 * section already holds is not added (no cap on how many: STUDY_FLOW_PLAN §4.1).
 */
export async function appendNoteForAgent(actor: AgentActor, docId: string, input: { heading: string; after?: string | undefined; markdown: string }, now: Date = new Date()) {
    if (await docUsesBlocks(docId)) return appendNoteInBlocks(actor, docId, input, now);
    const doc = await requireEditableDoc(docId, actor.userId);
    if (input.markdown.trim().length > NOTE_MAX) throw new ErrorResponse(400, noteTooLong());
    const { tz } = await loadLearningContext(actor.userId, now);
    const day = footerDay(now, tz);
    const blocks = blocksOrThrow(`${input.markdown.trim()}\n\n*${noteFooter(day, actor.agentName)}*`);
    const reports = await resolveDiagrams({ type: 'doc', content: blocks });
    const before = currentContent(doc).json.content ?? [];
    if (!findSection(before, input.heading)) throw headingNotFound(input.heading, before);

    const out = await withLiveDoc(docId, actor.agentName, (live) => {
        const current = (yXmlFragmentToProsemirrorJSON(live.fragment) as JSONContent).content ?? [];
        const section = findSection(current, input.heading);
        if (!section) throw headingNotFound(input.heading, current);
        const body = current.slice(section.heading + 1, section.end);
        const texts = body.map(nodePlainText);
        if (noteRepeats(input.markdown, texts)) return { already: true as const, heading: section.text };
        const hit = afterIndex(texts, input.after);
        let last = body.length - 1;
        while (last >= 0 && isEmptyParagraph(body[last])) last -= 1;
        const at = section.heading + 1 + (hit >= 0 ? hit : last) + 1;
        const { elements, boards, canvasIds } = liveBlocks(live, current, blocks);
        const change = live.apply((fragment) => {
            fragment.insert(at, elements);
            writeBoards(fragment.doc!, boards);
        });
        return { already: false as const, heading: section.text, change, canvasIds, placed: hit >= 0 ? ('after' as const) : ('section_end' as const) };
    });
    if (out.already) return { id: docId, heading: out.heading, already: true as const, placed: null, appended: 0, editId: null };
    const editId = await logDocChange(actor, docId, out.change, 'doc_append', `Added a note under ${quoted(out.heading)} in ${quoted(doc.title)}`);
    return { id: docId, heading: out.heading, placed: out.placed, appended: blocks.length, editId, ...canvasesField(reports, out.canvasIds) };
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
 * place (same id, the user's arrangement kept; ../docs/diagram/update.ts); other canvases are new.
 */
export async function replaceSectionForAgent(actor: AgentActor, docId: string, heading: string, markdown: string) {
    if (!normalizeHeading(heading)) throw new ErrorResponse(400, 'heading is required');
    if (await docUsesBlocks(docId)) return replaceSectionInBlocks(actor, docId, heading, markdown);
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
        undoChange(live, snapshot.yjsState, snapshot.agentUpdate ?? null)
    );
}

/**
 * Undo a doc the agent created: archive it, and drop its topic unless it was already revised. A
 * planned topic the doc was attached to (create_doc with topicId) stays on its path as it was.
 */
export async function undoDocCreate(userId: string, edit: Pick<AgentEdit, 'docId' | 'undoData'>, now: Date = new Date()): Promise<void> {
    if (!edit.docId) return;
    const data = (edit.undoData ?? {}) as { topicId?: unknown; attached?: unknown };
    const attached = topicBeforeOf(data.attached);
    if (attached) {
        // A revision done since: the topic was learned, so it keeps the (archived) doc, like a made one.
        await detachDocFromTopic(userId, attached).catch((err) => {
            if (!(err instanceof ErrorResponse && err.statusCode === 409)) throw err;
        });
    }
    await prisma.doc.updateMany({ where: { id: edit.docId, userId }, data: { isArchived: true, updatedAt: now } });
    const topicId = data.topicId;
    if (!attached && typeof topicId === 'string') {
        const revised = await prisma.revision.count({ where: { topicId, status: 'done' } });
        if (revised === 0) await prisma.topic.deleteMany({ where: { id: topicId, userId } });
    }
}

/** A TopicBeforeAttach read back from an edit's undoData, or null. */
export function topicBeforeOf(value: unknown): TopicBeforeAttach | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    const STATUSES = ['planned', 'in_progress', 'done', 'skipped'];
    if (typeof v['topicId'] !== 'string' || typeof v['title'] !== 'string' || !STATUSES.includes(String(v['status']))) return null;
    return {
        topicId: v['topicId'],
        title: v['title'],
        status: v['status'] as TopicBeforeAttach['status'],
        startedAt: typeof v['startedAt'] === 'string' ? v['startedAt'] : null,
        doneAt: typeof v['doneAt'] === 'string' ? v['doneAt'] : null,
        startedRevisions: v['startedRevisions'] === true,
    };
}
