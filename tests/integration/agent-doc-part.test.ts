// TOOL_ACCESS_PLAN §10 (11-27): edit_doc_part's route. One part of a doc, named as a person would (a heading, quoted
// words, a kind of block with first / last / empty), changed in one call, logged as doc_blocks and undone exactly.
// The cases are the picking test's block edits (F19-F23) plus what the words can't decide.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { stateBytes } from '../../src/services/docs/docState';
import { prisma } from '../../src/db/prisma';
import { BLOCKS_FRAGMENT, blocksToYElements, readBlocks, type InlineNode, type NewBlock } from '../../src/services/docs/blocks/serverEditor';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

const t = (text: string): InlineNode => ({ type: 'text', text, styles: {} });

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

/** The stored doc as "type:text" lines (a to-do with [x] when ticked). */
async function shape(docId: string): Promise<string[]> {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, row.yjsState!);
    const walk = (bs: ReturnType<typeof readBlocks>, depth: number): string[] =>
        bs.flatMap((b) => {
            const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as InlineNode[]).map((n) => (n.type === 'text' ? n.text : n.content.map((c) => c.text).join(''))).join('') : '';
            const tick = b.type === 'checkListItem' ? (b.props['checked'] ? '[x] ' : '[ ] ') : '';
            return [`${'  '.repeat(depth)}${b.type}:${tick}${text}`, ...walk(b.children, depth + 1)];
        });
    const out = walk(readBlocks(ydoc), 0);
    ydoc.destroy();
    return out;
}

/** The sliding window lesson, as the picking test's world has it. */
const lesson = (): NewBlock[] => [
    { id: 's1', type: 'heading', props: { level: 2 }, content: [t('Summary')] },
    { id: 's2', type: 'paragraph', content: [t('A window that slides.')] },
    { id: 'c1', type: 'heading', props: { level: 2 }, content: [t('Template')] },
    { id: 'c2', type: 'codeBlock', props: { language: 'python' }, content: 'for r in range(n):\n    pass' },
    { id: 'd1', type: 'heading', props: { level: 2 }, content: [t('To do')] },
    { id: 'd2', type: 'checkListItem', props: { checked: false }, content: [t('compare Redis vs Memcached')] },
    { id: 'd3', type: 'checkListItem', props: { checked: false }, content: [t('read the paper')] },
    { id: 'q1', type: 'heading', props: { level: 2 }, content: [t('Self-test questions')] },
    { id: 'q2', type: 'paragraph', content: [t('Why is it O(n)?')] },
    { id: 'n1', type: 'heading', props: { level: 2 }, content: [t('Notes')] },
    { id: 'n2', type: 'bulletListItem', content: [t('grows on the right')] },
    { id: 'n3', type: 'paragraph', content: [t('Shrinks on the left.')] },
    { id: 'e1', type: 'bulletListItem', content: [] },
    { id: 'e2', type: 'bulletListItem', content: [] },
    { id: 'z1', type: 'paragraph', content: [] },
];

async function setup() {
    const user = await createTestUser();
    const doc = await blocksDoc(user.id, 'Sliding window', lesson());
    const { token } = await createTestToken(user);
    return { user, doc, agent: asAgent(token, 'Claude Code') };
}

