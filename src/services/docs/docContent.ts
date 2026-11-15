// Doc content on the server: TipTap editor JSON → Yjs state (Base64) for REST saves
// (POST /api/docs/:id) and agent writes, and small helpers over doc JSON / Yjs states (no database).
//
// THE SCHEMA MUST MATCH THE FRONTEND EDITOR: it lives in ./docSchema.ts (the extensions of
// recollect/lib/editor/docSchema.ts, plus callout and details). Placeholder, AutoJoiner, slash
// commands, drag handles, Collaboration and the carets add no nodes or marks. When the editor
// gains a node or mark, add it there.
//
// Why it matters: ProseMirror throws on an unknown node/mark type (the old schema had only
// StarterKit + Image, so saving coloured text failed with 500 "There is no mark type textStyle in
// this schema") and silently DROPS attributes the schema doesn't declare. The browser replaces the
// editor content with the yjsState the save returns, so a dropped attribute is lost user data.
// Safety net: content that still uses an unknown node type, mark type or attribute is converted
// with a schema extended for that request (nothing is dropped) and a warning is logged.
//
// Canvas blocks keep their board in the Y.Doc's root maps, not in the fragment (./canvas.ts):
// docJsonToYjsState absorbs a canvas's attrs.data into them, yjsStateToDocJson injects it back.
import type { JSONContent } from '@tiptap/core';
import { Schema, type AttributeSpec, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { prosemirrorToYDoc, yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import ErrorResponse from '../../utils/errorResponse';
import { PendingDiagramError, copyCanvasMaps, readBoard, takeCanvasData, withCanvasData, writeBoards, type Absorbed } from './canvas';
import { BLOCKS_YJS_FRAGMENT, DOC_EDITOR_EXTENSIONS, DOC_YJS_FRAGMENT, getDocSchema } from './docSchema';
import { repairDoc } from './docRepair';
import { hasBlocks, readBlocks } from './blocks/serverEditor';
import { blocksToOldJson } from './blocks/toOldJson';
import { stateBytes, stateUpdate, type DocState, type StateBytes } from './docState';

export { DOC_EDITOR_EXTENSIONS, DOC_YJS_FRAGMENT, getDocSchema };

/** Node types that carry an `imageId` attr tracked in Doc.cloudImages. */
const IMAGE_NODE_TYPES = new Set(['resizableImage', 'image']);

// ─── Safety net for content the schema doesn't know ──────────────────

type AttrKeys = Map<string, Set<string>>;

function noteType(map: AttrKeys, type: string, attrs: unknown): void {
    let keys = map.get(type);
    if (!keys) {
        keys = new Set();
        map.set(type, keys);
    }
    if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
        for (const key of Object.keys(attrs)) keys.add(key);
    }
}

/** Every node type and mark type in a TipTap JSON tree, with the attribute names it uses. */
function collectTypes(root: unknown): { nodes: AttrKeys; marks: AttrKeys } {
    const nodes: AttrKeys = new Map();
    const marks: AttrKeys = new Map();
    const stack: unknown[] = [root];
    while (stack.length > 0) {
        const value = stack.pop();
        if (!value || typeof value !== 'object') continue;
        const node = value as { type?: unknown; attrs?: unknown; marks?: unknown; content?: unknown };
        if (typeof node.type === 'string' && node.type !== 'text') noteType(nodes, node.type, node.attrs);
        if (Array.isArray(node.marks)) {
            for (const mark of node.marks) {
                const m = mark as { type?: unknown; attrs?: unknown } | null;
                if (m && typeof m.type === 'string') noteType(marks, m.type, m.attrs);
            }
        }
        if (Array.isArray(node.content)) {
            for (const child of node.content) stack.push(child);
        }
    }
    return { nodes, marks };
}

function missingAttrs(spec: { attrs?: { [name: string]: AttributeSpec } } | undefined, keys: Set<string>): string[] {
    return [...keys].filter((key) => !spec?.attrs || !Object.prototype.hasOwnProperty.call(spec.attrs, key));
}

function withNullDefaults(existing: { [name: string]: AttributeSpec } | undefined, keys: string[]) {
    const attrs: { [name: string]: AttributeSpec } = { ...(existing ?? {}) };
    for (const key of keys) attrs[key] = { default: null };
    return attrs;
}

/** The doc schema, extended with permissive specs for anything in `content` it doesn't declare. */
export function schemaFor(content: unknown): Schema {
    const base = getDocSchema();
    const used = collectTypes(content);
    const added: string[] = [];

    let nodes = base.spec.nodes;
    for (const [name, keys] of used.nodes) {
        const spec = nodes.get(name);
        const missing = missingAttrs(spec, keys);
        if (spec && missing.length === 0) continue;
        added.push(spec ? `${name} attrs ${missing.join(',')}` : `node ${name}`);
        nodes = spec
            ? nodes.update(name, { ...spec, attrs: withNullDefaults(spec.attrs, missing) })
            : nodes.addToEnd(name, { attrs: withNullDefaults(undefined, missing) });
    }

    let marks = base.spec.marks;
    for (const [name, keys] of used.marks) {
        const spec = marks.get(name);
        const missing = missingAttrs(spec, keys);
        if (spec && missing.length === 0) continue;
        added.push(spec ? `${name} attrs ${missing.join(',')}` : `mark ${name}`);
        marks = spec
            ? marks.update(name, { ...spec, attrs: withNullDefaults(spec.attrs, missing) })
            : marks.addToEnd(name, { attrs: withNullDefaults(undefined, missing) });
    }

    if (added.length === 0) return base;
    console.warn(
        `[docContent] Doc content uses ${added.join('; ')}, which the server schema does not declare. ` +
            'It was kept; add it to src/services/docs/docContent.ts.'
    );
    return new Schema({ nodes, marks, ...(base.spec.topNode ? { topNode: base.spec.topNode } : {}) });
}

// ─── Conversions ───────────────────────────────────────────────────────

export interface DocStateOptions {
    /**
     * The state this content replaces (a REST save): the boards of canvases still in the content
     * carry over from it, and a canvas's `data` only fills a board it doesn't have.
     */
    canvasesFrom?: DocState | null | undefined;
}

/** A stored state as a Y.Doc, or null when it can't be read. */
function openState(state: DocState | null | undefined): Y.Doc | null {
    if (!state) return null;
    const ydoc = new Y.Doc();
    try {
        Y.applyUpdate(ydoc, stateUpdate(state));
        return ydoc;
    } catch (err) {
        console.error('[docContent] Could not read the previous yjsState (canvas boards not carried over):', err);
        ydoc.destroy();
        return null;
    }
}

/**
 * TipTap JSON (editor.getJSON()) → a Yjs update as bytes, the format stored in Doc.yjsState.
 * Malformed content (e.g. a node without a type, an empty text node) → 400.
 * `metadata` (optional) fills the Y.Doc's `metadata` map like the live editor does (title, cover).
 * Canvas blocks are absorbed: their `data` goes into the canvas maps (ids made where missing or
 * repeated), with `options.canvasesFrom` the boards of the replaced state carry over.
 */
export function docJsonToYjsState(content: unknown, metadata?: { title?: string; coverImage?: string | null }, options: DocStateOptions = {}): StateBytes {
    const previous = openState(options.canvasesFrom);
    try {
        let absorbed: Absorbed<JSONContent>;
        try {
            absorbed = takeCanvasData(content as JSONContent, previous ? { existing: (id) => readBoard(previous, id) } : {});
        } catch (err) {
            // A diagram that was never laid out is our bug, not bad content: let it fail loudly.
            if (err instanceof PendingDiagramError) throw err;
            throw new ErrorResponse(400, `Invalid doc content: ${err instanceof Error ? err.message : String(err)}`);
        }
        let pmDoc: ProseMirrorNode;
        try {
            const schema = schemaFor(absorbed.json);
            pmDoc = schema.nodeFromJSON(absorbed.json);
            // Content that breaks the schema's rules (a list item outside a list…) is refused, not
            // stored: an editor would throw on it. A schema widened for unknown types can't judge
            // those types' places, so that (logged) case is only checked by the editor.
            // An empty doc is fine: the editor starts it with an empty line.
            if (schema === getDocSchema() && pmDoc.childCount > 0) pmDoc.check();
        } catch (err) {
            throw new ErrorResponse(400, `Invalid doc content: ${err instanceof Error ? err.message : String(err)}`);
        }
        const ydoc = prosemirrorToYDoc(pmDoc, DOC_YJS_FRAGMENT);
        try {
            writeBoards(ydoc, absorbed.boards);
            if (previous && absorbed.kept.length > 0) copyCanvasMaps(previous, ydoc, absorbed.kept);
            if (metadata) {
                const map = ydoc.getMap('metadata');
                if (metadata.title !== undefined) map.set('title', metadata.title);
                if (metadata.coverImage !== undefined) map.set('coverImage', metadata.coverImage);
            }
            return stateBytes(Y.encodeStateAsUpdate(ydoc));
        } finally {
            ydoc.destroy();
        }
    } finally {
        previous?.destroy();
    }
}

/**
 * A stored Yjs state (bytes, or Base64) → TipTap JSON, exactly like the browser's yjsStateToJson()
 * (schema-free), with each canvas's board injected as attrs.data (for reading: Markdown, search text).
 */
export function yjsStateToDocJson(state: DocState): { type: 'doc'; content: unknown[] } {
    const ydoc = new Y.Doc();
    try {
        Y.applyUpdate(ydoc, stateUpdate(state));
        // A doc on the new editor reads from its blocks, as old JSON (DOCS_EDITOR_V2_PLAN phase 4).
        if (hasBlocks(ydoc)) return withCanvasData(blocksToOldJson(readBlocks(ydoc)), ydoc) as { type: 'doc'; content: unknown[] };
        // A stored state from before a repair reads as the editor will show it (./docRepair.ts).
        repairDoc(ydoc);
        const json = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(DOC_YJS_FRAGMENT)) as JSONContent;
        return withCanvasData(json, ydoc) as { type: 'doc'; content: unknown[] };
    } finally {
        ydoc.destroy();
    }
}

