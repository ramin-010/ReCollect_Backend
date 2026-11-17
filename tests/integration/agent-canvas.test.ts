// Canvas boards by id (AGENT_DIAGRAMS_PLAN steps 2–3): an edited fence through replace_section and
// update_canvas keep what the user arranged and give the same board; Undo restores it exactly; the
// agent can see a board (preview); "Tidy up" and "Save as" (/api/canvas) for the browser.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('upfly', async () => (await import('../helpers/uploads')).createUpflyMock());
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));

import { prisma } from '../../src/db/prisma';
import { absoluteBoxes, canvasMapNames, readBoard, type Board, type NodeRecord } from '../../src/services/docs/canvas';
import { withLiveDoc } from '../../src/services/agent/liveDoc';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

const BASE = ['flowchart LR', '  user([User]) -->|HTTPS| lb[Load balancer]', '  lb --> api[API]', '  api -->|SQL| db[(Postgres)]'].join('\n');
const fence = (body: string) => `\`\`\`canvas\n${body}\n\`\`\``;
const fenceOf = (md: string) => md.slice(md.indexOf('```canvas'), md.indexOf('\n```', md.indexOf('```canvas')) + 4);
const idOf = (md: string) => /%% id: (cv_[A-Za-z0-9_-]{12})/.exec(md)![1]!;

async function agentFor(user: { id: string }, scopes?: Parameters<typeof createTestToken>[1]) {
    const { token } = await createTestToken(user, scopes);
    return asAgent(token, 'Claude Code');
}

/** The board of a canvas as stored (the live doc is unloaded after every agent call). */
async function storedBoard(docId: string, canvasId: string): Promise<{ board: Board; height: unknown }> {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, row.yjsState!);
    const element = ydoc
        .getXmlFragment('default')
        .toArray()
        .find((el) => el instanceof Y.XmlElement && el.getAttribute('canvasId') === canvasId) as Y.XmlElement | undefined;
    const out = { board: readBoard(ydoc, canvasId), height: element?.getAttribute('height') };
    ydoc.destroy();
    return out;
}

/** The user drags boxes in the browser: the records change, and the routes of their arrows go. */
async function ramMoves(docId: string, canvasId: string, moves: Record<string, [number, number]>) {
    await withLiveDoc(docId, 'Alex', (live) =>
        live.apply(() => {
            const names = canvasMapNames(canvasId);
            const nodes = live.doc.getMap<NodeRecord>(names.nodes);
            const edges = live.doc.getMap<Record<string, unknown>>(names.edges);
            for (const [id, [dx, dy]] of Object.entries(moves)) {
                const n = nodes.get(id)!;
                nodes.set(id, { ...n, x: n.x + dx, y: n.y + dy });
                for (const [key, e] of edges) {
                    if (e['from'] !== id && e['to'] !== id) continue;
                    const { route: _route, ...rest } = e;
                    edges.set(key, rest);
                }
            }
        })
    );
}

/** A doc made by the agent with BASE as its canvas; the canvas id and the read text. */
async function docWithBoard(user: { id: string }, agent: Awaited<ReturnType<typeof agentFor>>) {
    const res = await agent.post('/api/agent/docs', { title: 'Request path', markdown: `## Diagram\n\n${fence(BASE)}\n\n## Next\n\nkeep` });
    expect(res.status).toBe(201);
    const docId = res.body.data.id as string;
    const canvasId = res.body.data.canvases[0].canvasId as string;
    return { docId, canvasId };
}

const readText = async (agent: Awaited<ReturnType<typeof agentFor>>, docId: string) => (await agent.get(`/api/agent/docs/${docId}`)).body.data.markdown as string;
const ADDED = '  api --> cache[(Redis)]\n  cache -.-> replica[(Replica)]';

