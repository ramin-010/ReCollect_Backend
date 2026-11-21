// Who pays for an account's AI, and whether that key works now (ECOSYSTEM_V2_PLAN §4.15 and §9.1,
// stage 2). Every AI call names its account; the account's key is the server's ("house") today, and a
// person's own later (stage 10). A key that runs out of credit or is rejected is paused for every
// account on it: no call is made on it until a probe succeeds (every 6 hours, or the user's "Try
// again"). "Busy" and network faults never pause a key: the caller waits and tries again, as before.
// What is paused is a state the apps show calmly, never an error per feature.
import type { RequestHandler } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../db/prisma';
import { aiAllowedFor } from '../../config/aiAccess';
import { poke } from '../scheduler/scheduler';
import { AiHttpError } from './errors';
import { allowanceOf, allowancePaused, type AllowanceJson } from './allowance';

/** The server's own key (CLAUDE_API_KEY). */
export const HOUSE_KEY = 'house';

export type AiSource = 'none' | 'own_key' | 'house';
/** `allowance` (stage 11): a friend's free AI waits (used up, today's limit, or the friends' ceiling): see `allowance.reason`. */
export type AiState = 'ok' | 'no_credit' | 'bad_key' | 'cap' | 'off' | 'allowance';
/** What a failed call says about its key. */
export type AiFault = 'no_credit' | 'bad_key' | 'busy' | 'other';

export interface AiAccess {
    source: AiSource;
    state: AiState;
    /** The key the account's calls use (null without one). */
    keyId: string | null;
    /** When a paused key was paused (ISO), else null. */
    since: string | null;
    /** Stage 11: a friend on the server's key: what they were given, used and have left (absent for anyone else). */
    allowance?: AllowanceJson;
}

/** A paused key is probed this long after its last failure. */
export const PROBE_EVERY_MS = 6 * 3600_000;
/** A busy answer to a probe: try again this soon. */
export const PROBE_BUSY_MS = 15 * 60_000;

const houseConfigured = () => Boolean(process.env['CLAUDE_API_KEY']?.trim());

/** Tests: which key an account uses (null: the real rule). Stage 10 replaces it with the person's own key. */
let keyOverride: ((userId: string) => string | null) | null = null;
export function setAiKeyForTests(fn: ((userId: string) => string | null) | null): void {
    keyOverride = fn;
}

/**
 * The key an account's calls use, and who pays: the person's own key when they added one (stage 10), else the
 * server's, for the accounts AI_ALLOWED_EMAILS allows. Never a fallback from one to the other.
 */
export async function keyFor(userId: string): Promise<{ source: AiSource; keyId: string | null }> {
    const forced = keyOverride?.(userId);
    if (forced) return { source: forced === HOUSE_KEY ? 'house' : 'own_key', keyId: forced };
    // Imported here: ./ownKeys imports this module's state helpers.
    const { activeOwnKey, ownKeyId, readyOwnClient } = await import('./ownKeys');
    const own = await activeOwnKey(userId);
    if (own) {
        readyOwnClient(own);
        return { source: 'own_key', keyId: ownKeyId(own) };
    }
    if (process.env['NODE_ENV'] !== 'test' && !houseConfigured()) return { source: 'none', keyId: null };
    if (!(await aiAllowedFor(userId))) return { source: 'none', keyId: null };
    return { source: 'house', keyId: HOUSE_KEY };
}

/** A key's state: ok unless a failure paused it. */
export async function keyState(keyId: string): Promise<{ state: 'ok' | 'no_credit' | 'bad_key'; since: Date | null; probeAt: Date | null }> {
    const row = await prisma.aiKeyState.findUnique({ where: { keyId } });
    if (!row || (row.state !== 'no_credit' && row.state !== 'bad_key')) return { state: 'ok', since: null, probeAt: null };
    return { state: row.state, since: row.since, probeAt: row.probeAt };
}

/** The account's AI now. `cap`: also check this month's spend against its cap (a query more). */
export async function aiAccessFor(userId: string, opts: { cap?: boolean; now?: Date } = {}): Promise<AiAccess> {
    const { source, keyId } = await keyFor(userId);
    if (!keyId) return { source: 'none', state: 'off', keyId: null, since: null };
    const k = await keyState(keyId);
    if (k.state !== 'ok') return { source, state: k.state, keyId, since: k.since?.toISOString() ?? null };
    // Stage 11: a friend on the server's key is held to their allowance, their limit a day and the friends' ceiling.
    const allowance = source === 'house' ? await allowanceOf(userId, opts.now) : null;
    const theirs = allowance ? { allowance } : {};
    if (allowance?.reason) return { source, state: 'allowance', keyId, since: null, ...theirs };
    if (opts.cap) {
        // Imported here: the usage service imports the access rules too (AI_ALLOWED_EMAILS).
        const { isUnderCap } = await import('./usage.service');
        if (!(await isUnderCap(userId))) return { source, state: 'cap', keyId, since: null, ...theirs };
    }
    return { source, state: 'ok', keyId, since: null, ...theirs };
}

/** The error for an account whose AI waits (a paused key, or a friend's allowance), or null while it may run. */
export function aiWaitError(access: AiAccess): AiHttpError | null {
    if (access.state === 'no_credit' || access.state === 'bad_key') return aiPaused(access.state);
    if (access.state === 'allowance' && access.allowance?.reason) return allowancePaused(access.allowance.reason);
    return null;
}

/** A paused key's state is one the apps show calmly: 503 AI_PAUSED with the reason. */
export function aiPaused(state: 'no_credit' | 'bad_key'): AiHttpError {
    return new AiHttpError(
        503,
        'AI_PAUSED',
        state === 'no_credit' ? 'The AI is paused: the Claude credits ran out. Everything else works.' : 'The AI is paused: the Claude key was not accepted. Everything else works.'
    );
}

