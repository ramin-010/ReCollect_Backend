// Canvas boards for agents, by id (AGENT_DIAGRAMS_PLAN steps 2–3):
//
//   updateCanvasForAgent   POST /api/agent/docs/:id/canvas/:canvasId   change a board in place
//   previewCanvasForAgent  GET  /api/agent/docs/:id/preview            a board as a PNG, with its report
//
// An update is an edited fence by another road: the board printed in the text form, the change
// applied (a whole new diagram, or add / remove / rename), then parse, ELK, and a merge that keeps
// what the user arranged, written as a diff in one live change (logged; Undo takes it back exactly).
import type { JSONContent } from '@tiptap/core';
import ErrorResponse from '../../utils/errorResponse';
import { canvasHeight, coerceBoard, isJsonCanvasText, readBoard, writeBoardDiff } from '../docs/canvas';
import { findAccessibleDoc } from '../docs/docs.service';
import { editedDiagramText, renumberAddError, type CanvasEdits } from '../docs/diagram/edit';
import { layoutDiagram } from '../docs/diagram/layout';
import { parseDiagram } from '../docs/diagram/parse';
import { svgToPng } from '../docs/diagram/png';
import { canvasReport, type CanvasReport } from '../docs/diagram/resolve';
import { boardToSvg, type Theme } from '../docs/diagram/svg';
import { canvasNodesIn, findCanvasElement, mergedCanvas } from '../docs/diagram/update';
import { quoted, type AgentActor } from './agentEditLog';
import { currentContent, logDocChange, requireEditableDoc } from './agentDocs.service';
import { withLiveDoc } from './liveDoc';
import { BLOCKS_FRAGMENT, hasBlocks } from '../docs/blocks/serverEditor';

export interface UpdateCanvasInput extends CanvasEdits {
    /** The whole new diagram in the text form (instead of add / remove / rename). */
    diagram?: string | undefined;
    /**
     * Lay the whole board out again (a new direction, a board that reads badly) instead of keeping
     * every box where it is; the boxes the user moved lose their places (Undo brings them back).
     */
    relayout?: boolean | undefined;
}

/** The canvases a doc shows, by id; a 404 that lists them (and says when its diagrams are Mermaid). */
function canvasNotFound(json: JSONContent, canvasId: string | null): ErrorResponse {
    const ids = canvasNodesIn(json).map((n) => String(n.attrs?.['canvasId'] ?? '')).filter(Boolean);
    const mermaid = countMermaid(json);
    const what = canvasId ? `There is no canvas ${canvasId} in this doc.` : 'This doc has no canvas.';
    if (ids.length > 0) return new ErrorResponse(404, `${what} Its canvases: ${ids.join(', ')}.`);
    if (mermaid > 0) return new ErrorResponse(404, `${what} Its ${mermaid === 1 ? 'diagram is a Mermaid block' : `${mermaid} diagrams are Mermaid blocks`}: the server does not draw Mermaid yet (the browser does).`);
    return new ErrorResponse(404, what);
}

function countMermaid(json: JSONContent): number {
    let n = 0;
    const walk = (node: JSONContent | undefined) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'codeBlock' && String(node.attrs?.['language'] ?? '').trim().toLowerCase() === 'mermaid') n += 1;
        (node.content ?? []).forEach(walk);
    };
    walk(json);
    return n;
}

/**
 * POST /api/agent/docs/:id/canvas/:canvasId {diagram} or {add?, remove?, rename?}: the board
 * changed in place, keeping its id and what the user arranged → { id, canvasId, editId, canvases: [report] }.
 * editId is null when nothing changed (no edit is logged then). 404 for a canvas the doc doesn't
 * show; 400 for a diagram that can't be read (`add line 2: …` for an added line).
 */
export async function updateCanvasForAgent(actor: AgentActor, docId: string, canvasId: string, input: UpdateCanvasInput) {
    const doc = await requireEditableDoc(docId, actor.userId);
    const { json, title } = currentContent(doc);
    const node = canvasNodesIn(json).find((n) => n.attrs?.['canvasId'] === canvasId);
    if (!node) throw canvasNotFound(json, canvasId);

    let text: string;
    let addFrom = Number.POSITIVE_INFINITY;
    if (input.diagram !== undefined) {
        if (isJsonCanvasText(input.diagram)) throw new ErrorResponse(400, 'diagram takes the text form (Mermaid flowchart syntax), not JSON');
        text = input.diagram;
    } else {
        ({ text, addFrom } = editedDiagramText(coerceBoard(node.attrs?.['data']), canvasId, input));
    }
    let graph;
    try {
        graph = parseDiagram(text);
    } catch (err) {
        throw renumberAddError(err, addFrom);
    }
    if (graph.canvasId && graph.canvasId !== canvasId) {
        throw new ErrorResponse(400, `The diagram says %% id: ${graph.canvasId}, but this updates ${canvasId}: drop the %% id line, or update ${graph.canvasId}`);
    }
    const laid = await layoutDiagram(graph);

    const { change, merged } = await withLiveDoc(docId, actor.agentName, (live) => {
        // A doc on the new editor keeps the canvas block (its canvasId and height props) in "blocks";
        // the old fragment's copy is frozen since the switch.
        const element = (hasBlocks(live.doc) ? findCanvasElement(live.doc.getXmlFragment(BLOCKS_FRAGMENT), canvasId) : null) ?? findCanvasElement(live.fragment, canvasId);
        if (!element) throw canvasNotFound(json, canvasId);
        const oldHeight = canvasHeight(element.getAttribute('height'));
        const request = { height: graph.height, notes: graph.notes, direction: graph.direction, laidDirection: laid.direction };
        const merged = mergedCanvas(readBoard(live.doc, canvasId), laid.board, request, oldHeight, { relayout: input.relayout === true });
        const change = live.apply(() => {
            writeBoardDiff(live.doc, canvasId, merged.board);
            if (merged.height !== oldHeight) element.setAttribute('height', merged.height as unknown as string);
        });
        return { change, merged };
    });
    const report: CanvasReport = { ...merged.report, canvasId };
    if (!change.update) return { id: docId, canvasId, editId: null, canvases: [report] };
    const editId = await logDocChange(actor, docId, change, 'doc_canvas_update', `Updated a canvas in ${quoted(title)}`);
    return { id: docId, canvasId, editId, canvases: [report] };
}

/** The longest side of a preview (an agent reads it as an image; bigger only costs tokens). */
const PREVIEW_MAX_SIDE = 3000;

/**
 * GET /api/agent/docs/:id/preview?canvasId=&theme= → { canvasId, width, height, png (Base64), report }:
 * a board of the doc as the user sees it (the first canvas without an id), drawn by the server.
 */
export async function previewCanvasForAgent(userId: string, docId: string, canvasId: string | undefined, theme: Theme = 'light') {
    const doc = await findAccessibleDoc(docId, userId);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');
    const { json } = currentContent(doc);
    const canvases = canvasNodesIn(json);
    const node = canvasId ? canvases.find((n) => n.attrs?.['canvasId'] === canvasId) : canvases[0];
    if (!node) throw canvasNotFound(json, canvasId ?? null);
    const board = coerceBoard(node.attrs?.['data']);
    const { svg, width, height } = boardToSvg(board, theme);
    const png = svgToPng(svg, width, height, 2, PREVIEW_MAX_SIDE);
    const id = String(node.attrs?.['canvasId'] ?? '');
    return {
        canvasId: id,
        width: png.width,
        height: png.height,
        png: png.png.toString('base64'),
        report: { ...canvasReport(board, canvasHeight(node.attrs?.['height'])), canvasId: id },
    };
}
