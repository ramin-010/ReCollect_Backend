// Reading the weekly coach's structured output (src/services/coach/output.ts): exactly 3 focus
// lines, the length caps, plain text. No database, no network.
import { describe, expect, it } from 'vitest';
import {
    COACH_LINE_KEYS,
    COACH_SCHEMA,
    FOCUS_COUNT,
    MAX_FOCUS_CHARS,
    MAX_LINE_CHARS,
    parseCoachOutput,
    parseStoredCoach,
    tidyFocus,
} from '../../../src/services/coach/output';
import { ModelOutputError } from '../../../src/services/recall/output';
import { sampleCoach } from '../../helpers/claude';

const out = (over: Parameters<typeof sampleCoach>[0] = {}) => JSON.stringify(sampleCoach(over));

function thrown(fn: () => unknown): ModelOutputError {
    try {
        fn();
    } catch (err) {
        if (err instanceof ModelOutputError) return err;
        throw err;
    }
    throw new Error('expected a ModelOutputError');
}

describe('the JSON schema sent as output_config.format', () => {
    it('the four lines and the focus array, all required, closed', () => {
        expect(COACH_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false, required: ['strong', 'slipping', 'fix', 'deadline', 'focus'] });
        expect((COACH_SCHEMA as any).properties.focus).toMatchObject({ type: 'array', items: { type: 'string' } });
    });

    it('uses no keyword the structured-outputs subset lacks (the counts and caps are enforced in code)', () => {
        const text = JSON.stringify(COACH_SCHEMA);
        for (const kw of ['minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum']) expect(text).not.toContain(`"${kw}"`);
    });
});

describe('parseCoachOutput', () => {
    it('the four lines and exactly 3 focus lines', () => {
        const parsed = parseCoachOutput(out());
        expect(parsed.lines).toEqual({
            strong: sampleCoach().strong,
            slipping: sampleCoach().slipping,
            fix: sampleCoach().fix,
            deadline: sampleCoach().deadline,
        });
        expect(parsed.focus).toEqual(sampleCoach().focus);
        expect(Object.keys(parsed.lines)).toEqual([...COACH_LINE_KEYS]);
    });

    it(`keeps the first ${FOCUS_COUNT} focus lines of more`, () => {
        expect(parseCoachOutput(out({ focus: ['a one', 'b two', 'c three', 'd four'] })).focus).toEqual(['a one', 'b two', 'c three']);
    });

    it(`fewer than ${FOCUS_COUNT} usable focus lines is an error (empty and repeated lines don't count)`, () => {
        expect(thrown(() => parseCoachOutput(out({ focus: ['Only one', 'And two'] }))).message).toBe('focus: 2 usable lines, expected 3');
        expect(thrown(() => parseCoachOutput(out({ focus: ['Same line', 'same  LINE', '  '] }))).message).toBe('focus: 1 usable lines, expected 3');
        expect(thrown(() => parseCoachOutput(out({ focus: [] }))).reason).toBe('invalid');
    });

    it(`caps lines at ${MAX_LINE_CHARS} and focus lines at ${MAX_FOCUS_CHARS} characters (cut at a word, with an ellipsis)`, () => {
        const parsed = parseCoachOutput(out({ strong: 'word '.repeat(80), focus: ['task '.repeat(50), 'b', 'c'] }));
        expect(parsed.lines.strong.length).toBeLessThanOrEqual(MAX_LINE_CHARS);
        expect(parsed.lines.strong.endsWith('…')).toBe(true);
        expect(parsed.focus[0]!.length).toBeLessThanOrEqual(MAX_FOCUS_CHARS);
        expect(parsed.focus[0]!.endsWith('…')).toBe(true);
    });

    it('plain text: no Markdown, single spaces, no list markers on focus lines', () => {
        const parsed = parseCoachOutput(out({ fix: '**Clear  reviews**\n first `daily`.', focus: ['1. Re-test Dijkstra', '- Clear 2 reviews', '• Draft the plan'] }));
        expect(parsed.lines.fix).toBe('Clear reviews first daily.');
        expect(parsed.focus).toEqual(['Re-test Dijkstra', 'Clear 2 reviews', 'Draft the plan']);
    });

    it('an empty line, a non-JSON answer or a wrong shape is a ModelOutputError', () => {
        expect(thrown(() => parseCoachOutput(out({ deadline: '   ' }))).message).toBe('deadline: empty');
        expect(thrown(() => parseCoachOutput('Here is your week!')).message).toBe('The output is not JSON');
        expect(thrown(() => parseCoachOutput(JSON.stringify({ strong: 'x' }))).message).toMatch(/^slipping/);
    });
});

describe('tidyFocus and the stored JSON', () => {
    it('tidyFocus keeps order and drops empties and repeats', () => {
        expect(tidyFocus(['  A  ', '', 'a', 'B'])).toEqual(['A', 'B']);
    });

    it('parseStoredCoach reads what the service wrote and tolerates anything else', () => {
        const lines = { strong: 's', slipping: 'p', fix: 'f', deadline: 'd' };
        expect(parseStoredCoach(lines, ['1', '2', '3'])).toEqual({ lines, focus: ['1', '2', '3'] });
        expect(parseStoredCoach(null, 'x')).toEqual({ lines: { strong: '', slipping: '', fix: '', deadline: '' }, focus: [] });
        expect(parseStoredCoach({ strong: 3 }, ['a', 4])).toEqual({ lines: { strong: '', slipping: '', fix: '', deadline: '' }, focus: ['a'] });
    });
});
