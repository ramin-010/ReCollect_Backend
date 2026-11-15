// The new editor's blocks on the server (DOCS_EDITOR_V2_PLAN phase 3): the old doc → blocks
// conversion, the Markdown dialect v2 with a round trip per block type, and BlockNote's Yjs encoding.
import { beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { JSONContent } from '@tiptap/core';
import { oldJsonToBlocks, tableFromGfm } from '../../../src/services/docs/blocks/fromOldJson';
import { markdownToBlocks, printBlocks, printInline } from '../../../src/services/docs/blocks/markdown';
import { BLOCKS_FRAGMENT, blocksToYElements, readBlocks, serverEditor, type InlineNode, type NewBlock, type StyledText } from '../../../src/services/docs/blocks/serverEditor';
import { writeBoards, readBoard } from '../../../src/services/docs/canvas';

const t = (text: string, styles: Record<string, string | boolean> = {}): StyledText => ({ type: 'text', text, styles });
const p = (...content: InlineNode[]): NewBlock => ({ type: 'paragraph', content });

/** A block as compared: type, the props we set, inline text and styles, children; no ids, no defaults. */
function norm(b: NewBlock): unknown {
    const props = Object.fromEntries(
        Object.entries(b.props ?? {}).filter(([k, v]) => !['backgroundColor', 'textColor', 'textAlignment'].includes(k) && v !== undefined && !(k === 'checked' && v === false) && !(k === 'isToggleable' && v === false))
    );
    const content = Array.isArray(b.content)
        ? b.content.map((n) => (n.type === 'link' ? { link: n.href, runs: n.content.map((c) => [c.text, Object.keys(c.styles).sort()]) } : [n.text, Object.keys(n.styles).sort()]))
        : b.content;
    return { type: b.type, props, content: content ?? null, children: (b.children ?? []).map(norm) };
}

// BlockNote and jsdom load on first use: seconds on a busy machine, so once here, with room.
beforeAll(() => {
    serverEditor();
}, 60_000);

describe('old doc → blocks', () => {
    it('maps every node type of the old editor', () => {
        const doc: JSONContent = {
            type: 'doc',
            content: [
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heaps' }] },
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Top-k: ' },
                        { type: 'text', text: 'min-heap', marks: [{ type: 'bold' }] },
                        { type: 'hardBreak' },
                        { type: 'text', text: 'see ' },
                        { type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://example.com/h' } }] },
                    ],
                },
                { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'push' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'O(log n)' }] }] }] }] }] },
                { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'third' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fourth' }] }] }] },
                { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'read it' }] }] }] },
                { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
                { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const k = 3;' }] },
                { type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'flowchart LR\n  A --> B' }] },
                { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: '| a | b |\n| --- | --- |\n| 1 | 2 |' }] },
                { type: 'horizontalRule' },
                { type: 'callout', attrs: { kind: 'tip' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'TTL every key' }] }] },
                { type: 'details', attrs: { open: false }, content: [{ type: 'detailsSummary', content: [{ type: 'text', text: 'Recall check' }] }, { type: 'detailsContent', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'heapify is O(n)' }] }] }] },
                { type: 'canvas', attrs: { canvasId: 'cv_abc', height: 320 } },
                { type: 'resizableImage', attrs: { src: 'https://res.cloudinary.com/x/a.webp', width: '480px', imageId: 'img_1' } },
                { type: 'inlineAi', attrs: {} },
                { type: 'embed', attrs: { url: 'https://youtu.be/x', embedType: 'youtube' } },
            ],
        };
        const { blocks, report } = oldJsonToBlocks(doc);
        expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'bulletListItem', 'numberedListItem', 'numberedListItem', 'checkListItem', 'quote', 'codeBlock', 'diagram', 'table', 'divider', 'callout', 'toggleListItem', 'canvas', 'image', 'paragraph']);
        expect(blocks[0]!.props).toEqual({ level: 2 });
        expect(blocks[1]!.content).toEqual([t('Top-k: '), t('min-heap\n', { bold: true }), t('see '), { type: 'link', href: 'https://example.com/h', content: [t('docs')] }]);
        expect(norm(blocks[2]!)).toEqual(norm({ type: 'bulletListItem', content: [t('push')], children: [{ type: 'bulletListItem', content: [t('O(log n)')] }] }));
        expect(blocks[3]!.props).toEqual({ start: 3 });
        expect(blocks[4]!.props).toEqual({});
        expect(blocks[5]!.props).toEqual({ checked: true });
        expect(blocks[6]!.content).toEqual([t('one\ntwo')]);
        expect([blocks[7]!.props, blocks[7]!.content]).toEqual([{ language: 'ts' }, 'const k = 3;']);
        expect(blocks[8]!.content).toBe('flowchart LR\n  A --> B');
        expect((blocks[9]!.content as { rows: unknown[] }).rows).toHaveLength(2);
        expect([blocks[11]!.props, blocks[11]!.content]).toEqual([{ kind: 'tip' }, [t('TTL every key')]]);
        expect(norm(blocks[12]!)).toEqual(norm({ type: 'toggleListItem', content: [t('Recall check')], children: [p(t('heapify is O(n)'))] }));
        expect(blocks[13]!.props).toEqual({ canvasId: 'cv_abc', height: 320 });
        expect(blocks[14]!.props).toEqual({ url: 'https://res.cloudinary.com/x/a.webp', previewWidth: 480 });
        expect(report.dropped).toEqual({ inlineAi: 1 });
        expect(report.merged).toEqual({ 'blockquote: paragraphs joined': 1, 'embed: became a link': 1 });
    });

    it('reads a GFM table only when it is one', () => {
        expect(tableFromGfm('just | a pipe')).toBeNull();
        const table = tableFromGfm('| x | y |\n|:--|--:|\n| 1 \\| 2 | 3 |\n| 4 |');
        expect(table?.rows.map((r) => r.cells.map((c) => (Array.isArray(c) ? c.map((n) => (n.type === 'text' ? n.text : '')).join('') : '')))).toEqual([
            ['x', 'y'],
            ['1 | 2', '3'],
            ['4', ''],
        ]);
    });
});

