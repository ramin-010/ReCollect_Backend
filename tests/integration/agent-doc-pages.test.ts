// DOC_PAGES_PLAN §3.5 (10): pages inside docs through the token API. A page under a lesson has no schedule of its own;
// the tree route answers a whole tree (with every page's Markdown until 60,000 characters, the rest named); a token
// without `read` can't see it; an agent's move is logged and Undo puts the doc back; trash and restore say the pages.
import { describe, expect, it } from 'vitest';
import { api, createLearner, createSubjectRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import { prisma } from '../../src/db/prisma';

async function setup() {
    const user = await createLearner();
    const agent = asAgent((await createTestToken(user)).token, 'Claude');
    const make = async (title: string, markdown: string, parentId?: string) => {
        const res = await agent.post('/api/agent/docs', { title, markdown, ...(parentId ? { parentId } : {}) });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.data.id as string;
    };
    return { user, agent, make };
}

const para = (word: string, n: number, times = 90) => Array.from({ length: n }, (_, i) => `${word} ${i} `.repeat(times).trim()).join('\n\n');

describe('pages inside docs, for agents (DOC_PAGES_PLAN stage 2)', () => {
    it('a page under a lesson takes no subject, topic or schedule of its own', async () => {
        const { user, agent, make } = await setup();
        const s = await createSubjectRow(user.id, 'Databases');
        const lesson = await make('Indexes', 'B-trees.');
        expect((await api(user).post('/api/topics', { docId: lesson, subjectId: s.id, startRevisions: false })).status).toBe(201);
        const refused = await agent.post('/api/agent/docs', { title: 'Practice', markdown: 'Q1', parentId: lesson, subjectId: s.id, revise: true });
        expect(refused.status).toBe(400);
        expect(refused.body.message).toContain('A page inside the lesson "Indexes" is revised with it');
        const made = await agent.post('/api/agent/docs', { title: 'Practice', markdown: 'Q1', parentId: lesson });
        expect(made.body.data.parent).toEqual({ id: lesson, title: 'Indexes' });
        const page = made.body.data.id as string;
        const read = await agent.get(`/api/agent/docs/${page}`);
        expect(read.body.data).toMatchObject({ lesson: { docId: lesson, title: 'Indexes' }, topicId: null, path: [{ id: lesson, title: 'Indexes' }] });
    });

    it('the tree: in tree order, sizes and lessons; with content until 60,000 characters, the rest named; the top level without a doc', async () => {
        const { agent, make } = await setup();
        const a = await make('Course', 'The overview.');
        const b = await make('Part one', para('alpha', 40, 150), a); // about 50,000 characters: with it, part two no longer fits
        const c = await make('Part two', para('beta', 30), a);
        const d = await make('Deep', 'Inside part one.', b);

        const tree = await agent.get(`/api/agent/docs/tree?docId=${a}`);
        expect(tree.status, JSON.stringify(tree.body)).toBe(200);
        const nodes = tree.body.data.nodes as Array<{ id: string; depth: number; pages: number; chars: number; lesson: boolean; markdown?: string }>;
        expect(nodes.map((n) => [n.id, n.depth, n.pages])).toEqual([
            [a, 0, 2],
            [b, 1, 1],
            [d, 2, 0],
            [c, 1, 0],
        ]);
        expect(nodes[1]!.chars).toBeGreaterThan(30_000);
        expect(nodes.every((n) => n.markdown === undefined && n.lesson === false)).toBe(true);
        expect(tree.body.data.root).toMatchObject({ id: a, title: 'Course', path: [] });

        const shallow = await agent.get(`/api/agent/docs/tree?docId=${a}&depth=1`);
        expect((shallow.body.data.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual([a, b, c]);

        const full = await agent.get(`/api/agent/docs/tree?docId=${a}&content=1`);
        const shown = full.body.data.nodes as Array<{ id: string; markdown?: string }>;
        expect(shown[0]!.markdown).toContain('The overview.');
        expect(shown[1]!.markdown).toContain('alpha 0');
        expect(shown[2]!.markdown).toContain('Inside part one.');
        expect(shown[3]!.markdown).toBeUndefined();
        expect((full.body.data.left as Array<{ id: string; title: string }>).map((l) => l.title)).toEqual(['Part two']);

        const top = await agent.get('/api/agent/docs/tree');
        const tops = top.body.data.nodes as Array<{ id: string; pages: number }>;
        expect(tops.map((n) => n.id)).toEqual([a]);
        expect(tops[0]!.pages).toBe(2);
        expect(top.body.data.root).toBeNull();
    });

    it('a token without read gets 403 on the tree', async () => {
        const user = await createLearner();
        const writeOnly = asAgent((await createTestToken(user, ['docs:write'])).token, 'Claude');
        expect((await writeOnly.get('/api/agent/docs/tree')).status).toBe(403);
    });

    it("an agent's move is logged, and Undo puts the doc back where it was", async () => {
        const { user, agent, make } = await setup();
        const a = await make('Course', 'x');
        const b = await make('One', 'x', a);
        const c = await make('Two', 'x', a);
        const moved = await agent.patch(`/api/agent/docs/${b}`, { parentId: null });
        expect(moved.status, JSON.stringify(moved.body)).toBe(200);
        expect(moved.body.data).toMatchObject({ parent: null, changes: ['moved it to the top level'] });
        const edit = await prisma.agentEdit.findUniqueOrThrow({ where: { id: moved.body.data.editId } });
        expect(edit.summary).toBe('Changed "One": moved it to the top level');
        expect((await api(user).post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(200);
        const back = await agent.get(`/api/agent/docs/${a}`);
        expect((back.body.data.pages as Array<{ id: string }>).map((p) => p.id)).toEqual([b, c]);

        const reorder = await agent.patch(`/api/agent/docs/${c}`, { after: 'start' });
        expect(reorder.body.data.changes).toEqual(['moved it to a new place among the pages of "Course"']);
        expect(((await agent.get(`/api/agent/docs/${a}`)).body.data.pages as Array<{ id: string }>).map((p) => p.id)).toEqual([c, b]);
        expect((await agent.patch(`/api/agent/docs/${a}`, { after: 'start' })).status).toBe(400);
    });

    it('the page block (stage 5): the link line places a page; it reads back with the live title; dropping the line keeps the page', async () => {
        const { agent, make } = await setup();
        const a = await make('Course', '## Parts\n\nThe overview.');
        const b = await make('Part one', 'Alpha.', a);
        const appended = await agent.post(`/api/agent/docs/${a}/append`, { markdown: `[Part one](/docs/${b})` });
        expect(appended.status, JSON.stringify(appended.body)).toBe(200);
        const outline = await agent.get(`/api/agent/docs/${a}/outline`);
        expect((outline.body.data.blocks as Array<{ type: string; text: string; props?: { docId?: string } }>).find((x) => x.type === 'page')).toMatchObject({ text: 'Part one', props: { docId: b } });
        await agent.patch(`/api/agent/docs/${b}`, { title: 'Part 1' });
        expect((await agent.get(`/api/agent/docs/${a}`)).body.data.markdown).toContain(`[Part 1](/docs/${b})`);
        const replaced = await agent.post(`/api/agent/docs/${a}/replace-section`, { heading: 'Parts', markdown: 'No links here.' });
        expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
        const read = await agent.get(`/api/agent/docs/${a}`);
        expect(read.body.data.markdown).not.toContain(`/docs/${b}`);
        expect((read.body.data.pages as Array<{ id: string }>).map((p) => p.id)).toEqual([b]);
    });

    it('trash and restore say the pages; search names the docs above a hit', async () => {
        const { agent, make } = await setup();
        const a = await make('Kafka', 'x');
        const b = await make('Partitions', 'How a topic splits into ordered logs.', a);
        await make('Leaders', 'x', b);
        const found = await agent.get('/api/agent/docs?query=ordered%20logs');
        expect((found.body.data as Array<{ id: string; path: string[] }>).find((d) => d.id === b)?.path).toEqual(['Kafka']);
        const trashed = await agent.post(`/api/agent/docs/${a}/trash`);
        expect(trashed.body.data).toMatchObject({ pages: 2 });
        const edit = await prisma.agentEdit.findUniqueOrThrow({ where: { id: trashed.body.data.editId } });
        expect(edit.summary).toBe('Moved "Kafka" and the 2 pages inside it to the trash');
        const restored = await agent.post(`/api/agent/docs/${a}/restore`);
        expect(restored.body.data).toMatchObject({ pages: 2, detached: false });
    });
});
