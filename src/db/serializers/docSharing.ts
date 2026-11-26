// Sharing shapes (MANAGER_AND_DOCS_PLAN §2: publish + people). The old share-link and access-request
// shapes (Mongo era) went with ShareLink in the 2026-11-15 rebuild.
//
// serializeDocPerson  → someone added to a doc: { _id: <their user id>, name, email, avatar, role, addedAt }
// serializeDocRequest → a pending "asks to edit": { _id: <request id>, user: {…}, role, requestedAt }
//
// Also exported from ./index.ts.
import type { CollaboratorRole, Prisma } from '@prisma/client';
import { serializeUserSummary, userSummarySelect, type UserSummaryJson } from './user';

export const docPersonSelect = {
    userId: true,
    role: true,
    addedAt: true,
    user: { select: userSummarySelect },
} satisfies Prisma.DocCollaboratorSelect;
export type DocPersonRow = Prisma.DocCollaboratorGetPayload<{ select: typeof docPersonSelect }>;

export interface DocPersonJson {
    /** Their user id (what PATCH/DELETE /api/docs/:id/people/:userId take). */
    _id: string;
    name: string;
    email: string;
    avatar: string;
    role: CollaboratorRole;
    addedAt: Date;
}

export function serializeDocPerson(row: DocPersonRow): DocPersonJson {
    return { _id: row.userId, name: row.user.name, email: row.user.email, avatar: row.user.avatar, role: row.role, addedAt: row.addedAt };
}

export const docRequestSelect = {
    id: true,
    role: true,
    requestedAt: true,
    user: { select: userSummarySelect },
} satisfies Prisma.AccessRequestSelect;
export type DocRequestRow = Prisma.AccessRequestGetPayload<{ select: typeof docRequestSelect }>;

export interface DocRequestJson {
    _id: string;
    user: UserSummaryJson;
    role: CollaboratorRole;
    requestedAt: Date;
}

export function serializeDocRequest(row: DocRequestRow): DocRequestJson {
    return { _id: row.id, user: serializeUserSummary(row.user), role: row.role, requestedAt: row.requestedAt };
}

/** A published doc's link, or null. */
export interface PublishedJson {
    url: string;
    slug: string;
    since: Date;
}

/** GET /api/docs/:id/people: the Share popover. Requests only for the owner ([] for everyone else). */
export interface DocPeopleJson {
    docId: string;
    title: string;
    owner: UserSummaryJson;
    /** The caller's own role. */
    you: 'owner' | CollaboratorRole;
    people: DocPersonJson[];
    requests: DocRequestJson[];
    published: PublishedJson | null;
    /** DOC_PAGES_PLAN D6: how many pages of the owner's are inside it (0 for anyone else): "also the N pages inside". */
    pages: number;
}
