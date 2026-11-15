// The old editor's doc (TipTap JSON, docSchema.ts) as the new editor's blocks (BlockNote JSON), mapped
// node by node, never through Markdown (DOCS_EDITOR_V2_PLAN §6 phase 4, §11 block audit). Used by
// the migration of every doc and by the Markdown dialect v2's parse (Markdown → old JSON → blocks).
//
//   paragraph, heading 1–6            paragraph, heading (same level; the old editor had 1–3)
//   bulletList / orderedList / taskList   bullet / numbered (first item keeps `start`) / check list items;
//                                     an item's first paragraph is its text, the rest are its children
//   blockquote                        quote (paragraphs joined by line breaks; other blocks as children)
//   codeBlock                         codeBlock with its language; ```mermaid → diagram; a GFM table kept
//                                     as code by the old dialect → a real table
//   horizontalRule                    divider
//   callout (5 kinds)                 callout (paragraphs joined by line breaks; other blocks as children)
//   details (summary + content)       toggle list item (the summary its text, the content its children);
//                                     a summary "## Title" or "<h2>Title</h2>" → a toggle heading
//   canvas                            canvas (same canvasId and height: the board stays in the Y.Doc's root maps)
//   resizableImage / image            image (src → url; a pixel width → previewWidth)
//   mediaRow / mediaItem              images, one per item
//   embed                             a paragraph with the link (no embed block in the new editor)
//   inlineAi                          dropped (the old "Ask AI to write" node, §11)
// Marks: bold, italic, strike, code, underline as styles; link as a link; highlight → a background
// colour; a text colour → textColor when it is one of BlockNote's names. A hard break is "\n".
import type { JSONContent } from '@tiptap/core';
import type { InlineNode, NewBlock, Styles, StyledText, TableContent } from './serverEditor';

/** What the conversion did beyond a plain mapping: node types dropped or merged, by count. */
export interface ConversionReport {
    dropped: Record<string, number>;
    merged: Record<string, number>;
}

