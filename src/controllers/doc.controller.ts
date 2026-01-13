import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import DocModel, { IDoc } from '../models/docSchema';
import ErrorResponse from '../utils/errorResponse';
import cloudinary from '../utils/cloudinary';
import { generatePreviewState } from '../utils/previewUtils';
import { disconnectUser } from '../collaboration/hocuspocus';

interface CloudFileOutput extends Express.Multer.File {
  cloudUrl: string;
  cloudProvider: string;
  cloudPublicId: string;
}

const deleteFromCloud = async (publicId: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.destroy(publicId, { invalidate: true }, (err: any, result: any) => {
      if (err) {
        console.error("[doc] Cloud deletion error:", err);
        reject(err);
      } else {
        console.log("[doc] Cloud deletion result:", result);
        resolve();
      }
    });
  });
};

const batchDeleteFromCloud = async (publicIds: string[]): Promise<void> => {
  if (publicIds.length === 0) return;
  const deletePromises = publicIds.map(id =>
    deleteFromCloud(id).catch(err => {
      console.error(`[doc] Failed to delete ${id}:`, err);
    })
  );
  await Promise.allSettled(deletePromises);
};

const parseJson = <T>(data: any, fallback: T): T => {
  try {
    if (typeof data === "object" && data !== null) return data as T;
    if (typeof data === "string") return JSON.parse(data) as T;
    return fallback;
  } catch {
    return fallback;
  }
};

export const createDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, "Unauthorized");

    const { title, docType } = req.body;

    const newDoc = await DocModel.create({
      user: userId,
      title: title || 'Untitled',
      content: { type: 'doc', content: [] },
      docType: docType || 'notes',
      cloudImages: [],
    });

    res.status(201).json({
      success: true,
      data: newDoc.toObject(),
      message: 'Doc created successfully',
    });
  } catch (err) {
    next(err);
  }
};

export const getAllDocs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, "Unauthorized");

    const docs = await DocModel.find({
      $or: [
        { user: userId },
        { 'collaborators.user': userId }
      ]
    })
      .select('title previewState docType isPinned isArchived coverImage createdAt updatedAt user collaborators')
      .populate('user', 'name email')
      .populate('collaborators.user', 'name email avatar')
      .sort({ updatedAt: -1 })
      .lean();

    const docsWithRole = docs.map((doc: any) => {
      const isOwner = doc.user?._id?.toString() === userId.toString() || 
                      doc.user?.toString() === userId.toString();
      
      let role: 'owner' | 'editor' | 'viewer' = 'owner';
      if (!isOwner) {
        const collaborator = doc.collaborators?.find(
          (c: any) => c.user?._id?.toString() === userId.toString() || 
            c.user?.toString() === userId.toString()
        );
        role = collaborator?.role || 'viewer';
      }
      
      return { ...doc, role };
    });

    res.status(200).json({
      success: true,
      data: docsWithRole,
    });
  } catch (err) {
    next(err);
  }
};

export const getDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, "Unauthorized");
  
    const doc = await DocModel.findOne({ 
      _id: id, 
      $or: [
        { user: userId },
        { 'collaborators.user': userId }
      ]
    }).populate('user', 'name email').populate('collaborators.user', 'name email avatar').lean();

    if (!doc) throw new ErrorResponse(404, "Doc not found");

    const isOwner = doc.user && (
      typeof doc.user === 'object' && '_id' in doc.user 
        ? doc.user._id.toString() === userId.toString()
        : doc.user === userId
    );
    
    let role: 'owner' | 'editor' | 'viewer' = 'owner';
    if (!isOwner) {
      const collaborator = doc.collaborators?.find(
        (c) => c.user.toString() === userId.toString()
      );
      role = collaborator?.role || 'viewer';
    }

    res.status(200).json({
      success: true,
      data: doc,
      role,
    });
  } catch (err) {
    next(err);
  }
};

export const updateDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, "Unauthorized");

    const doc = await DocModel.findOne({
      _id: id,
      $or: [
        { user: userId },
        { 'collaborators.user': userId }
      ]
    });

    if (!doc) throw new ErrorResponse(404, "Doc not found");

    const isOwner = doc.user.toString() === userId.toString();
    const collaborator = doc.collaborators?.find(
      (c) => c.user.toString() === userId.toString()
    );
    
    if (!isOwner) {
      if (req.body.title !== undefined || req.body.docType !== undefined || req.body.isPinned !== undefined || req.body.isArchived !== undefined) {
        throw new ErrorResponse(403, "Only the owner can rename, change type, or pin this document"); 
      }
    }

    const { docType, isPinned, isArchived, title, coverImage } = req.body;
    console.log("body :", req.body);
    const updateData: any = {};
    if (docType !== undefined) updateData.docType = docType;
    if (isPinned !== undefined) updateData.isPinned = isPinned;
    if (isArchived !== undefined) updateData.isArchived = isArchived;
    if (title !== undefined) updateData.title = title;
    if (coverImage !== undefined) updateData.coverImage = coverImage;
    updateData.updatedAt = new Date();

    const updatedDoc = await DocModel.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).lean();

    if (!updatedDoc) throw new ErrorResponse(404, "Doc not found");

    res.status(200).json({
      success: true,
      data: updatedDoc,
      message: 'Doc updated successfully',
    });
  } catch (err) {
    next(err);
  }
};

