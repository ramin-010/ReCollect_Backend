// Canvas blocks on the server (context/specs/CANVAS_BLOCK_SPEC.md §2–§5, v2 records §9): a board
// of boxes and arrows. The `canvas` node (./docSchema.ts) only says where a board sits in the text;
// the board itself lives in two root maps of the doc's Y.Doc, one entry per box or arrow (a plain
// JSON record, never a nested Y type):
//   canvas:<canvasId>:nodes   node id → NodeRecord
//   canvas:<canvasId>:edges   edge id → EdgeRecord
// The node's `data` attr carries a whole Board only on JSON that travels (Markdown → JSON, the
// paste route, agent input); it is taken out before anything reaches the Yjs fragment. A fence in
// the text form (./diagram) first carries a pending diagram there, which resolveDiagrams lays out.
//
//   normalizeBoard(input)            agent / JSON-fence input → a Board (a clear 400 when it can't)
//   printCanvasJsonFence / parseCanvasFence   the v1 JSON form of the ```canvas fence
//   canvasMapNames, canvasIdOfRoot, canvasRootNames
//   readBoard / writeBoard           a board in a Y.Doc (write = clear, then set)
//   takeCanvasData(json, target)     absorb (JSON → Yjs): data out, fresh ids, the boards to write
//   withCanvasData(json, ydoc)       inject (Yjs → JSON, for reading): attrs.data = the board
//   canvasRootsTouched(before, update)   the canvas maps an update changes (Undo's scope)
import crypto from 'node:crypto';
import type { JSONContent } from '@tiptap/core';
import * as Y from 'yjs';
import ErrorResponse from '../../utils/errorResponse';

// ─── Records ───────────────────────────────────────────────────────────

export const CANVAS_SHAPES = ['rect', 'rounded', 'pill', 'ellipse', 'diamond', 'cylinder', 'queue', 'sticky', 'text', 'zone'] as const;
export type CanvasShape = (typeof CANVAS_SHAPES)[number];
/** What a box is (spec §9): the browser draws its icon, and it sets the default shape. */
export const CANVAS_KINDS = [
    'client', 'user', 'mobile', 'service', 'worker', 'function', 'database', 'cache', 'queue', 'stream', 'storage',
    'search', 'cdn', 'dns', 'gateway', 'lb', 'auth', 'external', 'monitor', 'scheduler', 'notify', 'model',
] as const;
export type CanvasKind = (typeof CANVAS_KINDS)[number];
export const CANVAS_COLORS = ['default', 'gray', 'blue', 'green', 'yellow', 'red'] as const;
export type CanvasColor = (typeof CANVAS_COLORS)[number];
export const CANVAS_TEXT_SIZES = ['s', 'm', 'l'] as const;
export type CanvasTextSize = (typeof CANVAS_TEXT_SIZES)[number];
export const EDGE_LINES = ['solid', 'dashed'] as const;
export const EDGE_ARROWS = ['end', 'both', 'none'] as const;
export const EDGE_PATHS = ['straight', 'curved', 'elbow'] as const;
export const CANVAS_LAYOUTS = ['LR', 'TB'] as const;
export type CanvasLayout = (typeof CANVAS_LAYOUTS)[number];

export interface NodeRecord {
    id: string;
    shape: CanvasShape;
    text: string;
    /** Top-left, in canvas units: relative to the parent zone's top-left when `parent` is set. */
    x: number;
    y: number;
    /** Size; h is a minimum (text may make a box taller on screen). */
    w: number;
    h: number;
    color: CanvasColor;
    /** Stacking order, higher on top. */
    z: number;
    size?: CanvasTextSize;
    kind?: CanvasKind;
    /** The zone this node sits in (a node with shape 'zone'); zones nest. */
    parent?: string;
}

/** The layout engine's path for an arrow, in absolute board coordinates (never zone-relative). */
export interface EdgeRoute {
    /** From the source's border to the target's border; right-angle segments. */
    points: Array<[number, number]>;
    /** The label's centre. */
    label?: [number, number];
}

export interface EdgeRecord {
    id: string;
    /** A node id; a zone may be an arrow's end. */
    from: string;
    to: string;
    label: string;
    line: (typeof EDGE_LINES)[number];
    arrow: (typeof EDGE_ARROWS)[number];
    path: (typeof EDGE_PATHS)[number];
    /** Only true while neither end moves: the browser drops it when it moves an end. */
    route?: EdgeRoute;
}

/** A whole board; nodes are listed in z order, every zone before the nodes inside it. */
export interface Board {
    nodes: NodeRecord[];
    edges: EdgeRecord[];
}

export const SHAPE_SIZES: Readonly<Record<CanvasShape, { w: number; h: number }>> = {
    rect: { w: 160, h: 64 },
    rounded: { w: 160, h: 64 },
    pill: { w: 160, h: 56 },
    ellipse: { w: 140, h: 80 },
    diamond: { w: 140, h: 100 },
    cylinder: { w: 120, h: 96 },
    queue: { w: 160, h: 64 },
    sticky: { w: 200, h: 140 },
    text: { w: 200, h: 40 },
    zone: { w: 320, h: 200 },
};

/** The shape a kind gives a box that names no shape of its own (spec §9). */
export const KIND_SHAPES: Readonly<Record<CanvasKind, CanvasShape>> = {
    client: 'rounded',
    user: 'pill',
    mobile: 'rounded',
    service: 'rect',
    worker: 'rect',
    function: 'rounded',
    database: 'cylinder',
    cache: 'cylinder',
    queue: 'queue',
    stream: 'queue',
    storage: 'cylinder',
    search: 'rect',
    cdn: 'rounded',
    dns: 'rounded',
    gateway: 'rect',
    lb: 'rect',
    auth: 'rect',
    external: 'rect',
    monitor: 'rect',
    scheduler: 'rounded',
    notify: 'rounded',
    model: 'rect',
};

export const CANVAS_LIMITS = { nodes: 300, edges: 600, text: 1000, label: 200, id: 40 } as const;

/** The inline frame height (px) of a canvas block: the node's `height` attr. */
export const CANVAS_DEFAULT_HEIGHT = 440;
const HEIGHT_MIN = 240;
const HEIGHT_MAX = 1400;
const COORD_MAX = 1_000_000;
const SIZE_MIN = 16;
const SIZE_MAX = 4000;

const RECORD_ID = /^[A-Za-z0-9_-]+$/;
const CANVAS_ID = /^cv_[A-Za-z0-9_-]{12}$/;
/** A route longer than this is not a layout engine's (it is dropped, and the browser draws `path`). */
const ROUTE_POINTS_MAX = 400;

const emptyBoard = (): Board => ({ nodes: [], edges: [] });

export function isEmptyBoard(board: Board | null | undefined): boolean {
    return !board || (board.nodes.length === 0 && board.edges.length === 0);
}

/** `cv_` + 12 url-safe characters. */
export function newCanvasId(): string {
    return `cv_${crypto.randomBytes(9).toString('base64url')}`;
}

export function isCanvasId(value: unknown): value is string {
    return typeof value === 'string' && CANVAS_ID.test(value);
}

/** The frame height readers use: an integer 240–1400, 440 when unset. */
export function canvasHeight(value: unknown): number {
    const n = toNumber(value);
    return n === null ? CANVAS_DEFAULT_HEIGHT : Math.min(Math.max(Math.round(n), HEIGHT_MIN), HEIGHT_MAX);
}

