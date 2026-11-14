// A parsed diagram → a laid-out Board, with ELK (elkjs, EPL-2.0) on the server: the layered
// algorithm, zones as compound nodes (room for the title at the top), right-angle arrows with
// bend points, labels centred on their arrow, the order the agent wrote kept where it can be.
//
// Board conventions (CANVAS_BLOCK_SPEC §9): a node's x, y are relative to its zone (ELK's own
// convention for children), every route is in absolute board coordinates. The board starts at
// (0, 0), numbers are integers, and the same text always gives the same board.
//
// Without a direction the diagram is laid out both left to right and top to bottom, and the one
// that shows bigger in a doc's 720 px column wins (LR when they are within 0.05).
import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from 'elkjs/lib/elk-api';
import ErrorResponse from '../../../utils/errorResponse';
import { FITTED_HEIGHT, docZoom, zonesFirst, type Board, type EdgeRecord, type NodeRecord, type Rect } from '../canvas';
import { nearestOn, type Point } from './geometry';
import { ZONE, boxSize, labelSize, zoneMinWidth, zoneTitleBand } from './measure';
import type { DiagramDirection, DiagramGraph, DiagramNode } from './parse';

export interface LaidOutDiagram {
    board: Board;
    direction: DiagramDirection;
    /** The board's size (the box around every node). */
    width: number;
    height: number;
}

const ELK_DIRECTION: Readonly<Record<DiagramDirection, string>> = { LR: 'RIGHT', RL: 'LEFT', TB: 'DOWN', BT: 'UP' };

/**
 * Spacing tuned for a 720 px doc column (a board shows small there, so every px of air costs):
 * boxes 32 apart in a layer and 24 between layers (an arrow label sits in a layer of its own, so a
 * labelled arrow gets that much more), arrows 10 apart.
 */
const SPACING: LayoutOptions = {
    'elk.spacing.nodeNode': '32',
    'elk.layered.spacing.nodeNodeBetweenLayers': '24',
    'elk.spacing.edgeNode': '14',
    'elk.layered.spacing.edgeNodeBetweenLayers': '12',
    'elk.spacing.edgeEdge': '10',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '8',
    'elk.spacing.edgeLabel': '4',
};

const rootOptions = (direction: DiagramDirection): LayoutOptions => ({
    'elk.algorithm': 'layered',
    'elk.direction': ELK_DIRECTION[direction],
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.json.edgeCoords': 'ROOT',
    'elk.randomSeed': '1',
    // The order the agent wrote: boxes and arrows keep it where they can, and an arrow back to a
    // box written earlier is the one turned round when the arrows go in a circle.
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    // Not postCompaction: in 0.12.1 it can push two boxes of a small component onto each other.
    'elk.separateConnectedComponents': 'true',
    'elk.spacing.componentComponent': '40',
    'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    ...SPACING,
});

const LABEL_OPTIONS: LayoutOptions = { 'elk.edgeLabels.inline': 'true', 'elk.edgeLabels.placement': 'CENTER' };

/** The engine, loaded on first use (the bundle is large and most requests never draw). */
let engine: Promise<ELK> | null = null;
function elk(): Promise<ELK> {
    engine ??= import('elkjs/lib/elk.bundled.js').then((mod) => new mod.default());
    return engine;
}

// ─── ELK in and out ────────────────────────────────────────────────────

/** Options of a layout. */
export interface LayoutOptionsIn {
    /** Box sizes to keep (a board someone resized: "Tidy up"); others are measured from their text. */
    sizes?: ReadonlyMap<string, { w: number; h: number }> | undefined;
}

function buildGraph(graph: DiagramGraph, direction: DiagramDirection, options: LayoutOptionsIn): ElkNode {
    const children = new Map<string | undefined, DiagramNode[]>();
    for (const node of graph.nodes) {
        const list = children.get(node.parent) ?? [];
        list.push(node);
        children.set(node.parent, list);
    }
    const toElk = (node: DiagramNode): ElkNode => {
        if (node.shape !== 'zone') {
            const size = options.sizes?.get(node.id) ?? boxSize({ shape: node.shape, text: node.text, kind: node.kind, size: node.size });
            return { id: node.id, ...sizeOf(size) };
        }
        const band = zoneTitleBand(node.text);
        const top = band.h + ZONE.gap;
        const minW = zoneMinWidth(node.text);
        const minH = top + 24 + ZONE.bottom;
        const kids = children.get(node.id) ?? [];
        return {
            id: node.id,
            ...(kids.length === 0 ? { width: minW, height: minH } : {}),
            layoutOptions: {
                ...SPACING,
                'elk.padding': `[top=${top},left=${ZONE.side},bottom=${ZONE.bottom},right=${ZONE.side}]`,
                'elk.nodeSize.constraints': '[MINIMUM_SIZE]',
                'elk.nodeSize.minimum': `(${minW}, ${minH})`,
                'elk.contentAlignment': '[H_CENTER, V_TOP]',
            },
            children: kids.map(toElk),
        };
    };
    const edges: ElkExtendedEdge[] = graph.edges.map((e) => ({
        id: e.id,
        sources: [e.from],
        targets: [e.to],
        labels: e.label ? [{ id: `${e.id}:label`, text: e.label, ...sizeOf(labelSize(e.label)), layoutOptions: LABEL_OPTIONS }] : [],
    }));
    return { id: 'root', layoutOptions: rootOptions(direction), children: (children.get(undefined) ?? []).map(toElk), edges };
}