describe('the Markdown dialect v2', () => {
    it('prints inline marks the old dialect reads back', () => {
        expect(printInline([t('a '), t('b', { bold: true }), t(' '), t('c', { italic: true, code: true }), t(' x*y_z')])).toBe('a **b** *`c`* x\\*y\\_z');
    });

    // One block per type, printed, parsed back, compared.
    const cases: [string, NewBlock[]][] = [
        ['paragraph with marks and a link', [p(t('Plain, '), t('bold', { bold: true }), t(', '), t('italic', { italic: true }), t(', '), t('struck', { strike: true }), t(', '), t('code', { code: true }), t(' and '), { type: 'link', href: 'https://example.com/a', content: [t('a link')] })]],
        ['headings 1–6', [1, 2, 3, 4, 5, 6].map((level) => ({ type: 'heading', props: { level }, content: [t(`Heading ${level}`)] }))],
        ['toggle headings with what folds under them', [1, 2, 3].map((level) => ({ type: 'heading', props: { level, isToggleable: true }, content: [t(`Section ${level}`)], children: [p(t(`inside ${level}`))] }))],
        ['nested bullets', [{ type: 'bulletListItem', content: [t('outer')], children: [{ type: 'bulletListItem', content: [t('inner')] }] }, { type: 'bulletListItem', content: [t('second')] }]],
        ['a list item with a paragraph and a list under it', [{ type: 'bulletListItem', content: [t('item')], children: [p(t('more about it')), { type: 'bulletListItem', content: [t('sub-point')] }] }, { type: 'bulletListItem', content: [t('next')] }]],
        ['numbered list with a start', [{ type: 'numberedListItem', props: { start: 4 }, content: [t('four')] }, { type: 'numberedListItem', content: [t('five')] }]],
        ['to-dos', [{ type: 'checkListItem', props: { checked: true }, content: [t('done')] }, { type: 'checkListItem', content: [t('open')] }]],
        ['toggle with children', [{ type: 'toggleListItem', content: [t('Recall check')], children: [p(t('the answer')), { type: 'bulletListItem', content: [t('a point')] }] }]],
        ['quote', [{ type: 'quote', content: [t('numbers come from tools')] }]],
        ['callouts, every kind', ['note', 'tip', 'important', 'warning', 'caution'].map((kind) => ({ type: 'callout', props: { kind }, content: [t(`a ${kind}`)] }))],
        ['code block', [{ type: 'codeBlock', props: { language: 'python' }, content: 'def f(x):\n    return x * 2' }]],
        ['diagram', [{ type: 'diagram', content: 'flowchart LR\n  A[Client] --> B[Server]' }]],
        ['divider', [p(t('above')), { type: 'divider' }, p(t('below'))]],
        ['image', [{ type: 'image', props: { url: 'https://res.cloudinary.com/x/a.webp' } }]],
        [
            'table',
            [
                {
                    type: 'table',
                    content: {
                        type: 'tableContent',
                        headerRows: 1,
                        rows: [{ cells: [[t('Op')], [t('Cost')]] }, { cells: [[t('push')], [t('O(log n)')]] }],
                    },
                },
            ],
        ],
    ];

    for (const [name, blocks] of cases) {
        it(`round-trips: ${name}`, async () => {
            const md = printBlocks(blocks);
            const back = await markdownToBlocks(md);
            const sameTable = (b: NewBlock) =>
                b.type === 'table' ? { type: 'table', rows: (b.content as { rows: { cells: unknown[] }[] }).rows.map((r) => r.cells.map((c) => (Array.isArray(c) ? c : (c as { content: unknown }).content))) } : norm(b);
            expect(back.blocks.map(sameTable), md).toEqual(blocks.map(sameTable));
        });
    }

    it('prints a toggle heading as a toggle whose summary is the heading, and reads GitHub\'s <h2> form too', async () => {
        const md = printBlocks([{ type: 'heading', props: { level: 2, isToggleable: true }, content: [t('Caching')], children: [p(t('Read-through first.'))] }]);
        expect(md).toBe('<details>\n<summary>## Caching</summary>\n\nRead-through first.\n\n</details>');
        const github = await markdownToBlocks('<details>\n<summary><h3>Eviction</h3></summary>\n\nLRU by default.\n\n</details>');
        expect(github.blocks.map(norm)).toEqual([{ type: 'heading', props: { level: 3, isToggleable: true }, content: [['Eviction', []]], children: [norm(p(t('LRU by default.')))] }]);
        // A plain toggle stays a toggle.
        const plain = await markdownToBlocks('<details>\n<summary>Recall check</summary>\n\nanswer\n\n</details>');
        expect(plain.blocks[0]?.type).toBe('toggleListItem');
    });

    it('round-trips a canvas: its board goes out in the fence and comes back as a new board', async () => {
        const doc = new Y.Doc();
        const board = { nodes: [{ id: 'a', x: 0, y: 0, w: 120, h: 48, text: 'Client' }, { id: 'b', x: 200, y: 0, w: 120, h: 48, text: 'Server' }], edges: [{ id: 'e1', from: 'a', to: 'b' }] };
        writeBoards(doc, new Map([['cv_round', board as never]]));
        const md = printBlocks([{ type: 'canvas', props: { canvasId: 'cv_round', height: 320 } }], { ydoc: doc });
        expect(md.startsWith('```canvas')).toBe(true);
        const back = await markdownToBlocks(md);
        expect(back.blocks).toHaveLength(1);
        const id = String(back.blocks[0]!.props?.['canvasId']);
        expect(id).toMatch(/^cv_/);
        const laid = back.boards.get(id);
        expect(laid?.nodes.map((n) => n.text).sort()).toEqual(['Client', 'Server']);
        expect(laid?.edges).toHaveLength(1);
        expect(readBoard(doc, 'cv_round').nodes).toHaveLength(2);
        doc.destroy();
    });
});

