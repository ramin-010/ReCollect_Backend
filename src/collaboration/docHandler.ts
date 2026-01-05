import { DocumentHandler, CollabDocument, registerDocumentHandler } from './hocuspocus';
import Doc from '../models/docSchema';
import { batchDeleteFromCloud } from '../controllers/content.controller';
import * as Y from 'yjs';

/**
 * Extract cloudPublicIds from yjsState by decoding and traversing the document
 */
function extractPublicIdsFromYjsState(yjsStateBase64: string): string[] {
  try {
    const ydoc = new Y.Doc();
    const state = Buffer.from(yjsStateBase64, 'base64');
    Y.applyUpdate(ydoc, state);
    
    // Get the prosemirror fragment from Yjs
    const fragment = ydoc.getXmlFragment('default');
    const publicIds: string[] = [];
    
    // Traverse the Yjs XML fragment to find images
    function traverse(element: any) {
      if (element.nodeName === 'resizableImage' || element.nodeName === 'image') {
        const attrs = element.getAttributes();
        if (attrs.cloudPublicId) {
          publicIds.push(attrs.cloudPublicId);
        }
      }
      // Traverse children
      if (element.toArray) {
        for (const child of element.toArray()) {
          traverse(child);
        }
      }
    }
    
    traverse(fragment);
    ydoc.destroy();
    return publicIds;
  } catch (err) {
    console.error('[docHandler] Failed to extract publicIds from yjsState:', err);
    return [];
  }
}

const docHandler: DocumentHandler = {
  async authorize(userId: string, docId: string): Promise<boolean> {
    try {
      const doc = await Doc.findById(docId);
      if (!doc) return false;

      const isOwner = doc.user.toString() === userId;
      if (isOwner) return true;

      const collaborator = doc.collaborators?.find(
        (c: any) => c.user.toString() === userId && c.role === 'editor'
      );

      return !!collaborator;
    } catch {
      return false;
    }
  },

  async load(docId: string): Promise<CollabDocument | null> {
    try {
      const doc = await Doc.findById(docId) as any;
      if (!doc) return null;

      return {
        id: doc._id.toString(),
        yjsState: doc.yjsState,
      };
    } catch {
      return null;
    }
  },

  async save(docId: string, yjsState: string): Promise<void> {
    // Extract current images from the yjsState being saved
    const currentPublicIds = extractPublicIdsFromYjsState(yjsState);
    const currentPublicIdsSet = new Set(currentPublicIds);
    
    // Get existing cloudImages from DB
    const doc = await Doc.findById(docId) as any;
    const existingImages = doc?.cloudImages || [];
    
    // Find orphaned images (in DB but not in current yjsState)
    const orphanedImages = existingImages.filter(
      (img: any) => !currentPublicIdsSet.has(img.cloudPublicId)
    );
    
    // Delete orphaned images from Cloudinary
    if (orphanedImages.length > 0) {
      const publicIdsToDelete = orphanedImages.map((img: any) => img.cloudPublicId);
      console.log(`[docHandler] Cleaning up ${orphanedImages.length} orphaned images`);
      await batchDeleteFromCloud(publicIdsToDelete);
    }
    
    // Update cloudImages to only contain current images
    const updatedCloudImages = existingImages.filter(
      (img: any) => currentPublicIdsSet.has(img.cloudPublicId)
    );
    
    // Save yjsState and updated cloudImages
    await Doc.findByIdAndUpdate(docId, {
      yjsState,
      cloudImages: updatedCloudImages,
      updatedAt: new Date(),
    });
  },
};

export function registerDocHandler() {
  registerDocumentHandler('doc', docHandler);
}

export default docHandler;

