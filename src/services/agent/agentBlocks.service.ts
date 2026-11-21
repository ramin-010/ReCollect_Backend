// Block tools for agents and the app's AI (DOCS_EDITOR_V2_PLAN §5, phase 3): read a doc's outline and
// change its blocks by id, on the new editor's content (the "blocks" fragment). Each change is one
// Yjs transaction on the live doc (./liveDoc.ts), with a DocSnapshot and an AgentEdit (doc_blocks)
// so Home shows it and Undo takes exactly it back, like append and replace-section.
//
// A doc still on the old editor (old content and no blocks) answers 409; since the switch (phase 4) every
// doc is on the new editor, and an empty one takes blocks on its first write.
import * as Y from 'yjs';
import ErrorResponse from '../../utils/errorResponse';
import { newCanvasId, readBoard, takeCanvasData, writeBoardDiff, writeBoards, type Board } from '../docs/canvas';
import type { JSONContent } from '@tiptap/core';
import { markdownToDocJson } from '../docs/markdown/docMarkdown';
import { resolveDiagrams } from '../docs/diagram/resolve';
import { updateInPlace } from '../docs/diagram/update';
import { oldJsonToBlocks } from '../docs/blocks/fromOldJson';
import { blocksToOldJson } from '../docs/blocks/toOldJson';
import { getDocRole } from '../docs/docPermissions';
import { findAccessibleDoc } from '../docs/docs.service';
import * as ops from '../docs/blocks/docOps';
import { markdownToBlocks, printBlocks } from '../docs/blocks/markdown';
import { readBlocks, type DocBlock, type InlineNode, type NewBlock } from '../docs/blocks/serverEditor';
import { onNewEditor } from '../docs/blocks/newDocState';
import { liveDocument, withLiveDoc } from './liveDoc';
import { logDocChange, normalizeHeading, requireEditableDoc } from './agentDocs.service';
import { prisma } from '../../db/prisma';
import { plural, quoted, type AgentActor } from './agentEditLog';
import { loadLearningContext } from '../learningDb/common';
import { NOTES_PER_DOC_DAY, NOTE_MAX, afterIndex, footerDay, noteFooter, noteRepeats, notesOnDay } from './docNotes';

const OLD_EDITOR = 'This doc is still on the old editor: change it with append_to_doc or replace_section (block tools work once it is on the new editor)';

/** The doc's Y.Doc to read: the live one when an editor has it open, else the stored state (a copy). */
export function readable(doc: { id: string; yjsState: Uint8Array | null }): { ydoc: Y.Doc; done: () => void } {
    const live = liveDocument(doc.id);
    if (live) return { ydoc: live, done: () => {} };
    const copy = new Y.Doc();
    if (doc.yjsState) Y.applyUpdate(copy, doc.yjsState);
    return { ydoc: copy, done: () => copy.destroy() };
}

/** Every canvas id the doc already uses: in its blocks, and every board in its root maps (both editors). */
function takenCanvasIds(ydoc: Y.Doc): Set<string> {
    const ids = new Set<string>();
    for (const name of ydoc.share.keys()) {
        const m = /^canvas:(.+):(nodes|edges)$/.exec(name);
        if (m) ids.add(m[1]!);
    }
    for (const id of canvasIdsOf(readBlocks(ydoc))) ids.add(id);
    return ids;
}

/** Canvas ids of blocks in document order (a canvas inside another block counts too). */
export function canvasIdsOf(blocks: readonly (DocBlock | NewBlock)[]): string[] {
    const ids: string[] = [];
    const walk = (bs: readonly (DocBlock | NewBlock)[]) => {
        for (const b of bs) {
            const id = b.props?.['canvasId'];
            if (b.type === 'canvas' && typeof id === 'string' && id) ids.push(id);
            walk(b.children ?? []);
        }
    };
    walk(blocks);
    return ids;
}

/** GET /api/agent/docs/:id/outline → { id, title, blocks: [{ id, type, depth, text, props? }], canEdit } */
export async function outlineForAgent(userId: string, docId: string) {
    const doc = await findAccessibleDoc(docId, userId);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');
    const { ydoc, done } = readable(doc);
    try {
        if (!onNewEditor(ydoc)) throw new ErrorResponse(409, OLD_EDITOR);
        const role = getDocRole(doc, userId);
        return { id: doc.id, title: doc.title, blocks: ops.outline(ydoc), canEdit: role === 'owner' || role === 'editor' };
    } finally {
        done();
    }
}

