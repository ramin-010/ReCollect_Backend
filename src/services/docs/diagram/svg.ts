// A board drawn as SVG on the server (AGENT_DIAGRAMS_PLAN §4.4, step 3), light or dark: the agent's
// preview (preview_diagram), "Save as SVG/PNG", and pictures where no browser runs. It follows the
// board's own look (recollect/components/docs/editor/canvas/canvas.css and the .rc tokens in
// recollect/components/rc-ui/rc-ui.css): paper boxes with a hairline ring on surface 2, Notion's
// colour tints, zones as tinted frames with their title, kind icons, routed arrows with labels on
// the board's colour. Text wraps as the browser wraps it (./measure.ts).
import { absoluteBoxes, type Board, type CanvasColor, type EdgeRecord, type NodeRecord, type Rect } from '../canvas';
import type { Point } from './geometry';
import { iconSvg } from './icons';
import { labelSize, textWidth, wrapText, ZONE } from './measure';

export type Theme = 'light' | 'dark';

interface Palette {
    board: string;
    ink1: string;
    ink2: string;
    edge: string;
    /** Fill and ring per colour. */
    tint: Record<CanvasColor, [string, string]>;
    /** A sticky's ring (the card shadow's hairline) and its drop shadow's opacity. */
    stickyRing: [string, number];
    shadow: number;
}

const PALETTES: Readonly<Record<Theme, Palette>> = {
    light: {
        board: '#f4f3f2',
        ink1: '#2c2c2b',
        ink2: '#5f5e59',
        edge: '#73706b',
        tint: {
            default: ['#ffffff', '#e3e2df'],
            gray: ['#f0efed', '#e6e5e3'],
            blue: ['#e5f2fc', '#cee3f7'],
            green: ['#e8f1ec', '#d7e6dd'],
            yellow: ['#f9f3dc', '#f2e3b7'],
            red: ['#fce9e7', '#f7d9d5'],
        },
        stickyRing: ['#2a1c00', 0.07],
        shadow: 0.06,
    },
    dark: {
        board: '#262626',
        ink1: '#f0efed',
        ink2: '#ada9a3',
        edge: '#8e8b86',
        tint: {
            default: ['#2f2f2f', '#3f3e3c'],
            gray: ['#383836', '#4a4947'],
            blue: ['#233850', '#2f4b6b'],
            green: ['#263d30', '#33533f'],
            yellow: ['#504425', '#6a5a30'],
            red: ['#502c29', '#6b3b37'],
        },
        stickyRing: ['#2c2c2b', 1],
        shadow: 0.18,
    },
};

const FONT = `'Segoe UI', Arial, sans-serif`;
const PAD = 24;
const ICON = 16;
const ICON_GAP = 6;
const ARROW_LENGTH = 9;
const ARROW_HALF = 4;

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: number): string => String(Math.round(n * 100) / 100);

/** How a shape holds its text (canvas.css .cv-label and its per-shape paddings). */
interface TextBox {
    font: number;
    lineHeight: number;
    bold: boolean;
    left: (w: number) => number;
    right: (w: number) => number;
    top: (w: number) => number;
    bottom: number;
    /** Left-aligned, top-aligned (a sticky). */
    start: boolean;
    topAligned: boolean;
}

const CENTRED = { font: 14, lineHeight: 19.6, bold: false, bottom: 8, start: false, topAligned: false };
function textBoxOf(node: NodeRecord): TextBox {
    switch (node.shape) {
        case 'ellipse':
            return { ...CENTRED, left: (w) => 0.18 * w, right: (w) => 0.18 * w, top: () => 10, bottom: 10 };
        case 'diamond':
            return { ...CENTRED, left: (w) => 0.22 * w, right: (w) => 0.22 * w, top: () => 14, bottom: 14 };
        case 'cylinder':
            return { ...CENTRED, left: () => 10, right: () => 10, top: (w) => 0.22 * w, bottom: 10 };
        case 'queue':
            return { ...CENTRED, left: (w) => 0.09 * w, right: (w) => 0.16 * w, top: () => 8 };
        case 'sticky':
            return { font: 14, lineHeight: 14 * 1.45, bold: false, left: () => 16, right: () => 16, top: () => 14, bottom: 14, start: true, topAligned: true };
        case 'text': {
            const size = node.size === 's' ? { font: 14, lineHeight: 19.6, bold: false } : node.size === 'l' ? { font: 20, lineHeight: 26, bold: true } : { font: 16, lineHeight: 22.4, bold: false };
            return { ...size, left: () => 6, right: () => 6, top: () => 4, bottom: 4, start: true, topAligned: false };
        }
        default:
            return { ...CENTRED, left: () => 12, right: () => 12, top: () => 8 };
    }
}

