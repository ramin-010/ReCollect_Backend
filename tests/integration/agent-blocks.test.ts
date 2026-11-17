// Block tools (DOCS_EDITOR_V2_PLAN phase 3): an agent reads a doc's outline and changes the new
// editor's blocks by id (insert, update, move, delete), live through Hocuspocus, logged as
// doc_blocks and undone exactly. A doc still on the old editor answers 409.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { stateBytes } from '../../src/services/docs/docState';
import * as Y from 'yjs';

vi.mock('upfly', async () => (await import('../helpers/uploads')).createUpflyMock());
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));

import { prisma } from '../../src/db/prisma';
import { readBoard } from '../../src/services/docs/canvas';
import { docJsonToYjsState } from '../../src/services/docs/docContent';
import { markdownToDocJson } from '../../src/services/docs/markdown/docMarkdown';
import { BLOCKS_FRAGMENT, blocksToYElements, readBlocks, type InlineNode, type NewBlock } from '../../src/services/docs/blocks/serverEditor';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import type { ApiScope } from '../../src/types/auth';

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

const t = (text: string): InlineNode => ({ type: 'text', text, styles: {} });

/** A doc on the new editor: these blocks in its "blocks" fragment. */
async function blocksDoc(userId: string, title: string, blocks: NewBlock[]) {
    const ydoc = new Y.Doc();
    const group = new Y.XmlElement('blockGroup');
    ydoc.getXmlFragment(BLOCKS_FRAGMENT).insert(0, [group]);
    group.insert(0, blocksToYElements(blocks));
    ydoc.getMap('metadata').set('title', title);
    const yjsState = stateBytes(Y.encodeStateAsUpdate(ydoc));
    ydoc.destroy();
    return prisma.doc.create({ data: { userId, title, yjsState } });
}

/** The stored doc as "id:text" lines (children indented), from its blocks fragment. */
async function storedShape(docId: string): Promise<string> {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, row.yjsState!);
    const walk = (bs: ReturnType<typeof readBlocks>, depth: number): string[] =>
        bs.flatMap((b) => {
            const text = Array.isArray(b.content) ? (b.content as InlineNode[]).map((n) => (n.type === 'text' ? n.text : n.content.map((c) => c.text).join(''))).join('') : '';
            return [`${'  '.repeat(depth)}${b.type}:${text}`, ...walk(b.children, depth + 1)];
        });
    const out = walk(readBlocks(ydoc), 0).join('\n');
    ydoc.destroy();
    return out;
}

async function agentFor(user: { id: string }, scopes?: ApiScope[]) {
    const { token } = await createTestToken(user, scopes);
    return asAgent(token, 'Claude Code');
}

const base = (): NewBlock[] => [
    { id: 'h1', type: 'heading', props: { level: 2 }, content: [t('Heaps')] },
    { id: 'p1', type: 'paragraph', content: [t('A heap is a tree.')] },
    { id: 'l1', type: 'bulletListItem', content: [t('push')], children: [{ id: 'k1', type: 'paragraph', content: [t('O(log n)')] }] },
    { id: 'z1', type: 'paragraph', content: [] },
];

