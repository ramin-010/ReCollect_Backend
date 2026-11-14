// Markdown ⇄ doc (src/services/docs/markdown/docMarkdown.ts): every block type round-trips, the
// parsed JSON fits the editor's schema, and custom nodes print as something an agent can read.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { JSONContent } from '@tiptap/core';
import {
    docJsonToMarkdown,
    docJsonToYElements,
    markdownToBlocks,
    markdownToDocJson,
    yjsStateToMarkdown,
} from '../../../src/services/docs/markdown/docMarkdown';
import { docJsonToYjsState, getDocSchema, yjsStateToDocJson } from '../../../src/services/docs/docContent';
import { CALLOUT_KINDS } from '../../../src/services/docs/docSchema';
import ErrorResponse from '../../../src/utils/errorResponse';

/** Markdown → doc → Markdown. */
const roundTrip = (md: string) => docJsonToMarkdown(markdownToDocJson(md));
const blocks = (md: string) => markdownToDocJson(md).content ?? [];
const only = (md: string): JSONContent => {
    const list = blocks(md);
    expect(list).toHaveLength(1);
    return list[0]!;
};
const text = (value: string, marks?: JSONContent['marks']): JSONContent => (marks ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const para = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content });

describe('markdownToDocJson ⇄ docJsonToMarkdown: round trips', () => {
    it.each([
        ['headings 1–3', '# One\n\n## Two\n\n### Three'],
        ['bold, italic, strike, code', 'Some **bold**, *italic*, ~~strike~~ and `code`.'],
        ['underline and highlight', 'An <u>underlined</u> and ==highlighted== word.'],
        ['link with a title', 'See [the docs](https://example.test/a?b=1 "Docs") now.'],
        ['bullet list, nested', '- one\n- two\n  - nested\n  - nested two\n- three'],
        ['ordered list starting at 3', '3. first\n4. second'],
        ['nested task list', '- [ ] todo\n- [x] done\n  - [ ] nested todo\n  - [x] nested done'],
        ['code block with a language', '```ts\nconst x = 1;\nif (a < b && c) return "<details>";\n```'],
        ['mermaid stays a code block', '```mermaid\ngraph TD; A-->B\n```'],
        ['blockquote', '> A wise quote\n>\n> second paragraph'],
        ['horizontal rule', 'Above\n\n---\n\nBelow'],
        ['image', '![A diagram](https://img.example.test/d.png)'],
        ['hard break', 'line one  \nline two'],
        ['toggle', '<details>\n<summary>Answer</summary>\n\nIt is **42**.\n\n</details>'],
        ['open toggle', '<details open>\n<summary>Open one</summary>\n\nBody\n\n</details>'],
        ['nested toggles', '<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nDeep\n\n</details>\n\n</details>'],
        ['callout with a list inside', '> [!TIP]\n> Use **indexes**.\n>\n> - a\n> - b'],
        ['code inside an ordered list item', '1. Run:\n   ```bash\n   npm test\n   ```\n2. Done'],
        ['escaped Markdown characters stay text', 'Stars \\* and a\\_b\\_c and \\[not a link\\]'],
        ['embed', '[Embed: youtube](https://youtu.be/abc)'],
    ])('%s', (_name, md) => {
        expect(roundTrip(md)).toBe(md);
        // …and stays stable on the next trip.
        expect(roundTrip(roundTrip(md))).toBe(md);
    });

    it.each(CALLOUT_KINDS.map((kind) => [kind]))('callout %s', (kind) => {
        const md = `> [!${kind.toUpperCase()}]\n> Body of the ${kind}.`;
        expect(only(md)).toEqual({ type: 'callout', attrs: { kind }, content: [para(text(`Body of the ${kind}.`))] });
        expect(roundTrip(md)).toBe(md);
    });
});

