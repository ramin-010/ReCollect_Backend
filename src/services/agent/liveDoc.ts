// Agent writes to a doc go through the live collaboration server (Hocuspocus), never around it:
// the change is ONE Yjs transaction on the in-memory doc, so an editor that has the doc open gets
// it at once and keeps everything its user is typing (CRDT merge, no overwrite), and the doc is
// stored (onStoreDocument → Doc.yjsState, previewState, title, updatedAt) before the call returns.
//
// The API and Hocuspocus run in one process (src/index.ts), so this uses the Hocuspocus instance
// directly: openDirectConnection('doc_<id>') loads the doc (or joins the live one) without the
// WebSocket auth hook. Callers check permissions first (src/services/agent/agentDocs.service.ts).
// Change capture and Undo are in ./yjsChanges.ts.
import type * as Y from 'yjs';
import type { Document } from '@hocuspocus/server';
import { hocuspocusServer, registerDocumentHandler } from '../../collaboration/hocuspocus';
import docHandler from '../../collaboration/docHandler';
import { DOC_YJS_FRAGMENT } from '../docs/docSchema';
import { transactCapturing, undoChangeOn, type DocChange } from './yjsChanges';

export { fromBase64, toBase64 } from './yjsChanges';
export type LiveChange = DocChange;

export const docRoom = (docId: string): string => `doc_${docId}`;

/** The live in-memory doc when an editor (or another write) has it open, else undefined. */
export function liveDocument(docId: string): Document | undefined {
    return hocuspocusServer.hocuspocus.documents.get(docRoom(docId));
}

export interface LiveDoc {
    readonly doc: Y.Doc;
    readonly fragment: Y.XmlFragment;
    /** Run `mutate` as one transaction (broadcast + stored). At most once per withLiveDoc. */
    apply(mutate: (fragment: Y.XmlFragment) => void): LiveChange;
}

/**
 * Open the doc on the collaboration server and run `fn` on it. `fn` is synchronous: it reads the
 * live fragment, throws to refuse (nothing changes), or calls `apply` once. Resolves after the
 * change is stored; the connection is always closed (the doc unloads if nobody else has it).
 */
export async function withLiveDoc<T>(docId: string, actor: string, fn: (live: LiveDoc) => T): Promise<T> {
    // The API process normally registers it at startup (src/index.ts); tests and scripts may not.
    registerDocumentHandler('doc', docHandler);
    const connection = await hocuspocusServer.hocuspocus.openDirectConnection(docRoom(docId), {
        user: { name: `agent:${actor}` },
    });
    let stored: Promise<void> | null = null;
    try {
        const document = connection.document;
        if (!document) throw new Error('The live doc could not be opened');
        const live: LiveDoc = {
            doc: document,
            fragment: document.getXmlFragment(DOC_YJS_FRAGMENT),
            apply(mutate) {
                if (stored) throw new Error('withLiveDoc: one change per connection');
                let change: LiveChange | undefined;
                let failure: unknown;
                // transact() runs the callback synchronously, then stores the doc right away.
                stored = connection.transact((doc) => {
                    try {
                        change = transactCapturing(doc, mutate);
                    } catch (err) {
                        failure = err;
                    }
                });
                if (failure !== undefined) throw failure;
                return change!;
            },
        };
        const result = fn(live);
        if (stored) await stored;
        return result;
    } finally {
        if (stored) await (stored as Promise<void>).catch(() => {});
        await connection.disconnect();
    }
}

/** Take an agent change back on the live doc (see undoChangeOn). */
export function undoChange(live: LiveDoc, before: Uint8Array, change: Uint8Array | null): LiveChange {
    return undoChangeOn(live.doc, before, change, (mutate) => live.apply(mutate));
}
