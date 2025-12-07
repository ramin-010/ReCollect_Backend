import { Request, Response, NextFunction } from "express";
import Drawing from "../models/drawingSchema";
import ErrorResponse from "../utils/errorResponse";

interface CloudFileOutput extends Express.Multer.File {
  cloudUrl: string;
  cloudProvider: string;
  cloudPublicId: string;
}

const ParseJson = <T>(data: any, fallback: T): T => {
  try {
    if (typeof data === "object" && data !== null) return data as T;
    if (typeof data === "string") return JSON.parse(data) as T;
    return fallback;
  } catch (err) {
    return fallback;
  }
};

const MAX_FREE_DRAWINGS = 3;

// Sync a drawing to the cloud
export const syncDrawing = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const userId = req.user?._id;
    const { localId, name } = req.body;
    let data = ParseJson<any>(req.body.data, {});
    const imageFileIds = ParseJson<string[]>(req.body.imageFileIds, []);

    if (!localId || !name) {
      throw new ErrorResponse(400, "localId and name are required");
    }

    // Check if this is a new drawing or an update
    const existingDrawing = await Drawing.findOne({ user: userId, localId });
    
    if (!existingDrawing) {
      // This is a new drawing - check limit
      const currentCount = await Drawing.countDocuments({ user: userId });
      if (currentCount >= MAX_FREE_DRAWINGS) {
        throw new ErrorResponse(403, `Free users can only sync up to ${MAX_FREE_DRAWINGS} drawings. Delete an existing cloud drawing to sync a new one.`);
      }
    }

    // Process uploaded files
    const files = req.files as Record<string, Express.Multer.File[]>;
    
    // Process drawing images
    if (imageFileIds.length > 0 && files && data.files) {
      for (const fileId of imageFileIds) {
        const fieldname = `image_${fileId}`;
        const fileArray = files[fieldname];
        
        if (fileArray && fileArray.length > 0) {
          const uploadedFile = fileArray[0] as CloudFileOutput;
          
          if (data.files[fileId]) {
            data.files[fileId] = {
              ...data.files[fileId],
              dataURL: uploadedFile.cloudUrl,
              cloudPublicId: uploadedFile.cloudPublicId,
              isCloudUploaded: true
            };
          }
        }
      }
    }

    // Process thumbnail
    let thumbnailUrl = req.body.thumbnail || '';
    if (files && files['thumbnail'] && files['thumbnail'].length > 0) {
      const thumbnailFile = files['thumbnail'][0] as CloudFileOutput;
      thumbnailUrl = thumbnailFile.cloudUrl;
    }

    // Upsert: update if exists, create if not
    const drawing = await Drawing.findOneAndUpdate(
      { user: userId, localId },
      { 
        user: userId,
        localId,
        name,
        data: data || {},
        thumbnail: thumbnailUrl
      },
      { 
        new: true, 
        upsert: true,
        setDefaultsOnInsert: true
      }
    );

    res.status(200).json({
      success: true,
      data: {
        _id: drawing._id,
        localId: drawing.localId,
        name: drawing.name,
        thumbnail: drawing.thumbnail,
        updatedAt: drawing.updatedAt
      },
      message: 'Drawing synced to cloud successfully'
    });
  } catch (err: any) {
    // Handle duplicate key error gracefully
    if (err.code === 11000) {
      return res.status(200).json({
        success: true,
        message: 'Drawing already synced'
      });
    }
    next(err);
  }
};

// Get all cloud-synced drawings for the user
export const getCloudDrawings = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const userId = req.user?._id;

    const drawings = await Drawing.find({ user: userId })
      .sort({ updatedAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      data: drawings.map(d => ({
        id: d.localId,
        _id: d._id,
        name: d.name,
        data: d.data,
        thumbnail: d.thumbnail,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        isCloudSynced: true
      }))
    });
  } catch (err: any) {
    next(err);
  }
};

// Delete a cloud-synced drawing
export const deleteCloudDrawing = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const userId = req.user?._id;
    const { localId } = req.params;

    const result = await Drawing.findOneAndDelete({ user: userId, localId });

    if (!result) {
      throw new ErrorResponse(404, "Drawing not found in cloud");
    }

    res.status(200).json({
      success: true,
      message: 'Drawing removed from cloud'
    });
  } catch (err: any) {
    next(err);
  }
};
