// Bring in other chats (ECOSYSTEM_V2_PLAN stage 8, E5): a chat export from Claude or ChatGPT. Only his own
// messages, with their own dates; an estimate (pieces and dollars) before anything is read; on his yes and up to
// the limit he approves, the newest first, each piece queued for the digest as old news (it builds history: it
// never moves a stage, starts a question, a pulse or a notification, and an old plan opens a quiet thread). An
// outside message is known by its chat, its words and its own time to the second, so the same export uploaded
// twice, or a message heard by another route, is read once (§4.11 rule 3). Scrubbed like every other word.
//
//   POST /api/buddy/import              {export, fileName?} → the estimate (nothing read yet)
//   POST /api/buddy/imports/:id/approve {limitUsd}          → queued
//   POST /api/buddy/imports/:id/cancel                      → what waits is dropped
//   GET  /api/buddy/imports                                 → each import and how far it got
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { badRequest, notFound } from '../learning/http';
import { poke } from '../scheduler/scheduler';
import { scrubSecrets } from './scrub';
import type { ChunkMessage } from './capture.service';

/** What one piece costs to read (the digest on Sonnet, measured at about $0.004; a margin on top). */
export const IMPORT_PIECE_USD = 0.006;
/** A piece holds one chat's messages of one day, up to this many characters (as the hooks' pieces). */
const PIECE_CHARS = 2000;
const MESSAGE_MAX = 1000;
/** A file of this many of his messages at most (a bigger history: the newest of them). */
const MESSAGES_MAX = 5000;

export interface ImportedChat {
    /** The outside chat's own id. */
    key: string;
    title: string;
    /** `print`: the fingerprint of its own words (before scrubbing). */
    messages: Array<{ text: string; at: Date; print?: string }>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const date = (v: unknown): Date | null => {
    const d = typeof v === 'number' ? new Date(v * 1000) : typeof v === 'string' ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
};

/**
 * His own messages from an export (pure): Claude's conversations.json (`chat_messages`, sender "human") or
 * ChatGPT's (`mapping`, author role "user"). The assistant's words, system text and empty messages are left
 * out. Null when the file is neither.
 */
export function parseExport(data: unknown): { source: 'claude' | 'chatgpt'; chats: ImportedChat[] } | null {
    const list = Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { conversations?: unknown }).conversations) ? (data as { conversations: unknown[] }).conversations : null;
    if (!list) return null;
    const chats: ImportedChat[] = [];
    let source: 'claude' | 'chatgpt' | null = null;
    for (const c of list) {
        if (!c || typeof c !== 'object') continue;
        const o = c as Record<string, unknown>;
        const messages: ImportedChat['messages'] = [];
        if (Array.isArray(o['chat_messages'])) {
            source ??= 'claude';
            for (const m of o['chat_messages'] as Array<Record<string, unknown>>) {
                if (m?.['sender'] !== 'human') continue;
                const parts = Array.isArray(m['content']) ? (m['content'] as Array<Record<string, unknown>>).filter((p) => p?.['type'] === 'text').map((p) => str(p['text']) ?? '') : [];
                const text = (str(m['text']) ?? parts.join('\n')).trim();
                const at = date(m['created_at']);
                if (text && at) messages.push({ text, at });
            }
            chats.push({ key: String(o['uuid'] ?? o['id'] ?? chats.length), title: str(o['name']) ?? '', messages });
        } else if (o['mapping'] && typeof o['mapping'] === 'object') {
            source ??= 'chatgpt';
            for (const node of Object.values(o['mapping'] as Record<string, Record<string, unknown>>)) {
                const m = node?.['message'] as Record<string, unknown> | undefined;
                const author = m?.['author'] as Record<string, unknown> | undefined;
                if (!m || author?.['role'] !== 'user') continue;
                const content = m['content'] as Record<string, unknown> | undefined;
                const text = (Array.isArray(content?.['parts']) ? (content!['parts'] as unknown[]).filter((p): p is string => typeof p === 'string').join('\n') : '').trim();
                const at = date(m['create_time']);
                if (text && at) messages.push({ text, at });
            }
            messages.sort((a, b) => a.at.getTime() - b.at.getTime());
            chats.push({ key: String(o['conversation_id'] ?? o['id'] ?? chats.length), title: str(o['title']) ?? '', messages });
        }
    }
    return source ? { source, chats: chats.filter((c) => c.messages.length) } : null;
}

