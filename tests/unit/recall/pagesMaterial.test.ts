// DOC_PAGES_PLAN §8.2: Quiz me reads a lesson's pages too: the lesson's text, then each page under `## <title>` in tree
// order, until PAGES_MATERIAL_MAX added characters (the lesson's own text is never cut here). No model call.
import { describe, expect, it } from 'vitest';
import { PAGES_MATERIAL_MAX, withPages } from '../../../src/services/recall/material';

describe('a lesson with its pages, as Quiz me reads it', () => {
    it('adds each page under its title, in order', () => {
        const text = withPages('## Idea\n\nA heap keeps the min on top.', [
            { title: 'Practice', markdown: 'Q1: top k.' },
            { title: '  ', markdown: 'Edge cases.' },
        ]);
        expect(text).toBe('## Idea\n\nA heap keeps the min on top.\n\n## Practice\n\nQ1: top k.\n\n## Untitled\n\nEdge cases.');
    });

    it('stops at the cap: the lesson whole, the pages cut', () => {
        const lesson = 'L'.repeat(20_000);
        const text = withPages(lesson, [
            { title: 'One', markdown: 'a'.repeat(8_000) },
            { title: 'Two', markdown: 'b'.repeat(8_000) },
            { title: 'Three', markdown: 'c'.repeat(100) },
        ]);
        expect(text.startsWith(lesson)).toBe(true);
        expect(text.length - lesson.length).toBeLessThanOrEqual(PAGES_MATERIAL_MAX);
        expect(text).toContain('## One');
        expect(text).not.toContain('## Three');
    });
});
