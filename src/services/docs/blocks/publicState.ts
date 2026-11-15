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

/** The page's state: a new Y.Doc with the blocks (fragment "blocks") and their boards, encoded. */
export function publicDocState(ydoc: Y.Doc): Uint8Array {
    const blocks = publicBlocks(ydoc);
    const out = new Y.Doc();
    try {
        if (blocks.length > 0) {
            const elements = blocksToYElements(blocks);
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