/** A baseline for a line box of `lineHeight` starting at `top`. */
const baseline = (top: number, lineHeight: number, font: number) => top + lineHeight / 2 + 0.36 * font;

interface Laid {
    node: NodeRecord;
    /** Where it is drawn: its box, grown taller when its text needs it (as the browser does). */
    rect: Rect;
    lines: string[];
    box: TextBox;
}

function layText(node: NodeRecord, at: Rect): Laid {
    const box = textBoxOf(node);
    const icon = node.kind ? ICON + ICON_GAP : 0;
    const room = at.w - box.left(at.w) - box.right(at.w) - icon;
    const lines = node.text ? wrapText(node.text, box.font, Math.max(room, 8), box.bold) : [];
    const need = box.top(at.w) + Math.max(lines.length, 1) * box.lineHeight + box.bottom;
    return { node, rect: { ...at, h: Math.max(at.h, Math.ceil(need)) }, lines, box };
}

/** A shape's outline in the board's look: fill, and a 1 px ring just inside the edge. */
function shapeSvg(laid: Laid, p: Palette): string {
    const { node, rect: r } = laid;
    const [fill0, ring] = p.tint[node.color];
    const fill = node.shape === 'sticky' && node.color === 'default' ? p.tint.yellow[0] : fill0;
    const x = r.x;
    const y = r.y;
    const at = (px: number, py: number) => `${num(x + (px * r.w) / 100)},${num(y + (py * r.h) / 100)}`;
    const stroke = `fill="${fill}" stroke="${ring}" stroke-width="1"`;
    switch (node.shape) {
        case 'text':
            return '';
        case 'ellipse':
            return `<ellipse cx="${num(x + r.w / 2)}" cy="${num(y + r.h / 2)}" rx="${num(r.w / 2 - 0.5)}" ry="${num(r.h / 2 - 0.5)}" ${stroke}/>`;
        case 'diamond':
            return `<polygon points="${at(50, 0.6)} ${at(99.4, 50)} ${at(50, 99.4)} ${at(0.6, 50)}" ${stroke}/>`;
        case 'cylinder':
            return (
                `<path d="M${at(0.6, 11)} C${at(0.6, -1.6)} ${at(99.4, -1.6)} ${at(99.4, 11)} L${at(99.4, 89)} C${at(99.4, 101.6)} ${at(0.6, 101.6)} ${at(0.6, 89)} Z" ${stroke}/>` +
                `<path d="M${at(0.6, 11)} C${at(0.6, 23.6)} ${at(99.4, 23.6)} ${at(99.4, 11)}" fill="none" stroke="${ring}" stroke-width="1"/>`
            );
        case 'queue':
            return (
                `<path d="M${at(8, 0.6)} L${at(92, 0.6)} C${at(101, 0.6)} ${at(101, 99.4)} ${at(92, 99.4)} L${at(8, 99.4)} C${at(-1, 99.4)} ${at(-1, 0.6)} ${at(8, 0.6)} Z" ${stroke}/>` +
                `<path d="M${at(92, 0.6)} C${at(83, 0.6)} ${at(83, 99.4)} ${at(92, 99.4)}" fill="none" stroke="${ring}" stroke-width="1"/>`
            );
        case 'sticky': {
            const [shadowRing, ringOpacity] = p.stickyRing;
            return (
                `<rect x="${num(x)}" y="${num(y + 2)}" width="${num(r.w)}" height="${num(r.h)}" rx="4" fill="#000" fill-opacity="${p.shadow}"/>` +
                `<rect x="${num(x + 0.5)}" y="${num(y + 0.5)}" width="${num(r.w - 1)}" height="${num(r.h - 1)}" rx="4" fill="${fill}" stroke="${shadowRing}" stroke-opacity="${ringOpacity}" stroke-width="1"/>`
            );
        }
        default: {
            const radius = node.shape === 'pill' ? r.h / 2 : node.shape === 'rounded' ? 14 : 8;
            return `<rect x="${num(x + 0.5)}" y="${num(y + 0.5)}" width="${num(r.w - 1)}" height="${num(r.h - 1)}" rx="${num(Math.min(radius, r.h / 2, r.w / 2))}" ${stroke}/>`;
        }
    }
}

