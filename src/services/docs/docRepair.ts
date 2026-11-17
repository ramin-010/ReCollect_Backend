// Repairs for stored docs, at the Yjs level (no schema needed, so it also works on node types the
// schema no longer has). Run on every doc the collaboration server loads, on states read for
// agents, and after an agent Undo, so nothing invalid ever reaches an editor:
//
//   - Side-by-side columns are gone (the owner, 2026-11-14). A `columns` row becomes its columns'
//     blocks, left to right; a column that only held an empty line adds nothing.
//   - A list item outside a list (what dragging a list item beside a block made: the
//     "Called contentMatchAt on a node with invalid content" bug) is wrapped in a list again:
//     listItem in a bullet list, taskItem in a task list.
//
// The browser's editor deletes any element its schema can't place, which would lose the text in
// it for good; these repairs keep every word.
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { DOC_YJS_FRAGMENT, getDocSchema } from './docSchema';

/** Container elements that no longer exist; their content takes their place. */
const LEGACY_WRAPPERS = new Set(['columns', 'column']);

/** A list item and the list it must sit in; `parents` are the lists that may hold it. */
const ITEM_LISTS: Record<string, { wrapIn: string; parents: ReadonlySet<string> }> = {
    listItem: { wrapIn: 'bulletList', parents: new Set(['bulletList', 'orderedList']) },
    taskItem: { wrapIn: 'taskList', parents: new Set(['taskList']) },
};

/** The transaction origin of a repair (so observers can tell it from a person's edit). */
export const REPAIR_ORIGIN = 'recollect:repair';

type YBlock = Y.XmlElement | Y.XmlText;
type YParent = Y.XmlFragment | Y.XmlElement;

const isElement = (value: unknown): value is Y.XmlElement => value instanceof Y.XmlElement;

/** An empty line: a paragraph with no content. */
function isEmptyParagraph(el: YBlock): boolean {
    return isElement(el) && el.nodeName === 'paragraph' && el.length === 0;
}

/** Copies of a legacy wrapper's blocks, wrappers inside it flattened too. */
function unwrapped(wrapper: Y.XmlElement): YBlock[] {
    const children = wrapper.toArray() as YBlock[];
    // A column that only holds an empty line was a placeholder; it adds nothing.
    if (wrapper.nodeName === 'column' && children.length === 1 && isEmptyParagraph(children[0]!)) return [];
    const out: YBlock[] = [];
    for (const child of children) {
        if (isElement(child) && LEGACY_WRAPPERS.has(child.nodeName)) out.push(...unwrapped(child));
        else out.push(child.clone());
    }
    return out;
}

function flattenWrappers(parent: YParent): number {
    let changes = 0;
    let i = 0;
    while (i < parent.length) {
        const child = parent.get(i) as YBlock;
        if (isElement(child) && LEGACY_WRAPPERS.has(child.nodeName)) {
            const blocks = unwrapped(child);
            parent.delete(i, 1);
            if (blocks.length > 0) parent.insert(i, blocks);
            changes += 1;
            continue; // look at the blocks that took its place (they may hold more wrappers)
        }
        if (isElement(child)) changes += flattenWrappers(child);
        i += 1;
    }
    // A container left with nothing (a callout whose only block was an empty column row) gets an
    // empty line, so it stays valid.
    if (changes > 0 && parent.length === 0) parent.insert(0, [new Y.XmlElement('paragraph')]);
    return changes;
}

function wrapOrphanItems(parent: YParent): number {
    let changes = 0;
    const parentName = isElement(parent) ? parent.nodeName : null;
    let i = 0;
    while (i < parent.length) {
        const child = parent.get(i) as YBlock;
        const rule = isElement(child) ? ITEM_LISTS[child.nodeName] : undefined;
        if (rule && !(parentName && rule.parents.has(parentName))) {
            const name = (child as Y.XmlElement).nodeName;
            const run: YBlock[] = [];
            let j = i;
            while (j < parent.length) {
                const next = parent.get(j) as YBlock;
                if (!isElement(next) || next.nodeName !== name) break;
                run.push(next.clone());
                j += 1;
            }
            const list = new Y.XmlElement(rule.wrapIn);
            list.insert(0, run);
            parent.delete(i, run.length);
            parent.insert(i, [list]);
            changes += 1;
            i += 1;
            continue;
        }
        if (isElement(child)) changes += wrapOrphanItems(child);
        i += 1;
    }
    return changes;
}

/**
 * Repair a doc's editor fragment in place (call it inside a transaction). Returns how many
 * repairs were made (0 = the fragment was fine and nothing changed).
 */
export function repairLegacyBlocks(fragment: Y.XmlFragment): number {
    return flattenWrappers(fragment) + wrapOrphanItems(fragment);
}

/** Repair a whole doc in one transaction (origin REPAIR_ORIGIN). Returns the repair count. */
export function repairDoc(doc: Y.Doc): number {
    let changes = 0;
    doc.transact(() => {
        changes = repairLegacyBlocks(doc.getXmlFragment(DOC_YJS_FRAGMENT));
    }, REPAIR_ORIGIN);
    return changes;
}

/**
 * Why the doc's content does not fit the schema (the first problem ProseMirror finds), or null
 * when it does. For logging: a doc that fails this would break the editor.
 */
export function docProblem(doc: Y.Doc): string | null {
    const fragment = doc.getXmlFragment(DOC_YJS_FRAGMENT);
    // A new doc's fragment is empty; the editor starts it with an empty line.
    if (fragment.length === 0) return null;
    try {
        const json = yXmlFragmentToProsemirrorJSON(fragment);
        getDocSchema().nodeFromJSON(json).check();
        return null;
    } catch (err) {
        return err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
}
