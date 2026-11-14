// What an agent should check on a laid-out board, in a line each (AGENT_DIAGRAMS_PLAN §4.4): it
// can't see the drawing, so the canvas report says what a person would notice.
//
//   arrows that cross (how many, and up to 3 pairs)       an arrow running through a box
//   boxes that overlap (or a box partly over a zone)      a label over 40 characters
//   boxes with no arrows (on a board that has arrows)     over 25 boxes
//   a board that shows below 60% in a doc                 and what the parser drew differently
import { absoluteBoxes, docZoom, type Board, type EdgeRecord, type NodeRecord, type Rect } from '../canvas';
import { contains, rectsOverlap, segmentHitsRect, segmentsCross, segmentsOf, type Point, type Segment } from './geometry';

export const LINT = { label: 40, boxes: 25, zoom: 0.6, listed: 3 } as const;

export interface LintOptions {
    /** The block's height in a doc (the frame the board is fitted into). */
    frameHeight: number;
    /** Which way the boxes run (for the advice when it shows small). */
    direction?: 'LR' | 'RL' | 'TB' | 'BT' | null | undefined;
    /** Notes from the parser, added as they are. */
    notes?: readonly string[] | undefined;
}

const isBox = (n: NodeRecord) => n.shape !== 'zone' && n.shape !== 'sticky' && n.shape !== 'text';
const q = (text: string) => JSON.stringify(text.length > 30 ? `${text.slice(0, 29)}…` : text);
const nameOf = (e: EdgeRecord) => `${e.from}→${e.to}`;

/** "a", "b" and "c" (and n more) */
function listOf(items: readonly string[]): string {
    const shown = items.slice(0, LINT.listed);
    const more = items.length - shown.length;
    const head = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : (shown[0] ?? '');
    return more > 0 ? `${shown.join(', ')} and ${more} more` : head;
}

/** The centre of a box. */
const centre = (r: Rect): Point => [r.x + r.w / 2, r.y + r.h / 2];

/**
 * The path an arrow is drawn along: its route, or (a board laid out by hand) the straight line
 * between its boxes, from border to border.
 */
function pathOf(edge: EdgeRecord, boxes: ReadonlyMap<string, Rect>): Point[] {
    if (edge.route && edge.route.points.length >= 2) return edge.route.points;
    const a = boxes.get(edge.from);
    const b = boxes.get(edge.to);
    if (!a || !b || edge.from === edge.to) return [];
    return [borderToward(a, centre(b)), borderToward(b, centre(a))];
}

/** Where the line from a box's centre to `p` leaves the box. */
function borderToward(r: Rect, p: Point): Point {
    const [cx, cy] = centre(r);
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    if (dx === 0 && dy === 0) return [cx, cy];
    const t = 1 / Math.max(Math.abs(dx) / (r.w / 2 || 1), Math.abs(dy) / (r.h / 2 || 1));
    return [cx + dx * Math.min(t, 1), cy + dy * Math.min(t, 1)];
}

