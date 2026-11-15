// Canvas blocks (src/services/docs/canvas.ts, CANVAS_BLOCK_SPEC.md): input normalisation and
// auto-layout, the ```canvas Markdown fence, the v2 records (kind, parent, route, zones), and where
// boards live (absorb into the Y.Doc's canvas maps, inject back for reading).
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { JSONContent } from '@tiptap/core';
import {
    absoluteBoxes,
    boardBounds,
    canvasIdOfRoot,
    canvasMapNames,
    canvasRootNames,
    canvasRootsTouched,
    canvasTexts,
    coerceBoard,
    fittedCanvasHeight,
    giveCanvasIds,
    isCanvasId,
    isJsonCanvasText,
    newCanvasId,
    normalizeBoard,
    printCanvasJsonFence,
    readBoard,
    takeCanvasData,
    withCanvasData,
    writeBoard,
    type Board,
    type NodeRecord,
} from '../../../src/services/docs/canvas';
import { resolveDiagrams } from '../../../src/services/docs/diagram/resolve';
import { docJsonToMarkdown, markdownToBlocks, markdownToDocJson, yjsStateToMarkdown } from '../../../src/services/docs/markdown/docMarkdown';
import { docJsonToYjsState, getDocSchema, yjsStateToDocJson } from '../../../src/services/docs/docContent';
import ErrorResponse from '../../../src/utils/errorResponse';

/** The 400 message normalizeBoard (or the call) throws. */
function error400(run: () => unknown): string {
    try {
        run();
    } catch (err) {
        expect(err).toBeInstanceOf(ErrorResponse);
        expect((err as ErrorResponse).statusCode).toBe(400);
        return (err as ErrorResponse).message;
    }
    throw new Error('expected a 400');
}

const node = (over: Partial<NodeRecord> & { id: string }): NodeRecord => ({ shape: 'rect', text: '', x: 0, y: 0, w: 160, h: 64, color: 'default', z: 0, ...over });
const byId = (board: Board) => new Map(board.nodes.map((n) => [n.id, n]));
const canvasBlock = (canvasId: string | null, data: unknown = null): JSONContent => ({ type: 'canvas', attrs: { canvasId, height: 440, data } });
const para = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const ydocOf = (state: Uint8Array | string) => {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, typeof state === 'string' ? Buffer.from(state, 'base64') : state);
    return ydoc;
};
/** The board of the first canvas in some Markdown, as parsed (the JSON form). */
const parsedBoard = (md: string): Board => markdownToBlocks(md).find((b) => b.type === 'canvas')!.attrs!['data'] as Board;
/** The board of the first canvas in some Markdown, parsed and laid out (either form). */
async function laidOutBoard(md: string): Promise<Board> {
    const json = markdownToDocJson(md);
    await resolveDiagrams(json);
    return json.content!.find((b) => b.type === 'canvas')!.attrs!['data'] as Board;
}
/** What the text form keeps of a board: all but positions, sizes, z, arrow ids and paths. */
const meaning = (board: Board) => ({
    nodes: board.nodes.map((n) => ({ id: n.id, shape: n.shape, text: n.text, color: n.color, kind: n.kind ?? null, size: n.size ?? null, parent: n.parent ?? null })),
    edges: board.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, line: e.line, arrow: e.arrow })),
});

const SYSTEM_DESIGN = [
    '## Design',
    '',
    '```canvas',
    '{"layout": "LR", "nodes": [',
    '  {"id": "client", "text": "Client", "shape": "pill"},',
    '  {"id": "api", "text": "API gateway"},',
    '  {"id": "orders", "text": "Orders\\nservice", "color": "green"},',
    '  {"id": "db", "text": "Postgres", "shape": "database", "color": "blue"},',
    '  {"id": "queue", "text": "Kafka", "shape": "cylinder", "size": "l"},',
    '  {"id": "why", "text": "Idempotent consumers", "shape": "note", "color": "orange"}',
    '], "edges": [',
    '  {"from": "client", "to": "api", "label": "HTTPS"},',
    '  {"from": "api", "to": "orders", "path": "elbow"},',
    '  {"from": "orders", "to": "db", "label": "SQL", "line": "dashed"},',
    '  {"source": "orders", "target": "queue", "arrow": "both", "path": "curve"},',
    '  {"from": "queue", "to": "why", "arrow": "none"}',
    ']}',
    '```',
    '',
    'Text after the board.',
].join('\n');

// ─── normalizeBoard ────────────────────────────────────────────────────