// ─── Images ────────────────────────────────────────────────────────────

/**
 * Point freshly uploaded images at Cloudinary: every image node whose attrs.imageId is a key of
 * `urls` gets attrs.src = that URL. Mutates `content` (the parsed request body).
 */
export function replaceImageSrcs(content: unknown, urls: Record<string, { url: string }>): void {
    const stack: unknown[] = [content];
    while (stack.length > 0) {
        const value = stack.pop();
        if (!value || typeof value !== 'object') continue;
        const node = value as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown };
        const imageId = node.attrs?.imageId;
        if (
            typeof node.type === 'string' &&
            IMAGE_NODE_TYPES.has(node.type) &&
            typeof imageId === 'string' &&
            Object.prototype.hasOwnProperty.call(urls, imageId)
        ) {
            node.attrs!.src = urls[imageId]!.url;
        }
        if (Array.isArray(node.content)) {
            for (const child of node.content) stack.push(child);
        }
    }
}

/** The new editor's fragment (BlockNote, DOCS_EDITOR_V2_PLAN); its file blocks keep only a `url`. */
const BLOCKS_FRAGMENT = BLOCKS_YJS_FRAGMENT;
const BLOCK_FILE_TYPES = new Set(['image', 'file', 'video', 'audio']);

/**
 * The images a Y.Doc still uses: the imageId attrs of the old editor's image nodes, plus the URLs
 * of the new editor's file blocks (fragment "blocks"), which carry no imageId. `partitionCloudImages`
 * keeps an image when either its id or its URL is listed.
 */
