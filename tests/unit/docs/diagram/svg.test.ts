// The server's own drawing of a board (src/services/docs/diagram/svg.ts, png.ts) and the stateless
// canvas tools (src/services/docs/canvasTools.service.ts): a well-formed SVG with every label, a
// PNG at twice its size, "Tidy up" that keeps ids and box sizes, and 400s for boards that are none.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { absoluteBoxes, type Board } from '../../../../src/services/docs/canvas';
import { renderBoard, tidyBoard } from '../../../../src/services/docs/canvasTools.service';
import { layoutDiagram } from '../../../../src/services/docs/diagram/layout';
import { parseDiagram } from '../../../../src/services/docs/diagram/parse';
import { svgToPng } from '../../../../src/services/docs/diagram/png';
import { boardToSvg } from '../../../../src/services/docs/diagram/svg';
import ErrorResponse from '../../../../src/utils/errorResponse';

const fixture = (name: string) => readFileSync(path.join(__dirname, '../../../fixtures/diagrams', `${name}.txt`), 'utf8');
const laid = async (text: string) => (await layoutDiagram(parseDiagram(text))).board;
const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// The first drawing loads ELK and resvg cold (about 6 s on a busy machine).
describe('boardToSvg', { timeout: 30_000 }, () => {
    it.each(['url-shortener', 'chat-system', 'rate-limiter'])('%s: a well-formed SVG holding every box, zone and arrow label', async (name) => {
        const board = await laid(fixture(name));
        for (const theme of ['light', 'dark'] as const) {
            const { svg, width, height } = boardToSvg(board, theme);
            expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
            expect(() => new Resvg(svg)).not.toThrow(); // resvg refuses XML that is not well-formed
            expect(svg).toContain(`width="${width}" height="${height}"`);
            const words = [...board.nodes.map((n) => n.text), ...board.edges.map((e) => e.label)].flatMap((t) => t.split(/\s+/)).filter(Boolean);
            for (const word of words) expect(svg, word).toContain(escape(word));
        }
    });

    it('light and dark use the board’s colours; kind icons, notes and dashed arrows are drawn', async () => {
        const board = await laid('flowchart LR\n  web([Web])@{ kind: client } -.->|async| db[(DB)]:::blue\n  note for db: replicas');
        const light = boardToSvg(board, 'light').svg;
        const dark = boardToSvg(board, 'dark').svg;
        expect(light).toContain('fill="#f4f3f2"'); // the board (surface 2)
        expect(dark).toContain('fill="#262626"');
        expect(light).toContain('fill="#e5f2fc"'); // the blue tint
        expect(dark).toContain('fill="#233850"');
        expect(light).toContain('stroke-dasharray="6 5"');
        expect(light).toContain('<rect width="20" height="14" x="2" y="3" rx="2"/>'); // lucide Monitor
        expect(light).toContain('fill="#f9f3dc"'); // the note's yellow
    });

    it('text with markup characters is escaped; a board with nothing on it is a small empty picture', () => {
        const board: Board = { nodes: [{ id: 'a', shape: 'rect', text: '<b>&"x"', x: 0, y: 0, w: 160, h: 64, color: 'default', z: 0 }], edges: [] };
        const { svg } = boardToSvg(board);
        expect(svg).toContain('&lt;b&gt;&amp;&quot;x&quot;');
        expect(() => new Resvg(svg)).not.toThrow();
        const empty = boardToSvg({ nodes: [], edges: [] });
        expect([empty.width, empty.height]).toEqual([48, 48]);
    });
});

describe('svgToPng', () => {
    it('renders at twice the SVG’s size, capped on its longest side', async () => {
        const { svg, width, height } = boardToSvg(await laid(fixture('rate-limiter')));
        const png = svgToPng(svg, width, height);
        expect(pngSize(png.png)).toEqual({ width: 2 * width, height: 2 * height });
        expect([png.width, png.height]).toEqual([2 * width, 2 * height]);
        const capped = svgToPng(svg, width, height, 2, 1000);
        expect(Math.max(pngSize(capped.png).width, pngSize(capped.png).height)).toBeLessThanOrEqual(1001);
    });
});

