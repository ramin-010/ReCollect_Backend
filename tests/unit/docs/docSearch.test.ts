// Doc search's pure parts (src/services/docs/docSearch.service.ts): a doc's words, a query's words,
// and the snippet made from ts_headline's text (marks as offsets, the lead cut so the match shows).
import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { SNIPPET_MAX, docPlainText, searchTerms, snippetFrom } from '../../../src/services/docs/docSearch.service';

const S = '\u0002';
const E = '\u0003';

describe('docPlainText', () => {
    it('puts each textblock on its line, with embed links and the words on a canvas board', () => {
        const doc: JSONContent = {
            type: 'doc',
            content: [
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Rate limiter' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Token ' }, { type: 'text', text: 'bucket', marks: [{ type: 'bold' }] }] },
                { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'refill rate' }] }] }] },
                { type: 'paragraph' },
                { type: 'embed', attrs: { url: 'https://example.com/limits' } },
                {
                    type: 'canvas',
                    attrs: {
                        data: {
                            nodes: [
                                { id: 'a', text: 'API gateway' },
                                { id: 'b', text: 'Redis' },
                            ],
                            edges: [{ id: 'e', from: 'a', to: 'b', label: 'checks' }],
                        },
                    },
                },
            ],
        };
        expect(docPlainText(doc)).toBe('Rate limiter\nToken bucket\nrefill rate\nhttps://example.com/limits\nAPI gateway\nRedis\nchecks');
    });
});

describe('searchTerms', () => {
    it('keeps letters and digits, lower case, each word once, at most 8', () => {
        expect(searchTerms('  Rate-Limiter  design, RATE ')).toEqual(['rate', 'limiter', 'design']);
        expect(searchTerms('O(n) C++ 3sum')).toEqual(['o', 'n', 'c', '3sum']);
        expect(searchTerms('Café über naïve')).toEqual(['café', 'über', 'naïve']);
        expect(searchTerms('a b c d e f g h i j')).toHaveLength(8);
        expect(searchTerms('%% ++ ::')).toEqual([]);
    });
});

describe('snippetFrom', () => {
    it('the first block with a match and the blocks after it, marks as offsets, whitespace collapsed', () => {
        const { snippet, marks } = snippetFrom(`How groups work\nRow ${S}locks${E}  block writers,\tnot ${S}readers${E}\nOffsets ${S}locks${E}`);
        expect(snippet).toBe('Row locks block writers, not readers · Offsets locks');
        expect(marks.map(([a, b]) => snippet.slice(a, b))).toEqual(['locks', 'readers', 'locks']);
    });

    it('a block that repeats the title does not count', () => {
        expect(snippetFrom(`${S}Heaps${E} & priority queues\nTop-k: a min-${S}heap${E} of size k`, 'Heaps & priority queues').snippet).toBe('Top-k: a min-heap of size k');
        // Only the title matched: no marks, so the library shows no snippet (agents get the first block).
        expect(snippetFrom(`${S}Tries${E}\nNotes on prefixes.`, 'Tries')).toEqual({ snippet: 'Notes on prefixes.', marks: [] });
    });

    it('cuts the lead so the first match shows, and the tail at the limit', () => {
        const lead = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';
        const tail = ' and then some more words'.repeat(10);
        const { snippet, marks } = snippetFrom(`${lead} ${S}gateway${E}${tail}`);
        expect(snippet.startsWith('…')).toBe(true);
        expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX + 1);
        expect(snippet.endsWith('…')).toBe(true);
        expect(marks).toHaveLength(1);
        expect(snippet.slice(marks[0]![0], marks[0]![1])).toBe('gateway');
        expect(marks[0]![0]).toBeLessThanOrEqual(61);
    });

    it('a short block keeps its start; no marks gives the first block; empty stays empty', () => {
        expect(snippetFrom(`Virtual nodes smooth the load across the ${S}ring${E}`).snippet).toBe('Virtual nodes smooth the load across the ring');
        expect(snippetFrom('A cache keeps\nhot rows.')).toEqual({ snippet: 'A cache keeps · hot rows.', marks: [] });
        expect(snippetFrom('')).toEqual({ snippet: '', marks: [] });
    });
});
