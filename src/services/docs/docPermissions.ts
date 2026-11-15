// Who may do what with a doc. Written once here; every doc endpoint and the Hocuspocus doc handler
// use these helpers (the Mongo version copy-pasted the checks into each handler).
//
//   owner                 → view, edit, manage (rename, pin, publish, add and remove people, answer requests)
//   collaborator 'editor' → view, edit content
//   collaborator 'viewer' → view only
//   anyone else           → nothing in the app (a published doc is readable by anyone at /p/<slug>,
//                           read-only, outside these rules: services/docs/docSharing.service.ts)
//
// Bans went with the sharing rebuild (MANAGER_AND_DOCS_PLAN §2, 2026-11-15): a removed person can ask
// again, and the owner can decline.
import type { CollaboratorRole, Prisma } from '@prisma/client';

export type DocRole = 'owner' | CollaboratorRole;

/** The parts of a doc row the permission checks need (`collaborators` may be pre-filtered to one user). */
export interface DocAccessSubject {
    userId: string;
    collaborators: ReadonlyArray<{ userId: string; role: CollaboratorRole }>;
}

export function isDocOwner(doc: { userId: string }, userId: string): boolean {
    return doc.userId === userId;
}

export function findDocCollaborator(doc: Pick<DocAccessSubject, 'collaborators'>, userId: string) {
    return doc.collaborators.find((c) => c.userId === userId);
}

/** The user's role on the doc, or null when they have no access. */
export function getDocRole(doc: DocAccessSubject, userId: string): DocRole | null {
    if (isDocOwner(doc, userId)) return 'owner';
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
 * Prisma filter with the same meaning as canViewDoc(): docs the user owns or collaborates on.
 * Mongo: { $or: [{ user: id }, { 'collaborators.user': id }] }.
 */
export function accessibleDocWhere(userId: string): Prisma.DocWhereInput {
    return { OR: [{ userId }, { collaborators: { some: { userId } } }] };
}