export const isAiPausedError = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'AI_PAUSED';

/**
 * What a failed call says about its key, read from the API's own error (its status, its type, its
 * words): duck-typed, so it reads the SDK's errors and any error shaped like them.
 */
export function classifyAiError(err: unknown): AiFault {
    const e = err as { status?: unknown; type?: unknown; error?: { type?: unknown; error?: { type?: unknown } }; name?: unknown; message?: unknown } | null;
    const status = typeof e?.status === 'number' ? e.status : 0;
    const type = [e?.type, e?.error?.type, e?.error?.error?.type].find((t): t is string => typeof t === 'string' && t !== 'error') ?? '';
    const name = typeof e?.name === 'string' ? e.name : '';
    const message = typeof e?.message === 'string' ? e.message : '';
    if (status === 402 || type === 'billing_error' || /credit balance|billing/i.test(message)) return 'no_credit';
    if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error' || /AuthenticationError|PermissionDeniedError/.test(name)) return 'bad_key';
    if (status === 408 || status === 409 || status === 429 || status === 529 || status >= 500 || type === 'rate_limit_error' || type === 'overloaded_error') return 'busy';
    if (/APIConnectionError|APIConnectionTimeoutError|RateLimitError|InternalServerError|TimeoutError|AbortError/.test(name)) return 'busy';
    // The SDK's own classes (a connection error carries neither a status nor a name of its own).
    if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) return 'busy';
    return 'other';
}

/**
 * After a failed call on `keyId`: no credit or a rejected key pauses the key (for every account on it)
 * and schedules its probe; anything else changes nothing. Returns what the failure was.
 */
export async function noteAiFailure(keyId: string, err: unknown, now: Date = new Date()): Promise<AiFault> {
    const fault = classifyAiError(err);
    if (fault !== 'no_credit' && fault !== 'bad_key') return fault;
    const lastError = (typeof (err as { message?: unknown })?.message === 'string' ? String((err as { message: string }).message) : fault).slice(0, 300);
    const before = await keyState(keyId);
    await prisma.aiKeyState.upsert({
        where: { keyId },
        create: { keyId, state: fault, since: now, lastError, probeAt: new Date(now.getTime() + PROBE_EVERY_MS) },
        update: { state: fault, lastError, probeAt: new Date(now.getTime() + PROBE_EVERY_MS), ...(before.state === fault ? {} : { since: now }) },
    });
    if (before.state === 'ok') console.warn(`[ai] the ${keyId === HOUSE_KEY ? "server's" : 'a'} key is paused: ${fault === 'no_credit' ? 'out of credit' : 'not accepted'}`);
    await pokeProbe();
    return fault;
}

/** A probe or a call worked: the key is fine again. True when it had been paused. */
export async function markKeyOk(keyId: string, now: Date = new Date()): Promise<boolean> {
    // The pause just ended is kept (stage 4, hold and replay): the first night back is told the days it could not listen.
    const count = await prisma.$executeRaw`
        UPDATE "AiKeyState" SET "pausedFrom" = "since", "pausedTo" = ${now}, "state" = 'ok', "lastError" = NULL, "probeAt" = NULL, "since" = ${now}, "updatedAt" = ${now}
        WHERE "keyId" = ${keyId} AND "state" <> 'ok'`;
    return count > 0;
}

/** A pause of the person's key that ended in the last 36 hours, with the messages dropped meanwhile (stage 4). */
export async function recentPause(userId: string, now: Date = new Date()): Promise<{ from: Date; to: Date } | null> {
    const { keyId } = await keyFor(userId);
    if (!keyId) return null;
    const row = await prisma.aiKeyState.findUnique({ where: { keyId }, select: { pausedFrom: true, pausedTo: true } });
    if (!row?.pausedFrom || !row.pausedTo || now.getTime() - row.pausedTo.getTime() > 36 * 3600_000) return null;
    return { from: row.pausedFrom, to: row.pausedTo };
}

/** A paused key's probe found it still paused (or busy): the next probe. */
export async function probeLater(keyId: string, at: Date): Promise<void> {
    await prisma.aiKeyState.updateMany({ where: { keyId }, data: { probeAt: at } });
}

/** The paused keys whose probe is due. */
export async function keysToProbe(now: Date = new Date()): Promise<string[]> {
    const rows = await prisma.aiKeyState.findMany({ where: { state: { in: ['no_credit', 'bad_key'] }, OR: [{ probeAt: null }, { probeAt: { lte: now } }] }, select: { keyId: true } });
    return rows.map((r) => r.keyId);
}

/** The next probe over every paused key (the quiet scheduler's timer), or null. */
export async function nextProbeDue(): Promise<Date | null> {
    const row = await prisma.aiKeyState.findFirst({ where: { state: { in: ['no_credit', 'bad_key'] } }, orderBy: { probeAt: 'asc' }, select: { probeAt: true } });
    if (!row) return null;
    return row.probeAt ?? new Date();
}

async function pokeProbe(): Promise<void> {
    poke('aiProbe');
}

/**
 * For the AI routes, after the login and AI_ALLOWED_EMAILS checks: a paused key answers 503 AI_PAUSED
 * (the apps show one calm line). The spend meter and its settings stay outside it.
 */
export const requireAiReady: RequestHandler = (req, _res, next) => {
    const userId = req.user?.id;
    if (!userId) return next();
    aiAccessFor(userId).then(
        // Stage 11: a friend whose free AI waits answers the same calm 503, with its own words.
        (a) => next(aiWaitError(a) ?? undefined),
        (err: unknown) => next(err)
    );
};
