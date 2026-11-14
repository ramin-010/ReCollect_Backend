// Printing a board as the text form (src/services/docs/diagram/print.ts): what read_doc shows, and
// what an agent edits and sends back, so parse(print(board)) must give the same board (all but
// positions, sizes and arrow ids, which the server keeps).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fittedCanvasHeight, type Board, type EdgeRecord, type NodeRecord } from '../../../../src/services/docs/canvas';
import { layoutDiagram } from '../../../../src/services/docs/diagram/layout';
import { parseDiagram } from '../../../../src/services/docs/diagram/parse';
import { boardDirection, printCanvasFence, printDiagram } from '../../../../src/services/docs/diagram/print';

const fixture = (name: string) => readFileSync(path.join(__dirname, '../../../fixtures/diagrams', `${name}.txt`), 'utf8');

/** What the text form keeps: everything but positions, sizes, z and arrow ids. */
function meaning(board: { nodes: ReadonlyArray<Partial<NodeRecord> & { id: string }>; edges: ReadonlyArray<Pick<EdgeRecord, 'from' | 'to' | 'label' | 'line' | 'arrow'>> }) {
    return {
        nodes: board.nodes
            .map((n) => ({ id: n.id, shape: n.shape, text: n.text, color: n.color, kind: n.kind ?? null, size: n.size ?? null, parent: n.parent ?? null }))
            .sort((a, b) => (a.id < b.id ? -1 : 1)),
        edges: board.edges.map((e) => `${e.from} ${e.line}/${e.arrow} [${e.label}] ${e.to}`).sort(),
    };
}

const node = (id: string, over: Partial<NodeRecord> = {}): NodeRecord => ({ id, shape: 'rect', text: id, x: 0, y: 0, w: 160, h: 64, color: 'default', z: 0, ...over });
const edge = (id: string, from: string, to: string, over: Partial<EdgeRecord> = {}): EdgeRecord => ({ id, from, to, label: '', line: 'solid', arrow: 'end', path: 'straight', ...over });

