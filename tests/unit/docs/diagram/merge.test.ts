// Edits that keep Ramin's arrangement (src/services/docs/diagram/merge.ts, update.ts, edit.ts):
// boxes that stay keep their place, new boxes go beside what they connect to without overlapping
// anything, zones grow, arrows keep their ids and (while their ends stay) their routes.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { absoluteBoxes, readBoard, writeBoard, writeBoardDiff, type Board, type NodeRecord, type Rect } from '../../../../src/services/docs/canvas';
import { applyBoardEdits, editedDiagramText, renumberAddError } from '../../../../src/services/docs/diagram/edit';
import { layoutDiagram } from '../../../../src/services/docs/diagram/layout';
import { mergeBoards } from '../../../../src/services/docs/diagram/merge';
import { parseDiagram } from '../../../../src/services/docs/diagram/parse';
import { printDiagram } from '../../../../src/services/docs/diagram/print';
import ErrorResponse from '../../../../src/utils/errorResponse';

const laid = async (text: string) => (await layoutDiagram(parseDiagram(text))).board;
/** The board after the text is edited the way an agent edits a printed fence. */
async function edited(old: Board, extra: string, direction: 'LR' | 'TB' = 'LR') {
    const next = await laid(`${printDiagram(old)}\n${extra}`);
    return mergeBoards(old, next, direction);
}
/** Ramin moves a box (and the browser drops the routes of its arrows). */
function move(board: Board, id: string, dx: number, dy: number): Board {
    return {
        nodes: board.nodes.map((n) => (n.id === id ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
        edges: board.edges.map((e) => {
            if (e.from !== id && e.to !== id) return e;
            const { route: _route, ...rest } = e;
            return rest;
        }),
    };
}
const near = (a: Rect, b: Rect, clear: number) => a.x < b.x + b.w + clear && b.x < a.x + a.w + clear && a.y < b.y + b.h + clear && b.y < a.y + a.h + clear;
/** Pairs of boxes (not zones) closer than `clear` where at least one is new. */
function crowded(board: Board, placed: readonly string[], clear = 15.5): string[] {
    const abs = absoluteBoxes(board.nodes);
    const boxes = board.nodes.filter((n) => n.shape !== 'zone');
    const out: string[] = [];
    for (const a of boxes) {
        for (const b of boxes) {
            if (a.id >= b.id || (!placed.includes(a.id) && !placed.includes(b.id))) continue;
            if (near(abs.get(a.id)!, abs.get(b.id)!, clear)) out.push(`${a.id}/${b.id}`);
        }
    }
    return out;
}

const BASE = 'flowchart LR\n  user([User]) -->|HTTPS| lb[Load balancer]\n  lb --> api[API]\n  api -->|SQL| db[(Postgres)]';

describe('mergeBoards', () => {
    it("keeps every box Ramin placed exactly where he put it, and puts two new boxes beside what they connect to, clear of everything", async () => {
        let old = await laid(BASE);
        old = move(old, 'db', 0, 240);
        old = move(old, 'lb', 30, -60);
        old = { ...old, nodes: old.nodes.map((n) => (n.id === 'api' ? { ...n, w: 230 } : n)) };
        const { board, kept, placed } = await edited(old, '  api --> cache[(Redis)]\n  cache -.-> replica[(Replica)]');
        expect(kept.sort()).toEqual(['api', 'db', 'lb', 'user']);
        expect(placed.sort()).toEqual(['cache', 'replica']);
        const before = absoluteBoxes(old.nodes);
        const after = absoluteBoxes(board.nodes);
        for (const id of kept) expect(after.get(id), id).toEqual(before.get(id));
        expect(crowded(board, placed)).toEqual([]);
        // Beside api (its arrow neighbour), not somewhere far off.
        const api = after.get('api')!;
        const cache = after.get('cache')!;
        expect(Math.hypot(cache.x - api.x, cache.y - api.y)).toBeLessThan(600);
        expect(board.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['user>lb', 'lb>api', 'api>db', 'api>cache', 'cache>replica']);
    });

    it('removing a box removes its arrows; renaming keeps every place; the text decides labels and lines', async () => {
        const old = await laid(BASE);
        const changed = applyBoardEdits(old, { remove: ['db'], rename: { api: 'API v2' } });
        const { board } = mergeBoards(old, await laid(printDiagram(changed)), 'LR');
        expect(board.nodes.map((n) => n.id)).toEqual(['user', 'lb', 'api']);
        expect(board.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['user>lb', 'lb>api']);
        expect(board.nodes.find((n) => n.id === 'api')!.text).toBe('API v2');
        const before = absoluteBoxes(old.nodes);
        const after = absoluteBoxes(board.nodes);
        for (const id of ['user', 'lb', 'api']) expect(after.get(id)).toEqual(before.get(id));

        // An arrow made dashed with a new label keeps its id: what the text says wins.
        const relabelled = await laid(printDiagram(old).replace('lb --> api', 'lb -.->|gRPC| api'));
        const merged = mergeBoards(old, relabelled, 'LR').board;
        const arrow = merged.edges.find((e) => e.from === 'lb' && e.to === 'api')!;
        expect(arrow).toMatchObject({ id: old.edges.find((e) => e.from === 'lb' && e.to === 'api')!.id, line: 'dashed', label: 'gRPC' });
    });

    it('an arrow keeps its id, path and route while both its ends stay; else the route goes and the path is elbow', async () => {
        let old = await laid(BASE);
        old = { ...old, edges: old.edges.map((e) => (e.from === 'user' ? { ...e, path: 'curved' as const } : e)) };
        old = move(old, 'db', 0, 300);
        const { board } = await edited(old, '  api --> cache[(Redis)]');
        const userLb = board.edges.find((e) => e.from === 'user')!;
        const oldUserLb = old.edges.find((e) => e.from === 'user')!;
        expect(userLb).toEqual(oldUserLb); // same id, path, route
        const apiDb = board.edges.find((e) => e.to === 'db')!;
        expect(apiDb.id).toBe(old.edges.find((e) => e.to === 'db')!.id);
        expect(apiDb.route).toBeUndefined(); // db moved: the browser dropped it, and nothing brings it back
        const apiCache = board.edges.find((e) => e.to === 'cache')!;
        expect(apiCache).toMatchObject({ path: 'elbow' });
        expect(apiCache.route).toBeUndefined(); // one end new, one kept: no route
        // New arrows never take an id the old board used.
        expect(new Set(board.edges.map((e) => e.id)).size).toBe(board.edges.length);
    });

    it('arrows between two new boxes that moved together keep ELK’s route, moved with them', async () => {
        const old = await laid(BASE);
        const { board } = await edited(old, '  q1[[Queue]] --> w1[Worker]');
        const e = board.edges.find((x) => x.from === 'q1')!;
        expect(e.route).toBeDefined();
        const abs = absoluteBoxes(board.nodes);
        const [sx, sy] = e.route!.points[0]!;
        const q1 = abs.get('q1')!;
        expect(sx >= q1.x - 1 && sx <= q1.x + q1.w + 1 && sy >= q1.y - 1 && sy <= q1.y + q1.h + 1).toBe(true);
    });

    it('new boxes with no neighbour go as one block beside the old content: right for LR, below for TB', async () => {
        const old = await laid('flowchart LR\n  a[A] --> b[B]');
        const right = (await edited(old, '  c[C] --> d[D]', 'LR')).board;
        const abs = absoluteBoxes(right.nodes);
        const keptRight = Math.max(abs.get('a')!.x + abs.get('a')!.w, abs.get('b')!.x + abs.get('b')!.w);
        expect(Math.min(abs.get('c')!.x, abs.get('d')!.x)).toBeGreaterThanOrEqual(keptRight + 16);

        const tbOld = await laid('flowchart TB\n  a[A] --> b[B]');
        const below = (await edited(tbOld, '  c[C] --> d[D]', 'TB')).board;
        const tb = absoluteBoxes(below.nodes);
        const keptBottom = Math.max(tb.get('a')!.y + tb.get('a')!.h, tb.get('b')!.y + tb.get('b')!.h);
        expect(Math.min(tb.get('c')!.y, tb.get('d')!.y)).toBeGreaterThanOrEqual(keptBottom + 16);
    });

    it('zones grow to hold a new box (with their padding) and never shrink; a box moved into another zone is placed anew', async () => {
        const old = await laid('flowchart LR\n  subgraph tier [API tier]\n    a1[API 1]\n  end\n  subgraph data [Data]\n    db[(DB)]\n  end\n  lb[LB] --> a1\n  lb --> tier\n  a1 --> db');
        const oldAbs = absoluteBoxes(old.nodes);
        // Reopen the zone to add a box to it.
        const { board, placed } = await edited(old, '  subgraph tier\n    a2[API 2]\n  end\n  lb --> a2');
        const abs = absoluteBoxes(board.nodes);
        const tier = abs.get('tier')!;
        const a2 = abs.get('a2')!;
        expect(placed).toEqual(['a2']);
        expect(a2.x).toBeGreaterThanOrEqual(tier.x + 20);
        expect(a2.y).toBeGreaterThanOrEqual(tier.y + 40);
        expect(a2.x + a2.w).toBeLessThanOrEqual(tier.x + tier.w - 20);
        expect(a2.y + a2.h).toBeLessThanOrEqual(tier.y + tier.h - 20);
        const before = oldAbs.get('tier')!;
        expect(tier.x).toBeLessThanOrEqual(before.x);
        expect(tier.y).toBeLessThanOrEqual(before.y);
        expect(tier.x + tier.w).toBeGreaterThanOrEqual(before.x + before.w);
        expect(tier.y + tier.h).toBeGreaterThanOrEqual(before.y + before.h);
        // The zone changed size, so the arrow into it lost its route; the one into a1 kept it.
        expect(board.edges.find((e) => e.to === 'tier')!.route).toBeUndefined();
        expect(board.edges.find((e) => e.to === 'a1')!.route).toEqual(old.edges.find((e) => e.to === 'a1')!.route);
        // a1 stayed where it was on screen.
        expect(abs.get('a1')).toEqual(oldAbs.get('a1'));

        // Removing a box: the zone keeps its size.
        const shrunk = mergeBoards(old, await laid(printDiagram(applyBoardEdits(old, { remove: ['db'] }))), 'LR').board;
        expect(absoluteBoxes(shrunk.nodes).get('data')).toEqual(oldAbs.get('data'));

        // db moved into the API tier: placed like a new box there.
        const movedIn = printDiagram(old).replace('  subgraph data [Data]\n    db[(DB)]\n  end\n', '').replace('    a1[API 1]\n', '    a1[API 1]\n    db[(DB)]\n');
        const result = mergeBoards(old, await laid(movedIn), 'LR');
        expect(result.placed).toContain('db');
        expect(result.board.nodes.find((n) => n.id === 'db')!.parent).toBe('tier');
    });

    it('with nothing kept, the board is the new layout', async () => {
        const next = await laid('a --> b');
        const { board, kept } = mergeBoards({ nodes: [], edges: [] }, next, 'LR');
        expect(kept).toEqual([]);
        expect(absoluteBoxes(board.nodes)).toEqual(absoluteBoxes(next.nodes));
        expect(board.edges[0]!.route).toEqual(next.edges[0]!.route);
    });
});

describe('update_canvas edits (edit.ts)', () => {
    it('remove takes boxes (with their arrows) and arrows written as in the text; rename sets labels; a zone removed leaves its boxes in place', async () => {
        const old = await laid('flowchart LR\n  subgraph z [Zone]\n    a[A]\n  end\n  a --> b[B]\n  a -->|x| c[C]\n  b --> c');
        const abs = absoluteBoxes(old.nodes);
        const changed = applyBoardEdits(old, { remove: ['z', 'a -->|x| c', 'b'], rename: { c: 'C<br>two lines' } });
        expect(changed.nodes.map((n) => n.id)).toEqual(['a', 'c']);
        expect(changed.edges.map((e) => `${e.from}>${e.to}`)).toEqual([]);
        expect(changed.nodes.find((n) => n.id === 'c')!.text).toBe('C\ntwo lines');
        const a = changed.nodes.find((n) => n.id === 'a')!;
        expect(a.parent).toBeUndefined();
        expect({ x: a.x, y: a.y }).toEqual({ x: abs.get('a')!.x, y: abs.get('a')!.y });
    });

    it('unknown ids and arrows are 400s that list the boxes', async () => {
        const old = await laid('a --> b');
        const err = (edits: Parameters<typeof applyBoardEdits>[1]) => {
            try {
                applyBoardEdits(old, edits);
            } catch (e) {
                expect(e).toBeInstanceOf(ErrorResponse);
                return (e as ErrorResponse).message;
            }
            throw new Error('expected a 400');
        };
        expect(err({ remove: ['zz'] })).toBe('remove: "zz" is neither a box nor an arrow like a --> b. Boxes: a, b');
        expect(err({ remove: ['b --> a'] })).toBe('remove: there is no arrow from "b" to "a"');
        expect(err({ rename: { zz: 'x' } })).toBe('rename: there is no box "zz". Boxes: a, b');
    });

    it('add lines go after the printed board; their errors are numbered from the first added line', async () => {
        const old = await laid('a --> b');
        const { text, addFrom } = editedDiagramText(old, 'cv_Ab3dE6gH9jK0', { add: 'b --> c\nc -> d' });
        expect(text.startsWith('%% id: cv_Ab3dE6gH9jK0\nflowchart LR\n')).toBe(true);
        expect(text.endsWith('\nb --> c\nc -> d')).toBe(true);
        let message = '';
        try {
            parseDiagram(text);
        } catch (e) {
            message = (renumberAddError(e, addFrom) as ErrorResponse).message;
        }
        expect(message).toMatch(/^add line 2: "->" is not an arrow/);
    });
});

describe('writeBoardDiff', () => {
    it('sets only the records that changed, deletes what is gone, and leaves the rest as stored', () => {
        const ydoc = new Y.Doc();
        const id = 'cv_Ab3dE6gH9jK0';
        const node = (over: Partial<NodeRecord> & { id: string }): NodeRecord => ({ shape: 'rect', text: '', x: 0, y: 0, w: 160, h: 64, color: 'default', z: 0, ...over });
        writeBoard(ydoc, id, { nodes: [node({ id: 'a' }), node({ id: 'b', x: 200 }), node({ id: 'c', x: 400 })], edges: [{ id: 'e1', from: 'a', to: 'b', label: '', line: 'solid', arrow: 'end', path: 'straight' }] });
        // A newer browser stored a field we don't know on b.
        ydoc.getMap<Record<string, unknown>>(`canvas:${id}:nodes`).set('b', { ...ydoc.getMap<Record<string, unknown>>(`canvas:${id}:nodes`).get('b')!, future: 1 });
        const changes: string[] = [];
        ydoc.getMap(`canvas:${id}:nodes`).observe((event) => event.changes.keys.forEach((change, key) => changes.push(`${change.action}:${key}`)));
        const counts = writeBoardDiff(ydoc, id, { nodes: [node({ id: 'a', text: 'renamed' }), node({ id: 'b', x: 200 }), node({ id: 'd', x: 600 })], edges: [] });
        expect(counts).toEqual({ set: 2, deleted: 2 });
        expect(changes.sort()).toEqual(['add:d', 'delete:c', 'update:a']);
        expect(ydoc.getMap<Record<string, unknown>>(`canvas:${id}:nodes`).get('b')!['future']).toBe(1);
        expect(readBoard(ydoc, id).edges).toEqual([]);
        ydoc.destroy();
    });
});