describe('normalizeBoard', () => {
    it('fills in every field: the shape default size, colour, z in list order', () => {
        const board = normalizeBoard({ nodes: [{ id: 'a', text: 'A', x: 0, y: 0 }, { id: 'b', shape: 'cylinder', x: 300, y: 0 }], edges: [{ from: 'a', to: 'b' }] });
        expect(board).toEqual({
            nodes: [node({ id: 'a', text: 'A' }), node({ id: 'b', shape: 'cylinder', x: 300, w: 120, h: 96, z: 1 })],
            edges: [{ id: 'e1', from: 'a', to: 'b', label: '', line: 'solid', arrow: 'end', path: 'straight' }],
        });
    });

    it.each([
        ['box', 'rect'], ['Rectangle', 'rect'], ['stadium', 'pill'], ['terminal', 'pill'], ['round', 'pill'], ['circle', 'ellipse'], ['oval', 'ellipse'],
        ['decision', 'diamond'], ['rhombus', 'diamond'], ['database', 'cylinder'], ['DB', 'cylinder'], ['store', 'cylinder'], ['note', 'sticky'],
        ['post-it', 'sticky'], ['postit', 'sticky'], ['label', 'text'], ['title', 'text'], ['hexagon', 'rect'], [42, 'rect'],
    ])('shape %j → %s', (shape, expected) => {
        expect(normalizeBoard({ nodes: [{ shape, x: 0, y: 0 }] }).nodes[0]!.shape).toBe(expected);
    });

    it.each([
        ['grey', 'gray'], ['orange', 'yellow'], ['Amber', 'yellow'], ['purple', 'default'], ['pink', 'default'], ['brown', 'default'], ['teal', 'default'], ['RED', 'red'],
    ])('colour %s → %s', (color, expected) => {
        expect(normalizeBoard({ nodes: [{ color, x: 0, y: 0 }] }).nodes[0]!.color).toBe(expected);
    });

    it('edge line, arrow and path aliases; unknown values fall back to the defaults', () => {
        const edges = normalizeBoard({
            nodes: [{ id: 'a' }, { id: 'b' }],
            edges: [
                { from: 'a', to: 'b', line: 'dotted', arrow: 'both', path: 'curve' },
                { from: 'a', to: 'b', line: 'dashed', arrow: 'none', path: 'step' },
                { from: 'a', to: 'b', line: 'wavy', arrow: 'sideways', path: 'orthogonal' },
                { from: 'a', to: 'b', path: 'zigzag' },
            ],
        }).edges.map((e) => [e.line, e.arrow, e.path]);
        expect(edges).toEqual([
            ['dashed', 'both', 'curved'],
            ['dashed', 'none', 'elbow'],
            ['solid', 'end', 'elbow'],
            ['solid', 'end', 'straight'],
        ]);
    });

    it('label is an alias of text, source/target of from/to; text is trimmed with its line breaks kept', () => {
        const board = normalizeBoard({ nodes: [{ id: ' a ', label: '  Line one\r\nline two  ' }, { id: 'b', text: 7 }], edges: [{ source: 'a', target: 'b', text: ' calls ' }] });
        expect(board.nodes.map((n) => [n.id, n.text])).toEqual([
            ['a', 'Line one\nline two'],
            ['b', '7'],
        ]);
        expect(board.edges[0]).toMatchObject({ from: 'a', to: 'b', label: 'calls' });
    });

    it('makes ids n1, n2, … and e1, e2, … where missing, never taking a given one; repeated edge ids get new ones', () => {
        const board = normalizeBoard({
            nodes: [{ text: 'first' }, { id: 'n1', text: 'named n1' }, { text: 'third' }, { id: '', text: 'blank id' }],
            edges: [
                { id: 'e2', from: 'n1', to: 'n2' },
                { from: 'n2', to: 'n3' },
                { id: 'e2', from: 'n3', to: 'n1' },
                { id: 'bad id!', from: 'n1', to: 'n3' },
            ],
        });
        expect(board.nodes.map((n) => [n.id, n.text])).toEqual([
            ['n2', 'first'],
            ['n1', 'named n1'],
            ['n3', 'third'],
            ['n4', 'blank id'],
        ]);
        expect(board.edges.map((e) => e.id)).toEqual(['e2', 'e1', 'e3', 'e4']);
    });

    it('rounds and clamps numbers; numeric strings count; sizes outside 16–4000 are clamped, bad ones get the default', () => {
        const [a, b, c] = normalizeBoard({
            nodes: [
                { x: 10.6, y: -3.4, w: 3, h: 9999 },
                { x: 5e9, y: -5e9, w: '200', h: 'tall', shape: 'diamond' },
                { x: '12', y: '7.5', w: null, h: Infinity },
            ],
        }).nodes;
        expect([a!.x, a!.y, a!.w, a!.h]).toEqual([11, -3, 16, 4000]);
        expect([b!.x, b!.y, b!.w, b!.h]).toEqual([1_000_000, -1_000_000, 200, 100]);
        expect([c!.x, c!.y, c!.w, c!.h]).toEqual([12, 8, 160, 64]);
    });

    it('z orders the nodes (stable), then counts from 0; a text size is kept', () => {
        const board = normalizeBoard({ nodes: [{ id: 'top', z: 9, x: 0, y: 0 }, { id: 'bottom', z: -1, x: 0, y: 0 }, { id: 'mid', x: 0, y: 0, size: 'large' }, { id: 'mid2', z: 2, x: 0, y: 0, size: 's' }] });
        expect(board.nodes.map((n) => [n.id, n.z, n.size])).toEqual([
            ['bottom', 0, undefined],
            ['mid', 1, 'l'],
            ['mid2', 2, 's'],
            ['top', 3, undefined],
        ]);
        expect(Object.keys(board.nodes[0]!)).not.toContain('size');
    });

    it.each([
        ['not an object', [], /must be a JSON object/],
        ['no nodes', { edges: [] }, /needs a "nodes" array/],
        ['nodes not an array', { nodes: {} }, /needs a "nodes" array/],
        ['edges not an array', { nodes: [], edges: 'a->b' }, /"edges" must be an array/],
        ['301 nodes', { nodes: Array.from({ length: 301 }, () => ({})) }, /at most 300 nodes; this one has 301/],
        ['601 edges', { nodes: [{ id: 'a' }], edges: Array.from({ length: 601 }, () => ({ from: 'a', to: 'a' })) }, /at most 600 edges/],
        ['a node that is no object', { nodes: [{ id: 'a' }, 'b'] }, /^Node 2 must be an object/],
        ['an id with a space', { nodes: [{ id: 'api gateway' }] }, /^Node 1 has the id "api gateway": ids use only letters, digits, - and _/],
        ['a 41-character id', { nodes: [{ id: 'x'.repeat(41) }] }, /at most 40/],
        ['an id that is an object', { nodes: [{ id: { a: 1 } }] }, /^Node 1 has an id that is not text/],
        ['two nodes with one id', { nodes: [{ id: 'db' }, { id: 'api' }, { id: 'db' }] }, /^Two nodes have the id "db" \(nodes 1 and 3\)/],
        ['text that is an object', { nodes: [{ text: { md: 'x' } }] }, /^Node 1 text must be a string/],
        ['text over 1000 characters', { nodes: [{ text: 'y'.repeat(1001) }] }, /^Node 1 text is 1001 characters; the most is 1000/],
        ['an edge without ends', { nodes: [{ id: 'a' }], edges: [{ from: 'a' }] }, /^Edge 1 needs "from" and "to"/],
        ['an edge to a missing node', { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }, { from: 'a', to: 'xyz' }] }, /^Edge 3 points at "xyz", which is not a node\. Node ids: "a", "b"\.$/],
        ['an edge label over 200 characters', { nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'a', label: 'z'.repeat(201) }] }, /^Edge 1 label is 201 characters; the most is 200/],
        ['an unknown layout', { layout: 'radial', nodes: [] }, /^layout must be "LR" \(left to right\) or "TB" \(top to bottom\)/],
    ])('400: %s', (_name, input, message) => {
        expect(error400(() => normalizeBoard(input))).toMatch(message);
    });

    it('is idempotent (a normalised board normalises to itself)', () => {
        const once = parsedBoard(SYSTEM_DESIGN);
        expect(normalizeBoard(once)).toEqual(once);
    });
});