/** GET /api/agent/docs/:id/blocks?ids=a,b → the blocks (and their children) as Markdown, or the whole doc. */
export async function readBlocksForAgent(userId: string, docId: string, ids?: readonly string[]) {
    const doc = await findAccessibleDoc(docId, userId);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');
    const { ydoc, done } = readable(doc);
    try {
        if (!onNewEditor(ydoc)) throw new ErrorResponse(409, OLD_EDITOR);
        const all = readBlocks(ydoc);
        const picked = ids?.length
            ? ids.map((id) => {
                  const b = ops.blockById(ydoc, id);
                  if (!b) throw new ErrorResponse(404, `No block with the id ${id} in this doc (get_outline lists them)`);
                  return b;
              })
            : all;
        return { id: doc.id, title: doc.title, markdown: printBlocks(picked, { ydoc }) };
    } finally {
        done();
    }
}

const describe = (blocks: readonly NewBlock[]) => plural(blocks.length, blocks.every((b) => b.type === 'paragraph') ? 'paragraph' : 'block');

function whereText(where: ops.Where): string {
    if ('at' in where) return where.at === 'start' ? 'at the start' : 'at the end';
    if ('after' in where) return `after block ${where.after}`;
    if ('before' in where) return `before block ${where.before}`;
    return `under block ${where.under}`;
}

/** POST /api/agent/docs/:id/blocks { markdown, where } → { id, ids, inserted, editId, canvases? } */
export async function insertBlocksForAgent(actor: AgentActor, docId: string, markdown: string, where: ops.Where) {
    const doc = await requireEditableDoc(docId, actor.userId);
    // Parse first (a bad diagram or a block that can't be read is a 400 before anything changes).
    const parsed = await markdownToBlocks(markdown, {});
    if (!parsed.blocks.length) throw new ErrorResponse(400, 'markdown is empty');
    const { change, ids, canvasIds } = await withLiveDoc(docId, actor.agentName, (live) => {
        if (!onNewEditor(live.doc)) throw new ErrorResponse(409, OLD_EDITOR);
        // Canvases: fresh ids against the ones the doc has (both editors' blocks), boards written with the blocks.
        const { blocks, boards } = renameCanvases(parsed.blocks, parsed.boards, takenCanvasIds(live.doc));
        let made: string[] = [];
        const change = live.apply(() => {
            made = ops.insert(live.doc, blocks, where);
            writeBoards(live.doc, boards);
        });
        return { change, ids: made, canvasIds: canvasIdsOf(blocks) };
    });
    // Each canvas report names the board it made (ids are given after the reports are drawn up).
    const canvases = parsed.canvases.map((c, i) => ({ ...c, canvasId: canvasIds[i] ?? c.canvasId ?? null }));
    const editId = await logDocChange(actor, docId, change, 'doc_blocks', `Added ${describe(parsed.blocks)} ${whereText(where)} in ${quoted(doc.title)}`);
    return { id: docId, ids, inserted: parsed.blocks.length, editId, ...(canvases.length ? { canvases } : {}) };
}

/** Canvas ids the doc already has (or another board holds) get fresh ones; their boards follow. */
export function renameCanvases(blocks: NewBlock[], boards: Map<string, Board>, taken: Set<string>) {
    const out = new Map(boards);
    const visit = (bs: NewBlock[]): NewBlock[] =>
        bs.map((b) => {
            const children = b.children ? visit(b.children) : undefined;
            if (b.type !== 'canvas') return { ...b, ...(children ? { children } : {}) };
            let id = String(b.props?.['canvasId'] ?? '');
            const clash = !id || taken.has(id);
            if (clash) {
                const board = out.get(id);
                out.delete(id);
                do {
                    id = newCanvasId();
                } while (taken.has(id));
                if (board) out.set(id, board);
            }
            taken.add(id);
            return { ...b, props: { ...b.props, canvasId: id }, ...(children ? { children } : {}) };
        });
    return { blocks: visit(blocks), boards: out };
}

