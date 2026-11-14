// The text form of a canvas board (CANVAS_BLOCK_SPEC §9, AGENT_DIAGRAMS_PLAN §4.1): a subset of
// Mermaid's flowchart syntax, which models already write fluently, → a DiagramGraph (boxes, zones,
// notes and arrows, no positions: ./layout.ts places them).
//
//   flowchart LR                      first line, optional (LR RL TB TD BT; none: the layout picks)
//   user([User]) -->|HTTPS| lb[LB]    boxes: [rect] (rounded) ([pill]) [(cylinder)] ((circle))
//   lb --> a1 & a2                    {diamond} [[queue]]; arrows --> --- -.-> -.- ==> <--> <-.->,
//   a1 -- reads --> cache             labels -->|x| or -- x -->; chains; & on both sides
//   subgraph api [API tier] … end     zones, nestable; a zone may be an arrow's end
//   db[(Postgres)]:::blue             colours blue green yellow red gray
//   q@{ kind: queue, label: "Jobs" }  kind / label / shape / color / size, before or after the bracket
//   note for db: Primary + replicas   stickies: note: … · note id: … · note for box: … · note id for box: …
//   %% id: cv_…   %% height: 600      directives; other %% lines are comments; ; separates statements
//
// Unknown syntax is an error, never a silent drop: every error is a 400 that names its line and
// says what to write instead, so an agent fixes it in one round. What we accept but draw
// differently (a hexagon, a thick arrow) comes back as a note for the canvas report.
//
// Who is in a zone follows Mermaid: a box belongs to the innermost subgraph whose own lines name
// it (the first one to close wins); lines outside every subgraph never move a box.
import ErrorResponse from '../../../utils/errorResponse';
import {
    CANVAS_COLORS,
    CANVAS_LIMITS,
    KIND_SHAPES,
    canvasHeight,
    isCanvasId,
    kindOf,
    knownColor,
    textSizeOf,
    unknownKindMessage,
    type CanvasColor,
    type CanvasKind,
    type CanvasShape,
    type CanvasTextSize,
} from '../canvas';

export type DiagramDirection = 'LR' | 'RL' | 'TB' | 'BT';

export interface DiagramNode {
    id: string;
    shape: CanvasShape;
    text: string;
    color: CanvasColor;
    kind?: CanvasKind;
    size?: CanvasTextSize;
    /** The zone it sits in. */
    parent?: string;
}

export interface DiagramEdge {
    id: string;
    from: string;
    to: string;
    label: string;
    line: 'solid' | 'dashed';
    arrow: 'end' | 'both' | 'none';
}

export interface DiagramGraph {
    /** From the first line; null lets the layout pick the one that shows bigger in a doc. */
    direction: DiagramDirection | null;
    /** `%% id: cv_…` (the board this text was printed from). */
    canvasId: string | null;
    /** `%% height: N`: the frame height asked for. */
    height: number | null;
    /** In the order the text first names them (the layout keeps it). */
    nodes: DiagramNode[];
    edges: DiagramEdge[];
    /** What is drawn differently from how it was written, for the canvas report. */
    notes: string[];
}

// ─── Lexical pieces ────────────────────────────────────────────────────

