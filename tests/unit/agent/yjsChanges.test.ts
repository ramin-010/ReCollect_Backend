// Agent doc changes and their Undo, on plain Y.Docs (src/services/agent/yjsChanges.ts): the undo
// takes back exactly the agent's change and keeps what a person typed afterwards.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { JSONContent } from '@tiptap/core';
import { docJsonToYElements, markdownToBlocks } from '../../../src/services/docs/markdown/docMarkdown';
import { yjsStateToDocJson } from '../../../src/services/docs/docContent';
import { canvasMapNames, normalizeBoard, readBoard, takeCanvasData, writeBoards, type Board } from '../../../src/services/docs/canvas';
import {
    containsUpdates,
    restoreSnapshotContent,
    revertUpdate,
    transactCapturing,
    undoChangeOn,
} from '../../../src/services/agent/yjsChanges';

const elements = (md: string) => docJsonToYElements({ type: 'doc', content: markdownToBlocks(md) });

/** A doc holding this Markdown, and a second replica of it (a person's editor). */
function docWith(md: string): Y.Doc {
    const doc = new Y.Doc();
    doc.getXmlFragment('default').insert(0, elements(md));
    return doc;
}

function replicaOf(doc: Y.Doc): Y.Doc {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    return copy;
}

/** Sync both ways (what Hocuspocus does between editor and server). */
function sync(a: Y.Doc, b: Y.Doc): void {
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
}

