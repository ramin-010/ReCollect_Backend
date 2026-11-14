// The doc schema on the server: the TipTap extensions of every doc, headless (no React, no DOM).
//
// THE SCHEMA MUST MATCH THE FRONTEND EDITOR. It mirrors recollect/lib/editor/docSchema.ts
// (docSchemaExtensions) and the node definitions in recollect/lib/extensions/*.tsx (name, group,
// content, attrs, parseHTML, renderHTML only; node views are browser-only):
//   StarterKit v3 (headings 1–3; Link and Underline included), ResizableImage, TaskList,
//   TaskItem (nested), Highlight (multicolor), TextStyle + Color, EmbedNode, MediaRow, MediaItem,
//   InlineAINode,
// plus blocks defined identically on both sides:
//   callout  : group block, content block+, attr kind ∈ note|tip|important|warning|caution
//              (default note), HTML <div data-callout="<kind>">…</div>
//   details  : @tiptap/extension-details (details[open] > detailsSummary + detailsContent),
//              configured with persist: true so `open` is an attribute.
//   canvas   : a board of boxes and arrows (recollect/lib/extensions/Canvas.tsx;
//              context/specs/CANVAS_BLOCK_SPEC.md): group block, atom, selectable, not draggable,
//              attrs canvasId (cv_… or null), height (frame px, default 440) and data (a Board, or
//              null: a transient carrier, never stored in the fragment; the board lives in the
//              Y.Doc root maps canvas:<id>:nodes / :edges, see ./canvas.ts). div[data-type=canvas]
//              with data-canvas-id, data-height, data-board. Markdown: a ```canvas fence, printed
//              in the text form (./diagram/print.ts); the v1 JSON form is still read.
// and the plain `image` node of the old server schema (older content only; Markdown never makes it).
// Side-by-side columns were removed on 2026-11-14; ./docRepair.ts flattens any stored ones on load.
//
// Why it matters: in the browser, y-prosemirror DELETES any Yjs element or mark it cannot map to
// its schema, so a node the server writes that the editor doesn't know is lost for good once the
// doc is opened. Only write node types that exist in recollect/lib/editor/docSchema.ts.
//
// The Markdown handlers (parseMarkdown / renderMarkdown / markdownTokenizer, read by
// @tiptap/markdown's MarkdownManager) live on the custom nodes below; getSchema() ignores them.
// See ./markdown/docMarkdown.ts for the Markdown dialect.
import { Node as TiptapNode, getSchema, mergeAttributes, type AnyExtension, type JSONContent, type MarkdownRendererHelpers } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { OrderedList, TaskItem, TaskList } from '@tiptap/extension-list';
import Highlight from '@tiptap/extension-highlight';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import Image from '@tiptap/extension-image';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import type { Schema } from '@tiptap/pm/model';
import { CANVAS_DEFAULT_HEIGHT, canvasHeight, isCanvasId } from './canvas';
import { printCanvasFence } from './diagram/print';

/** The Y.XmlFragment the editor binds to (TipTap Collaboration's default field). */
export const DOC_YJS_FRAGMENT = 'default';

// ─── Markdown helpers ──────────────────────────────────────────────────

/** Render block children one by one (keeps sibling context), separated by a blank line. */
function renderBlocks(nodes: readonly JSONContent[] | undefined, h: MarkdownRendererHelpers): string {
    return (nodes ?? []).map((child, i) => (h.renderChild ? h.renderChild(child, i) : h.renderChildren([child]))).join('\n\n');
}

/** Prefix every line (`> ` for quotes; empty lines get the bare marker). */
function prefixLines(prefix: string, text: string): string {
    return text
        .split('\n')
        .map((line) => (line.trim() === '' ? prefix.trimEnd() : `${prefix}${line}`))
        .join('\n');
}

const emptyParagraph = (): JSONContent => ({ type: 'paragraph', content: [] });

// ─── Callout ───────────────────────────────────────────────────────────

export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export function calloutKind(value: unknown): CalloutKind {
    const kind = String(value ?? '').trim().toLowerCase();
    return (CALLOUT_KINDS as readonly string[]).includes(kind) ? (kind as CalloutKind) : 'note';
}

