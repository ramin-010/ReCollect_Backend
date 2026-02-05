import { Request, Response, NextFunction } from 'express';
import Drawing from '../models/drawingSchema';
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
        console.error("[drawing] Cloud deletion error:", err);
        reject(err);
      } else {
        console.log("[drawing] Cloud deletion result:", result);
        resolve();
      }
    });
  });
};

const batchDeleteFromCloud = async (publicIds: string[]): Promise<void> => {
  if (publicIds.length === 0) return;
  const deletePromises = publicIds.map(id =>
    deleteFromCloud(id).catch(err => {
      console.error(`[drawing] Failed to delete ${id}:`, err);
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

/**
 * Get all drawings for current user
 */
export const getAllDrawings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    const drawings = await Drawing.find({
      $or: [
        { user: userId },
        { 'collaborators.user': userId }
      ]
    })
      .populate('collaborators.user', 'name email avatar')
      .sort({ updatedAt: -1 })
      .lean();

    // Add role to each drawing
    const drawingsWithRole = drawings.map((drawing: any) => {
      const isOwner = drawing.user?.toString() === userId.toString();
      let role: 'owner' | 'editor' | 'viewer' = 'owner';
      if (!isOwner) {
        const collaborator = drawing.collaborators?.find(
          (c: any) => c.user?._id?.toString() === userId.toString()
        );
        role = collaborator?.role || 'viewer';
      }
      return { ...drawing, role };
    });

    res.status(200).json({
      success: true,
      data: drawingsWithRole,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get single drawing
 */
export const getDrawing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    const drawing = await Drawing.findOne({
      _id: id,
      $or: [
        { user: userId },
        { 'collaborators.user': userId }
      ]
    })
      .populate('user', 'name email')
      .populate('collaborators.user', 'name email avatar')
      .lean();

    if (!drawing) throw new ErrorResponse(404, 'Drawing not found');

    const isOwner = (drawing as any).user?._id?.toString() === userId.toString() ||
                    (drawing as any).user?.toString() === userId.toString();
    let role: 'owner' | 'editor' | 'viewer' = 'owner';
    if (!isOwner) {
      const collaborator = (drawing as any).collaborators?.find(
        (c: any) => c.user?._id?.toString() === userId.toString()
      );
      role = collaborator?.role || 'viewer';
    }

    // Log fetched size for analysis
    const yjsSizeKB = (drawing as any).yjsState 
      ? (Buffer.byteLength((drawing as any).yjsState, 'utf8') / 1024).toFixed(2) 
      : '0';
    console.log(`[Drawing API] GET ${id} | yjsState: ${yjsSizeKB} KB`);

    res.status(200).json({
      success: true,
      data: drawing,
      role,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Create a new drawing
 */
export const createDrawing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    const { name, localId } = req.body;

    const newDrawing = await Drawing.create({
      user: userId,
      name: name || 'Untitled Drawing',
      localId: localId || `drawing_${Date.now()}`,
      yjsState: undefined,
      collaborators: [],
      cloudImages: [],
    });

    res.status(201).json({
      success: true,
      data: newDrawing.toObject(),
      message: 'Drawing created successfully',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Save drawing yjsState with image handling
 */
export const saveDrawing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    const drawing = await Drawing.findOne({
      _id: id,
      $or: [
        { user: userId },
        { 'collaborators.user': userId }
      ]
    });

    if (!drawing) throw new ErrorResponse(404, 'Drawing not found');

    const isOwner = drawing.user.toString() === userId.toString();
    const collaborator = drawing.collaborators?.find(
      (c) => c.user.toString() === userId.toString()
    );

    // Viewers cannot save
    if (!isOwner && collaborator?.role === 'viewer') {
      throw new ErrorResponse(403, 'Viewers cannot edit this drawing');
    }

    let { yjsState, name, thumbnail, imageFileIds, allImageIds } = req.body;
    
    // Parse JSON fields
    imageFileIds = parseJson<string[]>(imageFileIds, []);
    allImageIds = parseJson<string[]>(allImageIds, []);

    // Log incoming size
    const incomingYjsSizeKB = yjsState ? (Buffer.byteLength(yjsState, 'utf8') / 1024).toFixed(2) : '0';
    console.log(`[Drawing API] SAVE ${id} | START | yjsState: ${incomingYjsSizeKB} KB | images: ${imageFileIds.length} new, ${allImageIds.length} total`);

    // Process uploaded images from Upfly
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const newCloudImages: { imageId: string; cloudUrl: string; cloudPublicId: string }[] = [];
    const imageUrlMap: Record<string, { url: string; publicId: string }> = {};

    if (files && imageFileIds.length > 0) {
      for (const imageId of imageFileIds) {
        const fieldName = `image_${imageId}`;
        const fileArray = files[fieldName];
        if (fileArray && fileArray.length > 0) {
          const file = fileArray[0] as CloudFileOutput;
          if (file.cloudUrl && file.cloudPublicId) {
            imageUrlMap[imageId] = {
              url: file.cloudUrl,
              publicId: file.cloudPublicId,
            };
            // console.log(`[Drawing API] Uploaded image ${imageId} -> ${file.cloudUrl}`);
            
            // Track new cloud images
            newCloudImages.push({
              imageId,
              cloudUrl: file.cloudUrl,
              cloudPublicId: file.cloudPublicId,
            });
          }
        }
      }
      
      // Note: We do NOT modify the binary yjsState here to replace URLs.
      // Instead, we store the mapping in `cloudImages` and the frontend
      // hydrates the file URLs from `cloudImages` on load.
      // This avoids risking corruption of the binary Yjs update blob.
    }

    // Cleanup orphaned images (images that were removed from the drawing)
    const newImageIdsSet = new Set(allImageIds);
    const existingCloudImages = drawing.cloudImages || [];
    const imagesToDelete: typeof existingCloudImages = [];
    const imagesToRetain: typeof existingCloudImages = [];

    for (const img of existingCloudImages) {
      if (newImageIdsSet.has(img.imageId)) {
        imagesToRetain.push(img);
      } else {
        imagesToDelete.push(img);
      }
    }
    // Log cleanup details
    console.log(`[Drawing API] SAVE ${id} | CLEANUP | existing: ${existingCloudImages.length}, retain: ${imagesToRetain.length}, delete: ${imagesToDelete.length}, new: ${newCloudImages.length}`);
    
    if (imagesToDelete.length > 0) {
      const publicIds = imagesToDelete.map(img => img.cloudPublicId);
      console.log(`[Drawing API] SAVE ${id} | DELETING orphaned images:`, publicIds);
      await batchDeleteFromCloud(publicIds);
      console.log(`[Drawing API] SAVE ${id} | Deleted ${publicIds.length} orphaned images`);
    }

    const finalCloudImages = [...imagesToRetain, ...newCloudImages];

    // Build update data
    const updateData: any = {
      updatedAt: new Date(),
      cloudImages: finalCloudImages,
    };
    if (yjsState !== undefined) updateData.yjsState = yjsState;
    if (name !== undefined) updateData.name = name;
    if (thumbnail !== undefined) updateData.thumbnail = thumbnail;
    
    // Log final size before DB save
    const finalYjsSizeKB = yjsState ? (Buffer.byteLength(yjsState, 'utf8') / 1024).toFixed(2) : '0';
    console.log(`[Drawing API] SAVE ${id} | DB_WRITE | yjsState: ${finalYjsSizeKB} KB | cloudImages: ${finalCloudImages.length}`);

    const updatedDrawing = await Drawing.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).lean();

    if (!updatedDrawing) throw new ErrorResponse(404, 'Drawing not found');

    console.log(`[Drawing API] SAVE ${id} | Success | cloudImages: ${finalCloudImages.length}`);

    res.status(200).json({
      success: true,
      data: updatedDrawing,
      imageUrlMap, // Return URL map so frontend can update local state
      message: 'Drawing saved successfully',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Update drawing metadata (name, etc)
 */
export const updateDrawing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    const drawing = await Drawing.findOne({
      _id: id,
      user: userId, // Only owner can update metadata
    });

    if (!drawing) throw new ErrorResponse(404, 'Drawing not found or not authorized');

    const { name } = req.body;

    const updateData: any = { updatedAt: new Date() };
    if (name !== undefined) updateData.name = name;

    const updatedDrawing = await Drawing.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    ).lean();

    res.status(200).json({
      success: true,
      data: updatedDrawing,
      message: 'Drawing updated successfully',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Delete drawing with image cleanup
 */
export const deleteDrawing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    console.log(`[Drawing API] DELETE ${id} | START | user: ${userId}`);

    const drawing = await Drawing.findOne({
      _id: id,
      user: userId, // Only owner can delete
    });

    if (!drawing) {
      console.log(`[Drawing API] DELETE ${id} | NOT FOUND or not authorized`);
      throw new ErrorResponse(404, 'Drawing not found or not authorized');
    }

    console.log(`[Drawing API] DELETE ${id} | Found drawing: "${drawing.name}" | cloudImages: ${drawing.cloudImages?.length || 0}`);

    // Cleanup all cloud images
    if (drawing.cloudImages && drawing.cloudImages.length > 0) {
      const publicIds = drawing.cloudImages.map(img => img.cloudPublicId);
      console.log(`[Drawing API] DELETE ${id} | CLEANUP | Deleting ${publicIds.length} cloud images:`, publicIds);
      await batchDeleteFromCloud(publicIds);
      console.log(`[Drawing API] DELETE ${id} | CLEANUP | Deleted ${publicIds.length} cloud images`);
    } else {
      console.log(`[Drawing API] DELETE ${id} | CLEANUP | No cloud images to delete`);
    }

    await Drawing.findByIdAndDelete(id);
    console.log(`[Drawing API] DELETE ${id} | COMPLETE | Removed from database`);

    res.status(200).json({
      success: true,
      message: 'Drawing deleted successfully',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Generate a unique share token
 */
function generateShareToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 16; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

/**
 * Enable sharing and generate share token (owner only)
 */
export const enableShare = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    console.log(`[Drawing API] ENABLE_SHARE ${id} | user: ${userId}`);

    const drawing = await Drawing.findOne({
      _id: id,
      user: userId, // Only owner can enable sharing
    });

    if (!drawing) throw new ErrorResponse(404, 'Drawing not found or not authorized');

    // Generate new token if not exists or if sharing was disabled
    let shareToken = drawing.shareToken;
    if (!shareToken) {
      shareToken = generateShareToken();
    }

    await Drawing.findByIdAndUpdate(id, {
      shareToken,
      shareEnabled: true,
    });

    console.log(`[Drawing API] ENABLE_SHARE ${id} | token: ${shareToken}`);

    res.status(200).json({
      success: true,
      shareToken,
      shareEnabled: true,
      message: 'Sharing enabled',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Disable sharing (owner only)
 */
export const disableShare = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    console.log(`[Drawing API] DISABLE_SHARE ${id} | user: ${userId}`);

    const drawing = await Drawing.findOne({
      _id: id,
      user: userId, // Only owner can disable sharing
    });

    if (!drawing) throw new ErrorResponse(404, 'Drawing not found or not authorized');

    await Drawing.findByIdAndUpdate(id, {
      shareEnabled: false,
      // Keep the token so URL stays the same if re-enabled
    });

    console.log(`[Drawing API] DISABLE_SHARE ${id} | Success`);

    res.status(200).json({
      success: true,
      shareEnabled: false,
      message: 'Sharing disabled',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get drawing by share token (public, no auth required)
 */
export const getSharedDrawing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  console.log('[Drawing API] GET_SHARED ROUTE HIT - this should appear if route works');
  try {
    const { token } = req.params;
    
    console.log(`[Drawing API] GET_SHARED | token: ${token}`);

    const drawing = await Drawing.findOne({
      shareToken: token,
      shareEnabled: true,
    })
      .populate('user', 'name email avatar')
      .lean();

    if (!drawing) {
      console.log(`[Drawing API] GET_SHARED | token: ${token} | NOT FOUND or sharing disabled`);
      throw new ErrorResponse(404, 'Drawing not found or sharing is disabled');
    }

    // Log size for analysis
    const yjsSizeKB = (drawing as any).yjsState 
      ? (Buffer.byteLength((drawing as any).yjsState, 'utf8') / 1024).toFixed(2) 
      : '0';
    console.log(`[Drawing API] GET_SHARED | token: ${token} | yjsState: ${yjsSizeKB} KB | name: "${drawing.name}"`);

    // Return drawing data (no cloudImages in response for guests)
    res.status(200).json({
      success: true,
      data: {
        _id: drawing._id,
        name: drawing.name,
        yjsState: drawing.yjsState,
        owner: (drawing as any).user,
        cloudImages: drawing.cloudImages, // Guests need this to render images
      },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Get share status for a drawing (owner only)
 */
export const getShareStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?._id;
    if (!userId) throw new ErrorResponse(401, 'Unauthorized');

    const drawing = await Drawing.findOne({
      _id: id,
      user: userId,
    }).select('shareToken shareEnabled').lean();

    if (!drawing) throw new ErrorResponse(404, 'Drawing not found or not authorized');

    res.status(200).json({
      success: true,
      shareToken: drawing.shareEnabled ? drawing.shareToken : null,
      shareEnabled: drawing.shareEnabled,
    });
  } catch (err) {
    next(err);
  }
};
