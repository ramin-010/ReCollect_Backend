// Doc shapes, matching what the Mongo API returned.
//
// serializeDoc           → a Doc as .lean()/.toObject() returned it, references NOT populated:
//                          { _id, user: <ownerId>, title, previewState, coverImage,
//                            isPinned, isArchived, cloudImages: [{ imageId, cloudUrl, cloudPublicId }],
//                            collaborators: [{ _id, user: <id>, role, addedAt }], createdAt, updatedAt }
//                          (collaborator subdocuments had their own _id in Mongoose). No __v. Bans went
//                          with the sharing rebuild (2026-11-15). The Yjs state is not sent (D3, 2026-11-15:
//                          it is bytes now, and the app reads a doc through the live server, never from here).
// serializeDocWithUsers  → GET /api/docs/:id: the same after .populate('user', 'name email') and
//                          .populate('collaborators.user', 'name email avatar').
// serializeDocListItem   → GET /api/docs: the old aggregation's $project (no yjsState or cloudImages;
//                          collaborators are { role, addedAt, user: {…} } without _id) + role, the owner
//                          and publishedAt (the library's "Shared" view).
//
// Also exported from ./index.ts.
import type { CollaboratorRole, Prisma } from '@prisma/client';
import { serializeUserSummary, userSummarySelect, type UserSummaryJson } from './user';

/** Mongo kept embedded arrays in insertion order. */
export const docCollaboratorOrder = [{ addedAt: 'asc' }, { id: 'asc' }] satisfies Prisma.DocCollaboratorOrderByWithRelationInput[];

/** Include for serializeDoc(). */
export const docRowInclude = {
    collaborators: { orderBy: docCollaboratorOrder },
} satisfies Prisma.DocInclude;
export type DocRow = Prisma.DocGetPayload<{ include: typeof docRowInclude }>;

/** Include for serializeDocWithUsers(). */
export const docWithUsersInclude = {
    user: { select: userSummarySelect },
    collaborators: { include: { user: { select: userSummarySelect } }, orderBy: docCollaboratorOrder },
} satisfies Prisma.DocInclude;
export type DocWithUsers = Prisma.DocGetPayload<{ include: typeof docWithUsersInclude }>;

/** Select for serializeDocListItem(). */
export const docListSelect = {
    id: true,
    userId: true,
    title: true,
    previewState: true,
    isPinned: true,
    isArchived: true,
    trashedAt: true,
    publishedAt: true,
    coverImage: true,
    createdAt: true,
    updatedAt: true,
    // DOC_PAGES_PLAN §3.2: where it sits in a tree.
    parentId: true,
    position: true,
    trashedWithId: true,
    user: { select: userSummarySelect },
    collaborators: {
        select: { userId: true, role: true, addedAt: true, user: { select: userSummarySelect } },
        orderBy: docCollaboratorOrder,
    },
} satisfies Prisma.DocSelect;
export type DocListRow = Prisma.DocGetPayload<{ select: typeof docListSelect }>;

export type DocRoleJson = 'owner' | CollaboratorRole;

interface DocBaseJson {
    _id: string;
    title: string;
    /** DOC_PAGES_PLAN: the doc it is a page of (null: top level), its place there, the doc whose trashing took it. */
    parentId: string | null;
    position: number;
    trashedWithId: string | null;
    previewState: string | null;
    coverImage: string | null;
    isPinned: boolean;
    isArchived: boolean;
    /** In the trash since then (the doc page says so), or null. */
    trashedAt: Date | null;
    cloudImages: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
}

export interface DocJson extends DocBaseJson {
    user: string;
    collaborators: Array<{ _id: string; user: string; role: CollaboratorRole; addedAt: Date }>;
}

export interface DocWithUsersJson extends DocBaseJson {
    user: UserSummaryJson;
    collaborators: Array<{ _id: string; user: UserSummaryJson; role: CollaboratorRole; addedAt: Date }>;
}

function docBase(doc: DocRow | DocWithUsers): DocBaseJson {
    return {
        _id: doc.id,
        title: doc.title,
        parentId: doc.parentId,
        position: doc.position,
        trashedWithId: doc.trashedWithId,
        previewState: doc.previewState,
        coverImage: doc.coverImage,
        isPinned: doc.isPinned,
        isArchived: doc.isArchived,
        trashedAt: doc.trashedAt,
        cloudImages: doc.cloudImages,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

export function serializeDoc(doc: DocRow): DocJson {
    return {
        ...docBase(doc),
        user: doc.userId,
        collaborators: doc.collaborators.map((c) => ({ _id: c.id, user: c.userId, role: c.role, addedAt: c.addedAt })),
    };
}

export function serializeDocWithUsers(doc: DocWithUsers): DocWithUsersJson {
    return {
        ...docBase(doc),
        user: serializeUserSummary(doc.user),
        collaborators: doc.collaborators.map((c) => ({
            _id: c.id,
            user: serializeUserSummary(c.user),
            role: c.role,
            addedAt: c.addedAt,
        })),
    };
}

export interface DocListItemJson {
    _id: string;
    title: string;
    /** DOC_PAGES_PLAN: the doc it is a page of (null: top level), its place there, and the doc whose trashing took it. */
    parentId: string | null;
    position: number;
    trashedWithId: string | null;
    previewState: string | null;
    isPinned: boolean;
    isArchived: boolean;
    /** In the trash since then (the library's Trash view), or null. */
    trashedAt: Date | null;
    /** Published to the web since then (the library's "Shared" view), or null. */
    publishedAt: Date | null;
    coverImage: string | null;
    createdAt: Date;
    updatedAt: Date;
    user: string;
    /** Who owns it (the "Shared" view says whose a doc shared with you is). */
    owner: UserSummaryJson;
    collaborators: Array<{ role: CollaboratorRole; addedAt: Date; user: UserSummaryJson }>;
    role: DocRoleJson;
}

export function serializeDocListItem(doc: DocListRow, role: DocRoleJson): DocListItemJson {
    return {
        _id: doc.id,
        title: doc.title,
        parentId: doc.parentId,
        position: doc.position,
        trashedWithId: doc.trashedWithId,
        previewState: doc.previewState,
        isPinned: doc.isPinned,
        isArchived: doc.isArchived,
        trashedAt: doc.trashedAt,
        publishedAt: doc.publishedAt,
        coverImage: doc.coverImage,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        user: doc.userId,
        owner: serializeUserSummary(doc.user),
        collaborators: doc.collaborators.map((c) => ({ role: c.role, addedAt: c.addedAt, user: serializeUserSummary(c.user) })),
        role,
    };
}