// ─── Small coercions ───────────────────────────────────────────────────

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A finite number (numeric strings too), else null. */
function toNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);
const coord = (n: number): number => clamp(Math.round(n), -COORD_MAX, COORD_MAX);
const size = (n: number): number => clamp(Math.round(n), SIZE_MIN, SIZE_MAX);

/** Lower case, letters and digits only ("Post-it" → "postit"). */
const aliasKey = (value: unknown): string => (typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '');

const SHAPE_ALIASES: Readonly<Record<string, CanvasShape>> = {
    rect: 'rect',
    box: 'rect',
    rectangle: 'rect',
    rounded: 'rounded',
    roundedrect: 'rounded',
    roundrect: 'rounded',
    queue: 'queue',
    pipe: 'queue',
    hcyl: 'queue',
    horizontalcylinder: 'queue',
    zone: 'zone',
    group: 'zone',
    frame: 'zone',
    subgraph: 'zone',
    pill: 'pill',
    stadium: 'pill',
    terminal: 'pill',
    round: 'pill',
    ellipse: 'ellipse',
    circle: 'ellipse',
    oval: 'ellipse',
    diamond: 'diamond',
    decision: 'diamond',
    rhombus: 'diamond',
    cylinder: 'cylinder',
    database: 'cylinder',
    db: 'cylinder',
    store: 'cylinder',
    sticky: 'sticky',
    note: 'sticky',
    postit: 'sticky',
    stickynote: 'sticky',
    text: 'text',
    label: 'text',
    title: 'text',
};

const COLOR_ALIASES: Readonly<Record<string, CanvasColor>> = {
    default: 'default',
    gray: 'gray',
    grey: 'gray',
    blue: 'blue',
    green: 'green',
    yellow: 'yellow',
    orange: 'yellow',
    amber: 'yellow',
    red: 'red',
    purple: 'default',
    pink: 'default',
    brown: 'default',
};

const SIZE_ALIASES: Readonly<Record<string, CanvasTextSize>> = { s: 's', small: 's', m: 'm', medium: 'm', l: 'l', large: 'l' };

const PATH_ALIASES: Readonly<Record<string, EdgeRecord['path']>> = {
    straight: 'straight',
    curved: 'curved',
    curve: 'curved',
    bezier: 'curved',
    elbow: 'elbow',
    step: 'elbow',
    orthogonal: 'elbow',
    smoothstep: 'elbow',
};

/** Kind names and their aliases (input only), keyed as aliasKey writes them. */
const KIND_ALIASES: Readonly<Record<string, CanvasKind>> = {
    ...Object.fromEntries(CANVAS_KINDS.map((kind) => [kind, kind])),
    browser: 'client',
    web: 'client',
    frontend: 'client',
    phone: 'mobile',
    app: 'mobile',
    server: 'service',
    backend: 'service',
    api: 'service',
    microservice: 'service',
    job: 'worker',
    consumer: 'worker',
    lambda: 'function',
    serverless: 'function',
    db: 'database',
    mq: 'queue',
    broker: 'queue',
    topic: 'stream',
    log: 'stream',
    eventbus: 'stream',
    kafkalike: 'stream',
    blob: 'storage',
    bucket: 'storage',
    s3: 'storage',
    index: 'search',
    proxy: 'gateway',
    apigateway: 'gateway',
    loadbalancer: 'lb',
    balancer: 'lb',
    iam: 'auth',
    identity: 'auth',
    login: 'auth',
    thirdparty: 'external',
    saas: 'external',
    metrics: 'monitor',
    monitoring: 'monitor',
    observability: 'monitor',
    cron: 'scheduler',
    timer: 'scheduler',
    email: 'notify',
    push: 'notify',
    notification: 'notify',
    llm: 'model',
    ml: 'model',
    ai: 'model',
};

const shapeOf = (value: unknown): CanvasShape => SHAPE_ALIASES[aliasKey(value)] ?? 'rect';
/** A shape name or alias, or null when it is none (the text form says so instead of guessing). */
export const knownShape = (value: unknown): CanvasShape | null => SHAPE_ALIASES[aliasKey(value)] ?? null;
const colorOf = (value: unknown): CanvasColor => COLOR_ALIASES[aliasKey(value)] ?? 'default';
/** A colour name or alias (grey, orange, …), or null when it is none. */
export const knownColor = (value: unknown): CanvasColor | null => COLOR_ALIASES[aliasKey(value)] ?? null;
/** A kind or its alias, or null (stored records: an unknown kind is simply no kind). */
export const kindOf = (value: unknown): CanvasKind | null => KIND_ALIASES[aliasKey(value)] ?? null;
/** s / m / l (small, medium, large too), else undefined. */
export const textSizeOf = (value: unknown): CanvasTextSize | undefined => SIZE_ALIASES[aliasKey(value)];

/** The 400 for a kind that is none, listing the kinds (agents fix it in one round). */
export function unknownKindMessage(value: unknown): string {
    return `${JSON.stringify(String(value))} is not a kind. Kinds: ${CANVAS_KINDS.join(', ')}`;
}
const lineOf = (value: unknown): EdgeRecord['line'] => (['dashed', 'dotted'].includes(aliasKey(value)) ? 'dashed' : 'solid');
const arrowOf = (value: unknown): EdgeRecord['arrow'] => {
    const key = aliasKey(value);
    return key === 'none' || key === 'both' ? key : 'end';
};
const pathOf = (value: unknown): EdgeRecord['path'] => PATH_ALIASES[aliasKey(value)] ?? 'straight';

/** Text as written: line breaks kept (CRLF → LF), trimmed. Numbers and booleans become text. */
function textOf(value: unknown): string | null {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
}

/** An id as written: trimmed text (numbers become text); '' when absent; null when not text at all. */
function idText(value: unknown): string | null {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

const bad = (message: string): ErrorResponse => new ErrorResponse(400, message);

/** "a", "b", … (at most `max`). */
function idList(ids: readonly string[], max = 12): string {
    const shown = ids.slice(0, max).map((id) => JSON.stringify(id));
    return `${shown.join(', ')}${ids.length > max ? ', …' : ''}`;
}

/** e2 before e10 (ids are compared as text with their numbers as numbers). */
export function naturalCompare(a: string, b: string): number {
    const pa = a.match(/\d+|\D+/g) ?? [];
    const pb = b.match(/\d+|\D+/g) ?? [];
    for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
        const x = pa[i]!;
        const y = pb[i]!;
        if (x === y) continue;
        const nx = /^\d/.test(x) ? Number(x) : NaN;
        const ny = /^\d/.test(y) ? Number(y) : NaN;
        if (!Number.isNaN(nx) && !Number.isNaN(ny) && nx !== ny) return nx - ny;
        return x < y ? -1 : 1;
    }
    return pa.length - pb.length || (a < b ? -1 : a > b ? 1 : 0);
}

// ─── normalizeBoard: agent and Markdown input ─────────────────────────

interface DraftNode {
    id: string;
    shape: CanvasShape;
    text: string;
    x: number | null;
    y: number | null;
    w: number;
    h: number;
    color: CanvasColor;
    z: number;
    size: CanvasTextSize | undefined;
    kind: CanvasKind | undefined;
    parent: string | undefined;
}

/** A finite [x, y] pair (also {x, y}), rounded and clamped, or null. */
function pointOf(value: unknown): [number, number] | null {
    const pair = Array.isArray(value) ? value : isObj(value) ? [value['x'], value['y']] : null;
    if (!pair || pair.length !== 2) return null;
    const x = toNumber(pair[0]);
    const y = toNumber(pair[1]);
    return x === null || y === null ? null : [coord(x), coord(y)];
}

