// Defaults that Mongoose computed in JS and Prisma cannot express in the schema.
// Use these when creating rows so behaviour matches the old models.
import crypto from 'crypto';

/** WorkspaceInviteLink.token default (Mongoose: crypto.randomBytes(24).toString('base64url')). */
export function generateInviteToken(): string {
    return crypto.randomBytes(24).toString('base64url');
}
