// A canvas updated in place (AGENT_DIAGRAMS_PLAN step 2): an edited text fence that names a board
// (`%% id: cv_…`) keeps that board's id, and Ramin's arrangement, in two cases: replace_section
// when the replaced section holds that board, and update_canvas. Everywhere else a fence is a new
// canvas, as before.
//
// The layout of the new text is ELK's (asynchronous, done first); merging it into the board as it
// is now happens inside the live doc's change (synchronous), so a box Ramin moved a moment ago
// keeps that place too. The board is then written as a diff (../canvas.ts writeBoardDiff).
import type { JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import { canvasHeight, fittedCanvasHeight, isCanvasId, type Board } from '../canvas';
import { mergeBoards } from './merge';
import { canvasReport, diagramRequestOf, type CanvasReport, type DiagramRequest } from './resolve';

export interface MergedCanvas {
    board: Board;
    /** The block's height: the text's `%% height`, else the old height or the one that fits, whichever is bigger. */
    height: number;
    report: CanvasReport;
}

/** The new layout merged into the board as it is, with the block's height and the report. */
export function mergedCanvas(
    old: Board,
    next: Board,
    request: Pick<DiagramRequest, 'height' | 'notes' | 'direction' | 'laidDirection'>,
    oldHeight: number,
    options: { relayout?: boolean } = {}
): MergedCanvas {
    // relayout: the new layout as it is (a new direction only shows this way); the frame fits it.
    if (options.relayout) {
        const height = request.height ?? fittedCanvasHeight(next);
        return { board: next, height, report: canvasReport(next, height, { notes: request.notes, direction: request.direction }) };
    }
    const { board } = mergeBoards(old, next, request.laidDirection);
    const height = request.height ?? Math.max(oldHeight, fittedCanvasHeight(board));
    return { board, height, report: canvasReport(board, height, { notes: request.notes, direction: request.direction }) };
}

/** Canvas nodes of a JSON tree, in document order. */
export function canvasNodesIn(nodes: readonly JSONContent[] | JSONContent): JSONContent[] {
    const out: JSONContent[] = [];
    const walk = (node: JSONContent | undefined) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'canvas') out.push(node);
        else if (Array.isArray(node.content)) node.content.forEach(walk);
    };
    if (Array.isArray(nodes)) nodes.forEach(walk);
    else walk(nodes as JSONContent);
    return out;
}

export interface InPlaceUpdate extends MergedCanvas {
    canvasId: string;
    /** The canvas's place among the new blocks' canvases (document order), for its report. */
    index: number;
}

/**
 * The canvases of laid-out new blocks that update a board of the section they replace: a text
 * fence whose `%% id` names a canvas of `replaced` (the first such fence only). Each of those
 * canvas nodes is changed in place: it takes the board's id, its height is set, and its data is
 * dropped (the board is written as a diff instead, so absorbing leaves it alone). `read` gives the
 * board an id holds now.
 */
export function updateInPlace(blocks: readonly JSONContent[], replaced: readonly JSONContent[], read: (canvasId: string) => Board): InPlaceUpdate[] {
    const heights = new Map<string, number>();
    for (const node of canvasNodesIn(replaced)) {
        const id = node.attrs?.['canvasId'];
        if (isCanvasId(id)) heights.set(id, canvasHeight(node.attrs?.['height']));
    }
    const updates: InPlaceUpdate[] = [];
    canvasNodesIn(blocks).forEach((node, index) => {
        const request = diagramRequestOf(node);
        const id = request?.canvasId;
        if (!request || !id || !heights.has(id) || updates.some((u) => u.canvasId === id)) return;
        const merged = mergedCanvas(read(id), node.attrs!['data'] as Board, request, heights.get(id)!);
        node.attrs = { ...node.attrs, canvasId: id, height: merged.height, data: null };
        updates.push({ ...merged, report: { ...merged.report, canvasId: id }, canvasId: id, index });
    });
    return updates;
}

/** The canvas element of `canvasId` in a live doc's fragment (blocks inside other blocks too). */
export function findCanvasElement(fragment: Y.XmlFragment, canvasId: string): Y.XmlElement | null {
    const stack: unknown[] = fragment.toArray();
    while (stack.length > 0) {
        const el = stack.pop();
        if (!(el instanceof Y.XmlElement)) continue;
        if (el.nodeName === 'canvas' && el.getAttribute('canvasId') === canvasId) return el;
        stack.push(...el.toArray());
    }
    return null;
}
