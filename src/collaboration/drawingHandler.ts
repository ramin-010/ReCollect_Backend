import { DocumentHandler, CollabDocument, registerDocumentHandler } from './hocuspocus';
import Drawing from '../models/drawingSchema';
import * as Y from 'yjs';

/**
 * Hocuspocus handler for Drawing collaboration.
 * Handles authorization, loading, and saving of Yjs state for drawings.
 */
const drawingHandler: DocumentHandler = {
  /**
   * Authorize user to access the drawing.
   * Owner and collaborators (editors/viewers) can access.
   */
  async authorize(userId: string, drawingId: string): Promise<boolean> {
    try {
      const drawing = await Drawing.findById(drawingId);
      if (!drawing) return false;

      // Owner can always access
      const isOwner = drawing.user.toString() === userId;
      if (isOwner) return true;

      // Check if user is a collaborator
      const collaborator = drawing.collaborators?.find(
        (c: any) => c.user.toString() === userId
      );

      return !!collaborator;
    } catch {
      return false;
    }
  },

  /**
   * Load drawing yjsState from MongoDB.
   */
  async load(drawingId: string): Promise<CollabDocument | null> {
    try {
      const drawing = await Drawing.findById(drawingId) as any;
      if (!drawing) return null;

      return {
        id: drawing._id.toString(),
        yjsState: drawing.yjsState,
      };
    } catch {
      return null;
    }
  },

  /**
   * Save yjsState to MongoDB.
   * Called by Hocuspocus when document is stored.
   */
  async save(drawingId: string, yjsState: string): Promise<void> {
    try {
      await Drawing.findByIdAndUpdate(drawingId, {
        yjsState,
        updatedAt: new Date(),
      });
      console.log(`[drawingHandler] Saved drawing ${drawingId}`);
    } catch (error) {
      console.error(`[drawingHandler] Error saving drawing ${drawingId}:`, error);
    }
  },

  /**
   * Cleanup when all users disconnect from a drawing.
   * Could be used to clean orphaned images in the future.
   */
  async cleanup(drawingId: string): Promise<void> {
    // Future: clean orphaned images from Excalidraw elements
    console.log(`[drawingHandler] Cleanup for drawing ${drawingId}`);
  },
};

export function registerDrawingHandler() {
  registerDocumentHandler('drawing', drawingHandler);
}

export default drawingHandler;