/** The doc's top-level blocks as "type:text" strings. */
function outline(doc: Y.Doc): string[] {
    const json = yjsStateToDocJson(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'));
    const textOf = (n: JSONContent): string => (n.type === 'text' ? n.text ?? '' : (n.content ?? []).map(textOf).join(''));
    return (json.content as JSONContent[]).map((b) => `${b.type}:${textOf(b)}`);
}

/** A person appends text to the XmlText of top-level block `index`. */
function typeInto(doc: Y.Doc, index: number, text: string): void {
    const block = doc.getXmlFragment('default').get(index) as Y.XmlElement;
    const run = block.get(0) as Y.XmlText;
    run.insert(run.length, text);
}

describe('agent change + undo', () => {
    it('undo of an append removes the agent blocks and keeps text typed after it', () => {
        const server = docWith('one');
        const change = transactCapturing(server, (f) => f.insert(1, elements('agent A\n\nagent B')));
        expect(outline(server)).toEqual(['paragraph:one', 'paragraph:agent A', 'paragraph:agent B']);

        // A person (synced) keeps typing, in their own block and in the agent's.
        const editor = replicaOf(server);
        typeInto(editor, 0, '!');
        editor.getXmlFragment('default').insert(3, elements('mine'));
        sync(server, editor);

        expect(containsUpdates(server, change.before, change.update!)).toBe(true);
        Y.applyUpdate(server, revertUpdate(change.before, change.update!)!);
        expect(outline(server)).toEqual(['paragraph:one!', 'paragraph:mine']);
        sync(server, editor);
        expect(outline(editor)).toEqual(['paragraph:one!', 'paragraph:mine']);
    });

    it('undo of a replaced section brings the old blocks back in place; later edits elsewhere stay', () => {
        const server = docWith('## Intro\n\nold 1\n\nold 2\n\n## Next\n\nkeep');
        const change = transactCapturing(server, (f) => {
            f.delete(1, 2);
            f.insert(1, elements('new text'));
        });
        expect(outline(server)).toEqual(['heading:Intro', 'paragraph:new text', 'heading:Next', 'paragraph:keep']);

        const editor = replicaOf(server);
        typeInto(editor, 3, ' more');
        sync(server, editor);

        Y.applyUpdate(server, revertUpdate(change.before, change.update!)!);
        expect(outline(server)).toEqual(['heading:Intro', 'paragraph:old 1', 'paragraph:old 2', 'heading:Next', 'paragraph:keep more']);
    });

    it('keeps formatting and attributes of restored blocks', () => {
        const server = docWith('## S\n\n- [x] **done** task\n\n```ts\nx\n```');
        const original = outline(server);
        const json = () => yjsStateToDocJson(Buffer.from(Y.encodeStateAsUpdate(server)).toString('base64'));
        const before = json();
        const change = transactCapturing(server, (f) => f.delete(1, 2));
        Y.applyUpdate(server, revertUpdate(change.before, change.update!)!);
        expect(outline(server)).toEqual(original);
        expect(json()).toEqual(before);
    });

    it('nothing to revert when the person already deleted the agent blocks', () => {
        const server = docWith('one');
        const change = transactCapturing(server, (f) => f.insert(1, elements('agent')));
        server.getXmlFragment('default').delete(1, 1);
        const revert = revertUpdate(change.before, change.update!);
        if (revert) Y.applyUpdate(server, revert);
        expect(outline(server)).toEqual(['paragraph:one']);
    });

    it('a doc that never saw the change falls back to the snapshot content', () => {
        const server = docWith('one');
        const change = transactCapturing(server, (f) => f.insert(1, elements('agent')));
        const unrelated = docWith('replaced wholesale');
        expect(containsUpdates(unrelated, change.before, change.update!)).toBe(false);

        undoChangeOn(unrelated, change.before, change.update, (mutate) => transactCapturing(unrelated, mutate));
        expect(outline(unrelated)).toEqual(['paragraph:one']);
    });

    it('restoreSnapshotContent replaces everything with the snapshot', () => {
        const target = docWith('a\n\nb');
        const snapshot = Y.encodeStateAsUpdate(docWith('# x\n\ny'));
        target.transact(() => restoreSnapshotContent(target.getXmlFragment('default'), snapshot));
        expect(outline(target)).toEqual(['heading:x', 'paragraph:y']);
    });

    it('a change that changes nothing records no update', () => {
        const doc = docWith('a');
        expect(transactCapturing(doc, () => {}).update).toBeNull();
    });
});

describe('agent change + undo: canvas boards (root maps outside the fragment)', () => {
    /** A board: the first id points at the others. */
    const board = (...ids: string[]): Board =>
        normalizeBoard({ nodes: ids.map((id) => ({ id, text: id.toUpperCase() })), edges: ids.slice(1).map((to) => ({ from: ids[0]!, to })) });

    /** Insert a canvas block at `at` and write its board, as the agent append does; returns its id. */
    function insertCanvas(fragment: Y.XmlFragment, at: number, data: Board): string {
        const { json, boards } = takeCanvasData<JSONContent>({ type: 'doc', content: [{ type: 'canvas', attrs: { canvasId: null, height: 440, data } }] });
        fragment.insert(at, docJsonToYElements(json));
        writeBoards(fragment.doc!, boards);
        return json.content![0]!.attrs!['canvasId'] as string;
    }

    const boxIds = (doc: Y.Doc, canvasId: string) => readBoard(doc, canvasId).nodes.map((n) => n.id);

    it('undo of an append with a canvas removes the block and its board; typing elsewhere stays', () => {
        const server = docWith('one');
        let id = '';
        const change = transactCapturing(server, (f) => {
            id = insertCanvas(f, 1, board('api', 'db', 'cache'));
        });
        expect(outline(server)).toEqual(['paragraph:one', 'canvas:']);
        expect(boxIds(server, id)).toEqual(['api', 'db', 'cache']);

        const editor = replicaOf(server);
        typeInto(editor, 0, '!');
        sync(server, editor);

        Y.applyUpdate(server, revertUpdate(change.before, change.update!)!);
        expect(outline(server)).toEqual(['paragraph:one!']);
        expect(readBoard(server, id)).toEqual({ nodes: [], edges: [] });
        sync(server, editor);
        expect(readBoard(editor, id)).toEqual({ nodes: [], edges: [] });
    });

    it('a box the person added to the agent board afterwards stays (only the change is undone)', () => {
        const server = docWith('one');
        let id = '';
        const change = transactCapturing(server, (f) => {
            id = insertCanvas(f, 1, board('a', 'b'));
        });
        const editor = replicaOf(server);
        editor.getMap(canvasMapNames(id).nodes).set('mine', { id: 'mine', shape: 'sticky', text: 'my note', x: 0, y: 300, w: 200, h: 140, color: 'yellow', z: 9 });
        sync(server, editor);
        Y.applyUpdate(server, revertUpdate(change.before, change.update!)!);
        expect(boxIds(server, id)).toEqual(['mine']);
    });

    it('undo of a rewritten section brings the old canvas back with its id and board; the new board goes', () => {
        const server = new Y.Doc();
        const fragment = server.getXmlFragment('default');
        fragment.insert(0, elements('## Design'));
        const oldId = insertCanvas(fragment, 1, board('client', 'server'));
        fragment.insert(2, elements('## Next\n\nkeep'));

        let newId = '';
        const change = transactCapturing(server, (f) => {
            f.delete(1, 1);
            newId = insertCanvas(f, 1, board('client', 'server', 'cdn'));
        });
        const canvasIdAt = (doc: Y.Doc, i: number) => (doc.getXmlFragment('default').get(i) as Y.XmlElement).getAttribute('canvasId');
        expect(canvasIdAt(server, 1)).toBe(newId);

        Y.applyUpdate(server, revertUpdate(change.before, change.update!)!);
        expect(outline(server)).toEqual(['heading:Design', 'canvas:', 'heading:Next', 'paragraph:keep']);
        expect(canvasIdAt(server, 1)).toBe(oldId);
        expect(boxIds(server, oldId)).toEqual(['client', 'server']);
        expect(boxIds(server, newId)).toEqual([]);
    });

    it('a change to a board alone (moved, added and deleted boxes) is undone exactly', () => {
        const server = new Y.Doc();
        const id = insertCanvas(server.getXmlFragment('default'), 0, board('a', 'b', 'c'));
        const before = readBoard(server, id);
        const names = canvasMapNames(id);
        const change = transactCapturing(server, () => {
            const nodes = server.getMap<Record<string, unknown>>(names.nodes);
            nodes.set('a', { ...nodes.get('a')!, x: 999, text: 'moved' });
            nodes.set('d', { id: 'd', shape: 'rect', text: 'D', x: 0, y: 500, w: 160, h: 64, color: 'red', z: 3 });
            nodes.delete('c');
            server.getMap(names.edges).delete('e2');
        });
        expect(boxIds(server, id)).toEqual(['a', 'b', 'd']);

        Y.applyUpdate(server, revertUpdate(change.before, change.update!)!);
        expect(readBoard(server, id)).toEqual(before);
        expect(outline(server)).toEqual(['canvas:']);
    });

    it('the snapshot fallback restores the snapshot’s boards too', () => {
        const server = new Y.Doc();
        const id = insertCanvas(server.getXmlFragment('default'), 0, board('x', 'y'));
        const change = transactCapturing(server, (f) => f.insert(1, elements('agent')));
        // A doc that never saw the change (replaced wholesale), whose board was emptied meanwhile.
        const unrelated = docWith('replaced');
        writeBoards(unrelated, new Map([[id, board('z')]]));

        undoChangeOn(unrelated, change.before, change.update, (mutate) => transactCapturing(unrelated, mutate));
        expect(outline(unrelated)).toEqual(['canvas:']);
        expect(readBoard(unrelated, id)).toEqual(readBoard(server, id));
    });
});
