// Mermaid blocks are checked when they are written (AGENT_DIAGRAMS_PLAN §5). Every agent write
// path awaits resolveDiagrams (../diagram/resolve.ts) before anything is stored, and it calls
// checkMermaidBlocks first. A ```mermaid block that Mermaid itself can't parse (the browser's
// version, run on the server by ./worker.ts) is a 400 with Mermaid's own message, naming the
// block, its diagram type and the line, so the agent can fix it in one round:
//
//   Mermaid block 2 (sequenceDiagram), line 4: Parse error on line 4:
//   ...ce: Hi  Alice->>Bob  Bob-->>Alice: ok
//   ----------------------^
//   Expecting 'TXT', got 'NEWLINE'
//
// Valid blocks pass through unchanged (nothing here edits the JSON).
import type { JSONContent } from '@tiptap/core';
import ErrorResponse from '../../../utils/errorResponse';
import { parseMermaid } from './worker';

/** A longer block is refused unread. */
export const MERMAID_MAX_CHARS = 20_000;
/** How long one block's parse may take (Mermaid already loaded). */
export const MERMAID_TIMEOUT_MS = 3_000;
/** Broken blocks described in one answer, at most. */
const MAX_DESCRIBED = 5;
/** One block's description, at most (Mermaid can list 30 tokens it expected). */
const MAX_DESCRIPTION = 800;

/** Where an unknown first word is pointed (each one parses in Mermaid 11.17.2). */
const DIAGRAM_TYPES = [
    'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'erDiagram', 'gantt', 'pie', 'journey', 'gitGraph', 'mindmap', 'timeline',
    'quadrantChart', 'requirementDiagram', 'C4Context', 'sankey-beta', 'xychart-beta', 'block-beta', 'packet-beta', 'kanban', 'architecture-beta', 'radar-beta', 'treemap-beta',
];

/** The source of every ```mermaid code block, at any depth, in document order. */
export function mermaidSources(json: JSONContent): string[] {
    const found: string[] = [];
    const walk = (node: JSONContent | undefined) => {
        if (!node || typeof node !== 'object') return;
        // The browser draws exactly this language (CodeBlockView); any other is plain code.
        if (node.type === 'codeBlock' && node.attrs?.['language'] === 'mermaid') {
            found.push((node.content ?? []).map((c) => c.text ?? '').join(''));
            return;
        }
        if (Array.isArray(node.content)) node.content.forEach(walk);
    };
    walk(json);
    return found;
}

/**
 * Parses every ```mermaid block of parsed Markdown with Mermaid. 400 describing each block it
 * can't read (one paragraph each): its number among the Mermaid blocks, its type, the line and
 * Mermaid's message. An empty block passes, as it does in the editor. If the checker can't run,
 * the blocks pass (logged): the browser still shows Mermaid's error.
 */
export async function checkMermaidBlocks(json: JSONContent): Promise<void> {
    const problems: string[] = [];
    for (const [i, source] of mermaidSources(json).entries()) {
        if (!source.trim()) continue;
        const typed = diagramType(source);
        const name = `Mermaid block ${i + 1} (${typed.type})`;
        if (source.length > MERMAID_MAX_CHARS) {
            problems.push(`${name} is ${source.length} characters; the limit is ${MERMAID_MAX_CHARS}. Split it into smaller diagrams.`);
            continue;
        }
        const result = await parseMermaid(source, MERMAID_TIMEOUT_MS);
        if (result.status === 'timeout') problems.push(`${name} is too complex to check in ${MERMAID_TIMEOUT_MS / 1000} s; simplify it.`);
        else if (result.status === 'error') problems.push(describeError(name, source, typed, result.message, result.span));
    }
    if (problems.length === 0) return;
    const more = problems.length - MAX_DESCRIBED;
    const text = problems.slice(0, MAX_DESCRIBED).join('\n\n') + (more > 0 ? `\n\n…and ${more} more Mermaid block${more === 1 ? '' : 's'} that Mermaid can't parse.` : '');
    throw new ErrorResponse(400, text);
}

// ─── The message ───────────────────────────────────────────────────────

/**
 * The diagram's first word, the type Mermaid reads, and its line: front matter, blank lines and
 * %% lines are skipped (a %%{…}%% directive may share the type's line).
 */
export function diagramType(source: string): { type: string; line: number } {
    const lines = source.split('\n');
    let i = 0;
    if (/^\s*---\s*$/.test(lines[0] ?? '')) {
        const close = lines.findIndex((l, k) => k > 0 && /^\s*---\s*$/.test(l));
        if (close > 0) i = close + 1;
    }
    for (; i < lines.length; i += 1) {
        let line = lines[i]!.trim();
        if (line.startsWith('%%{') && line.includes('}%%')) line = line.slice(line.lastIndexOf('}%%') + 3).trim();
        else if (line.startsWith('%%')) continue;
        if (line) return { type: line.split(/[\s;]/, 1)[0]!.slice(0, 40), line: i + 1 };
    }
    return { type: 'no diagram type', line: 1 };
}