describe('blocks → old JSON (the old readers on a doc with blocks)', () => {
    it('goes back to the same blocks through the conversion, for every block type', async () => {
        const { blocksToOldJson } = await import('../../../src/services/docs/blocks/toOldJson');
        const blocks: NewBlock[] = [
            { type: 'heading', props: { level: 2 }, content: [t('Heaps')] },
            { type: 'heading', props: { level: 5 }, content: [t('A deep heading')] },
            { type: 'heading', props: { level: 2, isToggleable: true }, content: [t('Folded section')], children: [p(t('inside it'))] },
            p(t('Plain '), t('bold', { bold: true }), t(' and '), { type: 'link', href: 'https://example.com', content: [t('a link')] }),
            { type: 'bulletListItem', content: [t('one')], children: [{ type: 'bulletListItem', content: [t('nested')] }] },
            { type: 'bulletListItem', content: [t('two')] },
            { type: 'numberedListItem', props: { start: 3 }, content: [t('three')] },
            { type: 'checkListItem', props: { checked: true }, content: [t('done')] },
            { type: 'toggleListItem', content: [t('Recall check')], children: [p(t('answer'))] },
            { type: 'quote', content: [t('line one\nline two')] },
            { type: 'callout', props: { kind: 'warning' }, content: [t('careful')] },
            { type: 'codeBlock', props: { language: 'ts' }, content: 'const k = 3;' },
            { type: 'diagram', content: 'flowchart LR\n  A --> B' },
            { type: 'canvas', props: { canvasId: 'cv_abcdefghijkl', height: 320 } },
            { type: 'divider' },
            { type: 'image', props: { url: 'https://res.cloudinary.com/x/a.webp', previewWidth: 480 } },
        ];
        const { blocks: back } = oldJsonToBlocks(blocksToOldJson(blocks));
        expect(back.map(norm)).toEqual(blocks.map(norm));
    });

    it('read_doc prints H4–H6 and a toggle heading the way the dialect reads them back', async () => {
        const { blocksToOldJson } = await import('../../../src/services/docs/blocks/toOldJson');
        const { docJsonToMarkdown } = await import('../../../src/services/docs/markdown/docMarkdown');
        const blocks: NewBlock[] = [
            { type: 'heading', props: { level: 4 }, content: [t('Four')] },
            { type: 'heading', props: { level: 6 }, content: [t('Six')] },
            { type: 'heading', props: { level: 3, isToggleable: true }, content: [t('Folded')], children: [p(t('inside'))] },
        ];
        const md = docJsonToMarkdown(blocksToOldJson(blocks));
        expect(md).toContain('#### Four');
        expect(md).toContain('###### Six');
        expect(md).toContain('<summary>### Folded</summary>');
        const back = await markdownToBlocks(md);
        expect(back.blocks.map(norm)).toEqual(blocks.map(norm));
    });
});