describe('edit_doc_part: a part named in words (TOOL_ACCESS_PLAN §10)', () => {
    it('F22: move a section by its heading to the end; Undo puts it back', async () => {
        const { user, doc, agent } = await setup();
        const before = await shape(doc.id);
        const res = await agent.post(`/api/agent/docs/${doc.id}/part`, { part: 'the Self-test questions section', action: 'move_to_end' });
        expect(res.status).toBe(200);
        expect(res.body.data.done).toBe('Moved the section "Self-test questions" (2 blocks) to the end');
        const after = await shape(doc.id);
        // At the end, before the editor's trailing empty line.
        expect(after.slice(-3)).toEqual(['heading:Self-test questions', 'paragraph:Why is it O(n)?', 'paragraph:']);
        const undo = await api(user).post(`/api/agent/edits/${res.body.data.editId}/undo`);
        expect(undo.status).toBe(200);
        expect(await shape(doc.id)).toEqual(before);
    });

    it('F20: insert before the code block (a kind); F21: tick a to-do by its words', async () => {
        const { doc, agent } = await setup();
        const ins = await agent.post(`/api/agent/docs/${doc.id}/part`, { part: 'the code', action: 'insert_before', markdown: '> [!WARNING]\n> Off by one: the length is r - l + 1.' });
        expect(ins.status).toBe(200);
        expect(ins.body.data.done).toBe('Added 1 block before the code block "for r in range(n): pass"');
        const s = await shape(doc.id);
        expect(s.indexOf('codeBlock:for r in range(n):\n    pass') - s.findIndex((l) => l.startsWith('callout:'))).toBe(1);
        const tick = await agent.post(`/api/agent/docs/${doc.id}/part`, { part: "the to-do 'compare Redis vs Memcached'", action: 'tick' });
        expect(tick.status).toBe(200);
        expect(await shape(doc.id)).toEqual(expect.arrayContaining(['checkListItem:[x] compare Redis vs Memcached', 'checkListItem:[ ] read the paper']));
    });

    it('F23: delete the empty bullet list at the bottom (the empty run, not the one with words)', async () => {
        const { doc, agent } = await setup();
        const res = await agent.post(`/api/agent/docs/${doc.id}/part`, { part: 'the empty bullet list at the bottom', action: 'delete' });
        expect(res.status).toBe(200);
        expect(res.body.data.done).toBe('Deleted the empty bullet list (2 blocks)');
        const s = await shape(doc.id);
        expect(s.filter((l) => l.startsWith('bulletListItem:'))).toEqual(['bulletListItem:grows on the right']);
    });

    it('F19: replace a section by its heading keeps the heading; a new heading renames it', async () => {
        const { doc, agent } = await setup();
        const res = await agent.post(`/api/agent/docs/${doc.id}/part`, { part: 'Summary', action: 'replace', markdown: 'A window over a contiguous range: it grows on the right and shrinks on the left, O(n) overall.' });
        expect(res.status).toBe(200);
        let s = await shape(doc.id);
        expect(s.slice(0, 2)).toEqual(['heading:Summary', 'paragraph:A window over a contiguous range: it grows on the right and shrinks on the left, O(n) overall.']);
        await agent.post(`/api/agent/docs/${doc.id}/part`, { part: 'summary', action: 'replace', markdown: '## In short\n\nGrows right, shrinks left.' });
        s = await shape(doc.id);
        expect(s.slice(0, 2)).toEqual(['heading:In short', 'paragraph:Grows right, shrinks left.']);
    });

    it('words that fit several blocks list them with ids; nothing found names the headings; a to-do-less part refuses tick', async () => {
        const { doc, agent } = await setup();
        const many = await agent.post(`/api/agent/docs/${doc.id}/part`, { part: 'the', action: 'delete' });
        expect(many.status).toBe(409);
        expect(many.body.message).toMatch(/fits \d+ parts of "Sliding window": \w+ · /);
        const none = await agent.post(`/api/agent/docs/${doc.id}/part`, { part: 'Kafka partitions', action: 'delete' });
        expect(none.status).toBe(404);
        expect(none.body.message).toContain('Its headings: "Summary", "Template", "To do", "Self-test questions", "Notes"');
        const notodo = await agent.post(`/api/agent/docs/${doc.id}/part`, { part: 'Summary', action: 'tick' });
        expect(notodo.status).toBe(400);
        const nomd = await agent.post(`/api/agent/docs/${doc.id}/part`, { part: 'Summary', action: 'replace' });
        expect(nomd.status).toBe(400);
        // Nothing changed.
        expect(await shape(doc.id)).toEqual(await shape(doc.id));
    });
});
