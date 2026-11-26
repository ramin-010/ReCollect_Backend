// The new editor's blocks as the old editor's JSON (TipTap, docSchema.ts): the reverse of
// ./fromOldJson.ts, so every reader written for the old content (search text, previews, Recall
// material, the old Markdown printer) reads a doc on the new editor unchanged until it is rewritten
// for blocks. Tables become the old dialect's GFM code block; children of a non-list block follow it.
import type { JSONContent } from '@tiptap/core';
import type { DocBlock, InlineNode, NewBlock, Styles, TableContent } from './serverEditor';

type AnyBlock = DocBlock | NewBlock;

/** DOC_PAGES_PLAN §5: the titles of the pages the reader may open; a page block prints as `[Title](/docs/<id>)`. */
export interface OldJsonOptions {
    pageTitles?: ReadonlyMap<string, string>;
}

/** The docs page blocks point at, anywhere in these blocks. */
export function pageIdsIn(blocks: readonly AnyBlock[]): string[] {
    const out: string[] = [];
    const walk = (list: readonly AnyBlock[]) => {
        for (const b of list) {
            if (b.type === 'page' && typeof b.props?.['docId'] === 'string' && b.props['docId']) out.push(b.props['docId']);
            if (b.children?.length) walk(b.children as AnyBlock[]);
        }
    };
    walk(blocks);
    return [...new Set(out)];
}

function marksOf(styles: Styles, href?: string): JSONContent['marks'] {
    const marks: NonNullable<JSONContent['marks']> = [];
    for (const k of ['bold', 'italic', 'strike', 'code', 'underline'] as const) if (styles[k]) marks.push({ type: k });
    if (typeof styles['backgroundColor'] === 'string' && styles['backgroundColor'] !== 'default') marks.push({ type: 'highlight', attrs: { color: styles['backgroundColor'] } });
    if (typeof styles['textColor'] === 'string' && styles['textColor'] !== 'default') marks.push({ type: 'textStyle', attrs: { color: styles['textColor'] } });
    if (href) marks.push({ type: 'link', attrs: { href } });
    return marks.length ? marks : undefined;
}

/** Inline nodes → old inline JSON: text runs with marks, "\n" as hard breaks. */
export function inlineToOld(content: unknown): JSONContent[] {
    const out: JSONContent[] = [];
    const run = (text: string, styles: Styles, href?: string) => {
        text.split('\n').forEach((part, i) => {
            if (i > 0) out.push({ type: 'hardBreak' });
            if (!part) return;
            const marks = marksOf(styles, href);
            out.push(marks ? { type: 'text', text: part, marks } : { type: 'text', text: part });
        });
    };
    if (typeof content === 'string') run(content, {});
    else if (Array.isArray(content))
        for (const n of content as InlineNode[]) {
            if (n.type === 'text') run(n.text, n.styles ?? {});
            else for (const c of n.content) run(c.text, c.styles ?? {}, n.href);
        }
    return out;
}

const plainText = (content: unknown): string =>
    typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content as InlineNode[]).map((n) => (n.type === 'text' ? n.text : n.content.map((c) => c.text).join(''))).join('')
          : '';

const paragraph = (content: unknown): JSONContent => {
    const inner = inlineToOld(content);
    return inner.length ? { type: 'paragraph', content: inner } : { type: 'paragraph' };
};