// ─── Auto-layout ───────────────────────────────────────────────────────

describe('auto-layout (nodes without x or y)', () => {
    const centre = (n: NodeRecord) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });

    it('LR (the default): ranks 240 apart left to right along the longest path, from (0, 0)', () => {
        const board = normalizeBoard({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'a', to: 'c' }] });
        expect(board.nodes.map((n) => [n.id, n.x, n.y])).toEqual([
            ['a', 0, 0],
            ['b', 240, 0],
            ['c', 480, 0],
        ]);
    });

    it('LR: rows 120 apart, each rank centred on the others', () => {
        const nodes = byId(normalizeBoard({ nodes: [{ id: 'lb' }, { id: 's1' }, { id: 's2' }, { id: 's3' }], edges: ['s1', 's2', 's3'].map((to) => ({ from: 'lb', to })) }));
        expect(['s1', 's2', 's3'].map((id) => centre(nodes.get(id)!))).toEqual([
            { x: 320, y: 32 },
            { x: 320, y: 152 },
            { x: 320, y: 272 },
        ]);
        expect(centre(nodes.get('lb')!)).toEqual({ x: 80, y: 152 });
    });

    it('TB: ranks 160 apart top to bottom, columns 220 apart, the parent centred over its children', () => {
        const nodes = byId(normalizeBoard({ layout: 'TB', nodes: [{ id: 'root' }, { id: 'left' }, { id: 'right' }], edges: [{ from: 'root', to: 'left' }, { from: 'root', to: 'right' }] }));
        expect(['root', 'left', 'right'].map((id) => [nodes.get(id)!.x, nodes.get(id)!.y])).toEqual([
            [110, 0],
            [0, 160],
            [220, 160],
        ]);
        expect(normalizeBoard({ layout: 'td', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] }).nodes[1]).toMatchObject({ x: 0, y: 160 });
    });

    it('without a layout, a long chain goes top to bottom (it fits a doc column); a short one stays left to right', () => {
        const chain = (n: number) => ({
            nodes: Array.from({ length: n }, (_, i) => ({ id: `s${i}` })),
            edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}` })),
        });
        const long = normalizeBoard(chain(5));
        expect(long.nodes.map((n) => n.x)).toEqual([0, 0, 0, 0, 0]);
        expect(long.nodes.map((n) => n.y)).toEqual([0, 160, 320, 480, 640]);
        expect(normalizeBoard(chain(3)).nodes.map((n) => n.y)).toEqual([0, 0, 0]);
        // An explicit layout always wins.
        expect(normalizeBoard({ ...chain(5), layout: 'LR' }).nodes.map((n) => n.y)).toEqual([0, 0, 0, 0, 0]);
    });

    it('a fence without "height" gets the height that shows its whole board (280–880); an empty one 440', () => {
        const fence = (body: object) => markdownToBlocks('```canvas\n' + JSON.stringify(body) + '\n```')[0]!.attrs!['height'];
        const chain = (n: number) => ({
            nodes: Array.from({ length: n }, (_, i) => ({ id: `s${i}` })),
            edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}` })),
        });
        expect(fence({ nodes: [] })).toBe(440);
        expect(fence(chain(2))).toBe(280); // one row of boxes: the minimum
        expect(fence(chain(5))).toBe(840); // 704 tall × 1.12 + 48 for the bars, on the 8 px grid
        expect(fence(chain(9))).toBe(880); // capped
        expect(fence({ ...chain(5), height: 500 })).toBe(500); // asked for: kept
    });

    it('a rank is only as deep as its own biggest box, and a note no arrow touches sits beside the flow', () => {
        const board = byId(
            normalizeBoard({
                layout: 'TB',
                nodes: [{ id: 'a' }, { id: 'b', shape: 'sticky' }, { id: 'c' }, { id: 'note', shape: 'sticky', text: 'Why' }],
                edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
            })
        );
        // a (64 tall), then the sticky's rank (140 tall), then c: gaps of 96 between ranks.
        expect(['a', 'b', 'c'].map((id) => board.get(id)!.y)).toEqual([0, 160, 396]);
        // The unconnected note: right of the flow (64 gap), from the top.
        expect(board.get('note')).toMatchObject({ x: 200 + 64, y: 0 });
    });

    it('breaks cycles (a → b → c → a) instead of looping, and ignores self-loops', () => {
        const nodes = byId(
            normalizeBoard({
                nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
                edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }, { from: 'b', to: 'b' }],
            })
        );
        expect(['a', 'b', 'c'].map((id) => nodes.get(id)!.x)).toEqual([0, 240, 480]);
    });

    it('orders a rank by where its predecessors sit (fewer crossings)', () => {
        // x1 → y2 and x2 → y1: the y's swap so the arrows don't cross.
        const nodes = byId(normalizeBoard({ nodes: [{ id: 'x1' }, { id: 'x2' }, { id: 'y1' }, { id: 'y2' }], edges: [{ from: 'x1', to: 'y2' }, { from: 'x2', to: 'y1' }] }));
        expect(nodes.get('y2')!.y).toBeLessThan(nodes.get('y1')!.y);
    });

    it('with some nodes placed, the laid-out ones go below their bounding box (120 gap), from its left edge', () => {
        const board = normalizeBoard({
            nodes: [
                { id: 'p1', x: 100, y: 50 },
                { id: 'p2', x: 400, y: 200, h: 100 },
                { id: 'f1' },
                { id: 'f2', x: 999 }, // x without y: laid out
            ],
            edges: [{ from: 'f1', to: 'f2' }, { from: 'p1', to: 'f1' }],
        });
        const nodes = byId(board);
        expect(nodes.get('p1')).toMatchObject({ x: 100, y: 50 });
        expect(nodes.get('p2')).toMatchObject({ x: 400, y: 200 });
        expect(nodes.get('f1')).toMatchObject({ x: 100, y: 420 });
        expect(nodes.get('f2')).toMatchObject({ x: 340, y: 420 });
    });

    it('bigger boxes get wider spacing, so nothing overlaps', () => {
        const board = normalizeBoard({ nodes: [{ id: 'hub' }, ...Array.from({ length: 4 }, (_v, i) => ({ id: `s${i}`, shape: 'sticky' }))], edges: [0, 1, 2, 3].map((i) => ({ from: 'hub', to: `s${i}` })) });
        const boxes = board.nodes;
        for (const a of boxes) {
            for (const b of boxes) {
                if (a === b) continue;
                const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
                expect(apart, `${a.id} and ${b.id} overlap`).toBe(true);
            }
        }
    });

    it('unconnected nodes stack in the first rank', () => {
        expect(normalizeBoard({ nodes: [{ id: 'a' }, { id: 'b' }] }).nodes.map((n) => [n.x, n.y])).toEqual([
            [0, 0],
            [0, 120],
        ]);
    });
});

