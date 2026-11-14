// A board → the text form of its ```canvas fence (CANVAS_BLOCK_SPEC §9 "Printing"): what read_doc
// and Copy as Markdown show, and what an agent edits and sends back.
//
//   %% id: cv_…                       first, so the next write can find the board
//   %% height: 600                    only when the block is not the height that fits the board
//   flowchart LR                      the direction the arrows mostly run
//   subgraph api [API tier]           zones, holding their boxes (and notes)
//     a1[API server 1]
//   end
//   db[(Postgres)]@{ kind: database }:::blue    the other boxes: shape bracket, kind, colour
//   a1 -->|SQL| db                    the arrows, one a line
//   note n1 for db: Primary + replicas          notes ("for" when its only link is a plain dashed line from one box)
//
// Positions and sizes are not printed: the server keeps them by id. parse(print(board)) gives the
// same ids, texts, shapes, kinds, colours, zones, parents, arrows and notes.
import {
    CANVAS_DEFAULT_HEIGHT,
    KIND_SHAPES,
    absoluteBoxes,
    canvasHeight,
    coerceBoard,
    fittedCanvasHeight,
    isCanvasId,
    type Board,
    type EdgeRecord,
    type NodeRecord,
} from '../canvas';

/** Ids the text form reads as one id (see parse.ts). */
const ID = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*$/;

/** Shape → its bracket. Text has none (it is written with @{ shape: text }). */
const BRACKETS: Readonly<Partial<Record<NodeRecord['shape'], [string, string]>>> = {
    rect: ['[', ']'],
    rounded: ['(', ')'],
    pill: ['([', '])'],
    cylinder: ['[(', ')]'],
    ellipse: ['((', '))'],
    diamond: ['{', '}'],
    queue: ['[[', ']]'],
};

/** Text on one line: line breaks as <br>. */
const oneLine = (text: string): string => text.replace(/\r?\n/g, '<br>');

