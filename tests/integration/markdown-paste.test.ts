// POST /api/agent/markdown: the editor's Markdown paste (cookie only), 2026-11-14.
import { describe, expect, it } from 'vitest';

import { createTestToken, asAgent } from '../helpers/agent';
import { api, createLearner } from '../helpers/learning';

describe('POST /api/agent/markdown', () => {
    it('turns Markdown into the doc’s blocks, in the agents’ dialect', async () => {
        const user = await createLearner();
        const res = await api(user).post('/api/agent/markdown', { markdown: '## Idea\n\n> [!TIP]\n> Pop while it breaks the order.\n\n1. Put `i` left' });
        expect(res.status).toBe(200);
        const types = res.body.data.content.map((n: { type: string }) => n.type);
        expect(types).toEqual(['heading', 'callout', 'orderedList']);
        expect(JSON.stringify(res.body.data.content[2])).toContain('"type":"code"');
    });

    it('a ```canvas fence comes back as a canvas block WITH its board in attrs.data (the browser absorbs it)', async () => {
        const user = await createLearner();
        const markdown = [
            'Before',
            '',
            '```canvas',
            '{"id": "cv_Ab3dE6gH9jK0", "nodes": [{"id": "api", "text": "API"}, {"id": "db", "text": "Postgres", "shape": "database", "color": "blue"}], "edges": [{"from": "api", "to": "db", "label": "SQL"}]}',
            '```',
        ].join('\n');
        const res = await api(user).post('/api/agent/markdown', { markdown });
        expect(res.status).toBe(200);
        const [, canvas] = res.body.data.content;
        expect(canvas).toEqual({
            type: 'canvas',
            attrs: {
                canvasId: null,
                height: 280, // no "height" in the fence: the height that fits one row of boxes
                data: {
                    nodes: [
                        { id: 'api', shape: 'rect', text: 'API', x: 0, y: 16, w: 160, h: 64, color: 'default', z: 0 },
                        // Each rank is as deep as its own box: 160 + the 80 gap, then the 120-wide cylinder.
                        { id: 'db', shape: 'cylinder', text: 'Postgres', x: 240, y: 0, w: 120, h: 96, color: 'blue', z: 1 },
                    ],
                    edges: [{ id: 'e1', from: 'api', to: 'db', label: 'SQL', line: 'solid', arrow: 'end', path: 'straight' }],
                },
            },
        });

        const bad = await api(user).post('/api/agent/markdown', { markdown: '```canvas\n{"nodes": [{"id": "a"}], "edges": [{"from": "a", "to": "zz"}]}\n```' });
        expect(bad.status).toBe(400);
        expect(bad.body.message).toBe('Edge 1 points at "zz", which is not a node. Node ids: "a".');
    });

    it('a ```canvas fence in the text form comes back laid out: the board (zones, routes) in attrs.data, the fitted height', async () => {
        const user = await createLearner();
        const markdown = '```canvas\nflowchart TB\n  subgraph api [API]\n    a1\n  end\n  user([User]) --> a1 -->|SQL| db[(Postgres)]\n```';
        const res = await api(user).post('/api/agent/markdown', { markdown });
        expect(res.status).toBe(200);
        const [canvas] = res.body.data.content;
        expect(canvas.type).toBe('canvas');
        expect(canvas.attrs.canvasId).toBeNull();
        expect(canvas.attrs.height).toBeGreaterThanOrEqual(280);
        const { nodes, edges } = canvas.attrs.data;
        expect(nodes.map((n: { id: string }) => n.id)).toEqual(['api', 'a1', 'user', 'db']);
        expect(nodes[1]).toMatchObject({ parent: 'api', shape: 'rect' });
        expect(edges.map((e: { route?: { points: unknown[] } }) => e.route?.points.length ?? 0).every((n: number) => n >= 2)).toBe(true);
        expect(edges[1].route.label).toEqual([expect.any(Number), expect.any(Number)]);

        const bad = await api(user).post('/api/agent/markdown', { markdown: '```canvas\nsubgraph x [X]\n  a\n```' });
        expect(bad.status).toBe(400);
        expect(bad.body.message).toBe('line 1: subgraph "x" is not closed: expected "end"');
    });

    it('a ```mermaid block Mermaid cannot parse still pastes as its code block (the browser shows the error; agents get a 400 instead)', async () => {
        const user = await createLearner();
        const markdown = '## Flow\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob\n```';
        const res = await api(user).post('/api/agent/markdown', { markdown });
        expect(res.status).toBe(200);
        expect(res.body.data.content[1]).toMatchObject({ type: 'codeBlock', attrs: { language: 'mermaid' } });
    });

    it('as blocks (the new editor): our blocks, a canvas with a fresh id and its board beside it', async () => {
        const user = await createLearner();
        const markdown = ['## Idea', '', '> [!TIP]', '> Keep it in Redis.', '', '```mermaid', 'flowchart LR', '  A --> B', '```', '', '```canvas', 'flowchart LR', '  a[Client] --> b[Gateway]', '```'].join('\n');
        const res = await api(user).post('/api/agent/markdown', { markdown, as: 'blocks' });
        expect(res.status).toBe(200);
        expect(res.body.data.blocks.map((b: { type: string }) => b.type)).toEqual(['heading', 'callout', 'diagram', 'canvas']);
        const canvasId = res.body.data.blocks[3].props.canvasId as string;
        expect(canvasId).toMatch(/^cv_/);
        expect(Object.keys(res.body.data.boards)).toEqual([canvasId]);
        expect(res.body.data.boards[canvasId].nodes.map((n: { text: string }) => n.text).sort()).toEqual(['Client', 'Gateway']);
    });

    it('refuses access tokens and oversize input', async () => {
        const user = await createLearner();
        const { token } = await createTestToken(user);
        expect((await asAgent(token).post('/api/agent/markdown', { markdown: '# x' })).status).toBe(403);
        expect((await api(user).post('/api/agent/markdown', { markdown: 'x'.repeat(200_001) })).status).toBe(400);
    });
});
