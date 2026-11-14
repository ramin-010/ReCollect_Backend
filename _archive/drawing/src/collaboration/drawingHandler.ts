import { DocumentHandler, CollabAccess, CollabDocument, registerDocumentHandler } from './hocuspocus';
import { getDrawingLiveAccess, loadDrawingYjsState, storeDrawingYjsState } from '../services/drawings/drawings.service';

/**
 * Hocuspocus handler for Drawing collaboration (rooms `drawing_<id>`).
 * Handles authorization, loading, and saving of Yjs state for drawings; DB access goes through
 * src/services/drawings/drawings.service.ts. yjsState stays Base64 text.
 */
const drawingHandler: DocumentHandler = {
  /**
   * Authorize user to access the drawing.
   * - Owner and editors: read-write; viewers: read-only
   * - Anyone with a valid shareToken (while sharing is enabled), guests too: read-write
   */
  async authorize(userId: string | null, drawingId: string, shareToken?: string): Promise<CollabAccess | null> {
    try {
      const access = await getDrawingLiveAccess(drawingId, userId, shareToken);
      console.log(
        `[drawingHandler] authorize ${drawingId} | user: ${userId ?? 'guest'} | share token: ${shareToken ? 'yes' : 'no'} | ${access ?? 'denied'}`
      );
      return access;
    } catch (err) {
      console.error('[drawingHandler] ❌ Error:', err);
      return null;
    }
  },

  /**
   * Load drawing yjsState from Postgres.
   */
  async load(drawingId: string): Promise<CollabDocument | null> {
    try {
      const drawing = await loadDrawingYjsState(drawingId);
      if (!drawing) return null;
      return { id: drawing.id, yjsState: drawing.yjsState ?? undefined };
    } catch {
      return null;
    }
  },

  /**
   * Save yjsState to Postgres.
   * Called by Hocuspocus when document is stored.
   */
  async save(drawingId: string, yjsState: string): Promise<void> {
    try {
      const saved = await storeDrawingYjsState(drawingId, yjsState);
      if (saved) console.log(`[drawingHandler] Saved drawing ${drawingId}`);
    } catch (error) {
      console.error(`[drawingHandler] Error saving drawing ${drawingId}:`, error);
    }
  },

  /**
   * Cleanup when all users disconnect from a drawing.
   * Could be used to clean orphaned images in the future (the REST save does it today).
   */
  async cleanup(drawingId: string): Promise<void> {
    console.log(`[drawingHandler] Cleanup for drawing ${drawingId}`);
  },
};

export function registerDrawingHandler() {
  registerDocumentHandler('drawing', drawingHandler);
}

export default drawingHandler;
