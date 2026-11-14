// The AI spend meter and the monthly cap (Settings → AI). Every Claude call is one AiUsage row,
// costed from its `usage` by ./pricing.ts. The month is the user's local calendar month (their
// learning time zone). A call is refused (402) once this month's spend reaches the cap; a call
// already running may finish past it.
import type { AiFeature } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { addDays, endOfMonth, resolveTimeZone, startOfDay, startOfMonth, today as todayIn } from '../learning';
import { aiCapReached } from './errors';
import { aiModel } from './client';
import { costOfCall, roundUsd, type CallUsage, type UsageTotals } from './pricing';

export const DEFAULT_MONTHLY_CAP_USD = 20;
export const MAX_MONTHLY_CAP_USD = 1000;

export const AI_FEATURES: readonly AiFeature[] = ['recall_questions', 'recall_grade', 'practice_note', 'weekly_coach'];

/** GET /api/ai/usage */
export interface AiUsageJson {
    /** 'YYYY-MM' in the user's time zone. */
    month: string;
    spentUsd: number;
    capUsd: number;
    calls: number;
    byFeature: Record<string, number>;
    /** The model new calls use. */
    model: string;
}

/** The user's local month containing `now`: 'YYYY-MM' and its [start, end) instants. */
export function monthRange(tz: string, now: Date): { month: string; start: Date; end: Date } {
    const day = todayIn(tz, now);
    return {
        month: day.slice(0, 7),
        start: startOfDay(startOfMonth(day), tz),
        end: startOfDay(addDays(endOfMonth(day), 1), tz),
    };
}

/** The cap stops new calls once spend reaches it ($0 = no AI calls at all). */
export const isOverCap = (spentUsd: number, capUsd: number): boolean => spentUsd >= capUsd;

async function userZone(userId: string, db: DbClient): Promise<string> {
    const user = await db.user.findUnique({ where: { id: userId }, select: { timezone: true } });
    return resolveTimeZone(user?.timezone);
}

export async function monthlyCapOf(userId: string, db: DbClient = prisma): Promise<number> {
    const row = await db.aiSettings.findUnique({ where: { userId }, select: { monthlyCapUsd: true } });
    return row ? Number(row.monthlyCapUsd) : DEFAULT_MONTHLY_CAP_USD;
}

/** This month's spend, call count and spend per feature. */
export async function monthSpend(userId: string, now: Date = new Date(), db: DbClient = prisma) {
    const { month, start, end } = monthRange(await userZone(userId, db), now);
    const groups = await db.aiUsage.groupBy({
        by: ['feature'],
        where: { userId, createdAt: { gte: start, lt: end } },
        _sum: { costUsd: true },
        _count: { _all: true },
    });
    const byFeature: Record<string, number> = Object.fromEntries(AI_FEATURES.map((f) => [f, 0]));
    let spent = 0;
    let calls = 0;
    for (const g of groups) {
        const usd = Number(g._sum.costUsd ?? 0);
        byFeature[g.feature] = roundUsd(usd);
        spent += usd;
        calls += g._count._all;
    }
    return { month, spentUsd: roundUsd(spent), calls, byFeature };
}

/** 402 AI_CAP_REACHED when this month's spend has reached the cap. */
export async function assertUnderCap(userId: string, now: Date = new Date()): Promise<void> {
    const [{ spentUsd }, cap] = await Promise.all([monthSpend(userId, now), monthlyCapOf(userId)]);
    if (isOverCap(spentUsd, cap)) throw aiCapReached(spentUsd, cap);
}

export async function isUnderCap(userId: string, now: Date = new Date()): Promise<boolean> {
    const [{ spentUsd }, cap] = await Promise.all([monthSpend(userId, now), monthlyCapOf(userId)]);
    return !isOverCap(spentUsd, cap);
}

/**
 * One AiUsage row for one response (also when its output turns out unusable: the tokens were
 * billed). With iterations, a refusal fallback's attempts are priced at their own models.
 */
export async function recordAiUsage(
    userId: string,
    feature: AiFeature,
    message: { model: string; usage: CallUsage },
    opts: { batch?: boolean; db?: DbClient } = {}
): Promise<UsageTotals> {
    const batch = opts.batch ?? false;
    const totals = costOfCall(message.usage, message.model, batch);
    await (opts.db ?? prisma).aiUsage.create({
        data: {
            userId,
            feature,
            model: message.model.slice(0, 100),
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cacheReadTokens: totals.cacheReadTokens,
            cacheWriteTokens: totals.cacheWriteTokens,
            batch,
            costUsd: roundUsd(totals.costUsd).toFixed(6),
        },
        select: { id: true },
    });
    return totals;
}

/** GET /api/ai/usage */
export async function aiUsageFor(userId: string, now: Date = new Date()): Promise<AiUsageJson> {
    const [spend, capUsd] = await Promise.all([monthSpend(userId, now), monthlyCapOf(userId)]);
    return { ...spend, capUsd, model: aiModel() };
}

/** PATCH /api/ai/settings { capUsd } (0–1000, kept to the cent). */
export async function setMonthlyCap(userId: string, capUsd: number, now: Date = new Date()): Promise<AiUsageJson> {
    const cents = Math.round(capUsd * 100) / 100;
    await prisma.aiSettings.upsert({
        where: { userId },
        create: { userId, monthlyCapUsd: cents.toFixed(2) },
        update: { monthlyCapUsd: cents.toFixed(2) },
        select: { userId: true },
    });
    return aiUsageFor(userId, now);
}
