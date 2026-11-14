// Who may do what with a doc. Written once here; every doc endpoint and the Hocuspocus doc handler
// use these helpers (the Mongo version copy-pasted the checks into each handler).
//
//   owner                 → view, edit, manage (rename, pin, share, approve requests, remove people)
//   collaborator 'editor' → view, edit content
//   collaborator 'viewer' → view only
//   banned user           → nothing (removed by the owner; only a new share link lifts the ban)
//   anyone else           → nothing
//
// A banned user is never also a collaborator through the API (removing someone deletes the
// collaborator row and bans them in one transaction), but if both rows ever exist the ban wins.
// The owner is never treated as banned.
import type { CollaboratorRole, Prisma } from '@prisma/client';

export type DocRole = 'owner' | CollaboratorRole;

/** The parts of a doc row the permission checks need. `bannedUsers` may be pre-filtered to one user. */
export interface DocAccessSubject {
    userId: string;
    collaborators: ReadonlyArray<{ userId: string; role: CollaboratorRole }>;
    bannedUsers?: ReadonlyArray<{ userId: string }> | undefined;
}

export function isDocOwner(doc: { userId: string }, userId: string): boolean {
    return doc.userId === userId;
}

export function isBannedFromDoc(doc: DocAccessSubject, userId: string): boolean {
    return doc.bannedUsers?.some((b) => b.userId === userId) ?? false;
}

export function findDocCollaborator(doc: Pick<DocAccessSubject, 'collaborators'>, userId: string) {
    return doc.collaborators.find((c) => c.userId === userId);
}

/** The user's role on the doc, or null when they have no access. */
export function getDocRole(doc: DocAccessSubject, userId: string): DocRole | null {
    if (isDocOwner(doc, userId)) return 'owner';
    if (isBannedFromDoc(doc, userId)) return null;
    return findDocCollaborator(doc, userId)?.role ?? null;
}

/** Owner or any collaborator (editors and viewers). */
export function canViewDoc(doc: DocAccessSubject, userId: string): boolean {
    return getDocRole(doc, userId) !== null;
}

/** Owner or an editor. */
export function canEditDoc(doc: DocAccessSubject, userId: string): boolean {
    const role = getDocRole(doc, userId);
    return role === 'owner' || role === 'editor';
}

/**
 * Prisma filter with the same meaning as canViewDoc(): docs the user owns, or collaborates on
 * without being banned. Mongo: { $or: [{ user: id }, { 'collaborators.user': id }] }.
 */
export function accessibleDocWhere(userId: string): Prisma.DocWhereInput {
    return {
        OR: [
            { userId },
            { collaborators: { some: { userId } }, bannedUsers: { none: { userId } } },
        ],
    };
}