/** The text (and kind icon) of a box. */
function textSvg(laid: Laid, p: Palette): string {
    const { node, rect: r, lines, box } = laid;
    if (lines.length === 0 && !node.kind) return '';
    const left = r.x + box.left(r.w);
    const right = r.x + r.w - box.right(r.w);
    const blockH = Math.max(lines.length, 1) * box.lineHeight;
    const labelH = box.top(r.w) + blockH + box.bottom;
    const top = box.topAligned ? r.y + box.top(r.w) : r.y + (r.h - labelH) / 2 + box.top(r.w);
    const widest = Math.min(Math.max(0, ...lines.map((l) => textWidth(l, box.font, box.bold))), right - left - (node.kind ? ICON + ICON_GAP : 0));
    const icon = node.kind ? ICON + ICON_GAP : 0;
    const groupLeft = box.start ? left : (left + right) / 2 - (icon + widest) / 2;
    const parts: string[] = [];
    if (node.kind) parts.push(iconSvg(node.kind, groupLeft, top + blockH / 2 - ICON / 2, ICON, p.ink2));
    const textX = box.start ? groupLeft + icon : groupLeft + icon + widest / 2;
    const anchor = box.start ? 'start' : 'middle';
    lines.forEach((line, i) => {
        parts.push(
            `<text x="${num(textX)}" y="${num(baseline(top + i * box.lineHeight, box.lineHeight, box.font))}" font-size="${box.font}"${box.bold ? ' font-weight="600"' : ''} fill="${p.ink1}" text-anchor="${anchor}">${esc(line)}</text>`
        );
    });
    return parts.join('');
}

function zoneSvg(node: NodeRecord, r: Rect, p: Palette): string {
    const [fill, ring] = node.color === 'default' ? p.tint.gray : p.tint[node.color];
    const opacity = node.color === 'default' || node.color === 'gray' ? 1 : 0.7;
    const title = node.text
        ? `<text x="${num(r.x + ZONE.titleLeft + ZONE.titlePad)}" y="${num(baseline(r.y + ZONE.titleTop + 1, ZONE.lineHeight, ZONE.font))}" font-size="${ZONE.font}" font-weight="600" fill="${p.ink2}">${esc(node.text.split('\n')[0]!)}</text>`
        : '';
    return `<rect x="${num(r.x + 0.5)}" y="${num(r.y + 0.5)}" width="${num(r.w - 1)}" height="${num(r.h - 1)}" rx="12" fill="${fill}" fill-opacity="${opacity}" stroke="${ring}" stroke-width="1"/>${title}`;
}

// ─── Arrows ────────────────────────────────────────────────────────────

const centreOf = (r: Rect): Point => [r.x + r.w / 2, r.y + r.h / 2];

/** Where the line from a box's centre towards `p` leaves the box's outline (as the browser draws straight arrows). */
function outlinePoint(r: Rect, shape: NodeRecord['shape'], p: Point, gap: number): Point {
    const [cx, cy] = centreOf(r);
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    if (dx === 0 && dy === 0) return [cx, cy];
    const hw = Math.max(r.w / 2, 1);
    const hh = Math.max(r.h / 2, 1);
    const t =
        shape === 'ellipse'
            ? 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh))
            : shape === 'diamond'
              ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
              : 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
    const extra = gap / Math.hypot(dx, dy);
    return [cx + dx * (t + extra), cy + dy * (t + extra)];
}

type Side = 'left' | 'right' | 'top' | 'bottom';

function facing(a: Rect, b: Rect): Side {
    const [ax, ay] = centreOf(a);
    const [bx, by] = centreOf(b);
    const dx = (bx - ax) / Math.max(a.w + b.w, 1);
    const dy = (by - ay) / Math.max(a.h + b.h, 1);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
    return dy >= 0 ? 'bottom' : 'top';
}

function sideMiddle(r: Rect, side: Side, gap: number): Point {
    if (side === 'top') return [r.x + r.w / 2, r.y - gap];
    if (side === 'bottom') return [r.x + r.w / 2, r.y + r.h + gap];
    if (side === 'left') return [r.x - gap, r.y + r.h / 2];
    return [r.x + r.w + gap, r.y + r.h / 2];
}