/** A box id: letters, digits and _, single dashes inside (orders-db), so `a-->b` still reads as an arrow. */
const ID = /[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/y;
const ID_SOURCE = '[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*';
const NOTE_LINE = new RegExp(`^note(?:\\s+(${ID_SOURCE}))?(?:\\s+for\\s+(${ID_SOURCE}))?\\s*:(.*)$`, 'is');
const NOTE_START = /^note(?=\s|:)/i;
/** `note …` starts a note, unless an arrow or & follows (a box may be called "note"). */
const isNoteStatement = (text: string): boolean => NOTE_START.test(text) && !/^note\s*(?:[-=<&]|:::|@\{)/i.test(text);
const DIRECTIONS: Readonly<Record<string, DiagramDirection>> = { LR: 'LR', RL: 'RL', TB: 'TB', TD: 'TB', BT: 'BT' };
const OTHER_DIAGRAMS = new Set([
    'sequencediagram', 'erdiagram', 'classdiagram', 'classdiagram-v2', 'statediagram', 'statediagram-v2', 'gantt', 'pie', 'journey',
    'mindmap', 'timeline', 'gitgraph', 'quadrantchart', 'requirementdiagram', 'c4context', 'c4container', 'c4component',
    'sankey-beta', 'xychart-beta', 'block-beta', 'packet-beta', 'architecture-beta', 'kanban', 'zenuml', 'radar-beta',
]);
const COLOR_LIST = CANVAS_COLORS.filter((c) => c !== 'default').map((c) => `:::${c}`).join(', ');
const ATTR_KEYS = ['kind', 'label', 'shape', 'color', 'size'];

interface Opener {
    open: string;
    /** Closers tried in order; the first found ends the text. */
    close: string[];
    /**
     * The shape drawn: undefined for the plain [box] (it names no shape, so a kind still picks
     * one), null for a Mermaid shape we draw as a box (with a note).
     */
    shape: CanvasShape | null | undefined;
    /** How the note names a shape we draw as a box. */
    name?: string;
}

/** Longest opener first. */
const OPENERS: readonly Opener[] = [
    { open: '(((', close: [')))'], shape: 'ellipse' },
    { open: '((', close: ['))'], shape: 'ellipse' },
    { open: '([', close: ['])'], shape: 'pill' },
    { open: '(', close: [')'], shape: 'rounded' },
    { open: '[[', close: [']]'], shape: 'queue' },
    { open: '[(', close: [')]'], shape: 'cylinder' },
    { open: '[/', close: ['/]', '\\]'], shape: null, name: '[/…/]' },
    { open: '[\\', close: ['\\]', '/]'], shape: null, name: '[\\…\\]' },
    { open: '[', close: [']'], shape: undefined },
    { open: '{{', close: ['}}'], shape: null, name: '{{…}}' },
    { open: '{', close: ['}'], shape: 'diamond' },
    { open: '>', close: [']'], shape: null, name: '>…]' },
];

/** The character that closes a bracket of this family: text holding it was not read right. */
const FAMILY_CLOSE: Readonly<Record<string, string>> = { '[': ']', '(': ')', '{': '}', '>': ']' };

/**
 * `shape:` values in @{ … }: ours, and Mermaid 11's names. A Mermaid shape we can't draw becomes
 * a box (null) with a note.
 */
const ATTR_SHAPES: Readonly<Record<string, CanvasShape | null>> = {
    rect: 'rect', rectangle: 'rect', box: 'rect', proc: 'rect', process: 'rect', square: 'rect',
    rounded: 'rounded', event: 'rounded', round: 'rounded',
    pill: 'pill', stadium: 'pill', terminal: 'pill',
    circle: 'ellipse', circ: 'ellipse', ellipse: 'ellipse', oval: 'ellipse', 'dbl-circ': 'ellipse', 'double-circle': 'ellipse',
    diamond: 'diamond', diam: 'diamond', decision: 'diamond', question: 'diamond', rhombus: 'diamond',
    cylinder: 'cylinder', cyl: 'cylinder', database: 'cylinder', db: 'cylinder', 'lin-cyl': 'cylinder', disk: 'cylinder', 'lined-cylinder': 'cylinder',
    queue: 'queue', 'h-cyl': 'queue', das: 'queue', 'horizontal-cylinder': 'queue',
    subproc: 'queue', subroutine: 'queue', subprocess: 'queue', 'fr-rect': 'queue', 'framed-rectangle': 'queue',
    text: 'text', sticky: 'sticky', note: 'sticky',
    hex: null, hexagon: null, prepare: null, 'lean-r': null, 'lean-l': null, 'lean-right': null, 'lean-left': null, 'in-out': null, 'out-in': null,
    'trap-b': null, 'trap-t': null, trapezoid: null, 'inv-trapezoid': null, priority: null, manual: null, 'trapezoid-bottom': null, 'trapezoid-top': null,
    doc: null, document: null, docs: null, documents: null, 'lin-doc': null, 'tag-doc': null, 'st-doc': null, 'stacked-document': null,
    'notch-rect': null, card: null, 'notched-rectangle': null, hourglass: null, collate: null, bolt: null, 'com-link': null, 'lightning-bolt': null,
    brace: null, 'brace-l': null, 'brace-r': null, braces: null, comment: null, delay: null, 'half-rounded-rectangle': null,
    'curv-trap': null, display: null, 'curved-trapezoid': null, 'div-rect': null, 'div-proc': null, 'divided-rectangle': null, 'divided-process': null,
    tri: null, extract: null, triangle: null, 'flip-tri': null, 'flipped-triangle': null, 'manual-file': null, fork: null, join: null,
    'win-pane': null, 'internal-storage': null, 'window-pane': null, 'f-circ': null, junction: null, 'filled-circle': null, 'sm-circ': null, 'small-circle': null,
    start: null, 'fr-circ': null, stop: null, 'framed-circle': null, 'lin-rect': null, 'lin-proc': null, 'lined-rectangle': null, 'lined-process': null,
    'shaded-process': null, 'notch-pent': null, 'loop-limit': null, 'notched-pentagon': null, 'sl-rect': null, 'manual-input': null, 'sloped-rectangle': null,
    'st-rect': null, processes: null, procs: null, 'stacked-rectangle': null, odd: null, flag: null, 'paper-tape': null, 'bow-rect': null,
    'stored-data': null, 'bow-tie-rectangle': null, 'cross-circ': null, summary: null, 'crossed-circle': null, 'tag-rect': null, 'tag-proc': null,
    'tagged-rectangle': null, 'tagged-process': null,
};
const OUR_SHAPES = 'rect, rounded, pill, circle, diamond, cylinder, queue, text';

// ─── Errors ────────────────────────────────────────────────────────────

const bad = (message: string): ErrorResponse => new ErrorResponse(400, message);
const atLine = (line: number, message: string): ErrorResponse => bad(`line ${line}: ${message}`);
const show = (text: string, max = 40): string => JSON.stringify(text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ─── Text in boxes, labels and notes ──────────────────────────────────

/** `<br>` and a written `\n` are line breaks; Mermaid's #quot; is a quote; spaces trimmed. */
export function cleanText(raw: string): string {
    let text = raw.trim();
    // A Mermaid markdown string: "`text`".
    if (text.length >= 2 && text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1);
    return text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\\n/g, '\n')
        .replace(/#quot;|&quot;/g, '"')
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .trim();
}

// ─── Splitting the text into statements ──────────────────────────────

interface Statement {
    text: string;
    line: number;
}

/**
 * One line → its statements: `;` separates them, except inside quotes, brackets and |labels|;
 * `%%` outside them starts a comment. A note runs to the end of its line (its text may hold `;`).
 */
function splitLine(source: string, line: number): Statement[] {
    const out: Statement[] = [];
    let start = 0;
    let depth = 0;
    let quote = false;
    let pipe = false;
    const push = (end: number) => {
        const text = source.slice(start, end).trim();
        if (text) out.push({ text, line });
    };
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i]!;
        if (quote) {
            if (ch === '"') quote = false;
            continue;
        }
        if ((ch === 'n' || ch === 'N') && source.slice(start, i).trim() === '' && isNoteStatement(source.slice(i))) {
            push(source.length);
            return out;
        }
        if (ch === '"') quote = true;
        else if (ch === '%' && source[i + 1] === '%' && depth === 0 && !pipe) {
            push(i);
            return out;
        } else if (ch === '[' || ch === '(' || ch === '{') depth += 1;
        else if (ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1);
        else if (ch === '|' && depth === 0) pipe = !pipe;
        else if (ch === ';' && depth === 0 && !pipe) {
            push(i);
            start = i + 1;
        }
    }
    push(source.length);
    return out;
}

// ─── A cursor over one statement ─────────────────────────────────────

class Cursor {
    pos = 0;

    constructor(
        readonly text: string,
        readonly line: number
    ) {}

    get done(): boolean {
        return this.pos >= this.text.length;
    }

    peek(offset = 0): string {
        return this.text[this.pos + offset] ?? '';
    }

    startsWith(s: string): boolean {
        return this.text.startsWith(s, this.pos);
    }

    skipSpace(): void {
        while (this.pos < this.text.length && /\s/.test(this.text[this.pos]!)) this.pos += 1;
    }

    /** A sticky regex at the cursor; moves past it. */
    take(re: RegExp): RegExpExecArray | null {
        re.lastIndex = this.pos;
        const m = re.exec(this.text);
        if (m) this.pos = re.lastIndex;
        return m;
    }

    /** What is left, for messages. */
    rest(max = 30): string {
        const rest = this.text.slice(this.pos).trim();
        return rest.length > max ? `${rest.slice(0, max - 1)}…` : rest;
    }

    fail(message: string): never {
        throw atLine(this.line, message);
    }
}

// ─── Statements ────────────────────────────────────────────────────────

interface NodeRef {
    id: string;
    text?: string;
    /** A shape the bracket or @{ shape } names; null when it named one we draw as a box. */
    shape?: CanvasShape | null;
    /** How a shape drawn as a box was written (for the note). */
    drawnAsBox?: string;
    color?: CanvasColor;
    colorWord?: string;
    kind?: CanvasKind;
    size?: CanvasTextSize;
    /** Written with a bracket or @{ … }: a declaration, not just a mention. */
    declared: boolean;
}

interface Link {
    line: 'solid' | 'dashed';
    arrow: 'end' | 'both' | 'none';
    label: string;
    thick: boolean;
    /** --o or --x */
    head: boolean;
}

interface Bracket {
    text: string;
    /** As Opener.shape. */
    shape: CanvasShape | null | undefined;
    drawnAsBox?: string;
}

/** A shape's text: "quoted" (may hold any bracket) or plain up to the closer. */
function readBracket(c: Cursor, id: string): Bracket {
    const opener = OPENERS.find((o) => c.startsWith(o.open))!;
    const from = c.pos;
    c.pos += opener.open.length;
    const inner = c.pos;
    c.skipSpace();
    if (c.peek() === '"') {
        const end = c.text.indexOf('"', c.pos + 1);
        if (end < 0) c.fail(`the text of ${show(id)} opens a quote that never closes: expected a closing "`);
        const text = c.text.slice(c.pos + 1, end);
        c.pos = end + 1;
        c.skipSpace();
        const closer = opener.close.find((s) => c.startsWith(s));
        if (!closer) c.fail(`expected ${show(opener.close[0]!)} after the quoted text of ${show(id)}, found ${show(c.rest())}`);
        c.pos += closer.length;
        return bracketOf(opener, text);
    }
    const ends = opener.close.map((s) => ({ s, at: c.text.indexOf(s, inner) })).filter((e) => e.at >= 0);
    const end = ends.sort((a, b) => a.at - b.at)[0];
    const plainClose = FAMILY_CLOSE[opener.open[0]!]!;
    const misread = !end || c.text.slice(inner, end.at).includes(plainClose);
    if (misread) {
        // "[(L7) LB]" or "[/v1/users]": the two-character opener was the text's first character.
        if (opener.open.length === 2 && opener.open[0] === '[' && c.text.indexOf(']', inner) >= 0) {
            c.pos = from;
            return readPlainBox(c);
        }
        c.fail(`the text of ${show(id)} is not closed: expected ${show(opener.close[0]!)}. Text with brackets goes in quotes: ${id}["…"]`);
    }
    c.pos = end!.at + end!.s.length;
    return bracketOf(opener, c.text.slice(inner, end!.at));
}

/** `[text]`, read as a plain box whatever its first character. */
function readPlainBox(c: Cursor): Bracket {
    const end = c.text.indexOf(']', c.pos + 1);
    const text = c.text.slice(c.pos + 1, end);
    c.pos = end + 1;
    return { text: cleanText(text), shape: undefined };
}

function bracketOf(opener: Opener, raw: string): Bracket {
    const text = cleanText(raw);
    if (opener.shape !== null) return { text, shape: opener.shape };
    return { text, shape: null, drawnAsBox: opener.name ?? opener.open };
}

/** `@{ key: value, … }` → the pairs (values unquoted). */
function readAttrs(c: Cursor, id: string): Map<string, string> {
    c.pos += 2; // @{
    const pairs = new Map<string, string>();
    for (;;) {
        c.skipSpace();
        if (c.peek() === '}') {
            c.pos += 1;
            return pairs;
        }
        if (c.done) c.fail(`@{ … } on ${show(id)} is not closed: expected "}"`);
        const key = c.take(/[A-Za-z_][A-Za-z0-9_-]*/y)?.[0];
        if (!key) c.fail(`expected a key in @{ … } on ${show(id)} (${ATTR_KEYS.join(', ')}), found ${show(c.rest())}`);
        c.skipSpace();
        if (c.peek() !== ':') c.fail(`expected ":" after ${show(key)} in @{ … } on ${show(id)}, e.g. @{ kind: cache }`);
        c.pos += 1;
        c.skipSpace();
        let value: string;
        const q = c.peek();
        if (q === '"' || q === "'") {
            const end = c.text.indexOf(q, c.pos + 1);
            if (end < 0) c.fail(`a quote in @{ … } on ${show(id)} never closes`);
            value = c.text.slice(c.pos + 1, end);
            c.pos = end + 1;
        } else {
            const m = c.take(/[^,}]*/y);
            value = (m?.[0] ?? '').trim();
        }
        const name = key.toLowerCase() === 'colour' ? 'color' : key.toLowerCase();
        if (!ATTR_KEYS.includes(name)) {
            const hint = name === 'icon' ? ' (kind sets the icon, e.g. @{ kind: database })' : '';
            c.fail(`${show(key)} is not a key of @{ … }${hint}. Keys: ${ATTR_KEYS.join(', ')}`);
        }
        pairs.set(name, value);
        c.skipSpace();
        if (c.done) c.fail(`@{ … } on ${show(id)} is not closed: expected "}"`);
        if (c.peek() === ',') c.pos += 1;
        else if (c.peek() !== '}') c.fail(`expected "," or "}" in @{ … } on ${show(id)}, found ${show(c.rest())}`);
    }
}

