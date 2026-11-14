// Reading a practice note's structured output (src/services/practice/output.ts): the learner's
// code goes in verbatim at the placeholder, the seven sections are checked, the title is tidied.
// No database, no network.
import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import {
    MAX_TITLE_CHARS,
    PRACTICE_NOTE_SCHEMA,
    PRACTICE_SECTIONS,
    SOLUTION_PLACEHOLDER,
    cleanTitle,
    codeLanguage,
    fencedCode,
    insertSolution,
    missingSections,
    parsePracticeNoteOutput,
    tidySolution,
} from '../../../src/services/practice/output';
import { ModelOutputError } from '../../../src/services/recall/output';
import { markdownToDocJson, nodePlainText } from '../../../src/services/docs/markdown/docMarkdown';
import { SAMPLE_NOTE_MARKDOWN, samplePracticeNote } from '../../helpers/claude';

const CODE = [
    'def two_sum(nums, target):',
    '\tseen = {}  ',
    '    for i, x in enumerate(nums):',
    '        seen[x] = i',
    '',
    '',
    '        # ```not a fence``` and a lone fence below',
    '```',
    '        if target - x in seen:',
    '            return [seen[target - x], i]',
].join('\n');

const out = (over: { title?: string; markdown?: string } = {}) => JSON.stringify(samplePracticeNote(over));

function thrown(fn: () => unknown): ModelOutputError {
    try {
        fn();
    } catch (err) {
        if (err instanceof ModelOutputError) return err;
        throw err;
    }
    throw new Error('expected a ModelOutputError');
}

function codeBlocks(md: string): Array<{ language: string | null; text: string }> {
    const blocks: Array<{ language: string | null; text: string }> = [];
    const walk = (node: JSONContent) => {
        if (node.type === 'codeBlock') blocks.push({ language: (node.attrs?.['language'] as string | null) ?? null, text: (node.content ?? []).map((t) => t.text ?? '').join('') });
        (node.content ?? []).forEach(walk);
    };
    walk(markdownToDocJson(md));
    return blocks;
}

const h2s = (md: string): string[] =>
    (markdownToDocJson(md).content ?? []).filter((b) => b.type === 'heading' && b.attrs?.['level'] === 2).map((b) => nodePlainText(b));

