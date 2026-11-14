// Doc shapes, matching what the Mongo API returned.
//
// serializeDoc           → a Doc as .lean()/.toObject() returned it, references NOT populated:
//                          { _id, user: <ownerId>, title, yjsState, previewState, docType, coverImage,
//                            isPinned, isArchived, cloudImages: [{ imageId, cloudUrl, cloudPublicId }],
//                            collaborators: [{ _id, user: <id>, role, addedAt }],
//                            bannedUsers: [{ _id, user: <id>, bannedAt }], createdAt, updatedAt }
//                          (collaborator/ban subdocuments had their own _id in Mongoose). No __v.
// serializeDocWithUsers  → GET /api/docs/:id: the same after .populate('user', 'name email') and
//                          .populate('collaborators.user', 'name email avatar').
// serializeDocListItem   → GET /api/docs: the old aggregation's $project (no yjsState, cloudImages or
//                          bans; collaborators are { role, addedAt, user: {…} } without _id) + role.
// serializeSharedByMeDoc → GET /api/docs/shared-by-me: select('title docType createdAt updatedAt
//                          collaborators') with collaborators.user populated.
//
// Also exported from ./index.ts.
import type { CollaboratorRole, DocType, Prisma } from '@prisma/client';
import { serializeUserSummary, userSummarySelect, type UserSummaryJson } from './user';

/** Mongo kept embedded arrays in insertion order. */
export const docCollaboratorOrder = [{ addedAt: 'asc' }, { id: 'asc' }] satisfies Prisma.DocCollaboratorOrderByWithRelationInput[];
export const docBannedUserOrder = [{ bannedAt: 'asc' }, { id: 'asc' }] satisfies Prisma.DocBannedUserOrderByWithRelationInput[];

/** Include for serializeDoc(). */
export const docRowInclude = {
    collaborators: { orderBy: docCollaboratorOrder },
    bannedUsers: { orderBy: docBannedUserOrder },
} satisfies Prisma.DocInclude;
export type DocRow = Prisma.DocGetPayload<{ include: typeof docRowInclude }>;

/** Include for serializeDocWithUsers(). */
export const docWithUsersInclude = {
    user: { select: userSummarySelect },
    collaborators: { include: { user: { select: userSummarySelect } }, orderBy: docCollaboratorOrder },
    bannedUsers: { orderBy: docBannedUserOrder },
} satisfies Prisma.DocInclude;
export type DocWithUsers = Prisma.DocGetPayload<{ include: typeof docWithUsersInclude }>;

/** Select for serializeDocListItem(). */
export const docListSelect = {
    id: true,
    userId: true,
    title: true,
    previewState: true,
    docType: true,
    isPinned: true,
    isArchived: true,
    coverImage: true,
    createdAt: true,
    updatedAt: true,
    collaborators: {
        select: { userId: true, role: true, addedAt: true, user: { select: userSummarySelect } },
        orderBy: docCollaboratorOrder,
    },
} satisfies Prisma.DocSelect;
export type DocListRow = Prisma.DocGetPayload<{ select: typeof docListSelect }>;

/** Select for serializeSharedByMeDoc(). */
export const sharedByMeDocSelect = {
    id: true,
    title: true,
    docType: true,
    createdAt: true,
    updatedAt: true,
    collaborators: { include: { user: { select: userSummarySelect } }, orderBy: docCollaboratorOrder },
} satisfies Prisma.DocSelect;
export type SharedByMeDocRow = Prisma.DocGetPayload<{ select: typeof sharedByMeDocSelect }>;

export type DocRoleJson = 'owner' | CollaboratorRole;

interface DocBaseJson {
    _id: string;
    title: string;
    yjsState: string | null;
    previewState: string | null;
    docType: DocType;
    coverImage: string | null;
    isPinned: boolean;
    isArchived: boolean;
    cloudImages: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
}

export interface DocJson extends DocBaseJson {
    user: string;
    collaborators: Array<{ _id: string; user: string; role: CollaboratorRole; addedAt: Date }>;
    bannedUsers: Array<{ _id: string; user: string; bannedAt: Date }>;
}

export interface DocWithUsersJson extends DocBaseJson {
    user: UserSummaryJson;
    collaborators: Array<{ _id: string; user: UserSummaryJson; role: CollaboratorRole; addedAt: Date }>;
    bannedUsers: Array<{ _id: string; user: string; bannedAt: Date }>;
}

function docBase(doc: DocRow | DocWithUsers): DocBaseJson {
    return {
        _id: doc.id,
        title: doc.title,
        yjsState: doc.yjsState,
        previewState: doc.previewState,
        docType: doc.docType,
        coverImage: doc.coverImage,
        isPinned: doc.isPinned,
        isArchived: doc.isArchived,
        cloudImages: doc.cloudImages,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

function serializeBans(bans: DocRow['bannedUsers']): DocJson['bannedUsers'] {
    return bans.map((b) => ({ _id: b.id, user: b.userId, bannedAt: b.bannedAt }));
}

export function serializeDoc(doc: DocRow): DocJson {
    return {
        ...docBase(doc),
        user: doc.userId,
        collaborators: doc.collaborators.map((c) => ({ _id: c.id, user: c.userId, role: c.role, addedAt: c.addedAt })),
        bannedUsers: serializeBans(doc.bannedUsers),
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
        bannedUsers: serializeBans(doc.bannedUsers),
    };
}

export interface DocListItemJson {
    _id: string;
    title: string;
    previewState: string | null;
    docType: DocType;
    isPinned: boolean;
    isArchived: boolean;
    coverImage: string | null;
    createdAt: Date;
    updatedAt: Date;
    user: string;
    collaborators: Array<{ role: CollaboratorRole; addedAt: Date; user: UserSummaryJson }>;
    role: DocRoleJson;
}

export function serializeDocListItem(doc: DocListRow, role: DocRoleJson): DocListItemJson {
    return {
        _id: doc.id,
        title: doc.title,
        previewState: doc.previewState,
        docType: doc.docType,
        isPinned: doc.isPinned,
        isArchived: doc.isArchived,
        coverImage: doc.coverImage,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        user: doc.userId,
        collaborators: doc.collaborators.map((c) => ({ role: c.role, addedAt: c.addedAt, user: serializeUserSummary(c.user) })),
        role,
    };
}

export interface SharedByMeDocJson {
    _id: string;
    title: string;
    docType: DocType;
    createdAt: Date;
    updatedAt: Date;
    collaborators: Array<{ _id: string; user: UserSummaryJson; role: CollaboratorRole; addedAt: Date }>;
}

export function serializeSharedByMeDoc(doc: SharedByMeDocRow): SharedByMeDocJson {
    return {
        _id: doc.id,
        title: doc.title,
        docType: doc.docType,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        collaborators: doc.collaborators.map((c) => ({
            _id: c.id,
            user: serializeUserSummary(c.user),
            role: c.role,
            addedAt: c.addedAt,
        })),
    };
}
