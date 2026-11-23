// EASY_SETUP_PLAN §3.2 (11-23): a PC signs in by approval, not by a copied token (RFC 8628's device flow, simplified).
//
//   startSignIn    POST /api/setup/start {device}        (public)   → the codes and the page to approve them on
//   pollSignIn     POST /api/setup/poll {deviceCode}     (public)   → pending | slow_down | denied | expired | approved
//   signInRequest  GET  /api/setup/request?code=         (cookie)   → what the approve page shows
//   answerSignIn   POST /api/setup/answer {code, allow}  (cookie)   → the request's new status
//   setupMe        GET  /api/setup/me                    (token)    → who this PC is signed in as
//   disconnect     POST /api/setup/disconnect            (token)    → the PC's own token ends itself
//
// `npx recollect-setup` holds the device code (only its hash is kept here) and shows the user code; the person opens
// the page, checks the code against their terminal and approves while signed in. The command's next poll gets a token
// of its own, made then and shown that once (never stored in plain text), with every scope an agent may have (not the
// phone's `ambient`). A request lives 10 minutes and is used once. Phishing (someone sends a link to approve): the page
// says to approve only a code they see in their own terminal, names the computer as it called itself, and the token
// shows in Settings › Agents, where it can be ended.
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import type { ApiScope, RequestAuth } from '../../types/auth';
import ErrorResponse from '../../utils/errorResponse';
import { ACTIVE_TOKEN_LIMIT, API_TOKEN_NAME_MAX, generateApiToken, hashApiToken, revokeApiToken } from '../apiTokens/apiTokens.service';
import { appUrl } from '../oauth/oauth.service';

export const SIGN_IN_TTL_MS = 10 * 60_000;
/** Seconds the command waits between polls; a faster poll is told to slow down. */
export const POLL_INTERVAL_S = 3;
const POLL_MIN_GAP_MS = 2_000;
/** No vowels: a code never spells a word. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
export const USER_CODE_LENGTH = 8;
const DEVICE_NAME_MAX = 60;
/** What a PC's token may do: everything an agent may (the phone app's ambient scope is its own). */
export const SETUP_SCOPES: readonly ApiScope[] = ['read', 'docs:write', 'learning:write', 'sessions:write', 'tasks:write'];

export const newUserCode = (): string => Array.from({ length: USER_CODE_LENGTH }, () => USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)]).join('');
/** "BCDFGHJK" → "BCDF-GHJK" (as the terminal and the page show it). */
export const showUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;
/** What the person typed or the link carried → the stored form (upper case, letters only). */
export const normalizeUserCode = (input: string): string => input.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 16);

/** The PC's own name for itself: printable, single spaces, at most 60 characters. */
export function cleanDeviceName(raw: unknown): string {
    const clean = (typeof raw === 'string' ? raw : '')
        .replace(/[^\x20-\x7e]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, DEVICE_NAME_MAX)
        .trim();
    return clean || 'A computer';
}

export interface StartedSignIn {
    deviceCode: string;
    userCode: string;
    /** The page to approve on, and the same page with the code filled in. */
    verifyUrl: string;
    verifyUrlComplete: string;
    interval: number;
    expiresIn: number;
}

/** POST /api/setup/start: a new request (requests that ran out a day ago are cleared on the way). */
export async function startSignIn(input: { device?: unknown }, now: Date = new Date()): Promise<StartedSignIn> {
    await prisma.deviceSignIn.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } } });
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    const deviceName = cleanDeviceName(input.device);
    for (let attempt = 0; ; attempt++) {
        const userCode = newUserCode();
        try {
            await prisma.deviceSignIn.create({
                data: { deviceCodeHash: hashApiToken(deviceCode), userCode, deviceName, expiresAt: new Date(now.getTime() + SIGN_IN_TTL_MS) },
                select: { id: true },
            });
            const page = `${appUrl()}/connect-pc`;
            return {
                deviceCode,
                userCode: showUserCode(userCode),
                verifyUrl: page,
                verifyUrlComplete: `${page}?code=${showUserCode(userCode)}`,
                interval: POLL_INTERVAL_S,
                expiresIn: SIGN_IN_TTL_MS / 1000,
            };
        } catch (err) {
            // A user code already taken (one in 25 billion): draw another.
            if (attempt < 3 && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
            throw err;
        }
    }
}

export type PollAnswer =
    | { status: 'pending' | 'slow_down' | 'denied' | 'expired'; message?: string }
    | { status: 'approved'; token: string; scopes: ApiScope[]; account: { name: string } };

const firstName = (name: string): string => name.trim().split(/\s+/)[0] || 'you';