/** A stored or given route, or undefined when it is not a usable one (a route is only a drawing hint). */
function routeOf(value: unknown): EdgeRoute | undefined {
    if (!isObj(value) || !Array.isArray(value['points'])) return undefined;
    const raw = value['points'];
    if (raw.length < 2 || raw.length > ROUTE_POINTS_MAX) return undefined;
    const points: Array<[number, number]> = [];
    for (const item of raw) {
        const point = pointOf(item);
        if (!point) return undefined;
        points.push(point);
    }
    const label = value['label'] === undefined ? null : pointOf(value['label']);
    return label ? { points, label } : { points };
}

const cloneRoute = (route: EdgeRoute): EdgeRoute => {
    const points = route.points.map(([x, y]): [number, number] => [x, y]);
    return route.label ? { points, label: [route.label[0], route.label[1]] } : { points };
};

/** Every zone before the nodes inside it, otherwise in the given order (parents must not loop). */
export function zonesFirst<T extends { id: string; parent?: string | undefined }>(nodes: readonly T[]): T[] {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out: T[] = [];
    const placed = new Set<string>();
    const place = (node: T): void => {
        if (placed.has(node.id)) return;
        placed.add(node.id);
        const parent = node.parent ? byId.get(node.parent) : undefined;
        if (parent) place(parent);
        out.push(node);
    };
    nodes.forEach(place);
    return out;
}

/**
 * The parent zone each node keeps: a parent that is not a zone of this board is dropped, and so
 * is the link that would close a loop of zones (the node becomes top level, keeping its numbers).
 */
function validParents(nodes: ReadonlyArray<{ id: string; shape: CanvasShape; parent?: string | undefined }>): Map<string, string> {
    const zones = new Set(nodes.filter((n) => n.shape === 'zone').map((n) => n.id));
    const parents = new Map<string, string>();
    for (const n of nodes) if (n.parent && n.parent !== n.id && zones.has(n.parent)) parents.set(n.id, n.parent);
    for (const n of nodes) {
        const seen = new Set([n.id]);
        for (let at = parents.get(n.id); at !== undefined; at = parents.get(at)) {
            if (at === n.id) {
                parents.delete(n.id); // n is on a loop: its own link goes
                break;
            }
            if (seen.has(at)) break; // a loop further up: cut when its own node comes round
            seen.add(at);
        }
    }
    return parents;
}

/** The layout asked for, or null when none was (normalizeBoard then picks the one that fits a doc). */
function layoutOf(value: unknown): CanvasLayout | null {
    if (value === undefined || value === null || value === '') return null;
    const key = aliasKey(value);
    if (['lr', 'leftright', 'lefttoright', 'horizontal'].includes(key)) return 'LR';
    if (['tb', 'td', 'topbottom', 'toptobottom', 'topdown', 'vertical'].includes(key)) return 'TB';
    throw bad('layout must be "LR" (left to right) or "TB" (top to bottom)');
}

/**
 * Agent or Markdown input → a Board (spec §3, v2 fields §9): ids checked or made (n1, n2, … / e1,
 * e2, …), shape, colour, kind, line, arrow and path aliases, numbers rounded and clamped, edges
 * and parents checked against the nodes, routes kept when usable, and boxes without a position
 * laid out. A 400 ErrorResponse, worded so an agent can fix its input, for anything it can't fix.
 * `input.layout` ('LR' or 'TB') steers the layout; without it, the direction that shows the board
 * biggest in a doc's 720 px column wins (LR on a tie). The old layout knows no zones, so a board
 * with zones must place every node itself (the text form lays zones out).
 */
export function normalizeBoard(input: unknown): Board {
    if (!isObj(input)) throw bad('The canvas must be a JSON object: {"nodes": [...], "edges": [...]}');
    const rawNodes = input['nodes'];
    if (!Array.isArray(rawNodes)) throw bad('The canvas needs a "nodes" array (its boxes)');
    if (rawNodes.length > CANVAS_LIMITS.nodes) throw bad(`A canvas holds at most ${CANVAS_LIMITS.nodes} nodes; this one has ${rawNodes.length}`);
    const rawEdges = input['edges'] ?? [];
    if (!Array.isArray(rawEdges)) throw bad('"edges" must be an array (the arrows)');
    if (rawEdges.length > CANVAS_LIMITS.edges) throw bad(`A canvas holds at most ${CANVAS_LIMITS.edges} edges; this one has ${rawEdges.length}`);
    const layout = layoutOf(input['layout']);

    // Nodes: explicit ids first (so made-up ones never take a name used later in the list).
    const given: Array<string | null> = rawNodes.map((raw, i) => {
        const label = `Node ${i + 1}`;
        if (!isObj(raw)) throw bad(`${label} must be an object like {"id": "api", "text": "API"}`);
        const id = idText(raw['id']);
        if (id === null) throw bad(`${label} has an id that is not text`);
        if (!id) return null;
        if (id.length > CANVAS_LIMITS.id || !RECORD_ID.test(id)) {
            throw bad(`${label} has the id ${JSON.stringify(id)}: ids use only letters, digits, - and _ (at most ${CANVAS_LIMITS.id})`);
        }
        return id;
    });
    const firstIndex = new Map<string, number>();
    given.forEach((id, i) => {
        if (id === null) return;
        const earlier = firstIndex.get(id);
        if (earlier !== undefined) throw bad(`Two nodes have the id ${JSON.stringify(id)} (nodes ${earlier + 1} and ${i + 1}): every node needs its own id`);
        firstIndex.set(id, i);
    });
    let counter = 0;
    const nextFree = (prefix: string, taken: { has(id: string): boolean }): string => {
        let id: string;
        do {
            counter += 1;
            id = `${prefix}${counter}`;
        } while (taken.has(id));
        return id;
    };

    const drafts: DraftNode[] = rawNodes.map((value, i) => {
        const raw = value as Obj;
        const label = `Node ${i + 1}`;
        const text = textOf(raw['text'] ?? raw['label']);
        if (text === null) throw bad(`${label} text must be a string`);
        if (text.length > CANVAS_LIMITS.text) throw bad(`${label} text is ${text.length} characters; the most is ${CANVAS_LIMITS.text}`);
        const rawKind = raw['kind'];
        const kind = rawKind === undefined || rawKind === null || rawKind === '' ? undefined : kindOf(rawKind);
        if (kind === null) throw bad(`${label}: ${unknownKindMessage(rawKind)}`);
        // A kind gives a box its shape when it names none.
        const rawShape = raw['shape'];
        const shape = (rawShape === undefined || rawShape === null || rawShape === '') && kind ? KIND_SHAPES[kind] : shapeOf(rawShape);
        const parent = idText(raw['parent']);
        if (parent === null) throw bad(`${label} has a parent that is not text`);
        const x = toNumber(raw['x']);
        const y = toNumber(raw['y']);
        const w = toNumber(raw['w'] ?? raw['width']);
        const h = toNumber(raw['h'] ?? raw['height']);
        const z = toNumber(raw['z']);
        return {
            id: given[i] ?? '',
            shape,
            text,
            x: x === null ? null : coord(x),
            y: y === null ? null : coord(y),
            w: w === null ? SHAPE_SIZES[shape].w : size(w),
            h: h === null ? SHAPE_SIZES[shape].h : size(h),
            color: colorOf(raw['color'] ?? raw['colour']),
            z: z ?? i,
            size: textSizeOf(raw['size']),
            kind,
            parent: parent || undefined,
        };
    });
    for (const draft of drafts) if (!draft.id) draft.id = nextFree('n', firstIndex);
    const nodeIds = new Set(drafts.map((d) => d.id));
    checkParents(drafts);

    // Edges.
    const edgeIds = new Set<string>();
    const pending: Array<{ edge: EdgeRecord; wanted: string | null }> = rawEdges.map((raw, i) => {
        const label = `Edge ${i + 1}`;
        if (!isObj(raw)) throw bad(`${label} must be an object like {"from": "api", "to": "db"}`);
        const from = idText(raw['from'] ?? raw['source']);
        const to = idText(raw['to'] ?? raw['target']);
        if (!from || !to) throw bad(`${label} needs "from" and "to" (the ids of the nodes it joins)`);
        for (const end of [from, to]) {
            if (!nodeIds.has(end)) throw bad(`${label} points at ${JSON.stringify(end)}, which is not a node. Node ids: ${idList([...nodeIds])}.`);
        }
        const text = textOf(raw['label'] ?? raw['text']);
        if (text === null) throw bad(`${label} label must be a string`);
        if (text.length > CANVAS_LIMITS.label) throw bad(`${label} label is ${text.length} characters; the most is ${CANVAS_LIMITS.label}`);
        const id = idText(raw['id']);
        const valid = id && id.length <= CANVAS_LIMITS.id && RECORD_ID.test(id) && !edgeIds.has(id) ? id : null;
        if (valid) edgeIds.add(valid);
        const edge: EdgeRecord = { id: valid ?? '', from, to, label: text, line: lineOf(raw['line']), arrow: arrowOf(raw['arrow']), path: pathOf(raw['path']) };
        const route = routeOf(raw['route']);
        if (route) edge.route = route;
        return { wanted: valid, edge };
    });
    counter = 0;
    const edges = pending.map(({ edge, wanted }) => (wanted ? edge : { ...edge, id: nextFree('e', edgeIds) }));

    const unplaced = drafts.some((d) => d.x === null || d.y === null);
    if (unplaced && drafts.some((d) => d.shape === 'zone' || d.parent)) {
        throw bad(
            'A canvas with zones in the JSON form needs x and y on every node (a node in a zone is placed relative to the zone). ' +
                'Or write the text form (flowchart … subgraph … end), which lays zones out for you.'
        );
    }
    layOut(drafts, edges, layout ?? bestLayout(drafts, edges));

    const sorted = drafts.map((d, i) => ({ d, i })).sort((a, b) => a.d.z - b.d.z || a.i - b.i);
    const nodes = zonesFirst(sorted.map(({ d }) => d)).map((d, z): NodeRecord => {
        const node: NodeRecord = { id: d.id, shape: d.shape, text: d.text, x: d.x ?? 0, y: d.y ?? 0, w: d.w, h: d.h, color: d.color, z };
        if (d.size) node.size = d.size;
        if (d.kind) node.kind = d.kind;
        if (d.parent) node.parent = d.parent;
        return node;
    });
    return { nodes, edges };
}

