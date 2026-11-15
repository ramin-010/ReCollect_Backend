// DocOps (DOCS_EDITOR_V2_PLAN §4.3): read and change the new editor's blocks by id, on a Y.Doc. Pure
// (no server, no database): the agent service runs each change as ONE Yjs transaction on the live
// doc (withLiveDoc), with the edit log and Undo. Every structural change goes through BlockNote's
// encoding of whole blocks (blocksToYElements), so what is written always fits the schema.
//
//   outline(doc)                     ids, types, depth and first words, cheap for agents
//   insert(doc, blocks, where)       where: { after | before | under: id } or { at: 'start' | 'end' }
//   update(doc, id, patch)           a block's type, props and/or text; its children stay as they are
//   move(doc, ids, where)            blocks (with their children) to another place, ids kept
//   remove(doc, ids)                 blocks with their children; the doc keeps one empty paragraph
import * as Y from 'yjs';
import ErrorResponse from '../../../utils/errorResponse';
import { BLOCKS_FRAGMENT, blockContentElement, blocksToYElements, readBlocks, type DocBlock, type InlineNode, type NewBlock } from './serverEditor';

export type Where = { after: string } | { before: string } | { under: string } | { at: 'start' | 'end' };

export interface OutlineItem {
    id: string;
    type: string;
    depth: number;
    /** The block's first words (at most 80 characters); a diagram's first line, a canvas's id. */
    text: string;
    props?: Record<string, unknown>;
}

const isGroup = (el: unknown): el is Y.XmlElement => el instanceof Y.XmlElement && el.nodeName.toLowerCase() === 'blockgroup';
const isContainer = (el: unknown): el is Y.XmlElement => el instanceof Y.XmlElement && el.nodeName.toLowerCase() === 'blockcontainer';

/** The doc's top block group (BlockNote keeps one); made when `create` and missing. */
function topGroup(doc: Y.Doc, create: boolean): Y.XmlElement | null {
    const fragment = doc.getXmlFragment(BLOCKS_FRAGMENT);
    const first = fragment.get(0);
    if (isGroup(first)) return first;
    if (!create) return null;
    const group = new Y.XmlElement('blockGroup');
    fragment.insert(0, [group]);
    return group;
}

/** A container's group of children; made when `create` and missing. */
function childGroup(container: Y.XmlElement, create: boolean): Y.XmlElement | null {
    const found = container.toArray().find(isGroup);
    if (found || !create) return found ?? null;
    const group = new Y.XmlElement('blockGroup');
    container.insert(container.length, [group]);
    return group;
}

interface Found {
    el: Y.XmlElement;
    group: Y.XmlElement;
    index: number;
}

function find(doc: Y.Doc, id: string): Found | null {
    const top = topGroup(doc, false);
    if (!top) return null;
    const walk = (group: Y.XmlElement): Found | null => {
        const items = group.toArray();
        for (let index = 0; index < items.length; index += 1) {
            const el = items[index];
            if (!isContainer(el)) continue;
            if (el.getAttribute('id') === id) return { el, group, index };
            const kids = childGroup(el, false);
            const inner = kids ? walk(kids) : null;
            if (inner) return inner;
        }
        return null;
    };
    return walk(top);
}

function findOrThrow(doc: Y.Doc, id: string): Found {
    const found = find(doc, id);
    if (!found) throw new ErrorResponse(404, `No block with the id ${id} in this doc (get_outline lists them)`);
    return found;
}

const inlineText = (content: DocBlock['content']): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return (content as InlineNode[]).map((n) => (n.type === 'text' ? n.text : n.content.map((c) => c.text).join(''))).join('');
};