export const saveDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, "Unauthorized");

    const doc = await DocModel.findOne({
      _id: id,
      $or: [
        { user: userId },
        { 'collaborators.user': userId }
      ]
    });

    if (doc) {
      const isOwner = doc.user.toString() === userId.toString();
      const collaborator = doc.collaborators?.find(
        (c) => c.user.toString() === userId.toString()
      );
      
      if (!isOwner && collaborator?.role === 'viewer') {
        throw new ErrorResponse(403, "Viewers cannot edit this document");
      }
    }

    let { title, coverImage, docType, content, imageNodeIds, allImageIds } = req.body;
    
    content = parseJson<any>(content, null);
    imageNodeIds = parseJson<string[]>(imageNodeIds, []);
    allImageIds = parseJson<string[]>(allImageIds, []);
    
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const newCloudImages: { imageId: string; cloudUrl: string; cloudPublicId: string }[] = [];
    
    if (files && imageNodeIds.length > 0 && content) {
      const imageUrlMap: Record<string, { url: string; publicId: string }> = {};
      
      for (const imageId of imageNodeIds) {
        const fieldName = `image_${imageId}`;
        const fileArray = files[fieldName];
        if (fileArray && fileArray.length > 0) {
          const file = fileArray[0] as CloudFileOutput;
          if (file.cloudUrl && file.cloudPublicId) {
            imageUrlMap[imageId] = {
              url: file.cloudUrl,
              publicId: file.cloudPublicId,
            };
          }
        }
      }
      
      const replaceImageUrls = (node: any): void => {
        if ((node.type === 'resizableImage' || node.type === 'image') && node.attrs?.imageId) {
          const imageData = imageUrlMap[node.attrs.imageId];
          if (imageData) {
            node.attrs.src = imageData.url;
          }
        }
        if (node.content && Array.isArray(node.content)) {
          node.content.forEach(replaceImageUrls);
        }
      };
      
      replaceImageUrls(content);
      
      for (const [imageId, data] of Object.entries(imageUrlMap)) {
        newCloudImages.push({
          imageId,
          cloudUrl: data.url,
          cloudPublicId: data.publicId,
        });
      }
    }
    
    let yjsState: string | null = null;
    if (content) {
      const Y = require('yjs');
      const { prosemirrorJSONToYDoc } = require('y-prosemirror');
      const { getSchema } = require('@tiptap/core');
      const StarterKit = require('@tiptap/starter-kit').default;
      const Image = require('@tiptap/extension-image').default;
      
      const ExtendedImage = Image.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            width: { default: '100%' },
            height: { default: 'auto' },
            imageId: { default: null },
            cloudPublicId: { default: null },
            cloudProvider: { default: null },
          };
        },
      });
      
      const extensions = [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        ExtendedImage,
      ];
      
      const schema = getSchema(extensions);
      const ydoc = prosemirrorJSONToYDoc(schema, content, 'default');
      const state = Y.encodeStateAsUpdate(ydoc);
      yjsState = Buffer.from(state).toString('base64');
      ydoc.destroy();
    }
    
    const newImageIdsSet = new Set(allImageIds);
    const existingCloudImages = doc?.cloudImages || [];
    const imagesToDelete: typeof existingCloudImages = [];
    const imagesToRetain: typeof existingCloudImages = [];
    
    for (const img of existingCloudImages) {
      if (newImageIdsSet.has(img.imageId)) {
        imagesToRetain.push(img);
      } else {
        imagesToDelete.push(img);
      }
    }
    
    if (imagesToDelete.length > 0) {
      const publicIds = imagesToDelete.map(img => img.cloudPublicId);
      if (publicIds.length > 0) {
        await batchDeleteFromCloud(publicIds);
      }
    }
    
    const finalCloudImages = [...imagesToRetain, ...newCloudImages];
    const previewState = yjsState ? generatePreviewState(yjsState) : null;
    
    if (doc) {
      const isOwner = doc.user.toString() === userId.toString();
      
      const updateData: any = {
        yjsState: yjsState || doc.yjsState,
        previewState: previewState || doc.previewState,
        title: isOwner ? (title || doc.title) : doc.title,
        docType: isOwner ? (docType !== undefined ? docType : doc.docType) : doc.docType,
        coverImage: coverImage !== undefined ? coverImage : doc.coverImage,
        cloudImages: finalCloudImages,
        updatedAt: new Date(),
      };

      const updatedDoc = await DocModel.findByIdAndUpdate(id, updateData, { new: true }).lean();

      res.status(200).json({
        success: true,
        data: updatedDoc,
        message: 'Doc updated successfully',
      });
    } else {
      const newDoc = await DocModel.create({
        _id: id,
        user: userId,
        title: title || 'Untitled',
        yjsState: yjsState,
        previewState: previewState,
        coverImage: coverImage || null,
        cloudImages: finalCloudImages,
      });

      res.status(201).json({
        success: true,
        data: newDoc.toObject(),
        message: 'Doc created successfully',
      });
    }
  } catch (err) {
    next(err);
  }
};

