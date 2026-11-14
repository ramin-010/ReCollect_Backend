// The server's diagram tools for a board the browser shows (CANVAS_BLOCK_SPEC §9, "Step 3
// endpoints"). Stateless: the board comes in, the result goes out, and the browser writes it
// itself, so the board's own Undo covers it.
//
//   tidyBoard     POST /api/canvas/layout   "Tidy up": the ELK layout agents get, keeping ids, zones,
//                                           parents, arrows and every box's own size
//   renderBoard   POST /api/canvas/render   "Save as SVG/PNG", and the agent's preview
import ErrorResponse from '../../utils/errorResponse';
import { fittedCanvasHeight, normalizeBoard, type Board } from './canvas';
import { layoutDiagram } from './diagram/layout';
import { contentHeight } from './diagram/measure';
import type { DiagramDirection, DiagramGraph } from './diagram/parse';
import { svgToPng } from './diagram/png';
import { canvasReport, type CanvasReport } from './diagram/resolve';
import { boardToSvg, type Theme } from './diagram/svg';

/** A board from the browser, checked (a 400 that says what is wrong; at most 300 boxes). */
export function boardFromRequest(input: unknown): Board {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ErrorResponse(400, 'board must be an object: { nodes: [...], edges: [...] }');
    return normalizeBoard(input);
}

/**
 * The board's boxes in the order its arrows read (sources first), as an agent would have written
 * them. ELK keeps the model order and breaks cycles by it, so feeding boxes in stacking order (zones
 * first) turned forward arrows into backward ones: the load balancer landed beside the API tier with
 * its arrows looping back. Ties and cycles go by where the boxes sit now (top to bottom, then left
 * to right); a zone comes just before the first box it holds.
 */
export function flowOrder(board: Board): Board {
    const byId = new Map(board.nodes.map((n) => [n.id, n]));
    const absCache = new Map<string, { x: number; y: number }>();
    const abs = (id: string, seen = new Set<string>()): { x: number; y: number } => {
        const hit = absCache.get(id);
        if (hit) return hit;
        const n = byId.get(id);
        if (!n) return { x: 0, y: 0 };
        const p = n.parent && byId.has(n.parent) && !seen.has(n.parent) ? abs(n.parent, new Set([...seen, id])) : { x: 0, y: 0 };
        const at = { x: p.x + n.x, y: p.y + n.y };
        absCache.set(id, at);
        return at;
    };
    const reading = (a: string, b: string) => abs(a).y - abs(b).y || abs(a).x - abs(b).x || (a < b ? -1 : a > b ? 1 : 0);

    const boxes = board.nodes.filter((n) => n.shape !== 'zone').map((n) => n.id);
    const next = new Map<string, string[]>(boxes.map((id) => [id, []]));
    const incoming = new Map<string, number>(boxes.map((id) => [id, 0]));
    for (const e of board.edges) {
        if (!next.has(e.from) || !incoming.has(e.to) || e.from === e.to) continue;
        next.get(e.from)!.push(e.to);
        incoming.set(e.to, incoming.get(e.to)! + 1);
    }
    for (const list of next.values()) list.sort(reading);
    // Reverse post-order of a depth-first walk from the sources (in reading order): a topological
    // order wherever there is no cycle.
    const visited = new Set<string>();
    const post: string[] = [];
    const visit = (start: string) => {
        if (visited.has(start)) return;
        const stack: Array<{ id: string; i: number }> = [{ id: start, i: 0 }];
        visited.add(start);
        while (stack.length > 0) {
            const top = stack[stack.length - 1]!;
            const children = next.get(top.id)!;
            if (top.i < children.length) {
                const child = children[top.i++]!;
                if (!visited.has(child)) {
                    visited.add(child);
                    stack.push({ id: child, i: 0 });
                }
            } else {
                post.push(top.id);
                stack.pop();
            }
        }
    };
    const inReading = [...boxes].sort(reading);
    for (const id of inReading) if (incoming.get(id) === 0) visit(id);
    for (const id of inReading) visit(id);
    const rank = new Map<string, number>(post.reverse().map((id, i) => [id, i]));
    // A zone just before the first box it holds (any depth).
    const zoneRank = (id: string): number => {
        let best = Infinity;
        for (const n of board.nodes) if (n.parent === id) best = Math.min(best, n.shape === 'zone' ? zoneRank(n.id) : rank.get(n.id) ?? Infinity);
        return best - 0.5;
    };
    for (const n of board.nodes) if (n.shape === 'zone') rank.set(n.id, zoneRank(n.id));
    const r = (id: string) => rank.get(id) ?? Infinity;
    return {
        nodes: [...board.nodes].sort((a, b) => r(a.id) - r(b.id) || reading(a.id, b.id)),
        edges: [...board.edges].sort((a, b) => r(a.from) - r(b.from) || r(a.to) - r(b.to)),
    };
}