/** @{ … } pairs onto a node reference. */
function applyAttrs(c: Cursor, ref: NodeRef, pairs: ReadonlyMap<string, string>): void {
    for (const [key, value] of pairs) {
        if (key === 'label') ref.text = cleanText(value);
        else if (key === 'kind') {
            const kind = kindOf(value);
            if (!kind) c.fail(`${show(ref.id)}: ${unknownKindMessage(value)}`);
            ref.kind = kind;
        } else if (key === 'shape') {
            const name = value.trim().toLowerCase();
            if (!(name in ATTR_SHAPES)) c.fail(`${show(value)} is not a shape (on ${show(ref.id)}). Shapes: ${OUR_SHAPES}`);
            const shape = ATTR_SHAPES[name]!;
            ref.shape = shape;
            if (shape === null) ref.drawnAsBox = `shape: ${name}`;
            else delete ref.drawnAsBox;
        } else if (key === 'color') {
            const color = knownColor(value);
            if (!color) c.fail(`${show(value)} is not a colour (on ${show(ref.id)}). Colours: ${CANVAS_COLORS.filter((x) => x !== 'default').join(', ')}`);
            ref.color = color;
            ref.colorWord = value;
        } else if (key === 'size') {
            const size = textSizeOf(value);
            if (!size) c.fail(`${show(value)} is not a text size (on ${show(ref.id)}): use s, m or l`);
            ref.size = size;
        }
    }
}

