// Doc endpoints (Postgres). DB access: src/services/docs/docs.service.ts; permission rules:
// src/services/docs/docPermissions.ts; editor JSON → Yjs: src/services/docs/docContent.ts.
// Routes, status codes, messages and JSON shapes are the same as the Mongo version.
import { Request, Response, NextFunction } from 'express';
import ErrorResponse from '../utils/errorResponse';
import { requireUser } from '../middlwares/auth';
import { disconnectUser } from '../collaboration/hocuspocus';
import { serializeDoc, serializeDocListItem, serializeDocWithUsers, serializeSharedByMeDoc } from '../db/serializers/doc';
import { parseJsonField, readOptionalBoolean, readOptionalString, readStringList } from '../utils/requestFields';
import type { UploadedFiles } from '../services/uploads/cloudImages';
import {
  createDoc as createDocInDb,
  deleteOrLeaveDoc,
  findAccessibleDocWithUsers,
  listAccessibleDocs,
  listDocsSharedBy,
  removeDocCollaborator,
  saveDocFromEditor,
  setDocCollaboratorRole,
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
      docType: readOptionalString(body.docType, 'docType'),
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
      docType: readOptionalString(body.docType, 'docType'),
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

/** POST /api/docs/:id — JSON body, or multipart (upfly) when it carries images as `image_<imageId>`. */
export const saveDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const body = req.body ?? {};

    const { doc, created } = await saveDocFromEditor(routeParam(req, 'id'), user.id, {
      title: readOptionalString(body.title, 'title'),
      coverImage: readOptionalString(body.coverImage, 'coverImage'),
      docType: readOptionalString(body.docType, 'docType'),
      content: parseJsonField<unknown>(body.content, null),
      imageNodeIds: readStringList(body.imageNodeIds),
      allImageIds: readStringList(body.allImageIds),
      files: req.files as unknown as UploadedFiles | undefined,
    });

    res.status(created ? 201 : 200).json({
      success: true,
      data: serializeDoc(doc),
      message: created ? 'Doc created successfully' : 'Doc updated successfully',
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

export const getSharedByMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const docs = await listDocsSharedBy(user.id);

    res.status(200).json({
      success: true,
      data: docs.map(serializeSharedByMeDoc),
    });
  } catch (err) {
    next(err);
  }
};

export const updateCollaboratorRole = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const role: unknown = req.body?.role;
    if (role !== 'editor' && role !== 'viewer') {
      throw new ErrorResponse(400, "Invalid role. Must be 'editor' or 'viewer'");
    }

    await setDocCollaboratorRole(routeParam(req, 'id'), user.id, routeParam(req, 'collaboratorId'), role);

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
    const user = requireUser(req);
    const id = routeParam(req, 'id');
    const collaboratorId = routeParam(req, 'collaboratorId');

    const { remainingCount, isLeavingVoluntarily } = await removeDocCollaborator(id, user.id, collaboratorId);

    // Kick the removed user's live connections and tell the others (Hocuspocus stateless message).
    disconnectUser(id, collaboratorId, remainingCount, isLeavingVoluntarily, user.id);

    res.status(200).json({
      success: true,
      message: 'Collaborator removed',
      remainingCount,
    });
  } catch (err) {
    next(err);
  }
};
