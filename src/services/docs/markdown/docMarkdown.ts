// Markdown ⇄ doc, headless (no editor, no DOM), for agents (the MCP server) reading and writing docs.
//
//   markdownToDocJson(md)      Markdown → TipTap JSON that validates against the doc schema (400 if not)
//   docJsonToMarkdown(json)    TipTap JSON (editor or Yjs) → Markdown
//   yjsStateToMarkdown(b64)    Doc.yjsState (Base64) → Markdown
//   docJsonToYjsState(json)    TipTap JSON → Doc.yjsState (re-exported from ../docContent)
//   docJsonToYElements(json)   TipTap JSON → loose Y.XmlElements to insert into a live doc
//
// Parsing and printing are @tiptap/markdown's MarkdownManager over the doc schema's extensions
// (../docSchema.ts), with its own `marked` instance. The dialect:
//   # / ## / ###          headings (#### and deeper become ###)
//   **b** *i* ~~s~~ `c`   bold, italic, strike, code;  <u>u</u> underline;  ==h== highlight
//   [text](url)           link (only http(s), mailto, tel, relative and #anchor links are kept)
//   ![alt](src)           image (a resizableImage block)
//   - / 1. / - [ ] / - [x] lists, task lists (nested)
//   ```lang               code block with its language; ```mermaid stays a code block
//   ```canvas             a canvas board in the text form, a Mermaid flowchart subset (../diagram/parse.ts),
//                         laid out by resolveDiagrams (await it before storing); or the v1 JSON
//                         {id?, height?, layout?, nodes, edges} (../canvas.ts) when the body starts
//                         with `{`. Printed in the text form with `%% id: cv_…`, read back as a new canvas
//   > quote, ---          blockquote, horizontal rule
//   > [!TIP] + > lines    callout (NOTE, TIP, IMPORTANT, WARNING, CAUTION)
//   <details><summary>T</summary> … </details>   toggle
//   [Embed: youtube](url) an embed (that is how embeds are printed, so they survive a round trip)
// Text colour has no Markdown and is dropped when printing; a GFM table is kept as a code block
// with its Markdown text (the editor has no tables). A single line break inside a paragraph is a
// space (CommonMark); end a line with two spaces for a hard break.
import type { AnyExtension, JSONContent } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import { Marked, type marked as MarkedFunction } from 'marked';
import * as Y from 'yjs';
import { prosemirrorToYDoc } from 'y-prosemirror';
import ErrorResponse from '../../../utils/errorResponse';
import { DOC_EDITOR_EXTENSIONS, DOC_YJS_FRAGMENT, EMBED_LINK_TEXT, getDocSchema } from '../docSchema';
import { docJsonToYjsState, yjsStateToDocJson } from '../docContent';
import { CANVAS_DEFAULT_HEIGHT, PENDING_DIAGRAM, isCanvasFenceLanguage, isJsonCanvasText, parseCanvasFence } from '../canvas';
import { parseDiagram } from '../diagram/parse';

export { docJsonToYjsState };

const MAX_HEADING_LEVEL = 3;

/** A GFM table has no node in the editor: keep its Markdown, verbatim, in a code block. */
const TableAsCode = Extension.create({
    name: 'markdownTable',
    markdownTokenName: 'table',
    parseMarkdown: (token, h) => h.createNode('codeBlock', { language: null }, [h.createTextNode(String(token.raw ?? '').trim())]),
});

/**
 * `####`–`######` become the deepest heading the editor has (TipTap's own handler makes a
 * paragraph). The manager prints a node with the first handler registered for its token name, so
 * this one prints headings too (exactly like Heading does).
 */
const DeepHeadings = Extension.create({
    name: 'markdownDeepHeadings',
    priority: 1000, // before Heading
    markdownTokenName: 'heading',
    parseMarkdown: (token, h) =>
        h.createNode('heading', { level: Math.min(Math.max(Number(token['depth']) || 1, 1), MAX_HEADING_LEVEL) }, h.parseInline(token.tokens ?? [])),
    renderMarkdown: (node, h) => {
        const level = Math.min(Math.max(Number(node.attrs?.['level']) || 1, 1), 6);
        return node.content ? `${'#'.repeat(level)} ${h.renderChildren(node.content)}` : '';
    },
});