/** POST /api/setup/poll: the command asks how its request stands; an approved one gets its token, once. */
export async function pollSignIn(deviceCode: unknown, now: Date = new Date()): Promise<PollAnswer> {
    if (typeof deviceCode !== 'string' || !deviceCode) return { status: 'expired', message: 'Start again: run the command once more.' };
    const row = await prisma.deviceSignIn.findUnique({ where: { deviceCodeHash: hashApiToken(deviceCode) } });
    if (!row || row.deliveredAt || row.expiresAt <= now) return { status: 'expired', message: 'This sign-in ran out (10 minutes). Run the command again.' };
    if (row.deniedAt) return { status: 'denied', message: 'Denied on the web page.' };
    if (row.lastPollAt && now.getTime() - row.lastPollAt.getTime() < POLL_MIN_GAP_MS) return { status: 'slow_down' };
    if (!row.approvedAt || !row.userId) {
        await prisma.deviceSignIn.update({ where: { id: row.id }, data: { lastPollAt: now }, select: { id: true } });
        return { status: 'pending' };
    }
    // One poll takes the token: two at once can't both.
    const took = await prisma.deviceSignIn.updateMany({ where: { id: row.id, deliveredAt: null }, data: { deliveredAt: now, lastPollAt: now } });
    if (took.count !== 1) return { status: 'expired', message: 'This sign-in was already used. Run the command again.' };
    const userId = row.userId;
    const active = await prisma.apiToken.count({ where: { userId, revokedAt: null } });
    if (active >= ACTIVE_TOKEN_LIMIT) return { status: 'denied', message: `Your account has ${ACTIVE_TOKEN_LIMIT} active tokens: end one in Settings › Agents, then run the command again.` };
    const { token, tokenHash, prefix } = generateApiToken();
    const name = `${row.deviceName} · recollect-setup`.slice(0, API_TOKEN_NAME_MAX);
    const made = await prisma.apiToken.create({ data: { userId, name, scopes: [...SETUP_SCOPES], tokenHash, prefix }, select: { id: true } });
    await prisma.deviceSignIn.update({ where: { id: row.id }, data: { apiTokenId: made.id }, select: { id: true } });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    return { status: 'approved', token, scopes: [...SETUP_SCOPES], account: { name: firstName(user.name) } };
}

export interface SignInRequestJson {
    code: string;
    device: string;
    createdAt: string;
    expiresAt: string;
    /** waiting: theirs to answer; approved / denied: answered (by them); used: the PC has its token; expired: ran out. */
    status: 'waiting' | 'approved' | 'denied' | 'used' | 'expired';
}

const GONE = 'This code doesn’t exist or ran out. Run the command on your computer again for a new one.';

async function findRequest(code: unknown) {
    const userCode = typeof code === 'string' ? normalizeUserCode(code) : '';
    if (userCode.length !== USER_CODE_LENGTH) throw new ErrorResponse(404, GONE);
    const row = await prisma.deviceSignIn.findUnique({ where: { userCode } });
    if (!row) throw new ErrorResponse(404, GONE);
    return row;
}

function statusOf(row: { approvedAt: Date | null; deniedAt: Date | null; deliveredAt: Date | null; expiresAt: Date; userId: string | null }, userId: string, now: Date): SignInRequestJson['status'] {
    // Someone else's answer is not shown to them: it reads as used.
    if (row.userId && row.userId !== userId) return 'used';
    if (row.deliveredAt) return 'used';
    if (row.deniedAt) return 'denied';
    if (row.approvedAt) return 'approved';
    return row.expiresAt <= now ? 'expired' : 'waiting';
}

/** GET /api/setup/request?code= (their cookie): what the approve page shows. */
export async function signInRequest(userId: string, code: unknown, now: Date = new Date()): Promise<SignInRequestJson> {
    const row = await findRequest(code);
    return { code: showUserCode(row.userCode), device: row.deviceName, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), status: statusOf(row, userId, now) };
}

/** POST /api/setup/answer {code, allow} (their cookie): Approve or Deny, once. */
export async function answerSignIn(userId: string, code: unknown, allow: boolean, now: Date = new Date()): Promise<SignInRequestJson> {
    const row = await findRequest(code);
    const status = statusOf(row, userId, now);
    if (status === 'expired') throw new ErrorResponse(410, 'This code ran out (10 minutes). Run the command on your computer again.');
    if (status !== 'waiting') return signInRequest(userId, code, now);
    if (allow) {
        const active = await prisma.apiToken.count({ where: { userId, revokedAt: null } });
        if (active >= ACTIVE_TOKEN_LIMIT) throw new ErrorResponse(409, `Your account has ${ACTIVE_TOKEN_LIMIT} active tokens: end one in Settings › Agents, then approve again.`);
    }
    // Only a request nobody answered yet (two tabs at once: the first answer stands).
    await prisma.deviceSignIn.updateMany({ where: { id: row.id, approvedAt: null, deniedAt: null }, data: allow ? { userId, approvedAt: now } : { userId, deniedAt: now } });
    return signInRequest(userId, code, now);
}

export interface SetupMeJson {
    /** Their first name (the command says "Signed in as …"). */
    name: string;
    tokenName: string | null;
    scopes: ApiScope[];
    /** What the server speaks (1: folder rules, set_folder, set_chat, this sign-in). */
    setup: 1;
}

/** GET /api/setup/me (the PC's token): who it is signed in as. */
export async function setupMe(userId: string, auth: RequestAuth | undefined): Promise<SetupMeJson> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
    const token = auth?.via === 'token' ? await prisma.apiToken.findUnique({ where: { id: auth.tokenId }, select: { name: true } }) : null;
    return { name: firstName(user.name), tokenName: token?.name ?? null, scopes: [...(auth?.scopes ?? [])], setup: 1 };
}

/** POST /api/setup/disconnect (the PC's token, `recollect-setup remove`): the token ends itself; nothing else changes. */
export async function disconnect(userId: string, auth: RequestAuth | undefined, now: Date = new Date()): Promise<{ ended: true }> {
    if (auth?.via !== 'token') throw new ErrorResponse(400, 'Only a token can end itself: use Settings › Agents');
    await revokeApiToken(userId, auth.tokenId, now);
    return { ended: true };
}
