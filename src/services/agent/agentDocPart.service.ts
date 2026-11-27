// TOOL_ACCESS_PLAN §10 (11-27, the picking test's misses): one part of a doc, named in words, changed in one call. The
// block tools need ids from get_outline first, and a chat that had found its tool through find_tools ran out of steps
// before the edit (F20, F22, F23). Here the part is named as a person would: a heading (its whole section), words
// quoted from inside a block, or a kind of block ("the code block", "the last bullet list", "the empty to-do list");
// the server finds it in the full text (the outline cuts at 80 characters). One change, one Undo, like the block tools.
import ErrorResponse from '../../utils/errorResponse';
import * as ops from '../docs/blocks/docOps';
import { markdownToBlocks } from '../docs/blocks/markdown';
import { readBlocks, type DocBlock, type InlineNode } from '../docs/blocks/serverEditor';
import { onNewEditor } from '../docs/blocks/newDocState';
import { writeBoards } from '../docs/canvas';
import { withLiveDoc } from './liveDoc';
import { logDocChange, normalizeHeading, requireEditableDoc } from './agentDocs.service';
import { renameCanvases, takenCanvasIds } from './agentBlocks.service';
import { plural, quoted, type AgentActor } from './agentEditLog';

export const PART_ACTIONS = ['replace', 'insert_before', 'insert_after', 'delete', 'move_to_start', 'move_to_end', 'tick', 'untick'] as const;
export type PartAction = (typeof PART_ACTIONS)[number];

/** The part found: sibling blocks in order (a section: its heading first). */
interface Part {
    blocks: DocBlock[];
    /** How the answer names it: the section "X", the code block, the to-do "Y", the bullet list "A…". */
    label: string;
    section?: { heading: DocBlock; level: number };
}

interface Placed {
    block: DocBlock;
    /** Its siblings (the group it is in) and its index there. */
    siblings: DocBlock[];
    index: number;
}

/** Kinds a person names, the block types they mean, and whether neighbours of the type make one unit (a list). */
const KINDS: ReadonlyArray<{ re: RegExp; types: readonly string[]; name: string; run?: boolean }> = [
    { re: /\bto-?dos?\b|\bchecklists?\b|\btask list\b|\bcheck ?boxes\b/, types: ['checkListItem'], name: 'to-do list', run: true },
    { re: /\bbullet(?:ed)? (?:list|points?)\b|\bbullets\b|\bbullet\b/, types: ['bulletListItem'], name: 'bullet list', run: true },
    { re: /\bnumbered (?:list|points?|steps?)\b/, types: ['numberedListItem'], name: 'numbered list', run: true },
    { re: /\bcode(?: block)?\b|\bsnippet\b/, types: ['codeBlock'], name: 'code block' },
    { re: /\bcallouts?\b/, types: ['callout'], name: 'callout' },
    { re: /\btables?\b/, types: ['table'], name: 'table' },
    { re: /\bdiagrams?\b|\bmermaid\b|\bflowcharts?\b/, types: ['diagram'], name: 'diagram' },
    { re: /\bcanvas(?:es)?\b|\bboards?\b/, types: ['canvas'], name: 'canvas' },
    { re: /\bimages?\b|\bpictures?\b|\bscreenshots?\b/, types: ['image'], name: 'image' },
    { re: /\bfiles?\b|\battachments?\b|\bpdfs?\b|\bspreadsheets?\b/, types: ['file'], name: 'file' },
    { re: /\bquotes?\b|\bblockquotes?\b/, types: ['quote'], name: 'quote' },
    { re: /\bdividers?\b|\bhorizontal (?:line|rule)\b/, types: ['divider'], name: 'divider' },
    { re: /\btoggles?\b/, types: ['toggleListItem'], name: 'toggle' },
    { re: /\bpage (?:link|block)s?\b/, types: ['page'], name: 'page link' },
];

/** Words that only point (articles, places in the doc, these words themselves): a kind phrase is nothing else. */
const FILLER = /\b(?:the|a|an|my|this|that|its|in|of|at|on|doc|document|note|notes|page|block|section|part|one|very|first|last|bottom|top|end|start|empty|blank|list)\b/g;

