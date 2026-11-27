// The Markdown dialect v2 (DOCS_EDITOR_V2_PLAN §4.4): the new editor's blocks ⇄ Markdown, for agents
// and the app's AI. It is the old dialect (../markdown/docMarkdown.ts), so agents write exactly what
// they write today, plus real GFM tables:
//
//   print   blocks → Markdown, here, block by block (lossless for every block the editor has, except
//           text colours and nesting under non-list blocks, which Markdown can't carry)
//   parse   Markdown → the old dialect's validated JSON (callouts, <details>, ```mermaid, ```canvas
//           diagrams laid out by ELK) → blocks (./fromOldJson.ts)
//
// A round-trip test per block type keeps the two sides in step (tests/unit/docs/blocksMarkdown.test.ts).
import type { JSONContent } from '@tiptap/core';
import type * as Y from 'yjs';
import { markdownToDocJson } from '../markdown/docMarkdown';
import { printCanvasFence } from '../diagram/print';
import { resolveDiagrams, type CanvasReport } from '../diagram/resolve';
import { readBoard, takeCanvasData, type Board, type CanvasTarget } from '../canvas';
import { oldJsonToBlocks, type ConversionReport } from './fromOldJson';
import type { DocBlock, InlineNode, NewBlock, StyledText, TableContent } from './serverEditor';

type AnyBlock = DocBlock | NewBlock;

// ─── Inline ───────────────────────────────────────────────────────────

/** Characters that would start Markdown syntax inside text. */
/** A URL inside Markdown's (…): whitespace and parentheses encoded (encodeURIComponent leaves the parentheses). */
const linkUrl = (url: string) => url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

