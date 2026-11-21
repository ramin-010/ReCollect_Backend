// A person's own Claude API key (ECOSYSTEM_V2_PLAN §9.3, stage 10): kept encrypted (AES-256-GCM with the server's
// AI_KEYS_SECRET), checked on save on each model the app calls, never returned, logged or put in an error: only its
// last 4 show. With one, the person's AI calls go on it (keyFor, ./access.ts), and its state (no credit, rejected) is
// kept per key like the server's, so a paused own key pauses only that person. Removing it ends it at once.
//
//   GET    /api/ai/key   its last 4, when added and checked, its state (or null)
//   PUT    /api/ai/key   {key}: checked, then stored (the one before it ends)
//   DELETE /api/ai/key   removed
import crypto from 'node:crypto';
import type { AiKey } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { AiHttpError } from './errors';
import { checkClient, forgetOwnClient, registerOwnClient } from './client';
import { classifyAiError, keyState, markKeyOk } from './access';

/** The models the app calls (the gate and the task line, the digest, the chat and the checks, the night and Recall). */
export const CHECK_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

export const ownKeyId = (row: Pick<AiKey, 'id'>): string => `own:${row.id}`;

function secret(): Buffer | null {
    const s = process.env['AI_KEYS_SECRET']?.trim();
    return s ? crypto.createHash('sha256').update(s, 'utf8').digest() : null;
}

/** Encrypts a key (pure but for the random iv). */
export function sealKey(plain: string, key: Buffer): { cipher: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const cipher = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return { cipher: cipher.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

/** Decrypts a sealed key; throws on a wrong secret or a changed row. */
export function openKey(sealed: { cipher: string; iv: string; tag: string }, key: Buffer): string {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(sealed.cipher, 'base64')), d.final()]).toString('utf8');
}

const notSetUp = () => new AiHttpError(503, 'AI_NOT_CONFIGURED', 'Your own key can’t be kept on this server yet.');
const refused = (message: string) => new AiHttpError(400, 'KEY_REFUSED', message);

/** The person's key in use, or null. */
export function activeOwnKey(userId: string): Promise<AiKey | null> {
    return prisma.aiKey.findFirst({ where: { userId, removedAt: null }, orderBy: { createdAt: 'desc' } });
}

/** Opens the key and makes its client, once (keyFor calls this when it chooses the key). False when it can't be opened. */
export function readyOwnClient(row: AiKey): boolean {
    const s = secret();
    if (!s) return false;
    try {
        registerOwnClient(ownKeyId(row), openKey(row, s));
        return true;
    } catch {
        // The reason only (never the key): a changed secret or row.
        console.warn('[ai] an own key could not be opened (the server secret changed?)');
        return false;
    }
}

/** A probe after a restart: the key's client made from its row (no client: false). */
export async function loadOwnClient(keyId: string): Promise<boolean> {
    if (!keyId.startsWith('own:')) return true;
    const row = await prisma.aiKey.findFirst({ where: { id: keyId.slice(4), removedAt: null } });
    return !!row && readyOwnClient(row);
}

export interface OwnKeyView {
    last4: string;
    addedAt: string;
    checkedAt: string | null;
    /** ok, or paused: no_credit | bad_key. */
    state: 'ok' | 'no_credit' | 'bad_key';
}

export async function ownKeyView(userId: string): Promise<OwnKeyView | null> {
    const row = await activeOwnKey(userId);
    if (!row) return null;
    return { last4: row.last4, addedAt: row.createdAt.toISOString(), checkedAt: row.checkedAt?.toISOString() ?? null, state: (await keyState(ownKeyId(row))).state };
}

const isNotFound = (err: unknown) => (err as { status?: unknown } | null)?.status === 404;

/**
 * PUT /api/ai/key: the key is checked on each model the app calls (one token each, on the key itself), then stored
 * encrypted; the one before it ends. A refusal says why (rejected, no credit, a model it can't use) and stores nothing.
 * The key is never in the answer, a log line or the error.
 */
export async function setOwnKey(userId: string, raw: string, now: Date = new Date()): Promise<OwnKeyView> {
    const key = raw.trim();
    if (!KEY_SHAPE.test(key)) throw refused('That doesn’t look like a Claude API key (it starts with sk-ant-).');
    const s = secret();
    if (!s) throw notSetUp();
    const client = checkClient(key);
    for (const model of CHECK_MODELS) {
        try {
            await client.createMessage({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] } as never);
        } catch (err) {
            const fault = classifyAiError(err);
            if (fault === 'bad_key') throw refused('Claude didn’t accept that key.');
            if (fault === 'no_credit') throw refused('That key has no credit left. Add credit in the Claude Console, then try again.');
            if (isNotFound(err)) throw refused(`That key can’t use ${model}, which the app needs.`);
            throw refused('The check didn’t go through. Try again in a minute.');
        }
    }
    const sealed = sealKey(key, s);
    const before = await prisma.aiKey.findMany({ where: { userId, removedAt: null }, select: { id: true } });
    const row = await prisma.$transaction(async (tx) => {
        await tx.aiKey.updateMany({ where: { userId, removedAt: null }, data: { removedAt: now } });
        return tx.aiKey.create({ data: { userId, ...sealed, last4: key.slice(-4), checkedAt: now, createdAt: now } });
    });
    for (const b of before) forgetOwnClient(ownKeyId(b));
    await markKeyOk(ownKeyId(row), now);
    readyOwnClient(row);
    return { last4: row.last4, addedAt: row.createdAt.toISOString(), checkedAt: now.toISOString(), state: 'ok' };
}

/** DELETE /api/ai/key: it ends at once (the server's key again where it is allowed, else no AI). */
export async function removeOwnKey(userId: string, now: Date = new Date()): Promise<{ removed: number }> {
    const rows = await prisma.aiKey.findMany({ where: { userId, removedAt: null }, select: { id: true } });
    const r = await prisma.aiKey.updateMany({ where: { userId, removedAt: null }, data: { removedAt: now } });
    for (const row of rows) forgetOwnClient(ownKeyId(row));
    // A removed key is never probed again.
    if (rows.length) await prisma.aiKeyState.deleteMany({ where: { keyId: { in: rows.map(ownKeyId) } } });
    return { removed: r.count };
}
