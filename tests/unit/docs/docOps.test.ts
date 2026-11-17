// DocOps on the new editor's blocks (DOCS_EDITOR_V2_PLAN §4.3): pure Y.Doc operations, and their
// exact Undo through the agent change machinery (revertUpdate now covers the "blocks" fragment).
import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { insert, move, outline, remove, update } from '../../../src/services/docs/blocks/docOps';
import { BLOCKS_FRAGMENT, blocksToYElements, readBlocks, serverEditor, type InlineNode, type NewBlock } from '../../../src/services/docs/blocks/serverEditor';
import { revertUpdate, transactCapturing } from '../../../src/services/agent/yjsChanges';

const t = (text: string): InlineNode => ({ type: 'text', text, styles: {} });

function docWith(blocks: NewBlock[]): Y.Doc {
    const doc = new Y.Doc();
    const group = new Y.XmlElement('blockGroup');
    doc.getXmlFragment(BLOCKS_FRAGMENT).insert(0, [group]);
    group.insert(0, blocksToYElements(blocks));
    return doc;
}

/** "id:text" of every block, children in brackets. */
function shape(doc: Y.Doc): string {
    const walk = (bs: ReturnType<typeof readBlocks>): string =>
        bs
            .map((b) => {
                const text = Array.isArray(b.content) ? (b.content as InlineNode[]).map((n) => (n.type === 'text' ? n.text : '')).join('') : '';
                return `${b.id}:${text}${b.children.length ? `[${walk(b.children)}]` : ''}`;
            })
            .join(' ');
    return walk(readBlocks(doc));
}

const base = (): NewBlock[] => [
    { id: 'h', type: 'heading', props: { level: 2 }, content: [t('Heaps')] },
    { id: 'a', type: 'paragraph', content: [t('alpha')] },
    { id: 'l', type: 'bulletListItem', content: [t('list')], children: [{ id: 'k', type: 'paragraph', content: [t('kid')] }] },
    { id: 'z', type: 'paragraph', content: [] },
];

// BlockNote and jsdom load on first use: seconds on a busy machine, so once here, with room.
beforeAll(() => {
    serverEditor();
}, 60_000);

describe('DocOps', () => {
    it('outlines ids, types, depth and first words', () => {
        const doc = docWith(base());
        expect(outline(doc)).toEqual([
            { id: 'h', type: 'heading', depth: 0, text: 'Heaps', props: { level: 2 } },
            { id: 'a', type: 'paragraph', depth: 0, text: 'alpha' },
            { id: 'l', type: 'bulletListItem', depth: 0, text: 'list' },
            { id: 'k', type: 'paragraph', depth: 1, text: 'kid' },
            { id: 'z', type: 'paragraph', depth: 0, text: '' },
        ]);
    });

    it('inserts at the end (before the trailing empty paragraph), the start, after, before and under a block', () => {
        const doc = docWith(base());
        insert(doc, [{ id: 'e', type: 'paragraph', content: [t('end')] }], { at: 'end' });
        insert(doc, [{ id: 's', type: 'paragraph', content: [t('start')] }], { at: 'start' });
        insert(doc, [{ id: 'x', type: 'paragraph', content: [t('after a')] }], { after: 'a' });
        insert(doc, [{ id: 'y', type: 'paragraph', content: [t('before a')] }], { before: 'a' });
        insert(doc, [{ id: 'u', type: 'paragraph', content: [t('under kid')] }], { under: 'k' });
        expect(shape(doc)).toBe('s:start h:Heaps y:before a a:alpha x:after a l:list[k:kid[u:under kid]] e:end z:');
    });

    it('gives a fresh id to an inserted block whose id the doc already has', () => {
        const doc = docWith(base());
        const [id] = insert(doc, [{ id: 'a', type: 'paragraph', content: [t('copy')] }], { at: 'end' });
        expect(id).not.toBe('a');
        expect(id).toBeTruthy();
        expect(outline(doc).filter((o) => o.id === 'a')).toHaveLength(1);
    });

    it('refuses blocks that do not fit the schema and ids it does not know', () => {
        const doc = docWith(base());
        expect(() => insert(doc, [{ type: 'noSuchBlock' }], { at: 'end' })).toThrow(/don't fit/);
        expect(() => insert(doc, [{ type: 'paragraph' }], { after: 'nope' })).toThrow(/No block with the id nope/);
        expect(() => insert(doc, [], { at: 'end' })).toThrow(/No blocks/);
    });

    it('updates props alone, text alone, or the type, and keeps the children', () => {
        const doc = docWith(base());
        update(doc, 'h', { props: { level: 3 } });
        expect(readBlocks(doc)[0]!.props['level']).toBe(3);
        expect(shape(doc).startsWith('h:Heaps')).toBe(true);
        update(doc, 'a', { content: [t('ALPHA')] });
        update(doc, 'l', { type: 'checkListItem', props: { checked: true } });
        const l = readBlocks(doc)[2]!;
        expect([l.type, l.props['checked'], l.children.map((c) => c.id)]).toEqual(['checkListItem', true, ['k']]);
        expect(shape(doc)).toBe('h:Heaps a:ALPHA l:list[k:kid] z:');
        // A callout's kind.
        insert(doc, [{ id: 'c', type: 'callout', props: { kind: 'note' }, content: [t('careful')] }], { at: 'end' });
        update(doc, 'c', { props: { kind: 'warning' } });
        expect(readBlocks(doc).find((b) => b.id === 'c')!.props['kind']).toBe('warning');
    });

    it('moves blocks with their children and keeps their ids; never into themselves', () => {
        const doc = docWith(base());
        move(doc, ['l'], { before: 'h' });
        expect(shape(doc)).toBe('l:list[k:kid] h:Heaps a:alpha z:');
        move(doc, ['a'], { under: 'h' });
        expect(shape(doc)).toBe('l:list[k:kid] h:Heaps[a:alpha] z:');
        move(doc, ['k'], { at: 'end' });
        expect(shape(doc)).toBe('l:list h:Heaps[a:alpha] k:kid z:');
        expect(() => move(doc, ['h'], { under: 'a' })).toThrow(/itself/);
        expect(() => move(doc, ['h'], { after: 'h' })).toThrow(/itself/);
    });

    it('removes blocks with their children and never leaves the doc without a block', () => {
        const doc = docWith(base());
        expect(remove(doc, ['l'])).toBe(1);
        expect(shape(doc)).toBe('h:Heaps a:alpha z:');
        remove(doc, ['h', 'a', 'z']);
        const left = readBlocks(doc);
        expect(left).toHaveLength(1);
        expect(left[0]!.type).toBe('paragraph');
        expect(() => remove(doc, ['gone'])).toThrow(/None of those blocks/);
    });

    it('an agent change on the blocks is undone exactly, keeping what was typed after it', () => {
        const doc = docWith(base());
        const change = transactCapturing(doc, () => {
            insert(doc, [{ id: 'n', type: 'paragraph', content: [t('agent wrote this')] }], { after: 'a' });
        });
        // The user types into "alpha" after the agent's change.
        update(doc, 'a', { content: [t('alpha, edited')] });
        const revert = revertUpdate(change.before, change.update!);
        expect(revert).not.toBeNull();
        Y.applyUpdate(doc, revert!);
        expect(shape(doc)).toBe('h:Heaps a:alpha, edited l:list[k:kid] z:');
    });
});