/** Parents of agent input: each must name a zone of the board, and zones must not hold each other. */
function checkParents(drafts: readonly DraftNode[]): void {
    const byId = new Map(drafts.map((d) => [d.id, d]));
    const zones = drafts.filter((n) => n.shape === 'zone').map((n) => n.id);
    const list = zones.length > 0 ? ` Zones: ${idList(zones)}.` : ' The board has no zones (shape "zone").';
    drafts.forEach((d, i) => {
        if (!d.parent) return;
        const parent = byId.get(d.parent);
        if (!parent) throw bad(`Node ${i + 1} has the parent ${JSON.stringify(d.parent)}, which is not a node.${list}`);
        if (parent.shape !== 'zone') throw bad(`Node ${i + 1} has the parent ${JSON.stringify(d.parent)}, which is not a zone (shape "zone").${list}`);
        const seen = new Set([d.id]);
        for (let at: DraftNode | undefined = parent; at; at = at.parent ? byId.get(at.parent) : undefined) {
            if (seen.has(at.id)) throw bad(`Zone ${JSON.stringify(at.id)} ends up inside itself: zones can nest, but not in a loop`);
            seen.add(at.id);
        }
    });
}

// ─── Auto-layout ───────────────────────────────────────────────────────

/**
 * Spacing between ranks (along the layout direction) and between neighbours in a rank. The spec's
 * numbers (LR: ranks 240 apart, rows 120; TB: ranks 160 apart, columns 220) fit the default box;
 * bigger boxes get at least these gaps so they never overlap.
 */
const SPACING = {
    LR: { rank: 240, rankGap: 80, cross: 120, crossGap: 40 },
    TB: { rank: 160, rankGap: 64, cross: 220, crossGap: 40 },
} as const;
/** Laid-out nodes go this far below the nodes that already have a position. */
const BELOW_GAP = 120;

/** A doc's column (px) and the browser's fit padding: what an inline board is sized for. */
export const DOC_COLUMN = 720;
export const FIT_PADDING = 0.12;
export const FITTED_HEIGHT = { min: 280, max: 880, chrome: 48 } as const;

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * Every node's box in board coordinates: a node in a zone is placed relative to the zone, so its
 * zones' positions add up (parents that are not zones of the board are ignored, as readers do).
 */
export function absoluteBoxes(nodes: readonly NodeRecord[]): Map<string, Rect> {
    const parents = validParents(nodes);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const boxes = new Map<string, Rect>();
    const boxOf = (node: NodeRecord): Rect => {
        const known = boxes.get(node.id);
        if (known) return known;
        const parentId = parents.get(node.id);
        const parent = parentId ? byId.get(parentId) : undefined;
        const origin = parent ? boxOf(parent) : { x: 0, y: 0 };
        const box = { x: origin.x + node.x, y: origin.y + node.y, w: node.w, h: node.h };
        boxes.set(node.id, box);
        return box;
    };
    nodes.forEach(boxOf);
    return boxes;
}

/** The box around every node of a board, in board coordinates (0×0 at the origin when it has none). */
export function boardBounds(nodes: readonly NodeRecord[]): Rect {
    const boxes = [...absoluteBoxes(nodes).values()];
    if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    const x1 = Math.min(...boxes.map((b) => b.x));
    const y1 = Math.min(...boxes.map((b) => b.y));
    const x2 = Math.max(...boxes.map((b) => b.x + b.w));
    const y2 = Math.max(...boxes.map((b) => b.y + b.h));
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * The zoom a board of this size shows at in a doc: the browser fits it into the 720 px column and
 * the frame (`frameHeight` minus its bars), with 12% padding, never above 1.
 */
export function docZoom(width: number, height: number, frameHeight: number): number {
    const across = width > 0 ? DOC_COLUMN / (width * (1 + FIT_PADDING)) : 1;
    const down = height > 0 ? (frameHeight - FITTED_HEIGHT.chrome) / (height * (1 + FIT_PADDING)) : 1;
    return Math.max(0, Math.min(1, across, down));
}

function bounds(nodes: ReadonlyArray<{ x: number | null; y: number | null; w: number; h: number }>) {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const n of nodes) {
        x1 = Math.min(x1, n.x ?? 0);
        y1 = Math.min(y1, n.y ?? 0);
        x2 = Math.max(x2, (n.x ?? 0) + n.w);
        y2 = Math.max(y2, (n.y ?? 0) + n.h);
    }
    return nodes.length > 0 ? { w: x2 - x1, h: y2 - y1 } : { w: 0, h: 0 };
}

