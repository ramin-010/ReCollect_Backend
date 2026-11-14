// Users: every Prisma query on the User table goes through here.
//
// Replaces what the Mongoose model did implicitly:
//   - pre('save') bcrypt hashing          → hashPassword() in createUser / setUserPassword
//   - pre('save') reminderEmail = email   → createUser
//   - trim / maxLength(50) on name        → normalizeUserName (and VARCHAR(50) in the DB)
//   - select: false on password           → global `omit` in src/db/prisma.ts (+ *WithPassword helpers)
// Every function takes an optional `db` so it can run inside prisma.$transaction(async (tx) => …).
import crypto from 'crypto';
import type { AuthProvider, Prisma, User, UserStatus } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { containsInsensitive } from '../../db/filters';
import { isRecordNotFound } from '../../db/errors';
import { userSummarySelect, type UserSummaryRow } from '../../db/serializers';
import ErrorResponse from '../../utils/errorResponse';
import { hashPassword } from '../auth/password';
import type { AuthUser } from '../../types/auth';

export const USER_NAME_MAX_LENGTH = 50;

/** A user row without the password hash (what queries return by default). */
export type SafeUser = Omit<User, 'password'>;

/** Trim and validate a display name with the same rules/messages as the Mongoose schema. */
export function normalizeUserName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new ErrorResponse(400, 'Path `name` is required.');
    }
    if (trimmed.length > USER_NAME_MAX_LENGTH) {
        throw new ErrorResponse(
            400,
            `Path \`name\` (\`${trimmed}\`) is longer than the maximum allowed length (${USER_NAME_MAX_LENGTH}).`
        );
    }
    return trimmed;
}

/** `req.user` value: the safe row plus `_id`. */
export function toAuthUser(user: SafeUser & { password?: string | null }): AuthUser {
    const { password: _password, ...safe } = user;
    return { ...safe, _id: safe.id };
}

// ─── Reads ─────────────────────────────────────────────────────────────

export function findUserById(id: string, db: DbClient = prisma): Promise<SafeUser | null> {
    return db.user.findUnique({ where: { id } });
}

/** Exact (case-sensitive) email match, like the Mongo queries. Lowercase first where the old code did. */
export function findUserByEmail(email: string, db: DbClient = prisma): Promise<SafeUser | null> {
    return db.user.findUnique({ where: { email } });
}

/** Opt-in to the password hash (login, password checks). Never send the result to a client. */
export function findUserByEmailWithPassword(email: string, db: DbClient = prisma): Promise<User | null> {
    return db.user.findUnique({ where: { email }, omit: { password: false } });
}

export function findUserByIdWithPassword(id: string, db: DbClient = prisma): Promise<User | null> {
    return db.user.findUnique({ where: { id }, omit: { password: false } });
}

/** True if another user (not `exceptUserId`) already uses this email / reminder email. */
export async function isEmailTaken(email: string, exceptUserId: string | undefined, db: DbClient = prisma): Promise<boolean> {
    const other = await db.user.findFirst({
        where: { email, ...(exceptUserId ? { NOT: { id: exceptUserId } } : {}) },
        select: { id: true },
    });
    return other !== null;
}

export async function isReminderEmailTaken(reminderEmail: string, exceptUserId: string | undefined, db: DbClient = prisma): Promise<boolean> {
    const other = await db.user.findFirst({
        where: { reminderEmail, ...(exceptUserId ? { NOT: { id: exceptUserId } } : {}) },
        select: { id: true },
    });
    return other !== null;
}

// ─── Writes ────────────────────────────────────────────────────────────

export interface CreateUserInput {
    email: string;
    name: string;
    /** Plain password; hashed here. */
    password?: string;
    /** Already-hashed password (e.g. from an OTP signup); used as is. */
    passwordHash?: string;
    reminderEmail?: string;
    avatar?: string;
    googleId?: string;
    authProvider?: AuthProvider;
    isGhost?: boolean;
    status?: UserStatus;
}

