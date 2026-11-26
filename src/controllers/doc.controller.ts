// Doc endpoints (Postgres). DB access: src/services/docs/docs.service.ts; permission rules:
// src/services/docs/docPermissions.ts; editor JSON → Yjs: src/services/docs/docContent.ts.
// Routes, status codes, messages and JSON shapes are the same as the Mongo version.
import { pagesOf, trailFor, treeOf } from '../services/docs/docTree.service';
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
      // DOC_PAGES_PLAN: a page inside a doc of theirs.
      parentId: readOptionalString(body.parentId, 'parentId'),
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
    // DOC_PAGES_PLAN §3.3: the trail above it (what they can open) and the pages inside it, in order.
    const [trail, pages] = await Promise.all([trailFor(found.doc.id, user.id), pagesOf(found.doc.id, user.id)]);

    res.status(200).json({
      success: true,
      data: {
        ...serializeDocWithUsers(found.doc),
        trail: trail.map((t) => ({ _id: t.id, title: t.title })),
        pages: pages.map((p) => ({ _id: p.id, title: p.title, position: p.position, pages: p.pages })),
      },
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
      // DOC_PAGES_PLAN §3.3: move it inside a doc (null: the top level), after one of its pages or at the 'start'.
      parentId: readOptionalString(body.parentId, 'parentId'),
      after: readOptionalString(body.after, 'after') ?? undefined,
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

/** GET /api/docs/:id/tree → { rootId, nodes: [{ _id, parentId, title, position }] } (DOC_PAGES_PLAN §3.3). */
export const getDocTree = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const user = requireUser(req);
    const tree = await treeOf(routeParam(req, 'id'), user.id);
    res.status(200).json({
      success: true,
      data: { rootId: tree.rootId, nodes: tree.nodes.map((n) => ({ _id: n.id, parentId: n.parentId, title: n.title, position: n.position })) },
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