describe('an edited fence keeps what the user arranged (step 2)', () => {
    it('replace_section with the fence it read: same canvas id, his moves kept, two new boxes placed; Undo restores the board exactly', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const { docId, canvasId } = await docWithBoard(user, agent);
        await ramMoves(docId, canvasId, { db: [0, 260], lb: [20, -70] });
        const before = await storedBoard(docId, canvasId);
        const beforeMarkdown = await readText(agent, docId);

        const edited = fenceOf(beforeMarkdown).replace('\n```', `\n${ADDED}\n\`\`\``);
        expect(idOf(edited)).toBe(canvasId);
        const res = await agent.post(`/api/agent/docs/${docId}/replace-section`, { heading: 'Diagram', markdown: edited });
        expect(res.status).toBe(200);
        expect(res.body.data.canvases).toEqual([expect.objectContaining({ canvasId, boxes: 6, arrows: 5 })]);

        const after = await storedBoard(docId, canvasId);
        const was = absoluteBoxes(before.board.nodes);
        const now = absoluteBoxes(after.board.nodes);
        for (const id of ['user', 'lb', 'api', 'db']) expect(now.get(id), id).toEqual(was.get(id));
        expect(after.board.nodes.map((n) => n.id).sort()).toEqual(['api', 'cache', 'db', 'lb', 'replica', 'user']);
        expect(idOf(await readText(agent, docId))).toBe(canvasId);
        expect((await readText(agent, docId)).endsWith('## Next\n\nkeep')).toBe(true);

        expect((await api(user).post(`/api/agent/edits/${res.body.data.editId}/undo`)).status).toBe(200);
        expect(await storedBoard(docId, canvasId)).toEqual(before);
        expect(await readText(agent, docId)).toBe(beforeMarkdown);
    });

    it('a fence naming a board elsewhere in the doc (or written by append) is a new canvas, as before', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const { docId, canvasId } = await docWithBoard(user, agent);
        const text = fenceOf(await readText(agent, docId));
        const res = await agent.post(`/api/agent/docs/${docId}/replace-section`, { heading: 'Next', markdown: text });
        expect(res.body.data.canvases[0].canvasId).not.toBe(canvasId);
        const appended = await agent.post(`/api/agent/docs/${docId}/append`, { markdown: text });
        expect(appended.body.data.canvases[0].canvasId).not.toBe(canvasId);
        expect((await storedBoard(docId, canvasId)).board.nodes).toHaveLength(4);
    });

    it('update_canvas with the same text gives the same board as replace_section', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const a = await docWithBoard(user, agent);
        const b = await docWithBoard(user, agent);
        for (const d of [a, b]) await ramMoves(d.docId, d.canvasId, { db: [0, 260] });

        const textA = fenceOf(await readText(agent, a.docId)).replace('\n```', `\n${ADDED}\n\`\`\``);
        expect((await agent.post(`/api/agent/docs/${a.docId}/replace-section`, { heading: 'Diagram', markdown: textA })).status).toBe(200);
        const diagram = fenceOf(await readText(agent, b.docId)).replace(/^```canvas\n|\n```$/g, '').concat(`\n${ADDED}`);
        const res = await agent.post(`/api/agent/docs/${b.docId}/canvas/${b.canvasId}`, { diagram });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ id: b.docId, canvasId: b.canvasId, editId: expect.any(String), canvases: [expect.objectContaining({ canvasId: b.canvasId, boxes: 6 })] });
        expect(await storedBoard(b.docId, b.canvasId)).toEqual(await storedBoard(a.docId, a.canvasId));
    });

    it('update_canvas with relayout: a new direction is laid out fresh (the user’s moves give way), the same as a new board of that text', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const { docId, canvasId } = await docWithBoard(user, agent);
        await ramMoves(docId, canvasId, { db: [0, 260] });
        const tb = fenceOf(await readText(agent, docId)).replace(/^```canvas\n|\n```$/g, '').replace('flowchart LR', 'flowchart TB');

        // Without relayout the boxes stay where they are, so a new direction changes nothing on screen.
        const kept = await agent.post(`/api/agent/docs/${docId}/canvas/${canvasId}`, { diagram: tb });
        expect(kept.status).toBe(200);
        const before = (await storedBoard(docId, canvasId)).board;

        const res = await agent.post(`/api/agent/docs/${docId}/canvas/${canvasId}`, { diagram: tb, relayout: true });
        expect(res.status).toBe(200);
        const after = (await storedBoard(docId, canvasId)).board;
        const y = (b: Board, id: string) => b.nodes.find((n) => n.id === id)!.y;
        // Top to bottom now: every arrow points down, and the moved db left its dragged spot.
        for (const e of after.edges) expect(y(after, e.to), `${e.from} → ${e.to}`).toBeGreaterThan(y(after, e.from));
        expect(after.nodes.find((n) => n.id === 'db')).not.toEqual(before.nodes.find((n) => n.id === 'db'));
        // The same board a new canvas of that text gets.
        const fresh = await agent.post('/api/agent/docs', { title: 'Fresh', markdown: fence(tb.replace(/^%% id: .*\n/m, '')) });
        const freshBoard = (await storedBoard(fresh.body.data.id, fresh.body.data.canvases[0].canvasId)).board;
        expect(after.nodes.map(({ id, x, y: top }) => [id, x, top])).toEqual(freshBoard.nodes.map(({ id, x, y: top }) => [id, x, top]));
    });

    it('update_canvas add / remove / rename: arrows of a removed box go, a renamed box stays put, nothing of the user’s moves; Undo restores it all', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const { docId, canvasId } = await docWithBoard(user, agent);
        await ramMoves(docId, canvasId, { api: [10, 90] });
        const before = await storedBoard(docId, canvasId);

        const res = await agent.post(`/api/agent/docs/${docId}/canvas/${canvasId}`, {
            add: 'api --> q[[Jobs]]@{ kind: queue }\nq --> w[Worker]',
            remove: ['db'],
            rename: { lb: 'L7 load balancer' },
        });
        expect(res.status).toBe(200);
        const after = (await storedBoard(docId, canvasId)).board;
        expect(after.nodes.map((n) => n.id).sort()).toEqual(['api', 'lb', 'q', 'user', 'w']);
        expect(after.edges.some((e) => e.to === 'db' || e.from === 'db')).toBe(false);
        expect(after.nodes.find((n) => n.id === 'lb')!.text).toBe('L7 load balancer');
        const was = absoluteBoxes(before.board.nodes);
        const now = absoluteBoxes(after.nodes);
        for (const id of ['user', 'lb', 'api']) expect(now.get(id), id).toEqual(was.get(id));
        expect(after.nodes.find((n) => n.id === 'q')).toMatchObject({ shape: 'queue', kind: 'queue' });

        expect((await api(user).post(`/api/agent/edits/${res.body.data.editId}/undo`)).status).toBe(200);
        expect(await storedBoard(docId, canvasId)).toEqual(before);
        const edit = await prisma.agentEdit.findUniqueOrThrow({ where: { id: res.body.data.editId } });
        expect(edit).toMatchObject({ kind: 'doc_canvas_update', summary: 'Updated a canvas in "Request path"' });
    });

    it('update_canvas refuses what it can not do, with reasons; a change that changes nothing logs nothing', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const { docId, canvasId } = await docWithBoard(user, agent);
        const post = (body: object, id = canvasId) => agent.post(`/api/agent/docs/${docId}/canvas/${id}`, body);

        const unknown = await post({ add: 'a --> b' }, 'cv_000000000000');
        expect(unknown.status).toBe(404);
        expect(unknown.body.message).toBe(`There is no canvas cv_000000000000 in this doc. Its canvases: ${canvasId}.`);
        expect((await post({ add: 'x' }, 'bad-id')).body.message).toMatch(/^canvasId: |must be a canvas id/);
        expect((await post({})).body.message).toBe('Send diagram (the whole new text), or add, remove or rename');
        expect((await post({ diagram: 'a --> b', add: 'c' })).body.message).toBe('Send diagram on its own, or add / remove / rename without it');
        const badAdd = await post({ add: 'api --> cache\ncache -> x' });
        expect(badAdd.status).toBe(400);
        expect(badAdd.body.message).toMatch(/^add line 2: "->" is not an arrow/);
        expect((await post({ remove: ['nope'] })).body.message).toMatch(/^remove: "nope" is neither a box nor an arrow/);
        expect((await post({ diagram: '%% id: cv_Zz3dE6gH9jK1\na --> b' })).body.message).toMatch(/^The diagram says %% id: cv_Zz3dE6gH9jK1, but this updates /);

        const same = await post({ diagram: fenceOf(await readText(agent, docId)).replace(/^```canvas\n|\n```$/g, '') });
        expect(same.status).toBe(200);
        expect(same.body.data.editId).toBeNull();

        const viewer = await createTestUser();
        await prisma.docCollaborator.create({ data: { docId, userId: viewer.id, role: 'viewer' } });
        expect((await (await agentFor(viewer)).post(`/api/agent/docs/${docId}/canvas/${canvasId}`, { add: 'a' })).status).toBe(403);
        expect((await (await agentFor(user, ['read'])).post(`/api/agent/docs/${docId}/canvas/${canvasId}`, { add: 'a' })).status).toBe(403);
    });
});