const normal: Record<Side, Point> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/** A right-angled path with rounded corners (as the browser draws an engine route). */
function roundedPath(points: readonly Point[], radius: number): string {
    const pts = points.filter((pt, i) => i === 0 || pt[0] !== points[i - 1]![0] || pt[1] !== points[i - 1]![1]);
    let d = `M${num(pts[0]![0])},${num(pts[0]![1])}`;
    for (let i = 1; i < pts.length; i += 1) {
        const [x, y] = pts[i]!;
        const next = pts[i + 1];
        if (!next) {
            d += ` L${num(x)},${num(y)}`;
            break;
        }
        const [px, py] = pts[i - 1]!;
        const inLen = Math.hypot(x - px, y - py);
        const outLen = Math.hypot(next[0] - x, next[1] - y);
        const r = Math.min(radius, inLen / 2, outLen / 2);
        if (r < 0.5) {
            d += ` L${num(x)},${num(y)}`;
            continue;
        }
        const ax = x - ((x - px) / inLen) * r;
        const ay = y - ((y - py) / inLen) * r;
        const bx = x + ((next[0] - x) / outLen) * r;
        const by = y + ((next[1] - y) / outLen) * r;
        d += ` L${num(ax)},${num(ay)} Q${num(x)},${num(y)} ${num(bx)},${num(by)}`;
    }
    return d;
}

interface ArrowShape {
    d: string;
    /** End points and the direction each one is reached from (for heads). */
    start: Point;
    startFrom: Point;
    end: Point;
    endFrom: Point;
    /** Points along it (bounds, label midpoint). */
    points: Point[];
}

function arrowShape(edge: EdgeRecord, from: { rect: Rect; shape: NodeRecord['shape'] }, to: { rect: Rect; shape: NodeRecord['shape'] }): ArrowShape {
    const route = edge.route?.points;
    if (route && route.length >= 2) {
        const pts = route.map(([x, y]): Point => [x, y]);
        return { d: roundedPath(pts, 8), start: pts[0]!, startFrom: pts[1]!, end: pts[pts.length - 1]!, endFrom: pts[pts.length - 2]!, points: pts };
    }
    if (edge.path === 'straight' || edge.from === edge.to) {
        const a = outlinePoint(from.rect, from.shape, centreOf(to.rect), 2);
        const b = outlinePoint(to.rect, to.shape, centreOf(from.rect), 3);
        return { d: `M${num(a[0])},${num(a[1])} L${num(b[0])},${num(b[1])}`, start: a, startFrom: b, end: b, endFrom: a, points: [a, b] };
    }
    const sa = facing(from.rect, to.rect);
    const sb = facing(to.rect, from.rect);
    const a = sideMiddle(from.rect, sa, 2);
    const b = sideMiddle(to.rect, sb, 3);
    if (edge.path === 'curved') {
        const reach = Math.max(24, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.4);
        const c1: Point = [a[0] + normal[sa][0] * reach, a[1] + normal[sa][1] * reach];
        const c2: Point = [b[0] + normal[sb][0] * reach, b[1] + normal[sb][1] * reach];
        const mid: Point = [(a[0] + 3 * c1[0] + 3 * c2[0] + b[0]) / 8, (a[1] + 3 * c1[1] + 3 * c2[1] + b[1]) / 8];
        return { d: `M${num(a[0])},${num(a[1])} C${num(c1[0])},${num(c1[1])} ${num(c2[0])},${num(c2[1])} ${num(b[0])},${num(b[1])}`, start: a, startFrom: c1, end: b, endFrom: c2, points: [a, mid, b] };
    }
    // Elbow: out of each side, then across at the middle.
    const horizontal = (s: Side) => s === 'left' || s === 'right';
    let pts: Point[];
    if (horizontal(sa) && horizontal(sb)) {
        const mx = (a[0] + b[0]) / 2;
        pts = [a, [mx, a[1]], [mx, b[1]], b];
    } else if (!horizontal(sa) && !horizontal(sb)) {
        const my = (a[1] + b[1]) / 2;
        pts = [a, [a[0], my], [b[0], my], b];
    } else if (horizontal(sa)) {
        pts = [a, [b[0], a[1]], b];
    } else {
        pts = [a, [a[0], b[1]], b];
    }
    return { d: roundedPath(pts, 10), start: a, startFrom: pts[1]!, end: b, endFrom: pts[pts.length - 2]!, points: pts };
}

/** An arrowhead with its tip on `tip`, pointing away from `from`. */
function head(tip: Point, from: Point, color: string): string {
    const dx = tip[0] - from[0];
    const dy = tip[1] - from[1];
    const len = Math.hypot(dx, dy) || 1;
    const [ux, uy] = [dx / len, dy / len];
    const base: Point = [tip[0] - ux * ARROW_LENGTH, tip[1] - uy * ARROW_LENGTH];
    const left: Point = [base[0] - uy * ARROW_HALF, base[1] + ux * ARROW_HALF];
    const right: Point = [base[0] + uy * ARROW_HALF, base[1] - ux * ARROW_HALF];
    return `<polygon points="${num(tip[0])},${num(tip[1])} ${num(left[0])},${num(left[1])} ${num(right[0])},${num(right[1])}" fill="${color}"/>`;
}

