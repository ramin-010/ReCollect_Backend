// Drawing endpoints (Postgres). DB access: src/services/drawings/drawings.service.ts; permission
// rules: src/services/drawings/drawingPermissions.ts. Routes, status codes, messages and JSON
// shapes are the same as the Mongo version.
import { Request, Response, NextFunction } from 'express';
import ErrorResponse from '../utils/errorResponse';
import { requireUser } from '../middlwares/auth';
import { serializeDrawing, serializeDrawingWithUsers, serializeSharedDrawing } from '../db/serializers/drawing';
import { readOptionalString, readStringList } from '../utils/requestFields';
import type { UploadedFiles } from '../services/uploads/cloudImages';
import {
  createDrawing as createDrawingInDb,
  deleteOwnedDrawing,
  disableDrawingShare,
  enableDrawingShare,
  findAccessibleDrawingWithUsers,
  findSharedDrawing,
  getDrawingShareStatus,
  listAccessibleDrawings,
  saveDrawingFromEditor,
  updateDrawingMeta,
} from '../services/drawings/drawings.service';

function routeParam(req: Request, name: string, notFoundMessage = 'Drawing not found'): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new ErrorResponse(404, notFoundMessage);
  return value;
}

function sizeKB(value: string | null | undefined): string {
  return value ? (Buffer.byteLength(value, 'utf8') / 1024).toFixed(2) : '0';
}

/**
 * Get all drawings for current user
 */
export const getAllDrawings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const drawings = await listAccessibleDrawings(user.id);

    res.status(200).json({
      success: true,
      data: drawings.map(({ drawing, role }) => ({ ...serializeDrawingWithUsers(drawing), role })),
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
    const user = requireUser(req);
    const id = routeParam(req, 'id');
    const found = await findAccessibleDrawingWithUsers(id, user.id);
    if (!found) throw new ErrorResponse(404, 'Drawing not found');

    console.log(`[Drawing API] GET ${id} | yjsState: ${sizeKB(found.drawing.yjsState)} KB`);

    res.status(200).json({
      success: true,
      data: serializeDrawingWithUsers(found.drawing),
      role: found.role,
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
    const user = requireUser(req);
    const body = req.body ?? {};

    const newDrawing = await createDrawingInDb(user.id, {
      name: readOptionalString(body.name, 'name'),
      localId: readOptionalString(body.localId, 'localId'),
    });

    res.status(201).json({
      success: true,
      data: serializeDrawing(newDrawing),
      message: 'Drawing created successfully',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * Save drawing yjsState with image handling (JSON body, or multipart with `image_<fileId>` files)
 */
export const saveDrawing = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const id = routeParam(req, 'id');
    const body = req.body ?? {};

    const yjsState = readOptionalString(body.yjsState, 'yjsState');
    const imageFileIds = readStringList(body.imageFileIds);
    const allImageIds = readStringList(body.allImageIds);
    console.log(
      `[Drawing API] SAVE ${id} | START | yjsState: ${sizeKB(yjsState)} KB | images: ${imageFileIds.length} new, ${allImageIds.length} total`
    );

    const { drawing, imageUrlMap } = await saveDrawingFromEditor(id, user.id, {
      yjsState,
      name: readOptionalString(body.name, 'name'),
      thumbnail: readOptionalString(body.thumbnail, 'thumbnail'),
      imageFileIds,
      allImageIds,
      files: req.files as unknown as UploadedFiles | undefined,
    });

    console.log(`[Drawing API] SAVE ${id} | Success | cloudImages: ${Array.isArray(drawing.cloudImages) ? drawing.cloudImages.length : 0}`);

    res.status(200).json({
      success: true,
      data: serializeDrawing(drawing),
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
    const user = requireUser(req);
    const updatedDrawing = await updateDrawingMeta(
      routeParam(req, 'id', 'Drawing not found or not authorized'),
      user.id,
      { name: readOptionalString(req.body?.name, 'name') }
    );

    res.status(200).json({
      success: true,
      data: serializeDrawing(updatedDrawing),
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
    const user = requireUser(req);
    const id = routeParam(req, 'id', 'Drawing not found or not authorized');
    await deleteOwnedDrawing(id, user.id);
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
 * Enable sharing and generate share token (owner only)
 */
export const enableShare = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const shareToken = await enableDrawingShare(routeParam(req, 'id', 'Drawing not found or not authorized'), user.id);

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
    const user = requireUser(req);
    await disableDrawingShare(routeParam(req, 'id', 'Drawing not found or not authorized'), user.id);

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
  try {
    const token = routeParam(req, 'token', 'Drawing not found or sharing is disabled');
    const drawing = await findSharedDrawing(token);

    if (!drawing) {
      throw new ErrorResponse(404, 'Drawing not found or sharing is disabled');
    }

    console.log(`[Drawing API] GET_SHARED | yjsState: ${sizeKB(drawing.yjsState)} KB | name: "${drawing.name}"`);

    res.status(200).json({
      success: true,
      data: serializeSharedDrawing(drawing),
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
    const user = requireUser(req);
    const status = await getDrawingShareStatus(routeParam(req, 'id', 'Drawing not found or not authorized'), user.id);

    res.status(200).json({
      success: true,
      shareToken: status.shareToken,
      shareEnabled: status.shareEnabled,
    });
  } catch (err) {
    next(err);
  }
};
