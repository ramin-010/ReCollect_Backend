// BlockNote on the server (DOCS_EDITOR_V2_PLAN §4): one headless editor with the doc schema
// (./specs.ts), for converting blocks to and from the new editor's Yjs fragment ("blocks") without
// a browser. Loaded on first use (BlockNote is ESM; Node 22 loads it through require).
//
// BlockNote's generic types don't fit this project's `exactOptionalPropertyTypes`, so the editor is
// used through the small typed surface below (the shapes are BlockNote's JSON blocks).
import path from 'node:path';
import * as Y from 'yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { BLOCKS_YJS_FRAGMENT } from '../docSchema';
import { serverDocSchema } from './specs';

/** The new editor's Yjs fragment. The old editor's ("default") stays beside it until the switch. */
export const BLOCKS_FRAGMENT = BLOCKS_YJS_FRAGMENT;

export type Styles = Record<string, string | boolean>;
export type StyledText = { type: 'text'; text: string; styles: Styles };
export type InlineNode = StyledText | { type: 'link'; href: string; content: StyledText[] };

/** A table's content (BlockNote's "tableContent"): rows of cells of inline content. */
export interface TableContent {
    type: 'tableContent';
    columnWidths?: (number | undefined)[];
    headerRows?: number;
    rows: { cells: (InlineNode[] | { type: 'tableCell'; content: InlineNode[]; props?: Record<string, unknown> })[] }[];
}

/** A block as stored: BlockNote's JSON block. `content` is inline nodes, a plain string (code, diagram), a table, or absent. */
export interface DocBlock {
    id: string;
    type: string;
    props: Record<string, unknown>;
    content?: InlineNode[] | string | TableContent | undefined;
    children: DocBlock[];
}

/** A block as written: everything but the type optional (BlockNote's PartialBlock). */
export interface NewBlock {
    id?: string;
    type: string;
    props?: Record<string, unknown>;
    content?: InlineNode[] | string | TableContent | undefined;
    children?: NewBlock[];
}

export interface ServerEditor {
    yXmlFragmentToBlocks(fragment: Y.XmlFragment): DocBlock[];
    yDocToBlocks(doc: Y.Doc, fragment?: string): DocBlock[];
    blocksToYDoc(blocks: NewBlock[], fragment?: string): Y.Doc;
    blocksToYXmlFragment(blocks: DocBlock[], fragment?: Y.XmlFragment): Y.XmlFragment;
    blocksToMarkdownLossy(blocks: NewBlock[]): Promise<string>;
    tryParseMarkdownToBlocks(markdown: string): Promise<DocBlock[]>;
}

/**
 * The Yjs that BlockNote uses. BlockNote is ESM, so it gets Yjs's ESM build, while this CommonJS
 * server (and Hocuspocus) gets the CJS build: two copies of the classes ("Yjs was already
 * imported" is printed once), and a Y object from one fails the other's instanceof checks. So Y
 * objects never cross between them: docs go across as encoded updates (bytes), here.
 */
let blockNoteYjs: typeof Y | undefined;
function yForBlockNote(): typeof Y {
    if (!blockNoteYjs) {
        // The ESM file by its path (the package's exports don't list it): the same module BlockNote imports.
        const file = path.join(path.dirname(require.resolve('yjs/package.json')), 'dist', 'yjs.mjs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        blockNoteYjs = require(file) as typeof Y;
    }
    return blockNoteYjs;
}

let editor: ServerEditor | undefined;

export function serverEditor(): ServerEditor {
    if (!editor) {
        // A jsdom document for BlockNote's DOM work (the subpath export needs Node's own resolution).
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getDocument } = require('@blocknote/server-util/dom') as { getDocument: () => Document };
        editor = ServerBlockNoteEditor.create({ schema: serverDocSchema as never }, getDocument()) as unknown as ServerEditor;
    }
    return editor;
}

/** True when the doc has the new editor's content (a non-empty "blocks" fragment). */
export function hasBlocks(doc: Y.Doc): boolean {
    return doc.share.has(BLOCKS_FRAGMENT) && doc.getXmlFragment(BLOCKS_FRAGMENT).length > 0;
}

/** The doc's blocks (the new editor's fragment); [] when it has none. Never creates the fragment. */
export function readBlocks(doc: Y.Doc): DocBlock[] {
    if (!doc.share.has(BLOCKS_FRAGMENT)) return [];
    const YB = yForBlockNote();
    const copy = new YB.Doc();
    try {
        YB.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
        return serverEditor().yDocToBlocks(copy, BLOCKS_FRAGMENT);
    } finally {
        copy.destroy();
    }
}

/**
 * New blocks as loose Y elements (blockContainer elements) to insert into a live doc's block
 * group: BlockNote encodes them on a scratch doc (its Yjs), the bytes are read into one of ours,
 * and the copies carry their ids. Throws when a block doesn't fit the schema.
 */
export function blocksToYElements(blocks: readonly NewBlock[]): Y.XmlElement[] {
    return withEncodedBlocks(blocks, (containers) => containers.map((el) => el.clone()));
}

/**
 * One block's own content element (the paragraph, heading, callout… element inside its container),
 * as a loose copy to put in place of another, and its attributes (read while it is still in a doc:
 * a loose Y type shows no content or attributes until it is inserted).
 */
export function blockContentElement(block: NewBlock): { element: Y.XmlElement; attributes: Record<string, unknown> } {
    return withEncodedBlocks([{ ...block, children: [] }], (containers) => {
        const content = containers[0]?.get(0);
        if (!(content instanceof Y.XmlElement)) throw new Error(`${block.type} could not be built`);
        return { element: content.clone(), attributes: { ...content.getAttributes() } };
    });
}

/** BlockNote encodes the blocks; `read` sees their containers in a doc of our Yjs (bytes cross, never objects). */
function withEncodedBlocks<T>(blocks: readonly NewBlock[], read: (containers: Y.XmlElement[]) => T): T {
    const YB = yForBlockNote();
    const theirs = serverEditor().blocksToYDoc([...blocks], BLOCKS_FRAGMENT);
    const ours = new Y.Doc();
    try {
        Y.applyUpdate(ours, YB.encodeStateAsUpdate(theirs as unknown as Parameters<typeof YB.encodeStateAsUpdate>[0]));
        const group = ours.getXmlFragment(BLOCKS_FRAGMENT).get(0);
        const containers = group instanceof Y.XmlElement ? group.toArray().filter((el): el is Y.XmlElement => el instanceof Y.XmlElement) : [];
        return read(containers);
    } finally {
        theirs.destroy();
        ours.destroy();
    }
}