describe('Tidy up reads the board in its arrows’ order', () => {
    it('a board stored zones-first (the browser’s stacking order) still lays out with every arrow running forward', async () => {
        const board = await laid(fixture('url-shortener').replace(/flowchart LR/, 'flowchart TB'));
        // The browser lists nodes back to front: the zone and its servers first.
        const zonesFirst: Board = {
            nodes: [...board.nodes].sort((a, b) => Number(b.shape === 'zone' || !!b.parent) - Number(a.shape === 'zone' || !!a.parent)),
            edges: [...board.edges].reverse(),
        };
        const tidy = (await tidyBoard(zonesFirst, 'TB')).board;
        const at = absoluteBoxes(tidy.nodes);
        for (const e of tidy.edges) {
            if (tidy.nodes.find((n) => n.id === e.to)?.shape === 'sticky') continue;
            const from = at.get(e.from)!;
            const to = at.get(e.to)!;
            expect(to.y, `${e.from} → ${e.to}`).toBeGreaterThan(from.y);
        }
    });
});

describe('the canvas tools (POST /api/canvas/layout and /render)', () => {
    it('tidyBoard keeps every id, zone, parent and box size, and lays the board out again with routes', async () => {
        const board = await laid(fixture('url-shortener'));
        // As Ramin left it: boxes dragged about, one resized, the routes gone.
        const messy: Board = {
            nodes: board.nodes.map((n, i) => ({ ...n, x: n.x + (i % 3) * 37, y: n.y + (i % 2) * 51, ...(n.id === 'db' ? { w: 260, h: 120 } : {}) })),
            edges: board.edges.map(({ route: _route, ...e }) => ({ ...e, path: 'straight' as const })),
        };
        const { board: tidy, report } = await tidyBoard(messy, 'TB');
        expect(tidy.nodes.map((n) => n.id).sort()).toEqual(messy.nodes.map((n) => n.id).sort());
        expect(tidy.edges.map((e) => e.id)).toEqual(messy.edges.map((e) => e.id));
        for (const n of messy.nodes) {
            const t = tidy.nodes.find((x) => x.id === n.id)!;
            expect(t.parent ?? null).toBe(n.parent ?? null);
            if (n.shape !== 'zone') expect([t.w, t.h >= n.h]).toEqual([n.w, true]);
        }
        expect(tidy.nodes.find((n) => n.id === 'db')).toMatchObject({ w: 260, h: 120 });
        expect(tidy.edges.every((e) => e.route && e.path === 'straight')).toBe(true);
        const abs = absoluteBoxes(tidy.nodes);
        expect(abs.get('user')!.y).toBeLessThan(abs.get('q')!.y); // top to bottom, as asked
        expect(report).toMatchObject({ boxes: 9, arrows: 9, zones: 1 });
    });

    it('renderBoard answers an SVG or a PNG; a board that is none is a 400 that says why', async () => {
        const board = await laid('a --> b');
        const svg = renderBoard(board, 'svg', 'dark');
        expect(svg.contentType).toBe('image/svg+xml; charset=utf-8');
        expect(String(svg.body)).toContain('<svg');
        const png = renderBoard(board, 'png', 'light');
        expect(png.contentType).toBe('image/png');
        expect(pngSize(png.body as Buffer)).toEqual({ width: png.width, height: png.height });

        const bad = (input: unknown) => {
            try {
                renderBoard(input, 'svg', 'light');
            } catch (err) {
                expect(err).toBeInstanceOf(ErrorResponse);
                expect((err as ErrorResponse).statusCode).toBe(400);
                return (err as ErrorResponse).message;
            }
            throw new Error('expected a 400');
        };
        expect(bad('nope')).toBe('board must be an object: { nodes: [...], edges: [...] }');
        expect(bad({ edges: [] })).toMatch(/needs a "nodes" array/);
        expect(bad({ nodes: [{ id: 'a', x: 0, y: 0 }], edges: [{ from: 'a', to: 'zz' }] })).toMatch(/^Edge 1 points at "zz", which is not a node/);
        expect(bad({ nodes: Array.from({ length: 301 }, (_, i) => ({ id: `n${i}`, x: 0, y: 0 })) })).toMatch(/at most 300 nodes; this one has 301/);
        await expect(tidyBoard({ nodes: 'x' })).rejects.toThrow(/needs a "nodes" array/);
    });
});