/** Text in a bracket: quoted when it holds a bracket, a pipe or a quote (a quote then as #quot;). */
function bracketed(text: string, open: string, close: string): string {
    const line = oneLine(text);
    if (line === '') return `${open}""${close}`;
    const plain = !/[[\](){}|"]/.test(line) && !/^\s|\s$/.test(line) && !line.startsWith('`');
    return plain ? `${open}${line}${close}` : `${open}"${line.replace(/"/g, '#quot;')}"${close}`;
}

/** An arrow label between pipes. */
function piped(label: string): string {
    const line = oneLine(label);
    return /[|"]/.test(line) || line.startsWith('`') ? `|"${line.replace(/"/g, '#quot;')}"|` : `|${line}|`;
}

const ARROWS: Readonly<Record<EdgeRecord['line'], Readonly<Record<EdgeRecord['arrow'], string>>>> = {
    solid: { end: '-->', none: '---', both: '<-->' },
    dashed: { end: '-.->', none: '-.-', both: '<-.->' },
};

/**
 * Box ids as the text form can write them: kept when they read as one id, else letters, digits
 * and _ only (a board drawn by hand may use other ids), never two alike.
 */
function textIds(nodes: readonly NodeRecord[]): Map<string, string> {
    const out = new Map<string, string>();
    const taken = new Set(nodes.map((n) => n.id).filter((id) => ID.test(id)));
    for (const n of nodes) {
        if (ID.test(n.id)) {
            out.set(n.id, n.id);
            continue;
        }
        const base = n.id.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36) || 'box';
        let id = base;
        for (let i = 2; taken.has(id); i += 1) id = `${base}_${i}`;
        taken.add(id);
        out.set(n.id, id);
    }
    return out;
}

/** The way most arrows between boxes run (LR when there are none). */
export function boardDirection(board: Board): 'LR' | 'RL' | 'TB' | 'BT' {
    const boxes = absoluteBoxes(board.nodes);
    const shapes = new Map(board.nodes.map((n) => [n.id, n.shape]));
    const votes = { LR: 0, RL: 0, TB: 0, BT: 0 };
    for (const e of board.edges) {
        if (e.from === e.to || shapes.get(e.from) === 'sticky' || shapes.get(e.to) === 'sticky') continue;
        const a = boxes.get(e.from);
        const b = boxes.get(e.to);
        if (!a || !b) continue;
        const dx = b.x + b.w / 2 - (a.x + a.w / 2);
        const dy = b.y + b.h / 2 - (a.y + a.h / 2);
        if (dx === 0 && dy === 0) continue;
        if (Math.abs(dx) >= Math.abs(dy)) votes[dx > 0 ? 'LR' : 'RL'] += 1;
        else votes[dy > 0 ? 'TB' : 'BT'] += 1;
    }
    const best = (['LR', 'TB', 'RL', 'BT'] as const).reduce((a, b) => (votes[b] > votes[a] ? b : a));
    return votes[best] > 0 ? best : 'LR';
}

/** The text form of a board. `height` is printed when it is not the height that fits the board. */
export function printDiagram(board: Board, options: { canvasId?: string | null | undefined; height?: number | null | undefined } = {}): string {
    const ids = textIds(board.nodes);
    const idOf = (id: string) => ids.get(id) ?? id;
    const lines: string[] = [];
    if (options.canvasId && isCanvasId(options.canvasId)) lines.push(`%% id: ${options.canvasId}`);
    if (options.height !== undefined && options.height !== null) {
        const height = canvasHeight(options.height);
        const fitted = board.nodes.length > 0 ? fittedCanvasHeight(board) : CANVAS_DEFAULT_HEIGHT;
        if (height !== fitted) lines.push(`%% height: ${height}`);
    }
    lines.push(`flowchart ${boardDirection(board)}`);

    // A sticky with nothing a note line can't say is a `note`; with a colour, kind or size it is a
    // box written @{ shape: sticky }. A note whose only link is a plain dashed line from one box
    // is written `note id for box`.
    const asNote = (n: NodeRecord): boolean => n.shape === 'sticky' && n.color === 'default' && !n.kind && !n.size;
    const byId = new Map(board.nodes.map((n) => [n.id, n]));
    const forBox = new Map<string, EdgeRecord>();
    for (const n of board.nodes) {
        if (!asNote(n)) continue;
        const links = board.edges.filter((e) => e.from === n.id || e.to === n.id);
        const only = links[0];
        if (links.length === 1 && only && only.to === n.id && only.from !== n.id && only.line === 'dashed' && only.arrow === 'none' && !only.label) forBox.set(n.id, only);
    }

    const children = new Map<string | undefined, NodeRecord[]>();
    for (const n of board.nodes) {
        const parent = n.parent && byId.get(n.parent)?.shape === 'zone' ? n.parent : undefined;
        children.set(parent, [...(children.get(parent) ?? []), n]);
    }

    const box = (n: NodeRecord): string => {
        const attrs: string[] = [];
        if (n.kind) attrs.push(`kind: ${n.kind}`);
        // A kind picks a shape when the bracket names none ([text] is a plain box), so say rect.
        if (n.shape === 'text' || n.shape === 'sticky') attrs.push(`shape: ${n.shape}`);
        else if (n.shape === 'rect' && n.kind && KIND_SHAPES[n.kind] !== 'rect') attrs.push('shape: rect');
        if (n.size) attrs.push(`size: ${n.size}`);
        const [open, close] = BRACKETS[n.shape] ?? BRACKETS.rect!;
        const colour = n.color !== 'default' ? `:::${n.color}` : '';
        return `${idOf(n.id)}${bracketed(n.text, open, close)}${attrs.length > 0 ? `@{ ${attrs.join(', ')} }` : ''}${colour}`;
    };
    const note = (n: NodeRecord): string => {
        const link = forBox.get(n.id);
        return `note ${idOf(n.id)}${link ? ` for ${idOf(link.from)}` : ''}: ${oneLine(n.text)}`.trimEnd();
    };

    // Zones hold their boxes (and their notes); top-level notes come after the arrows. Boxes keep
    // the board's order, which is the order the layout follows: a zone's block goes where its
    // first box comes, so text read and sent back lays out the same.
    const parentOf = (id: string): string | undefined => {
        const parent = byId.get(id)?.parent;
        return parent && byId.get(parent)?.shape === 'zone' ? parent : undefined;
    };
    /** The zone just inside `zone` that holds `id` (null when `id` is not inside `zone`; undefined when directly in it). */
    const childZoneOn = (id: string, zone: string | undefined): string | null | undefined => {
        let child: string | undefined;
        for (let at = parentOf(id); at !== zone; at = parentOf(at)) {
            if (at === undefined) return null;
            child = at;
        }
        return child;
    };
    const nonZones = board.nodes.filter((n) => n.shape !== 'zone');
    const write = (zone: string | undefined, depth: number) => {
        const pad = '  '.repeat(depth);
        const done = new Set<string>();
        const writeZone = (id: string) => {
            done.add(id);
            const z = byId.get(id)!;
            const colour = z.color !== 'default' ? `:::${z.color}` : '';
            lines.push(`${pad}subgraph ${idOf(id)} ${bracketed(z.text, '[', ']')}${colour}`);
            write(id, depth + 1);
            for (const m of children.get(id) ?? []) if (asNote(m)) lines.push(`${pad}  ${note(m)}`);
            lines.push(`${pad}end`);
        };
        for (const n of nonZones) {
            const child = childZoneOn(n.id, zone);
            if (child === null) continue;
            if (child === undefined) {
                if (!asNote(n)) lines.push(`${pad}${box(n)}`);
            } else if (!done.has(child)) writeZone(child);
        }
        // Zones with no boxes in them.
        for (const z of children.get(zone) ?? []) if (z.shape === 'zone' && !done.has(z.id)) writeZone(z.id);
    };
    write(undefined, 1);

    for (const e of board.edges) {
        if (forBox.get(e.to) === e) continue;
        lines.push(`  ${idOf(e.from)} ${ARROWS[e.line][e.arrow]}${e.label ? piped(e.label) : ''} ${idOf(e.to)}`);
    }
    for (const n of children.get(undefined) ?? []) if (asNote(n)) lines.push(`  ${note(n)}`);
    return lines.join('\n');
}

/** A canvas node's attrs → its ```canvas fence in the text form (how docs print canvases). */
export function printCanvasFence(attrs: { canvasId?: unknown; height?: unknown; data?: unknown } | null | undefined): string {
    const board = coerceBoard(attrs?.data);
    const canvasId = typeof attrs?.canvasId === 'string' ? attrs.canvasId : null;
    const height = attrs?.height === undefined || attrs.height === null ? null : canvasHeight(attrs.height);
    return ['```canvas', printDiagram(board, { canvasId, height }), '```'].join('\n');
}
