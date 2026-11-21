// Who may use the AI, and how high a cap may go (hosting P1-5).
//   AI_ALLOWED_EMAILS: only these accounts use any AI (comma or space separated); unset: everyone.
//     Every AI route answers 403 to the others (requireAiAccess), and the checks every AI entry
//     already makes (services/claude/usage.service.ts: assertUnderCap, isUnderCap; the buddy's
//     buddyMaySpend) refuse them too, so background work (the buddy, the nightly Recall batch)
//     never spends for them.
//   AI_MAX_CAP_USD: the highest monthly cap an account may set itself (default 1000).
import type { RequestHandler } from 'express';
import { prisma } from '../db/prisma';
import { AiHttpError } from '../services/claude/errors';

/** Today's bound on the self-set cap, kept when AI_MAX_CAP_USD is unset. */
export const MAX_MONTHLY_CAP_USD = 1000;

export function aiAllowedEmails(env: NodeJS.ProcessEnv = process.env): string[] | null {
    const list = (env['AI_ALLOWED_EMAILS'] ?? '')
        .split(/[\s,]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
    return list.length ? list : null;
}

/**
 * Whether this account may use the AI. Stage 10: an account on its own key may, whatever the list says (the list
 * governs the server's key only). Stage 11: so may a person the owner gave free AI to (their allowance decides,
 * src/services/claude/allowance.ts); an account whose access the owner ended may not.
 */
export async function aiAllowedFor(userId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    const list = aiAllowedEmails(env);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, accessEndedAt: true } });
    if (!user || user.accessEndedAt) return false;
    if (!list) return true;
    if ((await prisma.aiKey.count({ where: { userId, removedAt: null } })) > 0) return true;
    if ((await prisma.aiGrant.count({ where: { userId } })) > 0) return true;
    return list.includes(user.email.trim().toLowerCase());
}

export const aiNotAllowed = (): AiHttpError => new AiHttpError(403, 'AI_NOT_ALLOWED', 'The AI is not available to this account on this server.');

/** 403 AI_NOT_ALLOWED unless aiAllowedFor. */
export async function assertAiAllowed(userId: string): Promise<void> {
    if (!(await aiAllowedFor(userId))) throw aiNotAllowed();
}

/** For the AI routers, after the login check. */
export const requireAiAccess: RequestHandler = (req, _res, next) => {
    const userId = req.user?.id;
    if (!userId) return next();
    aiAllowedFor(userId).then(
        (ok) => next(ok ? undefined : aiNotAllowed()),
        (err: unknown) => next(err),
    );
};

/** The highest monthly cap an account may set: AI_MAX_CAP_USD when it is a number from 0, else 1000. */
export function aiMaxCapUsd(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env['AI_MAX_CAP_USD']?.trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : MAX_MONTHLY_CAP_USD;
}