/** PATCH /api/agent/docs/:id/blocks/:blockId { markdown?, type?, props? } → { id, block, editId } */
export async function updateBlockForAgent(actor: AgentActor, docId: string, blockId: string, input: { markdown?: string | undefined; type?: string | undefined; props?: Record<string, unknown> | undefined }) {
    const doc = await requireEditableDoc(docId, actor.userId);
    let patch: ops.BlockPatch = {};
    if (input.markdown !== undefined) {
        // One block of Markdown: its type, props and text replace the block's (its children stay).
        const parsed = await markdownToBlocks(input.markdown, {});
        if (parsed.blocks.length !== 1) throw new ErrorResponse(400, `markdown must be exactly one block (it was ${parsed.blocks.length}); use insert_blocks for more`);
        const one = parsed.blocks[0]!;
        if (one.type === 'canvas') throw new ErrorResponse(400, 'A canvas changes with update_canvas, not update_block');
        patch = { type: one.type, props: { ...(one.props ?? {}) }, content: (one.content as InlineNode[] | string | undefined) ?? [] };
    }
    if (input.type !== undefined) patch.type = input.type;
    if (input.props !== undefined) patch.props = { ...(patch.props ?? {}), ...input.props };
    if (patch.type === undefined && patch.props === undefined && patch.content === undefined) throw new ErrorResponse(400, 'Nothing to change: give markdown, type or props');
    const { change, block } = await withLiveDoc(docId, actor.agentName, (live) => {
        if (!onNewEditor(live.doc)) throw new ErrorResponse(409, OLD_EDITOR);
        let block: DocBlock | null = null;
        const change = live.apply(() => {
            block = ops.update(live.doc, blockId, patch);
        });
        return { change, block: block as DocBlock | null };
    });
    const editId = await logDocChange(actor, docId, change, 'doc_blocks', `Changed a ${block?.type ?? 'block'} in ${quoted(doc.title)}`);
    return { id: docId, block: block ? { id: block.id, type: block.type, markdown: printBlocks([{ ...block, children: [] }]) } : null, editId };
}

/** POST /api/agent/docs/:id/blocks/move { ids, where } → { id, moved, editId } */
export async function moveBlocksForAgent(actor: AgentActor, docId: string, ids: readonly string[], where: ops.Where) {
    const doc = await requireEditableDoc(docId, actor.userId);
    const { change } = await withLiveDoc(docId, actor.agentName, (live) => {
        if (!onNewEditor(live.doc)) throw new ErrorResponse(409, OLD_EDITOR);
        return { change: live.apply(() => ops.move(live.doc, ids, where)) };
    });
    const editId = await logDocChange(actor, docId, change, 'doc_blocks', `Moved ${plural(ids.length, 'block')} ${whereText(where)} in ${quoted(doc.title)}`);
    return { id: docId, moved: ids.length, editId };
}

/** POST /api/agent/docs/:id/blocks/delete { ids } → { id, deleted, editId } (Undo brings them back). */
export async function deleteBlocksForAgent(actor: AgentActor, docId: string, ids: readonly string[]) {
    const doc = await requireEditableDoc(docId, actor.userId);
    const { change, removed } = await withLiveDoc(docId, actor.agentName, (live) => {
        if (!onNewEditor(live.doc)) throw new ErrorResponse(409, OLD_EDITOR);
        let removed = 0;
        const change = live.apply(() => {
            removed = ops.remove(live.doc, ids);
        });
        return { change, removed };
    });
    const editId = await logDocChange(actor, docId, change, 'doc_blocks', `Deleted ${plural(removed, 'block')} from ${quoted(doc.title)}`);
    return { id: docId, deleted: removed, editId };
}

// ─── The old tools on a doc that has blocks (the switch): append and replace a section ───

/** True when the doc's content is the new editor's (its live doc, else its stored state). */
export async function docUsesBlocks(docId: string): Promise<boolean> {
    const live = liveDocument(docId);
    if (live) return onNewEditor(live);
    const row = await prisma.doc.findUnique({ where: { id: docId }, select: { yjsState: true } });
    if (!row?.yjsState) return true;
    const ydoc = new Y.Doc();
    try {
        Y.applyUpdate(ydoc, row.yjsState);
        return onNewEditor(ydoc);
    } finally {
        ydoc.destroy();
    }
}

/** append_to_doc on a doc with blocks: the Markdown as blocks at the end (before the trailing empty paragraph). */
export async function appendBlocksForAgent(actor: AgentActor, docId: string, markdown: string) {
    const r = await insertBlocksForAgent(actor, docId, markdown, { at: 'end' });
    return { id: r.id, appended: r.inserted, editId: r.editId, ...(r.canvases ? { canvases: r.canvases } : {}) };
}

const headingText = (b: DocBlock) =>
    (Array.isArray(b.content) ? (b.content as InlineNode[]) : []).map((n) => (n.type === 'text' ? n.text : n.content.map((c) => c.text).join(''))).join('');

