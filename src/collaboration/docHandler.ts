import { DocumentHandler, CollabDocument, registerDocumentHandler } from './hocuspocus';
import Doc from '../models/docSchema';

/**
 * Document Handler for Docs feature
 * 
 * To add collaboration for a new feature (e.g., Content), create a similar handler:
 * 1. Create `contentHandler.ts`
 * 2. Implement the DocumentHandler interface
 * 3. Call registerDocumentHandler('content', contentHandler)
 * 4. Frontend uses documentName: `content_${contentId}`
 */
const docHandler: DocumentHandler = {
  // Check if user is owner or editor collaborator
  async authorize(userId: string, docId: string): Promise<boolean> {
    try {
      const doc = await Doc.findById(docId);
      if (!doc) return false;

      // Owner can always edit
      const isOwner = doc.user.toString() === userId;
      if (isOwner) return true;

      // Collaborator with editor role can edit
      const collaborator = doc.collaborators?.find(
        (c: any) => c.user.toString() === userId && c.role === 'editor'
      );

      return !!collaborator;
    } catch {
      return false;
    }
  },

  // Load document from MongoDB
  async load(docId: string): Promise<CollabDocument | null> {
    try {
      const doc = await Doc.findById(docId) as any;
      if (!doc) return null;

      return {
        id: doc._id.toString(),
        yjsState: doc.yjsState,
        content: doc.content,
      };
    } catch {
      return null;
    }
  },

  // Save Yjs state to MongoDB
  async save(docId: string, yjsState: string): Promise<void> {
    await Doc.findByIdAndUpdate(docId, {
      yjsState,
      updatedAt: new Date(),
    });
  },
};

// Register the handler - called when this module is imported
export function registerDocHandler() {
  registerDocumentHandler('doc', docHandler);
}

export default docHandler;
