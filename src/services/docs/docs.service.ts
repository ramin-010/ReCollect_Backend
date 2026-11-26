// Docs: the Prisma queries on Doc and DocCollaborator (the REST endpoints, the /api/collab/upload
// route and the Hocuspocus doc handler). Sharing (publish, people, requests): ./docSharing.service.ts.
//
// Replaces what the Mongoose model/handlers did implicitly:
//   - trim + required on title          → normalizeDocTitle (old messages)
//   - collaborators[]                    → DocCollaborator rows (unique per doc+user)
//   - $push / $pull on cloudImages       → atomic SQL on the Json column (appendDocCloudImage, removeDocCloudImages)
// Permission rules live in ./docPermissions.ts.
import { assertParentForNewPage, moveDoc, nextPosition } from './docTree.service';
import type { Prisma } from '@prisma/client';
import type { StateBytes } from './docState';
import { prisma, type DbClient } from '../../db/prisma';
import { isUniqueViolation } from '../../db/errors';
import {
    docCollaboratorOrder,
    docListSelect,
    docRowInclude,
    docWithUsersInclude,
    type DocListRow,
    type DocRow,
    type DocWithUsers,
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
import { templateDocState } from './blocks/newDocState';

/** Trim a title; an empty one is rejected with the Mongoose `required` message. */
export function normalizeDocTitle(title: string): string {
    const trimmed = title.trim();
    if (!trimmed) throw new ErrorResponse(400, 'Path `title` is required.');
    return trimmed;
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

/** A doc the user can see (owner or collaborator), or null. */
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
    return { ...doc, collaborators };
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

// ─── Create / update / delete ─────────────────────────────────────────

export interface CreateDocInput {
    title?: string | null | undefined;
    /** A template's content (the app's TipTap JSON): the doc starts with it, as blocks (the new editor). */
    content?: unknown;
    /** DOC_PAGES_PLAN: a page inside this doc (the user's own, not in the trash). */
    parentId?: string | null | undefined;
}

/**
 * POST /api/docs. Title defaults to 'Untitled'. With `content` (a template) the doc
 * starts with it as blocks; without, it is empty (the editor makes its first block).
 */
export async function createDoc(userId: string, input: CreateDocInput, db: DbClient = prisma): Promise<DocRow> {
    const title = normalizeDocTitle(input.title || 'Untitled');
    let yjsState: StateBytes | null = null;
    if (input.content !== undefined && input.content !== null) {
        if (typeof input.content !== 'object') throw new ErrorResponse(400, 'content is the template\'s JSON');
        try {
            yjsState = templateDocState(input.content, title);
        } catch (err) {
            throw new ErrorResponse(400, `Invalid doc content: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // DOC_PAGES_PLAN §3.2: a page inside a doc of theirs goes after its last page, shared with the same people (D6).
    const parent = input.parentId ? await assertParentForNewPage(userId, input.parentId, db) : null;
    const created = await db.doc.create({
        data: {
            userId,
            title,
            cloudImages: [],
            ...(yjsState ? { yjsState, previewState: generatePreviewState(yjsState) } : {}),
            ...(parent ? { parentId: parent.id, position: await nextPosition(parent.id, db) } : {}),
        },
    });
    if (!parent) return { ...created, collaborators: [] };
    const people = await db.docCollaborator.findMany({ where: { docId: parent.id }, select: { userId: true, role: true } });
    if (people.length) await db.docCollaborator.createMany({ data: people.map((p) => ({ docId: created.id, userId: p.userId, role: p.role })), skipDuplicates: true });
    return loadDocRow(created.id, db);
}

export interface UpdateDocMetaInput {
    title?: string | null | undefined;
    isPinned?: boolean | undefined;
    isArchived?: boolean | undefined;
    coverImage?: string | null | undefined;
    /** DOC_PAGES_PLAN §3.2: move it inside this doc (null = the top level); owner only. */
    parentId?: string | null | undefined;
    /** With a parent: after this page of it, or 'start'. Alone: a new place among its own parent's pages. */
    after?: string | undefined;
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
    const moving = input.parentId !== undefined || input.after !== undefined;
    if (moving && role !== 'owner') throw new ErrorResponse(403, 'Only the owner can move a doc');
    if (role !== 'owner') {
        if (input.title !== undefined || input.isPinned !== undefined || input.isArchived !== undefined) {
            throw new ErrorResponse(403, 'Only the owner can rename or pin this document');
        }
        if (role !== 'editor' && input.coverImage !== undefined) {
            throw new ErrorResponse(403, 'Viewers cannot edit this document');
        }
    }

    const data: Prisma.DocUpdateInput = { updatedAt: new Date() };
    if (input.isPinned !== undefined) data.isPinned = input.isPinned;
    if (input.isArchived !== undefined) data.isArchived = input.isArchived;
    if (input.title !== undefined) data.title = normalizeDocTitle(input.title ?? '');
    if (input.coverImage !== undefined) data.coverImage = input.coverImage;

    // A move alone keeps updatedAt (it changes where the doc sits, not the doc).
    const fields = input.title !== undefined || input.isPinned !== undefined || input.isArchived !== undefined || input.coverImage !== undefined;
    if (fields || !moving) await db.doc.update({ where: { id: docId }, data, select: { id: true } });
    if (moving) {
        const parentId = input.parentId !== undefined ? input.parentId || null : doc.parentId;
        if (input.parentId === undefined && !parentId) throw new ErrorResponse(400, '`after` orders the pages inside a doc: this one is at the top level');
        await moveDoc(userId, docId, { parentId, ...(input.after !== undefined ? { after: input.after } : {}) });
    }
    return loadDocRow(docId, db);
}

/**
 * DELETE /api/docs/:id. The owner deletes the doc (its Cloudinary images first; collaborators and
 * access requests cascade). A collaborator only leaves it.
 */
export async function deleteOrLeaveDoc(docId: string, userId: string, db: DbClient = prisma): Promise<'deleted' | 'left'> {
    const doc = await findAccessibleDoc(docId, userId, db);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');

    if (isDocOwner(doc, userId)) {
        // DOC_PAGES_PLAN §3.2 (D8): a doc deleted from the trash takes the pages that went to the trash with it. The
        // live pages inside a doc deleted outside the trash stay, at the top level (Doc.parentId is SET NULL).
        const taken = doc.trashedAt
            ? await db.doc.findMany({ where: { trashedWithId: docId, userId }, select: { id: true, title: true, cloudImages: true } })
            : [];
        const all = [{ id: doc.id, title: doc.title, cloudImages: doc.cloudImages }, ...taken];
        const images = all.flatMap((d) => readCloudImages(d.cloudImages));
        if (images.length > 0) await batchDeleteFromCloud(images.map((img) => img.cloudPublicId));
        // Its path topics survive (SET NULL, with their revision history); they keep the doc's last
        // title instead of the one they were made with ("Untitled" for a doc named later).
        for (const d of all) await db.topic.updateMany({ where: { docId: d.id }, data: { title: d.title.trim() || 'Untitled' } });
        await db.doc.deleteMany({ where: { id: { in: all.map((d) => d.id) } } });
        return 'deleted';
    }
    await db.docCollaborator.deleteMany({ where: { docId, userId } });
    return 'left';
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
 * Owner and any collaborator may connect; 'viewer' connections are made read-only.
 * Sequential queries: this may run on a transaction client (see loadDocRow).
 */
export async function getDocLiveRole(docId: string, userId: string, db: DbClient = prisma): Promise<DocRole | null> {
    const doc = await db.doc.findUnique({ where: { id: docId }, select: { userId: true } });
    if (!doc) return null;
    if (isDocOwner(doc, userId)) return 'owner';
    const collaborators = await db.docCollaborator.findMany({ where: { docId, userId }, select: { userId: true, role: true } });
    return getDocRole({ userId: doc.userId, collaborators }, userId);
}

export function loadDocYjsState(docId: string, db: DbClient = prisma): Promise<{ id: string; yjsState: StateBytes | null } | null> {
    return db.doc.findUnique({ where: { id: docId }, select: { id: true, yjsState: true } });
}

export interface StoreDocStateInput {
    /** The Yjs state as bytes (D3). */
    yjsState: StateBytes;
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
): Promise<{ yjsState: StateBytes | null; cloudImages: Prisma.JsonValue } | null> {
    return db.doc.findUnique({ where: { id: docId }, select: { yjsState: true, cloudImages: true } });
}

/** How long images an agent edit removed are kept on Cloudinary, so Undo can bring them back. */
export const UNDO_IMAGE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Yjs states saved before agent edits that can still be undone (not undone, newer than the grace
 * period): the images in them must not be deleted as orphans yet.
 */
export async function undoableSnapshotStates(docId: string, now: Date = new Date(), db: DbClient = prisma): Promise<StateBytes[]> {
    const rows = await db.docSnapshot.findMany({
        where: { docId, createdAt: { gte: new Date(now.getTime() - UNDO_IMAGE_GRACE_MS) }, edits: { some: { undoneAt: null } } },
        select: { yjsState: true },
    });
    return rows.map((r) => r.yjsState);
}
