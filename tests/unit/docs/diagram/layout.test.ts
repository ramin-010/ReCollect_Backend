// ELK layout of the text form (src/services/docs/diagram/layout.ts), on three system-design
// diagrams (tests/fixtures/diagrams): nothing overlaps, zones hold their boxes below their title,
// arrows are right-angled and end on their boxes, labels stay off boxes, and the same text always
// gives the same board.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { absoluteBoxes, docZoom } from '../../../../src/services/docs/canvas';
import { layoutDiagram } from '../../../../src/services/docs/diagram/layout';
import { parseDiagram } from '../../../../src/services/docs/diagram/parse';
import { boardProblems } from './boardChecks';

const fixture = (name: string) => readFileSync(path.join(__dirname, '../../../fixtures/diagrams', `${name}.txt`), 'utf8');
const FIXTURES = ['url-shortener', 'chat-system', 'rate-limiter'] as const;

describe.each(FIXTURES)('fixture %s', (name) => {
    it('lays out with no overlaps, boxes inside their zones below the title, right-angled arrows ending on their boxes, labels off the boxes', async () => {
        const graph = parseDiagram(fixture(name));
        const laid = await layoutDiagram(graph);
        expect(boardProblems(laid.board)).toEqual([]);
        expect(laid.board.nodes.map((n) => n.id).sort()).toEqual(graph.nodes.map((n) => n.id).sort());
        expect(laid.board.edges.map((e) => e.id)).toEqual(graph.edges.map((e) => e.id));
        expect(laid.board.edges.every((e) => e.path === 'elbow')).toBe(true);
        const boxes = [...absoluteBoxes(laid.board.nodes).values()];
        expect(laid.width).toBe(Math.max(...boxes.map((b) => b.x + b.w)));
        expect(laid.height).toBe(Math.max(...boxes.map((b) => b.y + b.h)));
    }, 30_000);

    it('is deterministic: the same text gives the same board', async () => {
        const text = fixture(name);
        const [a, b] = [await layoutDiagram(parseDiagram(text)), await layoutDiagram(parseDiagram(text))];
        expect(b).toEqual(a);
    }, 30_000);
});

describe('layoutDiagram', () => {
    it('keeps the direction it was given; boxes in a zone are placed relative to it', async () => {
        const laid = await layoutDiagram(parseDiagram(fixture('url-shortener')));
        expect(laid.direction).toBe('LR');
        const a1 = laid.board.nodes.find((n) => n.id === 'a1')!;
        const api = laid.board.nodes.find((n) => n.id === 'api')!;
        expect(a1.parent).toBe('api');
        expect(a1.x).toBeGreaterThanOrEqual(0);
        expect(a1.x + a1.w).toBeLessThanOrEqual(api.w);
        // Laid out left to right: the user is left of the queue.
        const boxes = absoluteBoxes(laid.board.nodes);
        expect(boxes.get('user')!.x).toBeLessThan(boxes.get('q')!.x);
    });

    it('without a direction it keeps the one that shows bigger in a doc: a long chain goes top to bottom, a short one left to right', async () => {
        const chain = (n: number) => Array.from({ length: n - 1 }, (_, i) => `s${i} --> s${i + 1}`).join('\n');
        const long = await layoutDiagram(parseDiagram(chain(7)));
        expect(long.direction).toBe('TB');
        const short = await layoutDiagram(parseDiagram(chain(2)));
        expect(short.direction).toBe('LR');
        const forced = await layoutDiagram(parseDiagram(`flowchart LR\n${chain(7)}`));
        expect(forced.direction).toBe('LR');
        expect(docZoom(long.width, long.height, 880)).toBeGreaterThan(docZoom(forced.width, forced.height, 880));
    });

    it('routes end on the drawn outline of a diamond, inside its box', async () => {
        const laid = await layoutDiagram(parseDiagram('flowchart TB\nq{Is it?} -->|yes| a\nq -->|no| b'));
        const q = absoluteBoxes(laid.board.nodes).get('q')!;
        for (const e of laid.board.edges) {
            const [x, y] = e.route!.points[0]!;
            // On the diamond: |dx|/rx + |dy|/ry = 1, within a pixel.
            const d = Math.abs(x - (q.x + q.w / 2)) / (q.w / 2) + Math.abs(y - (q.y + q.h / 2)) / (q.h / 2);
            expect(Math.abs(d - 1)).toBeLessThan(0.03);
        }
        expect(boardProblems(laid.board)).toEqual([]);
    });

    it('self-loops, empty zones and boxes nobody links still lay out cleanly', async () => {
        const laid = await layoutDiagram(parseDiagram('retry --> retry\nsubgraph empty [Empty zone]\nend\nlonely[Alone]\na --> b'));
        expect(boardProblems(laid.board)).toEqual([]);
        expect(laid.board.edges[0]!.route!.points.length).toBeGreaterThan(2);
    });

    it('an empty diagram is an empty board', async () => {
        expect(await layoutDiagram(parseDiagram('flowchart TB'))).toEqual({ board: { nodes: [], edges: [] }, direction: 'TB', width: 0, height: 0 });
    });
});