const sizeOf = (size: { w: number; h: number }) => ({ width: size.w, height: size.h });

interface RawEdge {
    points: Point[];
    label: Point | null;
}

/** ELK's result: every node's absolute box, every edge's absolute path (edgeCoords ROOT). */
function readResult(root: ElkNode): { boxes: Map<string, Rect>; edges: Map<string, RawEdge> } {
    const boxes = new Map<string, Rect>();
    const edges = new Map<string, RawEdge>();
    const walk = (node: ElkNode, ox: number, oy: number) => {
        for (const child of node.children ?? []) {
            const x = ox + (child.x ?? 0);
            const y = oy + (child.y ?? 0);
            boxes.set(child.id, { x, y, w: child.width ?? 0, h: child.height ?? 0 });
            walk(child, x, y);
        }
        for (const edge of node.edges ?? []) {
            const points: Point[] = [];
            for (const section of (edge as ElkExtendedEdge).sections ?? []) {
                for (const p of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) points.push([p.x, p.y]);
            }
            const l = edge.labels?.[0];
            const label: Point | null = l && l.x !== undefined && l.y !== undefined ? [l.x + (l.width ?? 0) / 2, l.y + (l.height ?? 0) / 2] : null;
            edges.set(edge.id, { points, label });
        }
    };
    walk(root, 0, 0);
    return { boxes, edges };
}

// ─── Tidying routes ────────────────────────────────────────────────────

/** Jogs shorter than this (ELK leaves a few px where an arrow crosses a zone's edge) are straightened. */
const JOG = 8;
/** An S-shaped arrow whose step is shorter than this becomes straight, when one end can slide along its side. */
const STEP = 24;
/** A moved end stays this far from its side's corners… */
const CORNER = 4;
/** …and this far from where another arrow meets the same box. */
const END_GAP = 10;

/** Without repeated points and without points in the middle of a straight run. */
function simplify(points: readonly Point[]): Point[] {
    const out: Point[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (last && last[0] === p[0] && last[1] === p[1]) continue;
        const prev = out[out.length - 2];
        if (prev && last && ((prev[0] === last[0] && last[0] === p[0]) || (prev[1] === last[1] && last[1] === p[1]))) out[out.length - 1] = p;
        else out.push(p);
    }
    return out;
}

/** True when `p` lies on `box`'s border, away from its corners. */
function onBorder(p: Point, box: Rect): boolean {
    const [x, y] = p;
    const inX = x >= box.x + CORNER && x <= box.x + box.w - CORNER;
    const inY = y >= box.y + CORNER && y <= box.y + box.h - CORNER;
    return ((x === box.x || x === box.x + box.w) && inY) || ((y === box.y || y === box.y + box.h) && inX);
}

/**
 * Straightens tiny jogs: a short segment between two parallel runs goes, by moving one run onto
 * the other's line. An end point only moves if it stays on its box's side.
 */
function removeJogs(input: readonly Point[], from: Rect, to: Rect): Point[] {
    let points = simplify(input);
    for (let guard = 0; guard < 50; guard += 1) {
        let fixed = false;
        for (let i = 1; i + 2 < points.length; i += 1) {
            const a = points[i]!;
            const b = points[i + 1]!;
            const len = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
            if (len === 0 || len >= JOG) continue;
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const last = points.length - 1;
            // Move the run before the jog onto the run after it…
            const start = points[i - 1]!;
            const movedStart: Point = [start[0] + dx, start[1] + dy];
            if (i - 1 > 0 || onBorder(movedStart, from)) {
                points[i - 1] = movedStart;
                points[i] = b;
                fixed = true;
            } else {
                // …or the run after it onto the run before.
                const end = points[i + 2]!;
                const movedEnd: Point = [end[0] - dx, end[1] - dy];
                if (i + 2 < last || onBorder(movedEnd, to)) {
                    points[i + 2] = movedEnd;
                    points[i + 1] = a;
                    fixed = true;
                }
            }
            if (fixed) break;
        }
        if (!fixed) break;
        points = simplify(points);
    }
    return points;
}

