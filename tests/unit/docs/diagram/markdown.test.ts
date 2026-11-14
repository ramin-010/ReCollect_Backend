// The text form inside Markdown (src/services/docs/markdown/docMarkdown.ts + diagram/resolve.ts):
// a ```canvas fence parses into a pending diagram, resolveDiagrams lays it out (board in data,
// fitted height) and reports on it, a pending diagram never reaches a Y.Doc, and docs print
// their canvases in the text form.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { PENDING_DIAGRAM, PendingDiagramError, fittedCanvasHeight, takeCanvasData, type Board } from '../../../../src/services/docs/canvas';
import { docJsonToYjsState, yjsStateToDocJson } from '../../../../src/services/docs/docContent';
import { resolveDiagrams, withCanvasIds } from '../../../../src/services/docs/diagram/resolve';
import { docJsonToMarkdown, markdownToDocJson, yjsStateToMarkdown } from '../../../../src/services/docs/markdown/docMarkdown';
import ErrorResponse from '../../../../src/utils/errorResponse';
import { boardProblems } from './boardChecks';

const fixture = (name: string) => readFileSync(path.join(__dirname, '../../../fixtures/diagrams', `${name}.txt`), 'utf8');
const fence = (body: string) => `\`\`\`canvas\n${body}\n\`\`\``;
const canvases = (json: JSONContent) => (json.content ?? []).filter((b) => b.type === 'canvas');

describe('a ```canvas fence in the text form', () => {
    it('parses into a pending diagram; resolveDiagrams lays it out: the board in data, the height that fits it', async () => {
        const json = markdownToDocJson(`## Design\n\n${fence(fixture('url-shortener'))}\n\nAfter.`);
        const [canvas] = canvases(json);
        expect(canvas!.attrs).toMatchObject({ canvasId: null, height: 440 });
        expect(canvas!.attrs!['data']).toHaveProperty(PENDING_DIAGRAM);

        const reports = await resolveDiagrams(json);
        const board = canvas!.attrs!['data'] as Board;
        expect(boardProblems(board)).toEqual([]);
        expect(canvas!.attrs!['height']).toBe(fittedCanvasHeight(board));
        expect(reports).toHaveLength(1);
        // Boxes: every node but zones (the note counts).
        expect(reports[0]).toMatchObject({ canvasId: null, boxes: 9, arrows: 9, zones: 1, width: expect.any(Number), height: expect.any(Number), zoom: expect.any(Number) });
        expect(reports[0]!.zoom).toBeGreaterThan(0);
        expect(reports[0]!.zoom).toBeLessThanOrEqual(1);
    });

    it('%% height keeps the height asked for; the zoom is worked out for it', async () => {
        const json = markdownToDocJson(fence('%% height: 300\nflowchart TB\na --> b --> c --> d --> e'));
        const [report] = await resolveDiagrams(json);
        expect(canvases(json)[0]!.attrs!['height']).toBe(300);
        expect(report!.zoom).toBeLessThan(0.6);
        expect(report!.warnings.some((w) => w.startsWith('shows at'))).toBe(true);
    });

    it('a fence the parser can not read is a 400 naming its line, not "Could not read the Markdown"', () => {
        try {
            markdownToDocJson(`Intro\n\n${fence('flowchart LR\na -> b')}`);
            throw new Error('expected a 400');
        } catch (err) {
            expect(err).toBeInstanceOf(ErrorResponse);
            expect((err as ErrorResponse).message).toMatch(/^line 2: "->" is not an arrow/);
        }
    });

    it('a pending diagram never reaches a Y.Doc: absorbing one throws loudly (not a 400)', () => {
        const json = markdownToDocJson(fence('a --> b'));
        expect(() => docJsonToYjsState(json)).toThrow(PendingDiagramError);
        expect(() => takeCanvasData(json)).toThrow(PendingDiagramError);
        try {
            docJsonToYjsState(json);
        } catch (err) {
            expect(err).not.toBeInstanceOf(ErrorResponse);
        }
    });

    it('several canvases, text and JSON, are reported in document order; JSON boards keep their positions', async () => {
        const json = markdownToDocJson(
            [fence('a[A] --> b[B]'), 'Between.', fence('{"nodes": [{"id": "x", "x": 10, "y": 20}, {"id": "y", "x": 400, "y": 20}], "edges": [{"from": "x", "to": "y"}]}')].join('\n\n')
        );
        const reports = await resolveDiagrams(json);
        expect(reports.map((r) => [r.boxes, r.arrows])).toEqual([
            [2, 1],
            [2, 1],
        ]);
        expect((canvases(json)[1]!.attrs!['data'] as Board).nodes[0]).toMatchObject({ x: 10, y: 20 });
        expect(withCanvasIds(reports, ['cv_Ab3dE6gH9jK0']).map((r) => r.canvasId)).toEqual(['cv_Ab3dE6gH9jK0', null]);
        expect(await resolveDiagrams(markdownToDocJson('No canvas here.'))).toEqual([]);
    });
});

describe('docs print canvases in the text form', () => {
    it('stored, read back and printed: %% id first, then the diagram; it reads back as the same board', async () => {
        const json = markdownToDocJson(`## Chat\n\n${fence(fixture('chat-system'))}`);
        await resolveDiagrams(json);
        const state = docJsonToYjsState(json);
        const stored = yjsStateToDocJson(state).content as JSONContent[];
        const canvasId = stored[1]!.attrs!['canvasId'] as string;
        const markdown = yjsStateToMarkdown(state);
        expect(markdown.startsWith(`## Chat\n\n\`\`\`canvas\n%% id: ${canvasId}\nflowchart TB\n  web([Web app])@{ kind: client }\n`)).toBe(true);
        // A zone's block goes where its first box came in the text.
        expect(markdown).toContain('  lb[Load balancer]@{ kind: lb }\n  subgraph edge [Edge]\n    gw[API gateway]@{ kind: gateway }\n    auth[Auth service]@{ kind: auth }\n  end\n  subgraph core [Chat core]\n    subgraph realtime [Realtime]:::blue\n');
        expect(markdown).toContain('  note note1 for msgs: Partitioned by conversation id');
        expect(markdown).not.toContain('"x"');

        // Read back, it lays out the same: same order, same board.
        const again = markdownToDocJson(markdown);
        await resolveDiagrams(again);
        const before = stored[1]!.attrs!['data'] as Board;
        const after = canvases(again)[0]!.attrs!['data'] as Board;
        expect(after.nodes).toEqual(before.nodes);
        expect(after.edges.map((e) => e.route)).toEqual(before.edges.map((e) => e.route));
        // docJsonToMarkdown prints the same from the editor's JSON with the board injected.
        expect(docJsonToMarkdown(yjsStateToDocJson(state))).toBe(markdown);
    }, 30_000);
});
