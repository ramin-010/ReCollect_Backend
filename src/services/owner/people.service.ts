// The People page (ECOSYSTEM_V2_PLAN stage 11, the owner's decision 1; /owner, the owner only): every account on this
// server with its AI (whose key, the free allowance: given, used by feature, left, today, the limit a day), when it
// was last active, its phone's diagnostics; the open invites; the friends' ceiling and this month's total; what
// people sent. The owner adds a person (an invite link, or a grant for an account that exists), tops up, sets the
// limit a day, ends or restores access. Numbers and names only: never what anyone wrote, except their feedback.
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { allowanceOf, friendsCeilingUsd, friendsMonthSpend, giveAllowance, INVITE_ALLOWANCE_USD, isOwnerAccount, MAX_GRANT_USD, type AllowanceJson } from '../claude/allowance';
import { aiAllowedEmails } from '../../config/aiAccess';
import { poke } from '../scheduler/scheduler';
import { createInvite, inviteLink, inviteState, type InviteState } from './invites.service';

/** The meter's features in the owner's words (one line per group). */
export const FEATURE_GROUPS: ReadonlyArray<{ label: string; features: readonly string[] }> = [
    { label: 'Ask AI', features: ['assistant', 'doc_ask'] },
    { label: 'The buddy', features: ['buddy_gate', 'buddy_digest', 'buddy_think', 'buddy_pulse', 'buddy_check', 'buddy_work'] },
    { label: 'Recall', features: ['recall_questions', 'recall_grade'] },
    { label: 'Notes and coach', features: ['practice_note', 'weekly_coach', 'task_parse'] },
];

export type PersonAi = 'own_key' | 'allowance' | 'list' | 'none';

export interface PhoneDiagnostics {
    at: string;
    details: Record<string, unknown>;
}

export interface PersonJson {
    id: string;
    name: string;
    email: string;
    joined: string;
    /** The newest of: the app opened (a day), an AI call, an agent's call. */
    lastActive: string | null;
    isOwner: boolean;
    endedAt: string | null;
    ai: PersonAi;
    allowance: AllowanceJson | null;
    /** A friend: their spend on the server's key since the first grant; anyone else: the last 30 days. */
    byFeature: Array<{ label: string; usd: number }>;
    last7Usd: number;
    /** Apps connected with a token used in the last 30 days (Claude Code, claude.ai, ChatGPT, the phone). */
    appsConnected: number;
    phone: PhoneDiagnostics | null;
}

export interface InviteJson {
    id: string;
    email: string;
    name: string;
    allowanceUsd: number;
    link: string;
    state: InviteState;
    createdAt: string;
    expiresAt: string;
}

export interface FeedbackJson {
    id: string;
    personId: string;
    name: string;
    text: string;
    source: string;
    page: string | null;
    at: string;
}

export interface PeopleJson {
    people: PersonJson[];
    invites: InviteJson[];
    friends: { ceilingUsd: number; month: string; spentUsd: number };
    feedback: FeedbackJson[];
    /** What a new person gets ($5). */
    inviteAllowanceUsd: number;
}

const num = (v: Prisma.Decimal | number | null | undefined) => Math.round(Number(v ?? 0) * 100) / 100;
const DAY_MS = 86_400_000;

function groupFeatures(rows: Array<{ feature: string; usd: number }>): Array<{ label: string; usd: number }> {
    return FEATURE_GROUPS.map((g) => ({ label: g.label, usd: num(rows.filter((r) => g.features.includes(r.feature)).reduce((s, r) => s + r.usd, 0)) })).filter((g) => g.usd > 0);
}

