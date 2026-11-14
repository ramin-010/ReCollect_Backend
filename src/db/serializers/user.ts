// User shapes, matching what the Mongo API returned.
//
// serializeUser        → the full user minus password (login/signup/get-me/profile/settings bodies).
//                        Mongo returned the whole document; the cut fields (archivedNotes,
//                        favoriteNotes, gmail*) and __v are no longer included.
// serializeUserSummary → the nested user object of populate('…', 'name email avatar'):
//                        { _id, name, email, avatar }. Used for owners, members, assignees,
//                        collaborators, senders, search results. Old populates that selected
//                        fewer fields ('name email', 'name') now get this superset, which the
//                        frontend accepts.
import type { User } from '@prisma/client';

/** Select this in Prisma queries that feed serializeUserSummary (e.g. include: { user: { select: userSummarySelect } }). */
export const userSummarySelect = {
    id: true,
    name: true,
    email: true,
    avatar: true,
} as const;

export interface UserSummaryRow {
    id: string;
    name: string;
    email: string;
    avatar: string;
}

export interface UserSummaryJson {
    _id: string;
    name: string;
    email: string;
    avatar: string;
}

export function serializeUserSummary(user: UserSummaryRow): UserSummaryJson {
    return { _id: user.id, name: user.name, email: user.email, avatar: user.avatar };
}

/** Same as serializeUserSummary but passes null through (a SET NULL / missing relation). */
export function serializeUserSummaryOrNull(user: UserSummaryRow | null | undefined): UserSummaryJson | null {
    return user ? serializeUserSummary(user) : null;
}

/** A user row without the password hash (what the global `omit` returns). */
export type SafeUserRow = Omit<User, 'password'>;

export interface UserJson {
    _id: string;
    name: string;
    email: string;
    reminderEmail: string | null;
    phone: string;
    avatar: string;
    cloudPublicId: string;
    cloudProvider: string;
    status: SafeUserRow['status'];
    isGhost: boolean;
    googleId: string;
    authProvider: SafeUserRow['authProvider'];
    createdAt: Date;
    updatedAt: Date;
}

/** Full user JSON without the password. Safe to call with a row that includes the password. */
export function serializeUser(user: SafeUserRow & { password?: string | null }): UserJson {
    return {
        _id: user.id,
        name: user.name,
        email: user.email,
        reminderEmail: user.reminderEmail,
        phone: user.phone,
        avatar: user.avatar,
        cloudPublicId: user.cloudPublicId,
        cloudProvider: user.cloudProvider,
        status: user.status,
        isGhost: user.isGhost,
        googleId: user.googleId,
        authProvider: user.authProvider,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
}