describe('the agent can look (step 3)', () => {
    it('preview: the first canvas (or one by id) as a PNG at 2×, with its report', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user, ['read', 'docs:write']);
        const { docId, canvasId } = await docWithBoard(user, agent);
        for (const query of ['', `?canvasId=${canvasId}&theme=dark`]) {
            const res = await agent.get(`/api/agent/docs/${docId}/preview${query}`);
            expect(res.status).toBe(200);
            const png = Buffer.from(res.body.data.png, 'base64');
            expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
            expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([res.body.data.width, res.body.data.height]);
            expect(res.body.data).toMatchObject({ canvasId, report: { canvasId, boxes: 4, arrows: 3 } });
        }
        expect((await agent.get(`/api/agent/docs/${docId}/preview?canvasId=cv_000000000000`)).status).toBe(404);

        const mermaid = await agent.post('/api/agent/docs', { title: 'Flows', markdown: '```mermaid\nsequenceDiagram\n  A->>B: hi\n```' });
        const none = await agent.get(`/api/agent/docs/${mermaid.body.data.id}/preview`);
        expect(none.status).toBe(404);
        expect(none.body.message).toBe('This doc has no canvas. Its diagram is a Mermaid block: the server does not draw Mermaid yet (the browser does).');
    });
});

describe('/api/canvas (the browser’s Tidy up and Save as)', () => {
    const board = {
        nodes: [
            { id: 'z', shape: 'zone', text: 'Tier', x: 300, y: 0, w: 300, h: 200, color: 'blue', z: 0 },
            { id: 'a', shape: 'rect', text: 'A', x: 20, y: 60, w: 210, h: 90, color: 'default', z: 1, parent: 'z' },
            { id: 'b', shape: 'cylinder', text: 'B', x: 0, y: 400, w: 120, h: 96, color: 'default', z: 2, kind: 'database' },
        ],
        edges: [{ id: 'e_1', from: 'a', to: 'b', label: 'SQL', line: 'solid', arrow: 'end', path: 'curved' }],
    };

    it('layout keeps ids, zones, parents and box sizes; routes and positions are new; a token with read may call it', async () => {
        const user = await createTestUser();
        const res = await api(user).post('/api/canvas/layout', { board, direction: 'TB' });
        expect(res.status).toBe(200);
        const out = res.body.data.board as Board;
        expect(out.nodes.map((n) => [n.id, n.parent ?? null, n.shape === 'zone' ? null : [n.w, n.h]])).toEqual([
            ['z', null, null],
            ['a', 'z', [210, 90]],
            ['b', null, [120, 96]],
        ]);
        expect(out.edges).toEqual([expect.objectContaining({ id: 'e_1', path: 'curved', route: expect.objectContaining({ points: expect.any(Array) }) })]);
        expect(res.body.data.report).toMatchObject({ boxes: 2, arrows: 1, zones: 1 });

        const agent = await agentFor(user, ['read']);
        expect((await agent.post('/api/canvas/layout', { board })).status).toBe(200);
        expect((await api(user).post('/api/canvas/layout', { board: { nodes: [{ id: 'a', parent: 'nope', x: 0, y: 0 }] } })).body.message).toMatch(/has the parent "nope", which is not a node/);
    });

    it('render answers image/svg+xml or image/png; a bad board or format is a 400; no login is a 401', async () => {
        const user = await createTestUser();
        const svg = await api(user).post('/api/canvas/render', { board, format: 'svg', theme: 'dark' });
        expect(svg.status).toBe(200);
        expect(svg.headers['content-type']).toBe('image/svg+xml; charset=utf-8');
        const svgText = Buffer.isBuffer(svg.body) ? svg.body.toString('utf8') : svg.text;
        expect(svgText).toContain('<svg');
        expect(svgText).toContain('>SQL</text>');
        const png = await api(user).post('/api/canvas/render', { board, format: 'png', theme: 'light' }).buffer(true);
        expect(png.headers['content-type']).toBe('image/png');
        expect((png.body as Buffer).subarray(1, 4).toString('ascii')).toBe('PNG');
        expect((await api(user).post('/api/canvas/render', { board, format: 'gif' })).status).toBe(400);
        expect((await api(user).post('/api/canvas/render', { board: { nodes: 'x' }, format: 'svg' })).body.message).toMatch(/needs a "nodes" array/);
        expect((await (await import('supertest')).default((await import('../../src/app')).default).post('/api/canvas/render').send({ board, format: 'svg' })).status).toBe(401);
    });
});