/** The zoom the browser fits a board of this width at, in a doc's column (never above 1). */
const columnZoom = (width: number): number => (width > 0 ? Math.min(1, DOC_COLUMN / (width * (1 + FIT_PADDING))) : 1);

/** LR or TB, whichever shows the board bigger in a doc's column (a long chain reads better top to bottom). */
function bestLayout(drafts: readonly DraftNode[], edges: readonly EdgeRecord[]): CanvasLayout {
    if (!drafts.some((d) => d.x === null || d.y === null)) return 'LR';
    const zoomFor = (direction: CanvasLayout) => {
        const trial = drafts.map((d) => ({ ...d }));
        layOut(trial, edges, direction);
        return columnZoom(bounds(trial).w);
    };
    return zoomFor('TB') > zoomFor('LR') + 0.05 ? 'TB' : 'LR';
}

/**
 * The block height that shows a whole board at the zoom the browser will fit it at (a fence
 * without "height"): its laid-out height plus room for the board's bars, 280–880, on the 8 px grid.
 */
export function fittedCanvasHeight(board: Board): number {
    if (board.nodes.length === 0) return CANVAS_DEFAULT_HEIGHT;
    const box = boardBounds(board.nodes);
    const px = box.h * (1 + FIT_PADDING) * columnZoom(box.w) + FITTED_HEIGHT.chrome;
    return clamp(Math.round(px / 8) * 8, FITTED_HEIGHT.min, FITTED_HEIGHT.max);
}

/**
 * Gives every node without x or y a position: layered by the edges between such nodes (rank =
 * longest path, cycles broken where a depth-first walk meets them), rank 0 in input order, later
 * ranks ordered by where their predecessors sit, each rank centred and only as deep as its own
 * biggest box. Boxes no arrow touches (notes beside a flow) sit next to it, not in its first rank.
 */
function layOut(nodes: DraftNode[], edges: readonly EdgeRecord[], direction: CanvasLayout): void {
    const unplaced = nodes.filter((n) => n.x === null || n.y === null);
    if (unplaced.length === 0) return;
    const touched = new Set(edges.flatMap((e) => [e.from, e.to]));
    const connected = unplaced.filter((n) => touched.has(n.id));
    // With no arrows at all, everything is one rank (a row or a column), as before.
    const free = connected.length > 0 ? connected : unplaced;
    const loose = connected.length > 0 ? unplaced.filter((n) => !touched.has(n.id)) : [];
    const index = new Map(free.map((n, i) => [n.id, i]));
    const out: number[][] = free.map(() => []);
    for (const edge of edges) {
        const a = index.get(edge.from);
        const b = index.get(edge.to);
        if (a !== undefined && b !== undefined && a !== b) out[a]!.push(b);
    }

    // Depth-first, in input order: an edge back to a node still open closes a cycle and is dropped.
    const state = new Uint8Array(free.length); // 0 new, 1 open, 2 done
    const dag: number[][] = free.map(() => []);
    const finished: number[] = [];
    for (let root = 0; root < free.length; root += 1) {
        if (state[root] !== 0) continue;
        state[root] = 1;
        const stack: Array<[number, number]> = [[root, 0]];
        while (stack.length > 0) {
            const top = stack[stack.length - 1]!;
            const [v, next] = top;
            const targets = out[v]!;
            if (next < targets.length) {
                top[1] = next + 1;
                const w = targets[next]!;
                if (state[w] === 1) continue;
                dag[v]!.push(w);
                if (state[w] === 0) {
                    state[w] = 1;
                    stack.push([w, 0]);
                }
            } else {
                state[v] = 2;
                finished.push(v);
                stack.pop();
            }
        }
    }

    // Longest path, in reverse finishing order (a topological order of what is left).
    const rank = new Array<number>(free.length).fill(0);
    for (let k = finished.length - 1; k >= 0; k -= 1) {
        const v = finished[k]!;
        for (const w of dag[v]!) rank[w] = Math.max(rank[w]!, rank[v]! + 1);
    }
    const preds: number[][] = free.map(() => []);
    dag.forEach((targets, v) => targets.forEach((w) => preds[w]!.push(v)));

    const layers: number[][] = [];
    free.forEach((_n, v) => (layers[rank[v]!] ??= []).push(v));
    const slot = new Array<number>(free.length).fill(0);
    for (const [r, layer] of layers.entries()) {
        if (!layer) continue;
        if (r > 0) {
            const bary = new Map(layer.map((v) => [v, preds[v]!.reduce((sum, u) => sum + slot[u]!, 0) / Math.max(preds[v]!.length, 1)]));
            layer.sort((a, b) => bary.get(a)! - bary.get(b)! || a - b);
        }
        layer.forEach((v, i) => {
            slot[v] = i - (layer.length - 1) / 2;
        });
    }

    const spacing = SPACING[direction];
    const lr = direction === 'LR';
    const along = (n: DraftNode) => (lr ? n.w : n.h);
    // Each rank is as deep as its biggest box; the gap between ranks is the spec's (240 − 160 LR,
    // 160 − 64 TB), so default boxes keep the spec's exact pitch.
    const rankGap = lr ? spacing.rank - SHAPE_SIZES.rect.w : spacing.rank - SHAPE_SIZES.rect.h;
    const depth = Array.from({ length: layers.length }, (_, r) => Math.max(0, ...(layers[r] ?? []).map((v) => along(free[v]!))));
    const start: number[] = [];
    let at = 0;
    for (const [r, d] of depth.entries()) {
        start[r] = at;
        at += d + rankGap;
    }
    const widest = Math.max(...free.map((n) => n.w));
    const tallest = Math.max(...free.map((n) => n.h));
    const crossPitch = Math.max(spacing.cross, (lr ? tallest : widest) + spacing.crossGap);
    const placed = free.map((n, v) => {
        const centre = start[rank[v]!]! + depth[rank[v]!]! / 2;
        const across = slot[v]! * crossPitch;
        return { x: (lr ? centre : across) - n.w / 2, y: (lr ? across : centre) - n.h / 2 };
    });
    const minX = Math.min(...placed.map((p) => p.x));
    const minY = Math.min(...placed.map((p) => p.y));
    placed.forEach((p) => {
        p.x -= minX;
        p.y -= minY;
    });

    // Loose boxes: beside the flow (right of a top-to-bottom one, under a left-to-right one).
    const right = Math.max(...placed.map((p, v) => p.x + free[v]!.w));
    const bottom = Math.max(...placed.map((p, v) => p.y + free[v]!.h));
    let offset = 0;
    const loosePlaced = loose.map((n) => {
        const p = lr ? { x: offset, y: bottom + LOOSE_GAP } : { x: right + LOOSE_GAP, y: offset };
        offset += (lr ? n.w : n.h) + spacing.crossGap;
        return p;
    });

    const fixed = nodes.filter((n) => n.x !== null && n.y !== null);
    const originX = fixed.length > 0 ? Math.min(...fixed.map((n) => n.x!)) : 0;
    const originY = fixed.length > 0 ? Math.max(...fixed.map((n) => n.y! + n.h)) + BELOW_GAP : 0;
    [...free, ...loose].forEach((n, i) => {
        const p = i < free.length ? placed[i]! : loosePlaced[i - free.length]!;
        n.x = coord(p.x + originX);
        n.y = coord(p.y + originY);
    });
}

/** How far boxes no arrow touches sit from the laid-out flow. */
const LOOSE_GAP = 64;

