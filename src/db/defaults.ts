// Defaults that Mongoose computed in JS and Prisma cannot express in the schema.
// Use these when creating rows so behaviour matches the old models.
import crypto from 'crypto';

/** ShareLink.expiresAt default: now + 3 calendar days (Mongoose: date.setDate(date.getDate() + 3)). */
export function defaultShareLinkExpiry(now: Date = new Date()): Date {
    const date = new Date(now.getTime());
    date.setDate(date.getDate() + 3);
    return date;
}

/** WorkspaceInviteLink.token default (Mongoose: crypto.randomBytes(24).toString('base64url')). */
export function generateInviteToken(): string {
    return crypto.randomBytes(24).toString('base64url');
}