/** An outside message's fingerprint: its words, normalized (§4.11 rule 3: with its chat and its time to the second, it is known). */
export function wordsPrint(text: string): string {
    return createHash('sha256').update(text.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 32);
}

const second = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);

/** One chat's messages as pieces: one day of one chat each, up to PIECE_CHARS (pure). */
export function piecesOf(chat: ImportedChat): Array<ImportedChat['messages']> {
    const out: Array<ImportedChat['messages']> = [];
    let cur: ImportedChat['messages'] = [];
    let chars = 0;
    for (const m of chat.messages) {
        const day = m.at.toISOString().slice(0, 10);
        const curDay = cur[0]?.at.toISOString().slice(0, 10);
        if (cur.length && (day !== curDay || chars + m.text.length > PIECE_CHARS)) {
            out.push(cur);
            cur = [];
            chars = 0;
        }
        cur.push(m);
        chars += m.text.length;
    }
    if (cur.length) out.push(cur);
    return out;
}

export interface ImportJson {
    _id: string;
    source: string;
    fileName: string | null;
    chats: number;
    messages: number;
    known: number;
    pieces: number;
    estimateUsd: number;
    limitUsd: number | null;
    state: string;
    queued: number;
    /** Pieces still waiting to be read (queued ones not digested yet). */
    waiting: number;
    oldest: string | null;
    newest: string | null;
    createdAt: string;
}

type ImportRow = Awaited<ReturnType<typeof prisma.buddyImport.findFirstOrThrow>>;

async function importJson(row: ImportRow): Promise<ImportJson> {
    const waiting = row.state === 'queued' ? await prisma.buddyChunk.count({ where: { userId: row.userId, sessionKey: { startsWith: `import:${row.id}:` } } }) : 0;
    return {
        _id: row.id,
        source: row.source,
        fileName: row.fileName,
        chats: row.chats,
        messages: row.messages,
        known: row.known,
        pieces: row.pieces,
        estimateUsd: Number(row.estimateUsd),
        limitUsd: row.limitUsd === null ? null : Number(row.limitUsd),
        state: row.state,
        queued: row.queued,
        waiting,
        oldest: row.oldest?.toISOString() ?? null,
        newest: row.newest?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
    };
}

/** The estimate: his messages not heard before, in pieces, and what reading them costs. Nothing is read yet. */
export async function estimateImport(userId: string, data: unknown, fileName: string | null, now: Date = new Date()): Promise<ImportJson> {
    const parsed = parseExport(data);
    if (!parsed) throw badRequest('That is not a chat export from Claude or ChatGPT (conversations.json)');
    const all = parsed.chats.flatMap((c) => c.messages.map((m) => ({ chat: c, m })));
    // Known already: the same chat, words and time (to the second).
    const heard = new Set(
        (await prisma.buddyHeard.findMany({ where: { userId, chatKey: { in: [...new Set(parsed.chats.map((c) => c.key.slice(0, 120)))] } }, select: { chatKey: true, fingerprint: true, saidAt: true } })).map((h) => `${h.chatKey}|${h.fingerprint}|${h.saidAt.getTime()}`)
    );
    const fresh = new Map<string, ImportedChat>();
    let known = 0;
    for (const { chat, m } of all) {
        const key = chat.key.slice(0, 120);
        if (heard.has(`${key}|${wordsPrint(m.text)}|${second(m.at).getTime()}`)) {
            known++;
            continue;
        }
        const c = fresh.get(key) ?? { key, title: chat.title, messages: [] };
        c.messages.push({ text: scrubSecrets(m.text).slice(0, MESSAGE_MAX), at: second(m.at), print: wordsPrint(m.text) });
        fresh.set(key, c);
    }
    // The newest messages first when a history is bigger than one import takes.
    const kept = [...fresh.values()].flatMap((c) => c.messages.map((m) => ({ c, m }))).sort((a, b) => b.m.at.getTime() - a.m.at.getTime()).slice(0, MESSAGES_MAX);
    const chats = new Map<string, ImportedChat>();
    for (const { c, m } of kept) {
        const x = chats.get(c.key) ?? { key: c.key, title: c.title, messages: [] };
        x.messages.push(m);
        chats.set(c.key, x);
    }
    for (const c of chats.values()) c.messages.sort((a, b) => a.at.getTime() - b.at.getTime());
    const pieces = [...chats.values()].reduce((n, c) => n + piecesOf(c).length, 0);
    const times = kept.map((k) => k.m.at.getTime());
    const row = await prisma.buddyImport.create({
        data: {
            userId,
            source: parsed.source,
            fileName: fileName?.slice(0, 200) ?? null,
            chats: chats.size,
            messages: kept.length,
            known,
            pieces,
            estimateUsd: (pieces * IMPORT_PIECE_USD).toFixed(4),
            oldest: times.length ? new Date(Math.min(...times)) : null,
            newest: times.length ? new Date(Math.max(...times)) : null,
            payload: [...chats.values()].map((c) => ({ key: c.key, title: c.title.slice(0, 120), messages: c.messages.map((m) => ({ text: m.text, at: m.at.toISOString(), print: m.print })) })) as unknown as Prisma.InputJsonValue,
            createdAt: now,
        },
    });
    return importJson(row);
}