// ─── Lenient reading (records from the Y maps, data on JSON) ──────────
// Never throws and drops nothing a person drew: whatever a browser stored is shown.

/** A stored node record as a NodeRecord, or null when it is not one. The map key is its id. */
function coerceNode(value: unknown, key?: string): NodeRecord | null {
    if (!isObj(value)) return null;
    const id = typeof key === 'string' && key ? key : idText(value['id']);
    if (!id) return null;
    const shape = shapeOf(value['shape']);
    const text = textOf(value['text']);
    const num = (v: unknown, fallback: number) => toNumber(v) ?? fallback;
    const node: NodeRecord = {
        id,
        shape,
        text: text ?? '',
        x: coord(num(value['x'], 0)),
        y: coord(num(value['y'], 0)),
        w: size(num(value['w'], SHAPE_SIZES[shape].w)),
        h: size(num(value['h'], SHAPE_SIZES[shape].h)),
        color: colorOf(value['color']),
        z: num(value['z'], 0),
    };
    const textSize = textSizeOf(value['size']);
    if (textSize) node.size = textSize;
    const kind = kindOf(value['kind']);
    if (kind) node.kind = kind;
    const parent = idText(value['parent']);
    if (parent) node.parent = parent;
    return node;
}

function coerceEdge(value: unknown, key?: string): EdgeRecord | null {
    if (!isObj(value)) return null;
    const id = typeof key === 'string' && key ? key : idText(value['id']);
    const from = idText(value['from']);
    const to = idText(value['to']);
    if (!id || !from || !to) return null;
    const edge: EdgeRecord = { id, from, to, label: textOf(value['label']) ?? '', line: lineOf(value['line']), arrow: arrowOf(value['arrow']), path: pathOf(value['path']) };
    const route = routeOf(value['route']);
    if (route) edge.route = route;
    return edge;
}

/**
 * Records → a Board: one node per id, nodes in z order with every zone before what it holds, a
 * parent that is not a zone of the board dropped (that node becomes top level, keeping its
 * numbers), and only edges whose two ends are nodes (a box deleted while someone drew an arrow to
 * it leaves a dangling edge, which would not parse back). `byId`: map entries, whose order is not
 * meaningful, so ties and edges are sorted by id.
 */
function boardFrom(nodeEntries: Array<[string | undefined, unknown]>, edgeEntries: Array<[string | undefined, unknown]>, byId: boolean): Board {
    const read: NodeRecord[] = [];
    const ids = new Set<string>();
    for (const [key, value] of nodeEntries) {
        const node = coerceNode(value, key);
        if (node && !ids.has(node.id)) {
            ids.add(node.id);
            read.push(node);
        }
    }
    const parents = validParents(read);
    for (const node of read) {
        const parent = parents.get(node.id);
        if (parent) node.parent = parent;
        else delete node.parent;
    }
    const order = new Map(read.map((n, i) => [n.id, i]));
    read.sort((a, b) => a.z - b.z || (byId ? naturalCompare(a.id, b.id) : order.get(a.id)! - order.get(b.id)!));
    const nodes = zonesFirst(read);
    const edges: EdgeRecord[] = [];
    const edgeIds = new Set<string>();
    for (const [key, value] of edgeEntries) {
        const edge = coerceEdge(value, key);
        if (edge && !edgeIds.has(edge.id) && ids.has(edge.from) && ids.has(edge.to)) {
            edgeIds.add(edge.id);
            edges.push(edge);
        }
    }
    if (byId) edges.sort((a, b) => naturalCompare(a.id, b.id));
    return { nodes, edges };
}

/** Any `data` value (a Board, or JSON text of one) read leniently; an empty board when it is none. */
export function coerceBoard(value: unknown): Board {
    let data = value;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            return emptyBoard();
        }
    }
    if (!isObj(data)) return emptyBoard();
    const list = (v: unknown): Array<[undefined, unknown]> => (Array.isArray(v) ? v.map((item) => [undefined, item]) : []);
    return boardFrom(list(data['nodes']), list(data['edges']), false);
}

/** The words on a board (node texts, then edge labels), for search and snippets. */
export function canvasTexts(data: unknown): string[] {
    const board = coerceBoard(data);
    return [...board.nodes.map((n) => n.text), ...board.edges.map((e) => e.label)].filter((t) => t.trim());
}

// ─── The ```canvas fence ───────────────────────────────────────────────

export const CANVAS_FENCE_LANGUAGE = 'canvas';

/** A fence's info string names a canvas: its first word is `canvas` (any case). */
export function isCanvasFenceLanguage(lang: unknown): boolean {
    return typeof lang === 'string' && lang.trim().split(/\s+/)[0]?.toLowerCase() === CANVAS_FENCE_LANGUAGE;
}

const int = (n: number): number => Math.round(n);

/** One node on one line; fields equal to their default are left out (positions and sizes never). */
function printNode(n: NodeRecord): string {
    const fields: Obj = { id: n.id };
    if (n.shape !== 'rect') fields['shape'] = n.shape;
    if (n.text) fields['text'] = n.text;
    if (n.color !== 'default') fields['color'] = n.color;
    if (n.kind) fields['kind'] = n.kind;
    if (n.parent) fields['parent'] = n.parent;
    Object.assign(fields, { x: int(n.x), y: int(n.y), w: int(n.w), h: int(n.h) });
    if (n.size) fields['size'] = n.size;
    return JSON.stringify(fields);
}

function printEdge(e: EdgeRecord): string {
    const fields: Obj = { id: e.id, from: e.from, to: e.to };
    if (e.label) fields['label'] = e.label;
    if (e.line !== 'solid') fields['line'] = e.line;
    if (e.arrow !== 'end') fields['arrow'] = e.arrow;
    if (e.path !== 'straight') fields['path'] = e.path;
    if (e.route) fields['route'] = e.route;
    return JSON.stringify(fields);
}

function printList(name: string, items: readonly string[]): string {
    if (items.length === 0) return `  "${name}": []`;
    return `  "${name}": [\n${items.map((item) => `    ${item}`).join(',\n')}\n  ]`;
}

/**
 * The v1 JSON form of a canvas node's fence: the id, "height" when it isn't 440, one node or edge
 * per line. Without data it prints an empty board that keeps the id. Docs print the text form now
 * (./diagram/print.ts); this one stays for tests and for anything that wants every number.
 */
export function printCanvasJsonFence(attrs: { canvasId?: unknown; height?: unknown; data?: unknown } | null | undefined): string {
    const board = coerceBoard(attrs?.data);
    const fields: string[] = [];
    if (typeof attrs?.canvasId === 'string' && attrs.canvasId) fields.push(`  "id": ${JSON.stringify(attrs.canvasId)}`);
    const height = canvasHeight(attrs?.height);
    if (height !== CANVAS_DEFAULT_HEIGHT) fields.push(`  "height": ${height}`);
    fields.push(printList('nodes', board.nodes.map(printNode)), printList('edges', board.edges.map(printEdge)));
    return ['```canvas', '{', fields.join(',\n'), '}', '```'].join('\n');
}

/** A fence body in the v1 JSON form (it starts with `{`; an empty fence counts too). */
export function isJsonCanvasText(text: string): boolean {
    const start = text.trimStart();
    return start === '' || start.startsWith('{');
}

/**
 * A ```canvas fence's text → the block's height and board. The fence's `id` is ignored: a parsed
 * canvas always gets a fresh id when it is absorbed. Bad JSON or a board normalizeBoard rejects → 400.
 */
