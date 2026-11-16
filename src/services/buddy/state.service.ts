// The buddy's settings and portrait (BuddyState; BUDDY_MEMORY_PLAN §3.2, §6). No row = the
// defaults: not enabled (the thinking steps cost AI money and run only for enabled users), not
// paused (capture and notes work), "your buddy", candid, a $25 monthly cap.
//
//   GET   /api/buddy/settings   buddySettings
//   PATCH /api/buddy/settings   updateBuddySettings   (cookie only)
import type { BuddyState, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { badRequest } from '../learning/http';
import { fromDbDayOrNull } from '../learningDb/common';
import type { DayString } from '../learning';

export const BUDDY_TONES = ['candid', 'gentle'] as const;
export type BuddyTone = (typeof BUDDY_TONES)[number];
export const DEFAULT_BUDDY_CAP_USD = 25;
export const MAX_BUDDY_CAP_USD = 100;
export const BUDDY_NAME_MAX = 40;

export interface BuddySettingsJson {
    enabled: boolean;
    paused: boolean;
    /** What he calls it; null = "your buddy". */
    name: string | null;
    tone: BuddyTone;
    capUsd: number;
    /** B9: keep a log of what he works on. */
    workLog: boolean;
    portrait: { who: string | null; heading: string | null; now: string | null };
    lastNightDay: DayString | null;
    lastStepAt: string | null;
}

const toneOf = (t: string | null | undefined): BuddyTone => (t === 'gentle' ? 'gentle' : 'candid');

export function serializeBuddyState(s: BuddyState | null): BuddySettingsJson {
    return {
        enabled: s?.enabled ?? false,
        paused: s?.paused ?? false,
        name: s?.name ?? null,
        tone: toneOf(s?.tone),
        capUsd: s ? Number(s.capUsd) : DEFAULT_BUDDY_CAP_USD,
        workLog: s?.workLog ?? false,
        portrait: { who: s?.who ?? null, heading: s?.heading ?? null, now: s?.now ?? null },
        lastNightDay: fromDbDayOrNull(s?.lastNightDay),
        lastStepAt: s?.lastStepAt?.toISOString() ?? null,
    };
}

export async function buddySettings(userId: string): Promise<BuddySettingsJson> {
    return serializeBuddyState(await prisma.buddyState.findUnique({ where: { userId } }));
}

export async function isBuddyPaused(userId: string): Promise<boolean> {
    const s = await prisma.buddyState.findUnique({ where: { userId }, select: { paused: true } });
    return s?.paused ?? false;
}

export interface BuddySettingsPatch {
    enabled?: boolean | undefined;
    paused?: boolean | undefined;
    name?: string | null | undefined;
    tone?: BuddyTone | undefined;
    capUsd?: number | undefined;
    workLog?: boolean | undefined;
}

export async function updateBuddySettings(userId: string, patch: BuddySettingsPatch): Promise<BuddySettingsJson> {
    if (patch.capUsd !== undefined && (!Number.isFinite(patch.capUsd) || patch.capUsd < 0 || patch.capUsd > MAX_BUDDY_CAP_USD)) {
        throw badRequest(`capUsd is from 0 to ${MAX_BUDDY_CAP_USD}`);
    }
    const name = patch.name === undefined ? undefined : patch.name === null ? null : patch.name.replace(/\s+/g, ' ').trim().slice(0, BUDDY_NAME_MAX) || null;
    const data: Prisma.BuddyStateUncheckedUpdateInput = {
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.paused !== undefined ? { paused: patch.paused } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(patch.tone ? { tone: patch.tone } : {}),
        ...(patch.capUsd !== undefined ? { capUsd: patch.capUsd } : {}),
        ...(patch.workLog !== undefined ? { workLog: patch.workLog } : {}),
    };
    const row = await prisma.buddyState.upsert({
        where: { userId },
        create: { ...(data as Prisma.BuddyStateUncheckedCreateInput), userId },
        update: data,
    });
    return serializeBuddyState(row);
}