export const deleteDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, "Unauthorized");
    
    const doc = await DocModel.findOne({ 
      _id: id, 
      $or: [
        { user: userId },
        { 'collaborators.user': userId }
      ]
    });

    if (!doc) throw new ErrorResponse(404, "Doc not found");

    const isOwner = doc.user.toString() === userId.toString();

    if (isOwner) {
      if (doc.cloudImages && doc.cloudImages.length > 0) {
        await batchDeleteFromCloud(doc.cloudImages.map((img) => img.cloudPublicId));
      }
      await DocModel.deleteOne({ _id: id });
      
      res.status(200).json({
        success: true,
        message: 'Doc deleted successfully',
      });
    } else {
      await DocModel.updateOne(
        { _id: id },
        { $pull: { collaborators: { user: userId } } }
      );

      res.status(200).json({
        success: true,
        message: 'Removed from your library',
      });
    }
  } catch (err) {
    next(err);
  }
};

export const getSharedByMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, "Unauthorized");

    const docs = await DocModel.find({
      user: userId,
      'collaborators.0': { $exists: true }
    })
      .select('title docType  createdAt updatedAt collaborators')
      .populate('collaborators.user', 'name email avatar')
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      data: docs,
    });
  } catch (err) {
    next(err);
  }
};

export const updateCollaboratorRole = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id, collaboratorId } = req.params;
    const { role } = req.body;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, "Unauthorized");
    if (!role || !['editor', 'viewer'].includes(role)) {
      throw new ErrorResponse(400, "Invalid role. Must be 'editor' or 'viewer'");
    }

    const doc = await DocModel.findOne({ _id: id, user: userId });
    if (!doc) throw new ErrorResponse(404, "Doc not found or you are not the owner");

    const result = await DocModel.updateOne(
      { _id: id, 'collaborators.user': collaboratorId },
      { $set: { 'collaborators.$.role': role } }
    );

    if (result.modifiedCount === 0) {
      throw new ErrorResponse(404, "Collaborator not found");
    }

    res.status(200).json({
      success: true,
      message: `Collaborator role updated to ${role}`,
    });
  } catch (err) {
    next(err);
  }
};

export const removeCollaborator = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id, collaboratorId } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, "Unauthorized");

        const doc = await DocModel.findOne({
      _id: id,
      $or: [
        { user: userId },         { 'collaborators.user': userId }       ]
    });

    if (!doc) throw new ErrorResponse(404, "Doc not found");

        const isOwner = doc.user.toString() === userId.toString();
    if (!isOwner && collaboratorId !== userId.toString()) {
       throw new ErrorResponse(403, "Only the owner can remove other collaborators");
    }

    const result = await DocModel.updateOne(
      { _id: id },
      { $pull: { collaborators: { user: collaboratorId } } }
    );

    if (result.modifiedCount === 0) {
      throw new ErrorResponse(404, "Collaborator not found");
    }

        const remainingCount = (doc.collaborators?.length || 1) - 1;

        const isLeavingVoluntarily = collaboratorId === userId.toString();

        if (!isLeavingVoluntarily) {
      await DocModel.updateOne(
        { _id: id },
        { 
          $addToSet: { 
            bannedUsers: { 
              user: new mongoose.Types.ObjectId(collaboratorId), 
              bannedAt: new Date() 
            } 
          } 
        }
      );
    }

        if (id && collaboratorId) {
      disconnectUser(id, collaboratorId, remainingCount, isLeavingVoluntarily, userId.toString());
    }

    res.status(200).json({
      success: true,
      message: 'Collaborator removed',
      remainingCount,
    });
  } catch (err) {
    next(err);
  }
};