export function parseCanvasFence(text: string): { height: number; board: Board } {
    if (!text.trim()) return { height: CANVAS_DEFAULT_HEIGHT, board: emptyBoard() };
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (err) {
        throw bad(`The canvas block is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const board = normalizeBoard(value);
    const asked = (value as Obj)['height'];
    return { height: asked === undefined || asked === null ? fittedCanvasHeight(board) : canvasHeight(asked), board };
}

// ─── Where boards live: the Y.Doc's root maps ─────────────────────────

const ROOT_PREFIX = 'canvas:';
const ROOT_NAME = /^canvas:(.+):(nodes|edges)$/;

export function canvasMapNames(canvasId: string): { nodes: string; edges: string } {
    return { nodes: `${ROOT_PREFIX}${canvasId}:nodes`, edges: `${ROOT_PREFIX}${canvasId}:edges` };
}

/** 'canvas:<id>:nodes' / ':edges' → the canvas id, else null. */
export function canvasIdOfRoot(name: string): string | null {
    return ROOT_NAME.exec(name)?.[1] ?? null;
}

/** The names of the `canvas:*` root types a Y.Doc has (without creating any). */
export function canvasRootNames(ydoc: Y.Doc): string[] {
    return [...ydoc.share.keys()].filter((name) => canvasIdOfRoot(name) !== null);
}

/** The entries of a root map, or none when the doc doesn't have it (it is never created here). */
function rootEntries(ydoc: Y.Doc, name: string): Array<[string, unknown]> {
    if (!ydoc.share.has(name)) return [];
    try {
        return [...ydoc.getMap<unknown>(name).entries()].map(([key, value]) => [key, value instanceof Y.AbstractType ? value.toJSON() : value]);
    } catch {
        return [];
    }
}

/** The board of `canvasId` in this Y.Doc (empty when it has none): nodes in z order, edges by id. */
export function readBoard(ydoc: Y.Doc, canvasId: string): Board {
    const names = canvasMapNames(canvasId);
    return boardFrom(rootEntries(ydoc, names.nodes), rootEntries(ydoc, names.edges), true);
}

function nodeJson(n: NodeRecord): NodeRecord {
    const record: NodeRecord = { id: n.id, shape: n.shape, text: n.text, x: n.x, y: n.y, w: n.w, h: n.h, color: n.color, z: n.z };
    if (n.size) record.size = n.size;
    if (n.kind) record.kind = n.kind;
    if (n.parent) record.parent = n.parent;
    return record;
}

function edgeJson(e: EdgeRecord): EdgeRecord {
    const record: EdgeRecord = { id: e.id, from: e.from, to: e.to, label: e.label, line: e.line, arrow: e.arrow, path: e.path };
    if (e.route) record.route = cloneRoute(e.route);
    return record;
}

/** Make the board of `canvasId` exactly `board`: both maps cleared, then every record set (one transaction). */
export function writeBoard(ydoc: Y.Doc, canvasId: string, board: Board): void {
    const names = canvasMapNames(canvasId);
    ydoc.transact(() => {
        const nodes = ydoc.getMap<NodeRecord>(names.nodes);
        const edges = ydoc.getMap<EdgeRecord>(names.edges);
        nodes.clear();
        edges.clear();
        for (const node of board.nodes) nodes.set(node.id, nodeJson(node));
        for (const edge of board.edges) edges.set(edge.id, edgeJson(edge));
    });
}

export function writeBoards(ydoc: Y.Doc, boards: ReadonlyMap<string, Board>): void {
    if (boards.size === 0) return;
    ydoc.transact(() => {
        for (const [canvasId, board] of boards) writeBoard(ydoc, canvasId, board);
    });
}

/**
 * Make the board of `canvasId` equal `board` by touching only what differs (an edit in place):
 * records that changed are set, records that are gone deleted, the rest left as stored (extra
 * fields a newer browser wrote included). Open editors and Undo then see only the real changes.
 * Returns how many records it set and deleted.
 */
export function writeBoardDiff(ydoc: Y.Doc, canvasId: string, board: Board): { set: number; deleted: number } {
    const names = canvasMapNames(canvasId);
    const counts = { set: 0, deleted: 0 };
    const sync = <T extends { id: string }>(map: Y.Map<unknown>, records: readonly T[], read: (value: unknown, key: string) => T | null, json: (r: T) => T) => {
        const want = new Map(records.map((r) => [r.id, json(r)]));
        for (const key of [...map.keys()]) {
            if (want.has(key)) continue;
            map.delete(key);
            counts.deleted += 1;
        }
        for (const [key, record] of want) {
            const raw = map.get(key);
            const stored = read(raw instanceof Y.AbstractType ? raw.toJSON() : raw, key);
            if (stored && JSON.stringify(json(stored)) === JSON.stringify(record)) continue;
            map.set(key, record);
            counts.set += 1;
        }
    };
    ydoc.transact(() => {
        sync(ydoc.getMap<unknown>(names.nodes), board.nodes, coerceNode, nodeJson);
        sync(ydoc.getMap<unknown>(names.edges), board.edges, coerceEdge, edgeJson);
    });
    return counts;
}

/** Make `map` hold exactly `entries` (as plain JSON copies), touching only what differs. */
function syncMap(map: Y.Map<unknown>, entries: ReadonlyMap<string, unknown>): void {
    for (const key of [...map.keys()]) if (!entries.has(key)) map.delete(key);
    for (const [key, value] of entries) {
        const json = JSON.stringify(value ?? null);
        if (JSON.stringify(map.get(key) ?? null) !== json || !map.has(key)) map.set(key, JSON.parse(json) as unknown);
    }
}

/** Copy the canvas maps of these canvases, as stored (records untouched), from one doc into another. */
export function copyCanvasMaps(from: Y.Doc, to: Y.Doc, canvasIds: Iterable<string>): void {
    to.transact(() => {
        for (const canvasId of canvasIds) {
            const names = canvasMapNames(canvasId);
            for (const name of [names.nodes, names.edges]) {
                const entries = rootEntries(from, name);
                if (entries.length > 0 || to.share.has(name)) syncMap(to.getMap(name), new Map(entries));
            }
        }
    });
}

/** Every canvas map of `source` restored into `target` as it is in `source` (the snapshot Undo). */
export function restoreCanvasMaps(target: Y.Doc, source: Y.Doc): void {
    const ids = new Set(canvasRootNames(source).map((name) => canvasIdOfRoot(name)!));
    if (ids.size > 0) copyCanvasMaps(source, target, ids);
}

// ─── Absorb (JSON → Yjs) and inject (Yjs → JSON) ──────────────────────

function hasCanvas(node: unknown): boolean {
    if (!isObj(node)) return false;
    if (node['type'] === 'canvas') return true;
    const content = node['content'];
    return Array.isArray(content) && content.some(hasCanvas);
}

/** Canvas ids in a JSON tree (document order). */
export function canvasIdsIn(nodes: readonly JSONContent[] | JSONContent | undefined): string[] {
    const ids: string[] = [];
    const walk = (node: unknown) => {
        if (!isObj(node)) return;
        if (node['type'] === 'canvas') {
            const id = isObj(node['attrs']) ? node['attrs']['canvasId'] : null;
            if (isCanvasId(id)) ids.push(id);
            return;
        }
        if (Array.isArray(node['content'])) node['content'].forEach(walk);
    };
    if (Array.isArray(nodes)) nodes.forEach(walk);
    else walk(nodes);
    return ids;
}

/**
 * Gives every canvas in a JSON tree without an id of its own (none, not a canvas id, or one used
 * earlier in the tree) a fresh one, in place, and returns all canvas ids in document order. For
 * content going into a new doc, which keeps them, so a write can name the canvases it made.
 */
export function giveCanvasIds(json: JSONContent): string[] {
    const ids: string[] = [];
    const walk = (node: unknown) => {
        if (!isObj(node)) return;
        if (node['type'] === 'canvas') {
            const attrs: Obj = isObj(node['attrs']) ? node['attrs'] : (node['attrs'] = {});
            let id = attrs['canvasId'];
            if (!isCanvasId(id) || ids.includes(id)) {
                do id = newCanvasId();
                while (ids.includes(id as string));
                attrs['canvasId'] = id;
            }
            ids.push(id as string);
            return;
        }
        if (Array.isArray(node['content'])) node['content'].forEach(walk);
    };
    walk(json);
    return ids;
}

/** The doc the absorbed content goes into. */
export interface CanvasTarget {
    /** The board the target doc already holds for this id, or null when its maps are empty. */
    existing?: ((canvasId: string) => Board | null) | undefined;
    /** Canvas ids already shown in the target doc: a canvas with one of them is a copy (fresh id). */
    seen?: Iterable<string> | undefined;
}

export interface Absorbed<T> {
    /** The content with every canvas's `data` → null (and fresh ids where needed). */
    json: T;
    /** The boards to write: canvas id → board. */
    boards: Map<string, Board>;
    /** Canvas ids whose board the target already holds (left as they are). */
    kept: string[];
}

// A ```canvas fence in the text form parses (synchronously, with the rest of the Markdown) into a
// diagram that still has to be laid out, which is asynchronous (ELK). Until resolveDiagrams
// (./diagram/resolve.ts) has done that, the canvas's data is { pendingDiagram: <the diagram> }.

/** The key of a canvas's `data` that holds a diagram waiting for its layout. */
export const PENDING_DIAGRAM = 'pendingDiagram';

/** True when a canvas's `data` is a diagram still waiting for its layout. */
export function isPendingDiagram(data: unknown): boolean {
    return isObj(data) && PENDING_DIAGRAM in data;
}

/**
 * A diagram reached a doc's Y.Doc before it was laid out: a write path skipped resolveDiagrams.
 * A bug on our side (never the agent's input), so it is not a 400.
 */
export class PendingDiagramError extends Error {
    constructor() {
        super('A canvas diagram reached the doc before it was laid out: call resolveDiagrams() on parsed Markdown before it is stored');
        this.name = 'PendingDiagramError';
    }
}

/** `data` as a Board: normalised (agent rules), JSON text parsed. A pending diagram throws loudly. */
function dataBoard(data: unknown): Board | null {
    if (data === undefined || data === null) return null;
    let value = data;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            throw bad('The canvas data is not valid JSON');
        }
    }
    if (isPendingDiagram(value)) throw new PendingDiagramError();
    return normalizeBoard(value);
}

const cloneBoard = (board: Board): Board => ({ nodes: board.nodes.map(nodeJson), edges: board.edges.map(edgeJson) });

/**
 * Absorb (spec §5): for every canvas node in document order, an id that is missing (or not a
 * canvas id) or already seen in this doc gets a fresh id, and its board is its `data` or, without
 * data, a copy of the seen id's board. Otherwise its `data` is written only when the target has no
 * board for that id yet. Then `data` → null. Returns new JSON (the input is not changed); content
 * without canvases comes back as it is. `data` that is no board → 400.
 */
export function takeCanvasData<T extends JSONContent>(json: T, target: CanvasTarget = {}): Absorbed<T> {
    const boards = new Map<string, Board>();
    const kept: string[] = [];
    if (!hasCanvas(json)) return { json, boards, kept };
    const seen = new Set<string>(target.seen ?? []);
    const boardOf = (id: string): Board | null => boards.get(id) ?? target.existing?.(id) ?? null;

    const visit = (node: JSONContent): JSONContent => {
        if (!isObj(node)) return node;
        if (node.type === 'canvas') {
            const attrs: Obj = isObj(node.attrs) ? node.attrs : {};
            const given = isCanvasId(attrs['canvasId']) ? (attrs['canvasId'] as string) : null;
            const data = dataBoard(attrs['data']);
            let id: string;
            if (given === null || seen.has(given)) {
                const source = data ?? (given !== null ? boardOf(given) : null);
                do {
                    id = newCanvasId();
                } while (seen.has(id));
                if (source && !isEmptyBoard(source)) boards.set(id, cloneBoard(source));
            } else {
                id = given;
                const existing = target.existing?.(id) ?? null;
                if (existing && !isEmptyBoard(existing)) kept.push(id);
                else if (data && !isEmptyBoard(data)) boards.set(id, data);
            }
            seen.add(id);
            return { ...node, attrs: { ...attrs, canvasId: id, data: null } };
        }
        return Array.isArray(node.content) ? { ...node, content: node.content.map(visit) } : node;
    };
    return { json: visit(json) as T, boards, kept };
}

/** Absorb into a live doc: the ids its fragment shows are taken, its boards are the existing ones. */
export function liveCanvasTarget(ydoc: Y.Doc, current: readonly JSONContent[]): CanvasTarget {
    return { seen: canvasIdsIn(current), existing: (id) => readBoard(ydoc, id) };
}

/**
 * Inject (spec §5): every canvas node gets `attrs.data` = its board from `ydoc`, for reading
 * (Markdown, search text, Recall). Returns new JSON; content without canvases comes back as it is.
 */
export function withCanvasData<T extends JSONContent>(json: T, ydoc: Y.Doc): T {
    if (!hasCanvas(json)) return json;
    const visit = (node: JSONContent): JSONContent => {
        if (!isObj(node)) return node;
        if (node.type === 'canvas') {
            const attrs: Obj = isObj(node.attrs) ? node.attrs : {};
            const id = attrs['canvasId'];
            let data = typeof id === 'string' && id ? readBoard(ydoc, id) : emptyBoard();
            // A board carried in the element itself (should never be stored, but keep what is there).
            if (isEmptyBoard(data) && isObj(attrs['data'])) data = coerceBoard(attrs['data']);
            return { ...node, attrs: { ...attrs, data } };
        }
        return Array.isArray(node.content) ? { ...node, content: node.content.map(visit) } : node;
    };
    return visit(json) as T;
}

// ─── Undo scope ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyType = Y.AbstractType<any>;

/** The root type a (nested) type belongs to. */
function rootOf(type: AnyType): AnyType {
    let current = type;
    while (current._item && current._item.parent instanceof Y.AbstractType) current = current._item.parent;
    return current;
}

/**
 * The `canvas:*` root maps `update` changes (adds, overwrites or deletes entries of), given the
 * state `before` it was made on. Replays it on a scratch doc and reads what the transaction changed.
 */
export function canvasRootsTouched(before: Uint8Array, update: Uint8Array): string[] {
    const doc = new Y.Doc();
    try {
        Y.applyUpdate(doc, before);
        const changed = new Set<AnyType>();
        const collect = (transaction: Y.Transaction) => {
            for (const type of transaction.changed.keys()) changed.add(rootOf(type));
        };
        doc.on('afterTransaction', collect);
        Y.applyUpdate(doc, update);
        doc.off('afterTransaction', collect);
        const names: string[] = [];
        for (const [name, type] of doc.share) if (changed.has(type) && canvasIdOfRoot(name) !== null) names.push(name);
        return names.sort();
    } finally {
        doc.destroy();
    }
}