/** A block's words, its children's too (a table's cells; a canvas or an image has none). */
export function blockText(b: DocBlock): string {
    const inline = (c: DocBlock['content']): string => {
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return (c as InlineNode[]).map((n) => (n.type === 'text' ? n.text : n.content.map((x) => x.text).join(''))).join('');
        if (c && c.type === 'tableContent') return c.rows.flatMap((r) => r.cells.map((cell) => inline((Array.isArray(cell) ? cell : cell.content) as InlineNode[]))).join(' ');
        return '';
    };
    return [inline(b.content), ...b.children.map(blockText)].filter(Boolean).join('\n');
}

/** A 404 that lists the doc's top-level headings. */
function headingMissing(heading: string, top: readonly DocBlock[]): ErrorResponse {
    const heads = top.filter((b) => b.type === 'heading').map((b) => quoted(headingText(b), 60)).slice(0, 30);
    return new ErrorResponse(404, `Heading ${quoted(heading.replace(/^\s*#{1,6}\s*/, ''), 100)} not found in this doc.${heads.length ? ` Its headings: ${heads.join(', ')}.` : ' It has no headings.'}`);
}

/** The section under the first top-level heading with this text: its heading's index and the end (exclusive). */
function sectionOf(top: readonly DocBlock[], heading: string): { at: number; end: number } | null {
    const target = normalizeHeading(heading);
    const at = top.findIndex((b) => b.type === 'heading' && normalizeHeading(headingText(b)) === target);
    if (at < 0) return null;
    const level = Number(top[at]!.props['level']) || 1;
    let end = at + 1;
    while (end < top.length && !(top[end]!.type === 'heading' && (Number(top[end]!.props['level']) || 1) <= level)) end += 1;
    return { at, end };
}

/** An empty paragraph (the editor keeps one at a doc's end; people leave them between sections). */
const blankBlock = (b: DocBlock) => b.type === 'paragraph' && !blockText(b).trim() && !b.children.length;

/**
 * Stage 14 (ECOSYSTEM_V2_PLAN): a note inside one section, on the person's yes: right after the block that holds the
 * quoted `after` words, else at the section's end; with a quiet last line (the day and the app). Under the doc's live
 * connection (synchronous inside, so two chats saving the same note at once write it once): a note the section already
 * holds is not added (`already`), and a fourth note into the doc on one day is refused. No model call: it works with
 * no AI credits.
 */
export async function appendNoteInBlocks(actor: AgentActor, docId: string, input: { heading: string; after?: string | undefined; markdown: string }, now: Date = new Date()) {
    const doc = await requireEditableDoc(docId, actor.userId);
    if (input.markdown.trim().length > NOTE_MAX) throw new ErrorResponse(400, `A note is at most ${NOTE_MAX.toLocaleString('en')} characters: keep the point, the example that worked and one line on what confused them.`);
    const { tz } = await loadLearningContext(actor.userId, now);
    const day = footerDay(now, tz);
    const parsed = await markdownToBlocks(`${input.markdown.trim()}\n\n*${noteFooter(day, actor.agentName)}*`, {});
    if (parsed.blocks.length < 2) throw new ErrorResponse(400, 'markdown is empty');
    const out = await withLiveDoc(docId, actor.agentName, (live) => {
        if (!onNewEditor(live.doc)) throw new ErrorResponse(409, OLD_EDITOR);
        const top = readBlocks(live.doc);
        const section = sectionOf(top, input.heading);
        if (!section) throw headingMissing(input.heading, top);
        const heading = headingText(top[section.at]!).trim();
        if (notesOnDay(top.map(blockText), day) >= NOTES_PER_DOC_DAY)
            throw new ErrorResponse(409, `${NOTES_PER_DOC_DAY} notes were added to this doc from chats today, the most for a day: it can wait until tomorrow, or they can add it themselves in Recollect.`);
        const body = top.slice(section.at + 1, section.end);
        const texts = body.map(blockText);
        if (noteRepeats(input.markdown, texts)) return { already: true as const, heading };
        // After the block that holds the quoted words; else after the section's last block with something in it.
        const hit = afterIndex(texts, input.after);
        let last = body.length - 1;
        while (last >= 0 && blankBlock(body[last]!)) last -= 1;
        const anchor = hit >= 0 ? body[hit]! : last >= 0 ? body[last]! : top[section.at]!;
        const { blocks, boards } = renameCanvases(parsed.blocks, parsed.boards, takenCanvasIds(live.doc));
        let ids: string[] = [];
        const change = live.apply(() => {
            ids = ops.insert(live.doc, blocks, { after: anchor.id });
            writeBoards(live.doc, boards);
        });
        return { already: false as const, heading, change, ids, placed: hit >= 0 ? ('after' as const) : ('section_end' as const) };
    });
    if (out.already) return { id: docId, heading: out.heading, already: true as const, placed: null, appended: 0, editId: null };
    const editId = await logDocChange(actor, docId, out.change, 'doc_append', `Added a note under ${quoted(out.heading)} in ${quoted(doc.title)}`);
    return { id: docId, heading: out.heading, placed: out.placed, appended: parsed.blocks.length, ids: out.ids, editId };
}