function tableText(content: TableContent): string {
    const cell = (c: TableContent['rows'][number]['cells'][number]) => plainText(Array.isArray(c) ? c : c.content).replace(/\|/g, '\\|').replace(/\n/g, ' ') || ' ';
    const rows = content.rows.map((r) => r.cells.map(cell));
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? ' ').join(' | ')} |`;
    return [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

const LIST: Record<string, string> = { bulletListItem: 'bulletList', numberedListItem: 'orderedList', checkListItem: 'taskList' };

function listItemToOld(b: AnyBlock, opts: OldJsonOptions): JSONContent {
    const item: JSONContent = { type: b.type === 'checkListItem' ? 'taskItem' : 'listItem', content: [paragraph(b.content), ...blocksToOldNodes(b.children ?? [], opts)] };
    if (b.type === 'checkListItem') item.attrs = { checked: b.props?.['checked'] === true };
    return item;
}

function blockToOld(b: AnyBlock, opts: OldJsonOptions): JSONContent[] {
    const after = blocksToOldNodes(b.children ?? [], opts);
    switch (b.type) {
        case 'page': {
            // A line with one link when the reader may open the page; nothing otherwise (search, previews, Recall).
            const id = String(b.props?.['docId'] ?? '');
            const title = id ? opts.pageTitles?.get(id) : undefined;
            if (title === undefined) return after;
            return [{ type: 'paragraph', content: [{ type: 'text', text: title.trim() || 'Untitled', marks: [{ type: 'link', attrs: { href: `/docs/${id}` } }] }] }, ...after];
        }
        case 'paragraph':
            return [paragraph(b.content), ...after];
        case 'heading': {
            const level = Math.min(Math.max(Number(b.props?.['level']) || 1, 1), 6);
            if (b.props?.['isToggleable']) {
                // A toggle heading reads as the dialect writes it: a toggle whose summary is "## Title".
                const title = inlineToOld(b.content).map((n) => n.text ?? '').join('');
                return [
                    {
                        type: 'details',
                        attrs: { open: false },
                        content: [
                            { type: 'detailsSummary', content: title ? [{ type: 'text', text: `${'#'.repeat(level)} ${title}` }] : [] },
                            { type: 'detailsContent', content: after.length ? after : [{ type: 'paragraph' }] },
                        ],
                    },
                ];
            }
            return [{ type: 'heading', attrs: { level }, content: inlineToOld(b.content) }, ...after];
        }
        case 'toggleListItem':
            return [
                {
                    type: 'details',
                    attrs: { open: false },
                    content: [
                        { type: 'detailsSummary', content: inlineToOld(b.content) },
                        { type: 'detailsContent', content: after.length ? after : [{ type: 'paragraph' }] },
                    ],
                },
            ];
        case 'quote':
            return [{ type: 'blockquote', content: [paragraph(b.content), ...after] }];
        case 'callout':
            return [{ type: 'callout', attrs: { kind: String(b.props?.['kind'] ?? 'note') }, content: [paragraph(b.content), ...after] }];
        case 'codeBlock': {
            const lang = String(b.props?.['language'] ?? '');
            const text = plainText(b.content);
            return [{ type: 'codeBlock', attrs: { language: lang && lang !== 'text' ? lang : null }, ...(text ? { content: [{ type: 'text', text }] } : {}) }, ...after];
        }
        case 'diagram': {
            const text = plainText(b.content);
            return [{ type: 'codeBlock', attrs: { language: 'mermaid' }, ...(text ? { content: [{ type: 'text', text }] } : {}) }, ...after];
        }
        case 'canvas':
            return [{ type: 'canvas', attrs: { canvasId: String(b.props?.['canvasId'] ?? '') || null, height: Number(b.props?.['height']) || 440 } }, ...after];
        case 'image': {
            const url = String(b.props?.['url'] ?? '');
            const w = Number(b.props?.['previewWidth']);
            return url ? [{ type: 'resizableImage', attrs: { src: url, alt: String(b.props?.['caption'] ?? '') || null, width: w > 0 ? `${w}px` : '100%' } }, ...after] : after;
        }
        case 'divider':
            return [{ type: 'horizontalRule' }, ...after];
        case 'table': {
            const text = b.content && typeof b.content === 'object' && !Array.isArray(b.content) ? tableText(b.content as TableContent) : '';
            return [{ type: 'codeBlock', attrs: { language: null }, ...(text ? { content: [{ type: 'text', text }] } : {}) }, ...after];
        }
        default:
            return [paragraph(b.content), ...after];
    }
}

/** Blocks → old block nodes; consecutive list items of one kind become one list. */
export function blocksToOldNodes(blocks: readonly AnyBlock[], opts: OldJsonOptions = {}): JSONContent[] {
    const out: JSONContent[] = [];
    for (const b of blocks) {
        const listType = LIST[b.type];
        if (listType) {
            const last = out[out.length - 1];
            if (last?.type === listType && !(b.type === 'numberedListItem' && b.props?.['start'] !== undefined && Number(b.props['start']) !== 1)) {
                last.content!.push(listItemToOld(b, opts));
                continue;
            }
            const start = Number(b.props?.['start']) || 1;
            out.push({ type: listType, ...(listType === 'orderedList' && start !== 1 ? { attrs: { start } } : {}), content: [listItemToOld(b, opts)] });
            continue;
        }
        out.push(...blockToOld(b, opts));
    }
    return out;
}

/** The doc's blocks as an old JSON doc. */
export function blocksToOldJson(blocks: readonly AnyBlock[], opts: OldJsonOptions = {}): JSONContent {
    return { type: 'doc', content: blocksToOldNodes(blocks, opts) };
}
