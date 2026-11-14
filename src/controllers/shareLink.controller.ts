// Doc share links (Postgres). DB access: src/services/docs/docSharing.service.ts.
// Content, dashboard and slide share links were removed with those features (see _archive/ and the
// git history). Routes, status codes, messages and JSON shapes are the same as the Mongo version.
import { Request, Response, NextFunction } from "express";
import ErrorResponse from "../utils/errorResponse";
import { requireUser } from '../middlwares/auth';
import { hocuspocusServer } from '../collaboration/hocuspocus';
import { serializeSharedDocLink } from '../db/serializers/docSharing';
import {
    createDocShareLink as createDocShareLinkInDb,
    findActiveDocShareLink,
    joinDocViaShareLink,
} from '../services/docs/docSharing.service';

function routeParam(req: Request, name: string, notFoundMessage: string): string {
    const value = req.params[name];
    if (typeof value !== 'string' || !value) throw new ErrorResponse(404, notFoundMessage);
    return value;
}

/** Tell everyone editing the doc live that someone joined (Hocuspocus stateless message). */
function broadcastCollaboratorJoined(docId: string, userId: string): void {
    try {
        const documentName = `doc_${docId}`;
        const activeDoc = (hocuspocusServer as any).hocuspocus?.documents?.get(documentName);
        if (activeDoc) {
            activeDoc.broadcastStateless(JSON.stringify({ type: 'COLLABORATOR_JOINED', userId }));
            console.log(`[ShareLink] Broadcasted COLLABORATOR_JOINED to ${documentName}`);
        }
    } catch (broadcastErr) {
        console.error('[ShareLink] Failed to broadcast:', broadcastErr);
    }
}

export const createDocShareLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const user = requireUser(req);
        const { type, docId, role = 'viewer' } = req.body ?? {};

        if (typeof docId !== 'string' || !docId.trim()) {
            throw new ErrorResponse(400, "Missing document ID");
        }
        if (typeof type !== 'string' || !type.trim()) {
            throw new ErrorResponse(400, 'Type cannot be empty');
        }
        if (type.toLowerCase() !== 'doc') {
            throw new ErrorResponse(400, 'Type should be doc');
        }
        if (role !== 'editor' && role !== 'viewer') {
            // Mongoose enum message (the role was validated when the link was created).
            throw new ErrorResponse(400, `\`${String(role)}\` is not a valid enum value for path \`role\`.`);
        }

        const { slug } = await createDocShareLinkInDb(user.id, docId, role);

        res.status(200).json({
            success: true,
            data: {
                url: `${process.env.FRONTEND_URL}/doc/${slug}`
            },
            message: 'New share link generated. Previous links invalidated.'
        });
    } catch (err: any) {
        next(err);
    }
}

export const fetchDocLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const slug = routeParam(req, 'slug', 'URL is expired or not found');
        const docLink = await findActiveDocShareLink(slug);

        if (!docLink) {
            throw new ErrorResponse(404, 'URL is expired or not found');
        }

        res.status(200).json({
            success: true,
            data: serializeSharedDocLink(docLink),
            message: 'Successfully fetched the document'
        });
    } catch (err: any) {
        next(err);
    }
}

/** POST /api/save/:slug — "save to my profile": join the doc as a collaborator with the link's role. */
export const saveSharedDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const user = requireUser(req);
        const slug = routeParam(req, 'slug', 'Invalid or expired share link');

        const { result, docId } = await joinDocViaShareLink(slug, user.id);

        if (result === 'owner') {
            return void res.status(400).json({
                success: false,
                message: 'You are the owner of this document'
            });
        }
        if (result === 'banned') {
            return void res.status(403).json({
                success: false,
                message: 'Your access to this document has been revoked'
            });
        }
        if (result === 'already-collaborator') {
            return void res.status(200).json({
                success: true,
                message: 'You are already a collaborator on this document'
            });
        }

        broadcastCollaboratorJoined(docId, user.id);

        res.status(200).json({
            success: true,
            message: 'Document saved to your profile successfully'
        });
    } catch (err: any) {
        next(err);
    }
}
