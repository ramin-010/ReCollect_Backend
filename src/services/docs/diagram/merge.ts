// An edited diagram merged into the board it came from (AGENT_DIAGRAMS_PLAN §4.3, step 2): what
// the user arranged stays where they put it, and only what is new gets placed, next to what it connects
// to. The text decides what is on the board; the old board decides where the old things are.
//
//   kept      a node of both boards with the same zone (and still a zone, or still not one): its
//             x, y, w, h stay (on screen: zones that grow move their children's numbers, not them)
//   new       placed at ELK's offset from its nearest placed neighbour (an arrow first, else a kept
//             box in the same zone), a new zone with everything in it; then nudged off whatever
//             it overlaps (16 px clear), towards the side ELK put it on. New things with no
//             neighbour at all go as one block beside the old content (right for LR, below for TB)
//   zones     grow to hold their children with their padding; never shrink
//   arrows    one that existed (same ends, matched in order) keeps its id and path, and its route
//             while both its ends stay put; the text decides its line, head and label
import { absoluteBoxes, zonesFirst, type Board, type EdgeRecord, type EdgeRoute, type NodeRecord, type Rect } from '../canvas';
import { grow, rectsOverlap, segmentHitsRect, segmentsOf, type Point, type Segment } from './geometry';
import { ZONE, zoneMinWidth, zoneTitleBand } from './measure';
import type { DiagramDirection } from './parse';

/** Clear space a placed box keeps from everything else. */
const CLEAR = 16;
/** How far a block of unconnected new boxes sits from the old content. */
const BLOCK_GAP = 48;

export interface MergedBoard {
    board: Board;
    /** Nodes that kept their place. */
    kept: string[];
    /** Nodes placed anew. */
    placed: string[];
}

type Obstacle = { rect: Rect } | { seg: Segment };