describe('block tools', () => {
    it('outlines a doc on the new editor; a doc on the old one answers 409', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const doc = await blocksDoc(user.id, 'Heaps', base());
        const res = await agent.get(`/api/agent/docs/${doc.id}/outline`);
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            id: doc.id,
            title: 'Heaps',
            canEdit: true,
            blocks: [
                { id: 'h1', type: 'heading', depth: 0, text: 'Heaps', props: { level: 2 } },
                { id: 'p1', type: 'paragraph', depth: 0, text: 'A heap is a tree.' },
                { id: 'l1', type: 'bulletListItem', depth: 0, text: 'push' },
                { id: 'k1', type: 'paragraph', depth: 1, text: 'O(log n)' },
                { id: 'z1', type: 'paragraph', depth: 0, text: '' },
            ],
        });
        const read = await agent.get(`/api/agent/docs/${doc.id}/blocks?ids=l1`);
        expect(read.body.data.markdown).toBe('- push\n\n  O(log n)');

        const old = await prisma.doc.create({ data: { userId: user.id, title: 'Old', yjsState: docJsonToYjsState(markdownToDocJson('Hello')) } });
        const refused = await agent.get(`/api/agent/docs/${old.id}/outline`);
        expect(refused.status).toBe(409);
        expect(refused.body.message).toMatch(/old editor/);
        expect((await agent.post(`/api/agent/docs/${old.id}/blocks`, { markdown: 'x' })).status).toBe(409);
    });

    it('inserts Markdown after a block, logs doc_blocks, and Undo takes exactly it back', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const doc = await blocksDoc(user.id, 'Heaps', base());
        const res = await agent.post(`/api/agent/docs/${doc.id}/blocks`, { markdown: '> [!TIP]\n> peek is O(1)\n\n```mermaid\nflowchart LR\n  A --> B\n```', where: { after: 'p1' } });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ id: doc.id, inserted: 2, editId: expect.any(String) });
        expect(res.body.data.ids).toHaveLength(2);
        expect(await storedShape(doc.id)).toBe(['heading:Heaps', 'paragraph:A heap is a tree.', 'callout:peek is O(1)', 'diagram:flowchart LR\n  A --> B', 'bulletListItem:push', '  paragraph:O(log n)', 'paragraph:'].join('\n'));
        const edit = await prisma.agentEdit.findUniqueOrThrow({ where: { id: res.body.data.editId } });
        expect(edit).toMatchObject({ kind: 'doc_blocks', docId: doc.id, summary: 'Added 2 blocks after block p1 in "Heaps"' });

        // Agents can't undo; the user can.
        expect((await agent.post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(403);
        expect((await api(user).post(`/api/agent/edits/${edit.id}/undo`)).status).toBe(200);
        expect(await storedShape(doc.id)).toBe(['heading:Heaps', 'paragraph:A heap is a tree.', 'bulletListItem:push', '  paragraph:O(log n)', 'paragraph:'].join('\n'));
    });

    it('updates a block in place (props, or one block of Markdown), keeping its children', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const doc = await blocksDoc(user.id, 'Heaps', base());
        expect((await agent.patch(`/api/agent/docs/${doc.id}/blocks/h1`, { props: { level: 3 } })).status).toBe(200);
        const res = await agent.patch(`/api/agent/docs/${doc.id}/blocks/l1`, { markdown: '- [x] push and pop' });
        expect(res.status).toBe(200);
        expect(res.body.data.block).toEqual({ id: 'l1', type: 'checkListItem', markdown: '- [x] push and pop' });
        expect(await storedShape(doc.id)).toBe(['heading:Heaps', 'paragraph:A heap is a tree.', 'checkListItem:push and pop', '  paragraph:O(log n)', 'paragraph:'].join('\n'));
        expect((await agent.patch(`/api/agent/docs/${doc.id}/blocks/l1`, { markdown: 'one\n\ntwo' })).status).toBe(400);
        expect((await agent.patch(`/api/agent/docs/${doc.id}/blocks/nope`, { props: { level: 1 } })).status).toBe(404);
    });

    it('moves and deletes blocks by id; Undo of a delete brings them back', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const doc = await blocksDoc(user.id, 'Heaps', base());
        expect((await agent.post(`/api/agent/docs/${doc.id}/blocks/move`, { ids: ['l1'], where: { before: 'h1' } })).status).toBe(200);
        expect(await storedShape(doc.id)).toBe(['bulletListItem:push', '  paragraph:O(log n)', 'heading:Heaps', 'paragraph:A heap is a tree.', 'paragraph:'].join('\n'));
        expect((await agent.post(`/api/agent/docs/${doc.id}/blocks/move`, { ids: ['h1'], where: { under: 'k1' } })).status).toBe(200);
        expect((await agent.post(`/api/agent/docs/${doc.id}/blocks/move`, { ids: ['l1'], where: { under: 'k1' } })).status).toBe(400);
        const del = await agent.post(`/api/agent/docs/${doc.id}/blocks/delete`, { ids: ['p1', 'l1'] });
        expect(del.status).toBe(200);
        expect(del.body.data.deleted).toBe(2);
        expect(await storedShape(doc.id)).toBe('paragraph:');
        expect((await api(user).post(`/api/agent/edits/${del.body.data.editId}/undo`)).status).toBe(200);
        expect(await storedShape(doc.id)).toBe(['bulletListItem:push', '  paragraph:O(log n)', '    heading:Heaps', 'paragraph:A heap is a tree.', 'paragraph:'].join('\n'));
        expect((await agent.post(`/api/agent/docs/${doc.id}/blocks/move`, { ids: ['x'], where: { at: 'end', after: 'h1' } })).status).toBe(400);
    });

    it('a ```canvas fence makes a canvas block with its board in the doc; Undo removes both', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const doc = await blocksDoc(user.id, 'Caching', base());
        const res = await agent.post(`/api/agent/docs/${doc.id}/blocks`, { markdown: '```canvas\nflowchart LR\n  C[Client] --> R[(Redis)]\n```', where: { at: 'end' } });
        expect(res.status).toBe(200);
        expect(res.body.data.canvases).toHaveLength(1);
        const row = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, row.yjsState!);
        const canvas = readBlocks(ydoc).find((b) => b.type === 'canvas');
        const canvasId = String(canvas?.props['canvasId']);
        expect(readBoard(ydoc, canvasId).nodes.map((n) => n.text).sort()).toEqual(['Client', 'Redis']);
        ydoc.destroy();
        expect((await api(user).post(`/api/agent/edits/${res.body.data.editId}/undo`)).status).toBe(200);
        const after = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        const back = new Y.Doc();
        Y.applyUpdate(back, after.yjsState!);
        expect(readBlocks(back).some((b) => b.type === 'canvas')).toBe(false);
        expect(readBoard(back, canvasId).nodes).toHaveLength(0);
        back.destroy();
    });

    it('on a doc with blocks, read_doc, search, append_to_doc and replace_section work on the blocks', async () => {
        const user = await createTestUser();
        const agent = await agentFor(user);
        const doc = await blocksDoc(user.id, 'Heaps', [
            { id: 'h1', type: 'heading', props: { level: 2 }, content: [t('Basics')] },
            { id: 'p1', type: 'paragraph', content: [t('A heap is a tree with the smallest key on top.')] },
            { id: 'h2', type: 'heading', props: { level: 2 }, content: [t('Costs')] },
            { id: 'p2', type: 'paragraph', content: [t('push is O(log n).')] },
            { id: 'z1', type: 'paragraph', content: [] },
        ]);
        // read_doc reads the blocks (through the old JSON readers).
        const read = await agent.get(`/api/agent/docs/${doc.id}`);
        expect(read.status).toBe(200);
        expect(read.body.data.markdown).toContain('## Basics');
        expect(read.body.data.markdown).toContain('smallest key on top');
        // Search finds words that only exist in the blocks.
        const found = await agent.get('/api/agent/docs?query=smallest');
        expect(found.body.data.map((d: { id: string }) => d.id)).toContain(doc.id);
        // append_to_doc lands before the trailing empty paragraph.
        const app = await agent.post(`/api/agent/docs/${doc.id}/append`, { markdown: '- peek is O(1)' });
        expect(app.status).toBe(200);
        expect(app.body.data).toMatchObject({ id: doc.id, appended: 1, editId: expect.any(String) });
        // replace_section rewrites the body under "Costs" (the heading stays).
        const rep = await agent.post(`/api/agent/docs/${doc.id}/replace-section`, { heading: 'costs', markdown: 'pop is O(log n) too.' });
        expect(rep.status).toBe(200);
        expect(rep.body.data).toMatchObject({ heading: 'Costs', removed: 2, inserted: 1 });
        expect(await storedShape(doc.id)).toBe(['heading:Basics', 'paragraph:A heap is a tree with the smallest key on top.', 'heading:Costs', 'paragraph:pop is O(log n) too.', 'paragraph:'].join('\n'));
        // A rename: a heading of the same level replaces the heading too.
        expect((await agent.post(`/api/agent/docs/${doc.id}/replace-section`, { heading: 'Basics', markdown: '## The basics\n\nTrees.' })).status).toBe(200);
        expect((await storedShape(doc.id)).split('\n').slice(0, 2)).toEqual(['heading:The basics', 'paragraph:Trees.']);
        const missing = await agent.post(`/api/agent/docs/${doc.id}/replace-section`, { heading: 'Nope', markdown: 'x' });
        expect(missing.status).toBe(404);
        expect(missing.body.message).toContain('"Costs"');
        // Undo of the section rewrite puts the old body back.
        expect((await api(user).post(`/api/agent/edits/${rep.body.data.editId}/undo`)).status).toBe(200);
        expect(await storedShape(doc.id)).toContain('paragraph:push is O(log n).');
        // The stored preview (the library's snippet) comes from the blocks too.
        const row = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        expect(row.previewState).toContain('Trees.');
    });

    it('needs docs:write to change blocks (a read token can outline); viewers cannot write', async () => {
        const user = await createTestUser();
        const doc = await blocksDoc(user.id, 'Heaps', base());
        const reader = await agentFor(user, ['read']);
        expect((await reader.get(`/api/agent/docs/${doc.id}/outline`)).status).toBe(200);
        expect((await reader.post(`/api/agent/docs/${doc.id}/blocks`, { markdown: 'x' })).status).toBe(403);
        const stranger = await createTestUser();
        const other = await agentFor(stranger);
        expect((await other.get(`/api/agent/docs/${doc.id}/outline`)).status).toBe(404);
        expect((await other.post(`/api/agent/docs/${doc.id}/blocks`, { markdown: 'x' })).status).toBe(404);
    });
});
