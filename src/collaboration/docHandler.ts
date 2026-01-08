import { DocumentHandler, CollabDocument, registerDocumentHandler } from './hocuspocus';
import Doc from '../models/docSchema';
import { batchDeleteFromCloud } from '../controllers/content.controller';
import { generatePreviewAndMetadata } from '../utils/previewUtils';
import * as Y from 'yjs';

function extractImageIdsFromYjsState(yjsStateBase64: string): string[] {
  try {
    const ydoc = new Y.Doc();
    const state = Buffer.from(yjsStateBase64, 'base64');
    Y.applyUpdate(ydoc, state);
    
    const fragment = ydoc.getXmlFragment('default');
    const imageIds: string[] = [];
    
    function traverse(element: any) {
      if (element.nodeName === 'resizableImage' || element.nodeName === 'image') {
        const attrs = element.getAttributes();
        if (attrs.imageId) {
          imageIds.push(attrs.imageId);
        }
      }
      if (element.toArray) {
        for (const child of element.toArray()) {
          traverse(child);
        }
      }
    }
    
    traverse(fragment);
    ydoc.destroy();
    return imageIds;
  } catch (err) {
    console.error('[docHandler] Failed to extract imageIds from yjsState:', err);
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

  async save(docId: string, yjsState: string): Promise<void> {    const { previewState, metadata } = generatePreviewAndMetadata(yjsState);
    
    const updateData: any = {
      yjsState,
      previewState,
      updatedAt: new Date(),
    };
    
    if (metadata.title !== undefined) {
      console.log("metadata.title", metadata.title)
      updateData.title = metadata.title;
    }
    if (metadata.coverImage !== undefined) {
      updateData.coverImage = metadata.coverImage;
    }
    
    await Doc.findByIdAndUpdate(docId, updateData);
  },

  async cleanup(docId: string): Promise<void> {
    const doc = await Doc.findById(docId) as any;
    if (!doc?.yjsState) return;
    
    const currentImageIds = extractImageIdsFromYjsState(doc.yjsState);
    const currentImageIdsSet = new Set(currentImageIds);
    const existingImages = doc?.cloudImages || [];
    
    const orphanedImages = existingImages.filter(
      (img: any) => !currentImageIdsSet.has(img.imageId)
    );
    console.log('orphanedImages', orphanedImages, "length", orphanedImages.length);
    if (orphanedImages.length > 0) {
      const publicIdsToDelete = orphanedImages.map((img: any) => img.cloudPublicId);
      await batchDeleteFromCloud(publicIdsToDelete);
      
      const updatedCloudImages = existingImages.filter(
        (img: any) => currentImageIdsSet.has(img.imageId)
      );
      
      await Doc.findByIdAndUpdate(docId, { cloudImages: updatedCloudImages });
    }
  },
};

export function registerDocHandler() {
  registerDocumentHandler('doc', docHandler);
}

export default docHandler;
