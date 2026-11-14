// Yjs change bookkeeping for agent doc edits, pure (no server, no database): capture one change,
// and take it back later without touching what others wrote since. Used by ./liveDoc.ts.
//
// A change is recorded as the whole state before it (`before`) plus the update it produced.
// revertUpdate() replays both on a scratch doc under a Y.UndoManager and returns the undo as a NEW
// update: applied to the live doc it deletes the blocks the change inserted and brings back (as
// new copies, at their old place) the blocks it deleted. Edits made after the change stay.
// Canvas boards live outside the fragment (root maps canvas:<id>:nodes / :edges, see
// ../docs/canvas.ts): the maps a change touched are undone with it.
import * as Y from 'yjs';
import { canvasRootsTouched, restoreCanvasMaps } from '../docs/canvas';
import { DOC_YJS_FRAGMENT } from '../docs/docSchema';
import { repairLegacyBlocks } from '../docs/docRepair';

/** What one change did: the state before it and the change (null when nothing changed). */
export interface DocChange {
    before: Uint8Array;
    update: Uint8Array | null;
}

/** One Yjs transaction on the doc's editor fragment, capturing the state before it and its update. */
export function transactCapturing(doc: Y.Doc, mutate: (fragment: Y.XmlFragment) => void): DocChange {
    const before = Y.encodeStateAsUpdate(doc);
    const updates: Uint8Array[] = [];
    const collect = (update: Uint8Array) => updates.push(update);
    doc.on('update', collect);
    try {
        doc.transact(() => mutate(doc.getXmlFragment(DOC_YJS_FRAGMENT)));
    } finally {
        doc.off('update', collect);
    }
    return { before, update: updates.length > 0 ? Y.mergeUpdates(updates) : null };
}

/** True when `doc` has every change contained in these updates (a revert built on them applies). */
export function containsUpdates(doc: Y.Doc, ...updates: Uint8Array[]): boolean {
    const needed = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(Y.mergeUpdates(updates)));
    const have = Y.decodeStateVector(Y.encodeStateVector(doc));
    for (const [client, clock] of needed) {
        if ((have.get(client) ?? 0) < clock) return false;
    }
    return true;
}

/**
 * The update that undoes `change` (made on top of `before`) and nothing else; null if nothing to
 * undo. Its scope: the editor fragment plus every canvas map the change touched.
 */
export function revertUpdate(before: Uint8Array, change: Uint8Array): Uint8Array | null {
    const canvasMaps = canvasRootsTouched(before, change);
    const scratch = new Y.Doc();
    try {
        Y.applyUpdate(scratch, before);
        const origin = Symbol('agent-change');
        const scope = [scratch.getXmlFragment(DOC_YJS_FRAGMENT), ...canvasMaps.map((name) => scratch.getMap(name))];
        const undo = new Y.UndoManager(scope, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
        Y.applyUpdate(scratch, change, origin);
        const updates: Uint8Array[] = [];
        const collect = (update: Uint8Array) => updates.push(update);
        scratch.on('update', collect);
        while (undo.undoStack.length > 0) undo.undo();
        scratch.off('update', collect);
        undo.destroy();
        return updates.length > 0 ? Y.mergeUpdates(updates) : null;
    } finally {
        scratch.destroy();
    }
}

/**
 * Replace the fragment's content with the content of a whole snapshot (the fallback undo), and
 * the snapshot's canvas maps (its boards as they were). Maps the snapshot doesn't have stay.
 */
export function restoreSnapshotContent(fragment: Y.XmlFragment, snapshot: Uint8Array): void {
    const copy = new Y.Doc();
    try {
        Y.applyUpdate(copy, snapshot);
        const blocks = copy.getXmlFragment(DOC_YJS_FRAGMENT).toArray().map((el) => (el as Y.XmlElement | Y.XmlText).clone());
        if (fragment.length > 0) fragment.delete(0, fragment.length);
        if (blocks.length > 0) fragment.insert(0, blocks);
        if (fragment.doc) restoreCanvasMaps(fragment.doc, copy);
    } finally {
        copy.destroy();
    }
}

/**
 * Undo a change on `doc` (inside `apply`, which runs one transaction): the exact revert when the
 * doc still contains the change (the normal case), else (the doc was replaced wholesale since, or
 * the change wasn't recorded) the snapshot's content.
 */
export function undoChangeOn(doc: Y.Doc, before: Uint8Array, change: Uint8Array | null, apply: (mutate: (fragment: Y.XmlFragment) => void) => DocChange): DocChange {
    if (change && containsUpdates(doc, before, change)) {
        const revert = revertUpdate(before, change);
        return apply((fragment) => {
            if (revert) Y.applyUpdate(doc, revert);
            // What comes back may predate a repair (side-by-side columns): fix it in the same change.
            repairLegacyBlocks(fragment);
        });
    }
    return apply((fragment) => {
        restoreSnapshotContent(fragment, before);
        repairLegacyBlocks(fragment);
    });
}

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
export const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));
