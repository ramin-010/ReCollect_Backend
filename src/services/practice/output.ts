// What a practice note asks Claude to return, and how the answer becomes the doc's Markdown (pure:
// no SDK calls, no DB).
//
// Claude writes the note around a placeholder line (SOLUTION_PLACEHOLDER) and the learner's code is
// put there here, verbatim: the model never retypes the code (no silent "fixes", and no output
// tokens spent on code we already have). The finished Markdown must parse as a doc, keep the code
// as one code block, and have the seven ## sections; anything else is a ModelOutputError (502).
import { z } from 'zod';
import type { JSONContent } from '@tiptap/core';
import ErrorResponse from '../../utils/errorResponse';
import { markdownToDocJson, nodePlainText } from '../docs/markdown/docMarkdown';
import { clip, firstIssue, ModelOutputError, parseJson } from '../recall/output';

/** The line Claude writes where the learner's code goes. */
export const SOLUTION_PLACEHOLDER = '{{MY_SOLUTION}}';

/** The note's ## sections, in order. */
export const PRACTICE_SECTIONS = ['Problem', 'Approach', 'Complexity', 'Code', 'My mistakes', 'Recall check', 'Similar problems'] as const;

export const MAX_TITLE_CHARS = 80;
const FALLBACK_TITLE = 'Practice note';

// ─── JSON schema for the API (structured outputs) ──────────────────────

export const PRACTICE_NOTE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        title: { type: 'string', description: "The problem's usual name, at most 80 characters, no Markdown." },
        markdown: { type: 'string', description: 'The note body in the doc dialect: the seven ## sections, from ## Problem to ## Similar problems.' },
    },
    required: ['title', 'markdown'],
    additionalProperties: false,
};

// ─── Code languages ────────────────────────────────────────────────────

/** Common names → the tags the editor highlights (recollect/lib/editor/codeLanguages.ts). */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
    'c++': 'cpp', cpp: 'cpp', cxx: 'cpp', cc: 'cpp',
    'c#': 'csharp', cs: 'csharp', csharp: 'csharp',
    py: 'python', python: 'python',
    js: 'javascript', javascript: 'javascript', node: 'javascript', nodejs: 'javascript',
    ts: 'typescript', typescript: 'typescript',
    go: 'go', golang: 'go',
    java: 'java', kotlin: 'kotlin', kt: 'kotlin',
    rust: 'rust', rs: 'rust', ruby: 'ruby', rb: 'ruby', swift: 'swift', c: 'c',
    sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql',
    bash: 'bash', sh: 'bash', shell: 'bash',
};

/**
 * A language name as a code block tag: "C++17" → cpp, "Python 3" → python, "Scala" → scala.
 * Null when there is none. Unknown names are kept (lower case, safe characters only).
 */