const CALLOUT_START = /^ {0,3}>[ \t]?\[!(?:note|tip|important|warning|caution)\]/im;
const CALLOUT_FIRST_LINE = /^ {0,3}>[ \t]?\[!(note|tip|important|warning|caution)\][ \t]*([^\n]*)(?:\n|$)/i;
const QUOTE_LINE = /^ {0,3}>[^\n]*(?:\n|$)/;

/**
 * A callout block. Markdown: GitHub alert syntax
 *   > [!TIP]
 *   > Body, any blocks.
 */
export const Callout = TiptapNode.create({
    name: 'callout',
    group: 'block',
    content: 'block+',
    defining: true,

    addAttributes() {
        return {
            kind: {
                default: 'note',
                parseHTML: (element: HTMLElement) => calloutKind(element.getAttribute('data-callout')),
                renderHTML: (attributes: Record<string, unknown>) => ({ 'data-callout': calloutKind(attributes['kind']) }),
            },
        };
    },

    parseHTML() {
        return [{ tag: 'div[data-callout]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(HTMLAttributes), 0];
    },

    markdownTokenizer: {
        name: 'callout',
        level: 'block',
        start: (src: string) => {
            const match = CALLOUT_START.exec(src);
            return match ? match.index : -1;
        },
        tokenize(src, _tokens, lexer) {
            const first = CALLOUT_FIRST_LINE.exec(src);
            if (!first) return undefined;
            let raw = first[0];
            const lines: string[] = [];
            if (first[2]?.trim()) lines.push(first[2]);
            let rest = src.slice(raw.length);
            for (let line = QUOTE_LINE.exec(rest); line && line[0]; line = QUOTE_LINE.exec(rest)) {
                raw += line[0];
                lines.push(line[0].replace(/\n$/, '').replace(/^ {0,3}>[ \t]?/, ''));
                rest = rest.slice(line[0].length);
            }
            const body = lines.join('\n');
            return {
                type: 'callout',
                raw,
                kind: calloutKind(first[1]),
                tokens: body.trim() ? lexer.blockTokens(`${body}\n`) : [],
            };
        },
    },

    parseMarkdown(token, h) {
        const content = h.parseChildren(token.tokens ?? []);
        return h.createNode('callout', { kind: calloutKind(token['kind']) }, content.length > 0 ? content : [emptyParagraph()]);
    },

    renderMarkdown(node, h) {
        const kind = calloutKind(node.attrs?.['kind']).toUpperCase();
        const body = renderBlocks(node.content, h);
        return body.trim() ? `> [!${kind}]\n${prefixLines('> ', body)}` : `> [!${kind}]`;
    },
});

// ─── Toggle (details) ──────────────────────────────────────────────────

const DETAILS_START = /^ {0,3}<details(?=[\s>])/im;
const DETAILS_OPEN = /^ {0,3}<details(\s[^>]*)?>/i;
const DETAILS_TAG = /<details(?=[\s>])[^>]*>|<\/details\s*>/gi;
const SUMMARY = /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/i;

/** `<details>` … the matching `</details>` (nested toggles allowed), or null. */
function matchDetails(src: string): { raw: string; attrs: string; inner: string } | null {
    const open = DETAILS_OPEN.exec(src);
    if (!open) return null;
    DETAILS_TAG.lastIndex = open[0].length;
    let depth = 1;
    for (let tag = DETAILS_TAG.exec(src); tag; tag = DETAILS_TAG.exec(src)) {
        depth += tag[0].startsWith('</') ? -1 : 1;
        if (depth === 0) {
            let end = tag.index + tag[0].length;
            const trailing = /^[ \t]*(?:\n|$)/.exec(src.slice(end));
            if (trailing) end += trailing[0].length;
            return { raw: src.slice(0, end), attrs: open[1] ?? '', inner: src.slice(open[0].length, tag.index) };
        }
    }
    return null;
}

/** Remove the common leading indentation (a toggle's body is often indented). */
function dedent(text: string): string {
    const lines = text.split('\n');
    const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
    const min = indents.length > 0 ? Math.min(...indents) : 0;
    return min > 0 ? lines.map((l) => l.slice(Math.min(min, /^[ \t]*/.exec(l)![0].length))).join('\n') : text;
}

/**
 * A toggle. Markdown (HTML, as GitHub renders it):
 *   <details>
 *   <summary>Title</summary>
 *
 *   Body, any blocks.
 *
 *   </details>
 * `<details open>` keeps it open.
 */
const DetailsBlock = Details.extend({
    markdownTokenizer: {
        name: 'details',
        level: 'block',
        start: (src: string) => {
            const match = DETAILS_START.exec(src);
            return match ? match.index : -1;
        },
        tokenize(src, _tokens, lexer) {
            const match = matchDetails(src);
            if (!match) return undefined;
            const summary = SUMMARY.exec(match.inner);
            const title = summary ? summary[1]!.replace(/\s+/g, ' ').trim() : '';
            const body = dedent(summary ? match.inner.slice(summary[0].length) : match.inner);
            return {
                type: 'details',
                raw: match.raw,
                open: /(^|\s)open(\s|=|$)/i.test(match.attrs),
                summaryTokens: title ? lexer.inlineTokens(title) : [],
                tokens: body.trim() ? lexer.blockTokens(`${body.trim()}\n`) : [],
            };
        },
    },

    parseMarkdown(token, h) {
        const body = h.parseChildren(token.tokens ?? []);
        return h.createNode('details', { open: token['open'] === true }, [
            h.createNode('detailsSummary', undefined, h.parseInline(token['summaryTokens'] ?? [])),
            h.createNode('detailsContent', undefined, body.length > 0 ? body : [emptyParagraph()]),
        ]);
    },

    renderMarkdown(node, h) {
        const summary = node.content?.find((child) => child.type === 'detailsSummary');
        const body = node.content?.find((child) => child.type === 'detailsContent');
        const title = summary?.content ? h.renderChildren(summary.content).replace(/\n+/g, ' ').trim() : '';
        const inner = renderBlocks(body?.content, h).trim();
        const open = node.attrs?.['open'] ? ' open' : '';
        return `<details${open}>\n<summary>${title}</summary>\n\n${inner ? `${inner}\n\n` : ''}</details>`;
    },
}).configure({ persist: true });

// ─── Images ────────────────────────────────────────────────────────────

const imageTrackingAttributes = {
    width: { default: '100%' },
    height: { default: 'auto' },
    // Links the node to Doc.cloudImages / the browser's IndexedDB blob.
    imageId: { default: null },
    cloudPublicId: { default: null },
    cloudProvider: { default: null },
};

/** recollect/lib/extensions/ResizableImage.tsx: Image (src, alt, title, width, height) + tracking attrs. */
export const ResizableImage = Image.extend({
    name: 'resizableImage',
    addAttributes() {
        return { ...this.parent?.(), ...imageTrackingAttributes };
    },
    // `![alt](src "title")` becomes this node (Image's own handler would make an `image`, which the
    // editor doesn't have). Rendering is Image's: `![alt](src)`.
    markdownTokenName: 'image',
    parseMarkdown(token, h) {
        return h.createNode('resizableImage', {
            src: token['href'] ?? null,
            alt: token.text || null,
            title: token['title'] || null,
        });
    },
});

/** The plain `image` node of the old server schema (kept so older content still converts). */
const LegacyImage = Image.extend({
    addAttributes() {
        return { ...this.parent?.(), ...imageTrackingAttributes };
    },
    // Markdown images become resizableImage (above), never this node.
    parseMarkdown: () => [],
});

// ─── Other custom nodes (recollect/lib/extensions) ────────────────────

/** Markdown for an embed: a link line `[Embed: youtube](url)` (read back as an embed). */
export const EMBED_LINK_TEXT = /^embed(?::\s*([\w-]+))?$/i;

/** recollect/lib/extensions/EmbedNode.tsx */
export const EmbedNode = TiptapNode.create({
    name: 'embed',
    group: 'block',
    atom: true,
    addAttributes() {
        return {
            url: {
                default: '',
                parseHTML: (element: HTMLElement) => element.getAttribute('data-url'),
                renderHTML: (attributes: Record<string, unknown>) => ({ 'data-url': attributes['url'] }),
            },
            embedType: {
                default: 'link',
                parseHTML: (element: HTMLElement) => element.getAttribute('data-embed-type'),
                renderHTML: (attributes: Record<string, unknown>) => ({ 'data-embed-type': attributes['embedType'] }),
            },
            width: {
                default: '100%',
                parseHTML: (element: HTMLElement) => element.getAttribute('data-width') || '100%',
                renderHTML: (attributes: Record<string, unknown>) => ({ 'data-width': attributes['width'] }),
            },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-embed]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes({ 'data-embed': '' }, HTMLAttributes)];
    },
    renderMarkdown(node) {
        const url = String(node.attrs?.['url'] ?? '');
        const kind = String(node.attrs?.['embedType'] ?? 'link');
        return url ? `[Embed: ${kind}](${url})` : '';
    },
});

/** recollect/lib/extensions/InlineAINode.tsx: an AI prompt placeholder; nothing to say in Markdown. */
export const InlineAINode = TiptapNode.create({
    name: 'inlineAi',
    group: 'block',
    atom: true,
    parseHTML() {
        return [{ tag: 'div[data-ai-node]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes({ 'data-ai-node': '' }, HTMLAttributes)];
    },
    renderMarkdown: () => '',
});

/** recollect/lib/extensions/MediaRow.tsx: images/embeds side by side. Markdown: one line of them. */
export const MediaRow = TiptapNode.create({
    name: 'mediaRow',
    group: 'block',
    content: 'mediaItem+',
    selectable: true,
    draggable: true,
    addAttributes() {
        return {
            gap: {
                default: 8,
                parseHTML: (element: HTMLElement) => parseInt(element.getAttribute('data-gap') || '8', 10),
                renderHTML: (attributes: Record<string, unknown>) => ({ 'data-gap': attributes['gap'] }),
            },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-media-row]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes({ 'data-media-row': '' }, HTMLAttributes), 0];
    },
    renderMarkdown(node) {
        return (node.content ?? [])
            .map((item) => {
                const attrs = item.attrs ?? {};
                if (attrs['itemType'] === 'image' && attrs['src']) return `![](${String(attrs['src'])})`;
                const url = attrs['url'] ?? attrs['src'];
                return url ? `[Embed: ${String(attrs['embedType'] ?? 'link')}](${String(url)})` : '';
            })
            .filter(Boolean)
            .join(' ');
    },
});

/** recollect/lib/extensions/MediaItem.tsx */
export const MediaItem = TiptapNode.create({
    name: 'mediaItem',
    group: 'mediaItem',
    atom: true,
    selectable: true,
    draggable: true,
    addAttributes() {
        return {
            itemType: {
                default: 'image',
                parseHTML: (el: HTMLElement) => el.getAttribute('data-item-type'),
                renderHTML: (attrs: Record<string, unknown>) => ({ 'data-item-type': attrs['itemType'] }),
            },
            src: {
                default: null,
                parseHTML: (el: HTMLElement) => el.getAttribute('data-src'),
                renderHTML: (attrs: Record<string, unknown>) => (attrs['src'] ? { 'data-src': attrs['src'] } : {}),
            },
            url: {
                default: null,
                parseHTML: (el: HTMLElement) => el.getAttribute('data-url'),
                renderHTML: (attrs: Record<string, unknown>) => (attrs['url'] ? { 'data-url': attrs['url'] } : {}),
            },
            embedType: {
                default: 'link',
                parseHTML: (el: HTMLElement) => el.getAttribute('data-embed-type'),
                renderHTML: (attrs: Record<string, unknown>) => (attrs['embedType'] ? { 'data-embed-type': attrs['embedType'] } : {}),
            },
            width: {
                default: 'auto',
                parseHTML: (el: HTMLElement) => el.getAttribute('data-width') || 'auto',
                renderHTML: (attrs: Record<string, unknown>) => ({ 'data-width': attrs['width'] }),
            },
            imageId: {
                default: null,
                parseHTML: (el: HTMLElement) => el.getAttribute('data-image-id'),
                renderHTML: (attrs: Record<string, unknown>) => (attrs['imageId'] ? { 'data-image-id': attrs['imageId'] } : {}),
            },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-media-item]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes({ 'data-media-item': '' }, HTMLAttributes)];
    },
});

// ─── Canvas (a board of boxes and arrows) ──────────────────────────────

/**
 * recollect/lib/extensions/Canvas.tsx. The board is not in the node: it is in the doc's Y.Doc
 * (./canvas.ts); `data` carries it only on JSON that travels. Markdown: a ```canvas fence in the
 * text form with the canvas id (`%% id: cv_…`), printed here from `data` (read paths inject it
 * first); parsing the fence is CanvasFence in ./markdown/docMarkdown.ts. Default priority on
 * purpose: a block sorted before `paragraph` could become ProseMirror's default block type.
 */
export const CanvasNode = TiptapNode.create({
    name: 'canvas',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
        return {
            canvasId: {
                default: null,
                parseHTML: (element: HTMLElement) => {
                    const id = element.getAttribute('data-canvas-id');
                    return isCanvasId(id) ? id : null;
                },
                renderHTML: (attributes: Record<string, unknown>) => (attributes['canvasId'] ? { 'data-canvas-id': attributes['canvasId'] } : {}),
            },
            height: {
                default: CANVAS_DEFAULT_HEIGHT,
                parseHTML: (element: HTMLElement) => canvasHeight(element.getAttribute('data-height')),
                renderHTML: (attributes: Record<string, unknown>) => ({ 'data-height': canvasHeight(attributes['height']) }),
            },
            data: {
                default: null,
                parseHTML: (element: HTMLElement) => {
                    const raw = element.getAttribute('data-board');
                    if (!raw) return null;
                    try {
                        return JSON.parse(raw) as unknown;
                    } catch {
                        return null;
                    }
                },
                renderHTML: (attributes: Record<string, unknown>) => (attributes['data'] ? { 'data-board': JSON.stringify(attributes['data']) } : {}),
            },
        };
    },
    parseHTML() {
        return [{ tag: 'div[data-type="canvas"]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'canvas' })];
    },
    renderMarkdown: (node) => printCanvasFence(node.attrs),
});

// ─── The list ──────────────────────────────────────────────────────────

/**
 * StarterKit's ordered list (same node), without TipTap's own Markdown tokenizer for it: that one
 * measures an item's content indent without the "." (3.32.2), so a code block inside "1. …" gains
 * a leading space on every round trip. marked's standard list tokenizer gets it right.
 */
const MarkdownSafeOrderedList = OrderedList.extend({
    markdownTokenizer: { name: 'orderedList', level: 'block', start: () => -1, tokenize: () => undefined },
    // TipTap's own ordered-list parser reads an item's text token as plain text, so `code` and
    // **bold** inside a numbered item came out with literal backticks and asterisks. Hand each
    // item to the list_item parser instead, as the bullet list does.
    parseMarkdown(token, h) {
        if (token.type !== 'list' || !token['ordered']) return [];
        const start = Number(token['start']) || 1;
        const items = Array.isArray(token['items']) ? (token['items'] as Parameters<typeof h.parseChildren>[0]) : [];
        return h.createNode('orderedList', start !== 1 ? { start } : {}, h.parseChildren(items));
    },
});

/**
 * Every node and mark a doc may contain. ResizableImage comes before LegacyImage so Markdown
 * images become resizableImage. CanvasNode stays after StarterKit at the default priority (see it).
 */
export const DOC_EDITOR_EXTENSIONS: AnyExtension[] = [
    // The editor's link class is the `class` attr's default, so links made here match the editor's.
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { HTMLAttributes: { class: 'doc-link' } }, orderedList: false }),
    MarkdownSafeOrderedList,
    ResizableImage,
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight.configure({ multicolor: true }),
    TextStyle,
    Color,
    EmbedNode,
    MediaRow,
    MediaItem,
    InlineAINode,
    Callout,
    DetailsBlock,
    DetailsSummary,
    DetailsContent,
    CanvasNode,
    LegacyImage,
];

let docSchema: Schema | undefined;

/** The ProseMirror schema of the doc editor (built once). */
export function getDocSchema(): Schema {
    docSchema ??= getSchema(DOC_EDITOR_EXTENSIONS);
    return docSchema;
}
