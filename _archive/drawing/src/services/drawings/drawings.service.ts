// Drawings (Excalidraw): every Prisma query on Drawing and DrawingCollaborator goes through here
// (the REST endpoints and the Hocuspocus drawing handler).
//
// Replaces what the Mongoose model/handlers did implicitly:
//   - trim + required on name             → normalizeDrawingName (old message)
//   - unique (user, localId)              → same constraint; the old duplicate message is kept
//   - shareToken unique + sparse          → nullable unique column
// Permission rules live in ./drawingPermissions.ts. yjsState stays the Base64 text the client sends.
import crypto from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { isUniqueViolation } from '../../db/errors';
import {
    drawingRowInclude,
    drawingWithCollaboratorsInclude,
    drawingWithUsersInclude,
    sharedDrawingSelect,
    type DrawingRow,
    type DrawingWithCollaborators,
    type DrawingWithUsers,
    type SharedDrawingRow,
} from '../../db/serializers/drawing';
import ErrorResponse from '../../utils/errorResponse';
import { batchDeleteFromCloud } from '../../utils/cloudinary';
import {
    collectUploadedImages,
    partitionCloudImages,
    readCloudImages,
    type CollectedUploads,
    type UploadedFiles,
} from '../uploads/cloudImages';
import {
    accessibleDrawingWhere,
    getDrawingRole,
    isValidDrawingShareToken,
    type DrawingRole,
} from './drawingPermissions';

/** Trim a name; an empty one is rejected with the Mongoose `required` message. */
export function normalizeDrawingName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) throw new ErrorResponse(400, 'Path `name` is required.');
    return trimmed;
}

const SHARE_TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 16 characters from [A-Za-z0-9], as before, but from a CSPRNG (it was Math.random). */
export function generateDrawingShareToken(): string {
    let token = '';
    for (let i = 0; i < 16; i++) token += SHARE_TOKEN_ALPHABET.charAt(crypto.randomInt(SHARE_TOKEN_ALPHABET.length));
    return token;
}

// ─── Reads ─────────────────────────────────────────────────────────────

