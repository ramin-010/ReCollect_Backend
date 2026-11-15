// The buddy's AI money (BUDDY_MEMORY_PLAN §5): its own monthly cap (BuddyState.capUsd, default $25)
// on top of the account's cap, and the usage view (GET /api/buddy/usage: per day, calls and cost
// per step, messages seen and kept; never words).
import type { AiFeature } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { isAiConfigured } from '../claude/client';
import { isUnderCap, monthRange } from '../claude/usage.service';
import { addDays, dayOf, type DayString } from '../learning';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { DEFAULT_BUDDY_CAP_USD } from './state.service';

export const BUDDY_FEATURES = ['buddy_gate', 'buddy_digest', 'buddy_think', 'buddy_pulse', 'buddy_check'] as const satisfies readonly AiFeature[];
export type BuddyFeature = (typeof BUDDY_FEATURES)[number];

/** What the buddy spent this (local) month, in USD. */
export async function buddySpend(userId: string, now: Date = new Date()): Promise<number> {
    const { tz } = await loadLearningContext(userId, now);
    const { start, end } = monthRange(tz, now);
    const sum = await prisma.aiUsage.aggregate({ where: { userId, feature: { in: [...BUDDY_FEATURES] }, createdAt: { gte: start, lt: end } }, _sum: { costUsd: true } });
    return Number(sum._sum.costUsd ?? 0);
}

export type BuddyGate = 'ok' | 'off' | 'paused' | 'no_ai' | 'buddy_cap' | 'account_cap';

/** Whether the buddy may spend now: set up and on, not paused, under its own cap and the account's. */
export async function buddyMaySpend(userId: string, now: Date = new Date()): Promise<BuddyGate> {
    if (!isAiConfigured()) return 'no_ai';
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { enabled: true, paused: true, capUsd: true } });
    if (!state?.enabled) return 'off';
    if (state.paused) return 'paused';
    if ((await buddySpend(userId, now)) >= Number(state.capUsd ?? DEFAULT_BUDDY_CAP_USD)) return 'buddy_cap';
    if (!(await isUnderCap(userId, now))) return 'account_cap';
    return 'ok';
}

export interface BuddyUsageDay {
    day: DayString;
    seen: number;
    kept: number;
    chunks: number;
    dropped: number;
    secrets: number;
    notes: number;
    items: number;
    /** Calls and cost per step that day. */
    steps: Partial<Record<BuddyFeature, { calls: number; costUsd: number }>>;
    costUsd: number;
}

export interface BuddyUsage {
    month: { spentUsd: number; capUsd: number };
    days: BuddyUsageDay[];
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** The last 30 days (newest first), only days with something in them. */
export async function buddyUsage(userId: string, now: Date = new Date()): Promise<BuddyUsage> {
    const { today, tz } = await loadLearningContext(userId, now);
    const from = addDays(today, -29);
    const [counts, calls, state, spent] = await Promise.all([
        prisma.buddyCaptureDay.findMany({ where: { userId, day: { gte: toDbDay(from) } } }),
        prisma.aiUsage.findMany({ where: { userId, feature: { in: [...BUDDY_FEATURES] }, createdAt: { gte: new Date(now.getTime() - 31 * 86_400_000) } }, select: { feature: true, costUsd: true, createdAt: true } }),
        prisma.buddyState.findUnique({ where: { userId }, select: { capUsd: true } }),
        buddySpend(userId, now),
    ]);
    const days = new Map<string, BuddyUsageDay>();
    const dayRow = (day: DayString): BuddyUsageDay => {
        let d = days.get(day);
        if (!d) {
            d = { day, seen: 0, kept: 0, chunks: 0, dropped: 0, secrets: 0, notes: 0, items: 0, steps: {}, costUsd: 0 };
            days.set(day, d);
        }
        return d;
    };
    for (const c of counts) Object.assign(dayRow(fromDbDay(c.day)), { seen: c.seen, kept: c.kept, chunks: c.chunks, dropped: c.dropped, secrets: c.secrets, notes: c.notes, items: c.items });
    for (const call of calls) {
        const day = dayOf(call.createdAt, tz);
        if (day < from) continue;
        const d = dayRow(day);
        const feature = call.feature as BuddyFeature;
        const step = (d.steps[feature] ??= { calls: 0, costUsd: 0 });
        step.calls++;
        step.costUsd = round(step.costUsd + Number(call.costUsd));
        d.costUsd = round(d.costUsd + Number(call.costUsd));
    }
    return {
        month: { spentUsd: round(spent), capUsd: Number(state?.capUsd ?? DEFAULT_BUDDY_CAP_USD) },
        days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    };
}
