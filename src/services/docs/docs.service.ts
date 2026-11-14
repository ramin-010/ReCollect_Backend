// Docs: every Prisma query on Doc, DocCollaborator and DocBannedUser goes through here (the REST
// endpoints, the /api/collab/upload route and the Hocuspocus doc handler).
//
// Replaces what the Mongoose model/handlers did implicitly:
//   - trim + required on title          → normalizeDocTitle (old messages)
//   - docType enum                       → assertDocType (old message; Postgres can't store a bad value)
//   - collaborators[] / bannedUsers[]    → DocCollaborator / DocBannedUser rows (unique per doc+user)
//   - $push / $pull on cloudImages       → atomic SQL on the Json column (appendDocCloudImage, removeDocCloudImages)
// Permission rules live in ./docPermissions.ts.
import type { CollaboratorRole, DocType, Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { isUniqueViolation } from '../../db/errors';
import {
    docBannedUserOrder,
    docCollaboratorOrder,
    docListSelect,
    docRowInclude,
    docWithUsersInclude,
    sharedByMeDocSelect,
    type DocListRow,
    type DocRow,
    type DocWithUsers,
    type SharedByMeDocRow,
} from '../../db/serializers/doc';
import ErrorResponse from '../../utils/errorResponse';
import { batchDeleteFromCloud } from '../../utils/cloudinary';
import { generatePreviewState } from '../../utils/previewUtils';
import {
    collectUploadedImages,
    partitionCloudImages,
    readCloudImages,
    type CloudImage,
    type UploadedFiles,
} from '../uploads/cloudImages';
import { accessibleDocWhere, canEditDoc, getDocRole, isDocOwner, type DocRole } from './docPermissions';
import { docJsonToYjsState, replaceImageSrcs } from './docContent';

export const DOC_TYPES: readonly DocType[] = ['notes', 'meeting', 'project', 'personal'];

/** Trim a title; an empty one is rejected with the Mongoose `required` message. */
export function normalizeDocTitle(title: string): string {
    const trimmed = title.trim();
    if (!trimmed) throw new ErrorResponse(400, 'Path `title` is required.');
    return trimmed;
}

/** Validate a docType with the Mongoose enum message. */
export function assertDocType(docType: unknown): DocType {
    if (typeof docType !== 'string' || !(DOC_TYPES as readonly string[]).includes(docType)) {
        throw new ErrorResponse(400, `\`${String(docType)}\` is not a valid enum value for path \`docType\`.`);
    }
    return docType as DocType;
}

/**
 * Ids the REST save may create a doc with. Mongo only accepted ObjectIds there (anything else was a
 * CastError → 404); here: letters and digits (cuids, migrated ObjectIds). Browser-only copies use
 * `local_…` ids and must not become server rows.
 */
export function isAcceptableNewDocId(id: string): boolean {
    return /^[A-Za-z0-9]{1,64}$/.test(id);
}

// ─── Reads ─────────────────────────────────────────────────────────────

/** A doc the user can see (owner or non-banned collaborator), or null. */
export function findAccessibleDoc(docId: string, userId: string, db: DbClient = prisma): Promise<DocRow | null> {
    return db.doc.findFirst({ where: { id: docId, ...accessibleDocWhere(userId) }, include: docRowInclude });
}

/**
 * A doc row for serializeDoc(), read right after a write. The relations are loaded one query at a
 * time on purpose: `create/update({ include: docRowInclude })` (or any include of 2+ relations on a
 * transaction client) makes Prisma run the relation queries concurrently on ONE pg connection,
 * which pg 8 deprecates ("client is already executing a query") and pg 9 will reject.
 */
async function loadDocRow(docId: string, db: DbClient): Promise<DocRow> {
    const doc = await db.doc.findUniqueOrThrow({ where: { id: docId } });
    const collaborators = await db.docCollaborator.findMany({ where: { docId }, orderBy: docCollaboratorOrder });
    const bannedUsers = await db.docBannedUser.findMany({ where: { docId }, orderBy: docBannedUserOrder });
    return { ...doc, collaborators, bannedUsers };
}

/** GET /api/docs/:id: the doc with owner/collaborators populated and the caller's role, or null. */
export async function findAccessibleDocWithUsers(
    docId: string,
    userId: string,
    db: DbClient = prisma
): Promise<{ doc: DocWithUsers; role: DocRole } | null> {
    const doc = await db.doc.findFirst({ where: { id: docId, ...accessibleDocWhere(userId) }, include: docWithUsersInclude });
    if (!doc) return null;
    const role = getDocRole(doc, userId);
    return role ? { doc, role } : null;
}

/** GET /api/docs: docs the user owns or collaborates on, newest first, with the caller's role. */
export async function listAccessibleDocs(
    userId: string,
    db: DbClient = prisma
): Promise<Array<{ doc: DocListRow; role: DocRole }>> {
    const docs = await db.doc.findMany({
        where: accessibleDocWhere(userId),
        select: docListSelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
    // Non-owners always have a collaborator row here (the filter requires it); 'viewer' is the old fallback.
    return docs.map((doc) => ({ doc, role: getDocRole(doc, userId) ?? 'viewer' }));
}

/** GET /api/docs/shared-by-me: the user's docs that have at least one collaborator. */
export function listDocsSharedBy(ownerId: string, db: DbClient = prisma): Promise<SharedByMeDocRow[]> {
    return db.doc.findMany({
        where: { userId: ownerId, collaborators: { some: {} } },
        select: sharedByMeDocSelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
}

// ─── Create / update / delete ─────────────────────────────────────────

export interface CreateDocInput {
    title?: string | null | undefined;
    docType?: string | null | undefined;
}

/** POST /api/docs. Title defaults to 'Untitled', docType to 'notes'. */
export async function createDoc(userId: string, input: CreateDocInput, db: DbClient = prisma): Promise<DocRow> {
    const created = await db.doc.create({
        data: {
            userId,
            title: normalizeDocTitle(input.title || 'Untitled'),
            docType: assertDocType(input.docType || 'notes'),
            cloudImages: [],
        },
    });
    // A new doc has no collaborators or bans yet.
    return { ...created, collaborators: [], bannedUsers: [] };
}

export interface UpdateDocMetaInput {
    title?: string | null | undefined;
    docType?: string | null | undefined;
    isPinned?: boolean | undefined;
    isArchived?: boolean | undefined;
    coverImage?: string | null | undefined;
}

/**
 * PATCH /api/docs/:id. Owner: any field. Editors: only coverImage (as before). Viewers: nothing
 * (they could change the cover before; now 403 "Viewers cannot edit this document").
 */
export async function updateDocMeta(
    docId: string,
    userId: string,
    input: UpdateDocMetaInput,
    db: DbClient = prisma
): Promise<DocRow> {
    const doc = await findAccessibleDoc(docId, userId, db);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');

    const role = getDocRole(doc, userId);
    if (role !== 'owner') {
        if (
            input.title !== undefined ||
            input.docType !== undefined ||
            input.isPinned !== undefined ||
            input.isArchived !== undefined
        ) {
            throw new ErrorResponse(403, 'Only the owner can rename, change type, or pin this document');
        }
        if (role !== 'editor' && input.coverImage !== undefined) {
            throw new ErrorResponse(403, 'Viewers cannot edit this document');
        }
    }

    const data: Prisma.DocUpdateInput = { updatedAt: new Date() };
    if (input.docType !== undefined) data.docType = assertDocType(input.docType);
    if (input.isPinned !== undefined) data.isPinned = input.isPinned;
    if (input.isArchived !== undefined) data.isArchived = input.isArchived;
    if (input.title !== undefined) data.title = normalizeDocTitle(input.title ?? '');
    if (input.coverImage !== undefined) data.coverImage = input.coverImage;

    await db.doc.update({ where: { id: docId }, data, select: { id: true } });
    return loadDocRow(docId, db);
}

export interface SaveDocInput {
    title?: string | null | undefined;
    coverImage?: string | null | undefined;
    docType?: string | null | undefined;
    /** Parsed TipTap JSON (editor.getJSON()), or null to keep the stored content. */
    content: unknown;
    /** Ids of the images uploaded with this request (form fields `image_<id>`). */
    imageNodeIds: string[];
    /** Every imageId the doc still uses; stored images not in this list are deleted from Cloudinary. */
    allImageIds: string[];
    files?: UploadedFiles | undefined;
}

/**
 * POST /api/docs/:id (personal-doc cloud save). Converts the editor JSON to a Yjs state, points
 * uploaded images at Cloudinary, deletes orphaned images, then updates the doc, or creates it
 * with the client's id when it doesn't exist (as before). Canvas boards are not in the JSON (they
 * live in the Y.Doc): those of canvases still in the content carry over from the stored state.
 */
export async function saveDocFromEditor(
    docId: string,
    userId: string,
    input: SaveDocInput,
    db: DbClient = prisma
): Promise<{ doc: DocRow; created: boolean }> {
    const doc = await findAccessibleDoc(docId, userId, db);
    if (doc && getDocRole(doc, userId) === 'viewer') {
        throw new ErrorResponse(403, 'Viewers cannot edit this document');
    }
    const docType = doc && isDocOwner(doc, userId) && input.docType !== undefined ? assertDocType(input.docType) : undefined;

    const { content } = input;
    const { imageUrlMap, uploaded } =
        content && input.imageNodeIds.length > 0
            ? collectUploadedImages(input.files, input.imageNodeIds)
            : { imageUrlMap: {}, uploaded: [] as CloudImage[] };
    if (content) replaceImageSrcs(content, imageUrlMap);

    const yjsState = content ? docJsonToYjsState(content, undefined, { canvasesFrom: doc?.yjsState }) : null;

    const { retain, orphaned } = partitionCloudImages(readCloudImages(doc?.cloudImages), input.allImageIds);
    if (orphaned.length > 0) {
        await batchDeleteFromCloud(orphaned.map((img) => img.cloudPublicId));
    }
    const cloudImages: CloudImage[] = [...retain, ...uploaded];
    const previewState = yjsState ? generatePreviewState(yjsState) : null;

    if (doc) {
        const isOwner = isDocOwner(doc, userId);
        await db.doc.update({
            where: { id: docId },
            data: {
                yjsState: yjsState || doc.yjsState,
                previewState: previewState || doc.previewState,
                // Mongoose trimmed here but did not validate (no runValidators on this update).
                title: isOwner ? (input.title || doc.title).trim() : doc.title,
                docType: docType ?? doc.docType,
                coverImage: input.coverImage !== undefined ? input.coverImage : doc.coverImage,
                cloudImages,
                updatedAt: new Date(),
            },
            select: { id: true },
        });
        return { doc: await loadDocRow(docId, db), created: false };
    }

    if (!isAcceptableNewDocId(docId)) {
        // What Mongo's CastError handler answered for a non-ObjectId id.
        throw new ErrorResponse(404, `Resource not found with id of ${docId}`);
    }
    try {
        const created = await db.doc.create({
            data: {
                id: docId,
                userId,
                title: normalizeDocTitle(input.title || 'Untitled'),
                yjsState,
                previewState,
                coverImage: input.coverImage || null,
                cloudImages,
            },
        });
        return { doc: { ...created, collaborators: [], bannedUsers: [] }, created: true };
    } catch (err) {
        // The id belongs to a doc this user can't access (Mongo: duplicate key on _id).
        if (isUniqueViolation(err)) throw new ErrorResponse(400, 'Duplicate field value entered: _id');
        throw err;
    }
}

/**
 * DELETE /api/docs/:id. The owner deletes the doc (its Cloudinary images first; collaborators,
 * bans, share links and access requests cascade). A collaborator only leaves it.
 */
export async function deleteOrLeaveDoc(docId: string, userId: string, db: DbClient = prisma): Promise<'deleted' | 'left'> {
    const doc = await findAccessibleDoc(docId, userId, db);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');

    if (isDocOwner(doc, userId)) {
        const images = readCloudImages(doc.cloudImages);
        if (images.length > 0) await batchDeleteFromCloud(images.map((img) => img.cloudPublicId));
        await db.doc.deleteMany({ where: { id: docId } });
        return 'deleted';
    }
    await db.docCollaborator.deleteMany({ where: { docId, userId } });
    return 'left';
}

// ─── Collaborators ─────────────────────────────────────────────────────

/** PATCH /api/docs/:id/collaborators/:collaboratorId (owner only). */
export async function setDocCollaboratorRole(
    docId: string,
    ownerId: string,
    collaboratorId: string,
    role: CollaboratorRole,
    db: DbClient = prisma
): Promise<void> {
    const owned = await db.doc.findFirst({ where: { id: docId, userId: ownerId }, select: { id: true } });
    if (!owned) throw new ErrorResponse(404, 'Doc not found or you are not the owner');

    const { count } = await db.docCollaborator.updateMany({ where: { docId, userId: collaboratorId }, data: { role } });
    if (count === 0) throw new ErrorResponse(404, 'Collaborator not found');
}

/**
 * DELETE /api/docs/:id/collaborators/:collaboratorId. The owner removes (and bans) someone, or a
 * collaborator leaves (no ban). Opens its own transaction, so it takes no `db`.
 * `remainingCount` is computed like before: collaborators before the removal, minus one.
 */
export async function removeDocCollaborator(
    docId: string,
    actorId: string,
    collaboratorId: string
): Promise<{ remainingCount: number; isLeavingVoluntarily: boolean }> {
    const doc = await findAccessibleDoc(docId, actorId);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');

    const isLeavingVoluntarily = collaboratorId === actorId;
    if (!isDocOwner(doc, actorId) && !isLeavingVoluntarily) {
        throw new ErrorResponse(403, 'Only the owner can remove other collaborators');
    }

    await prisma.$transaction(async (tx) => {
        const { count } = await tx.docCollaborator.deleteMany({ where: { docId, userId: collaboratorId } });
        if (count === 0) throw new ErrorResponse(404, 'Collaborator not found');
        if (!isLeavingVoluntarily) {
            await tx.docBannedUser.upsert({
                where: { docId_userId: { docId, userId: collaboratorId } },
                create: { docId, userId: collaboratorId },
                update: { bannedAt: new Date() },
            });
        }
    });

    return { remainingCount: (doc.collaborators.length || 1) - 1, isLeavingVoluntarily };
}

// ─── Cloud images ──────────────────────────────────────────────────────

/**
 * POST /api/collab/upload: remember an image uploaded from the live editor in Doc.cloudImages so
 * cleanup can delete it later. Only for the owner or an editor (the Mongo route let any logged-in
 * user append to any doc). One atomic UPDATE (Mongo: $push), so concurrent uploads aren't lost.
 * Returns false when nothing was recorded.
 */
export async function appendDocCloudImage(
    docId: string,
    userId: string,
    image: CloudImage,
    db: DbClient = prisma
): Promise<boolean> {
    const doc = await db.doc.findFirst({
        where: { id: docId, ...accessibleDocWhere(userId) },
        select: { userId: true, collaborators: { where: { userId }, select: { userId: true, role: true } } },
    });
    if (!doc || !canEditDoc(doc, userId)) return false;

    const entry = JSON.stringify([image]);
    const updated = await db.$executeRaw`
        UPDATE "Doc"
        SET "cloudImages" = COALESCE("cloudImages", '[]'::jsonb) || ${entry}::jsonb,
            "updatedAt" = ${new Date()}
        WHERE "id" = ${docId}`;
    return updated > 0;
}

/**
 * Remove the entries with these imageIds from Doc.cloudImages in one UPDATE, so images appended
 * meanwhile (by /api/collab/upload) are kept. Order of the remaining entries is preserved.
 */
export async function removeDocCloudImages(docId: string, imageIds: readonly string[], db: DbClient = prisma): Promise<void> {
    if (imageIds.length === 0) return;
    await db.$executeRaw`
        UPDATE "Doc"
        SET "cloudImages" = COALESCE((
                SELECT jsonb_agg(t.elem ORDER BY t.pos)
                FROM jsonb_array_elements("cloudImages") WITH ORDINALITY AS t(elem, pos)
                WHERE COALESCE((t.elem ->> 'imageId') = ANY(${[...imageIds]}::text[]), false) = false
            ), '[]'::jsonb),
            "updatedAt" = ${new Date()}
        WHERE "id" = ${docId} AND jsonb_typeof("cloudImages") = 'array'`;
}

// ─── Live collaboration (Hocuspocus doc handler) ───────────────────────

/**
 * The user's role for a live (Hocuspocus) connection, or null when they may not open the doc.
 * Owner and any non-banned collaborator may connect; 'viewer' connections are made read-only.
 * Sequential queries: this may run on a transaction client (see loadDocRow).
 */
export async function getDocLiveRole(docId: string, userId: string, db: DbClient = prisma): Promise<DocRole | null> {
    const doc = await db.doc.findUnique({ where: { id: docId }, select: { userId: true } });
    if (!doc) return null;
    if (isDocOwner(doc, userId)) return 'owner';
    const collaborators = await db.docCollaborator.findMany({ where: { docId, userId }, select: { userId: true, role: true } });
    const bannedUsers = await db.docBannedUser.findMany({ where: { docId, userId }, select: { userId: true } });
    return getDocRole({ userId: doc.userId, collaborators, bannedUsers }, userId);
}

export function loadDocYjsState(docId: string, db: DbClient = prisma): Promise<{ id: string; yjsState: string | null } | null> {
    return db.doc.findUnique({ where: { id: docId }, select: { id: true, yjsState: true } });
}

export interface StoreDocStateInput {
    yjsState: string;
    previewState: string | null;
    /** From the Y.Doc's `metadata` map; undefined = leave unchanged. */
    title?: string | undefined;
    coverImage?: string | null | undefined;
}

/** Hocuspocus onStoreDocument. A doc deleted meanwhile is ignored (Mongo's findByIdAndUpdate did the same). */
export async function storeDocYjsState(docId: string, input: StoreDocStateInput, db: DbClient = prisma): Promise<void> {
    const data: Prisma.DocUpdateManyMutationInput = {
        yjsState: input.yjsState,
        previewState: input.previewState,
        updatedAt: new Date(),
    };
    if (input.title !== undefined) data.title = input.title.trim();
    if (input.coverImage !== undefined) data.coverImage = input.coverImage;
    await db.doc.updateMany({ where: { id: docId }, data });
}

export function findDocImageState(
    docId: string,
    db: DbClient = prisma
): Promise<{ yjsState: string | null; cloudImages: Prisma.JsonValue } | null> {
    return db.doc.findUnique({ where: { id: docId }, select: { yjsState: true, cloudImages: true } });
}

/** How long images an agent edit removed are kept on Cloudinary, so Undo can bring them back. */
export const UNDO_IMAGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Yjs states saved before agent edits that can still be undone (not undone, newer than the grace
 * period): the images in them must not be deleted as orphans yet.
 */
export async function undoableSnapshotStates(docId: string, now: Date = new Date(), db: DbClient = prisma): Promise<string[]> {
    const rows = await db.docSnapshot.findMany({
        where: { docId, createdAt: { gte: new Date(now.getTime() - UNDO_IMAGE_GRACE_MS) }, edits: { some: { undoneAt: null } } },
        select: { yjsState: true },
    });
    return rows.map((r) => r.yjsState);
}