/**
 * Where an arrow that meets `box`'s bounding box at `p` (on `side`) meets the shape's drawn
 * outline instead (the browser's ShapeNode outlines), moving along the arrow, towards the centre.
 */
function outlinePoint(p: Point, box: Rect, shape: NodeRecord['shape'], side: 'left' | 'right' | 'top' | 'bottom'): Point {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const rx = box.w / 2;
    const ry = box.h / 2;
    const horizontal = side === 'left' || side === 'right';
    const sign = side === 'left' || side === 'top' ? -1 : 1;
    const along = horizontal ? (p[1] - cy) / ry : (p[0] - cx) / rx; // −1…1 across the side
    const root = Math.sqrt(Math.max(0, 1 - along * along));
    let inset: number | null = null; // how far in from the bounding box the outline is, at p
    if (shape === 'ellipse') inset = (horizontal ? rx : ry) * (1 - root);
    else if (shape === 'diamond') inset = (horizontal ? rx : ry) * Math.abs(along);
    else if (shape === 'pill') {
        const r = Math.min(rx, ry);
        if (horizontal && rx >= ry) inset = r - Math.sqrt(Math.max(0, r * r - (p[1] - cy) ** 2));
        else if (!horizontal && rx >= ry) {
            const past = Math.abs(p[0] - cx) - (rx - r);
            inset = past > 0 ? r - Math.sqrt(Math.max(0, r * r - past * past)) : 0;
        }
    } else if (shape === 'cylinder' && !horizontal) inset = box.h * (0.11 - 0.0945 * root);
    else if (shape === 'queue' && horizontal) inset = box.w * (0.08 - 0.0675 * root);
    if (inset === null || inset <= 0.5) return p;
    const d = Math.round(inset);
    if (horizontal) return [side === 'left' ? p[0] + d : p[0] - d, p[1]];
    return [p[0], sign < 0 ? p[1] + d : p[1] - d];
}

/** The side of `box` that `p` is on, or null when it is on none. */
function sideOf(p: Point, box: Rect): 'left' | 'right' | 'top' | 'bottom' | null {
    if (p[0] === box.x) return 'left';
    if (p[0] === box.x + box.w) return 'right';
    if (p[1] === box.y) return 'top';
    if (p[1] === box.y + box.h) return 'bottom';
    return null;
}

/** Ends moved from the bounding box onto the drawn outline of ellipses, diamonds, pills, cylinders and queues. */
function onOutlines(points: Point[], from: { box: Rect; shape: NodeRecord['shape'] }, to: { box: Rect; shape: NodeRecord['shape'] }): Point[] {
    if (points.length < 2) return points;
    const out = points.map((p): Point => [p[0], p[1]]);
    const ends: Array<[number, number, typeof from]> = [
        [0, 1, from],
        [out.length - 1, out.length - 2, to],
    ];
    for (const [i, j, end] of ends) {
        const side = sideOf(out[i]!, end.box);
        if (!side) continue;
        const moved = outlinePoint(out[i]!, end.box, end.shape, side);
        // Only along the arrow's own (perpendicular) last run, and never past the next bend.
        const next = out[j]!;
        const horizontal = side === 'left' || side === 'right';
        if (horizontal ? next[1] !== out[i]![1] : next[0] !== out[i]![0]) continue;
        out[i] = moved;
    }
    return out;
}

/**
 * An arrow that leaves one box and steps sideways by a few px before it reaches the next (two
 * parallel runs and a short step between) becomes one straight run, by sliding one of its ends
 * along its box's side, when that end stays on the side and clear of the other arrows' ends.
 * `ends` holds every arrow's end points per box; it is kept up to date.
 */
function straightenStep(points: Point[], from: { id: string; box: Rect }, to: { id: string; box: Rect }, ends: Map<string, Point[]>): Point[] {
    if (points.length !== 4) return points;
    const [p0, p1, p2, p3] = points as [Point, Point, Point, Point];
    const step: Point = [p2[0] - p1[0], p2[1] - p1[1]];
    const len = Math.abs(step[0]) + Math.abs(step[1]);
    if (len === 0 || len >= STEP) return points;
    const clear = (p: Point, own: Point, id: string) => (ends.get(id) ?? []).every((q) => q === own || Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) >= END_GAP);
    const slide = (end: Point, by: Point, node: { id: string; box: Rect }): Point | null => {
        const moved: Point = [end[0] + by[0], end[1] + by[1]];
        return onBorder(moved, node.box) && clear(moved, end, node.id) ? moved : null;
    };
    const target = slide(p3, [-step[0], -step[1]], to);
    if (target) {
        replaceEnd(ends, to.id, p3, target);
        return [p0, target];
    }
    const source = slide(p0, step, from);
    if (source) {
        replaceEnd(ends, from.id, p0, source);
        return [source, p3];
    }
    return points;
}

