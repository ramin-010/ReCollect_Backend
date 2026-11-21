// Free AI for invited friends (ECOSYSTEM_V2_PLAN stage 11, the owner's decision 1, 11-20): the owner gives a person a
// one-time allowance on the server's key ($5 when their invite is used) and tops it up from the People page.
//
// The rule (code, never a model):
//   - a person with any AiGrant who is not the owner (OWNER_EMAIL) is "on an allowance": the server's key serves them
//     only while what they were given exceeds what they spent on it since their first grant (AiUsage, source "house");
//   - they are also held to a limit a day (AiSettings.dailyCapUsd, $1 when unset) and to one monthly ceiling for all
//     friends together (FRIENDS_MONTHLY_CEILING_USD, $25 by default; the owner changes it on the People page);
//   - out of any of the three, their AI is in the calm paused state (stage 2): one line, everything else works, the
//     buddy's background waits (a hook holds the words), and a top-up lets it go on (the catch-up that exists);
//   - their own key, when they add one, is used first and spends nothing of the owner's (keyFor, stage 10);
//   - a call already on its way may pass $0 by its own cost (the check is before each call).
// The owner's own account is never on an allowance, and nothing here changes it.
import { Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { ownerEmail } from '../../config/owner';
import { addDays, endOfMonth, resolveTimeZone, startOfDay, startOfMonth, today as todayIn } from '../learning';
import { AiHttpError } from './errors';

/** The owner's decision: a friend's first allowance (an invite's default). */
export const INVITE_ALLOWANCE_USD = 5;
/** A friend's limit a day on the server's key when the owner has not set one. */
export const FRIEND_DAILY_CAP_USD = 1;
/** All friends together, a month, when neither the People page nor FRIENDS_MONTHLY_CEILING_USD says otherwise. */
export const DEFAULT_FRIENDS_CEILING_USD = 25;
/** ServerSetting key of the ceiling the owner set on the People page. */
export const CEILING_SETTING = 'friendsMonthlyCeilingUsd';
/** The highest amount one top-up, one allowance or the ceiling may be (a typo guard). */
export const MAX_GRANT_USD = 500;

/** Why a friend's AI waits: their allowance is used up, today's limit is reached, or the friends' ceiling this month. */
export type AllowanceReason = 'empty' | 'day' | 'ceiling';

export interface AllowanceJson {
    grantedUsd: number;
    usedUsd: number;
    /** What is left (never below 0). */
    leftUsd: number;
    todayUsd: number;
    dailyCapUsd: number;
    /** The first grant (ISO): spend before it is not theirs to count. */
    since: string;
    /** Null while their AI may run. */
    reason: AllowanceReason | null;
}

const money = (v: Prisma.Decimal | number | string | null | undefined): number => Math.round(Number(v ?? 0) * 1e6) / 1e6;
const cents = (n: number): number => Math.round(n * 100) / 100;

/** The env default of the friends' ceiling: FRIENDS_MONTHLY_CEILING_USD when a number from 0, else $25. */
export function envFriendsCeilingUsd(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env['FRIENDS_MONTHLY_CEILING_USD']?.trim();
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FRIENDS_CEILING_USD;
}

/** The friends' monthly ceiling now: the owner's on the People page, else the env's. */
export async function friendsCeilingUsd(env: NodeJS.ProcessEnv = process.env): Promise<number> {
    const row = await prisma.serverSetting.findUnique({ where: { key: CEILING_SETTING }, select: { value: true } });
    const v = row ? Number(row.value) : NaN;
    return Number.isFinite(v) && v >= 0 ? v : envFriendsCeilingUsd(env);
}

export async function setFriendsCeilingUsd(usd: number): Promise<number> {
    if (!Number.isFinite(usd) || usd < 0 || usd > MAX_GRANT_USD * 10) throw new AiHttpError(400, 'BAD_AMOUNT', `The ceiling is from $0 to $${MAX_GRANT_USD * 10}.`);
    const value = cents(usd);
    await prisma.serverSetting.upsert({ where: { key: CEILING_SETTING }, create: { key: CEILING_SETTING, value }, update: { value } });
    return value;
}

/** The owner's account id (OWNER_EMAIL), or null. A short cache: it is read on every friend's call. */
let ownerCache: { email: string; id: string | null; tz: string; at: number } | null = null;
const OWNER_CACHE_MS = 5 * 60_000;

async function owner(): Promise<{ id: string | null; tz: string }> {
    const email = ownerEmail();
    if (!email) return { id: null, tz: resolveTimeZone(null) };
    if (ownerCache && ownerCache.email === email && Date.now() - ownerCache.at < OWNER_CACHE_MS) return ownerCache;
    // Emails are kept as typed (some flows lower-case them): the match ignores case.
    const row = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true, timezone: true } });
    ownerCache = { email, id: row?.id ?? null, tz: resolveTimeZone(row?.timezone), at: Date.now() };
    return ownerCache;
}

/** Tests: forget the owner read before (OWNER_EMAIL changed). */
export function forgetOwnerForTests(): void {
    ownerCache = null;
}

/** Whether this account is the owner's (OWNER_EMAIL set and matching). */
export async function isOwnerAccount(userId: string): Promise<boolean> {
    const o = await owner();
    return o.id !== null && o.id === userId;
}

