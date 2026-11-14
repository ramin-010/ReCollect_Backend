// Share-link and access-request shapes, matching what the Mongo API returned.
//
// serializeSharedDocLink → GET /api/doc/:slug: the ShareLink after
//                          .populate({ path: 'doc', select: 'title yjsState docType isPinned createdAt
//                          updatedAt coverImage cloudImages' }):
//                          { _id, user: <ownerId>, type: 'doc', role, doc: { _id, title, yjsState, docType,
//                            isPinned, createdAt, updatedAt, coverImage, cloudImages }, slug, expiresAt,
//                            createdAt, updatedAt }. The cut content/dashboard/slide refs are gone. No __v.
// serializeAccessRequest → an AccessRequest with user populated ('name email avatar') and doc either
//                          unpopulated (<docId>, GET /api/docs/:id/requests) or populated with 'title'
//                          ({ _id, title }, GET /api/docs/pending-requests):
//                          { _id, user: {…}, doc, shareLink: <id>, status, role, requestedAt,
//                            respondedAt (null while pending; Mongo omitted it), createdAt, updatedAt }
//
// Also exported from ./index.ts.
import type { AccessRequestStatus, CollaboratorRole, DocType, Prisma, ShareLinkType } from '@prisma/client';
import { serializeUserSummary, userSummarySelect, type UserSummaryJson } from './user';

/** The doc fields GET /api/doc/:slug returned. */
export const sharedDocSelect = {
    id: true,
    title: true,
    yjsState: true,
    docType: true,
    isPinned: true,
    createdAt: true,
    updatedAt: true,
    coverImage: true,
    cloudImages: true,
} satisfies Prisma.DocSelect;

export const sharedDocLinkInclude = { doc: { select: sharedDocSelect } } satisfies Prisma.ShareLinkInclude;
export type SharedDocLinkRow = Prisma.ShareLinkGetPayload<{ include: typeof sharedDocLinkInclude }>;

export interface SharedDocLinkJson {
    _id: string;
    user: string;
    type: ShareLinkType;
    role: CollaboratorRole;
    doc: {
        _id: string;
        title: string;
        yjsState: string | null;
        docType: DocType;
        isPinned: boolean;
        createdAt: Date;
        updatedAt: Date;
        coverImage: string | null;
        cloudImages: Prisma.JsonValue;
    };
    slug: string;
    expiresAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

export function serializeSharedDocLink(link: SharedDocLinkRow): SharedDocLinkJson {
    const { doc } = link;
    return {
        _id: link.id,
        user: link.userId,
        type: link.type,
        role: link.role,
        doc: {
            _id: doc.id,
            title: doc.title,
            yjsState: doc.yjsState,
            docType: doc.docType,
            isPinned: doc.isPinned,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
            coverImage: doc.coverImage,
            cloudImages: doc.cloudImages,
        },
        slug: link.slug,
        expiresAt: link.expiresAt,
        createdAt: link.createdAt,
        updatedAt: link.updatedAt,
    };
}

/** Include for an access request whose doc stays an id. */
export const accessRequestInclude = { user: { select: userSummarySelect } } satisfies Prisma.AccessRequestInclude;
export type AccessRequestRow = Prisma.AccessRequestGetPayload<{ include: typeof accessRequestInclude }>;

/** Include for an access request with its doc's title (the owner's "pending requests" panel). */
export const accessRequestWithDocInclude = {
    user: { select: userSummarySelect },
    doc: { select: { id: true, title: true } },
} satisfies Prisma.AccessRequestInclude;
export type AccessRequestWithDocRow = Prisma.AccessRequestGetPayload<{ include: typeof accessRequestWithDocInclude }>;

export interface AccessRequestJson {
    _id: string;
    user: UserSummaryJson;
    doc: string | { _id: string; title: string };
    shareLink: string;
    status: AccessRequestStatus;
    role: CollaboratorRole;
    requestedAt: Date;
    respondedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export function serializeAccessRequest(request: AccessRequestRow | AccessRequestWithDocRow): AccessRequestJson {
    const doc = 'doc' in request ? { _id: request.doc.id, title: request.doc.title } : request.docId;
    return {
        _id: request.id,
        user: serializeUserSummary(request.user),
        doc,
        shareLink: request.shareLinkId,
        status: request.status,
        role: request.role,
        requestedAt: request.requestedAt,
        respondedAt: request.respondedAt,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
    };
}