/**
 * replace_section on a doc with blocks: the section under the first top-level heading with this text
 * (to the next heading of the same or a higher level) is replaced; a new heading of the same or a
 * higher level at the start of the Markdown replaces the heading too (a rename). One change, one Undo.
 */
export async function replaceSectionInBlocks(actor: AgentActor, docId: string, heading: string, markdown: string) {
    const doc = await requireEditableDoc(docId, actor.userId);
    // Parsed and laid out first (a bad diagram is a 400 before the doc opens); the blocks are made
    // inside, once the section is known: a fence naming a board of the section updates it in place.
    const json = markdownToDocJson(markdown, { maxHeading: 6 });
    const reports = await resolveDiagrams(json, {});
    const firstJson = json.content?.[0];
    const target = normalizeHeading(heading);
    const { change, removed, inserted, text, canvasIds, updates } = await withLiveDoc(docId, actor.agentName, (live) => {
        if (!onNewEditor(live.doc)) throw new ErrorResponse(409, 'This doc is on the old editor');
        const top = readBlocks(live.doc);
        const at = top.findIndex((b) => b.type === 'heading' && normalizeHeading(headingText(b)) === target);
        if (at < 0) {
            const heads = top.filter((b) => b.type === 'heading').map((b) => quoted(headingText(b), 60)).slice(0, 30);
            throw new ErrorResponse(404, `Heading ${quoted(heading.replace(/^\s*#{1,6}\s*/, ''), 100)} not found in this doc.${heads.length ? ` Its headings: ${heads.join(', ')}.` : ' It has no headings.'}`);
        }
        const level = Number(top[at]!.props['level']) || 1;
        let end = at + 1;
        while (end < top.length && !(top[end]!.type === 'heading' && (Number(top[end]!.props['level']) || 1) <= level)) end += 1;
        // A trailing empty paragraph at the doc's end stays (the editor keeps one).
        if (end === top.length && end - 1 > at && top[end - 1]!.type === 'paragraph' && !headingText(top[end - 1]!) && !top[end - 1]!.children.length) end -= 1;
        const rename = firstJson?.type === 'heading' && (Number(firstJson.attrs?.['level']) || 1) <= level;
        const replaced = top.slice(rename ? at : at + 1, end);
        const gone = replaced.map((b) => b.id);
        // A fence whose %% id names a board of this section changes that board in place (its id, his
        // arrangement kept, written as a diff); any other canvas is a new board with a fresh id.
        const updates = updateInPlace(json.content ?? [], blocksToOldJson(replaced).content ?? [], (id) => readBoard(live.doc, id));
        const taken = takenCanvasIds(live.doc);
        for (const u of updates) taken.delete(u.canvasId);
        const absorbed = takeCanvasData(json, { seen: [...taken], existing: (id) => readBoard(live.doc, id) });
        const { blocks } = oldJsonToBlocks(absorbed.json as JSONContent);
        const anchor = rename ? (at > 0 ? top[at - 1]!.id : null) : top[at]!.id;
        const change = live.apply(() => {
            if (gone.length) ops.remove(live.doc, gone);
            if (blocks.length) ops.insert(live.doc, blocks, anchor ? { after: anchor } : { at: 'start' });
            writeBoards(live.doc, absorbed.boards);
            for (const u of updates) writeBoardDiff(live.doc, u.canvasId, u.board);
        });
        return { change, removed: gone.length, inserted: blocks.length, text: headingText(top[at]!).trim(), canvasIds: canvasIdsOf(blocks), updates };
    });
    const editId = await logDocChange(actor, docId, change, 'doc_replace_section', `Rewrote section ${quoted(text)} in ${quoted(doc.title)}`);
    // Each report names its board: an updated one its kept id, a new one the id it was given.
    const canvases = reports.map((report, i) => updates.find((u) => u.index === i)?.report ?? { ...report, canvasId: canvasIds[i] ?? report.canvasId ?? null });
    return { id: docId, heading: text, removed, inserted, editId, ...(canvases.length ? { canvases } : {}) };
}
