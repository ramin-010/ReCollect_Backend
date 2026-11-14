// What the weekly coach asks Claude to return, and how the answer is read back (pure: no SDK calls,
// no DB). The JSON schema goes to the API as a structured output; the limits it can't express
// (exactly 3 focus lines, the length caps) are in the prompt and enforced here: lines are tidied
// and clipped (≤ 220 / ≤ 140 characters), extra focus lines dropped, and an empty line or fewer than
// 3 usable focus lines is a ModelOutputError (502).
import { z } from 'zod';
import { clip, firstIssue, ModelOutputError, parseJson } from '../recall/output';

export const COACH_LINE_KEYS = ['strong', 'slipping', 'fix', 'deadline'] as const;
export type CoachLineKey = (typeof COACH_LINE_KEYS)[number];
export type CoachLines = Record<CoachLineKey, string>;

export const FOCUS_COUNT = 3;
/** Hard caps (the prompt asks for 200 / 120, leaving room). */
export const MAX_LINE_CHARS = 220;
/** A FocusItem's limit, so a suggested line can be added as it is. */
export const MAX_FOCUS_CHARS = 140;

export interface CoachOutput {
    lines: CoachLines;
    /** Exactly FOCUS_COUNT lines. */
    focus: string[];
}

// ─── JSON schema for the API (structured outputs) ──────────────────────

const line = (description: string) => ({ type: 'string', description: `${description} One or two sentences, at most 200 characters.` });

export const COACH_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        strong: line('What went well this week, specifically.'),
        slipping: line('What is falling behind, specifically.'),
        fix: line('The one change for next week.'),
        deadline: line("Whether the nearest goal's deadline is still realistic at this pace, and why."),
        focus: {
            type: 'array',
            description: 'Exactly 3 focus lines: concrete tasks doable in a day, each at most 120 characters.',
            items: { type: 'string' },
        },
    },
    required: ['strong', 'slipping', 'fix', 'deadline', 'focus'],
    additionalProperties: false,
};

// ─── Reading the output ────────────────────────────────────────────────

const zCoachOutput = z.object({
    strong: z.string(),
    slipping: z.string(),
    fix: z.string(),
    deadline: z.string(),
    focus: z.array(z.string()),
});

/** One line of plain text: no Markdown emphasis or code marks, single spaces. */
const plain = (text: string): string => text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();

/** Focus lines: plain, without list markers, distinct (ignoring case), clipped. */
export function tidyFocus(lines: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of lines) {
        const text = clip(plain(raw).replace(/^(?:\d+[.)]|[-*•])\s+/, ''), MAX_FOCUS_CHARS);
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

/** A coach response → its four lines and exactly 3 focus lines. */
export function parseCoachOutput(text: string): CoachOutput {
    const parsed = zCoachOutput.safeParse(parseJson(text));
    if (!parsed.success) throw new ModelOutputError(firstIssue(parsed.error));
    const lines = {} as CoachLines;
    for (const key of COACH_LINE_KEYS) {
        const value = clip(plain(parsed.data[key]), MAX_LINE_CHARS);
        if (!value) throw new ModelOutputError(`${key}: empty`);
        lines[key] = value;
    }
    const focus = tidyFocus(parsed.data.focus);
    if (focus.length < FOCUS_COUNT) throw new ModelOutputError(`focus: ${focus.length} usable lines, expected ${FOCUS_COUNT}`);
    return { lines, focus: focus.slice(0, FOCUS_COUNT) };
}

// ─── Stored JSON (CoachNote.lines / .focus) ────────────────────────────

/** CoachNote.lines and .focus as written by the service; anything malformed reads as ''. */
export function parseStoredCoach(lines: unknown, focus: unknown): CoachOutput {
    const record = lines && typeof lines === 'object' && !Array.isArray(lines) ? (lines as Record<string, unknown>) : {};
    const out = {} as CoachLines;
    for (const key of COACH_LINE_KEYS) out[key] = typeof record[key] === 'string' ? (record[key] as string) : '';
    return { lines: out, focus: Array.isArray(focus) ? focus.filter((f): f is string => typeof f === 'string') : [] };
}