function replaceEnd(ends: Map<string, Point[]>, id: string, old: Point, next: Point): void {
    const list = ends.get(id);
    const i = list?.indexOf(old) ?? -1;
    if (list && i >= 0) list[i] = next;
}

// ─── One layout ────────────────────────────────────────────────────────

async function layoutOnce(graph: DiagramGraph, direction: DiagramDirection, options: LayoutOptionsIn): Promise<LaidOutDiagram> {
    let result: ElkNode;
    try {
        result = await (await elk()).layout(buildGraph(graph, direction, options));
    } catch (err) {
        throw new ErrorResponse(500, `The canvas could not be laid out: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { boxes, edges: rawEdges } = readResult(result);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    // Integers from the top-left of the board. Absolute numbers are rounded first, so a box's
    // border and the arrows ending on it round alike.
    const all = [...boxes.values()];
    const minX = Math.min(...all.map((b) => b.x));
    const minY = Math.min(...all.map((b) => b.y));
    const round = (v: number, min: number) => Math.round(v - min);
    const abs = new Map<string, Rect>();
    for (const [id, b] of boxes) {
        const x = round(b.x, minX);
        const y = round(b.y, minY);
        abs.set(id, { x, y, w: round(b.x + b.w, minX) - x, h: round(b.y + b.h, minY) - y });
    }

    const ordered = [...zonesFirst(graph.nodes.filter((n) => n.shape === 'zone')), ...graph.nodes.filter((n) => n.shape !== 'zone')];
    const nodes: NodeRecord[] = ordered.map((n, z) => {
        const box = abs.get(n.id)!;
        const parent = n.parent ? abs.get(n.parent)! : { x: 0, y: 0 };
        const record: NodeRecord = { id: n.id, shape: n.shape, text: n.text, x: box.x - parent.x, y: box.y - parent.y, w: box.w, h: box.h, color: n.color, z };
        if (n.size) record.size = n.size;
        if (n.kind) record.kind = n.kind;
        if (n.parent) record.parent = n.parent;
        return record;
    });

    // Routes: rounded, tidied (tiny jogs and short S-steps straightened), ended on the drawn outlines.
    const routes = new Map<string, Point[]>();
    for (const e of graph.edges) {
        const raw = rawEdges.get(e.id);
        if (!raw || raw.points.length < 2) continue;
        const rounded = raw.points.map((p): Point => [round(p[0], minX), round(p[1], minY)]);
        routes.set(e.id, e.from === e.to ? simplify(rounded) : removeJogs(rounded, abs.get(e.from)!, abs.get(e.to)!));
    }
    const ends = new Map<string, Point[]>();
    const addEnd = (id: string, p: Point) => ends.set(id, [...(ends.get(id) ?? []), p]);
    for (const e of graph.edges) {
        const points = routes.get(e.id);
        if (!points) continue;
        addEnd(e.from, points[0]!);
        addEnd(e.to, points[points.length - 1]!);
    }
    const edges: EdgeRecord[] = graph.edges.map((e) => {
        const record: EdgeRecord = { id: e.id, from: e.from, to: e.to, label: e.label, line: e.line, arrow: e.arrow, path: 'elbow' };
        const tidy = routes.get(e.id);
        if (!tidy) return record;
        const from = { id: e.from, box: abs.get(e.from)!, shape: byId.get(e.from)!.shape };
        const to = { id: e.to, box: abs.get(e.to)!, shape: byId.get(e.to)!.shape };
        const points = onOutlines(e.from === e.to ? tidy : straightenStep(tidy, from, to, ends), from, to);
        record.route = { points };
        const label = rawEdges.get(e.id)?.label;
        if (e.label && label) record.route.label = nearestOn(points, [label[0] - minX, label[1] - minY]);
        return record;
    });

    const width = Math.max(0, ...[...abs.values()].map((b) => b.x + b.w));
    const height = Math.max(0, ...[...abs.values()].map((b) => b.y + b.h));
    return { board: { nodes, edges }, direction, width, height };
}

/**
 * Lays a parsed diagram out. The direction is the diagram's own, or (without one) whichever of
 * LR and TB shows bigger in a doc's column, in a frame `graph.height` tall (fitted, at most 880).
 */
export async function layoutDiagram(graph: DiagramGraph, options: LayoutOptionsIn = {}): Promise<LaidOutDiagram> {
    if (graph.nodes.length === 0) return { board: { nodes: [], edges: [] }, direction: graph.direction ?? 'LR', width: 0, height: 0 };
    if (graph.direction) return layoutOnce(graph, graph.direction, options);
    const lr = await layoutOnce(graph, 'LR', options);
    const tb = await layoutOnce(graph, 'TB', options);
    const frame = graph.height ?? FITTED_HEIGHT.max;
    return docZoom(tb.width, tb.height, frame) > docZoom(lr.width, lr.height, frame) + 0.05 ? tb : lr;
}
