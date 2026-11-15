// Phase 4 of DOCS_EDITOR_V2_PLAN: a doc's old content (the "default" fragment, TipTap) written into the
// same Y.Doc as the new editor's blocks (the "blocks" fragment), node by node (./fromOldJson.ts). The
// old fragment is left exactly as it was, so a doc can go back. A doc that already has blocks is never
// touched. Canvas boards stay where they are (root maps by id; the canvas blocks keep their ids).
import * as Y from 'yjs';
import type { JSONContent } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { DOC_YJS_FRAGMENT } from '../docSchema';
import { oldJsonToBlocks, type ConversionReport } from './fromOldJson';
import { BLOCKS_FRAGMENT, blocksToYElements, hasBlocks, readBlocks, type DocBlock, type InlineNode, type NewBlock, type TableContent } from './serverEditor';

export interface DocMigration {
    status: 'converted' | 'already' | 'empty';
    /** Top-level blocks written. */
    blocks: number;
    /** Every block written, by type (children included). */
    types: Record<string, number>;
    report: ConversionReport;
    /** The doc's words, before and after (a word-for-word check; nothing may go missing). */
    wordsBefore: number;
    wordsAfter: number;
    /** Words in the old doc that the blocks don't have (at most 20, for the report; empty when all is well). */
    missing: string[];
}

const tokens = (text: string) => text.split(/[\s|]+/).filter((w) => w && !/^:?-+:?$/.test(w));

/** Words of the old doc: its text, its code, an embed's address (it becomes a link with it). */
function oldWords(node: JSONContent | undefined, out: string[] = []): string[] {
    if (!node) return out;
    if (node.type === 'text' && node.text) out.push(...tokens(node.text));
    if (node.type === 'embed' && typeof node.attrs?.['url'] === 'string') out.push(...tokens(node.attrs['url']));
    if (node.type === 'inlineAi') return out;
    for (const c of node.content ?? []) oldWords(c, out);
    return out;
}

function inlineWords(content: unknown, out: string[]): void {
    if (typeof content === 'string') out.push(...tokens(content));
    else if (Array.isArray(content))
        for (const n of content as InlineNode[]) {
            if (n.type === 'text') out.push(...tokens(n.text));
            else for (const c of n.content) out.push(...tokens(c.text));
        }
    else if (content && typeof content === 'object' && (content as TableContent).type === 'tableContent')
        for (const row of (content as TableContent).rows) for (const cell of row.cells) inlineWords(Array.isArray(cell) ? cell : cell.content, out);
}

function blockWords(blocks: readonly (DocBlock | NewBlock)[], out: string[] = []): string[] {
    for (const b of blocks) {
        inlineWords(b.content, out);
        blockWords(b.children ?? [], out);
    }
    return out;
}

function countTypes(blocks: readonly (DocBlock | NewBlock)[], into: Record<string, number> = {}): Record<string, number> {
    for (const b of blocks) {
        into[b.type] = (into[b.type] ?? 0) + 1;
        countTypes(b.children ?? [], into);
    }
    return into;
}

/** Words of `before` that `after` lacks (a multiset difference), at most `limit`. */
function missingWords(before: string[], after: string[], limit = 20): string[] {
    const have = new Map<string, number>();
    for (const w of after) have.set(w, (have.get(w) ?? 0) + 1);
    const missing: string[] = [];
    for (const w of before) {
        const n = have.get(w) ?? 0;
        if (n > 0) have.set(w, n - 1);
        else if (missing.length < limit) missing.push(w);
    }
    return missing;
}

/** The blocks the old content becomes (no writing), with the report. */
export function planMigration(ydoc: Y.Doc): { blocks: NewBlock[]; result: DocMigration } {
    const json = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(DOC_YJS_FRAGMENT)) as JSONContent;
    const { blocks, report } = oldJsonToBlocks(json);
    const before = oldWords(json);
    const after = blockWords(blocks);
    return {
        blocks,
        result: {
            status: blocks.length ? 'converted' : 'empty',
            blocks: blocks.length,
            types: countTypes(blocks),
            report,
            wordsBefore: before.length,
            wordsAfter: after.length,
            missing: missingWords(before, after),
        },
    };
}

/**
 * Write the doc's blocks from its old content, in one transaction on `ydoc` (never when it already
 * has blocks). Returns what was done; the words are checked again on what was written.
 */
export function migrateYDoc(ydoc: Y.Doc): DocMigration {
    if (hasBlocks(ydoc)) {
        const blocks = readBlocks(ydoc);
        return { status: 'already', blocks: blocks.length, types: countTypes(blocks), report: { dropped: {}, merged: {} }, wordsBefore: 0, wordsAfter: 0, missing: [] };
    }
    const { blocks, result } = planMigration(ydoc);
    if (!blocks.length) return result;
    const elements = blocksToYElements(blocks);
    ydoc.transact(() => {
        const fragment = ydoc.getXmlFragment(BLOCKS_FRAGMENT);
        const group = new Y.XmlElement('blockGroup');
        fragment.insert(0, [group]);
        group.insert(0, elements);
    });
    const written = readBlocks(ydoc);
    const json = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(DOC_YJS_FRAGMENT)) as JSONContent;
    const after = blockWords(written);
    return { ...result, blocks: written.length, types: countTypes(written), wordsAfter: after.length, missing: missingWords(oldWords(json), after) };
}
