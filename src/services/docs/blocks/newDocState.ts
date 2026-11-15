// Docs on the new editor from their first state (the switch, DOCS_EDITOR_V2_PLAN phase 4, 2026-11-15):
// a new doc holds its blocks in the "blocks" fragment, the boards of its canvases in their root maps
// and its title in the metadata map, like the live editor keeps them. No old ("default") fragment.
//
// And the one rule for which editor a doc is on: the new one, unless it holds old content and no
// blocks (a doc nobody migrated). An empty doc is on the new editor: its first write makes blocks.
import * as Y from 'yjs';
import { writeBoards, type Board } from '../canvas';
import { DOC_YJS_FRAGMENT } from '../docSchema';
import { oldJsonToBlocks } from './fromOldJson';
import { BLOCKS_FRAGMENT, blocksToYElements, hasBlocks, type NewBlock } from './serverEditor';
import type { JSONContent } from '@tiptap/core';
import { stateBytes, type StateBytes } from '../docState';

/** True unless the doc holds the old editor's content and no blocks. */
export function onNewEditor(ydoc: Y.Doc): boolean {
    if (hasBlocks(ydoc)) return true;
    return !(ydoc.share.has(DOC_YJS_FRAGMENT) && ydoc.getXmlFragment(DOC_YJS_FRAGMENT).length > 0);
}

/** A new doc's state (bytes, as Doc.yjsState stores it): the blocks, their boards, the title. */
export function blocksDocState(blocks: readonly NewBlock[], boards: ReadonlyMap<string, Board>, meta: { title: string; coverImage?: string | null }): StateBytes {
    const ydoc = new Y.Doc();
    try {
        const elements = blocks.length > 0 ? blocksToYElements(blocks) : [];
        ydoc.transact(() => {
            const map = ydoc.getMap('metadata');
            map.set('title', meta.title);
            map.set('coverImage', meta.coverImage ?? null);
            if (elements.length > 0) {
                const group = new Y.XmlElement('blockGroup');
                ydoc.getXmlFragment(BLOCKS_FRAGMENT).insert(0, [group]);
                group.insert(0, elements);
            }
        });
        if (boards.size > 0) writeBoards(ydoc, boards);
        return stateBytes(Y.encodeStateAsUpdate(ydoc));
    } finally {
        ydoc.destroy();
    }
}

/** A template's content (the app's TipTap JSON, lib/docs/templates.ts) as a new doc's blocks. */
export function templateDocState(content: unknown, title: string): StateBytes {
    const json: JSONContent = content && typeof content === 'object' && (content as JSONContent).type === 'doc' ? (content as JSONContent) : { type: 'doc', content: Array.isArray(content) ? (content as JSONContent[]) : [] };
    const { blocks } = oldJsonToBlocks(json);
    return blocksDocState(blocks, new Map(), { title });
}
