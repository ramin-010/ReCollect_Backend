// Reading Claude's structured output for Recall (src/services/recall/output.ts). No database.
import { describe, expect, it } from 'vitest';
import {
    GRADE_SCHEMA,
    MAX_QUESTIONS,
    MAX_QUOTE_CHARS,
    ModelOutputError,
    QUESTIONS_SCHEMA,
    RECALL_GRADES,
    RECALL_KINDS,
    clip,
    messageText,
    parseGradeOutput,
    parseQuestionsOutput,
    parseStoredQuestions,
    responseText,
} from '../../../src/services/recall/output';

const q = (over: Record<string, unknown> = {}) => ({
    kind: 'recall',
    prompt: 'What invariant does a monotonic stack keep?',
    answerKey: 'Elements stay in decreasing order from bottom to top.',
    sourceQuote: 'The stack is kept in decreasing order.',
    ...over,
});
const out = (questions: unknown[]) => JSON.stringify({ questions });

function thrown(fn: () => unknown): ModelOutputError {
    try {
        fn();
    } catch (err) {
        if (err instanceof ModelOutputError) return err;
        throw err;
    }
    throw new Error('expected a ModelOutputError');
}

describe('the JSON schemas sent as output_config.format', () => {
    it('questions: every object closed, every field required, the six kinds', () => {
        const items = (QUESTIONS_SCHEMA as any).properties.questions.items;
        expect((QUESTIONS_SCHEMA as any).additionalProperties).toBe(false);
        expect((QUESTIONS_SCHEMA as any).required).toEqual(['questions']);
        expect(items.additionalProperties).toBe(false);
        expect(items.required).toEqual(['kind', 'prompt', 'answerKey', 'sourceQuote']);
        expect(items.properties.kind.enum).toEqual([...RECALL_KINDS]);
    });

    it('grade: strong | partial | weak, feedback and quote, closed', () => {
        expect((GRADE_SCHEMA as any).additionalProperties).toBe(false);
        expect((GRADE_SCHEMA as any).required).toEqual(['grade', 'feedback', 'quote']);
        expect((GRADE_SCHEMA as any).properties.grade.enum).toEqual([...RECALL_GRADES]);
    });

    it('use no keyword the structured-outputs JSON schema subset lacks', () => {
        const keys = new Set<string>();
        const walk = (node: unknown): void => {
            if (Array.isArray(node)) node.forEach(walk);
            else if (node && typeof node === 'object')
                for (const [k, v] of Object.entries(node)) {
                    // `properties` maps field names (not keywords) to schemas.
                    if (k === 'properties') Object.values(v as object).forEach(walk);
                    else {
                        keys.add(k);
                        walk(v);
                    }
                }
        };
        walk([QUESTIONS_SCHEMA, GRADE_SCHEMA]);
        for (const kw of ['minLength', 'maxLength', 'minimum', 'maximum', 'maxItems', 'minItems', 'pattern', 'format']) expect(keys.has(kw)).toBe(false);
        expect([...keys].sort()).toEqual(['additionalProperties', 'description', 'enum', 'items', 'required', 'type']);
    });
});