function escapeText(text: string): string {
    return text.replace(/([\\`*_[\]<>~|=])/g, '\\$1');
}

/** One styled run: marks wrap the text (code first: nothing is escaped inside it). */
function printRun(run: StyledText): string {
    const s = run.styles ?? {};
    // Lines of a run with a hard break: each line wrapped on its own, joined by "  \n" (a hard break).
    return run.text
        .split('\n')
        .map((line) => {
            if (!line) return '';
            const lead = line.match(/^\s*/)![0];
            const trail = line.match(/\s*$/)![0];
            let core = line.slice(lead.length, line.length - trail.length);
            if (!core) return line;
            if (s['code']) {
                const ticks = core.includes('`') ? '``' : '`';
                core = `${ticks}${core.startsWith('`') ? ' ' : ''}${core}${core.endsWith('`') ? ' ' : ''}${ticks}`;
            } else {
                core = escapeText(core);
            }
            if (s['backgroundColor']) core = `==${core}==`;
            if (s['underline']) core = `<u>${core}</u>`;
            if (s['strike']) core = `~~${core}~~`;
            if (s['italic']) core = `*${core}*`;
            if (s['bold']) core = `**${core}**`;
            return `${lead}${core}${trail}`;
        })
        .join('  \n');
}

export function printInline(content: readonly InlineNode[] | undefined): string {
    return (content ?? [])
        .map((n) => (n.type === 'link' ? `[${n.content.map(printRun).join('')}](${linkUrl(n.href)})` : printRun(n)))
        .join('');
}

const inline = (b: AnyBlock): InlineNode[] => (Array.isArray(b.content) ? (b.content as InlineNode[]) : []);
const plain = (b: AnyBlock): string => (typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as InlineNode[]).map((n) => (n.type === 'text' ? n.text : n.content.map((c) => c.text).join(''))).join('') : '');

// ─── Blocks ───────────────────────────────────────────────────────────

const indentLines = (text: string, pad: string) =>
    text
        .split('\n')
        .map((l) => (l ? pad + l : l))
        .join('\n');

const prefixLines = (prefix: string, text: string) =>
    text
        .split('\n')
        .map((l) => (l ? `${prefix}${l}` : prefix.trimEnd()))
        .join('\n');

function printTable(content: TableContent): string {
    const cellText = (c: TableContent['rows'][number]['cells'][number]) => printInline(Array.isArray(c) ? c : c.content).replace(/\n/g, ' ') || ' ';
    const rows = content.rows.map((r) => r.cells.map(cellText));
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? ' ').join(' | ')} |`;
    return [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

interface PrintContext {
    /** The doc's Y.Doc, for canvas boards (root maps). Without it a canvas prints with an empty board. */
    ydoc?: Y.Doc | undefined;
    /** DOC_PAGES_PLAN §5: the titles of the pages the reader may open (a page block prints `[Title](/docs/<id>)`). */
    pageTitles?: ReadonlyMap<string, string> | undefined;
}

/** A list run's items, nested children indented under each item. */
function printListItem(b: AnyBlock, marker: string, ctx: PrintContext): string {
    const text = printInline(inline(b));
    const head = `${marker}${text}`;
    const kids = b.children ?? [];
    if (!kids.length) return head;
    // A nested list follows on the next line; anything else needs a blank line, or Markdown reads it
    // as more of the item's own text (a lazy continuation line).
    const gap = LIST.has(kids[0]!.type) ? '\n' : '\n\n';
    return `${head}${gap}${indentLines(printBlocks(kids, ctx), ' '.repeat(marker.replace(/\[.\] $/, '').length))}`;
}

function printBlock(b: AnyBlock, ctx: PrintContext, numbered: number): string {
    const kids = b.children ?? [];
    const after = (text: string) => (kids.length ? `${text}\n\n${printBlocks(kids, ctx)}` : text);
    switch (b.type) {
        case 'page': {
            const id = String(b.props?.['docId'] ?? '');
            const title = id ? ctx.pageTitles?.get(id) : undefined;
            return after(title !== undefined ? `[${(title.trim() || 'Untitled').replace(/([[\]])/g, '\\$1')}](/docs/${id})` : '');
        }
        case 'paragraph':
            return after(printInline(inline(b)));
        case 'heading': {
            const level = Math.min(Math.max(Number(b.props?.['level']) || 1, 1), 6);
            if (b.props?.['isToggleable']) {
                // A toggle heading: a toggle whose summary is the heading ("## Title"); its children fold under it.
                const body = kids.length ? `${printBlocks(kids, ctx)}\n\n` : '';
                return `<details>\n<summary>${'#'.repeat(level)} ${printInline(inline(b)).replace(/ {2}\n/g, ' ')}</summary>\n\n${body}</details>`;
            }
            return after(`${'#'.repeat(level)} ${printInline(inline(b))}`);
        }
        case 'bulletListItem':
            return printListItem(b, '- ', ctx);
        case 'numberedListItem':
            return printListItem(b, `${numbered}. `, ctx);
        case 'checkListItem':
            return printListItem(b, b.props?.['checked'] ? '- [x] ' : '- [ ] ', ctx);
        case 'toggleListItem': {
            const body = kids.length ? `${printBlocks(kids, ctx)}\n\n` : '';
            return `<details>\n<summary>${printInline(inline(b)).replace(/ {2}\n/g, ' ')}</summary>\n\n${body}</details>`;
        }
        case 'quote': {
            const body = [printInline(inline(b)), kids.length ? printBlocks(kids, ctx) : ''].filter(Boolean).join('\n\n');
            return prefixLines('> ', body);
        }
        case 'callout': {
            const kind = String(b.props?.['kind'] ?? 'note').toUpperCase();
            const body = [printInline(inline(b)), kids.length ? printBlocks(kids, ctx) : ''].filter(Boolean).join('\n\n');
            return body ? `> [!${kind}]\n${prefixLines('> ', body)}` : `> [!${kind}]`;
        }
        case 'codeBlock': {
            const lang = String(b.props?.['language'] ?? '');
            const code = plain(b);
            const fence = code.includes('```') ? '````' : '```';
            return after(`${fence}${lang && lang !== 'text' ? lang : ''}\n${code}\n${fence}`);
        }
        case 'diagram':
            return after(`\`\`\`mermaid\n${plain(b)}\n\`\`\``);
        case 'canvas': {
            const canvasId = String(b.props?.['canvasId'] ?? '');
            const data = ctx.ydoc && canvasId ? readBoard(ctx.ydoc, canvasId) : undefined;
            return after(printCanvasFence({ canvasId: canvasId || null, height: b.props?.['height'], data }));
        }
        case 'divider':
            return after('---');
        case 'image': {
            const url = String(b.props?.['url'] ?? '');
            const alt = String(b.props?.['caption'] ?? '');
            return url ? after(`![${escapeText(alt)}](${linkUrl(url)})`) : '';
        }
        case 'file':
        case 'video':
        case 'audio': {
            // Files in docs (11-27): a link with the file's name (BlockNote keeps url, name and caption).
            const url = String(b.props?.['url'] ?? '');
            const name = String(b.props?.['name'] ?? '').trim() || decodeURIComponent(url.split('/').pop() ?? '') || 'file';
            return url ? after(`[${escapeText(name)}](${linkUrl(url)})`) : '';
        }
        case 'table':
            return after(b.content && typeof b.content === 'object' && !Array.isArray(b.content) ? printTable(b.content as TableContent) : '');
        default:
            return after(printInline(inline(b)));
    }
}

const LIST = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);

/** Blocks → Markdown. List items of one run sit on consecutive lines; other blocks are separated by a blank line. */
export function printBlocks(blocks: readonly AnyBlock[], ctx: PrintContext = {}): string {
    const parts: string[] = [];
    let prev: AnyBlock | null = null;
    let n = 0;
    for (const b of blocks) {
        if (b.type === 'numberedListItem') n = prev?.type === 'numberedListItem' ? n + 1 : Number(b.props?.['start']) || 1;
        const text = printBlock(b, ctx, n);
        const tight = prev && LIST.has(prev.type) && prev.type === b.type;
        // An empty paragraph between blocks is a blank line the editor shows; Markdown drops it.
        if ((b.type === 'paragraph' || b.type === 'page' || b.type === 'file' || b.type === 'video' || b.type === 'audio') && !text && !(b.children ?? []).length) {
            prev = b;
            continue;
        }
        parts.push(tight ? `\n${text}` : parts.length ? `\n\n${text}` : text);
        prev = b;
    }
    return parts.join('');
}

// ─── Parse ────────────────────────────────────────────────────────────

/**
 * Markdown (the dialect) → new blocks: the old dialect's parse and checks (400 on what it refuses),
 * canvas diagrams laid out and given ids against `target` (a live doc's canvases; a fresh id for
 * each by default), then the conversion. `boards`: the canvases' boards by id, for the caller to
 * write into the doc's root maps in the same change as the blocks.
 */
export async function markdownToBlocks(
    markdown: string,
    target: CanvasTarget = {},
    options: { checkMermaid?: boolean } = {}
): Promise<{ blocks: NewBlock[]; boards: Map<string, Board>; canvases: CanvasReport[]; report: ConversionReport }> {
    const json: JSONContent = markdownToDocJson(markdown, { maxHeading: 6 });
    const canvases = await resolveDiagrams(json, options);
    const { json: absorbed, boards } = takeCanvasData(json, target);
    const { blocks, report } = oldJsonToBlocks(absorbed);
    return { blocks, boards, canvases, report };
}