describe('BlockNote on the server', () => {
    it('encodes blocks as Y elements and reads them back with their ids and our blocks', () => {
        const blocks: NewBlock[] = [
            { id: 'b1', type: 'heading', props: { level: 2 }, content: [t('Heaps')] },
            { id: 'b2', type: 'callout', props: { kind: 'warning' }, content: [t('careful')] },
            { id: 'b3', type: 'diagram', content: 'flowchart LR\n  A --> B' },
            { id: 'b4', type: 'canvas', props: { canvasId: 'cv_1', height: 360 } },
            { id: 'b5', type: 'bulletListItem', content: [t('item')], children: [{ id: 'b6', type: 'paragraph', content: [t('child')] }] },
        ];
        const doc = new Y.Doc();
        const group = new Y.XmlElement('blockGroup');
        doc.getXmlFragment(BLOCKS_FRAGMENT).insert(0, [group]);
        group.insert(0, blocksToYElements(blocks));
        const back = readBlocks(doc);
        expect(back.map((b) => [b.id, b.type])).toEqual([
            ['b1', 'heading'],
            ['b2', 'callout'],
            ['b3', 'diagram'],
            ['b4', 'canvas'],
            ['b5', 'bulletListItem'],
        ]);
        expect(back[1]!.props['kind']).toBe('warning');
        // Plain content reads back as one unstyled run (written, it may be a string).
        expect(back[2]!.content).toEqual([{ type: 'text', text: 'flowchart LR\n  A --> B', styles: {} }]);
        expect(back[3]!.props).toMatchObject({ canvasId: 'cv_1', height: 360 });
        expect(back[4]!.children.map((c) => c.id)).toEqual(['b6']);
        expect(serverEditor()).toBe(serverEditor());
        doc.destroy();
    });
});