describe('parseQuestionsOutput', () => {
    it('numbers the questions q1… and tidies whitespace', () => {
        const questions = parseQuestionsOutput(out([q({ prompt: '  What   invariant\n does a monotonic stack keep? ' }), q({ kind: 'complexity', prompt: 'Why is it O(n)?' })]));
        expect(questions).toEqual([
            { id: 'q1', kind: 'recall', prompt: 'What invariant does a monotonic stack keep?', answerKey: q().answerKey, sourceQuote: q().sourceQuote },
            { id: 'q2', kind: 'complexity', prompt: 'Why is it O(n)?', answerKey: q().answerKey, sourceQuote: q().sourceQuote },
        ]);
    });

    it(`keeps at most ${MAX_QUESTIONS} questions`, () => {
        const many = Array.from({ length: 7 }, (_, i) => q({ prompt: `Question number ${i + 1}?` }));
        const questions = parseQuestionsOutput(out(many));
        expect(questions).toHaveLength(MAX_QUESTIONS);
        expect(questions.map((x) => x.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    });

    it('drops duplicates and questions without a prompt or an answer key', () => {
        const questions = parseQuestionsOutput(out([q(), q({ prompt: 'WHAT INVARIANT DOES A MONOTONIC STACK KEEP?' }), q({ prompt: '   ' }), q({ prompt: 'Other?', answerKey: '' }), q({ prompt: 'Kept?' })]));
        expect(questions.map((x) => x.prompt)).toEqual(['What invariant does a monotonic stack keep?', 'Kept?']);
        expect(questions.map((x) => x.id)).toEqual(['q1', 'q2']);
    });

    it(`clips a source quote to ${MAX_QUOTE_CHARS} characters at a word boundary`, () => {
        const long = 'word '.repeat(100).trim();
        const [first] = parseQuestionsOutput(out([q({ sourceQuote: long })]));
        expect(first!.sourceQuote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
        expect(first!.sourceQuote.endsWith('word…')).toBe(true);
    });

    it('rejects output that is not the schema: not JSON, an unknown kind, a missing field, nothing usable', () => {
        expect(thrown(() => parseQuestionsOutput('Here are your questions: …')).message).toMatch(/not JSON/);
        expect(thrown(() => parseQuestionsOutput(out([q({ kind: 'trivia' })]))).message).toMatch(/kind/);
        expect(thrown(() => parseQuestionsOutput(JSON.stringify({ questions: [{ kind: 'recall', prompt: 'x?' }] }))).message).toMatch(/answerKey/);
        expect(thrown(() => parseQuestionsOutput(JSON.stringify({ items: [] }))).message).toMatch(/questions/);
        expect(thrown(() => parseQuestionsOutput(out([]))).message).toMatch(/No usable questions/);
        expect(thrown(() => parseQuestionsOutput(out([q({ prompt: '' })]))).reason).toBe('invalid');
    });
});

describe('parseGradeOutput', () => {
    it('reads grade, feedback and quote', () => {
        const g = parseGradeOutput(JSON.stringify({ grade: 'partial', feedback: ' You left out **why** it is O(n). ', quote: 'Each element is pushed and popped once.' }), 'fallback');
        expect(g).toEqual({ grade: 'partial', feedback: 'You left out why it is O(n).', quote: 'Each element is pushed and popped once.' });
    });

    it("an empty quote falls back to the question's source quote, else null", () => {
        expect(parseGradeOutput(JSON.stringify({ grade: 'strong', feedback: '', quote: '  ' }), 'The source passage.').quote).toBe('The source passage.');
        expect(parseGradeOutput(JSON.stringify({ grade: 'strong', feedback: '', quote: '' }), '').quote).toBeNull();
    });

    it('rejects an unknown grade or missing fields', () => {
        expect(() => parseGradeOutput(JSON.stringify({ grade: 'excellent', feedback: '', quote: '' }), '')).toThrow(ModelOutputError);
        expect(() => parseGradeOutput(JSON.stringify({ grade: 'weak' }), '')).toThrow(ModelOutputError);
    });
});

describe('responseText (stop reasons first)', () => {
    const text = (t: string) => ({ type: 'text', text: t });

    it('joins the text blocks and skips thinking blocks', () => {
        expect(responseText({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' } as any, text('{"a":'), text('1}')] })).toBe('{"a":1}');
        expect(messageText([text('x'), { type: 'tool_use' }])).toBe('x');
    });

    it('a refusal or a cut-off output is not usable', () => {
        expect(thrown(() => responseText({ stop_reason: 'refusal', content: [] })).reason).toBe('refused');
        expect(thrown(() => responseText({ stop_reason: 'max_tokens', content: [text('{"questions": [')] })).reason).toBe('truncated');
    });
});

describe('parseStoredQuestions', () => {
    it('reads RecallSet.questions leniently and skips malformed entries', () => {
        const stored = [
            { id: 'q1', kind: 'edge', prompt: 'P1', answerKey: 'K1', sourceQuote: 'S1' },
            { id: 'q2', kind: 'unknown-kind', prompt: 'P2', answerKey: 'K2', sourceQuote: 'S2' },
            { id: 'q3', prompt: '' },
            'junk',
            { kind: 'recall', prompt: 'no id' },
        ];
        expect(parseStoredQuestions(stored)).toEqual([
            { id: 'q1', kind: 'edge', prompt: 'P1', answerKey: 'K1', sourceQuote: 'S1' },
            { id: 'q2', kind: 'recall', prompt: 'P2', answerKey: 'K2', sourceQuote: 'S2' },
        ]);
        expect(parseStoredQuestions(null)).toEqual([]);
    });
});

describe('clip', () => {
    it('leaves short text alone and cuts long text with an ellipsis', () => {
        expect(clip('short', 10)).toBe('short');
        expect(clip('aaaa bbbb cccc dddd', 12)).toBe('aaaa bbbb…');
        expect(clip('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
    });
});