/** GET /api/drawings: drawings the user owns or collaborates on, newest first, with the caller's role. */
export async function listAccessibleDrawings(
    userId: string,
    db: DbClient = prisma
): Promise<Array<{ drawing: DrawingWithCollaborators; role: DrawingRole }>> {
    const drawings = await db.drawing.findMany({
        where: accessibleDrawingWhere(userId),
        include: drawingWithCollaboratorsInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    return drawings.map((drawing) => ({ drawing, role: getDrawingRole(drawing, userId) ?? 'viewer' }));
}

/** GET /api/drawings/:id: owner and collaborators populated, with the caller's role, or null. */
export async function findAccessibleDrawingWithUsers(
    drawingId: string,
    userId: string,
    db: DbClient = prisma
): Promise<{ drawing: DrawingWithUsers; role: DrawingRole } | null> {
    const drawing = await db.drawing.findFirst({
        where: { id: drawingId, ...accessibleDrawingWhere(userId) },
        include: drawingWithUsersInclude,
    });
    if (!drawing) return null;
    return { drawing, role: getDrawingRole(drawing, userId) ?? 'viewer' };
}

/** A drawing owned by this user (all management routes are owner-only), or null. */
function findOwnedDrawing(drawingId: string, userId: string, db: DbClient) {
    return db.drawing.findFirst({ where: { id: drawingId, userId } });
}

// ─── Create / save / update / delete ──────────────────────────────────

export interface CreateDrawingInput {
    name?: string | null | undefined;
    localId?: string | null | undefined;
}

/** POST /api/drawings. */
export async function createDrawing(userId: string, input: CreateDrawingInput, db: DbClient = prisma): Promise<DrawingRow> {
    try {
        return await db.drawing.create({
            data: {
                userId,
                name: normalizeDrawingName(input.name || 'Untitled Drawing'),
                localId: input.localId || `drawing_${Date.now()}`,
                cloudImages: [],
            },
            include: drawingRowInclude,
        });
    } catch (err) {
        // Same text as the Mongo duplicate-key handler (the unique index was { user, localId }).
        if (isUniqueViolation(err)) throw new ErrorResponse(400, 'Duplicate field value entered: user,localId');
        throw err;
    }
}

export interface SaveDrawingInput {
    yjsState?: string | null | undefined;
    name?: string | null | undefined;
    thumbnail?: string | null | undefined;
    /** Ids (Excalidraw fileIds) of the images uploaded with this request (fields `image_<id>`). */
    imageFileIds: string[];
    /** Every fileId the drawing still uses; stored images not in this list are deleted from Cloudinary. */
    allImageIds: string[];
    files?: UploadedFiles | undefined;
}

/**
 * POST /api/drawings/:id/save. Records uploaded images (the yjsState itself is not rewritten: the
 * client maps fileIds to cloudImages URLs on load), deletes orphaned images, updates the drawing.
 */
export async function saveDrawingFromEditor(
    drawingId: string,
    userId: string,
    input: SaveDrawingInput,
    db: DbClient = prisma
): Promise<{ drawing: DrawingRow; imageUrlMap: CollectedUploads['imageUrlMap'] }> {
    const drawing = await db.drawing.findFirst({ where: { id: drawingId, ...accessibleDrawingWhere(userId) }, include: drawingRowInclude });
    if (!drawing) throw new ErrorResponse(404, 'Drawing not found');
    if (getDrawingRole(drawing, userId) === 'viewer') throw new ErrorResponse(403, 'Viewers cannot edit this drawing');

    const { imageUrlMap, uploaded } =
        input.imageFileIds.length > 0 ? collectUploadedImages(input.files, input.imageFileIds) : { imageUrlMap: {}, uploaded: [] };

    const { retain, orphaned } = partitionCloudImages(readCloudImages(drawing.cloudImages), input.allImageIds);
    console.log(
        `[Drawing API] SAVE ${drawingId} | CLEANUP | existing: ${retain.length + orphaned.length}, retain: ${retain.length}, delete: ${orphaned.length}, new: ${uploaded.length}`
    );
    if (orphaned.length > 0) await batchDeleteFromCloud(orphaned.map((img) => img.cloudPublicId));

    const data: Prisma.DrawingUpdateInput = { updatedAt: new Date(), cloudImages: [...retain, ...uploaded] };
    if (input.yjsState !== undefined) data.yjsState = input.yjsState;
    // findByIdAndUpdate ran with runValidators: an empty name was rejected.
    if (input.name !== undefined) data.name = normalizeDrawingName(input.name ?? '');
    if (input.thumbnail !== undefined) data.thumbnail = input.thumbnail ?? '';

    const updated = await db.drawing.update({ where: { id: drawingId }, data, include: drawingRowInclude });
    return { drawing: updated, imageUrlMap };
}

/** PATCH /api/drawings/:id (owner only): rename. */
export async function updateDrawingMeta(
    drawingId: string,
    userId: string,
    input: { name?: string | null | undefined },
    db: DbClient = prisma
): Promise<DrawingRow> {
    const owned = await findOwnedDrawing(drawingId, userId, db);
    if (!owned) throw new ErrorResponse(404, 'Drawing not found or not authorized');

    const data: Prisma.DrawingUpdateInput = { updatedAt: new Date() };
    if (input.name !== undefined) data.name = normalizeDrawingName(input.name ?? '');
    return db.drawing.update({ where: { id: drawingId }, data, include: drawingRowInclude });
}

/** DELETE /api/drawings/:id (owner only): Cloudinary images first, then the row (collaborators cascade). */
export async function deleteOwnedDrawing(drawingId: string, userId: string, db: DbClient = prisma): Promise<void> {
    const owned = await findOwnedDrawing(drawingId, userId, db);
    if (!owned) throw new ErrorResponse(404, 'Drawing not found or not authorized');

    const images = readCloudImages(owned.cloudImages);
    if (images.length > 0) await batchDeleteFromCloud(images.map((img) => img.cloudPublicId));
    await db.drawing.deleteMany({ where: { id: drawingId } });
}

// ─── Share links (anonymous, by token) ────────────────────────────────

/** POST /api/drawings/:id/share (owner only). Reuses the existing token so old URLs keep working. */
export async function enableDrawingShare(drawingId: string, userId: string, db: DbClient = prisma): Promise<string> {
    const owned = await findOwnedDrawing(drawingId, userId, db);
    if (!owned) throw new ErrorResponse(404, 'Drawing not found or not authorized');

    const shareToken = owned.shareToken || generateDrawingShareToken();
    await db.drawing.update({ where: { id: drawingId }, data: { shareToken, shareEnabled: true } });
    return shareToken;
}

/** DELETE /api/drawings/:id/share (owner only). The token is kept so re-enabling restores the URL. */
export async function disableDrawingShare(drawingId: string, userId: string, db: DbClient = prisma): Promise<void> {
    const owned = await findOwnedDrawing(drawingId, userId, db);
    if (!owned) throw new ErrorResponse(404, 'Drawing not found or not authorized');
    await db.drawing.update({ where: { id: drawingId }, data: { shareEnabled: false } });
}

/** GET /api/drawings/:id/share (owner only). The token is only revealed while sharing is enabled. */
export async function getDrawingShareStatus(
    drawingId: string,
    userId: string,
    db: DbClient = prisma
): Promise<{ shareToken: string | null; shareEnabled: boolean }> {
    const owned = await findOwnedDrawing(drawingId, userId, db);
    if (!owned) throw new ErrorResponse(404, 'Drawing not found or not authorized');
    return { shareToken: owned.shareEnabled ? owned.shareToken : null, shareEnabled: owned.shareEnabled };
}

/** GET /api/drawings/public/shared/:token (no login): the drawing while sharing is enabled, or null. */
export function findSharedDrawing(token: string, db: DbClient = prisma): Promise<SharedDrawingRow | null> {
    if (!token) return Promise.resolve(null);
    return db.drawing.findFirst({ where: { shareToken: token, shareEnabled: true }, select: sharedDrawingSelect });
}

// ─── Live collaboration (Hocuspocus drawing handler) ───────────────────

/** What a live (Hocuspocus) connection may do with a drawing. */
export type DrawingLiveAccess = 'edit' | 'view';

/**
 * May this connection open the drawing live, and may it write? A valid share token (sharing
 * enabled) lets anyone edit, guests included ("Guests can edit in real-time without logging
 * in"; links have no view-only mode). Otherwise the owner and editors edit, viewers only view.
 * null = no access.
 */
export async function getDrawingLiveAccess(
    drawingId: string,
    userId: string | null,
    shareToken: string | undefined,
    db: DbClient = prisma
): Promise<DrawingLiveAccess | null> {
    const drawing = await db.drawing.findUnique({
        where: { id: drawingId },
        select: { userId: true, shareToken: true, shareEnabled: true },
    });
    if (!drawing) return null;
    if (shareToken && isValidDrawingShareToken(drawing, shareToken)) return 'edit';
    if (!userId) return null;
    const collaborators = await db.drawingCollaborator.findMany({
        where: { drawingId, userId },
        select: { userId: true, role: true },
    });
    const role = getDrawingRole({ userId: drawing.userId, collaborators }, userId);
    if (role === null) return null;
    return role === 'viewer' ? 'view' : 'edit';
}

export function loadDrawingYjsState(
    drawingId: string,
    db: DbClient = prisma
): Promise<{ id: string; yjsState: string | null } | null> {
    return db.drawing.findUnique({ where: { id: drawingId }, select: { id: true, yjsState: true } });
}

/** Hocuspocus onStoreDocument. A drawing deleted meanwhile is ignored (as with findByIdAndUpdate). */
export async function storeDrawingYjsState(drawingId: string, yjsState: string, db: DbClient = prisma): Promise<boolean> {
    const { count } = await db.drawing.updateMany({ where: { id: drawingId }, data: { yjsState, updatedAt: new Date() } });
    return count > 0;
}
