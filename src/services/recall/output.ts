// What Recall asks Claude to return, and how the answer is read back (pure: no SDK calls, no DB).
//
// The JSON schemas go to the API as structured outputs (`output_config.format`), so a normal
// response always parses. They hold no length or count limits (the API's JSON schema subset has
// none): those are in the prompts, and here, where the output is validated with zod and tidied
// (trimmed, clipped, at most 5 questions, ids q1…q5). Batch results and on-demand calls go through
// the same functions.
import { z } from 'zod';

export const RECALL_KINDS = ['recall', 'apply', 'explain', 'pattern', 'complexity', 'edge'] as const;
export type RecallKind = (typeof RECALL_KINDS)[number];

export const RECALL_GRADES = ['strong', 'partial', 'weak'] as const;
export type RecallGradeValue = (typeof RECALL_GRADES)[number];

export const MAX_QUESTIONS = 5;
/** Longest source quote / grading quote kept (the prompts ask for at most 300 characters). */
export const MAX_QUOTE_CHARS = 300;
const MAX_PROMPT_CHARS = 400;
const MAX_ANSWER_KEY_WORDS = 80; // the prompt asks for 40; past twice that it is clipped
const MAX_FEEDBACK_CHARS = 500;

/** A stored question. `answerKey` never goes to the client. */
export interface RecallQuestion {
    id: string;
    kind: RecallKind;
    prompt: string;
    answerKey: string;
    sourceQuote: string;
}

// ─── JSON schemas for the API (structured outputs) ─────────────────────

export const QUESTIONS_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        questions: {
            type: 'array',
            description: '3 to 5 questions.',
            items: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: [...RECALL_KINDS] },
                    prompt: { type: 'string', description: 'The question: one sentence that reads on its own.' },
                    answerKey: { type: 'string', description: 'What a fully correct answer contains, in at most 40 words.' },
                    sourceQuote: {
                        type: 'string',
                        description: 'The passage that supports the answer, copied word for word from the doc, at most 300 characters.',
                    },
                },
                required: ['kind', 'prompt', 'answerKey', 'sourceQuote'],
                additionalProperties: false,
            },
        },
    },
    required: ['questions'],
    additionalProperties: false,
};

export const GRADE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        grade: { type: 'string', enum: [...RECALL_GRADES] },
        feedback: {
            type: 'string',
            description: 'At most two plain sentences to the learner ("you"): what was missing or wrong. Empty for a complete answer.',
        },
        quote: { type: 'string', description: 'The doc passage that best shows the right answer, copied word for word, at most 300 characters.' },
    },
    required: ['grade', 'feedback', 'quote'],
    additionalProperties: false,
};

// ─── Reading the output ────────────────────────────────────────────────

/** The model's output could not be used: declined, cut off, or not the asked-for JSON. */
export class ModelOutputError extends Error {
    readonly reason: 'refused' | 'truncated' | 'invalid';

    constructor(message: string, reason: 'refused' | 'truncated' | 'invalid' = 'invalid') {
        super(message);
        this.name = 'ModelOutputError';
        this.reason = reason;
    }
}

/**
 * The text of a complete response. Checks `stop_reason` first: a refusal (a safety classifier
 * declined, after any fallbacks) or a cut-off output is not a usable answer.
 */
export function responseText(message: { stop_reason: string | null; content: ReadonlyArray<{ type: string; text?: unknown }> }): string {
    if (message.stop_reason === 'refusal') throw new ModelOutputError('The model declined (stop_reason refusal)', 'refused');
    if (message.stop_reason === 'max_tokens') throw new ModelOutputError('The output was cut off (stop_reason max_tokens)', 'truncated');
    return messageText(message.content);
}

const zQuestionsOutput = z.object({
    questions: z.array(
        z.object({
            kind: z.enum(RECALL_KINDS),
            prompt: z.string(),
            answerKey: z.string(),
            sourceQuote: z.string(),
        })
    ),
});

const zGradeOutput = z.object({
    grade: z.enum(RECALL_GRADES),
    feedback: z.string(),
    quote: z.string(),
});

/** The text of a response's `text` blocks (thinking blocks come first and are skipped). */
export function messageText(content: ReadonlyArray<{ type: string; text?: unknown }>): string {
    return content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');
}

/** JSON.parse, or a ModelOutputError. (Also used by the practice note and coach parsers.) */
export function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw new ModelOutputError('The output is not JSON');
    }
}

/** "path: message" of a zod error's first issue. */
export function firstIssue(error: z.ZodError): string {
    const issue = error.issues[0];
    return issue ? `${issue.path.join('.') || 'output'}: ${issue.message}` : 'invalid output';
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** At most `max` characters, cut at a word boundary, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function clipWords(text: string, max: number): string {
    const words = text.split(' ');
    return words.length <= max ? text : `${words.slice(0, max).join(' ')}…`;
}

/**
 * The questions of a question-writing response: trimmed, duplicates and empty ones dropped, at
 * most MAX_QUESTIONS, numbered q1…qN. Throws ModelOutputError when nothing usable is left.
 */
export function parseQuestionsOutput(text: string): RecallQuestion[] {
    const parsed = zQuestionsOutput.safeParse(parseJson(text));
    if (!parsed.success) throw new ModelOutputError(firstIssue(parsed.error));

    const seen = new Set<string>();
    const out: RecallQuestion[] = [];
    for (const q of parsed.data.questions) {
        const prompt = clip(oneLine(q.prompt), MAX_PROMPT_CHARS);
        const answerKey = clipWords(oneLine(q.answerKey), MAX_ANSWER_KEY_WORDS);
        if (!prompt || !answerKey) continue;
        const key = prompt.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: `q${out.length + 1}`, kind: q.kind, prompt, answerKey, sourceQuote: clip(q.sourceQuote.trim(), MAX_QUOTE_CHARS) });
        if (out.length === MAX_QUESTIONS) break;
    }
    if (out.length === 0) throw new ModelOutputError('No usable questions');
    return out;
}

export interface GradeOutput {
    grade: RecallGradeValue;
    feedback: string;
    quote: string | null;
}

/** A grading response. An empty quote falls back to the question's source quote. */
export function parseGradeOutput(text: string, fallbackQuote: string): GradeOutput {
    const parsed = zGradeOutput.safeParse(parseJson(text));
    if (!parsed.success) throw new ModelOutputError(firstIssue(parsed.error));
    const feedback = clip(oneLine(parsed.data.feedback.replace(/\*\*|__/g, '')), MAX_FEEDBACK_CHARS);
    const quote = clip(parsed.data.quote.trim(), MAX_QUOTE_CHARS) || fallbackQuote.trim() || null;
    return { grade: parsed.data.grade, feedback, quote };
}

// ─── Stored JSON (RecallSet.questions) ─────────────────────────────────

const zStoredQuestion = z.object({
    id: z.string().min(1),
    kind: z.enum(RECALL_KINDS).catch('recall'),
    prompt: z.string(),
    answerKey: z.string().catch(''),
    sourceQuote: z.string().catch(''),
});

/** RecallSet.questions as written by this module; malformed entries are skipped. */
export function parseStoredQuestions(value: unknown): RecallQuestion[] {
    if (!Array.isArray(value)) return [];
    const out: RecallQuestion[] = [];
    for (const item of value) {
        const q = zStoredQuestion.safeParse(item);
        if (q.success && q.data.prompt) out.push(q.data);
    }
    return out;
}
