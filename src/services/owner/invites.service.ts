// Invites (ECOSYSTEM_V2_PLAN stage 11, the owner's decision 1): the owner adds a person on the People page and gets a
// one-time link (/signup?invite=<code>) to send them. Signup stays closed (SIGNUP_MODE); an open invite lets its email
// make an account once, within 14 days, unless revoked. The email's code and Google prove the address, so those
// flows need only the email to match; the password route, which proves nothing, needs the link's code too. When the
// account is made (or a placeholder claimed), the invite is used and its allowance becomes the person's first grant.
import crypto from 'crypto';
import type { SignupInvite } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { signupAllowed, SIGNUP_CLOSED_MESSAGE } from '../../config/signup';
import ErrorResponse from '../../utils/errorResponse';
import { giveAllowance } from '../claude/allowance';

/** An invite is open this long. */
export const INVITE_DAYS = 14;

export type InviteState = 'open' | 'used' | 'expired' | 'revoked';

export function inviteState(row: Pick<SignupInvite, 'usedAt' | 'revokedAt' | 'expiresAt'>, now: Date = new Date()): InviteState {
    if (row.usedAt) return 'used';
    if (row.revokedAt) return 'revoked';
    return row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'open';
}

const appUrl = (): string => (process.env['FRONTEND_URL'] || 'http://localhost:3005').replace(/\/+$/, '');
export const inviteLink = (code: string): string => `${appUrl()}/signup?invite=${encodeURIComponent(code)}`;

/** A new code: 18 random bytes, URL-safe (24 characters). */
export const newInviteCode = (): string => crypto.randomBytes(18).toString('base64url');

const normal = (email: string) => email.trim().toLowerCase();

/** The newest open invite for this email, or null. */
export async function openInviteFor(email: string, now: Date = new Date(), db: DbClient = prisma): Promise<SignupInvite | null> {
    return db.signupInvite.findFirst({ where: { email: normal(email), usedAt: null, revokedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
}

export interface InviteView {
    email: string;
    name: string;
    /** The first name of who invited them ("Someone" when unknown). */
    from: string;
    allowanceUsd: number;
    state: InviteState;
}

/** GET /api/invites/:code (no login): what the signup page shows. Null for a code that never existed. */
export async function inviteView(code: string, now: Date = new Date()): Promise<InviteView | null> {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) return null;
    const row = await prisma.signupInvite.findUnique({ where: { code }, include: { invitedBy: { select: { name: true } } } });
    if (!row) return null;
    const from = row.invitedBy?.name.trim().split(/\s+/)[0] || 'Someone';
    return { email: row.email, name: row.name, from, allowanceUsd: Number(row.allowanceUsd), state: inviteState(row, now) };
}

/**
 * Whether a new account (or a placeholder's claim) may be made for this email: SIGNUP_MODE says so, or an open invite
 * for it exists. `needCode`: the route proves nothing about the address (the password route), so the invite's code
 * must come with it. 403 otherwise, with the closed-signup words.
 */
export async function assertMayMakeAccount(email: string, opts: { code?: string | undefined; needCode?: boolean } = {}, now: Date = new Date(), db: DbClient = prisma): Promise<void> {
    if (signupAllowed(email)) return;
    const invite = await openInviteFor(email, now, db);
    if (invite && (!opts.needCode || (opts.code && safeEqual(opts.code, invite.code)))) return;
    throw new ErrorResponse(403, SIGNUP_CLOSED_MESSAGE);
}

function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * After an account was made or claimed for this email: its open invite (if any) is used, and the invite's allowance
 * becomes the first grant, given by who invited them. Safe to call when there is none.
 */
export async function useInviteFor(email: string, userId: string, now: Date = new Date(), db: DbClient = prisma): Promise<boolean> {
    const invite = await openInviteFor(email, now, db);
    if (!invite) return false;
    // Claimed first, so two sign-ins at once never give it twice.
    const claimed = await db.signupInvite.updateMany({ where: { id: invite.id, usedAt: null }, data: { usedAt: now, usedById: userId } });
    if (claimed.count === 0) return false;
    if (Number(invite.allowanceUsd) > 0) await giveAllowance(userId, Number(invite.allowanceUsd), invite.invitedById, 'Invite', db);
    return true;
}

/** The owner's new invite (an open one for the same email is revoked first, so one link works at a time). */
export async function createInvite(ownerId: string, input: { email: string; name: string; allowanceUsd: number }, now: Date = new Date()): Promise<SignupInvite> {
    const email = normal(input.email);
    await prisma.signupInvite.updateMany({ where: { email, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    return prisma.signupInvite.create({
        data: {
            email,
            name: input.name.replace(/\s+/g, ' ').trim().slice(0, 50),
            code: newInviteCode(),
            allowanceUsd: (Math.round(input.allowanceUsd * 100) / 100).toFixed(2),
            invitedById: ownerId,
            createdAt: now,
            expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000),
        },
    });
}

/** The owner's Revoke: the link stops working (a used one stays as it was). */
export async function revokeInvite(id: string, now: Date = new Date()): Promise<boolean> {
    const r = await prisma.signupInvite.updateMany({ where: { id, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    return r.count > 0;
}