/** GET /api/owner/people */
export async function peopleView(now: Date = new Date()): Promise<PeopleJson> {
    const d30 = new Date(now.getTime() - 30 * DAY_MS);
    const d7 = new Date(now.getTime() - 7 * DAY_MS);
    const [users, granted, sinceGrant, month, tokens, keys, diagnostics, invites, feedback, ceilingUsd, friends] = await Promise.all([
        prisma.user.findMany({ where: { isGhost: false }, select: { id: true, name: true, email: true, createdAt: true, lastSeenDay: true, accessEndedAt: true }, orderBy: { createdAt: 'asc' } }),
        prisma.aiGrant.groupBy({ by: ['userId'], _count: { _all: true } }),
        prisma.$queryRaw<Array<{ userId: string; feature: string; usd: Prisma.Decimal | null }>>`
            SELECT u."userId", u."feature"::text AS feature, SUM(u."costUsd") AS usd
            FROM "AiUsage" u JOIN (SELECT "userId", MIN("createdAt") AS since FROM "AiGrant" GROUP BY 1) g ON g."userId" = u."userId"
            WHERE u."source" = 'house' AND u."createdAt" >= g.since GROUP BY 1, 2`,
        prisma.$queryRaw<Array<{ userId: string; feature: string; usd: Prisma.Decimal | null; week: Prisma.Decimal | null; last: Date | null }>>`
            SELECT "userId", "feature"::text AS feature, SUM("costUsd") AS usd, SUM("costUsd") FILTER (WHERE "createdAt" >= ${d7}) AS week, MAX("createdAt") AS last
            FROM "AiUsage" WHERE "createdAt" >= ${d30} GROUP BY 1, 2`,
        prisma.apiToken.groupBy({ by: ['userId'], where: { revokedAt: null, lastUsedAt: { gte: d30 } }, _count: { _all: true }, _max: { lastUsedAt: true } }),
        prisma.aiKey.groupBy({ by: ['userId'], where: { removedAt: null }, _count: { _all: true } }),
        prisma.feedback.findMany({ where: { kind: 'diagnostics' }, orderBy: { createdAt: 'desc' }, take: 200, select: { userId: true, details: true, createdAt: true } }),
        prisma.signupInvite.findMany({ where: { usedAt: null }, orderBy: { createdAt: 'desc' }, take: 50 }),
        prisma.feedback.findMany({ where: { kind: 'feedback' }, orderBy: { createdAt: 'desc' }, take: 50, include: { user: { select: { name: true } } } }),
        friendsCeilingUsd(),
        friendsMonthSpend(now),
    ]);
    const list = aiAllowedEmails();
    const hasGrant = new Set(granted.map((g) => g.userId));
    const hasKey = new Set(keys.map((k) => k.userId));
    const tokenOf = new Map(tokens.map((t) => [t.userId, t]));
    const phoneOf = new Map<string, PhoneDiagnostics>();
    for (const d of diagnostics) if (!phoneOf.has(d.userId)) phoneOf.set(d.userId, { at: d.createdAt.toISOString(), details: (d.details ?? {}) as Record<string, unknown> });

    const people: PersonJson[] = [];
    for (const u of users) {
        const isOwner = await isOwnerAccount(u.id);
        const friend = hasGrant.has(u.id) && !isOwner;
        const allowance = friend ? await allowanceOf(u.id, now) : null;
        const mine30 = month.filter((r) => r.userId === u.id);
        const byFeature = friend
            ? groupFeatures(sinceGrant.filter((r) => r.userId === u.id).map((r) => ({ feature: r.feature, usd: Number(r.usd ?? 0) })))
            : groupFeatures(mine30.map((r) => ({ feature: r.feature, usd: Number(r.usd ?? 0) })));
        const lastAi = mine30.reduce<Date | null>((m, r) => (r.last && (!m || r.last > m) ? r.last : m), null);
        const tok = tokenOf.get(u.id);
        const seen = u.lastSeenDay ? new Date(u.lastSeenDay.getTime() + 12 * 3600_000) : null; // a day: its middle
        const times = [seen, lastAi, tok?._max.lastUsedAt ?? null].filter((t): t is Date => !!t);
        const lastActive = times.length ? new Date(Math.min(now.getTime(), Math.max(...times.map((t) => t.getTime())))).toISOString() : null;
        const ai: PersonAi = hasKey.has(u.id) ? 'own_key' : friend ? 'allowance' : !list || list.includes(u.email.trim().toLowerCase()) ? 'list' : 'none';
        people.push({
            id: u.id,
            name: u.name,
            email: u.email,
            joined: u.createdAt.toISOString(),
            lastActive,
            isOwner,
            endedAt: u.accessEndedAt?.toISOString() ?? null,
            ai,
            allowance,
            byFeature,
            last7Usd: num(mine30.reduce((s, r) => s + Number(r.week ?? 0), 0)),
            appsConnected: tok?._count._all ?? 0,
            phone: phoneOf.get(u.id) ?? null,
        });
    }
    // The owner first, then friends, then the rest; the most recently active first within each.
    const rank = (p: PersonJson) => (p.isOwner ? 0 : p.ai === 'allowance' ? 1 : 2);
    people.sort((a, b) => rank(a) - rank(b) || (b.lastActive ?? '').localeCompare(a.lastActive ?? ''));

    return {
        people,
        invites: invites
            .filter((i) => !i.revokedAt)
            .map((i) => ({ id: i.id, email: i.email, name: i.name, allowanceUsd: num(i.allowanceUsd), link: inviteLink(i.code), state: inviteState(i, now), createdAt: i.createdAt.toISOString(), expiresAt: i.expiresAt.toISOString() })),
        friends: { ceilingUsd, month: friends.month, spentUsd: num(friends.spentUsd) },
        feedback: feedback.map((f) => ({
            id: f.id,
            personId: f.userId,
            name: f.user.name,
            text: f.text,
            source: f.source,
            page: typeof (f.details as { page?: unknown } | null)?.page === 'string' ? String((f.details as { page: string }).page) : null,
            at: f.createdAt.toISOString(),
        })),
        inviteAllowanceUsd: INVITE_ALLOWANCE_USD,
    };
}

