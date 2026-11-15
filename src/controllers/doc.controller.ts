// Doc endpoints (Postgres). DB access: src/services/docs/docs.service.ts; permission rules:
// src/services/docs/docPermissions.ts; editor JSON → Yjs: src/services/docs/docContent.ts.
// Routes, status codes, messages and JSON shapes are the same as the Mongo version.
import { Request, Response, NextFunction } from 'express';
import ErrorResponse from '../utils/errorResponse';
import { requireUser } from '../middlwares/auth';
import { serializeDoc, serializeDocListItem, serializeDocWithUsers } from '../db/serializers/doc';
import { readOptionalBoolean, readOptionalString } from '../utils/requestFields';
import {
  createDoc as createDocInDb,
  deleteOrLeaveDoc,
  findAccessibleDocWithUsers,
  listAccessibleDocs,
  updateDocMeta,
} from '../services/docs/docs.service';

/** A route parameter (Express always sets the ones in the path; this only satisfies the types). */
function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value) throw new ErrorResponse(404, 'Doc not found');
  return value;
}

export const createDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const body = req.body ?? {};

    const newDoc = await createDocInDb(user.id, {
      title: readOptionalString(body.title, 'title'),
      content: body.content,
    });

    res.status(201).json({
      success: true,
      data: serializeDoc(newDoc),
      message: 'Doc created successfully',
    });
  } catch (err) {
    next(err);
  }
};

export const getAllDocs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const docs = await listAccessibleDocs(user.id);

    res.status(200).json({
      success: true,
      data: docs.map(({ doc, role }) => serializeDocListItem(doc, role)),
    });
  } catch (err) {
    next(err);
  }
};

export const getDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const found = await findAccessibleDocWithUsers(routeParam(req, 'id'), user.id);
    if (!found) throw new ErrorResponse(404, 'Doc not found');

    res.status(200).json({
      success: true,
      data: serializeDocWithUsers(found.doc),
      // The Mongo handler always said 'viewer' for collaborators here (it compared a populated
      // user object with an id); this is the real role.
      role: found.role,
    });
  } catch (err) {
    next(err);
  }
};

export const updateDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const body = req.body ?? {};

    const updatedDoc = await updateDocMeta(routeParam(req, 'id'), user.id, {
      title: readOptionalString(body.title, 'title'),
      isPinned: readOptionalBoolean(body.isPinned, 'isPinned'),
      isArchived: readOptionalBoolean(body.isArchived, 'isArchived'),
      coverImage: readOptionalString(body.coverImage, 'coverImage'),
    });

    res.status(200).json({
      success: true,
      data: serializeDoc(updatedDoc),
      message: 'Doc updated successfully',
    });
  } catch (err) {
    next(err);
  }
};

export const deleteDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const outcome = await deleteOrLeaveDoc(routeParam(req, 'id'), user.id);

    res.status(200).json({
      success: true,
      message: outcome === 'deleted' ? 'Doc deleted successfully' : 'Removed from your library',
    });
  } catch (err) {
    next(err);
  }
};
