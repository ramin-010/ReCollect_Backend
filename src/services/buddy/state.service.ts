// The buddy's settings and portrait (BuddyState; BUDDY_MEMORY_PLAN §3.2, §6). No row = the
// defaults: not enabled (the thinking steps cost AI money and run only for enabled users), not
// paused (capture and notes work), "your buddy", candid, a $25 monthly cap.
//
//   GET   /api/buddy/settings   buddySettings
//   PATCH /api/buddy/settings   updateBuddySettings   (cookie only)
import type { BuddyState, Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { poke } from '../scheduler/scheduler';
import { badRequest } from '../learning/http';
import { fromDbDayOrNull } from '../learningDb/common';
import type { DayString } from '../learning';

export const BUDDY_TONES = ['candid', 'gentle', 'bro'] as const;
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
    /** Stage 12: connected chats see what work folders logged. */
    shareOfficeWork: boolean;
    /** Stage 16: their goal on the phone's pictures (off by default: a goal may be private). */
    goalOnScreens: boolean;
    /** Stage 3: the loop is on for this account. */
    loop: boolean;
    /** Stage 5: the buddy may ask him questions. */
    asksOn: boolean;
    portrait: { who: string | null; heading: string | null; now: string | null };
    lastNightDay: DayString | null;
    lastStepAt: string | null;
}

/** A stored tone as one the character knows (anything else is candid). */
export const toneOf = (t: string | null | undefined): BuddyTone => (t === 'gentle' || t === 'bro' ? t : 'candid');

export function serializeBuddyState(s: BuddyState | null): BuddySettingsJson {
    return {
        enabled: s?.enabled ?? false,
        paused: s?.paused ?? false,
        name: s?.name ?? null,
        tone: toneOf(s?.tone),
        capUsd: s ? Number(s.capUsd) : DEFAULT_BUDDY_CAP_USD,
        workLog: s?.workLog ?? false,
        shareOfficeWork: s?.shareOfficeWork ?? true,
        goalOnScreens: s?.goalOnScreens ?? false,
        loop: s?.loop ?? false,
        asksOn: s?.asksOn ?? true,
        portrait: { who: s?.who ?? null, heading: s?.heading ?? null, now: s?.now ?? null },
        lastNightDay: fromDbDayOrNull(s?.lastNightDay),
        lastStepAt: s?.lastStepAt?.toISOString() ?? null,
    };
}

export async function buddySettings(userId: string): Promise<BuddySettingsJson> {
    return serializeBuddyState(await prisma.buddyState.findUnique({ where: { userId } }));
}

/** The account's own name, for the buddy's prompts (characterPrompt takes its first word). */
export async function personName(userId: string): Promise<string | null> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    return user?.name ?? null;
}

/**
 * Stage 11 (§9.6; the owner's word, 11-20: the loop on by default for new accounts): a new account starts with its
 * buddy on and the loop on. It thinks only when the account has AI (its own key, a free allowance, or the server's
 * list), and the person switches either off on /you. An existing row is left as it is.
 * Stage 12: its work log on too (a connected chat's lines cost no AI; Claude Code's summary runs only where the hooks
 * are installed); the person switches it off on /you.
 */
export async function startBuddyForNewAccount(userId: string, db: DbClient = prisma): Promise<void> {
    await db.buddyState.upsert({ where: { userId }, create: { userId, enabled: true, loop: true, workLog: true }, update: {}, select: { userId: true } });
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
    shareOfficeWork?: boolean | undefined;
    goalOnScreens?: boolean | undefined;
    loop?: boolean | undefined;
    asksOn?: boolean | undefined;
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
        ...(patch.shareOfficeWork !== undefined ? { shareOfficeWork: patch.shareOfficeWork } : {}),
        ...(patch.goalOnScreens !== undefined ? { goalOnScreens: patch.goalOnScreens } : {}),
        ...(patch.loop !== undefined ? { loop: patch.loop } : {}),
        ...(patch.asksOn !== undefined ? { asksOn: patch.asksOn } : {}),
    };
    const row = await prisma.buddyState.upsert({
        where: { userId },
        create: { ...(data as Prisma.BuddyStateUncheckedCreateInput), userId },
        update: data,
    });
    poke('buddy', 'capture'); // on, off, paused or a new cap: what the buddy may do now (hosting P1-11)
    // The loop on (stage 3): the open thread memories are copied into threads once (they stay as they are,
    // so off goes back to today's behaviour at once). Safe to run again.
    if (patch.loop === true) {
        const { copyThreadMemories } = await import('./threads');
        await copyThreadMemories(userId);
    }
    return serializeBuddyState(row);
}