describe('markdownToDocJson: the JSON fits the editor schema', () => {
    it('makes the editor nodes with every attribute filled in', () => {
        const doc = markdownToDocJson('# T\n\n- [x] done\n\n```py\nx = 1\n```\n\n![alt](https://i/x.png "Title")');
        expect(doc.content).toEqual([
            { type: 'heading', attrs: { level: 1 }, content: [text('T')] },
            { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [para(text('done'))] }] },
            { type: 'codeBlock', attrs: { language: 'py' }, content: [text('x = 1')] },
            {
                type: 'resizableImage',
                attrs: { src: 'https://i/x.png', alt: 'alt', title: 'Title', width: '100%', height: 'auto', imageId: null, cloudPublicId: null, cloudProvider: null },
            },
        ]);
        expect(() => getDocSchema().nodeFromJSON(doc).check()).not.toThrow();
    });

    it('links get the editor defaults (doc-link class, new tab)', () => {
        const [link] = only('[x](https://a.test)').content![0]!.marks!;
        expect(link).toEqual({ type: 'link', attrs: { href: 'https://a.test', target: '_blank', rel: 'noopener noreferrer nofollow', class: 'doc-link', title: null } });
    });

    it('caps headings at level 3 (the editor has 1–3)', () => {
        expect(only('#### Deep').attrs).toEqual({ level: 3 });
        expect(roundTrip('###### Deeper')).toBe('### Deeper');
    });

    it('a toggle is details > detailsSummary + detailsContent', () => {
        expect(only('<details open>\n<summary>Why?</summary>\n\nBecause.\n\n</details>')).toEqual({
            type: 'details',
            attrs: { open: true },
            content: [
                { type: 'detailsSummary', content: [text('Why?')] },
                { type: 'detailsContent', content: [para(text('Because.'))] },
            ],
        });
    });

    it('an empty callout or toggle body still holds a paragraph', () => {
        expect(only('> [!NOTE]').content).toEqual([{ type: 'paragraph' }]);
        expect(only('<details>\n<summary>Empty</summary>\n</details>').content![1]).toEqual({ type: 'detailsContent', content: [{ type: 'paragraph' }] });
    });

    it('accepts lower-case alert names and text on the marker line', () => {
        expect(only('> [!warning] Careful here\n> and here')).toEqual({ type: 'callout', attrs: { kind: 'warning' }, content: [para(text('Careful here and here'))] });
    });

    it('a code block keeps its text verbatim (no escaping, spaces kept)', () => {
        const code = 'a*b_c  \n  <details>\n\t[x](y)';
        expect(only(`\`\`\`\n${code}\n\`\`\``)).toEqual({ type: 'codeBlock', attrs: { language: null }, content: [text(code)] });
    });

    it('lifts an image out of a paragraph', () => {
        expect(blocks('Before ![pic](https://i/p.png) after').map((b) => b.type)).toEqual(['paragraph', 'resizableImage', 'paragraph']);
    });

    it('a single line break inside a paragraph is a space; two trailing spaces are a hard break', () => {
        expect(only('one\ntwo').content).toEqual([text('one two')]);
        expect(only('one  \ntwo').content).toEqual([text('one'), { type: 'hardBreak' }, text('two')]);
    });

    it('keeps the text of unsafe links, not the link', () => {
        expect(only('[click](javascript:alert(1)) me').content).toEqual([text('click me')]);
        expect(only('[mail](mailto:a@b.test)').content![0]!.marks![0]!.attrs!['href']).toBe('mailto:a@b.test');
    });

    it('keeps a table as a code block with its Markdown', () => {
        const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
        expect(only(table)).toEqual({ type: 'codeBlock', attrs: { language: null }, content: [text(table)] });
    });

    it('reads `[Embed: kind](url)` back as an embed', () => {
        expect(only('[Embed: youtube](https://youtu.be/abc)')).toEqual({ type: 'embed', attrs: { url: 'https://youtu.be/abc', embedType: 'youtube', width: '100%' } });
        expect(only('[Embed](https://x.test)').attrs!['embedType']).toBe('link');
    });

    it('empty Markdown is a doc with one empty paragraph; markdownToBlocks gives no blocks', () => {
        expect(markdownToDocJson('   \n')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
        expect(markdownToBlocks('  ')).toEqual([]);
    });

    it('rejects nothing a person would write (HTML it cannot place is kept as text)', () => {
        expect(only('<span class="x">hi</span>').content![0]!.text).toContain('hi');
        expect(only('<div>block html</div>').type).toBe('paragraph');
    });

    it('Markdown that is not a string is a 400 ErrorResponse, not a crash', () => {
        expect(() => markdownToDocJson(undefined as unknown as string)).toThrow(ErrorResponse);
    });
});