/** The block's first words for the outline. */
function firstWords(b: DocBlock): string {
    if (b.type === 'canvas') return `canvas ${String(b.props['canvasId'] ?? '')}`;
    if (b.type === 'image') return `image ${String(b.props['url'] ?? '')}`.slice(0, 80);
    if (b.type === 'table') return 'table';
    const text = inlineText(b.content).replace(/\s+/g, ' ').trim();
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

const OUTLINE_PROPS: Record<string, string[]> = { heading: ['level'], callout: ['kind'], checkListItem: ['checked'], codeBlock: ['language'] };

/** Every block in reading order with its depth (children right after their parent). */
export function outline(doc: Y.Doc): OutlineItem[] {
    const out: OutlineItem[] = [];
    const walk = (blocks: DocBlock[], depth: number) => {
        for (const b of blocks) {
            const keys = OUTLINE_PROPS[b.type] ?? [];
            const props = Object.fromEntries(keys.filter((k) => b.props[k] !== undefined).map((k) => [k, b.props[k]]));
            out.push({ id: b.id, type: b.type, depth, text: firstWords(b), ...(keys.length ? { props } : {}) });
            walk(b.children, depth + 1);
        }
    };
    walk(readBlocks(doc), 0);
    return out;
}

/** The blocks of a doc by id (a block and its subtree), or null. */
export function blockById(doc: Y.Doc, id: string): DocBlock | null {
    const walk = (blocks: DocBlock[]): DocBlock | null => {
        for (const b of blocks) {
            if (b.id === id) return b;
            const inner = walk(b.children);
            if (inner) return inner;
        }
        return null;
    };
    return walk(readBlocks(doc));
}

function isEmptyParagraph(el: unknown): boolean {
    if (!isContainer(el)) return false;
    const content = el.get(0);
    return content instanceof Y.XmlElement && content.nodeName === 'paragraph' && content.length === 0 && !childGroup(el, false);
}

/** Where `where` points: a group and an index in it. `refuse`: ids the place must not be inside (a move's own blocks). */
function place(doc: Y.Doc, where: Where, refuse: ReadonlySet<string> = new Set()): { group: Y.XmlElement; index: number } {
    if ('at' in where) {
        const group = topGroup(doc, true)!;
        if (where.at === 'start') return { group, index: 0 };
        // The end: before the trailing empty paragraph the editor keeps, as an append does.
        const last = group.get(group.length - 1);
        return { group, index: group.length > 0 && isEmptyParagraph(last) ? group.length - 1 : group.length };
    }
    const id = 'after' in where ? where.after : 'before' in where ? where.before : where.under;
    const found = findOrThrow(doc, id);
    for (const r of refuse) {
        const moved = find(doc, r);
        if (moved && (moved.el === found.el || isInside(found.el, moved.el))) throw new ErrorResponse(400, 'A block cannot be moved next to or under itself or its own children');
    }
    if ('under' in where) {
        const group = childGroup(found.el, true)!;
        return { group, index: group.length };
    }
    return { group: found.group, index: found.index + ('after' in where ? 1 : 0) };
}

/** True when `el` is somewhere inside `ancestor`'s subtree. */
function isInside(el: Y.XmlElement, ancestor: Y.XmlElement): boolean {
    let cur: Y.AbstractType<unknown> | null = el.parent as Y.AbstractType<unknown> | null;
    while (cur) {
        if (cur === ancestor) return true;
        cur = cur.parent as Y.AbstractType<unknown> | null;
    }
    return false;
}

/** Every block id in the doc. */
function allIds(doc: Y.Doc): Set<string> {
    const ids = new Set<string>();
    const top = topGroup(doc, false);
    const walk = (group: Y.XmlElement) => {
        for (const el of group.toArray()) {
            if (!isContainer(el)) continue;
            const id = el.getAttribute('id');
            if (id) ids.add(id);
            const kids = childGroup(el, false);
            if (kids) walk(kids);
        }
    };
    if (top) walk(top);
    return ids;
}

/** New blocks never take an id the doc already has (a copy gets fresh ones from BlockNote). */
function withoutTakenIds(blocks: readonly NewBlock[], taken: Set<string>): NewBlock[] {
    return blocks.map((b) => {
        const { id, children, ...rest } = b;
        const keep = id && !taken.has(id) ? id : undefined;
        if (keep) taken.add(keep);
        return { ...rest, ...(keep ? { id: keep } : {}), ...(children ? { children: withoutTakenIds(children, taken) } : {}) };
    });
}

function badBlocks(err: unknown): ErrorResponse {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return new ErrorResponse(400, `The blocks don't fit the doc: ${msg}`);
}

/** Insert blocks; returns their ids (top-level ones, in order). */
export function insert(doc: Y.Doc, blocks: readonly NewBlock[], where: Where): string[] {
    if (!blocks.length) throw new ErrorResponse(400, 'No blocks to insert');
    const target = place(doc, where);
    let els: Y.XmlElement[];
    try {
        els = blocksToYElements(withoutTakenIds(blocks, allIds(doc)));
    } catch (err) {
        throw badBlocks(err);
    }
    target.group.insert(target.index, els);
    return els.map((el) => String(el.getAttribute('id') ?? ''));
}

export interface BlockPatch {
    type?: string;
    props?: Record<string, unknown>;
    /** Inline content, or a plain string for code and diagram blocks. */
    content?: InlineNode[] | string;
}

/**
 * Change one block in place: only its own content element is rebuilt (or, for props alone, its
 * attributes set), so its children and anything typed in them stay untouched.
 */
export function update(doc: Y.Doc, id: string, patch: BlockPatch): DocBlock {
    const found = findOrThrow(doc, id);
    const current = blockById(doc, id)!;
    const contentEl = found.el.get(0);
    if (!(contentEl instanceof Y.XmlElement)) throw new ErrorResponse(409, 'This block has no content to change');
    const onlyProps = patch.type === undefined && patch.content === undefined && patch.props !== undefined;
    if (onlyProps && current.type !== 'table') {
        // Props alone: set the attributes BlockNote would write, so text typed meanwhile stays.
        let attributes: Record<string, unknown>;
        try {
            ({ attributes } = blockContentElement({ type: current.type, props: { ...current.props, ...patch.props }, content: current.content as never }));
        } catch (err) {
            throw badBlocks(err);
        }
        for (const [k, v] of Object.entries(attributes)) if (contentEl.getAttribute(k) !== v) contentEl.setAttribute(k, v as string);
        return blockById(doc, id)!;
    }
    const type = patch.type ?? current.type;
    const props = patch.type && patch.type !== current.type ? { ...(patch.props ?? {}) } : { ...current.props, ...(patch.props ?? {}) };
    const content = patch.content ?? current.content;
    let element: Y.XmlElement;
    try {
        ({ element } = blockContentElement({ type, props, content: content as never }));
    } catch (err) {
        throw badBlocks(err);
    }
    found.el.delete(0, 1);
    found.el.insert(0, [element]);
    return blockById(doc, id)!;
}

/** Move blocks (with their children) to `where`, keeping their ids; in the order given. */
export function move(doc: Y.Doc, ids: readonly string[], where: Where): void {
    if (!ids.length) throw new ErrorResponse(400, 'No blocks to move');
    const unique = [...new Set(ids)];
    // Refuse a place inside a moved block before changing anything.
    place(doc, where, new Set(unique));
    // Outermost first: a block inside another moved block goes with it.
    const copies: Y.XmlElement[] = [];
    const found = unique.map((id) => findOrThrow(doc, id));
    const outer = found.filter((f) => !found.some((o) => o !== f && isInside(f.el, o.el)));
    for (const f of outer) copies.push(f.el.clone());
    for (const f of outer) {
        const now = find(doc, String(f.el.getAttribute('id')));
        if (now) now.group.delete(now.index, 1);
    }
    const target = place(doc, where);
    target.group.insert(target.index, copies);
    pruneEmptyGroups(doc);
}

/** Remove blocks (with their children). */
export function remove(doc: Y.Doc, ids: readonly string[]): number {
    let removed = 0;
    for (const id of new Set(ids)) {
        const f = find(doc, id);
        if (!f) continue;
        f.group.delete(f.index, 1);
        removed += 1;
    }
    if (!removed) throw new ErrorResponse(404, 'None of those blocks are in this doc (get_outline lists them)');
    pruneEmptyGroups(doc);
    const top = topGroup(doc, true)!;
    if (top.length === 0) top.insert(0, blocksToYElements([{ type: 'paragraph' }]));
    return removed;
}

/** A container whose children were all moved or removed keeps no empty group (the schema wants one or more). */
function pruneEmptyGroups(doc: Y.Doc): void {
    const top = topGroup(doc, false);
    const walk = (group: Y.XmlElement) => {
        for (const el of group.toArray()) {
            if (!isContainer(el)) continue;
            const kids = childGroup(el, false);
            if (!kids) continue;
            if (kids.length === 0) el.delete(el.toArray().indexOf(kids), 1);
            else walk(kids);
        }
    };
    if (top) walk(top);
}
