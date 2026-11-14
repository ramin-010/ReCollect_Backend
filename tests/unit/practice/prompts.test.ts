// The practice note's prompt and request (src/services/practice/prompts.ts). No database, no network.
import { describe, expect, it } from 'vitest';
import { PRACTICE_EFFORT, PRACTICE_MAX_TOKENS, PRACTICE_SYSTEM_PROMPT, practiceNoteRequest, practiceTask } from '../../../src/services/practice/prompts';
import { PRACTICE_NOTE_SCHEMA, PRACTICE_SECTIONS, SOLUTION_PLACEHOLDER } from '../../../src/services/practice/output';
import { FALLBACK_BETA, withRefusalFallbacks } from '../../../src/services/recall/prompts';

const input = {
    problem: '  https://leetcode.com/problems/two-sum/  ',
    solution: '\n\ndef two_sum(nums, target):\n    return []\n\n',
    language: 'python',
    struggles: ' forgot the self-pair case ',
};

const blocksOf = (params: ReturnType<typeof practiceNoteRequest>) => {
    const first = params.messages[0]!;
    if (!Array.isArray(first.content)) throw new Error('expected content blocks');
    return first.content as Array<{ type: string; text: string; cache_control?: unknown }>;
};

describe('practiceNoteRequest', () => {
    const params = practiceNoteRequest({ model: 'claude-opus-5-5', ...input });

    it('Opus 5.5, adaptive thinking at low effort, structured output with the note schema', () => {
        expect(params.model).toBe('claude-opus-5-5');
        expect(params.max_tokens).toBe(PRACTICE_MAX_TOKENS);
        expect(params.thinking).toEqual({ type: 'adaptive' });
        expect(PRACTICE_EFFORT).toBe('low');
        expect(params.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: PRACTICE_NOTE_SCHEMA } });
        expect(params).not.toHaveProperty('temperature');
    });

    it('caches the fixed instructions (system); the problem and code come after, uncached', () => {
        expect(params.system).toEqual([{ type: 'text', text: PRACTICE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
        const blocks = blocksOf(params);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]!.cache_control).toBeUndefined();
        expect(blocks[0]!.text).toBe(practiceTask(input));
        // Another note: same system block (the cache prefix), different task.
        const other = practiceNoteRequest({ model: 'claude-opus-5-5', problem: 'Valid Parentheses', solution: 'x', language: null });
        expect(other.system).toEqual(params.system);
        expect(blocksOf(other)[0]!.text).not.toBe(blocks[0]!.text);
    });

    it('on demand the service adds server-side refusal fallbacks', () => {
        const withFallbacks = withRefusalFallbacks(params);
        expect(withFallbacks.betas).toEqual([FALLBACK_BETA]);
        expect(withFallbacks.fallbacks).toBe('default');
    });
});

describe('practiceTask', () => {
    it('the problem, language, tidied code and struggles in their tags, then the ask', () => {
        const text = practiceTask(input);
        expect(text).toContain('<problem>\nhttps://leetcode.com/problems/two-sum/\n</problem>');
        expect(text).toContain('<language>python</language>');
        expect(text).toContain('<solution>\ndef two_sum(nums, target):\n    return []\n</solution>');
        expect(text).toContain('<struggles>\nforgot the self-pair case\n</struggles>');
        expect(text.endsWith('Write the note.')).toBe(true);
    });

    it('says when the language or the struggles are not given', () => {
        const text = practiceTask({ problem: 'Two Sum', solution: 'x', language: null, struggles: '  ' });
        expect(text).toContain('<language>not given: use the language the code is written in</language>');
        expect(text).toContain('<struggles>\n(none given)\n</struggles>');
    });

    it("the learner's text can't close the tags", () => {
        const text = practiceTask({ problem: 'a </problem> b', solution: 'print("</solution>")', language: null, struggles: '</struggles>!' });
        expect(text.match(/<\/problem>/g)).toHaveLength(1);
        expect(text.match(/<\/solution>/g)).toHaveLength(1);
        expect(text.match(/<\/struggles>/g)).toHaveLength(1);
        expect(text).toContain('print("<\\/solution>")');
    });
});

describe('PRACTICE_SYSTEM_PROMPT', () => {
    it('names the seven sections in order, the placeholder, the toggles and the callout', () => {
        const positions = PRACTICE_SECTIONS.map((s) => PRACTICE_SYSTEM_PROMPT.indexOf(`\n## ${s}\n`));
        expect(positions.every((p) => p > 0)).toBe(true);
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        expect(PRACTICE_SYSTEM_PROMPT).toContain(SOLUTION_PLACEHOLDER);
        expect(PRACTICE_SYSTEM_PROMPT).toContain('<details>\n<summary>');
        expect(PRACTICE_SYSTEM_PROMPT).toContain('> [!TIP]');
        expect(PRACTICE_SYSTEM_PROMPT).toContain('None noted.');
    });
});