describe('docJsonToMarkdown: what agents read', () => {
    it('prints text colour as plain text and highlight colours as ==…==', () => {
        const doc = { type: 'doc', content: [para(text('red', [{ type: 'textStyle', attrs: { color: '#f00' } }]), text(' hl', [{ type: 'highlight', attrs: { color: '#ff0' } }]))] };
        expect(docJsonToMarkdown(doc)).toBe('red ==hl==');
    });

    it('prints embeds and media rows as links and images; drops the AI prompt placeholder', () => {
        const doc = {
            type: 'doc',
            content: [
                { type: 'embed', attrs: { url: 'https://youtu.be/x', embedType: 'youtube', width: '100%' } },
                {
                    type: 'mediaRow',
                    attrs: { gap: 8 },
                    content: [
                        { type: 'mediaItem', attrs: { itemType: 'image', src: 'https://i/1.png' } },
                        { type: 'mediaItem', attrs: { itemType: 'embed', url: 'https://x.test/v', embedType: 'twitter' } },
                    ],
                },
                { type: 'inlineAi' },
                para(text('after')),
            ],
        };
        expect(docJsonToMarkdown(doc)).toBe('[Embed: youtube](https://youtu.be/x)\n\n![](https://i/1.png) [Embed: twitter](https://x.test/v)\n\nafter');
    });

    it('reads a stored Yjs state (as the editor wrote it) to Markdown', () => {
        const json = markdownToDocJson('# Notes\n\n> [!IMPORTANT]\n> Locks are **per row**.\n\n- [ ] read MVCC');
        expect(yjsStateToMarkdown(docJsonToYjsState(json))).toBe('# Notes\n\n> [!IMPORTANT]\n> Locks are **per row**.\n\n- [ ] read MVCC');
    });

    it('an empty doc is empty Markdown', () => {
        expect(docJsonToMarkdown({ type: 'doc', content: [] })).toBe('');
        expect(docJsonToMarkdown(null)).toBe('');
    });
});

describe('docJsonToYElements', () => {
    it('encodes blocks exactly like the converter the editor uses (y-prosemirror)', () => {
        const json = markdownToDocJson('## H\n\n> [!TIP]\n> tip\n\n<details>\n<summary>S</summary>\n\nbody\n\n</details>\n\n- [x] t\n\nA **b** [l](https://l.test)');
        const target = new Y.Doc();
        target.getXmlFragment('default').insert(0, docJsonToYElements(json));
        const viaElements = yjsStateToDocJson(Buffer.from(Y.encodeStateAsUpdate(target)).toString('base64'));
        expect(viaElements).toEqual(yjsStateToDocJson(docJsonToYjsState(json)));
        expect(getDocSchema().nodeFromJSON(viaElements).eq(getDocSchema().nodeFromJSON(json))).toBe(true);
        target.destroy();
    });
});

// Side-by-side columns were removed (2026-11-14): stored rows are flattened, see docRepair.test.ts.

describe('inline code with other marks (the editor allows none)', () => {
    const marksOf = (md: string) =>
        (blocks(md)[0]?.content ?? []).map((t) => [t.text, (t.marks ?? []).map((m) => m.type).join('+')]);
    it('bold or italic code keeps only the code, instead of refusing the note', () => {
        expect(marksOf('Use **`create_doc`** and *`x`* here.')).toEqual([
            ['Use ', ''],
            ['create_doc', 'code'],
            [' and ', ''],
            ['x', 'code'],
            [' here.', ''],
        ]);
    });
    it('linked code keeps the link', () => {
        expect(marksOf('See [`useEffect`](https://react.dev).')).toEqual([
            ['See ', ''],
            ['useEffect', 'link'],
            ['.', ''],
        ]);
    });
});

describe('inline marks inside list items', () => {
    const marksIn = (md: string) => {
        const json = JSON.stringify(markdownToDocJson(md));
        return { code: json.includes('"type":"code"'), bold: json.includes('"type":"bold"'), literalTicks: /`i`/.test(json) };
    };
    it('numbered items keep inline code and bold', () => {
        expect(marksIn('1. Put `i` at the left and **j** at the right.\n2. Move the shorter side.')).toEqual({ code: true, bold: true, literalTicks: false });
    });
    it('bulleted items keep inline code and bold', () => {
        expect(marksIn('- Put `i` at the left and **j** at the right.\n- Move.')).toEqual({ code: true, bold: true, literalTicks: false });
    });
});
