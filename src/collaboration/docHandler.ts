// Hocuspocus handler for docs (rooms `doc_<id>`): who may connect, load/store of the Yjs state,
// and the Cloudinary orphan-image cleanup when someone disconnects. DB access goes through
// src/services/docs/docs.service.ts; yjsState is bytes (D3, 2026-11-15).
import { DocumentHandler, CollabAccess, CollabDocument, registerDocumentHandler, hocuspocusServer } from './hocuspocus';
import { batchDeleteFromCloud } from '../utils/cloudinary';
import { generatePreviewAndMetadata } from '../utils/previewUtils';
import { stateBytes } from '../services/docs/docState';
import { extractImageIdsFromYDoc, extractImageIdsFromYjsState } from '../services/docs/docContent';
import { docProblem, repairDoc } from '../services/docs/docRepair';
import type * as Y from 'yjs';
import { partitionCloudImages, readCloudImages } from '../services/uploads/cloudImages';
import {
  findDocImageState,
  getDocLiveRole,
  loadDocYjsState,
  removeDocCloudImages,
  storeDocYjsState,
  undoableSnapshotStates,
} from '../services/docs/docs.service';

/**
 * Image ids used by the doc's live (in-memory) state, if Hocuspocus still holds it. The stored
 * state lags behind it (stores are debounced 2–10 s), so an image inserted just before someone
 * disconnects is only in the live document.
 */
function liveImageIds(docId: string): string[] {
  try {
    const live = (hocuspocusServer as any).hocuspocus?.documents?.get(`doc_${docId}`);
    return live ? extractImageIdsFromYDoc(live) : [];
  } catch (err) {
    console.error('[docHandler] Failed to read the live document:', err);
    return [];
  }
}

const docHandler: DocumentHandler = {
  /**
   * Docs don't support anonymous access (share links only lead to an access request). Owner and
   * editors connect read-write; viewers connect read-only (Hocuspocus drops their updates).
   */
  async authorize(userId: string | null, docId: string): Promise<CollabAccess | null> {
    try {
      if (!userId) return null;
      const role = await getDocLiveRole(docId, userId);
      if (role === null) return null;
      return role === 'viewer' ? 'view' : 'edit';
    } catch {
      return null;
    }
  },

  async load(docId: string): Promise<CollabDocument | null> {
    try {
      const doc = await loadDocYjsState(docId);
      if (!doc) return null;
      return { id: doc.id, yjsState: doc.yjsState ?? undefined };
    } catch {
      return null;
    }
  },

  /** Legacy blocks (columns) and stray list items fixed on load; anything still invalid is logged. */
  repair(docId: string, document: Y.Doc): number {
    const repairs = repairDoc(document);
    if (repairs > 0) console.log(`[docHandler] doc ${docId}: ${repairs} repair(s) on load (columns flattened or list items re-wrapped)`);
    const problem = docProblem(document);
    if (problem) console.warn(`[docHandler] doc ${docId} does not fit the schema after load: ${problem}`);
    return repairs;
  },

  async save(docId: string, yjsState: Uint8Array): Promise<void> {
    const { previewState, metadata } = generatePreviewAndMetadata(yjsState);
    await storeDocYjsState(docId, {
      yjsState: stateBytes(yjsState),
      previewState,
      title: metadata.title,
      coverImage: metadata.coverImage,
    });
  },

  /**
   * Delete Cloudinary images the doc no longer uses (not in the stored nor in the live state, nor
   * in a snapshot an agent edit can still be undone to).
   */
  async cleanup(docId: string): Promise<void> {
    const doc = await findDocImageState(docId);
    if (!doc?.yjsState) return;

    const storedIds = extractImageIdsFromYjsState(doc.yjsState);
    if (storedIds === null) return; // unreadable state: never treat that as "no images"

    const undoIds: string[] = [];
    for (const state of await undoableSnapshotStates(docId)) {
      const ids = extractImageIdsFromYjsState(state);
      if (ids === null) return; // same rule for an unreadable snapshot
      undoIds.push(...ids);
    }

    const inUse = new Set([...storedIds, ...liveImageIds(docId), ...undoIds]);
    const { orphaned } = partitionCloudImages(readCloudImages(doc.cloudImages), inUse);
    if (orphaned.length === 0) return;

    console.log(`[docHandler] Cleanup ${docId}: deleting ${orphaned.length} orphaned image(s)`);
    await batchDeleteFromCloud(orphaned.map((img) => img.cloudPublicId));
    await removeDocCloudImages(docId, orphaned.map((img) => img.imageId));
  },
};

export function registerDocHandler() {
  registerDocumentHandler('doc', docHandler);
}

export default docHandler;