export function codeLanguage(name: string | null | undefined): string | null {
    const raw = (name ?? '').trim().toLowerCase();
    if (!raw) return null;
    const base = raw.replace(/[\s-]*v?\d+(?:\.\d+)*$/, '').trim() || raw; // a trailing version
    const known = LANGUAGE_ALIASES[base] ?? LANGUAGE_ALIASES[raw];
    if (known) return known;
    const tag = base.replace(/[^a-z0-9+#.-]+/g, '').slice(0, 20);
    return tag || null;
}

// ─── The learner's code ────────────────────────────────────────────────

/** The code as pasted, without blank lines before and after it (CRLF → LF). Nothing else changes. */
export function tidySolution(code: string): string {
    const lines = code.replace(/\r\n?/g, '\n').split('\n');
    while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
    while (lines.length > 0 && !lines[lines.length - 1]!.trim()) lines.pop();
    return lines.join('\n');
}

/** A fenced block of `code`, its fence longer than any run of backticks in it (nothing inside can close it). */
export function fencedCode(code: string, language: string | null): string {
    const longest = (code.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}${language ?? ''}\n${code}\n${fence}`;
}

const FENCE_OPEN = /^ {0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const CODE_HEADING = /^ {0,3}##[ \t]+code[ \t]*:?[ \t]*#*[ \t]*$/i;

interface Fence {
    /** Line index of the opening fence. */
    start: number;
    /** Line index of the closing fence (the last line when it is never closed). */
    end: number;
    /** The info string's first word (the language tag). */
    tag: string;
}

/** The top-level fenced code blocks of some Markdown lines. */
function fencesOf(lines: readonly string[]): Fence[] {
    const fences: Fence[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const open = FENCE_OPEN.exec(lines[i]!);
        if (!open) continue;
        const marker = open[1] ?? open[3]!;
        let end = lines.length - 1;
        for (let j = i + 1; j < lines.length; j += 1) {
            const close = FENCE_CLOSE.exec(lines[j]!);
            if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
                end = j;
                break;
            }
        }
        fences.push({ start: i, end, tag: (open[2] ?? open[4] ?? '').trim().split(/\s+/)[0] ?? '' });
        i = end;
    }
    return fences;
}

/**
 * The Markdown with the learner's code where Claude put the placeholder: the fence around the
 * placeholder (or the bare placeholder line) becomes one fenced block of the code, verbatim, tagged
 * with `language`, else with the tag Claude gave that fence. Further placeholders are dropped.
 * Without a placeholder, the code goes right under the "## Code" heading.
 */
export function insertSolution(markdown: string, code: string, language: string | null): string {
    const lines = markdown.split('\n');
    const fences = new Map(fencesOf(lines).map((f) => [f.start, f]));
    const out: string[] = [];
    let placed = false;
    let codeHeading = -1;
    const place = (tag: string | null) => {
        if (!placed) out.push('', fencedCode(code, language ?? tag), '');
        placed = true;
    };

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        const fence = fences.get(i);
        if (fence) {
            const body = lines.slice(fence.start + 1, fence.end);
            if (body.some((l) => l.trim() === SOLUTION_PLACEHOLDER)) place(codeLanguage(fence.tag));
            else out.push(...lines.slice(fence.start, fence.end + 1));
            i = fence.end;
            continue;
        }
        if (line.trim() === SOLUTION_PLACEHOLDER) {
            place(null);
            continue;
        }
        if (line.includes(SOLUTION_PLACEHOLDER)) {
            // Mentioned inside a sentence: the words stay, the placeholder goes.
            const rest = line.split(SOLUTION_PLACEHOLDER).join('').trimEnd();
            if (rest.trim()) out.push(rest);
            continue;
        }
        if (codeHeading < 0 && CODE_HEADING.test(line)) codeHeading = out.length;
        out.push(line);
    }
    if (!placed && codeHeading >= 0) out.splice(codeHeading + 1, 0, '', fencedCode(code, language), '');
    return out.join('\n');
}

// ─── Reading the output ────────────────────────────────────────────────

const zPracticeOutput = z.object({ title: z.string(), markdown: z.string() });

/** A finished note: the doc's title and Markdown (the learner's code already in it). */
export interface PracticeNote {
    title: string;
    markdown: string;
}

/** The problem's name as a doc title: one line, no Markdown, quotes or "1." numbering, at most 80 characters. */
export function cleanTitle(raw: string): string {
    const numbering = /^\d+\s*[.)]\s+/;
    const text = raw
        .replace(/\s+/g, ' ')
        .replace(/\*\*|__|`/g, '')
        .replace(/^\s*#+\s*/, '')
        .trim()
        .replace(numbering, '')
        .replace(/^["'“‘]+|["'”’]+$/g, '')
        .replace(numbering, '')
        .trim();
    return clip(text, MAX_TITLE_CHARS);
}

/** Without a leading "# Title" line (the doc's title is shown separately). */
function withoutTitleHeading(markdown: string): string {
    return markdown.replace(/^\s*#[ \t]+[^\n]*(?:\n|$)/, '');
}

const sectionKey = (text: string): string =>
    text
        .replace(/[*_`~]/g, '')
        .replace(/:\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

/** The PRACTICE_SECTIONS that are not a ## heading of the doc. */
export function missingSections(doc: JSONContent): string[] {
    const found = new Set(
        (doc.content ?? []).filter((b) => b.type === 'heading' && Number(b.attrs?.['level']) === 2).map((b) => sectionKey(nodePlainText(b)))
    );
    return PRACTICE_SECTIONS.filter((s) => !found.has(s.toLowerCase()));
}

/** True when one code block of the doc holds exactly `code`. */
function hasCodeBlock(doc: JSONContent, code: string): boolean {
    const walk = (node: JSONContent): boolean =>
        (node.type === 'codeBlock' && (node.content ?? []).map((t) => t.text ?? '').join('') === code) || (node.content ?? []).some(walk);
    return walk(doc);
}

/**
 * A practice-note response → the doc's title and Markdown, with the learner's code (tidied:
 * surrounding blank lines dropped) inserted verbatim. Throws ModelOutputError when the output is
 * not the asked-for JSON, does not fit a doc, or lacks a section.
 */
export function parsePracticeNoteOutput(text: string, input: { solution: string; language: string | null }): PracticeNote {
    const parsed = zPracticeOutput.safeParse(parseJson(text));
    if (!parsed.success) throw new ModelOutputError(firstIssue(parsed.error));

    const code = tidySolution(input.solution);
    const body = withoutTitleHeading(parsed.data.markdown.replace(/\r\n?/g, '\n'));
    const markdown = insertSolution(body, code, input.language).trim();

    let doc: JSONContent;
    try {
        doc = markdownToDocJson(markdown);
    } catch (err) {
        if (err instanceof ErrorResponse) throw new ModelOutputError(`The note does not fit a doc: ${err.message}`);
        throw err;
    }
    const missing = missingSections(doc);
    if (missing.length > 0) throw new ModelOutputError(`Missing sections: ${missing.join(', ')}`);
    if (!hasCodeBlock(doc, code)) throw new ModelOutputError("The learner's code is not in the note");

    return { title: cleanTitle(parsed.data.title) || FALLBACK_TITLE, markdown };
}