/** Halfway along a polyline. */
function midway(points: readonly Point[]): Point {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
    let left = total / 2;
    for (let i = 1; i < points.length; i += 1) {
        const [x0, y0] = points[i - 1]!;
        const [x1, y1] = points[i]!;
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len >= left && len > 0) return [x0 + ((x1 - x0) * left) / len, y0 + ((y1 - y0) * left) / len];
        left -= len;
    }
    return points[points.length - 1] ?? [0, 0];
}

// ─── The board ─────────────────────────────────────────────────────────

export interface BoardSvg {
    svg: string;
    width: number;
    height: number;
}

/** The board as an SVG document, `theme` light or dark, with a 24 px margin of board colour. */
export function boardToSvg(board: Board, theme: Theme = 'light'): BoardSvg {
    const p = PALETTES[theme];
    const abs = absoluteBoxes(board.nodes);
    const laid = new Map<string, Laid>();
    for (const n of board.nodes) if (n.shape !== 'zone') laid.set(n.id, layText(n, abs.get(n.id)!));
    const rectOf = (id: string): Rect => laid.get(id)?.rect ?? abs.get(id)!;
    const shapeOf = (id: string) => board.nodes.find((n) => n.id === id)?.shape ?? 'rect';

    const zones: string[] = [];
    const boxes: string[] = [];
    for (const n of board.nodes) {
        if (n.shape === 'zone') zones.push(zoneSvg(n, abs.get(n.id)!, p));
        else {
            const l = laid.get(n.id)!;
            boxes.push(shapeSvg(l, p) + textSvg(l, p));
        }
    }

    const arrows: string[] = [];
    const labels: string[] = [];
    const extents: Rect[] = [...abs.keys()].map(rectOf);
    for (const e of board.edges) {
        if (!abs.has(e.from) || !abs.has(e.to)) continue;
        const shape = arrowShape(e, { rect: rectOf(e.from), shape: shapeOf(e.from) }, { rect: rectOf(e.to), shape: shapeOf(e.to) });
        const dash = e.line === 'dashed' ? ' stroke-dasharray="6 5"' : '';
        arrows.push(`<path d="${shape.d}" fill="none" stroke="${p.edge}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${dash}/>`);
        if (e.arrow !== 'none') arrows.push(head(shape.end, shape.endFrom, p.edge));
        if (e.arrow === 'both') arrows.push(head(shape.start, shape.startFrom, p.edge));
        for (const [x, y] of shape.points) extents.push({ x, y, w: 0, h: 0 });
        if (e.label) {
            const [cx, cy] = e.route?.label ?? midway(shape.points);
            const size = labelSize(e.label);
            const lines = wrapText(e.label, 12.5, 208);
            const top = cy - size.h / 2;
            labels.push(`<rect x="${num(cx - size.w / 2)}" y="${num(top)}" width="${num(size.w)}" height="${num(size.h)}" rx="4" fill="${p.board}"/>`);
            lines.forEach((line, i) => {
                labels.push(`<text x="${num(cx)}" y="${num(baseline(top + 2 + i * 16.875, 16.875, 12.5))}" font-size="12.5" fill="${p.ink2}" text-anchor="middle">${esc(line)}</text>`);
            });
            extents.push({ x: cx - size.w / 2, y: top, w: size.w, h: size.h });
        }
    }

    const x1 = extents.length > 0 ? Math.floor(Math.min(...extents.map((r) => r.x))) - PAD : 0;
    const y1 = extents.length > 0 ? Math.floor(Math.min(...extents.map((r) => r.y))) - PAD : 0;
    const x2 = extents.length > 0 ? Math.ceil(Math.max(...extents.map((r) => r.x + r.w))) + PAD : 2 * PAD;
    const y2 = extents.length > 0 ? Math.ceil(Math.max(...extents.map((r) => r.y + r.h))) + PAD : 2 * PAD;
    const width = x2 - x1;
    const height = y2 - y1;
    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x1} ${y1} ${width} ${height}" font-family="${FONT}">`,
        `<rect x="${x1}" y="${y1}" width="${width}" height="${height}" fill="${p.board}"/>`,
        ...zones,
        ...arrows,
        ...boxes,
        ...labels,
        '</svg>',
    ].join('\n');
    return { svg, width, height };
}
