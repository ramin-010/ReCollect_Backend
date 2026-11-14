// Who may do what with a drawing. Written once here; the drawing endpoints and the Hocuspocus
// drawing handler use these helpers.
//
//   owner                 → view, edit, manage (rename, delete, share links)
//   collaborator 'editor' → view, edit
//   collaborator 'viewer' → view only
//   anyone else           → nothing, unless they hold the drawing's share token while sharing is
//                           enabled: then they may open it (REST) and edit it live as a guest
//                           ("Guests can edit in real-time without logging in").
// Drawings have no banned users.
import type { CollaboratorRole, Prisma } from '@prisma/client';

export type DrawingRole = 'owner' | CollaboratorRole;

export interface DrawingAccessSubject {
    userId: string;
    collaborators: ReadonlyArray<{ userId: string; role: CollaboratorRole }>;
}

export function isDrawingOwner(drawing: { userId: string }, userId: string): boolean {
    return drawing.userId === userId;
}

/** The user's role on the drawing, or null when they have no access. */
export function getDrawingRole(drawing: DrawingAccessSubject, userId: string): DrawingRole | null {
    if (isDrawingOwner(drawing, userId)) return 'owner';
    return drawing.collaborators.find((c) => c.userId === userId)?.role ?? null;
}

export function canViewDrawing(drawing: DrawingAccessSubject, userId: string): boolean {
    return getDrawingRole(drawing, userId) !== null;
}

export function canEditDrawing(drawing: DrawingAccessSubject, userId: string): boolean {
    const role = getDrawingRole(drawing, userId);
    return role === 'owner' || role === 'editor';
}

/** A share token grants access only while sharing is enabled and the token matches exactly. */
export function isValidDrawingShareToken(
    drawing: { shareToken: string | null; shareEnabled: boolean },
    token: string | null | undefined
): boolean {
    return Boolean(token) && drawing.shareEnabled && drawing.shareToken === token;
}

/** Prisma filter with the same meaning as canViewDrawing(). */
export function accessibleDrawingWhere(userId: string): Prisma.DrawingWhereInput {
    return { OR: [{ userId }, { collaborators: { some: { userId } } }] };
}
