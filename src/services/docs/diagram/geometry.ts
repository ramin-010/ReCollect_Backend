// Plane geometry for laid-out boards (layout tidying, note placement, lint): points, boxes and the
// polylines arrows are drawn along.
import type { Rect } from '../canvas';

export type Point = [number, number];

export interface Segment {
    a: Point;
    b: Point;
}

/** The segments of a polyline. */
export function segmentsOf(points: readonly Point[]): Segment[] {
    const out: Segment[] = [];
    for (let i = 0; i + 1 < points.length; i += 1) out.push({ a: points[i]!, b: points[i + 1]! });
    return out;
}

/** Two boxes overlap by more than `slack` px (touching edges don't count). */
export function rectsOverlap(r: Rect, s: Rect, slack = 0): boolean {
    return r.x + slack < s.x + s.w && s.x + slack < r.x + r.w && r.y + slack < s.y + s.h && s.y + slack < r.y + r.h;
}

/** `r` grown by `m` on every side. */
export const grow = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

/** `inner` lies within `outer` (edges may touch). */
export const contains = (outer: Rect, inner: Rect): boolean =>
    inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** The empty space between two boxes (0 when they touch or overlap). */
export function gapBetween(r: Rect, s: Rect): number {
    const dx = Math.max(0, s.x - (r.x + r.w), r.x - (s.x + s.w));
    const dy = Math.max(0, s.y - (r.y + r.h), r.y - (s.y + s.h));
    return Math.max(dx, dy);
}

/**
 * A segment passes through the inside of a box (Liang–Barsky clipping): running along its edge
 * or touching a corner doesn't count.
 */
export function segmentHitsRect(seg: Segment, r: Rect): boolean {
    const [x0, y0] = seg.a;
    const [x1, y1] = seg.b;
    const dx = x1 - x0;
    const dy = y1 - y0;
    let t0 = 0;
    let t1 = 1;
    const clip = (p: number, q: number): boolean => {
        if (p === 0) return q > 0; // parallel: inside only when strictly between the edges
        const t = q / p;
        if (p < 0) {
            if (t > t1) return false;
            if (t > t0) t0 = t;
        } else {
            if (t < t0) return false;
            if (t < t1) t1 = t;
        }
        return true;
    };
    if (!clip(-dx, x0 - r.x) || !clip(dx, r.x + r.w - x0) || !clip(-dy, y0 - r.y) || !clip(dy, r.y + r.h - y0)) return false;
    if (t1 - t0 <= 1e-9) return false;
    // The clipped part must reach strictly inside, not just slide along an edge.
    const mx = x0 + ((t0 + t1) / 2) * dx;
    const my = y0 + ((t0 + t1) / 2) * dy;
    return mx > r.x && mx < r.x + r.w && my > r.y && my < r.y + r.h;
}

const cross = (o: Point, a: Point, b: Point): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/**
 * Two segments cross: their insides meet at one point. Segments that only touch (an end on the
 * other) or run along each other don't count.
 */
export function segmentsCross(s: Segment, t: Segment): boolean {
    const d1 = cross(t.a, t.b, s.a);
    const d2 = cross(t.a, t.b, s.b);
    const d3 = cross(s.a, s.b, t.a);
    const d4 = cross(s.a, s.b, t.b);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** The point on a polyline nearest to `p`, rounded. */
export function nearestOn(points: readonly Point[], p: Point): Point {
    let best: Point = points[0] ?? p;
    let bestD = Infinity;
    for (const { a, b } of segmentsOf(points)) {
        const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2));
        const q: Point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
        if (d < bestD) {
            bestD = d;
            best = q;
        }
    }
    return [Math.round(best[0]), Math.round(best[1])];
}

/** The box a label of this size takes when centred on `centre`. */
export const boxAround = (centre: Point, size: { w: number; h: number }): Rect => ({ x: centre[0] - size.w / 2, y: centre[1] - size.h / 2, w: size.w, h: size.h });