/** The friends' month (the owner's calendar month): its name and [start, end). */
async function friendsMonth(now: Date): Promise<{ month: string; start: Date; end: Date }> {
    const { tz } = await owner();
    const day = todayIn(tz, now);
    return { month: day.slice(0, 7), start: startOfDay(startOfMonth(day), tz), end: startOfDay(addDays(endOfMonth(day), 1), tz) };
}

/** What all friends (accounts with a grant, not the owner) spent on the server's key this month. */
export async function friendsMonthSpend(now: Date = new Date()): Promise<{ month: string; spentUsd: number }> {
    const [{ month, start, end }, o] = await Promise.all([friendsMonth(now), owner()]);
    const rows = await prisma.$queryRaw<Array<{ usd: Prisma.Decimal | null }>>`
        SELECT SUM(u."costUsd") AS usd FROM "AiUsage" u
        WHERE u."source" = 'house' AND u."createdAt" >= ${start} AND u."createdAt" < ${end}
          AND EXISTS (SELECT 1 FROM "AiGrant" g WHERE g."userId" = u."userId")
          AND u."userId" <> ${o.id ?? ''}`;
    return { month, spentUsd: money(rows[0]?.usd) };
}

/**
 * The account's free allowance, or null when it is not on one (no grant, or the owner's). `reason` says why its AI
 * waits now: used up first, then the friends' ceiling, then today's limit.
 */
export async function allowanceOf(userId: string, now: Date = new Date()): Promise<AllowanceJson | null> {
    const grants = await prisma.aiGrant.aggregate({ where: { userId }, _sum: { amountUsd: true }, _min: { createdAt: true }, _count: { _all: true } });
    if (!grants._count._all || !grants._min.createdAt) return null;
    if (await isOwnerAccount(userId)) return null;
    const since = grants._min.createdAt;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true, aiSettings: { select: { dailyCapUsd: true } } } });
    const tz = resolveTimeZone(user?.timezone);
    const dayStart = startOfDay(todayIn(tz, now), tz);
    const from = since < dayStart ? since : dayStart;
    const rows = await prisma.$queryRaw<Array<{ used: Prisma.Decimal | null; today: Prisma.Decimal | null }>>`
        SELECT SUM("costUsd") FILTER (WHERE "createdAt" >= ${since}) AS used,
               SUM("costUsd") FILTER (WHERE "createdAt" >= ${dayStart}) AS today
        FROM "AiUsage" WHERE "userId" = ${userId} AND "source" = 'house' AND "createdAt" >= ${from}`;
    const grantedUsd = money(grants._sum.amountUsd);
    const usedUsd = money(rows[0]?.used);
    const todayUsd = money(rows[0]?.today);
    const cap = user?.aiSettings?.dailyCapUsd;
    const dailyCapUsd = cap === null || cap === undefined ? FRIEND_DAILY_CAP_USD : money(cap);
    let reason: AllowanceReason | null = null;
    if (usedUsd >= grantedUsd) reason = 'empty';
    else {
        const [ceiling, friends] = await Promise.all([friendsCeilingUsd(), friendsMonthSpend(now)]);
        if (friends.spentUsd >= ceiling) reason = 'ceiling';
        else if (todayUsd >= dailyCapUsd) reason = 'day';
    }
    return { grantedUsd: cents(grantedUsd), usedUsd: cents(usedUsd), leftUsd: cents(Math.max(0, grantedUsd - usedUsd)), todayUsd: cents(todayUsd), dailyCapUsd: cents(dailyCapUsd), since: since.toISOString(), reason };
}

/** The calm words for a friend whose free AI waits (503 AI_PAUSED, like a paused key: the apps show one line). */
export function allowanceWords(reason: AllowanceReason): string {
    if (reason === 'day') return 'Today’s free AI is used up. It’s back tomorrow, and everything else works.';
    if (reason === 'ceiling') return 'The free AI is resting until next month. Everything else works.';
    return 'Your free AI is used up. Everything else works and nothing you saved is lost: ask the person who invited you for more, or add your own Claude key in Settings › AI.';
}

export const allowancePaused = (reason: AllowanceReason): AiHttpError => new AiHttpError(503, 'AI_PAUSED', allowanceWords(reason));

/** A grant: the first allowance (an invite used) or a top-up. */
export async function giveAllowance(userId: string, amountUsd: number, givenById: string | null, note: string, db: DbClient = prisma): Promise<void> {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > MAX_GRANT_USD) throw new AiHttpError(400, 'BAD_AMOUNT', `An amount is more than $0 and at most $${MAX_GRANT_USD}.`);
    await db.aiGrant.create({ data: { userId, amountUsd: cents(amountUsd).toFixed(2), givenById, note: note.slice(0, 200) }, select: { id: true } });
}

/** The owner's "Set budget": a friend's limit a day (null: back to $1). */
export async function setDailyCapUsd(userId: string, usd: number | null): Promise<void> {
    if (usd !== null && (!Number.isFinite(usd) || usd < 0 || usd > MAX_GRANT_USD)) throw new AiHttpError(400, 'BAD_AMOUNT', `A limit a day is from $0 to $${MAX_GRANT_USD}.`);
    const value = usd === null ? null : cents(usd).toFixed(2);
    await prisma.aiSettings.upsert({ where: { userId }, create: { userId, dailyCapUsd: value }, update: { dailyCapUsd: value }, select: { userId: true } });
}