/** An id, then (in any order, each once) a bracket, @{ … } and :::colour. */
function readNode(c: Cursor): NodeRef {
    const id = c.take(ID)?.[0];
    if (!id) {
        const found = c.rest();
        if (/^["[({]/.test(found)) c.fail(`a box needs an id before its text, e.g. api${found.slice(0, 1)}…: found ${show(found)}`);
        c.fail(`expected a box id (letters, digits, _), found ${show(found)}`);
    }
    if (id.length > CANVAS_LIMITS.id) c.fail(`the id ${show(id)} is ${id.length} characters; the most is ${CANVAS_LIMITS.id}`);
    const ref: NodeRef = { id, declared: false };
    const seen = new Set<string>();
    // @{ label } and @{ shape } win over the bracket's, whichever comes first.
    const fromAttrs = { text: false, shape: false };
    for (;;) {
        const before = c.pos;
        c.skipSpace();
        const spaced = c.pos > before;
        const ch = c.peek();
        let part: string | null = null;
        if (c.startsWith('@{')) part = 'attrs';
        else if (c.startsWith(':::')) part = 'class';
        else if (ch === '[' || ch === '(' || ch === '{' || (ch === '>' && !spaced)) part = 'shape';
        if (!part) {
            c.pos = before;
            break;
        }
        if (seen.has(part)) c.fail(`${show(id)} has two ${part === 'shape' ? 'brackets' : part === 'attrs' ? '@{ … } blocks' : ':::colours'}: give each once`);
        seen.add(part);
        ref.declared = ref.declared || part !== 'class';
        if (part === 'shape') {
            const bracket = readBracket(c, id);
            if (!fromAttrs.text) ref.text = bracket.text;
            if (!fromAttrs.shape && bracket.shape !== undefined) {
                ref.shape = bracket.shape;
                if (bracket.drawnAsBox) ref.drawnAsBox = bracket.drawnAsBox;
            }
        } else if (part === 'attrs') {
            const pairs = readAttrs(c, id);
            applyAttrs(c, ref, pairs);
            fromAttrs.text = pairs.has('label');
            fromAttrs.shape = pairs.has('shape');
        } else {
            c.pos += 3;
            const word = c.take(/[A-Za-z0-9_-]+/y)?.[0];
            if (!word) c.fail(`expected a colour after ::: on ${show(id)}: ${COLOR_LIST}`);
            const color = knownColor(word);
            if (!color) c.fail(`:::${word} is not a colour (on ${show(id)}): use ${COLOR_LIST}`);
            ref.color = color;
            ref.colorWord = word;
        }
    }
    const next = c.peek();
    if (next === ')' || next === ']' || next === '}') {
        c.fail(`the text of ${show(id)} has a ${show(next)} in it, or a bracket too many: put the text in quotes, e.g. ${id}["text (with) brackets"]`);
    }
    return ref;
}

/** `a & b & c` */
function readGroup(c: Cursor): NodeRef[] {
    const group = [readNode(c)];
    for (;;) {
        const before = c.pos;
        c.skipSpace();
        if (c.peek() !== '&') {
            c.pos = before;
            return group;
        }
        c.pos += 1;
        c.skipSpace();
        if (c.done) c.fail('expected a box id after "&"');
        group.push(readNode(c));
    }
}

/** A pipe label `|text|` (quotes allowed, so a label can hold a |). */
function readPipeLabel(c: Cursor): string {
    c.pos += 1;
    c.skipSpace();
    if (c.peek() === '"') {
        const end = c.text.indexOf('"', c.pos + 1);
        if (end < 0) c.fail('a quoted arrow label never closes: expected a closing "');
        const text = c.text.slice(c.pos + 1, end);
        c.pos = end + 1;
        c.skipSpace();
        if (c.peek() !== '|') c.fail(`expected "|" after the quoted arrow label, found ${show(c.rest())}`);
        c.pos += 1;
        return cleanText(text);
    }
    const end = c.text.indexOf('|', c.pos);
    if (end < 0) c.fail('an arrow label |… is not closed: expected "|"');
    const text = c.text.slice(c.pos, end);
    c.pos = end + 1;
    return cleanText(text);
}

const ARROW_HELP = 'Arrows: --> (or --->), --- (no head), -.-> (dashed), -.- , ==> , <--> and <-.-> (both ways); a label goes in -->|label| or -- label -->';

/** A link at the cursor, or null when there is none (the cursor stays put). */
function readLink(c: Cursor): Link | null {
    const start = c.pos;
    const both = c.peek() === '<';
    if (both) c.pos += 1;
    const link = (line: Link['line'], end: boolean, extra: Partial<Link> = {}): Link => {
        if (both && !end) c.fail(`an arrow that starts with "<" needs a head at the end too: <--> or <-.->`);
        return { line, arrow: both ? 'both' : end ? 'end' : 'none', label: '', thick: false, head: false, ...extra };
    };
    /** `-- text -->`: the text, then the closing arrow. */
    const textForm = (close: RegExp, line: Link['line'], thick: boolean): Link => {
        const rest = c.text.slice(c.pos);
        const m = close.exec(rest);
        if (!m && both) c.fail('an arrow that starts with "<" needs a head at the end too: <--> or <-.->. For an arrow the other way, swap the boxes: b --> a');
        if (!m) c.fail(`an arrow label written as ${thick ? '== text ==>' : line === 'dashed' ? '-. text .->' : '-- text -->'} needs its closing arrow. ${ARROW_HELP}`);
        const label = cleanText(rest.slice(0, m.index).replace(/^"(.*)"$/s, '$1'));
        c.pos += m.index + m[0].length;
        return link(line, m[1]!.endsWith('>'), { label, thick });
    };
    let m: RegExpExecArray | null;
    if (c.take(/-{2,}>/y)) return link('solid', true);
    if ((m = c.take(/-{2,}[ox](?=\s|$)/y))) return link('solid', true, { head: true });
    if (c.take(/-{3,}(?![->.])/y)) return link('solid', false);
    if (c.take(/-\.+->/y)) return link('dashed', true);
    if (c.take(/-\.+-(?![->])/y)) return link('dashed', false);
    if (c.take(/={2,}>/y)) return link('solid', true, { thick: true });
    if (c.take(/={3,}(?![=>])/y)) return link('solid', false, { thick: true });
    if (c.take(/--(?![->])/y)) return textForm(/\s*(-{2,}>|-{3,})(?![->])/, 'solid', false);
    if (c.take(/-\.(?![.-])/y)) return textForm(/\s*(\.+->|\.+-)(?![->])/, 'dashed', false);
    if (c.take(/==(?![=>])/y)) return textForm(/\s*(={2,}>|={3,})(?![=>])/, 'solid', true);
    c.pos = start;
    return null;
}

// ─── The parser ────────────────────────────────────────────────────────

interface Draft {
    id: string;
    /** Set by a bracket other than [ ] or by @{ shape }; null = a shape drawn as a box. */
    shape: CanvasShape | null | undefined;
    text: string | undefined;
    color: CanvasColor;
    kind: CanvasKind | undefined;
    size: CanvasTextSize | undefined;
    zone: boolean;
    note: boolean;
    /** The line that gave it a bracket, @{ … }, a note or a subgraph. */
    declaredAt: number | undefined;
    /** Named somewhere other than a note's `for`. */
    named: boolean;
    parent: string | undefined;
    claimed: boolean;
}

interface Frame {
    zone: string;
    line: number;
    mentioned: string[];
}

interface PendingNoteLink {
    note: string;
    box: string;
    line: number;
}

class DiagramParser {
    private direction: DiagramDirection | null = null;
    private directionLine = 0;
    private canvasId: string | null = null;
    private height: number | null = null;
    private readonly drafts = new Map<string, Draft>();
    private readonly order: string[] = [];
    private readonly edges: Array<DiagramEdge & { lineNo: number; noteLink: boolean }> = [];
    private readonly stack: Frame[] = [];
    private readonly notes = new Set<string>();
    private readonly drawnAsBox: string[] = [];
    private readonly noteLinks: PendingNoteLink[] = [];
    private statements = 0;
    private unnamedNotes = 0;

    parse(text: string): DiagramGraph {
        const lines = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n');
        let i = this.skipFrontMatter(lines);
        for (; i < lines.length; i += 1) {
            const source = lines[i]!;
            const line = i + 1;
            const trimmed = source.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('%%')) {
                this.directive(trimmed, line);
                continue;
            }
            for (const st of splitLine(source, line)) this.statement(st);
        }
        return this.finish();
    }

    /** A `---` … `---` block at the top (Mermaid front matter) is skipped, with a note. */
    private skipFrontMatter(lines: readonly string[]): number {
        const first = lines.findIndex((l) => l.trim() !== '');
        if (first < 0 || lines[first]!.trim() !== '---') return 0;
        const close = lines.findIndex((l, i) => i > first && l.trim() === '---');
        if (close < 0) throw atLine(first + 1, 'a "---" front matter block never closes: expected a second "---" line (or leave it out)');
        this.notes.add('The --- front matter is ignored.');
        return close + 1;
    }

    private directive(text: string, line: number): void {
        const m = /^%%\s*(id|height)\s*:\s*(.*)$/i.exec(text);
        if (!m) return; // a comment
        const value = m[2]!.trim();
        if (m[1]!.toLowerCase() === 'id') {
            if (!isCanvasId(value)) throw atLine(line, `${show(value)} is not a canvas id (cv_ and 12 letters, digits, - or _): copy it from read_doc, or leave the line out`);
            this.canvasId = value;
            return;
        }
        const n = Number(value.replace(/px$/i, ''));
        if (!value || !Number.isFinite(n)) throw atLine(line, `%% height needs a number of pixels (240–1400), e.g. %% height: 600`);
        this.height = canvasHeight(n);
    }

    private statement(st: Statement): void {
        const { text, line } = st;
        const firstStatement = this.statements === 0;
        this.statements += 1;
        const word = /^[A-Za-z][A-Za-z0-9-]*/.exec(text)?.[0] ?? '';
        const lower = word.toLowerCase();
        const after = text.slice(word.length);
        /** The word is a keyword only when no arrow, & or bracket follows it (a box may be named "class"). */
        const keyword = word !== '' && (after === '' || /^\s/.test(after)) && !/^\s*(?:[-=<&]|:::|@\{)/.test(after);

        if (keyword && (lower === 'flowchart' || lower === 'graph' || lower === 'flowchart-elk')) {
            if (!firstStatement) throw atLine(line, `${show(word)} must be the first line (it names the direction: flowchart LR or flowchart TB)`);
            this.header(after.trim(), line);
            return;
        }
        if (firstStatement && OTHER_DIAGRAMS.has(lower)) {
            throw atLine(line, `a canvas holds a flowchart (boxes and arrows); for a ${word} use a \`\`\`mermaid fence instead`);
        }
        if (keyword && lower === 'subgraph') return this.subgraph(after, line);
        if (text === 'end') return this.end(line);
        if (keyword && lower === 'direction') return this.directionStatement(after.trim(), line);
        if (isNoteStatement(text)) return this.note(text, line);
        if (keyword && ['classdef', 'class', 'style'].includes(lower)) {
            throw atLine(line, `${word} is not supported on a canvas: colour a box with ${COLOR_LIST}, e.g. db[(Postgres)]:::blue`);
        }
        if (keyword && lower === 'linkstyle') {
            throw atLine(line, 'linkStyle is not supported: arrows are drawn plain; use -.-> for a dashed (async) arrow, and |label| for words on it');
        }
        if (keyword && lower === 'click') throw atLine(line, 'click is not supported on a canvas (boxes have no links): leave the line out');
        if (keyword && (lower === 'acctitle' || lower === 'accdescr')) throw atLine(line, `${word} is not supported on a canvas: leave the line out`);
        this.chain(new Cursor(text, line));
    }

    private header(rest: string, line: number): void {
        if (!rest) return;
        const dir = DIRECTIONS[rest.toUpperCase()];
        if (!dir) throw atLine(line, `${show(rest)} is not a direction: write flowchart LR (left to right), TB (top to bottom), RL or BT`);
        this.direction = dir;
        this.directionLine = line;
    }

    private directionStatement(rest: string, line: number): void {
        const dir = DIRECTIONS[rest.toUpperCase()];
        if (!dir) throw atLine(line, `${show(rest)} is not a direction: LR, RL, TB or BT`);
        const frame = this.stack[this.stack.length - 1];
        if (frame) {
            this.notes.add(`"direction ${rest}" in subgraph ${show(frame.zone)} is ignored: a board has one direction.`);
            return;
        }
        if (this.direction && this.direction !== dir) {
            this.notes.add(`"direction ${rest}" on line ${line} is ignored: line ${this.directionLine} already says ${this.direction}.`);
            return;
        }
        this.direction = dir;
        this.directionLine = line;
    }

    // ─── Nodes ───

    private draft(id: string, line: number): Draft {
        let d = this.drafts.get(id);
        if (!d) {
            d = {
                id,
                shape: undefined,
                text: undefined,
                color: 'default',
                kind: undefined,
                size: undefined,
                zone: false,
                note: false,
                declaredAt: undefined,
                named: false,
                parent: undefined,
                claimed: false,
            };
            this.drafts.set(id, d);
            this.order.push(id);
            if (this.drafts.size > CANVAS_LIMITS.nodes) throw atLine(line, `a canvas holds at most ${CANVAS_LIMITS.nodes} boxes (zones and notes count)`);
        }
        return d;
    }

    /** A box named on this line, inside the open subgraph (if any). */
    private mention(id: string, line: number): Draft {
        const d = this.draft(id, line);
        d.named = true;
        const frame = this.stack[this.stack.length - 1];
        if (frame && !frame.mentioned.includes(id)) frame.mentioned.push(id);
        return d;
    }

    private declare(ref: NodeRef, line: number): Draft {
        const d = this.mention(ref.id, line);
        if (!ref.declared && ref.color === undefined) return d;
        if (d.zone && !ref.declared) {
            d.color = ref.color ?? d.color; // api:::blue colours the zone
            return d;
        }
        if (d.zone) throw atLine(line, `${show(ref.id)} is a zone (subgraph on line ${d.declaredAt}): a zone has no box shape or kind; give the box another id`);
        if (d.note && ref.declared) throw atLine(line, `${show(ref.id)} is a note (line ${d.declaredAt}): give the box another id`);
        if (ref.declared) d.declaredAt ??= line;
        if (ref.text !== undefined) {
            if (ref.text.length > CANVAS_LIMITS.text) throw atLine(line, `the text of ${show(ref.id)} is ${ref.text.length} characters; the most is ${CANVAS_LIMITS.text}`);
            d.text = ref.text;
        }
        if ('shape' in ref) d.shape = ref.shape;
        if (ref.drawnAsBox) this.drawnAsBox.push(`${show(ref.id)} (${ref.drawnAsBox})`);
        if (ref.color !== undefined) {
            d.color = ref.color;
            if (ref.color === 'default' && ref.colorWord && ref.colorWord.toLowerCase() !== 'default') {
                this.notes.add(`:::${ref.colorWord} on ${show(ref.id)} is drawn without a colour (colours: ${COLOR_LIST}).`);
            }
        }
        if (ref.kind) d.kind = ref.kind;
        if (ref.size) d.size = ref.size;
        return d;
    }

    // ─── Statements ───

    /** `a --> b & c -->|x| d`, or a lone box declaration. */
    private chain(c: Cursor): void {
        const groups: NodeRef[][] = [readGroup(c)];
        const links: Link[] = [];
        for (;;) {
            c.skipSpace();
            if (c.done) break;
            const link = readLink(c);
            if (!link) {
                const rest = c.rest();
                const last = groups[groups.length - 1]!;
                const after = last[last.length - 1]!.id;
                if (/^[-=<.>~]/.test(rest)) c.fail(`${show(rest.split(/\s/)[0]!)} is not an arrow. ${ARROW_HELP}`);
                c.fail(`expected an arrow (-->) or & after ${show(after)}, found ${show(rest)}. Put one statement on each line (or separate them with ;)`);
            }
            c.skipSpace();
            if (c.peek() === '|') {
                if (link.label) c.fail('an arrow has two labels: use -- text --> or -->|text|, not both');
                link.label = readPipeLabel(c);
                c.skipSpace();
            }
            if (link.label.length > CANVAS_LIMITS.label) c.fail(`an arrow label is ${link.label.length} characters; the most is ${CANVAS_LIMITS.label}`);
            if (c.done) c.fail('expected a box id after the arrow');
            groups.push(readGroup(c));
            links.push(link);
        }
        for (const group of groups) for (const ref of group) this.declare(ref, c.line);
        links.forEach((link, i) => {
            if (link.thick) this.notes.add('Thick arrows (==>) are drawn as normal arrows.');
            if (link.head) this.notes.add('--o and --x arrows end in a normal arrowhead.');
            for (const from of groups[i]!) for (const to of groups[i + 1]!) this.addEdge(from.id, to.id, link, c.line);
        });
    }

    private addEdge(from: string, to: string, link: Link, line: number, noteLink = false): void {
        if (this.edges.length >= CANVAS_LIMITS.edges) throw atLine(line, `a canvas holds at most ${CANVAS_LIMITS.edges} arrows`);
        this.edges.push({ id: `e${this.edges.length + 1}`, from, to, label: link.label, line: link.line, arrow: link.arrow, lineNo: line, noteLink });
    }

    private subgraph(after: string, line: number): void {
        // Typed explicitly: TypeScript only treats `c.fail()` as never returning on a declared type.
        const c: Cursor = new Cursor(after.trim(), line);
        if (c.done) c.fail('a subgraph needs a name: subgraph api [API tier]');
        let id: string;
        let title: string;
        /** False for `subgraph id` alone: reopening a zone then keeps its title. */
        let titled = true;
        let colorWord: string | undefined;
        const colorAt = c.text.search(/:::[A-Za-z0-9_-]+\s*$/);
        const head = colorAt >= 0 ? c.text.slice(0, colorAt).trim() : c.text;
        if (colorAt >= 0) colorWord = c.text.slice(colorAt + 3).trim();
        const h: Cursor = new Cursor(head, line);
        if (h.peek() === '"') {
            const end = head.indexOf('"', 1);
            if (end < 0) h.fail('the subgraph title opens a quote that never closes');
            if (head.slice(end + 1).trim()) h.fail(`unexpected ${show(head.slice(end + 1).trim())} after the subgraph title`);
            title = cleanText(head.slice(1, end));
            id = this.slugFor(title);
        } else {
            const word = h.take(ID)?.[0];
            if (!word) h.fail(`expected a subgraph id, found ${show(head)}: write subgraph api [API tier]`);
            h.skipSpace();
            if (h.done) {
                id = word;
                title = word;
                titled = false;
            } else if (h.peek() === '[') {
                id = word;
                h.pos += 1;
                h.skipSpace();
                let raw: string;
                if (h.peek() === '"') {
                    const end = head.indexOf('"', h.pos + 1);
                    if (end < 0) h.fail('the subgraph title opens a quote that never closes');
                    raw = head.slice(h.pos + 1, end);
                    h.pos = end + 1;
                    h.skipSpace();
                    if (h.peek() !== ']') h.fail(`expected "]" after the subgraph title, found ${show(h.rest())}`);
                } else {
                    const end = head.indexOf(']', h.pos);
                    if (end < 0) h.fail('the subgraph title is not closed: expected "]"');
                    raw = head.slice(h.pos, end);
                    h.pos = end;
                }
                h.pos += 1;
                if (!h.done && h.rest()) h.fail(`unexpected ${show(h.rest())} after the subgraph title`);
                title = cleanText(raw);
            } else if (/^[({]/.test(h.peek())) {
                h.fail(`a subgraph title goes in square brackets: subgraph ${word} [Title]`);
            } else {
                // `subgraph API tier`: several words are the title.
                title = cleanText(head);
                id = this.slugFor(title);
            }
        }
        if (title.length > CANVAS_LIMITS.text) throw atLine(line, `the title of subgraph ${show(id)} is ${title.length} characters; the most is ${CANVAS_LIMITS.text}`);
        const existing = this.drafts.get(id);
        const parentFrame = this.stack[this.stack.length - 1];
        if (existing?.zone) {
            // The same zone again: its lines add to it (update_canvas `add` puts boxes in a zone so).
            if (existing.parent !== parentFrame?.zone) {
                const where = existing.parent ? `inside subgraph ${show(existing.parent)}` : 'outside every subgraph';
                throw atLine(line, `subgraph ${show(id)} (line ${existing.declaredAt}) sits ${where}: reopen it there, or give this one another id`);
            }
        } else if (existing?.declaredAt !== undefined) {
            throw atLine(line, `${show(id)} is already a box (line ${existing.declaredAt}): give the subgraph another id`);
        }
        const d = this.draft(id, line);
        if (!d.zone || titled) d.text = title;
        d.zone = true;
        d.declaredAt ??= line;
        d.named = true;
        if (parentFrame) d.parent = parentFrame.zone;
        if (colorWord !== undefined) {
            const color = knownColor(colorWord);
            if (!color) throw atLine(line, `:::${colorWord} is not a colour (on subgraph ${show(id)}): use ${COLOR_LIST}`);
            d.color = color;
        }
        this.stack.push({ zone: id, line, mentioned: [] });
    }

    /** `end`: this subgraph takes the boxes its lines named that no inner subgraph took. */
    private end(line: number): void {
        const frame = this.stack.pop();
        if (!frame) throw atLine(line, '"end" without a subgraph to close');
        for (const id of frame.mentioned) {
            const d = this.drafts.get(id)!;
            if (d.zone || d.claimed) continue;
            d.parent = frame.zone;
            d.claimed = true;
        }
    }

    private note(text: string, line: number): void {
        const m = NOTE_LINE.exec(text);
        if (!m) {
            if (/^note\s+(?:left|right|over|above|below|top|bottom)\b/i.test(text)) {
                throw atLine(line, 'that is sequence-diagram syntax: write note for db: text (a note beside a box)');
            }
            throw atLine(line, 'write a note as note: text, note id: text, or note for box: text');
        }
        const body = cleanText(m[3] ?? '');
        if (body.length > CANVAS_LIMITS.text) throw atLine(line, `a note is ${body.length} characters; the most is ${CANVAS_LIMITS.text}`);
        let id = m[1];
        if (id && id.length > CANVAS_LIMITS.id) throw atLine(line, `the id ${show(id)} is ${id.length} characters; the most is ${CANVAS_LIMITS.id}`);
        if (!id) {
            this.unnamedNotes += 1;
            id = `\u0000note${this.unnamedNotes}`; // named once every id in the text is known
        }
        const existing = this.drafts.get(id);
        if (existing?.zone) throw atLine(line, `${show(id)} is a zone (subgraph on line ${existing.declaredAt}): give the note another id`);
        if (existing && existing.declaredAt !== undefined) {
            throw atLine(line, `${show(id)} is already ${existing.note ? 'a note' : 'a box'} (line ${existing.declaredAt}): give the note its own id`);
        }
        const d = this.mention(id, line);
        d.note = true;
        d.text = body;
        d.declaredAt = line;
        const box = m[2];
        if (box) {
            this.draft(box, line);
            this.noteLinks.push({ note: id, box, line });
            this.addEdge(box, id, { line: 'dashed', arrow: 'none', label: '', thick: false, head: false }, line, true);
        }
    }

    // ─── The end ───

    /** A free id from a title: "API tier" → api_tier. */
    private slugFor(title: string): string {
        const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, CANVAS_LIMITS.id - 4) || 'zone';
        let id = base;
        for (let n = 2; this.drafts.has(id); n += 1) id = `${base}_${n}`;
        return id;
    }

    private finish(): DiagramGraph {
        const open = this.stack[this.stack.length - 1];
        if (open) throw atLine(open.line, `subgraph ${show(open.zone)} is not closed: expected "end"`);

        // Unnamed notes: note1, note2, … (never an id the text uses).
        const rename = new Map<string, string>();
        let n = 0;
        for (const id of this.order) {
            if (!id.startsWith('\u0000')) continue;
            let name: string;
            do {
                n += 1;
                name = `note${n}`;
            } while (this.drafts.has(name));
            rename.set(id, name);
        }
        const idOf = (id: string): string => rename.get(id) ?? id;

        for (const link of this.noteLinks) {
            const box = this.drafts.get(link.box)!;
            if (!box.named) {
                const ids = this.order.filter((id) => this.drafts.get(id)!.named && !this.drafts.get(id)!.note && !id.startsWith('\u0000'));
                throw atLine(link.line, `note for ${show(link.box)}: there is no box ${show(link.box)}.${ids.length > 0 ? ` Boxes: ${ids.slice(0, 15).join(', ')}${ids.length > 15 ? ', …' : ''}` : ''}`);
            }
        }

        const nodes: DiagramNode[] = this.order.map((key) => {
            const d = this.drafts.get(key)!;
            const shape: CanvasShape = d.zone ? 'zone' : d.note ? 'sticky' : (d.shape ?? (d.kind ? KIND_SHAPES[d.kind] : 'rect'));
            const node: DiagramNode = { id: idOf(key), shape, text: d.text ?? key, color: d.color };
            if (d.kind && !d.zone) node.kind = d.kind;
            if (d.size) node.size = d.size;
            if (d.parent) node.parent = idOf(d.parent);
            return node;
        });

        // An arrow between a zone and something inside it has nowhere to go.
        const parentOf = new Map(nodes.filter((nd) => nd.parent).map((nd) => [nd.id, nd.parent!]));
        const inside = (id: string, zone: string): boolean => {
            for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) if (at === zone) return true;
            return false;
        };
        const edges: DiagramEdge[] = this.edges.map(({ lineNo, noteLink, ...edge }) => {
            const from = idOf(edge.from);
            const to = idOf(edge.to);
            if (from === to && this.drafts.get(edge.from)!.zone) throw atLine(lineNo, `an arrow can't join zone ${show(from)} to itself`);
            if (inside(to, from) || inside(from, to)) {
                const [zone, member] = inside(to, from) ? [from, to] : [to, from];
                if (noteLink) throw atLine(lineNo, `a note inside zone ${show(zone)} can't be "for" that zone: move the note line out of the subgraph`);
                throw atLine(lineNo, `an arrow can't join zone ${show(zone)} to ${show(member)}, which is inside it: point it at a box in the zone, or at something outside`);
            }
            return { ...edge, from, to };
        });

        const notes = [...this.notes];
        if (this.drawnAsBox.length > 0) {
            const list = [...new Set(this.drawnAsBox)];
            notes.unshift(`Drawn as plain boxes: ${list.slice(0, 6).join(', ')}${list.length > 6 ? ', …' : ''} (shapes: [box], (rounded), ([pill]), [(database)], ((circle)), {decision}, [[queue]]).`);
        }
        return { direction: this.direction, canvasId: this.canvasId, height: this.height, nodes, edges, notes };
    }
}

/**
 * The text of a ```canvas fence → its diagram. A 400 ErrorResponse naming the line (`line 7: …`)
 * for anything it can't read.
 */
export function parseDiagram(text: string): DiagramGraph {
    return new DiagramParser().parse(text);
}