// ─── The fence ─────────────────────────────────────────────────────────

describe('the ```canvas fence', () => {
    const specBoard: Board = {
        nodes: [node({ id: 'client', text: 'Client' }), node({ id: 'db', shape: 'cylinder', text: 'Postgres', color: 'blue', x: 480, w: 120, h: 96, z: 1 })],
        edges: [{ id: 'e1', from: 'client', to: 'db', label: 'SQL', line: 'dashed', arrow: 'end', path: 'straight' }],
    };

    it('prints as the spec shows: the id, one node or edge per line, defaults left out', () => {
        expect(printCanvasJsonFence({ canvasId: 'cv_Ab3dE6gH9jK0', height: 440, data: specBoard })).toBe(
            [
                '```canvas',
                '{',
                '  "id": "cv_Ab3dE6gH9jK0",',
                '  "nodes": [',
                '    {"id":"client","text":"Client","x":0,"y":0,"w":160,"h":64},',
                '    {"id":"db","shape":"cylinder","text":"Postgres","color":"blue","x":480,"y":0,"w":120,"h":96}',
                '  ],',
                '  "edges": [',
                '    {"id":"e1","from":"client","to":"db","label":"SQL","line":"dashed"}',
                '  ]',
                '}',
                '```',
            ].join('\n')
        );
    });

    it('adds "height" when it is not 440 (clamped to 240–1400); numbers print as integers; nodes in z order', () => {
        const data = { nodes: [node({ id: 'b', x: 10.4, z: 5, size: 'l' }), node({ id: 'a', w: 99.6, z: 1 })], edges: [] };
        expect(printCanvasJsonFence({ canvasId: null, height: 9000, data })).toBe(
            ['```canvas', '{', '  "height": 1400,', '  "nodes": [', '    {"id":"a","x":0,"y":0,"w":100,"h":64},', '    {"id":"b","x":10,"y":0,"w":160,"h":64,"size":"l"}', '  ],', '  "edges": []', '}', '```'].join('\n')
        );
    });

    it('without data: an empty board that keeps the id', () => {
        expect(printCanvasJsonFence({ canvasId: 'cv_Ab3dE6gH9jK0', height: 600, data: null })).toBe(
            ['```canvas', '{', '  "id": "cv_Ab3dE6gH9jK0",', '  "height": 600,', '  "nodes": [],', '  "edges": []', '}', '```'].join('\n')
        );
    });

    it('parses into a canvas block with its board in data and no id (the fence id is ignored)', () => {
        const [block] = markdownToBlocks('```canvas\n{"id": "cv_Ab3dE6gH9jK0", "height": 600, "nodes": [{"id": "a", "text": "A"}]}\n```');
        expect(block).toEqual({ type: 'canvas', attrs: { canvasId: null, height: 600, data: { nodes: [node({ id: 'a', text: 'A' })], edges: [] } } });
        expect(() => getDocSchema().nodeFromJSON({ type: 'doc', content: [block] }).check()).not.toThrow();
    });

    it('Markdown → JSON → Yjs state → Markdown prints the text form; read back and laid out it is the same board; the next trip prints the same (but a new id)', async () => {
        const first = yjsStateToMarkdown(docJsonToYjsState(markdownToDocJson(SYSTEM_DESIGN)));
        const withoutId = (md: string) => md.replace(/%% id: cv_[A-Za-z0-9_-]{12}/, '%% id: …');
        expect(first.split('\n')[3]).toMatch(/^%% id: cv_[A-Za-z0-9_-]{12}$/);
        // The height fits the board, so no %% height line; positions and sizes are not printed.
        expect(withoutId(first)).toBe(
            [
                '## Design',
                '',
                '```canvas',
                '%% id: …',
                'flowchart LR',
                '  client([Client])',
                '  api[API gateway]',
                '  orders[Orders<br>service]:::green',
                '  db[(Postgres)]:::blue',
                '  queue[(Kafka)]@{ size: l }',
                '  why[Idempotent consumers]@{ shape: sticky }:::yellow',
                '  client -->|HTTPS| api',
                '  api --> orders',
                '  orders -.->|SQL| db',
                '  orders <--> queue',
                '  queue --- why',
                '```',
                '',
                'Text after the board.',
            ].join('\n')
        );
        const original = parsedBoard(SYSTEM_DESIGN);
        expect(original.nodes).toHaveLength(6);
        expect(original.edges).toHaveLength(5);
        const back = await laidOutBoard(first);
        expect(meaning(back)).toEqual(meaning(original));

        const json = markdownToDocJson(first);
        await resolveDiagrams(json);
        const second = yjsStateToMarkdown(docJsonToYjsState(json));
        expect(withoutId(second)).toBe(withoutId(first));
        expect(second).not.toBe(first);
    });

    it('any text survives the fence: quotes, backslashes, HTML, backticks, a fence line, emoji, line breaks', async () => {
        const texts = ['say "hi" \\ bye', '<b>bold</b> &amp; <script>x</script>', 'use ```ts``` here', '```\nnot a fence end', 'naïve ✓ 🚀', 'tab\there\r\nnext'];
        const md = `\`\`\`canvas\n${JSON.stringify({ nodes: texts.map((text, i) => ({ id: `t${i}`, text, x: 0, y: i * 100 })), edges: [{ from: 't0', to: 't1', label: '"quoted" `label`' }] })}\n\`\`\``;
        const board = parsedBoard(md);
        const printed = yjsStateToMarkdown(docJsonToYjsState(markdownToDocJson(md)));
        expect(markdownToBlocks(printed)).toHaveLength(1);
        expect(meaning(await laidOutBoard(printed))).toEqual(meaning(board));
        expect(board.nodes.map((n) => n.text)).toEqual(texts.map((t) => t.replace(/\r\n/g, '\n')));
    });

    it('a JSON fence still reads as before (positions kept); a text fence is laid out when resolved', async () => {
        expect(isJsonCanvasText('  {"nodes": []}')).toBe(true);
        expect(isJsonCanvasText('')).toBe(true);
        expect(isJsonCanvasText('flowchart LR\na --> b')).toBe(false);
        const json = parsedBoard('```canvas\n{"nodes": [{"id": "a", "x": 5, "y": 7}]}\n```');
        expect(json.nodes[0]).toMatchObject({ id: 'a', x: 5, y: 7 });
        const text = await laidOutBoard('```canvas\nflowchart LR\na[A] --> b[B]\n```');
        expect(text.nodes.map((n) => [n.id, n.text])).toEqual([
            ['a', 'A'],
            ['b', 'B'],
        ]);
        expect(text.edges[0]!.route!.points.length).toBeGreaterThanOrEqual(2);
    });

    it('bad JSON is a 400 that says so (not wrapped as unreadable Markdown)', () => {
        expect(error400(() => markdownToDocJson('```canvas\n{"nodes": [}\n```'))).toMatch(/^The canvas block is not valid JSON: /);
        expect(error400(() => markdownToDocJson('Intro\n\n```canvas\n{"nodes": [{"id": "a"}], "edges": [{"from": "a", "to": "b"}]}\n```'))).toBe(
            'Edge 1 points at "b", which is not a node. Node ids: "a".'
        );
    });

    it('an empty fence is an empty board; ~~~canvas and ```Canvas work too', () => {
        expect(markdownToBlocks('```canvas\n```')[0]).toMatchObject({ type: 'canvas', attrs: { data: { nodes: [], edges: [] } } });
        expect(markdownToBlocks('~~~canvas\n{"nodes": []}\n~~~')[0]!.type).toBe('canvas');
        expect(markdownToBlocks('```Canvas\n{"nodes": []}\n```')[0]!.type).toBe('canvas');
    });

    it.each(['ts', 'json', 'mermaid', 'canvases', ''])('a ```%s fence stays a code block', (lang) => {
        const md = `\`\`\`${lang}\n{"nodes": []}\n\`\`\``;
        expect(markdownToBlocks(md)).toEqual([{ type: 'codeBlock', attrs: { language: lang || null }, content: [{ type: 'text', text: '{"nodes": []}' }] }]);
        expect(docJsonToMarkdown(markdownToDocJson(md))).toBe(md);
    });
});

