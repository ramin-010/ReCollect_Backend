// The first run (ECOSYSTEM_V2_PLAN stage 11, §9.6 item 2): a new account's short checklist on Home, and the buddy's
// first chat, which opens with two or three open questions. Shown for 30 days after the account was made, until it is
// hidden or every step is done. Each step is read from what the person really did, never ticked by hand, except the
// time zone (only they know it is right).
//
//   GET   /api/first-run                     → FirstRunJson
//   PATCH /api/first-run {zoneOk?, dismissed?}
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { aiAccessFor } from '../claude/access';
import { resolveTimeZone } from '../learning';

export const FIRST_RUN_DAYS = 30;

export type FirstRunStep = 'zone' | 'buddy' | 'connect' | 'import';

export interface FirstRunJson {
    show: boolean;
    steps: Array<{ id: FirstRunStep; done: boolean }>;
    /** Their time zone now (IANA). */
    zone: string;
    /** Whether the app's AI runs for them (the buddy's steps show only then). */
    ai: boolean;
    /** The buddy's first words in Ask Kaaga, while they have never talked to it (else null). */
    opening: string | null;
}

interface FirstRunState {
    zoneOk?: true;
    dismissedAt?: string;
}

const stateOf = (v: Prisma.JsonValue | null): FirstRunState => (v && typeof v === 'object' && !Array.isArray(v) ? (v as FirstRunState) : {});

/** The buddy's opening words in a person's first chat: who it is, then three open questions (§9.6 item 2). */
export function firstChatWords(name: string | null | undefined): string {
    const first = name?.trim().split(/\s+/)[0];
    return [
        `Hi${first ? ` ${first}` : ''}! I’m your buddy. I keep what you tell me and bring it back when it helps: a reminder, a question at the right moment, a nudge on your plan.`,
        'To get going, tell me any of these, in your own words:',
        '- What are you learning or working towards right now?',
        '- What does a good week look like for you?',
        '- Anything coming up soon I should know about?',
    ].join('\n');
}

/** Whether they have said anything to the buddy yet (a chat, a memory, a note). */
async function talkedToBuddy(userId: string): Promise<boolean> {
    const [chats, memories, notes] = await Promise.all([
        prisma.assistantThread.count({ where: { userId, docId: null } }),
        prisma.memory.count({ where: { userId } }),
        prisma.observation.count({ where: { userId } }),
    ]);
    return chats + memories + notes > 0;
}

export async function firstRunFor(userId: string, now: Date = new Date()): Promise<FirstRunJson> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, timezone: true, createdAt: true, firstRun: true } });
    const zone = resolveTimeZone(user?.timezone);
    if (!user) return { show: false, steps: [], zone, ai: false, opening: null };
    const state = stateOf(user.firstRun);
    const [access, talked, agents, imports] = await Promise.all([
        aiAccessFor(userId, { now }),
        talkedToBuddy(userId),
        // Their own Claude (Claude Code, claude.ai, ChatGPT): any live token but the phone app's.
        prisma.apiToken.count({ where: { userId, revokedAt: null, NOT: { scopes: { has: 'ambient' } } } }),
        prisma.buddyImport.count({ where: { userId } }),
    ]);
    const ai = access.source !== 'none';
    const steps: FirstRunJson['steps'] = [
        { id: 'zone', done: state.zoneOk === true },
        ...(ai ? [{ id: 'buddy' as const, done: talked }] : []),
        { id: 'connect', done: agents > 0 },
        ...(ai ? [{ id: 'import' as const, done: imports > 0 }] : []),
    ];
    const young = now.getTime() - user.createdAt.getTime() < FIRST_RUN_DAYS * 86_400_000;
    const show = young && !state.dismissedAt && steps.some((s) => !s.done);
    return { show, steps, zone, ai, opening: ai && !talked ? firstChatWords(user.name) : null };
}

/** PATCH /api/first-run: "Looks right" on the time zone, or "Hide this". */
export async function updateFirstRun(userId: string, patch: { zoneOk?: boolean | undefined; dismissed?: boolean | undefined }, now: Date = new Date()): Promise<FirstRunJson> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { firstRun: true } });
    const next: FirstRunState = { ...stateOf(user?.firstRun ?? null) };
    if (patch.zoneOk === true) next.zoneOk = true;
    if (patch.dismissed === true) next.dismissedAt = now.toISOString();
    await prisma.user.update({ where: { id: userId }, data: { firstRun: next as Prisma.InputJsonValue }, select: { id: true } });
    return firstRunFor(userId, now);
}