/**
 * A ```canvas fence becomes a canvas block (absorbed into the doc's Y.Doc later, with a fresh id).
 * The text form (../diagram/parse.ts) carries its diagram in `data` as { pendingDiagram } until
 * resolveDiagrams lays it out (layout is asynchronous; this parse is not); the JSON form (a body
 * that starts with `{`) carries its board. Tried before CodeBlock's handler for the same `code`
 * token; any other fence returns nothing here, so it stays a code block. A diagram or board that
 * can't be read → 400. Printing is the canvas node's own (../docSchema.ts).
 */
const CanvasFence = Extension.create({
    name: 'markdownCanvasFence',
    priority: 1000, // before CodeBlock
    markdownTokenName: 'code',
    parseMarkdown: (token, h) => {
        if (!isCanvasFenceLanguage(token['lang'])) return [];
        const text = String(token.text ?? '');
        if (isJsonCanvasText(text)) {
            const { height, board } = parseCanvasFence(text);
            return h.createNode('canvas', { canvasId: null, height, data: board });
        }
        const diagram = parseDiagram(text);
        return h.createNode('canvas', { canvasId: null, height: diagram.height ?? CANVAS_DEFAULT_HEIGHT, data: { [PENDING_DIAGRAM]: diagram } });
    },
});

let manager: MarkdownManager | undefined;

function markdownManager(): MarkdownManager {
    manager ??= new MarkdownManager({
        // Its own marked instance: the manager registers its tokenizers on it.
        marked: new Marked() as unknown as typeof MarkedFunction,
        extensions: [...DOC_EDITOR_EXTENSIONS, TableAsCode, DeepHeadings, CanvasFence] as AnyExtension[],
    });
    return manager;
}

// ─── Markdown → JSON ───────────────────────────────────────────────────

