// The checks a canvas report carries (src/services/docs/diagram/lint.ts): what a person would
// notice on the board, in a line an agent can act on.
import { describe, expect, it } from 'vitest';
import type { Board, EdgeRecord, NodeRecord } from '../../../../src/services/docs/canvas';
import { lintBoard } from '../../../../src/services/docs/diagram/lint';

const box = (id: string, x: number, y: number, over: Partial<NodeRecord> = {}): NodeRecord => ({ id, shape: 'rect', text: id, x, y, w: 100, h: 50, color: 'default', z: 0, ...over });
const arrow = (from: string, to: string, points?: Array<[number, number]>, over: Partial<EdgeRecord> = {}): EdgeRecord => ({
    id: `${from}-${to}`,
    from,
    to,
    label: '',
    line: 'solid',
    arrow: 'end',
    path: 'elbow',
    ...(points ? { route: { points } } : {}),
    ...over,
});
const lint = (board: Board, frameHeight = 880, extra: { direction?: 'LR' | 'TB'; notes?: string[] } = {}) => lintBoard(board, { frameHeight, ...extra });

describe('lintBoard', () => {
    it('a clean board has nothing to say', () => {
        const board = { nodes: [box('a', 0, 0), box('b', 200, 0)], edges: [arrow('a', 'b', [[100, 25], [200, 25]])] };
        expect(lint(board)).toEqual([]);
    });

    it('arrows that cross: how many, and the pairs by box ids', () => {
        const board = {
            nodes: [box('lb', 0, 100), box('a1', 300, 0), box('cache', 0, 0), box('db', 300, 100)],
            edges: [
                arrow('lb', 'a1', [[100, 125], [200, 125], [200, 25], [300, 25]]),
                arrow('cache', 'db', [[100, 25], [150, 25], [150, 60], [250, 60], [250, 125], [300, 125]]),
            ],
        };
        expect(lint(board)).toEqual(['2 arrows cross (lb→a1 × cache→db)']);
    });

    it('an arrow through a box (its own ends and zones do not count); without a route the straight line is checked', () => {
        const board = { nodes: [box('a', 0, 0), box('mid', 200, 0), box('b', 400, 0)], edges: [arrow('a', 'b')] };
        expect(lint(board)).toEqual(['an arrow runs through a box (a→b through "mid")', 'box "mid" has no arrows']);
    });

    it('boxes that overlap, a box partly over a zone it is not in, a box sticking out of its zone', () => {
        const zone = box('z', 0, 200, { shape: 'zone', w: 300, h: 150 });
        const board = {
            nodes: [zone, box('a', 0, 0), box('b', 50, 20), box('outside', 280, 220), box('inner', 250, 100, { parent: 'z' })],
            edges: [],
        };
        expect(lint(board)).toEqual(['boxes overlap ("outside" overlaps zone "z", "inner" sticks out of zone "z" and "a" over "b")']);
    });

    it('labels over 40 characters, on boxes and arrows (not notes or text)', () => {
        const long = 'x'.repeat(41);
        const board = {
            nodes: [box('a', 0, 0, { text: long }), box('b', 300, 0), box('n', 0, 200, { shape: 'sticky', text: long })],
            edges: [arrow('a', 'b', [[100, 25], [300, 25]], { label: long })],
        };
        expect(lint(board)).toEqual(['2 labels are over 40 characters ("a" and arrow a→b): shorten, or put the detail in a note']);
    });

    it('boxes no arrow reaches, on a board with arrows (an arrow to its zone counts; notes, text and zones never)', () => {
        const board = {
            nodes: [
                box('z', 0, 200, { shape: 'zone', w: 400, h: 200 }),
                box('a', 0, 0),
                box('b', 200, 0),
                box('member', 20, 40, { parent: 'z' }),
                box('alone', 400, 0),
                box('note', 600, 0, { shape: 'sticky' }),
                box('title', 800, 0, { shape: 'text' }),
            ],
            edges: [arrow('a', 'b', [[100, 25], [200, 25]]), arrow('b', 'z', [[250, 50], [250, 200]])],
        };
        expect(lint(board)).toEqual(['box "alone" has no arrows']);
        expect(lint({ nodes: [box('x', 0, 0), box('y', 200, 0)], edges: [] })).toEqual([]);
    });

    it('over 25 boxes', () => {
        const nodes = Array.from({ length: 26 }, (_, i) => box(`b${i}`, (i % 6) * 120, Math.floor(i / 6) * 80));
        const edges = nodes.slice(1).map((n, i) => arrow(nodes[i]!.id, n.id));
        expect(lint({ nodes, edges }).filter((w) => w.startsWith('over'))).toEqual(['over 25 boxes (26): consider splitting it into two canvases']);
    });

    it('shows below 60% in a doc: too wide (and LR) → try TB; too tall → fewer steps in a row', () => {
        const wide = { nodes: [box('a', 0, 0), box('b', 1500, 0)], edges: [arrow('a', 'b', [[100, 25], [1500, 25]])] };
        expect(lint(wide, 280, { direction: 'LR' })).toEqual(['shows at 40% in a doc (too wide): try flowchart TB (on an existing board: update_canvas with relayout: true), or split it']);
        expect(lint(wide, 280)).toEqual(['shows at 40% in a doc (too wide): fewer boxes side by side, or split it']);
        const tall = { nodes: [box('a', 0, 0), box('b', 0, 1800)], edges: [arrow('a', 'b', [[50, 50], [50, 1800]])] };
        expect(lint(tall, 880, { direction: 'TB' })).toEqual(['shows at 40% in a doc (too tall): try flowchart LR (on an existing board: update_canvas with relayout: true), fewer steps in a row, or split it']);
    });

    it('the parser’s notes come last, without their full stop', () => {
        const board = { nodes: [box('a', 0, 0)], edges: [] };
        expect(lint(board, 880, { notes: ['Thick arrows (==>) are drawn as normal arrows.'] })).toEqual(['Thick arrows (==>) are drawn as normal arrows']);
    });
});
