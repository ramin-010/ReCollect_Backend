// Laying out the diagrams of parsed Markdown, and the report agents get for every canvas they write.
//
// Markdown parses synchronously, but the layout (ELK) is asynchronous: a ```canvas fence in the
// text form first becomes a canvas whose data is { pendingDiagram } (../canvas.ts). Every path
// that parses agent Markdown awaits resolveDiagrams before anything reaches a Y.Doc (absorbing a
// pending diagram throws): create_doc, append_to_doc, replace_section, practice notes and the
// paste route.
import type { JSONContent } from '@tiptap/core';
import { PENDING_DIAGRAM, boardBounds, canvasHeight, coerceBoard, docZoom, fittedCanvasHeight, isCanvasId, isPendingDiagram, type Board } from '../canvas';
import { checkMermaidBlocks } from '../mermaid/check';
import { layoutDiagram } from './layout';
import { lintBoard } from './lint';
import type { DiagramGraph } from './parse';

/** What an agent learns about a canvas it wrote (CANVAS_BLOCK_SPEC §9). */
export interface CanvasReport {
    /** Null until the canvas is stored (it gets its id then). */
    canvasId: string | null;
    /** Nodes that are not zones (notes and text count). */
    boxes: number;
    arrows: number;
    zones: number;
    /** The laid-out size. */
    width: number;
    height: number;
    /** The zoom it shows at in a doc (0–1). */
    zoom: number;
    warnings: string[];
}

/** The report for a board shown in a frame `frameHeight` px tall. */
export function canvasReport(board: Board, frameHeight: number, options: { notes?: readonly string[]; direction?: DiagramGraph['direction'] } = {}): CanvasReport {
    const bounds = boardBounds(board.nodes);
    return {
        canvasId: null,
        boxes: board.nodes.filter((n) => n.shape !== 'zone').length,
        arrows: board.edges.length,
        zones: board.nodes.filter((n) => n.shape === 'zone').length,
        width: bounds.w,
        height: bounds.h,
        zoom: board.nodes.length > 0 ? Math.round(docZoom(bounds.w, bounds.h, frameHeight) * 100) / 100 : 1,
        warnings: lintBoard(board, { frameHeight, direction: options.direction, notes: options.notes }),
    };
}

/** The diagram a canvas's data is waiting with, or null. */
function pendingOf(data: unknown): DiagramGraph | null {
    return isPendingDiagram(data) ? ((data as Record<string, unknown>)[PENDING_DIAGRAM] as DiagramGraph) : null;
}

/** What a laid-out text fence asked for, beyond its board: an edit in place (step 2) needs it. */
export interface DiagramRequest {
    /** `%% id: cv_…`: the board the text was printed from. */
    canvasId: string | null;
    /** `%% height`, or null (the block then fits the board). */
    height: number | null;
    notes: string[];
    /** The direction the text asked for (null: the layout picked). */
    direction: DiagramGraph['direction'];
    /** The direction it was laid out in. */
    laidDirection: NonNullable<DiagramGraph['direction']>;
}

const requests = new WeakMap<object, DiagramRequest>();

/** What the text fence of this canvas node asked for, once resolveDiagrams laid it out. */
export function diagramRequestOf(canvas: JSONContent): DiagramRequest | undefined {
    return requests.get(canvas);
}

/**
 * Lays out every canvas of parsed Markdown that still holds a diagram: its data becomes the
 * board, its height the one that fits the board (unless the text asked for one with `%% height`).
 * Changes `json` in place. Returns a report for every canvas, in document order (boards from the
 * JSON form are reported too, as they are).
 */
export async function resolveDiagrams(json: JSONContent, options: { checkMermaid?: boolean } = {}): Promise<CanvasReport[]> {
    // A ```mermaid block Mermaid can't parse: 400, before any layout, so an agent fixes it. Ramin's
    // own paste and AI practice notes skip it: the browser shows Mermaid's error on the block, and a
    // refusal there would lose a paste or a note already paid for.
    if (options.checkMermaid !== false) await checkMermaidBlocks(json);
    const canvases: JSONContent[] = [];
    const walk = (node: JSONContent | undefined) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'canvas') canvases.push(node);
        else if (Array.isArray(node.content)) node.content.forEach(walk);
    };
    walk(json);

    const reports: CanvasReport[] = [];
    for (const canvas of canvases) {
        const attrs = (canvas.attrs ??= {});
        const graph = pendingOf(attrs['data']);
        let report: CanvasReport;
        if (graph) {
            const laid = await layoutDiagram(graph);
            const height = graph.height ?? fittedCanvasHeight(laid.board);
            attrs['data'] = laid.board;
            attrs['height'] = height;
            requests.set(canvas, { canvasId: graph.canvasId, height: graph.height, notes: graph.notes, direction: graph.direction, laidDirection: laid.direction });
            report = canvasReport(laid.board, height, { notes: graph.notes, direction: graph.direction });
        } else {
            report = canvasReport(coerceBoard(attrs['data']), canvasHeight(attrs['height']));
        }
        if (isCanvasId(attrs['canvasId'])) report.canvasId = attrs['canvasId'] as string;
        reports.push(report);
    }
    return reports;
}

/** Reports named by the ids their canvases got when stored (both in document order). */
export function withCanvasIds(reports: readonly CanvasReport[], ids: readonly string[]): CanvasReport[] {
    return reports.map((report, i) => ({ ...report, canvasId: ids[i] ?? report.canvasId }));
}