const norm = (s: string) =>
    s
        .toLowerCase()
        .replace(/[“”"‘’`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

const inlineText = (b: DocBlock): string => {
    const c = b.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return (c as InlineNode[]).map((n) => (n.type === 'text' ? n.text : n.content.map((x) => x.text).join(''))).join('');
    return '';
};

/** Every block in reading order with its siblings (children right after their parent). */
function placed(top: DocBlock[]): Placed[] {
    const out: Placed[] = [];
    const walk = (siblings: DocBlock[]) =>
        siblings.forEach((block, index) => {
            out.push({ block, siblings, index });
            walk(block.children);
        });
    walk(top);
    return out;
}

const levelOf = (b: DocBlock) => Number(b.props['level']) || 1;

/** A heading and what follows it among its siblings, to the next heading of the same or a higher level. */
function sectionAt(p: Placed): Part {
    const level = levelOf(p.block);
    let end = p.index + 1;
    while (end < p.siblings.length && !(p.siblings[end]!.type === 'heading' && levelOf(p.siblings[end]!) <= level)) end += 1;
    // The editor's trailing empty paragraph stays where it is.
    const last = p.siblings[end - 1]!;
    if (end === p.siblings.length && end - 1 > p.index && last.type === 'paragraph' && !inlineText(last).trim() && !last.children.length) end -= 1;
    return { blocks: p.siblings.slice(p.index, end), label: `the section ${quoted(inlineText(p.block).trim(), 60)}`, section: { heading: p.block, level } };
}

/** The neighbours of the same list type around one item (a list is its run of items). */
function runAt(p: Placed): DocBlock[] {
    let from = p.index;
    let to = p.index;
    while (from > 0 && p.siblings[from - 1]!.type === p.block.type) from -= 1;
    while (to + 1 < p.siblings.length && p.siblings[to + 1]!.type === p.block.type) to += 1;
    return p.siblings.slice(from, to + 1);
}

const firstWords = (b: DocBlock) => {
    const t = inlineText(b).replace(/\s+/g, ' ').trim();
    return t.length > 50 ? `${t.slice(0, 49)}…` : t;
};

function blockLabel(b: DocBlock): string {
    const kind = KINDS.find((k) => k.types.includes(b.type))?.name.replace(' list', '') ?? (b.type === 'heading' ? 'heading' : 'text');
    const words = firstWords(b);
    return words ? `the ${kind} ${quoted(words, 60)}` : `the ${kind}`;
}

const isEmptyBlock = (b: DocBlock) => !inlineText(b).trim() && b.children.every(isEmptyBlock);

function ambiguous(part: string, found: Part[], title: string): ErrorResponse {
    const lines = found.slice(0, 5).map((p) => `${p.blocks[0]!.id} · ${p.label}`);
    return new ErrorResponse(
        409,
        `${quoted(part, 100)} fits ${found.length} parts of ${quoted(title)}: ${lines.join('; ')}${found.length > 5 ? '; …' : ''}. ` +
            'Name it more exactly (quote its own words), or use update_block, move_blocks or delete_blocks with an id.'
    );
}

function notFound(part: string, top: DocBlock[], title: string): ErrorResponse {
    const heads = placed(top)
        .filter((p) => p.block.type === 'heading')
        .map((p) => quoted(inlineText(p.block).trim(), 50))
        .slice(0, 15);
    return new ErrorResponse(
        404,
        `Nothing in ${quoted(title)} fits ${quoted(part, 100)}.${heads.length ? ` Its headings: ${heads.join(', ')}.` : ''} ` +
            'Name a heading, quote words from the block, or name its kind ("the code block", "the last bullet list"); get_outline lists every block.'
    );
}

/** Finds the part a person named (throws 404 or 409 with what the doc has). */
export function findPart(top: DocBlock[], part: string, title: string): Part {
    const all = placed(top);
    const said = norm(part);
    const quotedWords = /["“‘'`]([^"”’'`]{2,})["”’'`]/.exec(part)?.[1];
    const kind = KINDS.find((k) => k.re.test(said));
    const wantLast = /\b(?:last|bottom|end)\b/.test(said);
    const wantFirst = /\b(?:first|top|start)\b/.test(said);
    const wantEmpty = /\b(?:empty|blank)\b/.test(said);

    // 1. A heading, by its text ("Self-test questions", "the Self-test questions section").
    if (!quotedWords) {
        const bare = normalizeHeading(said.replace(/^(?:the|my) /, '').replace(/^section /, '').replace(/ (?:section|heading)$/, ''));
        const heads = all.filter((p) => p.block.type === 'heading' && normalizeHeading(norm(inlineText(p.block))) === bare);
        if (heads.length === 1) return sectionAt(heads[0]!);
        if (heads.length > 1) throw ambiguous(part, heads.map(sectionAt), title);
    }

    // 2. A kind of block, alone with its pointers ("the code block", "the last bullet list", "the empty to-do list").
    const rest = kind ? said.replace(kind.re, ' ').replace(FILLER, ' ').replace(/[^a-z0-9]+/g, ' ').trim() : 'x';
    if (kind && !quotedWords && !rest) {
        const seen = new Set<DocBlock>();
        let units: Part[] = [];
        for (const p of all) {
            if (!kind.types.includes(p.block.type) || seen.has(p.block)) continue;
            const blocks = kind.run ? runAt(p) : [p.block];
            blocks.forEach((b) => seen.add(b));
            units.push({ blocks, label: blocks.length > 1 || kind.run ? `the ${kind.name}${blocks[0] && inlineText(blocks[0]).trim() ? ` ${quoted(firstWords(blocks[0]), 60)}` : ''}` : blockLabel(p.block) });
        }
        if (wantEmpty) units = units.filter((u) => u.blocks.every(isEmptyBlock));
        if (units.length > 1 && wantLast) units = [units[units.length - 1]!];
        else if (units.length > 1 && wantFirst) units = [units[0]!];
        if (units.length === 1) return { ...units[0]!, label: wantEmpty ? units[0]!.label.replace(/^the /, 'the empty ') : units[0]!.label };
        if (units.length > 1) throw ambiguous(part, units, title);
        throw notFound(part, top, title);
    }

    // 3. Words from inside a block (quoted, or the whole phrase), within the kind when one was named.
    const words = norm(quotedWords ?? part);
    let hits = all.filter((p) => norm(inlineText(p.block)).includes(words));
    if (kind && quotedWords) hits = hits.filter((p) => kind.types.includes(p.block.type));
    // A heading found by its words stands for its section.
    const parts = hits.map((p) => (p.block.type === 'heading' ? sectionAt(p) : { blocks: [p.block], label: blockLabel(p.block) }));
    if (parts.length === 1) return parts[0]!;
    if (parts.length > 1) throw ambiguous(part, parts, title);
    throw notFound(part, top, title);
}

const DONE_WORDS: Record<PartAction, string> = {
    replace: 'Replaced',
    insert_before: 'Added before',
    insert_after: 'Added after',
    delete: 'Deleted',
    move_to_start: 'Moved',
    move_to_end: 'Moved',
    tick: 'Ticked',
    untick: 'Unticked',
};

/**
 * POST /api/agent/docs/:id/part { part, action, markdown? } → { id, title, done, part: { label, blocks }, ids?, editId }.
 * replace on a section keeps its heading (as replace_section) unless the Markdown starts with a heading of the same or a
 * higher level (a rename); on a block or a list it takes their place.
 */
export async function editDocPartForAgent(actor: AgentActor, docId: string, input: { part: string; action: PartAction; markdown?: string | undefined }) {
    const doc = await requireEditableDoc(docId, actor.userId);
    const needsMarkdown = input.action === 'replace' || input.action === 'insert_before' || input.action === 'insert_after';
    if (needsMarkdown && !input.markdown?.trim()) throw new ErrorResponse(400, `${input.action} needs markdown: the new blocks`);
    // Parsed before the doc opens (a bad diagram is a 400 before anything changes).
    const parsed = needsMarkdown ? await markdownToBlocks(input.markdown!, {}) : null;
    if (parsed && !parsed.blocks.length) throw new ErrorResponse(400, 'markdown is empty');
    const out = await withLiveDoc(docId, actor.agentName, (live) => {
        if (!onNewEditor(live.doc)) throw new ErrorResponse(409, 'This doc is still on the old editor: change it with replace_section or append_to_doc');
        const top = readBlocks(live.doc);
        const found = findPart(top, input.part, doc.title || 'Untitled');
        const ids = found.blocks.map((b) => b.id);
        let made: string[] = [];
        let count = found.blocks.length;
        const fresh = () => {
            const { blocks, boards } = renameCanvases(parsed!.blocks, parsed!.boards, takenCanvasIds(live.doc));
            return { blocks, boards };
        };
        const change = live.apply(() => {
            switch (input.action) {
                case 'delete':
                    count = ops.remove(live.doc, ids);
                    break;
                case 'move_to_start':
                case 'move_to_end':
                    ops.move(live.doc, ids, { at: input.action === 'move_to_start' ? 'start' : 'end' });
                    break;
                case 'insert_before':
                case 'insert_after': {
                    const { blocks, boards } = fresh();
                    made = ops.insert(live.doc, blocks, input.action === 'insert_before' ? { before: ids[0]! } : { after: ids[ids.length - 1]! });
                    writeBoards(live.doc, boards);
                    break;
                }
                case 'replace': {
                    const { blocks, boards } = fresh();
                    const first = parsed!.blocks[0]!;
                    const rename = !!found.section && first.type === 'heading' && (Number(first.props?.['level']) || 1) <= found.section.level;
                    // A section keeps its heading unless the Markdown brings a new one.
                    const gone = found.section && !rename ? ids.slice(1) : ids;
                    made = found.section && !rename ? ops.insert(live.doc, blocks, { after: ids[0]! }) : ops.insert(live.doc, blocks, { before: ids[0]! });
                    if (gone.length) ops.remove(live.doc, gone);
                    writeBoards(live.doc, boards);
                    count = gone.length;
                    break;
                }
                case 'tick':
                case 'untick': {
                    const todos: DocBlock[] = [];
                    const walk = (bs: DocBlock[]) => {
                        for (const b of bs) {
                            if (b.type === 'checkListItem') todos.push(b);
                            walk(b.children);
                        }
                    };
                    walk(found.blocks);
                    if (!todos.length) throw new ErrorResponse(400, `${found.label} has no to-do to ${input.action}`);
                    for (const t of todos) ops.update(live.doc, t.id, { props: { checked: input.action === 'tick' } });
                    count = todos.length;
                    break;
                }
            }
        });
        return { change, found, made, count };
    });
    const title = doc.title || 'Untitled';
    const where = input.action === 'move_to_start' ? ' to the start' : input.action === 'move_to_end' ? ' to the end' : '';
    const what =
        input.action === 'insert_before' || input.action === 'insert_after'
            ? `${plural(out.made.length, 'block')} ${input.action === 'insert_before' ? 'before' : 'after'} ${out.found.label}`
            : input.action === 'tick' || input.action === 'untick'
              ? `${plural(out.count, 'to-do')} in ${out.found.label}`
              : `${out.found.label}${out.found.blocks.length > 1 ? ` (${plural(out.found.blocks.length, 'block')})` : ''}${where}`;
    const done = input.action === 'insert_before' || input.action === 'insert_after' ? `Added ${what}` : `${DONE_WORDS[input.action]} ${what}`;
    const editId = await logDocChange(actor, docId, out.change, 'doc_blocks', `${done} in ${quoted(title)}`.slice(0, 200));
    return { id: docId, title, done, part: { label: out.found.label, blocks: out.found.blocks.length }, ...(out.made.length ? { ids: out.made } : {}), editId };
}