export async function createUser(input: CreateUserInput, db: DbClient = prisma): Promise<SafeUser> {
    const email = input.email.trim();
    const name = normalizeUserName(input.name);
    const password =
        input.passwordHash ?? (input.password !== undefined ? await hashPassword(input.password) : undefined);

    const data: Prisma.UserCreateInput = {
        email,
        name,
        // Mongoose pre-save hook: reminderEmail defaults to the account email.
        reminderEmail: input.reminderEmail?.trim() || email,
    };
    if (password !== undefined) data.password = password;
    if (input.avatar !== undefined) data.avatar = input.avatar;
    if (input.googleId !== undefined) data.googleId = input.googleId;
    if (input.authProvider !== undefined) data.authProvider = input.authProvider;
    if (input.isGhost !== undefined) data.isGhost = input.isGhost;
    if (input.status !== undefined) data.status = input.status;

    return db.user.create({ data });
}

/**
 * Create a placeholder ("ghost") user for an email that has no account yet, as the workspace
 * invite and task-assign flows do: lowercased email, name = the part before '@', a random
 * (hashed, unusable) password, isGhost = true, status = 'pending'. The person claims the
 * account later by signing up with OTP or Google.
 */
export async function createPlaceholderUser(email: string, db: DbClient = prisma): Promise<SafeUser> {
    const normalizedEmail = email.toLowerCase().trim();
    const emailPrefix = normalizedEmail.split('@')[0] || normalizedEmail;
    return createUser(
        {
            email: normalizedEmail,
            name: emailPrefix.slice(0, USER_NAME_MAX_LENGTH),
            password: `ghost_${crypto.randomBytes(18).toString('hex')}`,
            isGhost: true,
            status: 'pending',
        },
        db
    );
}

/** Find a user by (lowercased) email, or create a placeholder user. `created` tells which. */
export async function findOrCreatePlaceholderUser(
    email: string,
    db: DbClient = prisma
): Promise<{ user: SafeUser; created: boolean }> {
    const normalizedEmail = email.toLowerCase().trim();
    const existing = await findUserByEmail(normalizedEmail, db);
    if (existing) return { user: existing, created: false };
    return { user: await createPlaceholderUser(normalizedEmail, db), created: true };
}

/** Turn a ghost user into a real account (OTP signup). */
export function claimGhostUser(
    userId: string,
    input: { name: string; passwordHash: string },
    db: DbClient = prisma
): Promise<SafeUser> {
    return db.user.update({
        where: { id: userId },
        data: {
            name: normalizeUserName(input.name),
            password: input.passwordHash,
            isGhost: false,
            status: 'active',
        },
    });
}

/** Partial update; returns null when the user does not exist. */
async function updateUserOrNull(userId: string, data: Prisma.UserUpdateInput, db: DbClient): Promise<SafeUser | null> {
    try {
        return await db.user.update({ where: { id: userId }, data });
    } catch (err) {
        if (isRecordNotFound(err)) return null;
        throw err;
    }
}

export interface UpdateProfileInput {
    name?: string | undefined;
    email?: string | undefined;
    phone?: string | undefined;
    reminderEmail?: string | undefined;
}

/**
 * PATCH /update-profile. Same checks and messages as before (exact-match uniqueness, excluding
 * the user). Returns null when the user does not exist.
 */
export async function updateUserProfile(
    userId: string,
    input: UpdateProfileInput,
    db: DbClient = prisma
): Promise<SafeUser | null> {
    const data: Prisma.UserUpdateInput = {};
    if (input.name !== undefined) data.name = normalizeUserName(input.name);
    if (input.phone !== undefined) data.phone = input.phone.trim();
    if (input.email !== undefined) data.email = input.email.trim();
    if (input.reminderEmail !== undefined) data.reminderEmail = input.reminderEmail.trim();

    if (input.email && (await isEmailTaken(input.email.trim(), userId, db))) {
        throw new ErrorResponse(400, 'Email already in use');
    }
    if (input.reminderEmail && (await isReminderEmailTaken(input.reminderEmail.trim(), userId, db))) {
        throw new ErrorResponse(400, 'This alternative email is already in use by another account');
    }

    return updateUserOrNull(userId, data, db);
}