describe('the JSON schema sent as output_config.format', () => {
    it('title + markdown, both required, closed, no keyword the structured-outputs subset lacks', () => {
        expect(PRACTICE_NOTE_SCHEMA).toMatchObject({ type: 'object', required: ['title', 'markdown'], additionalProperties: false });
        const keys = JSON.stringify(PRACTICE_NOTE_SCHEMA);
        for (const kw of ['minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'minimum', 'maximum']) expect(keys).not.toContain(kw);
    });
});

describe('parsePracticeNoteOutput', () => {
    it('puts the code in verbatim (tabs, trailing spaces, blank lines, backticks) with the given language; the seven sections in order', () => {
        const note = parsePracticeNoteOutput(out(), { solution: `\n\n${CODE}\n\n`, language: 'python' });
        expect(note.title).toBe('Two Sum');
        expect(note.markdown).not.toContain(SOLUTION_PLACEHOLDER);
        expect(h2s(note.markdown)).toEqual([...PRACTICE_SECTIONS]);
        const [mine, cleaner] = codeBlocks(note.markdown);
        expect(mine).toEqual({ language: 'python', text: CODE });
        expect(cleaner!.text).toContain('def two_sum(nums, target):');
        // A lone ``` line in the code can't close its block: the fence is longer.
        expect(note.markdown).toContain('````python\n');
    });

    it("the given language wins over Claude's fence tag; without one, Claude's tag is used (normalized)", () => {
        const md = SAMPLE_NOTE_MARKDOWN.replace('```python\n{{MY_SOLUTION}}', '```C++\n{{MY_SOLUTION}}');
        expect(codeBlocks(parsePracticeNoteOutput(out({ markdown: md }), { solution: 'int main() {}', language: 'java' }).markdown)[0]!.language).toBe('java');
        expect(codeBlocks(parsePracticeNoteOutput(out({ markdown: md }), { solution: 'int main() {}', language: null }).markdown)[0]!.language).toBe('cpp');
    });

    it('drops a leading "# Title" heading and tidies the title (no numbering, quotes or Markdown; at most 80 characters)', () => {
        const note = parsePracticeNoteOutput(out({ title: '  **1. "Two Sum"**  ', markdown: `# Two Sum\n\n${SAMPLE_NOTE_MARKDOWN}` }), { solution: 'x = 1', language: 'python' });
        expect(note.title).toBe('Two Sum');
        expect(note.markdown.startsWith('## Problem')).toBe(true);
        const long = parsePracticeNoteOutput(out({ title: 'Word '.repeat(40) }), { solution: 'x = 1', language: null });
        expect(long.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
        expect(parsePracticeNoteOutput(out({ title: '   ' }), { solution: 'x = 1', language: null }).title).toBe('Practice note');
    });

    it('a missing section, a non-JSON answer or a wrong shape is a ModelOutputError', () => {
        const noMistakes = SAMPLE_NOTE_MARKDOWN.replace('## My mistakes', '## Pitfalls');
        expect(thrown(() => parsePracticeNoteOutput(out({ markdown: noMistakes }), { solution: 'x = 1', language: null })).message).toBe('Missing sections: My mistakes');
        expect(thrown(() => parsePracticeNoteOutput(out({ markdown: '' }), { solution: 'x = 1', language: null })).message).toMatch(/^Missing sections: Problem, Approach/);
        expect(thrown(() => parsePracticeNoteOutput('Here is your note!', { solution: 'x = 1', language: null })).message).toBe('The output is not JSON');
        expect(thrown(() => parsePracticeNoteOutput(JSON.stringify({ title: 'x' }), { solution: 'x = 1', language: null })).message).toMatch(/^markdown/);
    });

    it('section headings match ignoring case, emphasis and a trailing colon', () => {
        const loose = SAMPLE_NOTE_MARKDOWN.replace('## Recall check', '## **Recall Check:**');
        expect(() => parsePracticeNoteOutput(out({ markdown: loose }), { solution: 'x = 1', language: null })).not.toThrow();
    });
});

describe('insertSolution', () => {
    it('replaces the fence around the placeholder (other lines in it go too) and drops a second placeholder', () => {
        const md = ['## Code', '', '```js', '// mine', SOLUTION_PLACEHOLDER, '```', '', 'Again:', SOLUTION_PLACEHOLDER, '', '## Next'].join('\n');
        const result = insertSolution(md, 'let a = 1;', null);
        expect(result).not.toContain(SOLUTION_PLACEHOLDER);
        expect(result).not.toContain('// mine');
        expect(codeBlocks(result)).toEqual([{ language: 'javascript', text: 'let a = 1;' }]);
        expect(result).toContain('Again:');
    });

    it('a bare placeholder line becomes the block; one inside a sentence just goes', () => {
        expect(codeBlocks(insertSolution(`## Code\n\n${SOLUTION_PLACEHOLDER}\n`, 'x', 'go'))).toEqual([{ language: 'go', text: 'x' }]);
        const inline = insertSolution(`## Code\n\nMy code: ${SOLUTION_PLACEHOLDER}\n`, 'x', null);
        expect(inline).toContain('My code:');
        expect(inline).not.toContain(SOLUTION_PLACEHOLDER);
        expect(codeBlocks(inline)).toEqual([{ language: null, text: 'x' }]);
    });

    it('without a placeholder the code goes right under "## Code"; other fences are left alone', () => {
        const md = ['## Code', '### A cleaner version', '```python', 'print(1)', '```', '## My mistakes'].join('\n');
        const result = insertSolution(md, 'print(0)', 'python');
        expect(codeBlocks(result).map((b) => b.text)).toEqual(['print(0)', 'print(1)']);
    });

    it('only the fence that holds the placeholder is replaced; other fences stay as written', () => {
        const md = ['```text', 'not it', '```', '', '```python', SOLUTION_PLACEHOLDER, '```'].join('\n');
        expect(codeBlocks(insertSolution(md, 'y = 2', null)).map((b) => b.text)).toEqual(['not it', 'y = 2']);
    });
});

describe('the code itself', () => {
    it('tidySolution drops blank lines around the code and CRLF, and nothing else', () => {
        expect(tidySolution('\r\n  \n\tif x:\r\n\t\treturn 1  \r\n\n')).toBe('\tif x:\n\t\treturn 1  ');
    });

    it('fencedCode uses a fence longer than any backtick run in the code', () => {
        expect(fencedCode('a', 'python')).toBe('```python\na\n```');
        expect(fencedCode('s = "````"', null)).toBe('`````\ns = "````"\n`````');
    });

    it('codeLanguage maps common names to the editor tags and keeps unknown ones safe', () => {
        expect(codeLanguage('C++')).toBe('cpp');
        expect(codeLanguage('c++17')).toBe('cpp');
        expect(codeLanguage('Python 3')).toBe('python');
        expect(codeLanguage('python3')).toBe('python');
        expect(codeLanguage('JS')).toBe('javascript');
        expect(codeLanguage('golang')).toBe('go');
        expect(codeLanguage('C#')).toBe('csharp');
        expect(codeLanguage('Java 17')).toBe('java');
        expect(codeLanguage('Scala')).toBe('scala');
        expect(codeLanguage('weird `lang`!')).toBe('weirdlang');
        expect(codeLanguage('  ')).toBeNull();
        expect(codeLanguage(undefined)).toBeNull();
    });

    it('cleanTitle', () => {
        expect(cleanTitle('# 3Sum')).toBe('3Sum');
        expect(cleanTitle('`Two  Sum`')).toBe('Two Sum');
        expect(cleanTitle('42) Trapping Rain Water')).toBe('Trapping Rain Water');
    });

    it('missingSections lists the absent ones in order', () => {
        expect(missingSections(markdownToDocJson('## Problem\n\nx\n\n## Code\n\ny'))).toEqual(['Approach', 'Complexity', 'My mistakes', 'Recall check', 'Similar problems']);
        expect(missingSections(markdownToDocJson('### Problem'))).toContain('Problem'); // ### is not a section
    });
});