const COLORS = new Set(['gray', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']);
const HIGHLIGHT_COLOR = 'yellow';

const count = (into: Record<string, number>, key: string) => {
    into[key] = (into[key] ?? 0) + 1;
};

const textOf = (nodes: readonly JSONContent[] | undefined): string =>
    (nodes ?? []).map((n) => (n.type === 'text' ? n.text ?? '' : n.type === 'hardBreak' ? '\n' : textOf(n.content))).join('');

function colorName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase().replace(/^var\(--[\w-]*?(\w+)\)$/, '$1');
    return COLORS.has(v) ? v : null;
}

/** Marks → BlockNote styles; the link (if any) separately. */
function stylesOf(marks: JSONContent['marks']): { styles: Styles; href: string | null } {
    const styles: Styles = {};
    let href: string | null = null;
    for (const m of marks ?? []) {
        switch (m.type) {
            case 'bold':
            case 'italic':
            case 'strike':
            case 'code':
            case 'underline':
                styles[m.type] = true;
                break;
            case 'highlight':
                styles['backgroundColor'] = colorName(m.attrs?.['color']) ?? HIGHLIGHT_COLOR;
                break;
            case 'textStyle': {
                const c = colorName(m.attrs?.['color']);
                if (c) styles['textColor'] = c;
                break;
            }
            case 'link':
                if (typeof m.attrs?.['href'] === 'string' && m.attrs['href']) href = m.attrs['href'];
                break;
            default:
                break;
        }
    }
    return { styles, href };
}

const sameStyles = (a: Styles, b: Styles) => {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/** Inline content (text with marks, hard breaks) as BlockNote inline nodes; neighbours with the same styles merge. */
/**
 * A toggle's summary that is a heading makes a toggle heading: "## Title" (how the dialect prints
 * one) keeps the title's marks; "<h2>Title</h2>" (GitHub's way) keeps its words. Anything else: null.
 */
function toggleHeading(summary: readonly JSONContent[] | undefined): { level: number; content: InlineNode[] } | null {
    const content = inlineContent(summary);
    const first = content[0];
    const hashes = first?.type === 'text' ? /^(#{1,6})[ \t]+/.exec(first.text) : null;
    if (first?.type === 'text' && hashes) {
        const rest = first.text.slice(hashes[0].length);
        const out: InlineNode[] = rest ? [{ ...first, text: rest }, ...content.slice(1)] : content.slice(1);
        return out.length ? { level: hashes[1]!.length, content: out } : null;
    }
    const words = content.map((n) => (n.type === 'text' ? n.text : n.content.map((c) => c.text).join(''))).join('');
    const tag = /^\s*<h([1-6])>([\s\S]*?)<\/h\1>\s*$/i.exec(words);
    return tag && tag[2]!.trim() ? { level: Number(tag[1]), content: [{ type: 'text', text: tag[2]!.trim(), styles: {} }] } : null;
}

export function inlineContent(nodes: readonly JSONContent[] | undefined): InlineNode[] {
    const out: InlineNode[] = [];
    const push = (text: string, styles: Styles, href: string | null) => {
        if (!text) return;
        const last = out[out.length - 1];
        if (href) {
            if (last?.type === 'link' && last.href === href) {
                const tail = last.content[last.content.length - 1];
                if (tail && sameStyles(tail.styles, styles)) tail.text += text;
                else last.content.push({ type: 'text', text, styles });
                return;
            }
            out.push({ type: 'link', href, content: [{ type: 'text', text, styles }] });
            return;
        }
        if (last?.type === 'text' && sameStyles(last.styles, styles)) last.text += text;
        else out.push({ type: 'text', text, styles });
    };
    for (const n of nodes ?? []) {
        if (n.type === 'text') {
            const { styles, href } = stylesOf(n.marks);
            push(n.text ?? '', styles, href);
        } else if (n.type === 'hardBreak') {
            const last = out[out.length - 1];
            // The break takes the styles of the text before it (no separate run).
            if (last?.type === 'text') last.text += '\n';
            else if (last?.type === 'link') push('\n', {}, null);
            else push('\n', {}, null);
        } else if (Array.isArray(n.content)) {
            for (const c of inlineContent(n.content)) out.push(c);
        }
    }
    return out;
}

/** Paragraphs' inline content joined by line breaks (a quote or a callout holds one run of text). */
function joinParagraphs(paragraphs: readonly JSONContent[]): InlineNode[] {
    const out: InlineNode[] = [];
    paragraphs.forEach((p, i) => {
        if (i > 0) out.push({ type: 'text', text: '\n', styles: {} });
        out.push(...inlineContent(p.content));
    });
    return mergeRuns(out);
}

function mergeRuns(nodes: InlineNode[]): InlineNode[] {
    const out: InlineNode[] = [];
    for (const n of nodes) {
        const last = out[out.length - 1];
        if (n.type === 'text' && last?.type === 'text' && sameStyles(last.styles, n.styles)) last.text += n.text;
        else out.push(n.type === 'text' ? { ...n } : { ...n, content: n.content.map((c) => ({ ...c })) });
    }
    return out;
}

// ─── GFM tables (the old dialect kept them as code) ────────────────────

const splitRow = (line: string): string[] => {
    const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells: string[] = [];
    let cur = '';
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i]!;
        if (ch === '\\' && body[i + 1] === '|') {
            cur += '|';
            i += 1;
        } else if (ch === '|') {
            cells.push(cur.trim());
            cur = '';
        } else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
};

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A GFM table's text as a BlockNote table (cells as plain text), or null when it isn't one. */
export function tableFromGfm(text: string): TableContent | null {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2 || !lines[0]!.includes('|') || !SEPARATOR.test(lines[1]!)) return null;
    const header = splitRow(lines[0]!);
    const width = header.length;
    const rows = [header, ...lines.slice(2).filter((l) => l.trim()).map(splitRow)].map((cells) => {
        const padded = [...cells.slice(0, width), ...Array.from({ length: Math.max(0, width - cells.length) }, () => '')];
        return { cells: padded.map((c): InlineNode[] => (c ? [{ type: 'text', text: c, styles: {} } satisfies StyledText] : [])) };
    });
    return { type: 'tableContent', headerRows: 1, rows };
}

// ─── Blocks ───────────────────────────────────────────────────────────

function pixelWidth(value: unknown): number | undefined {
    if (typeof value === 'number' && value > 0) return Math.round(value);
    if (typeof value === 'string' && /^\d+(\.\d+)?(px)?$/.test(value.trim())) return Math.round(parseFloat(value));
    return undefined;
}

function imageBlock(attrs: Record<string, unknown> | undefined): NewBlock | null {
    const url = typeof attrs?.['src'] === 'string' ? attrs['src'] : '';
    if (!url || url.startsWith('blob:')) return null;
    const props: Record<string, unknown> = { url };
    const width = pixelWidth(attrs?.['width']);
    if (width) props['previewWidth'] = width;
    if (typeof attrs?.['alt'] === 'string' && attrs['alt']) props['caption'] = attrs['alt'];
    return { type: 'image', props };
}

/** A list item's blocks: its first paragraph is the item's text, everything after it its children. */
function listItem(item: JSONContent, type: string, props: Record<string, unknown>, report: ConversionReport): NewBlock {
    const kids = item.content ?? [];
    const first = kids[0]?.type === 'paragraph' ? kids[0] : null;
    const rest = first ? kids.slice(1) : kids;
    return { type, props, content: first ? inlineContent(first.content) : [], children: convertBlocks(rest, report) };
}

/** Paragraph-like containers (quote, callout): leading paragraphs become the text, the rest children. */
function textAndChildren(node: JSONContent, report: ConversionReport): { content: InlineNode[]; children: NewBlock[] } {
    const kids = node.content ?? [];
    let i = 0;
    while (i < kids.length && kids[i]!.type === 'paragraph') i += 1;
    if (i > 1) count(report.merged, `${node.type}: paragraphs joined`);
    return { content: joinParagraphs(kids.slice(0, i)), children: convertBlocks(kids.slice(i), report) };
}

function convertBlock(node: JSONContent, report: ConversionReport): NewBlock[] {
    switch (node.type) {
        case 'paragraph':
            return [{ type: 'paragraph', content: inlineContent(node.content) }];
        case 'heading': {
            const level = Math.min(Math.max(Number(node.attrs?.['level']) || 1, 1), 6);
            return [{ type: 'heading', props: { level }, content: inlineContent(node.content) }];
        }
        case 'bulletList':
            return (node.content ?? []).map((item) => listItem(item, 'bulletListItem', {}, report));
        case 'orderedList': {
            const start = Number(node.attrs?.['start']) || 1;
            return (node.content ?? []).map((item, i) => listItem(item, 'numberedListItem', i === 0 && start !== 1 ? { start } : {}, report));
        }
        case 'taskList':
            return (node.content ?? []).map((item) => listItem(item, 'checkListItem', { checked: item.attrs?.['checked'] === true }, report));
        case 'listItem':
        case 'taskItem':
            // A stray item outside its list (the old repair re-wraps these; be safe here too).
            return [listItem(node, node.type === 'taskItem' ? 'checkListItem' : 'bulletListItem', node.type === 'taskItem' ? { checked: node.attrs?.['checked'] === true } : {}, report)];
        case 'blockquote': {
            const { content, children } = textAndChildren(node, report);
            return [{ type: 'quote', content, children }];
        }
        case 'callout': {
            const kind = String(node.attrs?.['kind'] ?? 'note');
            const { content, children } = textAndChildren(node, report);
            return [{ type: 'callout', props: { kind: ['note', 'tip', 'important', 'warning', 'caution'].includes(kind) ? kind : 'note' }, content, children }];
        }
        case 'codeBlock': {
            const language = typeof node.attrs?.['language'] === 'string' && node.attrs['language'] ? (node.attrs['language'] as string) : '';
            const text = textOf(node.content);
            if (language.toLowerCase() === 'mermaid') return [{ type: 'diagram', content: text }];
            if (!language) {
                const table = tableFromGfm(text);
                if (table) return [{ type: 'table', content: table }];
            }
            return [{ type: 'codeBlock', props: { language: language || 'text' }, content: text }];
        }
        case 'horizontalRule':
            return [{ type: 'divider' }];
        case 'details': {
            const summary = (node.content ?? []).find((c) => c.type === 'detailsSummary');
            const body = (node.content ?? []).find((c) => c.type === 'detailsContent');
            const children = convertBlocks(body?.content ?? [], report).filter((b, i, all) => !(all.length === 1 && isEmptyParagraph(b)));
            // A summary that is a heading ("## Title" as the dialect prints it, or "<h2>Title</h2>") makes a toggle heading.
            const asHeading = toggleHeading(summary?.content);
            if (asHeading) return [{ type: 'heading', props: { level: asHeading.level, isToggleable: true }, content: asHeading.content, children }];
            return [{ type: 'toggleListItem', content: inlineContent(summary?.content), children }];
        }
        case 'canvas': {
            const canvasId = typeof node.attrs?.['canvasId'] === 'string' ? (node.attrs['canvasId'] as string) : '';
            if (!canvasId) {
                count(report.dropped, 'canvas without a board id');
                return [];
            }
            const height = Number(node.attrs?.['height']) || 440;
            return [{ type: 'canvas', props: { canvasId, height } }];
        }
        case 'resizableImage':
        case 'image': {
            const img = imageBlock(node.attrs);
            if (!img) count(report.dropped, `${node.type} without a stored address`);
            return img ? [img] : [];
        }
        case 'mediaRow':
            return (node.content ?? []).flatMap((item) => {
                const img = imageBlock(item.attrs);
                if (!img) count(report.dropped, 'media item without a stored address');
                return img ? [img] : [];
            });
        case 'mediaItem': {
            const img = imageBlock(node.attrs);
            return img ? [img] : [];
        }
        case 'embed': {
            const url = typeof node.attrs?.['url'] === 'string' ? (node.attrs['url'] as string) : '';
            count(report.merged, 'embed: became a link');
            return url ? [{ type: 'paragraph', content: [{ type: 'link', href: url, content: [{ type: 'text', text: url, styles: {} }] }] }] : [];
        }
        case 'inlineAi':
            count(report.dropped, 'inlineAi');
            return [];
        default:
            if (Array.isArray(node.content) && node.content.length) {
                count(report.merged, `${node.type ?? 'unknown'}: unwrapped`);
                return convertBlocks(node.content, report);
            }
            count(report.dropped, node.type ?? 'unknown');
            return [];
    }
}

function isEmptyParagraph(b: NewBlock): boolean {
    return b.type === 'paragraph' && (!Array.isArray(b.content) || b.content.every((c) => c.type === 'text' && !c.text)) && !(b.children ?? []).length;
}

function convertBlocks(nodes: readonly JSONContent[], report: ConversionReport): NewBlock[] {
    return nodes.flatMap((n) => convertBlock(n, report));
}

/** The old doc (its JSON) as new blocks, with what was dropped or merged. */
export function oldJsonToBlocks(doc: JSONContent): { blocks: NewBlock[]; report: ConversionReport } {
    const report: ConversionReport = { dropped: {}, merged: {} };
    const blocks = convertBlocks(doc.type === 'doc' ? doc.content ?? [] : [doc], report);
    return { blocks, report };
}
