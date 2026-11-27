// Files in docs (11-27): the editor's file block (BlockNote's own: url, name, caption) reaches every reader of the
// doc as a link with its name: an agent's read_doc and the export (Markdown), search text and Recall (the old JSON),
// and the outline's first words.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { printBlocks } from '../../../src/services/docs/blocks/markdown';
import { blocksToOldJson } from '../../../src/services/docs/blocks/toOldJson';
import { outline } from '../../../src/services/docs/blocks/docOps';
import { BLOCKS_FRAGMENT, blocksToYElements, type NewBlock } from '../../../src/services/docs/blocks/serverEditor';

const URL = 'https://res.cloudinary.com/demo/raw/upload/v1/notes/rate limits (q3).xlsx';
const blocks: NewBlock[] = [
    { type: 'paragraph', content: [{ type: 'text', text: 'The numbers:', styles: {} }] },
    { type: 'file', props: { url: URL, name: 'rate limits (q3).xlsx', caption: '' } },
    { type: 'file', props: { url: '', name: '' } },
];

describe('the file block', () => {
    it('prints as a link with its name (an empty one prints nothing)', () => {
        // Parentheses in the URL are encoded (they would end the link); in the name they are fine.
        expect(printBlocks(blocks as never)).toBe('The numbers:\n\n[rate limits (q3).xlsx](https://res.cloudinary.com/demo/raw/upload/v1/notes/rate%20limits%20%28q3%29.xlsx)');
    });

    it('is a linked line in the old JSON (search text, Recall), and the outline names it', () => {
        const old = blocksToOldJson(blocks as never);
        const para = old.content?.[1];
        expect(para?.content?.[0]).toMatchObject({ type: 'text', text: 'rate limits (q3).xlsx', marks: [{ type: 'link', attrs: { href: URL } }] });
        const y = new Y.Doc();
        const group = new Y.XmlElement('blockGroup');
        y.getXmlFragment(BLOCKS_FRAGMENT).insert(0, [group]);
        group.insert(0, blocksToYElements(blocks));
        expect(outline(y).map((b) => `${b.type}:${b.text}`)).toEqual(['paragraph:The numbers:', 'file:file rate limits (q3).xlsx', 'file:file']);
    }, 30_000); // the server editor loads slowly beside the rest of the suite
});