/** A board as a diagram (what the layout reads), keeping every id. */
function graphOf(board: Board, direction: DiagramDirection | null): DiagramGraph {
    return {
        direction,
        canvasId: null,
        height: null,
        notes: [],
        nodes: board.nodes.map((n) => ({
            id: n.id,
            shape: n.shape,
            text: n.text,
            color: n.color,
            ...(n.kind ? { kind: n.kind } : {}),
            ...(n.size ? { size: n.size } : {}),
            ...(n.parent ? { parent: n.parent } : {}),
        })),
        edges: board.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label, line: e.line, arrow: e.arrow })),
    };
}

/**
 * "Tidy up": the board laid out again by ELK. Ids, zones, parents and arrows stay; positions,
 * zone sizes and routes are new. Boxes keep their width; their height only grows when their text
 * needs it (the browser draws them that tall anyway). Arrows keep their own `path` (used once a
 * box moves and the route goes).
 */
export async function tidyBoard(input: unknown, direction?: 'LR' | 'TB'): Promise<{ board: Board; report: CanvasReport }> {
    const board = boardFromRequest(input);
    const sizes = new Map<string, { w: number; h: number }>();
    for (const n of board.nodes) {
        if (n.shape === 'zone') continue;
        sizes.set(n.id, { w: n.w, h: Math.max(n.h, contentHeight({ shape: n.shape, text: n.text, kind: n.kind, size: n.size }, n.w)) });
    }
    const laid = await layoutDiagram(graphOf(flowOrder(board), direction ?? null), { sizes });
    // The browser's stacking order and arrow paths stay.
    const z = new Map(board.nodes.map((n) => [n.id, n.z]));
    const path = new Map(board.edges.map((e) => [e.id, e.path]));
    // Back in the order they came in (the layout read them in flow order).
    const nodeAt = new Map(board.nodes.map((n, i) => [n.id, i]));
    const edgeAt = new Map(board.edges.map((e, i) => [e.id, i]));
    const tidy: Board = {
        nodes: laid.board.nodes.map((n) => ({ ...n, z: z.get(n.id) ?? n.z })).sort((a, b) => (nodeAt.get(a.id) ?? 0) - (nodeAt.get(b.id) ?? 0)),
        edges: laid.board.edges.map((e) => ({ ...e, path: path.get(e.id) ?? e.path })).sort((a, b) => (edgeAt.get(a.id) ?? 0) - (edgeAt.get(b.id) ?? 0)),
    };
    return { board: tidy, report: canvasReport(tidy, fittedCanvasHeight(tidy)) };
}

export type RenderFormat = 'svg' | 'png';

/** The board drawn by the server: an SVG document or a PNG at 2×. */
export function renderBoard(input: unknown, format: RenderFormat, theme: Theme): { body: Buffer | string; contentType: string; width: number; height: number } {
    const board = boardFromRequest(input);
    const { svg, width, height } = boardToSvg(board, theme);
    if (format === 'svg') return { body: svg, contentType: 'image/svg+xml; charset=utf-8', width, height };
    const png = svgToPng(svg, width, height);
    return { body: png.png, contentType: 'image/png', width: png.width, height: png.height };
}