/** Set the avatar; returns the user as it was BEFORE the update (to delete the old image), or null. */
export async function setUserAvatar(
    userId: string,
    avatar: { url: string; cloudPublicId: string; cloudProvider: string },
    db: DbClient = prisma
): Promise<SafeUser | null> {
    const previous = await findUserById(userId, db);
    if (!previous) return null;
    await db.user.update({
        where: { id: userId },
        data: { avatar: avatar.url, cloudPublicId: avatar.cloudPublicId, cloudProvider: avatar.cloudProvider },
    });
    return previous;
}

/** Hash and store a new password. Returns null when the user does not exist. */
export async function setUserPassword(userId: string, plainPassword: string, db: DbClient = prisma): Promise<SafeUser | null> {
    return updateUserOrNull(userId, { password: await hashPassword(plainPassword) }, db);
}

/**
 * Link a Google account on login (same rules as before): a ghost user is claimed, and if the
 * account has no googleId yet it gets googleId, authProvider 'google' and the Google picture
 * when it has no avatar. Writes only when something changed (Mongoose skipped no-op saves).
 */
export async function applyGoogleLogin(
    user: SafeUser,
    google: { googleId: string; picture: string | undefined },
    db: DbClient = prisma
): Promise<SafeUser> {
    const data: Prisma.UserUpdateInput = {};
    if (user.isGhost) {
        data.isGhost = false;
        data.status = 'active';
    }
    if (!user.googleId) {
        data.googleId = google.googleId;
        data.authProvider = 'google';
        if (google.picture && !user.avatar) data.avatar = google.picture;
    }
    if (Object.keys(data).length === 0) return user;
    return db.user.update({ where: { id: user.id }, data });
}

export const OWNS_SHARED_WORKSPACE_MESSAGE = 'Transfer ownership or remove other members before deleting your account';

/**
 * Delete the account. Owned rows (docs, todos, owned workspaces, …) cascade; see prisma/schema.prisma.
 * Refused with 409 while the user owns a workspace that has other members: the cascade would delete
 * that workspace (and everyone's tasks in it). Workspaces where the owner is the only member still
 * cascade. The check is part of the DELETE statement itself (a NOT EXISTS subquery), so there is no
 * separate check-then-delete window. Returns false when the user does not exist.
 */
export async function deleteUser(userId: string, db: DbClient = prisma): Promise<boolean> {
    const { count } = await db.user.deleteMany({
        where: {
            id: userId,
            ownedWorkspaces: { none: { members: { some: { userId: { not: userId } } } } },
        },
    });
    if (count > 0) return true;

    const blocking = await db.workspace.findFirst({
        where: { ownerId: userId, members: { some: { userId: { not: userId } } } },
        select: { id: true },
    });
    if (blocking) {
        throw new ErrorResponse(409, OWNS_SHARED_WORKSPACE_MESSAGE);
    }
    return false;
}

// ─── Search ────────────────────────────────────────────────────────────

/**
 * GET /search (assignee picker): name or email contains `query` (case-insensitive, wildcards
 * escaped), excluding the current user and ghost users, at most 10 results.
 */
export function searchUsers(
    query: string,
    excludeUserId: string | undefined,
    db: DbClient = prisma,
    limit = 10
): Promise<UserSummaryRow[]> {
    const filter = containsInsensitive(query);
    return db.user.findMany({
        where: {
            ...(excludeUserId ? { NOT: { id: excludeUserId } } : {}),
            isGhost: false,
            OR: [{ name: filter }, { email: filter }],
        },
        select: userSummarySelect,
        // Mongo returned natural (insertion) order.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
    });
}