/**
 * His yes, with the limit he approves: the newest pieces first, as many as the limit covers, queued for the
 * digest as old news; every message queued is now known (a second upload skips it). The estimate's payload goes.
 */
export async function approveImport(userId: string, id: string, limitUsd: number, now: Date = new Date()): Promise<ImportJson> {
    const row = await prisma.buddyImport.findFirst({ where: { id, userId } });
    if (!row) throw notFound();
    if (row.state !== 'estimated') throw badRequest(`That import is ${row.state} already`);
    const chats = (Array.isArray(row.payload) ? row.payload : []) as unknown as Array<{ key: string; title: string; messages: Array<{ text: string; at: string; print?: string }> }>;
    const pieces = chats
        .flatMap((c) => piecesOf({ key: c.key, title: c.title, messages: c.messages.map((m) => ({ text: m.text, at: new Date(m.at), ...(m.print ? { print: m.print } : {}) })) }).map((p) => ({ chat: c.key, p })))
        .sort((a, b) => b.p[b.p.length - 1]!.at.getTime() - a.p[a.p.length - 1]!.at.getTime());
    const take = Math.max(0, Math.min(pieces.length, Math.floor(limitUsd / IMPORT_PIECE_USD + 1e-9)));
    const chosen = pieces.slice(0, take);
    let n = 0;
    for (const { chat, p } of chosen) {
        n++;
        const messages: ChunkMessage[] = p.map((m) => ({ at: m.at.toISOString(), text: m.text }));
        await prisma.buddyChunk.create({
            data: { userId, sessionKey: `import:${row.id}:${n}`.slice(0, 80), seq: 1, source: 'app', via: 'import', saidFrom: p[0]!.at, messages: messages as unknown as Prisma.InputJsonValue, createdAt: now },
            select: { id: true },
        });
        await prisma.buddyHeard.createMany({ data: p.map((m) => ({ userId, chatKey: chat, fingerprint: m.print ?? wordsPrint(m.text), saidAt: m.at })), skipDuplicates: true });
    }
    const updated = await prisma.buddyImport.update({ where: { id: row.id }, data: { state: 'queued', queued: chosen.length, limitUsd: limitUsd.toFixed(4), payload: [] } });
    if (chosen.length) poke('capture');
    return importJson(updated);
}

/** Stops an import: the pieces still waiting go (what was read stays); an estimate not approved is dropped. */
export async function cancelImport(userId: string, id: string): Promise<ImportJson> {
    const row = await prisma.buddyImport.findFirst({ where: { id, userId } });
    if (!row) throw notFound();
    await prisma.buddyChunk.deleteMany({ where: { userId, sessionKey: { startsWith: `import:${row.id}:` } } });
    return importJson(await prisma.buddyImport.update({ where: { id: row.id }, data: { state: 'cancelled', payload: [] } }));
}

/** His imports, newest first, with how far each got. */
export async function listImports(userId: string): Promise<ImportJson[]> {
    const rows = await prisma.buddyImport.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 });
    return Promise.all(rows.map(importJson));
}