/** Mermaid's message cut to the lines that help, its line numbers counted in the block. */
function describeError(name: string, source: string, typed: { type: string; line: number }, message: string, span?: [number, number]): string {
    const lines = message.split('\n').map((l) => l.trimEnd());
    const first = lines[0] ?? '';
    const toBlock = blockLineMap(source, /^(?:flowchart|graph)/.test(typed.type));
    let body: string[];
    let line: number | null = null;
    /** Our own last line, in the block's count already. */
    let hint: string | null = null;

    if (first.startsWith('No diagram type detected')) {
        // Mermaid quotes the whole text: its first line is enough.
        body = [first.slice(0, 200), `The first line names the diagram type: ${DIAGRAM_TYPES.join(', ')}.`];
        line = typed.line;
    } else if (/^(?:Parse|Lexical) error on line \d+/.test(first)) {
        // A jison parser's: the line, the text around the spot, a caret under it, what it expected.
        body = lines.slice(0, 4);
        const expecting = body[3];
        if (expecting?.startsWith('Expecting ')) {
            body[3] = shortenExpecting(expecting);
            if (END_OF_INPUT.test(expecting)) {
                // It ran into the end of the block. A token that began lines earlier is a string
                // whose quote never closed; otherwise something opened is still open.
                if (span && span[0] < span[1]) {
                    line = toBlock(span[0]);
                    hint = `Is a quote opened on line ${line} never closed?`;
                } else if (/'end'/.test(expecting)) hint = 'Is an "end" missing?';
                else if (/'STRUCT_STOP'/.test(expecting)) hint = 'Is a closing "}" missing?';
            }
        }
    } else if (first.startsWith('Parsing failed:')) {
        // A Langium parser's (pie, gitGraph, packet, architecture, …): one error per line.
        body = [first.replace(/^Parsing failed:\s*/, ''), ...lines.slice(1, 6)].filter((l) => l.trim());
    } else {
        // Anything else (a limit, a rule of the diagram): its first line says it.
        body = [lines.find((l) => l.trim())?.slice(0, 300) ?? 'Mermaid could not read it'];
    }

    // "on line N" in Mermaid's count → the block's.
    body = body.map((l) =>
        l.replace(/\bon line (\d+)/g, (_m, n: string) => {
            const mapped = toBlock(Number(n));
            line ??= mapped;
            return `on line ${mapped}`;
        })
    );
    if (hint) body.push(hint);
    const text = `${name}${line !== null ? `, line ${line}` : ''}: ${body.join('\n')}`;
    return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

/** A jison parser's end of input (token 1, or a grammar's own name for it). */
const END_OF_INPUT = /, got '(?:1|EOF|EOF_IN_STRUCT)'$/;

/** "Expecting 'A', 'B', … (30 in all), got the end of the block". */
function shortenExpecting(line: string): string {
    const match = /^Expecting (.+), got (.+)$/.exec(line);
    if (!match) return line;
    const items = match[1]!.split(', ');
    const list = items.length > 8 ? `${items.slice(0, 8).join(', ')}, … (${items.length} in all)` : match[1];
    const got = END_OF_INPUT.test(line) ? 'the end of the block' : match[2];
    return `Expecting ${list}, got ${got}`;
}

// ─── Mermaid's line numbers → the block's ──────────────────────────────

// Mermaid 11.17.2 drops these before it parses, so its "line N" counts the lines that are left
// (src/diagram-api/regexes.ts, comments.ts and preprocess.ts; flowParser.ts for the last one).
const FRONT_MATTER = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/gs;
const DIRECTIVE = /%{2}\{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!\}%{2}).|\r?\n)*))?\s*(?:\}%{2})?/gi;
const COMMENT_LINE = /^\s*%%(?!\{)[^\n]+\n?/gm;
const LEADING_SPACE = /^\s+/g;
/** A flowchart's parser turns "}", blank lines, "\n" into "}\n". */
const BLANKS_AFTER_BRACE = /(?<=\})\s*(?=\n)/g;
/** A longer block keeps Mermaid's count: the patterns above slow down on long runs of blank lines. */
const MAPPED_LINES_MAX = 1_000;

/** A text and, for each of its characters, the block line it came from. */
interface Traced {
    text: string;
    lines: number[];
}

/** `traced` without what `pattern` (global) matches. */
function without(traced: Traced, pattern: RegExp): Traced {
    const out: Traced = { text: '', lines: [] };
    let from = 0;
    const keep = (to: number) => {
        out.text += traced.text.slice(from, to);
        for (let i = from; i < to; i += 1) out.lines.push(traced.lines[i]!);
    };
    for (const match of traced.text.matchAll(pattern)) {
        keep(match.index);
        from = match.index + match[0].length;
    }
    keep(traced.text.length);
    return out;
}

/** Mermaid's line N → the block's line (past the end: the block's last line that has text). */
function blockLineMap(source: string, flowchart: boolean): (line: number) => number {
    const sourceLines = source.split('\n');
    let last = sourceLines.length;
    while (last > 1 && !sourceLines[last - 1]!.trim()) last -= 1;
    if (sourceLines.length > MAPPED_LINES_MAX) return (line) => Math.min(line, last);

    let traced: Traced = { text: source, lines: [] };
    for (let i = 0, line = 1; i < source.length; i += 1) {
        traced.lines.push(line);
        if (source[i] === '\n') line += 1;
    }
    for (const pattern of [FRONT_MATTER, DIRECTIVE, COMMENT_LINE, LEADING_SPACE, ...(flowchart ? [BLANKS_AFTER_BRACE] : [])]) traced = without(traced, pattern);
    const starts = [0];
    for (let i = 0; i < traced.text.length; i += 1) if (traced.text[i] === '\n') starts.push(i + 1);
    return (line) => {
        const at = starts[line - 1];
        return Math.min(at !== undefined && at < traced.lines.length ? traced.lines[at]! : last, last);
    };
}