const SAFE_LINK = /^(https?:|mailto:|tel:|\/|#|\.{0,2}\/)/i;

function plainText(nodes: readonly JSONContent[] | undefined): string {
    return (nodes ?? [])
        .map((n) => (n.type === 'text' ? n.text ?? '' : n.type === 'hardBreak' ? ' ' : plainText(n.content)))
        .join('');
}

interface Normalizer {
    blockTypes: Set<string>;
    markTypes: Set<string>;
    nodeTypes: Set<string>;
}

function normalizer(): Normalizer {
    const schema = getDocSchema();
    return {
        nodeTypes: new Set(Object.keys(schema.nodes)),
        blockTypes: new Set(Object.values(schema.nodes).filter((t) => t.isBlock).map((t) => t.name)),
        markTypes: new Set(Object.keys(schema.marks)),
    };
}

/**
 * Keep known marks; drop links to anything but http(s)/mailto/tel/relative targets. Inline code
 * can't carry other marks in the editor (its mark excludes them all), so `**`x`**` keeps only the
 * code, and a linked `[`x`](url)` keeps the link (where it points matters more than the style):
 * agents write both often, and refusing the whole note for it would be wrong.
 */
function cleanMarks(marks: JSONContent['marks'], n: Normalizer): JSONContent['marks'] {
    if (!marks) return undefined;
    let kept = marks.filter((m) => {
        if (!n.markTypes.has(m.type)) return false;
        if (m.type === 'link') return SAFE_LINK.test(String(m.attrs?.['href'] ?? '').trim());
        return true;
    });
    if (kept.length > 1 && kept.some((m) => m.type === 'code')) {
        const link = kept.find((m) => m.type === 'link');
        kept = link ? [link] : kept.filter((m) => m.type === 'code');
    }
    return kept.length > 0 ? kept : undefined;
}

/** A paragraph that is only `[Embed: kind](url)` is an embed. */
function asEmbed(node: JSONContent): JSONContent | null {
    const only = node.content?.length === 1 ? node.content[0] : undefined;
    const link = only?.type === 'text' ? only.marks?.find((m) => m.type === 'link') : undefined;
    const match = only?.text ? EMBED_LINK_TEXT.exec(only.text.trim()) : null;
    if (!link || !match) return null;
    const url = String(link.attrs?.['href'] ?? '');
    return url ? { type: 'embed', attrs: { url, embedType: match[1]?.toLowerCase() ?? 'link' } } : null;
}

/**
 * Make parsed content fit the schema: block nodes (images) are lifted out of paragraphs, heading
 * levels are capped at 3, soft line breaks become spaces, empty text goes, list items start with a
 * paragraph and containers get at least one block.
 */
function normalizeContent(nodes: readonly JSONContent[] | undefined, parentType: string, n: Normalizer): JSONContent[] {
    const out: JSONContent[] = [];
    for (const node of nodes ?? []) {
        if (!node || typeof node.type !== 'string') continue;

        if (node.type === 'text') {
            const text = parentType === 'codeBlock' ? node.text ?? '' : (node.text ?? '').replace(/[ \t]*\r?\n[ \t]*/g, ' ');
            if (!text) continue;
            const marks = parentType === 'codeBlock' ? undefined : cleanMarks(node.marks, n);
            out.push(marks ? { type: 'text', text, marks } : { type: 'text', text });
            continue;
        }
        if (!n.nodeTypes.has(node.type)) {
            // Not in the editor's schema: keep its text, never the node.
            const text = plainText(node.content);
            if (text.trim()) out.push(...normalizeContent([{ type: 'text', text }], parentType, n));
            continue;
        }
        if (node.type === 'resizableImage' && !String(node.attrs?.['src'] ?? '').trim()) continue;

        if (node.type === 'paragraph') {
            const embed = asEmbed(node);
            if (embed) {
                out.push(embed);
                continue;
            }
        }

        const copy: JSONContent = { ...node };
        if (node.type === 'heading') {
            const level = Number(node.attrs?.['level']) || 1;
            copy.attrs = { ...node.attrs, level: Math.min(Math.max(level, 1), MAX_HEADING_LEVEL) };
        }
        if (node.type === 'detailsSummary') {
            // text* only: a summary keeps its words, not inline nodes.
            const text = plainText(node.content).replace(/\s+/g, ' ').trim();
            copy.content = text ? [{ type: 'text', text }] : [];
            out.push(copy);
            continue;
        }
        if (node.content) copy.content = normalizeContent(node.content, node.type, n);

        const isTextblock = node.type === 'paragraph' || node.type === 'heading';
        if (isTextblock && copy.content?.some((c) => n.blockTypes.has(c.type ?? ''))) {
            // Split around block children: "a ![x](y) b" → paragraph(a), image, paragraph(b).
            let run: JSONContent[] = [];
            const flush = () => {
                const first = run[0];
                const last = run[run.length - 1];
                if (first?.type === 'text') run[0] = { ...first, text: (first.text ?? '').trimStart() };
                if (last?.type === 'text') run[run.length - 1] = { ...run[run.length - 1]!, text: (run[run.length - 1]!.text ?? '').trimEnd() };
                run = run.filter((c) => c.type !== 'text' || c.text);
                if (run.length > 0) out.push({ ...copy, content: run });
                run = [];
            };
            for (const child of copy.content) {
                if (n.blockTypes.has(child.type ?? '')) {
                    flush();
                    out.push(child);
                } else {
                    run.push(child);
                }
            }
            flush();
            continue;
        }

        if ((node.type === 'listItem' || node.type === 'taskItem') && copy.content?.[0]?.type !== 'paragraph') {
            copy.content = [{ type: 'paragraph', content: [] }, ...(copy.content ?? [])];
        }
        if (['callout', 'detailsContent', 'blockquote'].includes(node.type) && (copy.content?.length ?? 0) === 0) {
            copy.content = [{ type: 'paragraph', content: [] }];
        }
        out.push(copy);
    }
    return out;
}

/**
 * Markdown → a TipTap JSON doc (every attribute filled in) that validates against the doc schema.
 * Empty Markdown → a doc with one empty paragraph. Content the schema can't hold → 400. A canvas
 * block carries its board in attrs.data (absorb it before it reaches a Y.Doc), or, from the text
 * form, a diagram that `await resolveDiagrams(json)` (../diagram/resolve.ts) must lay out first.
 */
export function markdownToDocJson(markdown: string): JSONContent {
    let parsed: JSONContent;
    try {
        if (typeof markdown !== 'string') throw new Error('Markdown must be a string');
        parsed = markdownManager().parse(markdown.replace(/\r\n?/g, '\n'));
    } catch (err) {
        // A handler's own 400 (a ```canvas fence that is not a board) says what to fix: keep it.
        if (err instanceof ErrorResponse) throw err;
        throw new ErrorResponse(400, `Could not read the Markdown: ${err instanceof Error ? err.message : String(err)}`);
    }
    const content = normalizeContent(parsed.content, 'doc', normalizer());
    const doc: JSONContent = { type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph', content: [] }] };
    try {
        const node = getDocSchema().nodeFromJSON(doc);
        node.check();
        return node.toJSON() as JSONContent;
    } catch (err) {
        throw new ErrorResponse(400, `The Markdown does not fit a doc: ${invalidBlock(doc) ?? (err instanceof Error ? err.message : String(err))}`);
    }
}

/** "block 3 (taskList): <reason>" for the first top-level block the schema rejects. */
function invalidBlock(doc: JSONContent): string | null {
    const schema = getDocSchema();
    for (const [i, block] of (doc.content ?? []).entries()) {
        try {
            if (!schema.nodes[block.type ?? '']?.isBlock) throw new Error(`"${block.type}" is not a block`);
            schema.nodeFromJSON(block).check();
        } catch (err) {
            return `block ${i + 1} (${block.type}): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
        }
    }
    return null;
}

/** The top-level blocks of `markdown` (no blocks for empty Markdown). */
export function markdownToBlocks(markdown: string): JSONContent[] {
    if (!markdown.trim()) return [];
    return markdownToDocJson(markdown).content ?? [];
}

// ─── JSON → Markdown ───────────────────────────────────────────────────

/** Node types with nothing to print (UI placeholders): left out, so they leave no blank gap. */
const UNPRINTED = new Set(['inlineAi']);

function printable(nodes: readonly JSONContent[]): JSONContent[] {
    return nodes
        .filter((node) => node && !UNPRINTED.has(node.type ?? ''))
        .map((node) => (Array.isArray(node.content) ? { ...node, content: printable(node.content) } : node));
}

/** TipTap JSON (editor.getJSON() or a Yjs fragment's JSON) → Markdown. */
export function docJsonToMarkdown(json: unknown): string {
    const doc = json as JSONContent | null | undefined;
    if (!doc || !Array.isArray(doc.content) || doc.content.length === 0) return '';
    // Line ends are left alone: two trailing spaces are a hard break, and code keeps its whitespace.
    return markdownManager().serialize({ type: 'doc', content: printable(doc.content) }).replace(/\s+$/, '');
}

/** Doc.yjsState (Base64) → Markdown. */
export function yjsStateToMarkdown(yjsStateBase64: string): string {
    return docJsonToMarkdown(yjsStateToDocJson(yjsStateBase64));
}

// ─── JSON → Yjs elements ───────────────────────────────────────────────

/**
 * The top-level blocks of a TipTap JSON doc as loose (not yet inserted) Y.XmlElements, encoded
 * exactly like the editor's Collaboration extension (y-prosemirror): insert them into a live
 * doc's fragment.
 */
export function docJsonToYElements(json: JSONContent): Array<Y.XmlElement | Y.XmlText> {
    const pmDoc = getDocSchema().nodeFromJSON(json);
    const ydoc = prosemirrorToYDoc(pmDoc, DOC_YJS_FRAGMENT);
    try {
        return ydoc
            .getXmlFragment(DOC_YJS_FRAGMENT)
            .toArray()
            .map((el) => (el as Y.XmlElement | Y.XmlText).clone());
    } finally {
        ydoc.destroy();
    }
}

/** Plain text of a JSON node (headings, snippets). Hard breaks count as spaces. */
export function nodePlainText(node: JSONContent | undefined): string {
    return node ? plainText(node.content) : '';
}
