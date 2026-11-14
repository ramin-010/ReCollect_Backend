// Drawing shapes, matching what the Mongo API returned.
//
// serializeDrawing        → a Drawing as .lean()/.toObject() returned it, references NOT populated:
//                           { _id, user: <ownerId>, localId, name, yjsState, thumbnail,
//                             collaborators: [{ user: <id>, role, addedAt }], cloudImages, shareToken,
//                             shareEnabled, createdAt, updatedAt }. Collaborator subdocuments had no
//                           _id (`_id: false`). yjsState/shareToken are null when unset (Mongo omitted
//                           them). No __v.
// serializeDrawingWithUsers → collaborators.user populated ('name email avatar'), and `user` too when
//                           it was populated (GET /api/drawings/:id); GET /api/drawings left `user` an id.
// serializeSharedDrawing  → GET /api/drawings/public/shared/:token: { _id, name, yjsState, owner, cloudImages }.
//
// Also exported from ./index.ts.
import type { CollaboratorRole, Prisma } from '@prisma/client';
import { serializeUserSummary, userSummarySelect, type UserSummaryJson, type UserSummaryRow } from './user';

const collaboratorOrder = [{ addedAt: 'asc' }, { userId: 'asc' }] satisfies Prisma.DrawingCollaboratorOrderByWithRelationInput[];

export const drawingRowInclude = { collaborators: { orderBy: collaboratorOrder } } satisfies Prisma.DrawingInclude;
export type DrawingRow = Prisma.DrawingGetPayload<{ include: typeof drawingRowInclude }>;

/** GET /api/drawings: collaborators populated, owner left as an id. */
export const drawingWithCollaboratorsInclude = {
    collaborators: { include: { user: { select: userSummarySelect } }, orderBy: collaboratorOrder },
} satisfies Prisma.DrawingInclude;
export type DrawingWithCollaborators = Prisma.DrawingGetPayload<{ include: typeof drawingWithCollaboratorsInclude }>;

/** GET /api/drawings/:id: owner and collaborators populated. */
export const drawingWithUsersInclude = {
    user: { select: userSummarySelect },
    collaborators: { include: { user: { select: userSummarySelect } }, orderBy: collaboratorOrder },
} satisfies Prisma.DrawingInclude;
export type DrawingWithUsers = Prisma.DrawingGetPayload<{ include: typeof drawingWithUsersInclude }>;

interface DrawingBaseJson {
    _id: string;
    localId: string;
    name: string;
    yjsState: string | null;
    thumbnail: string;
    cloudImages: Prisma.JsonValue;
    shareToken: string | null;
    shareEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface DrawingJson extends DrawingBaseJson {
    user: string;
    collaborators: Array<{ user: string; role: CollaboratorRole; addedAt: Date }>;
}

export interface DrawingWithUsersJson extends DrawingBaseJson {
    user: string | UserSummaryJson;
    collaborators: Array<{ user: UserSummaryJson; role: CollaboratorRole; addedAt: Date }>;
}

function drawingBase(drawing: DrawingRow | DrawingWithCollaborators | DrawingWithUsers): DrawingBaseJson {
    return {
        _id: drawing.id,
        localId: drawing.localId,
        name: drawing.name,
        yjsState: drawing.yjsState,
        thumbnail: drawing.thumbnail,
        cloudImages: drawing.cloudImages,
        shareToken: drawing.shareToken,
        shareEnabled: drawing.shareEnabled,
        createdAt: drawing.createdAt,
        updatedAt: drawing.updatedAt,
    };
}

export function serializeDrawing(drawing: DrawingRow): DrawingJson {
    return {
        ...drawingBase(drawing),
        user: drawing.userId,
        collaborators: drawing.collaborators.map((c) => ({ user: c.userId, role: c.role, addedAt: c.addedAt })),
    };
}

export function serializeDrawingWithUsers(drawing: DrawingWithCollaborators | DrawingWithUsers): DrawingWithUsersJson {
    const owner: UserSummaryRow | undefined = 'user' in drawing ? drawing.user : undefined;
    return {
        ...drawingBase(drawing),
        user: owner ? serializeUserSummary(owner) : drawing.userId,
        collaborators: drawing.collaborators.map((c) => ({
            user: serializeUserSummary(c.user),
            role: c.role,
            addedAt: c.addedAt,
        })),
    };
}

export const sharedDrawingSelect = {
    id: true,
    name: true,
    yjsState: true,
    cloudImages: true,
    user: { select: userSummarySelect },
} satisfies Prisma.DrawingSelect;
export type SharedDrawingRow = Prisma.DrawingGetPayload<{ select: typeof sharedDrawingSelect }>;

export interface SharedDrawingJson {
    _id: string;
    name: string;
    yjsState: string | null;
    owner: UserSummaryJson;
    cloudImages: Prisma.JsonValue;
}

export function serializeSharedDrawing(drawing: SharedDrawingRow): SharedDrawingJson {
    return {
        _id: drawing.id,
        name: drawing.name,
        yjsState: drawing.yjsState,
        owner: serializeUserSummary(drawing.user),
        // Guests need these to render the drawing's images.
        cloudImages: drawing.cloudImages,
    };
}