/** Every warning for a board, worded for an agent that will fix the text form. */
export function lintBoard(board: Board, options: LintOptions): string[] {
    const warnings: string[] = [];
    const boxes = absoluteBoxes(board.nodes);
    const byId = new Map(board.nodes.map((n) => [n.id, n]));
    const paths = new Map(board.edges.map((e) => [e.id, pathOf(e, boxes)]));

    // Arrows that cross.
    const segments: Array<{ edge: EdgeRecord; seg: Segment }> = [];
    for (const edge of board.edges) for (const seg of segmentsOf(paths.get(edge.id)!)) segments.push({ edge, seg });
    const crossingPairs: string[] = [];
    const crossingArrows = new Set<string>();
    const pairSeen = new Set<string>();
    for (let i = 0; i < segments.length; i += 1) {
        for (let j = i + 1; j < segments.length; j += 1) {
            const s = segments[i]!;
            const t = segments[j]!;
            if (s.edge === t.edge || !segmentsCross(s.seg, t.seg)) continue;
            const key = [s.edge.id, t.edge.id].sort().join('|');
            if (pairSeen.has(key)) continue;
            pairSeen.add(key);
            crossingArrows.add(s.edge.id).add(t.edge.id);
            crossingPairs.push(`${nameOf(s.edge)} × ${nameOf(t.edge)}`);
        }
    }
    if (crossingPairs.length > 0) warnings.push(`${crossingArrows.size} arrows cross (${listOf(crossingPairs)})`);

    // Arrows through boxes (not their own ends, and not zones: an arrow may run through a zone).
    const through: string[] = [];
    for (const edge of board.edges) {
        const path = paths.get(edge.id)!;
        for (const node of board.nodes) {
            if (node.shape === 'zone' || node.id === edge.from || node.id === edge.to) continue;
            const box = boxes.get(node.id)!;
            const inner = { x: box.x + 1, y: box.y + 1, w: box.w - 2, h: box.h - 2 };
            if (segmentsOf(path).some((seg) => segmentHitsRect(seg, inner))) {
                through.push(`${nameOf(edge)} through ${q(node.id)}`);
                break;
            }
        }
    }
    if (through.length > 0) warnings.push(`${through.length === 1 ? 'an arrow runs' : `${through.length} arrows run`} through a box (${listOf(through)})`);

    // Overlaps: boxes on boxes, and a box partly over a zone it is not in (or sticking out of its own).
    const overlaps: string[] = [];
    const inZone = (node: NodeRecord, zone: string): boolean => {
        for (let at = node.parent; at; at = byId.get(at)?.parent) if (at === zone) return true;
        return false;
    };
    const nodes = board.nodes;
    for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
            const a = nodes[i]!;
            const b = nodes[j]!;
            const ra = boxes.get(a.id)!;
            const rb = boxes.get(b.id)!;
            if (a.shape === 'zone' || b.shape === 'zone') {
                const [zone, other] = a.shape === 'zone' ? [a, b] : [b, a];
                const rz = boxes.get(zone.id)!;
                const ro = boxes.get(other.id)!;
                if (inZone(other, zone.id)) {
                    if (!contains(rz, ro)) overlaps.push(`${q(other.id)} sticks out of zone ${q(zone.id)}`);
                } else if (!inZone(zone, other.id) && rectsOverlap(rz, ro, 1)) {
                    overlaps.push(`${q(other.id)} overlaps zone ${q(zone.id)}`);
                }
            } else if (rectsOverlap(ra, rb, 1)) {
                overlaps.push(`${q(a.id)} over ${q(b.id)}`);
            }
        }
    }
    if (overlaps.length > 0) warnings.push(`boxes overlap (${listOf(overlaps)})`);

    // Long labels.
    const long: string[] = [];
    for (const node of nodes) if (isBox(node) && node.text.replace(/\n/g, ' ').length > LINT.label) long.push(q(node.id));
    for (const edge of board.edges) if (edge.label.replace(/\n/g, ' ').length > LINT.label) long.push(`arrow ${nameOf(edge)}`);
    if (long.length > 0) warnings.push(`${long.length === 1 ? 'a label is' : `${long.length} labels are`} over ${LINT.label} characters (${listOf(long)}): shorten, or put the detail in a note`);

    // Boxes no arrow reaches (an arrow to a box's zone counts), on a board with arrows.
    if (board.edges.length > 0) {
        const touched = new Set(board.edges.flatMap((e) => [e.from, e.to]));
        const reached = (node: NodeRecord): boolean => {
            for (let at: string | undefined = node.id; at; at = byId.get(at)?.parent) if (touched.has(at)) return true;
            return false;
        };
        const lonely = nodes.filter((n) => isBox(n) && !reached(n)).map((n) => q(n.id));
        if (lonely.length > 0) warnings.push(`${lonely.length === 1 ? `box ${lonely[0]} has` : `boxes ${listOf(lonely)} have`} no arrows`);
    }

    const count = nodes.filter(isBox).length;
    if (count > LINT.boxes) warnings.push(`over ${LINT.boxes} boxes (${count}): consider splitting it into two canvases`);

    // How big it shows in a doc.
    if (nodes.length > 0) {
        const all = [...boxes.values()];
        const width = Math.max(...all.map((b) => b.x + b.w)) - Math.min(...all.map((b) => b.x));
        const height = Math.max(...all.map((b) => b.y + b.h)) - Math.min(...all.map((b) => b.y));
        const zoom = docZoom(width, height, options.frameHeight);
        if (zoom < LINT.zoom) warnings.push(smallAdvice(zoom, width, height, options));
    }

    for (const note of options.notes ?? []) warnings.push(note.replace(/\.$/, ''));
    return warnings;
}

/** "shows at 45% in a doc (too wide): …" with the change most likely to help. */
function smallAdvice(zoom: number, width: number, height: number, options: LintOptions): string {
    const percent = `shows at ${Math.round(zoom * 100)}% in a doc`;
    const wide = docZoom(width, 0, options.frameHeight) <= docZoom(0, height, options.frameHeight);
    const across = options.direction === 'LR' || options.direction === 'RL';
    if (wide && across) return `${percent} (too wide): try flowchart TB (on an existing board: update_canvas with relayout: true), or split it`;
    if (wide) return `${percent} (too wide): fewer boxes side by side, or split it`;
    if (!across && options.direction) return `${percent} (too tall): try flowchart LR (on an existing board: update_canvas with relayout: true), fewer steps in a row, or split it`;
    return `${percent} (too tall): fewer steps in a row, or split it`;
}
