// DOC_PAGES_PLAN §5 (stage 5): the page block. A line that is one link to /docs/<id> becomes a page block; a page
// block prints back as that line with the title the reader may see, and prints nothing without one (search, previews).
import { describe, expect, it } from 'vitest';
import { markdownToDocJson } from '../../../src/services/docs/markdown/docMarkdown';
import { markdownToBlocks, printBlocks } from '../../../src/services/docs/blocks/markdown';
import { blocksToOldJson, pageIdsIn } from '../../../src/services/docs/blocks/toOldJson';
import { pageLinkOf } from '../../../src/services/docs/blocks/fromOldJson';

describe('the page block', () => {
    it('U2: a line holding one relative link to /docs/<id> keeps its href', () => {
        const json = markdownToDocJson('[Redis eviction](/docs/cmabc123)');
        const para = json.content?.[0];
        expect(para?.type).toBe('paragraph');
        const text = para?.content?.[0];
        expect(text?.text).toBe('Redis eviction');
        expect(text?.marks?.find((m) => m.type === 'link')?.attrs?.['href']).toBe('/docs/cmabc123');
    });

    it('a line that is one link to /docs/<id> (relative or on any host) is a page; other lines stay text', () => {
        const link = (href: string, text = 'X') => ({ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }] });
        expect(pageLinkOf(link('/docs/abc123'))).toBe('abc123');
        expect(pageLinkOf(link('https://kaaga.in/docs/abc123'))).toBe('abc123');
        expect(pageLinkOf(link('/docs/abc123/'))).toBe('abc123');
        expect(pageLinkOf(link('/docs'))).toBeNull();
        expect(pageLinkOf(link('https://example.com/abc'))).toBeNull();
        expect(pageLinkOf({ type: 'paragraph', content: [{ type: 'text', text: 'See ' }, link('/docs/abc123').content[0]!] })).toBeNull();
    });

    it('round trip: the link line makes a page block, which prints back with the title it is given (nothing without one)', async () => {
        const { blocks } = await markdownToBlocks('## Pages\n\n[Redis eviction](/docs/cmabc123)\n\nAfter it.', {}, { checkMermaid: false });
        const page = blocks.find((b) => b.type === 'page');
        expect(page?.props).toEqual({ docId: 'cmabc123' });
        expect(pageIdsIn(blocks)).toEqual(['cmabc123']);
        const titles = new Map([['cmabc123', 'Redis eviction (renamed)']]);
        expect(printBlocks(blocks, { pageTitles: titles })).toBe('## Pages\n\n[Redis eviction (renamed)](/docs/cmabc123)\n\nAfter it.');
        expect(printBlocks(blocks)).toBe('## Pages\n\nAfter it.');
        const old = blocksToOldJson(blocks, { pageTitles: titles });
        expect(JSON.stringify(old)).toContain('"href":"/docs/cmabc123"');
        expect(JSON.stringify(blocksToOldJson(blocks))).not.toContain('cmabc123');
    });
});
