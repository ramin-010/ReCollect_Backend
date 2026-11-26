// A published doc as its readers get it (MANAGER_AND_DOCS_PLAN §2): a fresh Y.Doc that holds only what
// the page draws, the blocks and the boards of their canvases, drawn in the browser by the new editor
// (read-only). Never the doc's own state: that one also holds the old editor's copy once a doc is
// migrated (words deleted since stay in it), the metadata map and every board ever made in the doc.
//
// A doc still on the old editor is converted on the fly (the migration's conversion, ./migrate.ts), so
// every published doc reads the same way.
import * as Y from 'yjs';
import { copyCanvasMaps } from '../canvas';
import { planMigration } from './migrate';
import { BLOCKS_FRAGMENT, blocksToYElements, hasBlocks, readBlocks, type DocBlock, type NewBlock } from './serverEditor';

/** The canvas ids of these blocks, in order (children too). */
export function canvasIdsOfBlocks(blocks: readonly (DocBlock | NewBlock)[]): string[] {
    const ids: string[] = [];
    const walk = (list: readonly (DocBlock | NewBlock)[]) => {
        for (const b of list) {
            const id = b.props?.['canvasId'];
            if (b.type === 'canvas' && typeof id === 'string' && id) ids.push(id);
            walk(b.children ?? []);
        }
    };
    walk(blocks);
    return ids;
}

/** What a reader sees: the doc's blocks, or its old content converted to blocks. */
export function publicBlocks(ydoc: Y.Doc): NewBlock[] {
    return hasBlocks(ydoc) ? readBlocks(ydoc) : planMigration(ydoc).blocks;
}

/**
 * DOC_PAGES_PLAN §7: on a published doc a page block is a line linking to that page's public address when the page is
 * published (`links`: its id → its title and slug), and goes when it is not (a private page's title never reaches the web).
 */
export function publicPageLinks(blocks: readonly NewBlock[], links: ReadonlyMap<string, { title: string; slug: string }>): NewBlock[] {
    const out: NewBlock[] = [];
    for (const b of blocks) {
        const children = b.children?.length ? publicPageLinks(b.children, links) : [];
        if (b.type === 'page') {
            const to = links.get(String(b.props?.['docId'] ?? ''));
            if (to) out.push({ type: 'paragraph', content: [{ type: 'link', href: `/p/${to.slug}`, content: [{ type: 'text', text: to.title, styles: {} }] }] as never, children });
            else out.push(...children);
            continue;
        }
        out.push({ ...b, children });
    }
    return out;
}

/** The page's state: a new Y.Doc with the blocks (fragment "blocks") and their boards, encoded. */
export function publicDocState(ydoc: Y.Doc): Uint8Array {
    return stateOfBlocks(ydoc, publicBlocks(ydoc));
}

/**
 * A fresh Y.Doc's state holding only these blocks (fragment "blocks") and the boards of their canvases, copied from
 * `ydoc`: what the new editor draws read-only (a published page; a doc's revision card, STUDY_FLOW_PLAN §4.4).
 */
export function stateOfBlocks(ydoc: Y.Doc, blocks: readonly NewBlock[]): Uint8Array {
    const out = new Y.Doc();
    try {
        if (blocks.length > 0) {
            const elements = blocksToYElements([...blocks]);
            out.transact(() => {
                const group = new Y.XmlElement('blockGroup');
                out.getXmlFragment(BLOCKS_FRAGMENT).insert(0, [group]);
                group.insert(0, elements);
            });
        }
        copyCanvasMaps(ydoc, out, canvasIdsOfBlocks(blocks));
        return Y.encodeStateAsUpdate(out);
    } finally {
        out.destroy();
    }
}