// ─── Records v2: kind, parent, route; zones ────────────────────────────

describe('records v2 (CANVAS_BLOCK_SPEC §9)', () => {
    const zoned = () => ({
        nodes: [
            { id: 'a1', text: 'API 1', parent: 'api', x: 20, y: 40, kind: 'server' },
            { id: 'api', shape: 'zone', text: 'API tier', x: 300, y: 100, w: 220, h: 140, z: 5 },
            { id: 'inner', shape: 'group', text: 'Inner', parent: 'api', x: 10, y: 10, w: 100, h: 60 },
            { id: 'db', kind: 'db', x: 0, y: 0 },
        ],
        edges: [{ from: 'a1', to: 'db', route: { points: [[320.4, 172], [100, 172], { x: 100, y: 96 }], label: [210, 172] } }, { from: 'api', to: 'db', route: { points: [[1, 2]] } }],
    });

    it('normalizeBoard keeps kind (aliases too; it gives the shape when none is named), parent and a route; zones come before what they hold', () => {
        const board = normalizeBoard(zoned());
        expect(board.nodes.map((n) => [n.id, n.shape, n.kind ?? null, n.parent ?? null, n.z])).toEqual([
            ['api', 'zone', null, null, 0],
            ['a1', 'rect', 'service', 'api', 1],
            ['inner', 'zone', null, 'api', 2],
            ['db', 'cylinder', 'database', null, 3],
        ]);
        expect(board.edges[0]!.route).toEqual({ points: [[320, 172], [100, 172], [100, 96]], label: [210, 172] });
        // A route that is not one (a single point) is dropped: the browser draws `path` instead.
        expect(board.edges[1]).not.toHaveProperty('route');
        expect(normalizeBoard({ nodes: [{ id: 'q', kind: 'kafka-like', shape: 'rect', x: 0, y: 0 }] }).nodes[0]).toMatchObject({ shape: 'rect', kind: 'stream' });
        expect(normalizeBoard(board)).toEqual(board);
    });

    it.each([
        ['an unknown kind', { nodes: [{ id: 'x', kind: 'blockchain' }] }, /^Node 1: "blockchain" is not a kind\. Kinds: client, user, mobile, service, /],
        ['a parent that is no node', { nodes: [{ id: 'z', shape: 'zone', x: 0, y: 0 }, { id: 'a', parent: 'nope', x: 0, y: 0 }] }, /^Node 2 has the parent "nope", which is not a node\. Zones: "z"\./],
        ['a parent that is no zone', { nodes: [{ id: 'b', x: 0, y: 0 }, { id: 'a', parent: 'b', x: 0, y: 0 }] }, /^Node 2 has the parent "b", which is not a zone \(shape "zone"\)\. The board has no zones/],
        ['zones in a loop', { nodes: [{ id: 'z1', shape: 'zone', parent: 'z2', x: 0, y: 0 }, { id: 'z2', shape: 'zone', parent: 'z1', x: 0, y: 0 }] }, /ends up inside itself/],
        ['zones without positions', { nodes: [{ id: 'z', shape: 'zone' }, { id: 'a', parent: 'z' }] }, /^A canvas with zones in the JSON form needs x and y on every node.*Or write the text form/],
    ])('400: %s', (_name, input, message) => {
        expect(error400(() => normalizeBoard(input))).toMatch(message);
    });

    it('reading what a browser stored: a parent that is no zone is dropped (the node keeps its numbers), loops are cut, unknown kinds dropped, zones first', () => {
        const ydoc = new Y.Doc();
        const nodes = ydoc.getMap<unknown>('canvas:cv_Ab3dE6gH9jK0:nodes');
        nodes.set('child', { text: 'C', parent: 'zone', x: 5, y: 6, z: 0, kind: 'cache' });
        nodes.set('zone', { shape: 'zone', text: 'Z', x: 100, y: 100, w: 300, h: 200, z: 3 });
        nodes.set('orphan', { text: 'O', parent: 'gone', x: 7, y: 8, z: 1, kind: 'spaceship' });
        nodes.set('boxed', { text: 'B', parent: 'orphan', z: 2 });
        nodes.set('l1', { shape: 'zone', parent: 'l2', z: 4 });
        nodes.set('l2', { shape: 'zone', parent: 'l1', z: 5 });
        ydoc.getMap<unknown>('canvas:cv_Ab3dE6gH9jK0:edges').set('e1', { from: 'child', to: 'orphan', route: { points: [[1, 2], [3, 4]] } });
        const board = readBoard(ydoc, 'cv_Ab3dE6gH9jK0');
        expect(board.nodes.map((n) => [n.id, n.parent ?? null, n.kind ?? null])).toEqual([
            ['zone', null, null],
            ['child', 'zone', 'cache'],
            ['orphan', null, null],
            ['boxed', null, null],
            // l1 ↔ l2: the first one read loses its link, so the other sits in it.
            ['l1', null, null],
            ['l2', 'l1', null],
        ]);
        expect(board.nodes.find((n) => n.id === 'orphan')).toMatchObject({ x: 7, y: 8 });
        expect(board.edges[0]!.route).toEqual({ points: [[1, 2], [3, 4]] });

        // Written back, the v2 fields stay.
        const copy = new Y.Doc();
        writeBoard(copy, 'cv_Ab3dE6gH9jK0', board);
        expect(readBoard(copy, 'cv_Ab3dE6gH9jK0')).toEqual(board);
        ydoc.destroy();
        copy.destroy();
    });

    it('positions in a zone add up: absolute boxes, the bounds and the fitted height use them', () => {
        const board = normalizeBoard(zoned());
        const boxes = absoluteBoxes(board.nodes);
        expect(boxes.get('a1')).toEqual({ x: 320, y: 140, w: 160, h: 64 });
        expect(boxes.get('inner')).toEqual({ x: 310, y: 110, w: 100, h: 60 });
        expect(boardBounds(board.nodes)).toEqual({ x: 0, y: 0, w: 520, h: 240 });
        expect(fittedCanvasHeight(board)).toBe(Math.round((240 * 1.12 + 48) / 8) * 8);
        expect(boardBounds([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    });

    it('the JSON printer writes kind, parent and route', () => {
        const printed = printCanvasJsonFence({ canvasId: null, height: 440, data: normalizeBoard(zoned()) });
        expect(printed).toContain('{"id":"a1","text":"API 1","kind":"service","parent":"api","x":20,"y":40,"w":160,"h":64}');
        expect(printed).toContain('"route":{"points":[[320,172],[100,172],[100,96]],"label":[210,172]}');
    });

    it('giveCanvasIds: fresh ids where there are none (or one repeats), in place, in document order', () => {
        const id = 'cv_Ab3dE6gH9jK0';
        const json: JSONContent = { type: 'doc', content: [canvasBlock(null), para('x'), canvasBlock(id), canvasBlock(id), { type: 'canvas' }] };
        const ids = giveCanvasIds(json);
        expect(ids).toHaveLength(4);
        expect(ids[1]).toBe(id);
        expect(new Set(ids).size).toBe(4);
        expect(ids.every(isCanvasId)).toBe(true);
        expect(json.content!.filter((b) => b.type === 'canvas').map((b) => b.attrs!['canvasId'])).toEqual(ids);
    });
});

// ─── The schema ────────────────────────────────────────────────────────

describe('the canvas node', () => {
    it('is an atom block with canvasId, height (440) and data, all defaulted', () => {
        const type = getDocSchema().nodes['canvas']!;
        expect(type.isBlock && type.isAtom).toBe(true);
        expect(type.spec.group).toBe('block');
        expect(type.spec.draggable).toBe(false);
        expect(type.spec.selectable).toBe(true);
        expect(Object.fromEntries(Object.entries(type.spec.attrs ?? {}).map(([k, v]) => [k, v.default]))).toEqual({ canvasId: null, height: 440, data: null });
    });

    it('does not become the default block (paragraph stays first)', () => {
        const schema = getDocSchema();
        expect(schema.topNodeType.contentMatch.defaultType?.name).toBe('paragraph');
        for (const name of ['callout', 'detailsContent', 'blockquote']) expect(schema.nodes[name]!.contentMatch.defaultType?.name, name).toBe('paragraph');
    });
});

// ─── Ids and maps ──────────────────────────────────────────────────────

describe('ids and root maps', () => {
    it('makes cv_ + 12 url-safe characters, different every time', () => {
        const ids = new Set(Array.from({ length: 200 }, newCanvasId));
        expect(ids.size).toBe(200);
        for (const id of ids) expect(isCanvasId(id)).toBe(true);
        expect(isCanvasId('cv_short')).toBe(false);
    });

    it('names two root maps per canvas', () => {
        expect(canvasMapNames('cv_Ab3dE6gH9jK0')).toEqual({ nodes: 'canvas:cv_Ab3dE6gH9jK0:nodes', edges: 'canvas:cv_Ab3dE6gH9jK0:edges' });
        expect(canvasIdOfRoot('canvas:cv_Ab3dE6gH9jK0:edges')).toBe('cv_Ab3dE6gH9jK0');
        expect(canvasIdOfRoot('metadata')).toBeNull();
    });

    it('writeBoard clears, then sets plain records; readBoard reads them back without creating maps', () => {
        const ydoc = new Y.Doc();
        const board = parsedBoard(SYSTEM_DESIGN);
        writeBoard(ydoc, 'cv_Ab3dE6gH9jK0', board);
        expect(readBoard(ydoc, 'cv_Ab3dE6gH9jK0')).toEqual(board);
        expect(ydoc.getMap('canvas:cv_Ab3dE6gH9jK0:nodes').get('db')).toEqual(board.nodes.find((n) => n.id === 'db'));
        writeBoard(ydoc, 'cv_Ab3dE6gH9jK0', { nodes: [node({ id: 'only' })], edges: [] });
        expect(readBoard(ydoc, 'cv_Ab3dE6gH9jK0')).toEqual({ nodes: [node({ id: 'only' })], edges: [] });

        expect(readBoard(ydoc, 'cv_nothingHere1')).toEqual({ nodes: [], edges: [] });
        expect(canvasRootNames(ydoc).sort()).toEqual(['canvas:cv_Ab3dE6gH9jK0:edges', 'canvas:cv_Ab3dE6gH9jK0:nodes']);
    });

    it('readBoard is lenient with what a browser stored: map keys are ids, z orders, dangling arrows are dropped', () => {
        const ydoc = new Y.Doc();
        const nodes = ydoc.getMap<unknown>('canvas:cv_Ab3dE6gH9jK0:nodes');
        const edges = ydoc.getMap<unknown>('canvas:cv_Ab3dE6gH9jK0:edges');
        nodes.set('b', { shape: 'sticky', text: 'B', x: 1.5, y: 2, z: 2 });
        nodes.set('a', { id: 'ignored', text: 'A', x: 0, y: 0, w: 100, h: 50, z: 1, color: 'blue', size: 's' });
        nodes.set('junk', 'not a record');
        edges.set('e10', { from: 'a', to: 'b' });
        edges.set('e2', { from: 'b', to: 'a', label: 'back' });
        edges.set('e3', { from: 'a', to: 'deleted-box' });
        const board = readBoard(ydoc, 'cv_Ab3dE6gH9jK0');
        expect(board.nodes).toEqual([
            { id: 'a', shape: 'rect', text: 'A', x: 0, y: 0, w: 100, h: 50, color: 'blue', z: 1, size: 's' },
            { id: 'b', shape: 'sticky', text: 'B', x: 2, y: 2, w: 200, h: 140, color: 'default', z: 2 },
        ]);
        expect(board.edges.map((e) => e.id)).toEqual(['e2', 'e10']);
    });

    it('canvasTexts: the words of a board for search', () => {
        expect(canvasTexts(parsedBoard(SYSTEM_DESIGN))).toEqual(['Client', 'API gateway', 'Orders\nservice', 'Postgres', 'Kafka', 'Idempotent consumers', 'HTTPS', 'SQL']);
        expect(canvasTexts(null)).toEqual([]);
        expect(coerceBoard('{"nodes": [{"id": "a", "text": "A"}]}').nodes[0]!.text).toBe('A');
    });
});

// ─── Absorb and inject ─────────────────────────────────────────────────

describe('absorb (takeCanvasData) and inject (withCanvasData)', () => {
    const boardA = normalizeBoard({ nodes: [{ id: 'a', text: 'A' }] });
    const boardB = normalizeBoard({ nodes: [{ id: 'b', text: 'B' }] });

    it('takes data out, gives a canvas without an id a fresh one, and returns its board to write', () => {
        const json: JSONContent = { type: 'doc', content: [para('x'), canvasBlock(null, boardA)] };
        const { json: out, boards, kept } = takeCanvasData(json);
        const attrs = out.content![1]!.attrs!;
        expect(isCanvasId(attrs['canvasId'])).toBe(true);
        expect(attrs['data']).toBeNull();
        expect(attrs['height']).toBe(440);
        expect([...boards]).toEqual([[attrs['canvasId'], boardA]]);
        expect(kept).toEqual([]);
        expect(json.content![1]!.attrs!['data']).toBe(boardA); // the input is not changed
    });

    it('a repeated id is a copy: a fresh id, and its data or (without data) a copy of the first board', () => {
        const id = 'cv_Ab3dE6gH9jK0';
        const json: JSONContent = { type: 'doc', content: [canvasBlock(id, boardA), canvasBlock(id, null), canvasBlock(id, boardB)] };
        const { json: out, boards } = takeCanvasData(json);
        const ids = out.content!.map((b) => b.attrs!['canvasId'] as string);
        expect(ids[0]).toBe(id);
        expect(new Set(ids).size).toBe(3);
        expect(boards.get(id)).toEqual(boardA);
        expect(boards.get(ids[1]!)).toEqual(boardA);
        expect(boards.get(ids[1]!)).not.toBe(boardA);
        expect(boards.get(ids[2]!)).toEqual(boardB);
    });

    it('the target doc wins: data never overwrites a board it already has; its shown ids make copies', () => {
        const id = 'cv_Ab3dE6gH9jK0';
        const existing = (canvasId: string) => (canvasId === id ? boardB : null);
        const kept = takeCanvasData({ type: 'doc', content: [canvasBlock(id, boardA)] }, { existing });
        expect(kept.boards.size).toBe(0);
        expect(kept.kept).toEqual([id]);

        const copied = takeCanvasData({ type: 'doc', content: [canvasBlock(id)] }, { existing, seen: [id] });
        const newId = copied.json.content![0]!.attrs!['canvasId'] as string;
        expect(newId).not.toBe(id);
        expect(copied.boards.get(newId)).toEqual(boardB);
    });

    it('content without canvases comes back as it is; data that is no board is a 400', () => {
        const json: JSONContent = { type: 'doc', content: [para('plain')] };
        expect(takeCanvasData(json).json).toBe(json);
        expect(error400(() => takeCanvasData({ type: 'doc', content: [canvasBlock(null, { nodes: 'x' })] }))).toMatch(/"nodes" array/);
    });

    it('docJsonToYjsState: the board goes into the maps, never into the fragment; reading injects it back', () => {
        const state = docJsonToYjsState({ type: 'doc', content: [para('before'), canvasBlock(null, boardA)] });
        const ydoc = ydocOf(state);
        const element = ydoc.getXmlFragment('default').get(1) as Y.XmlElement;
        expect(element.nodeName).toBe('canvas');
        const id = element.getAttribute('canvasId') as string;
        expect(isCanvasId(id)).toBe(true);
        expect(element.getAttributes()).toEqual({ canvasId: id, height: 440 });
        expect(readBoard(ydoc, id)).toEqual(boardA);

        const back = yjsStateToDocJson(state).content[1] as JSONContent;
        expect(back).toEqual({ type: 'canvas', attrs: { canvasId: id, height: 440, data: boardA } });
        // withCanvasData on the fragment JSON does the same; a canvas whose maps are empty gets an empty board.
        expect(withCanvasData({ type: 'doc', content: [canvasBlock(id), canvasBlock('cv_000000000000')] }, ydoc).content!.map((b) => b.attrs!['data'])).toEqual([
            boardA,
            { nodes: [], edges: [] },
        ]);
        ydoc.destroy();
    });

    it('saved JSON whose canvas data is no board is a 400 "Invalid doc content"', () => {
        expect(error400(() => docJsonToYjsState({ type: 'doc', content: [canvasBlock(null, { nodes: [{ id: 'a' }, { id: 'a' }] })] }))).toMatch(
            /^Invalid doc content: Two nodes have the id "a"/
        );
    });

    it('two canvases with one id in saved JSON (a duplicated block) become two boards', () => {
        const id = 'cv_Ab3dE6gH9jK0';
        const back = yjsStateToDocJson(docJsonToYjsState({ type: 'doc', content: [canvasBlock(id, boardA), canvasBlock(id)] })).content as JSONContent[];
        expect(back[0]!.attrs!['canvasId']).toBe(id);
        expect(back[1]!.attrs!['canvasId']).not.toBe(id);
        expect(back.map((b) => b.attrs!['data'])).toEqual([boardA, boardA]);
    });

    it('canvasesFrom (a REST save): boards of canvases still in the content carry over, as stored; data does not overwrite them', () => {
        const kept = 'cv_keepKeepKeep';
        const gone = 'cv_goneGoneGone';
        const old = new Y.Doc();
        writeBoard(old, kept, boardA);
        writeBoard(old, gone, boardB);
        old.getMap<unknown>(`canvas:${kept}:nodes`).set('extra', { id: 'extra', text: 'from a newer browser', futureField: 1 });
        const previous = Buffer.from(Y.encodeStateAsUpdate(old)).toString('base64');

        const state = docJsonToYjsState({ type: 'doc', content: [canvasBlock(kept, boardB), para('x')] }, undefined, { canvasesFrom: previous });
        const ydoc = ydocOf(state);
        expect(readBoard(ydoc, kept).nodes.map((n) => n.id)).toEqual(['a', 'extra']);
        expect(ydoc.getMap(`canvas:${kept}:nodes`).get('extra')).toEqual({ id: 'extra', text: 'from a newer browser', futureField: 1 });
        expect(canvasRootNames(ydoc).some((name) => name.includes(gone))).toBe(false);
        ydoc.destroy();
        old.destroy();
    });
});

// ─── Undo scope ────────────────────────────────────────────────────────

describe('canvasRootsTouched', () => {
    it('lists the canvas maps an update adds to, overwrites or deletes from', () => {
        const ydoc = new Y.Doc();
        writeBoard(ydoc, 'cv_Ab3dE6gH9jK0', normalizeBoard({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] }));
        const before = Y.encodeStateAsUpdate(ydoc);
        const capture = (mutate: () => void) => {
            const updates: Uint8Array[] = [];
            const collect = (u: Uint8Array) => updates.push(u);
            ydoc.on('update', collect);
            ydoc.transact(mutate);
            ydoc.off('update', collect);
            return Y.mergeUpdates(updates);
        };
        const nodesMap = ydoc.getMap<unknown>('canvas:cv_Ab3dE6gH9jK0:nodes');
        const overwrite = capture(() => nodesMap.set('a', { id: 'a', text: 'moved', x: 50 }));
        expect(canvasRootsTouched(before, overwrite)).toEqual(['canvas:cv_Ab3dE6gH9jK0:nodes']);

        const afterOverwrite = Y.encodeStateAsUpdate(ydoc);
        const removal = capture(() => ydoc.getMap('canvas:cv_Ab3dE6gH9jK0:edges').delete('e1'));
        expect(canvasRootsTouched(afterOverwrite, removal)).toEqual(['canvas:cv_Ab3dE6gH9jK0:edges']);

        const afterRemoval = Y.encodeStateAsUpdate(ydoc);
        const both = capture(() => {
            ydoc.getXmlFragment('default').insert(0, [new Y.XmlText('x')]);
            writeBoard(ydoc, 'cv_newNewNewNew', normalizeBoard({ nodes: [{ id: 'n' }] }));
        });
        // Not the fragment, and not the new board's edges map (it stayed empty).
        expect(canvasRootsTouched(afterRemoval, both)).toEqual(['canvas:cv_newNewNewNew:nodes']);
        ydoc.destroy();
    });
});