export function extractImageIdsFromYDoc(ydoc: Y.Doc): string[] {
    const ids: string[] = [];
    // Duck-typed (as before) so it also works on Hocuspocus' live Document objects.
    const stack: any[] = ydoc.getXmlFragment(DOC_YJS_FRAGMENT).toArray();
    while (stack.length > 0) {
        const element = stack.pop();
        if (!element || typeof element.toArray !== 'function') continue;
        if (typeof element.nodeName === 'string' && IMAGE_NODE_TYPES.has(element.nodeName)) {
            const imageId = element.getAttribute?.('imageId');
            if (imageId) ids.push(String(imageId));
        }
        for (const child of element.toArray()) stack.push(child);
    }
    // Only read the new fragment when the doc has one (never create it here).
    if (ydoc.share.has(BLOCKS_FRAGMENT)) {
        const blocks: any[] = ydoc.getXmlFragment(BLOCKS_FRAGMENT).toArray();
        while (blocks.length > 0) {
            const element = blocks.pop();
            if (!element || typeof element.toArray !== 'function') continue;
            if (typeof element.nodeName === 'string' && BLOCK_FILE_TYPES.has(element.nodeName)) {
                const url = element.getAttribute?.('url');
                if (url) ids.push(String(url));
            }
            for (const child of element.toArray()) blocks.push(child);
        }
    }
    return ids;
}

/**
 * imageId attrs used by a stored Yjs state, or null when the state can't be read
 * (callers must then skip orphan cleanup; the old code treated it as "no images" and deleted all).
 */
export function extractImageIdsFromYjsState(state: DocState): string[] | null {
    const ydoc = new Y.Doc();
    try {
        Y.applyUpdate(ydoc, stateUpdate(state));
        return extractImageIdsFromYDoc(ydoc);
    } catch (err) {
        console.error('[docContent] Failed to read image ids from a yjsState:', err);
        return null;
    } finally {
        ydoc.destroy();
    }
}