const centre = (r: Rect): Point => [r.x + r.w / 2, r.y + r.h / 2];
const moved = (r: Rect, d: Point): Rect => ({ x: r.x + d[0], y: r.y + d[1], w: r.w, h: r.h });
const sameRect = (a: Rect | undefined, b: Rect | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const distance = (a: Rect, b: Rect) => Math.hypot(centre(a)[0] - centre(b)[0], centre(a)[1] - centre(b)[1]);

function union(rects: readonly Rect[]): Rect | null {
    if (rects.length === 0) return null;
    const x1 = Math.min(...rects.map((r) => r.x));
    const y1 = Math.min(...rects.map((r) => r.y));
    const x2 = Math.max(...rects.map((r) => r.x + r.w));
    const y2 = Math.max(...rects.map((r) => r.y + r.h));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** The side a thing sits on, seen from its anchor: the axis of the bigger offset. */
function sideOf(offset: Point): Point {
    if (Math.abs(offset[0]) >= Math.abs(offset[1])) return [offset[0] >= 0 ? 1 : -1, 0];
    return [0, offset[1] >= 0 ? 1 : -1];
}

/**
 * Moves `rect` along `dir` (one axis) past every obstacle it comes near, until it is clear of
 * all of them. It only ever moves one way, so it stops.
 */
function nudge(rect: Rect, dir: Point, obstacles: readonly Obstacle[]): Rect {
    const out = { ...rect };
    for (let i = 0; i < 400; i += 1) {
        const near = grow(out, CLEAR);
        const hit = obstacles.find((o) => ('rect' in o ? rectsOverlap(near, o.rect) : segmentHitsRect(o.seg, grow(out, CLEAR / 2))));
        if (!hit) break;
        const o = 'rect' in hit ? hit.rect : union([{ x: hit.seg.a[0], y: hit.seg.a[1], w: 0, h: 0 }, { x: hit.seg.b[0], y: hit.seg.b[1], w: 0, h: 0 }])!;
        if (dir[0] > 0) out.x = o.x + o.w + CLEAR;
        else if (dir[0] < 0) out.x = o.x - CLEAR - out.w;
        else if (dir[1] > 0) out.y = o.y + o.h + CLEAR;
        else out.y = o.y - CLEAR - out.h;
    }
    return out;
}

/** Arrows of `old` and `next` with the same ends, paired in order: next id → old arrow. */
function matchArrows(old: readonly EdgeRecord[], next: readonly EdgeRecord[]): Map<string, EdgeRecord> {
    const byEnds = new Map<string, EdgeRecord[]>();
    for (const e of old) {
        const key = `${e.from}\u0000${e.to}`;
        byEnds.set(key, [...(byEnds.get(key) ?? []), e]);
    }
    const matched = new Map<string, EdgeRecord>();
    for (const e of next) {
        const queue = byEnds.get(`${e.from}\u0000${e.to}`);
        const first = queue?.shift();
        if (first) matched.set(e.id, first);
    }
    return matched;
}

/**
 * Merges `next` (ELK's layout of the edited text, every id the text names) into `old` (the board
 * as stored). `direction` is the way `next` was laid out.
 */
export function mergeBoards(old: Board, next: Board, direction: DiagramDirection): MergedBoard {
    const oldById = new Map(old.nodes.map((n) => [n.id, n]));
    const nextById = new Map(next.nodes.map((n) => [n.id, n]));
    const oldAbs = absoluteBoxes(old.nodes);
    const elkAbs = absoluteBoxes(next.nodes);
    const isZone = (n: NodeRecord | undefined) => n?.shape === 'zone';

    const kept = new Set(
        next.nodes
            .filter((n) => {
                const o = oldById.get(n.id);
                return !!o && (o.parent ?? null) === (n.parent ?? null) && isZone(o) === isZone(n);
            })
            .map((n) => n.id)
    );

    // Where everything ends up, in board coordinates. Kept nodes: where they were.
    const final = new Map<string, Rect>();
    for (const id of kept) final.set(id, { ...oldAbs.get(id)! });

    // Units: a new node whose zone is kept (or that is top level), with everything inside it.
    const rootOf = (id: string): string => {
        let n = nextById.get(id)!;
        while (n.parent && !kept.has(n.parent)) n = nextById.get(n.parent)!;
        return n.id;
    };
    const units = new Map<string, string[]>();
    for (const n of next.nodes) {
        if (kept.has(n.id)) continue;
        const root = rootOf(n.id);
        units.set(root, [...(units.get(root) ?? []), n.id]);
    }

    // Obstacles new things must stay clear of: kept boxes, kept zones they are not in, the
    // routes that stay (arrows the text keeps, between kept boxes), and what was placed before them.
    const matched = matchArrows(old.edges, next.edges);
    const keptRoutes: Segment[] = [];
    for (const before of matched.values()) {
        if (before.route && kept.has(before.from) && kept.has(before.to)) keptRoutes.push(...segmentsOf(before.route.points));
    }
    const ancestorsOf = (id: string): Set<string> => {
        const out = new Set<string>();
        for (let at = nextById.get(id)?.parent; at; at = nextById.get(at)?.parent) out.add(at);
        return out;
    };
    const delta = new Map<string, Point>();
    for (const id of kept) {
        const before = centre(oldAbs.get(id)!);
        const elk = centre(elkAbs.get(id)!);
        delta.set(id, [before[0] - elk[0], before[1] - elk[1]]);
    }
    const placedUnits: string[] = [];
    const obstaclesFor = (root: string): Obstacle[] => {
        const around = ancestorsOf(root);
        const list: Obstacle[] = [];
        for (const id of kept) {
            if (around.has(id)) continue;
            list.push({ rect: final.get(id)! });
        }
        for (const other of placedUnits) list.push({ rect: final.get(other)! });
        for (const seg of keptRoutes) list.push({ seg });
        return list;
    };
    const place = (root: string, d: Point, dir: Point) => {
        const elkRect = elkAbs.get(root)!;
        const rect = nudge(moved(elkRect, d), dir, obstaclesFor(root));
        const shift: Point = [rect.x - elkRect.x, rect.y - elkRect.y];
        for (const id of units.get(root)!) {
            final.set(id, moved(elkAbs.get(id)!, shift));
            delta.set(id, shift);
        }
        placedUnits.push(root);
        units.delete(root);
    };

    // Anchors: an arrow to something already placed (the nearest, as ELK drew them), else a
    // kept box in the same zone, else the inside of that zone.
    const anchorFor = (root: string, byArrow: boolean): string | null => {
        const members = new Set(units.get(root)!);
        const candidates = new Set<string>();
        if (byArrow) {
            for (const e of next.edges) {
                const [inside, outside] = members.has(e.from) ? [e.from, e.to] : members.has(e.to) ? [e.to, e.from] : [null, null];
                if (!inside || !outside || members.has(outside)) continue;
                if (final.has(outside)) candidates.add(outside);
            }
        } else {
            const parent = nextById.get(root)!.parent;
            if (parent) for (const n of next.nodes) if (n.parent === parent && kept.has(n.id) && n.id !== root) candidates.add(n.id);
        }
        let best: string | null = null;
        for (const c of candidates) if (!best || distance(elkAbs.get(c)!, elkAbs.get(root)!) < distance(elkAbs.get(best)!, elkAbs.get(root)!)) best = c;
        return best;
    };
    for (let progress = true; progress && units.size > 0; ) {
        progress = false;
        for (const byArrow of [true, false]) {
            for (const root of [...units.keys()]) {
                const anchor = anchorFor(root, byArrow);
                if (!anchor) continue;
                const offset: Point = [centre(elkAbs.get(root)!)[0] - centre(elkAbs.get(anchor)!)[0], centre(elkAbs.get(root)!)[1] - centre(elkAbs.get(anchor)!)[1]];
                place(root, delta.get(anchor)!, sideOf(offset));
                progress = true;
            }
            if (progress) break;
        }
    }
    // New things in a kept zone with nothing to go by: inside the zone, under its title.
    for (const root of [...units.keys()]) {
        const parent = nextById.get(root)!.parent;
        if (!parent || !kept.has(parent)) continue;
        const zone = final.get(parent)!;
        const elkRect = elkAbs.get(root)!;
        const top = zoneTitleBand(nextById.get(parent)!.text).h + ZONE.gap;
        place(root, [zone.x + ZONE.side - elkRect.x, zone.y + top - elkRect.y], [0, 1]);
    }
    // The rest: one block beside the old content, as ELK arranged it.
    if (units.size > 0) {
        const keptBounds = union([...kept].map((id) => final.get(id)!));
        const block = union([...units.keys()].map((root) => elkAbs.get(root)!))!;
        const across = direction === 'LR' || direction === 'RL';
        const d: Point = !keptBounds
            ? [0, 0]
            : across
              ? [keptBounds.x + keptBounds.w + BLOCK_GAP - block.x, keptBounds.y - block.y]
              : [keptBounds.x - block.x, keptBounds.y + keptBounds.h + BLOCK_GAP - block.y];
        for (const root of [...units.keys()]) place(root, d, across ? [1, 0] : [0, 1]);
    }

    // Zones grow to hold what they hold (the deepest first), and never shrink.
    const depth = (id: string) => ancestorsOf(id).size;
    const zones = next.nodes.filter(isZone).sort((a, b) => depth(b.id) - depth(a.id));
    for (const z of zones) {
        const children = next.nodes.filter((n) => n.parent === z.id).map((n) => final.get(n.id)!);
        const top = zoneTitleBand(z.text).h + ZONE.gap;
        const inner = union(children);
        const need = inner ? { x: inner.x - ZONE.side, y: inner.y - top, w: inner.w + 2 * ZONE.side, h: inner.h + top + ZONE.bottom } : null;
        let rect = union([final.get(z.id)!, ...(need ? [need] : [])])!;
        const minW = zoneMinWidth(z.text);
        if (rect.w < minW) rect = { ...rect, w: minW };
        final.set(z.id, rect);
    }

    // Records: the text's content at the merged places, numbers relative to the zone.
    const stayed = (id: string) => kept.has(id) && sameRect(final.get(id), oldAbs.get(id));
    const maxZ = Math.max(0, ...old.nodes.map((n) => n.z));
    const minZ = Math.min(0, ...old.nodes.map((n) => n.z));
    let above = maxZ;
    let below = minZ;
    const nodes = next.nodes.map((n): NodeRecord => {
        const rect = final.get(n.id)!;
        const parent = n.parent ? final.get(n.parent)! : { x: 0, y: 0 };
        const o = kept.has(n.id) ? oldById.get(n.id)! : null;
        const z = o ? o.z : isZone(n) ? (below -= 1) : (above += 1);
        const record: NodeRecord = { id: n.id, shape: n.shape, text: n.text, x: rect.x - parent.x, y: rect.y - parent.y, w: rect.w, h: rect.h, color: n.color, z };
        if (n.size) record.size = n.size;
        if (n.kind) record.kind = n.kind;
        if (n.parent) record.parent = n.parent;
        return record;
    });
    const order = new Map(next.nodes.map((n, i) => [n.id, i]));
    const sorted = zonesFirst([...nodes].sort((a, b) => a.z - b.z || order.get(a.id)! - order.get(b.id)!));

    // Arrows. A new arrow never takes the id of one that was removed (that would read as a change).
    const taken = new Set(old.edges.map((e) => e.id));
    let counter = 0;
    const freshId = () => {
        let id: string;
        do id = `e${(counter += 1)}`;
        while (taken.has(id));
        taken.add(id);
        return id;
    };
    const edges = next.edges.map((e): EdgeRecord => {
        const before = matched.get(e.id);
        const record: EdgeRecord = { id: before?.id ?? freshId(), from: e.from, to: e.to, label: e.label, line: e.line, arrow: e.arrow, path: 'elbow' };
        if (before && stayed(e.from) && stayed(e.to)) {
            record.path = before.path;
            if (before.route) record.route = before.route;
            return record;
        }
        // Two new ends moved together: ELK's route moves with them.
        const a = delta.get(e.from);
        const b = delta.get(e.to);
        if (!kept.has(e.from) && !kept.has(e.to) && a && b && a[0] === b[0] && a[1] === b[1] && e.route) record.route = shiftRoute(e.route, a);
        return record;
    });

    return { board: { nodes: sorted, edges }, kept: [...kept], placed: next.nodes.filter((n) => !kept.has(n.id)).map((n) => n.id) };
}

function shiftRoute(route: EdgeRoute, d: Point): EdgeRoute {
    const points = route.points.map(([x, y]): [number, number] => [Math.round(x + d[0]), Math.round(y + d[1])]);
    return route.label ? { points, label: [Math.round(route.label[0] + d[0]), Math.round(route.label[1] + d[1])] } : { points };
}
