import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import DocModel, { IDoc } from '../models/docSchema';
import ErrorResponse from '../utils/errorResponse';
import cloudinary from '../utils/cloudinary';

interface CloudFileOutput extends Express.Multer.File {
  cloudUrl: string;
  cloudProvider: string;
  cloudPublicId: string;
}

// Helper: Delete from Cloudinary
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

// Helper: Parse JSON safely
const parseJson = <T>(data: any, fallback: T): T => {
  try {
    if (typeof data === "object" && data !== null) return data as T;
    if (typeof data === "string") return JSON.parse(data) as T;
    return fallback;
  } catch {
    return fallback;
  }
};

// ============================================================
// CREATE NEW DOC
// ============================================================
export const createDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, "Unauthorized");

    const { title } = req.body;

    const newDoc = await DocModel.create({
      user: userId,
      title: title || 'Untitled',
      content: { type: 'doc', content: [] },
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

// ============================================================
// GET ALL DOCS
// ============================================================
export const getAllDocs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, "Unauthorized");

    const docs = await DocModel.find({ user: userId })
      .select('title content isPinned isArchived coverImage createdAt updatedAt')
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

// ============================================================
// GET SINGLE DOC
// ============================================================
export const getDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, "Unauthorized");
  
    const doc = await DocModel.findOne({ _id: id, user: userId }).lean();

    if (!doc) throw new ErrorResponse(404, "Doc not found");

    res.status(200).json({
      success: true,
      data: doc,
    });
  } catch (err) {
    next(err);
  }
};

// ============================================================
// SAVE/UPDATE DOC
// ============================================================
export const saveDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, "Unauthorized");

    const { title, coverImage, imageNodeIds } = req.body;
    let content = parseJson(req.body.content, { type: 'doc', content: [] });
    const parsedImageNodeIds = parseJson<string[]>(imageNodeIds, []);

    const files = req.files as Record<string, Express.Multer.File[]>;

    // Build map of newly uploaded images
    const newCloudImages: { nodeId: string; cloudUrl: string; cloudPublicId: string }[] = [];
    const nodeIdToUrl: Record<string, string> = {};

    for (const nodeId of parsedImageNodeIds) {
      const fieldname = `image_${nodeId}`;
      const fileArray = files?.[fieldname];
      if (fileArray && fileArray.length > 0) {
        const file = fileArray[0] as CloudFileOutput;
        nodeIdToUrl[nodeId] = file.cloudUrl;
        newCloudImages.push({
          nodeId,
          cloudUrl: file.cloudUrl,
          cloudPublicId: file.cloudPublicId,
        });
      }
    }

    // Replace PENDING_UPLOAD placeholders with actual cloud URLs
    const replaceUrlsInContent = (node: any) => {
      if (node.type === 'image' && node.attrs?.src?.startsWith('PENDING_UPLOAD:')) {
        const nodeId = node.attrs.src.replace('PENDING_UPLOAD:', '');
        if (nodeIdToUrl[nodeId]) {
          node.attrs.src = nodeIdToUrl[nodeId];
        }
      }
      if (node.content && Array.isArray(node.content)) {
        node.content.forEach(replaceUrlsInContent);
      }
    };
    replaceUrlsInContent(content);

    // Check if doc exists
    const existingDoc = await DocModel.findOne({ _id: id, user: userId });

    if (existingDoc) {
      // UPDATE existing doc
      
      // Find images that were removed (compare old cloudImages with current content)
      const currentImageUrls = new Set<string>();
      const extractImageUrls = (node: any) => {
        if (node.type === 'image' && node.attrs?.src && !node.attrs.src.startsWith('data:')) {
          currentImageUrls.add(node.attrs.src);
        }
        if (node.content && Array.isArray(node.content)) {
          node.content.forEach(extractImageUrls);
        }
      };
      extractImageUrls(content);

      // Find removed images to delete from cloud
      const removedImages = (existingDoc.cloudImages || []).filter(
        img => !currentImageUrls.has(img.cloudUrl)
      );

      if (removedImages.length > 0) {
        console.log(`[doc] Deleting ${removedImages.length} removed images from cloud`);
        await batchDeleteFromCloud(removedImages.map(img => img.cloudPublicId));
      }

      // Merge cloudImages: keep existing (that are still in content) + add new
      const keptImages = (existingDoc.cloudImages || []).filter(
        img => currentImageUrls.has(img.cloudUrl)
      );
      const mergedCloudImages = [...keptImages, ...newCloudImages];

      const updatedDoc = await DocModel.findByIdAndUpdate(
        id,
        {
          title: title || existingDoc.title,
          content,
          coverImage: coverImage !== undefined ? coverImage : existingDoc.coverImage,
          cloudImages: mergedCloudImages,
          updatedAt: new Date(),
        },
        { new: true }
      ).lean();

      res.status(200).json({
        success: true,
        data: updatedDoc,
        message: 'Doc updated successfully',
      });
    } else {
      // CREATE new doc
      const newDoc = await DocModel.create({
        _id: id,
        user: userId,
        title: title || 'Untitled',
        content,
        coverImage: coverImage || null,
        cloudImages: newCloudImages,
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

// ============================================================
// DELETE DOC
// ============================================================
export const deleteDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;

    if (!userId) throw new ErrorResponse(401, "Unauthorized");
    // (!mongoose.Types.ObjectId.isValid(id)) throw new ErrorResponse(400, "Invalid doc ID");

    const doc = await DocModel.findOne({ _id: id, user: userId });

    if (!doc) throw new ErrorResponse(404, "Doc not found");

    // Delete all cloud images
    if (doc.cloudImages && doc.cloudImages.length > 0) {
      console.log(`[doc] Deleting ${doc.cloudImages.length} images from cloud`);
      await batchDeleteFromCloud(doc.cloudImages.map(img => img.cloudPublicId));
    }

    await DocModel.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: 'Doc deleted successfully',
    });
  } catch (err) {
    next(err);
  }
};
