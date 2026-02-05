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
   * - Owner and collaborators (editors/viewers) can access
   * - Anonymous users with valid shareToken can access
   */
  async authorize(userId: string | null, drawingId: string, shareToken?: string): Promise<boolean> {
    console.log('[drawingHandler] === AUTHORIZE ===');
    console.log('[drawingHandler] userId:', userId);
    console.log('[drawingHandler] drawingId:', drawingId);
    console.log('[drawingHandler] shareToken:', shareToken ? shareToken.slice(0, 8) + '...' : 'none');
    
    try {
      const drawing = await Drawing.findById(drawingId);
      if (!drawing) {
        console.log('[drawingHandler] ❌ Drawing not found');
        return false;
      }
      console.log('[drawingHandler] Drawing found:', drawing.name);
      console.log('[drawingHandler] Drawing shareEnabled:', drawing.shareEnabled);
      console.log('[drawingHandler] Drawing shareToken:', drawing.shareToken ? drawing.shareToken.slice(0, 8) + '...' : 'none');
      if (shareToken) {
        const tokenMatches = drawing.shareToken === shareToken;
        const isEnabled = drawing.shareEnabled;
        console.log('[drawingHandler] Token matches:', tokenMatches);
        console.log('[drawingHandler] Share enabled:', isEnabled);
        
        const isValidShare = tokenMatches && isEnabled;
        if (isValidShare) {
          console.log(`[drawingHandler] ✅ Share token valid for ${drawingId}`);
          return true;
        } else {
          console.log(`[drawingHandler] ❌ Share token invalid - matches: ${tokenMatches}, enabled: ${isEnabled}`);
        }
      }
      if (!userId) {
        console.log('[drawingHandler] ❌ No userId and no valid share token');
        return false;
      }
      const isOwner = drawing.user.toString() === userId;
      console.log('[drawingHandler] Is owner:', isOwner);
      if (isOwner) {
        console.log('[drawingHandler] ✅ Owner authorized');
        return true;
      }
      const collaborator = drawing.collaborators?.find(
        (c: any) => c.user.toString() === userId
      );
      console.log('[drawingHandler] Is collaborator:', !!collaborator);

      return !!collaborator;
    } catch (err) {
      console.error('[drawingHandler] ❌ Error:', err);
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
    console.log(`[drawingHandler] Cleanup for drawing ${drawingId}`);
  },
};

export function registerDrawingHandler() {
  registerDocumentHandler('drawing', drawingHandler);
}

export default drawingHandler;