export type AddPersonResult = { kind: 'invite'; invite: InviteJson } | { kind: 'granted'; personId: string; name: string };

/**
 * POST /api/owner/people {email, name, allowanceUsd}: a new person gets a one-time invite link (their allowance waits
 * on it); an account that already exists gets the allowance at once.
 */
export async function addPerson(ownerId: string, input: { email: string; name: string; allowanceUsd: number }, now: Date = new Date()): Promise<AddPersonResult> {
    const email = input.email.trim().toLowerCase();
    if (!Number.isFinite(input.allowanceUsd) || input.allowanceUsd < 0 || input.allowanceUsd > MAX_GRANT_USD) throw new ErrorResponse(400, `The free AI is from $0 to $${MAX_GRANT_USD}.`);
    const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true, name: true, isGhost: true } });
    if (existing && !existing.isGhost) {
        if (await isOwnerAccount(existing.id)) throw new ErrorResponse(400, 'That is your own account: it uses the server’s key as it is.');
        if (input.allowanceUsd > 0) await giveAllowance(existing.id, input.allowanceUsd, ownerId, 'Added on the People page');
        poke('capture', 'buddy');
        return { kind: 'granted', personId: existing.id, name: existing.name };
    }
    const row = await createInvite(ownerId, { email, name: input.name, allowanceUsd: input.allowanceUsd }, now);
    return {
        kind: 'invite',
        invite: { id: row.id, email: row.email, name: row.name, allowanceUsd: num(row.allowanceUsd), link: inviteLink(row.code), state: inviteState(row, now), createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString() },
    };
}

async function personOrThrow(userId: string): Promise<{ id: string; name: string; accessEndedAt: Date | null }> {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, accessEndedAt: true, isGhost: true } });
    if (!row || row.isGhost) throw new ErrorResponse(404, 'No such person');
    return row;
}

/** POST /api/owner/people/:id/top-up {amountUsd, note?}: more free AI; held words and the buddy go on at once. */
export async function topUp(ownerId: string, userId: string, amountUsd: number, note = 'Top-up'): Promise<void> {
    await personOrThrow(userId);
    if (await isOwnerAccount(userId)) throw new ErrorResponse(400, 'Your own account uses the server’s key as it is.');
    await giveAllowance(userId, amountUsd, ownerId, note || 'Top-up');
    poke('capture', 'buddy');
}

/** POST /api/owner/people/:id/end-access: no sign-in and no request from now on; the account and its data stay. */
export async function endAccess(ownerId: string, userId: string, now: Date = new Date()): Promise<void> {
    if (ownerId === userId || (await isOwnerAccount(userId))) throw new ErrorResponse(400, 'You can’t end your own access.');
    await personOrThrow(userId);
    await prisma.user.update({ where: { id: userId }, data: { accessEndedAt: now }, select: { id: true } });
}

/** POST /api/owner/people/:id/restore-access */
export async function restoreAccess(userId: string): Promise<void> {
    await personOrThrow(userId);
    await prisma.user.update({ where: { id: userId }, data: { accessEndedAt: null }, select: { id: true } });
    poke('capture', 'buddy');
}