describe('printDiagram', () => {
    it('prints the id, the direction, zones with their boxes, the other boxes, the arrows, then the notes', () => {
        const board: Board = {
            nodes: [
                node('api', { shape: 'zone', text: 'API tier', color: 'blue', x: 300, y: 0, w: 220, h: 200 }),
                node('a1', { text: 'API server 1', parent: 'api', x: 20, y: 40 }),
                node('n2', { shape: 'sticky', text: 'Stateless', parent: 'api', x: 20, y: 120 }),
                node('user', { shape: 'pill', text: 'User', kind: 'user', x: 0, y: 0 }),
                node('db', { shape: 'cylinder', text: 'Postgres\nprimary', kind: 'database', color: 'blue', x: 600, y: 0 }),
                node('q', { shape: 'rect', text: 'Jobs', kind: 'queue', x: 900, y: 0 }),
                node('t', { shape: 'text', text: 'Title', size: 'l', x: 0, y: 300 }),
                node('n1', { shape: 'sticky', text: 'Primary + replicas', x: 600, y: 200 }),
                node('n3', { shape: 'sticky', text: 'Yellow one', color: 'yellow', x: 900, y: 200 }),
            ],
            edges: [
                edge('e1', 'user', 'a1', { label: 'HTTPS' }),
                edge('e2', 'a1', 'db', { line: 'dashed', label: 'write | read' }),
                edge('e3', 'db', 'q', { arrow: 'both' }),
                edge('e4', 'db', 'n1', { line: 'dashed', arrow: 'none' }),
                edge('e5', 'q', 'n3', { line: 'dashed', arrow: 'none' }),
            ],
        };
        expect(printDiagram(board, { canvasId: 'cv_Ab3dE6gH9jK0' })).toBe(
            [
                '%% id: cv_Ab3dE6gH9jK0',
                'flowchart LR',
                '  subgraph api [API tier]:::blue',
                '    a1[API server 1]',
                '    note n2: Stateless',
                '  end',
                '  user([User])@{ kind: user }',
                '  db[(Postgres<br>primary)]@{ kind: database }:::blue',
                '  q[Jobs]@{ kind: queue, shape: rect }',
                '  t[Title]@{ shape: text, size: l }',
                '  n3[Yellow one]@{ shape: sticky }:::yellow',
                '  user -->|HTTPS| a1',
                '  a1 -.->|"write | read"| db',
                '  db <--> q',
                '  q -.- n3',
                '  note n1 for db: Primary + replicas',
            ].join('\n')
        );
    });

    it('quotes text that holds brackets, pipes or quotes (a quote as #quot;), and round-trips it', async () => {
        const texts = ['Load balancer (L7)', 'say "hi"', 'a | b', '[x]', '`code` first', 'semi; colon %% percent', 'naïve ✓ 🚀', ''];
        const board: Board = { nodes: texts.map((text, i) => node(`t${i}`, { text, x: i * 200 })), edges: [edge('e1', 't0', 't1', { label: '"quoted" `label`' })] };
        const printed = printDiagram(board);
        expect(printed).toContain('t0["Load balancer (L7)"]');
        expect(printed).toContain('t1["say #quot;hi#quot;"]');
        expect(printed).toContain('t7[""]');
        expect(printed).toContain('t0 -->|"#quot;quoted#quot; `label`"| t1');
        const back = parseDiagram(printed);
        expect(back.nodes.map((n) => n.text)).toEqual(texts);
        expect(back.edges[0]!.label).toBe('"quoted" `label`');
    });

    it('ids the text form can not write become ones it can (never two alike); arrows follow them', () => {
        const board: Board = { nodes: [node('a--b'), node('a_b'), node('-x-')], edges: [edge('e1', 'a--b', '-x-')] };
        const printed = printDiagram(board);
        expect(printed).toContain('a_b_2[a--b]');
        expect(printed).toContain('x[-x-]');
        expect(printed).toContain('a_b_2 --> x');
        expect(() => parseDiagram(printed)).not.toThrow();
    });

    it('the direction is the way most arrows run; %% height only when the block is not the fitted height', () => {
        const tb: Board = { nodes: [node('a'), node('b', { y: 200 }), node('c', { y: 400 })], edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')] };
        expect(boardDirection(tb)).toBe('TB');
        expect(boardDirection({ ...tb, edges: [edge('e1', 'c', 'b'), edge('e2', 'b', 'a')] })).toBe('BT');
        expect(boardDirection({ nodes: [node('a'), node('b', { x: -400 })], edges: [edge('e1', 'a', 'b')] })).toBe('RL');
        expect(boardDirection({ nodes: [node('a')], edges: [] })).toBe('LR');
        expect(printDiagram(tb, { height: fittedCanvasHeight(tb) })).not.toContain('%% height');
        expect(printDiagram(tb, { height: 600 })).toContain('%% height: 600');
    });

    it('printCanvasFence: a ```canvas fence; an empty board keeps its id', () => {
        expect(printCanvasFence({ canvasId: 'cv_Ab3dE6gH9jK0', height: 440, data: null })).toBe('```canvas\n%% id: cv_Ab3dE6gH9jK0\nflowchart LR\n```');
    });
});

describe.each(['url-shortener', 'chat-system', 'rate-limiter'])('round trip: %s', (name) => {
    it('parse(print(board)) is the same board, and prints the same again', async () => {
        const first = (await layoutDiagram(parseDiagram(fixture(name)))).board;
        const printed = printDiagram(first, { canvasId: 'cv_Ab3dE6gH9jK0' });
        const graph = parseDiagram(printed);
        expect(graph.canvasId).toBe('cv_Ab3dE6gH9jK0');
        expect(meaning(graph)).toEqual(meaning(first));
        const second = (await layoutDiagram(graph)).board;
        expect(meaning(second)).toEqual(meaning(first));
        expect(printDiagram(second, { canvasId: 'cv_Ab3dE6gH9jK0' })).toBe(printed);
    }, 30_000);
});
