// Capture (BUDDY_MEMORY_PLAN §3.1): his typed words from the Claude Code hooks, scrubbed of secrets,
// queued as one BuddyChunk per piece of a session; the worker (./worker.ts) gates and digests them,
// then deletes the chunk. Only counts are kept per day (BuddyCaptureDay), never words.
//
//   queueWords   POST /api/buddy/words {sessionKey, seq, project?, office?, v?, canHold?, messages[≤ 50]}   sessions:write → 202
//
// Stage 4 (ECOSYSTEM_V2_PLAN §4.11 rule 2, §4.15): with `v: 2` every message carries its own number in its
// session (`n`), and the server keeps how far it has read each session (BuddySessionMark): it takes only
// what is new, whatever is sent again, and answers how far it has read, so a send whose answer was lost
// loses and doubles nothing. A message it already read may come again as context (`context: true`):
// the digest sees it, never reads it. A hook that can hold (`canHold`) is told 503 AI_PAUSED while the
// person's AI is paused or a budget is used up, and keeps the words on the PC; any other sender gets
// today's answer. Every answer says `capture: 2`, so a hook learns it may send this way.
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { poke } from '../scheduler/scheduler';
import type { DayString } from '../learning';
import { badRequest } from '../learning/http';
import { loadLearningContext, toDbDay } from '../learningDb/common';
import { officeFolder } from '../learningDb/lens';
import { scrubSecrets } from './scrub';
import { isBuddyPaused } from './state.service';
import { AiHttpError } from '../claude/errors';

export const WORDS_PER_CHUNK = 50;
/** One message's words as the buddy keeps them (the hook already cuts long pastes). */
export const WORD_TEXT_MAX = 4000;
/** The agent's reply, for context only. */
export const REPLY_MAX = 300;

export interface ChunkMessage {
    at: string;
    text: string;
    reply?: string;
    /** Stage 3: the buddy's words just before his (its question, its last answer), for context only. */
    before?: string;
    /** Stage 4: its own number in its session (the hooks' second protocol). */
    n?: number;
    /** Stage 4: already read; sent again as context only (never read twice). */
    context?: boolean;
    /** MCP_MEMORY_PLAN §4.7: the saved note these words are (a piece of saved notes names each one). */
    noteId?: string;
    /** §4.4: whose word that saved note is ('said', 'inferred'; left out: own, or passed on as before). */
    basis?: string | null;
}

/** The protocol this server speaks (a hook that sees it may send message numbers). */
export const CAPTURE_PROTOCOL = 2;

/**
 * His own words from inside the app (ECOSYSTEM_V2_PLAN stage 3): a message to the buddy's chat, or his
 * words in answer to one of its questions. Scrubbed and queued like the hooks' words, marked with
 * their kind of source (`via`), read without the gate. Paused: dropped, counted. Once only per key
 * and number (a retry is not queued twice).
 */
/**
 * Stage 8 (E3): words an agent passes on from a chat the hooks don't hear (claude.ai, the phone): `about` on
 * get_brief, `said` on checkpoint. Indirect (the agent's relay: his own later words win), read through the
 * gate, never from a work folder; only with the loop on. Scrubbed like every word. At most 3, 300 characters each.
 */
export async function queueRelayedWords(userId: string, sessionKey: string, words: readonly string[], now: Date = new Date()): Promise<{ queued: number }> {
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { loop: true, enabled: true, paused: true } });
    if (!state?.loop || !state.enabled || state.paused) return { queued: 0 };
    const messages: ChunkMessage[] = words
        .slice(0, 3)
        .map((w) => cut(scrubSecrets(w).replace(/\s+/g, ' ').trim(), 300))
        .filter(Boolean)
        .map((text) => ({ at: now.toISOString(), text }));
    if (!messages.length) return { queued: 0 };
    const { today } = await loadLearningContext(userId, now);
    // Each relay its own piece: a number from its time (two in the same millisecond: the next number).
    const key = `relay:${sessionKey}`.slice(0, 80);
    for (let seq = now.getTime() % 2_000_000_000, tries = 0; ; seq++, tries++) {
        try {
            await prisma.buddyChunk.create({ data: { userId, sessionKey: key, seq, source: 'agent', via: 'connector', saidFrom: now, messages: messages as unknown as Prisma.InputJsonValue, createdAt: now }, select: { id: true } });
            break;
        } catch (err) {
            if (tries >= 3 || !(err instanceof Error && 'code' in err && (err as { code?: string }).code === 'P2002')) throw err;
        }
    }
    await bumpSource(userId, today, 'connector', { seen: messages.length, pieces: 1 }, now);
    poke('capture');
    return { queued: messages.length };
}

export async function queueOwnWords(
    userId: string,
    input: { key: string; seq: number; via: 'ask_ai' | 'doc_ask' | 'answer' | 'pocket'; messages: ReadonlyArray<{ at: string; text: string; before?: string | undefined; reply?: string | undefined }> },
    now: Date = new Date()
): Promise<{ queued: number; paused?: true; duplicate?: true }> {
    const { today } = await loadLearningContext(userId, now);
    if (await isBuddyPaused(userId)) {
        await bumpDay(userId, today, { seen: input.messages.length, dropped: input.messages.length });
        await bumpSource(userId, today, input.via, { seen: input.messages.length, dropped: input.messages.length }, now);
        return { queued: 0, paused: true };
    }
    let secrets = 0;
    const messages: ChunkMessage[] = [];
    for (const m of input.messages) {
        const text = scrubSecrets(m.text);
        if (text !== m.text) secrets++;
        const clean = cut(text.trim(), WORD_TEXT_MAX);
        if (!clean) continue;
        const at = !Number.isNaN(Date.parse(m.at)) ? new Date(m.at).toISOString() : now.toISOString();
        const before = m.before ? cut(scrubSecrets(m.before).replace(/\s+/g, ' ').trim(), REPLY_MAX) : '';
        const reply = m.reply ? cut(scrubSecrets(m.reply).replace(/\s+/g, ' ').trim(), REPLY_MAX) : '';
        messages.push({ at, text: clean, ...(before ? { before } : {}), ...(reply ? { reply } : {}) });
    }
    if (!messages.length) return { queued: 0 };
    const saidFrom = new Date(Math.min(...messages.map((m) => Date.parse(m.at))));
    try {
        await prisma.buddyChunk.create({
            // Its times from the `now` it is given (ECOSYSTEM_V2_PLAN §10.1: a test can move the clock).
            data: { userId, sessionKey: input.key.slice(0, 80), seq: input.seq, source: 'app', via: input.via, saidFrom, messages: messages as unknown as Prisma.InputJsonValue, createdAt: now },
            select: { id: true },
        });
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { queued: 0, duplicate: true };
        throw err;
    }
    await bumpDay(userId, today, { seen: messages.length, chunks: 1, secrets });
    await bumpSource(userId, today, input.via, { seen: messages.length, pieces: 1 }, now);
    poke('capture');
    return { queued: messages.length };
}

export interface WordsInput {
    sessionKey: string;
    seq: number;
    project?: string | null | undefined;
    /** B9: from a folder that never gets his brief (office work). */
    office?: boolean | undefined;
    /** Stage 4: 2 = every message carries its own number in the session (`n`). */
    v?: 2 | undefined;
    /** Stage 4: the hook keeps his words on his PC while his AI is paused (it is told 503 AI_PAUSED). */
    canHold?: boolean | undefined;
    messages: ReadonlyArray<{ at?: string | undefined; text: string; reply?: string | undefined; n?: number | undefined; context?: boolean | undefined }>;
}

export interface WordsResult {
    queued: number;
    paused?: true;
    office?: true;
    duplicate?: true;
    /** Stage 4 (v 2): the highest message number of the session the server has taken. */
    read?: number;
    capture: number;
}

/** Per source, per day (the ear meter's data): { seen, pieces, dropped, last }. */
export interface SourceCounts {
    seen?: number;
    pieces?: number;
    dropped?: number;
}

/**
 * Adds to his day's counts for one source (hook, ask_ai, doc_ask, answer, agent, tell, ...) and keeps
 * when it was last heard: one statement, so two sends at once never lose a count.
 */
export async function bumpSource(userId: string, day: DayString, source: string, inc: SourceCounts, at: Date = new Date()): Promise<void> {
    const key = source.slice(0, 20);
    const seen = inc.seen ?? 0;
    const pieces = inc.pieces ?? 0;
    const dropped = inc.dropped ?? 0;
    const last = at.toISOString();
    await prisma.$executeRaw`
        INSERT INTO "BuddyCaptureDay" ("userId", "day", "bySource")
        VALUES (${userId}, ${toDbDay(day)}, jsonb_build_object(${key}::text, jsonb_build_object('seen', ${seen}::int, 'pieces', ${pieces}::int, 'dropped', ${dropped}::int, 'last', ${last}::text)))
        ON CONFLICT ("userId", "day") DO UPDATE SET "bySource" = "BuddyCaptureDay"."bySource" || jsonb_build_object(${key}::text, jsonb_build_object(
            'seen', COALESCE(("BuddyCaptureDay"."bySource" -> ${key}::text ->> 'seen')::int, 0) + ${seen}::int,
            'pieces', COALESCE(("BuddyCaptureDay"."bySource" -> ${key}::text ->> 'pieces')::int, 0) + ${pieces}::int,
            'dropped', COALESCE(("BuddyCaptureDay"."bySource" -> ${key}::text ->> 'dropped')::int, 0) + ${dropped}::int,
            'last', GREATEST(COALESCE("BuddyCaptureDay"."bySource" -> ${key}::text ->> 'last', ''), ${last}::text)))`;
}

/** The ear meter (stage 5, H1): each source heard in the last 30 days, its last time and the last 7 days' counts. */
export interface EarSource {
    source: string;
    last: string | null;
    seen7: number;
    dropped7: number;
    /** Not heard for 7 days (named on /you). */
    silent: boolean;
}

export async function earMeter(userId: string, now: Date = new Date()): Promise<EarSource[]> {
    const rows = await prisma.buddyCaptureDay.findMany({ where: { userId, day: { gte: new Date(now.getTime() - 31 * 86_400_000) } }, select: { day: true, bySource: true } });
    const weekAgo = now.getTime() - 7 * 86_400_000;
    const out = new Map<string, EarSource>();
    for (const r of rows) {
        const recent = r.day.getTime() >= weekAgo - 86_400_000;
        for (const [source, v] of Object.entries((r.bySource ?? {}) as Record<string, { seen?: number; dropped?: number; last?: string }>)) {
            const e = out.get(source) ?? { source, last: null, seen7: 0, dropped7: 0, silent: true };
            if (v.last && (!e.last || v.last > e.last)) e.last = v.last;
            if (recent) {
                e.seen7 += v.seen ?? 0;
                e.dropped7 += v.dropped ?? 0;
            }
            out.set(source, e);
        }
    }
    return [...out.values()].map((e) => ({ ...e, silent: !e.last || Date.parse(e.last) < weekAgo })).sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));
}

/** 503 AI_PAUSED for a hook that can hold: it keeps the words on the PC and sends them on return. */
const holdWords = () => new AiHttpError(503, 'AI_PAUSED', 'The buddy is waiting: AI is paused for this account. Keep the words and send them later.');

export interface DayCounts {
    seen?: number;
    kept?: number;
    chunks?: number;
    dropped?: number;
    secrets?: number;
    notes?: number;
    items?: number;
    /** B9: work lines written. */
    work?: number;
}

/** Adds to his day's counts. */
export async function bumpDay(userId: string, day: DayString, inc: DayCounts): Promise<void> {
    const data = Object.fromEntries(Object.entries(inc).filter(([, v]) => v)) as Record<string, number>;
    if (!Object.keys(data).length) return;
    await prisma.buddyCaptureDay.upsert({
        where: { userId_day: { userId, day: toDbDay(day) } },
        create: { userId, day: toDbDay(day), ...data },
        update: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { increment: v }])),
    });
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * BUDDY_OFFICE_CAPTURE=off (hosting P1-14; production): words a hook marked as office work are
 * dropped on arrival, counted, never stored: the second guard after the hooks' own folder rules
 * (which since B10 send no words from an office folder at all). Unset: kept, as before.
 */
export const officeCaptureOff = (env: NodeJS.ProcessEnv = process.env): boolean => /^(off|0|false|no)$/i.test(env['BUDDY_OFFICE_CAPTURE']?.trim() ?? '');

/**
 * Queue a piece of a session's words. Paused, or office words with BUDDY_OFFICE_CAPTURE=off: dropped
 * (counted; with message numbers, marked as taken). A retried piece is not queued twice.
 */
export async function queueWords(userId: string, input: WordsInput, now: Date = new Date()): Promise<WordsResult> {
    if (input.messages.length > WORDS_PER_CHUNK) throw badRequest(`At most ${WORDS_PER_CHUNK} messages at once`);
    const numbered = input.v === 2;
    if (numbered && input.messages.some((m) => !Number.isInteger(m.n) || (m.n ?? 0) < 1)) throw badRequest('Each message needs its number in the session (n ≥ 1)');
    const { today } = await loadLearningContext(userId, now);
    const sessionKey = input.sessionKey.slice(0, 80);
    const fresh = numbered ? input.messages.filter((m) => !m.context) : input.messages;
    const topN = numbered ? Math.max(0, ...input.messages.map((m) => m.n ?? 0)) : 0;
    // Words that will never be read (office words switched off, a buddy he paused): counted, and with
    // message numbers marked as taken, so they are not sent again.
    const skip = async (why: 'office' | 'paused'): Promise<WordsResult> => {
        await bumpDay(userId, today, { seen: fresh.length, dropped: fresh.length });
        await bumpSource(userId, today, 'hook', { seen: fresh.length, dropped: fresh.length }, now);
        const read = numbered ? await markRead(userId, sessionKey, topN) : undefined;
        return { queued: 0, ...(why === 'office' ? { office: true as const } : { paused: true as const }), ...(read !== undefined ? { read } : {}), capture: CAPTURE_PROTOCOL };
    };
    // PERSONAL_OFFICE_PLAN: a folder the server knows as work is office work whatever the PC's rule says.
    const office = await officeFolder(userId, input.project, input.office);
    if (office && officeCaptureOff()) return skip('office');
    if (await isBuddyPaused(userId)) return skip('paused');
    // His AI is paused or a budget is used up: a hook that can hold keeps the words (§4.15).
    if (input.canHold === true) {
        const { buddyMaySpend } = await import('./spend');
        const gate = await buddyMaySpend(userId, now);
        if (gate === 'ai_paused' || gate === 'allowance' || gate === 'buddy_cap' || gate === 'account_cap') throw holdWords();
    }
    let secrets = 0;
    const clean = (m: WordsInput['messages'][number]): ChunkMessage | null => {
        const text = scrubSecrets(m.text);
        const reply = m.reply ? scrubSecrets(m.reply) : '';
        if (text !== m.text || reply !== (m.reply ?? '')) secrets++;
        const words = cut(text.trim(), WORD_TEXT_MAX);
        if (!words) return null;
        const at = m.at && !Number.isNaN(Date.parse(m.at)) ? new Date(m.at).toISOString() : now.toISOString();
        return { at, text: words, ...(reply.trim() ? { reply: cut(reply.replace(/\s+/g, ' ').trim(), REPLY_MAX) } : {}), ...(numbered ? { n: m.n! } : {}) };
    };
    if (!numbered) {
        const messages = input.messages.map(clean).filter((m): m is ChunkMessage => !!m);
        if (!messages.length) return { queued: 0, capture: CAPTURE_PROTOCOL };
        try {
            await prisma.buddyChunk.create({
                data: {
                    userId,
                    sessionKey,
                    seq: input.seq,
                    project: input.project ? input.project.toLowerCase().slice(0, 100) : null,
                    office,
                    messages: messages as unknown as Prisma.InputJsonValue,
                },
                select: { id: true },
            });
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { queued: 0, duplicate: true, capture: CAPTURE_PROTOCOL };
            throw err;
        }
        await bumpDay(userId, today, { seen: messages.length, chunks: 1, secrets });
        await bumpSource(userId, today, 'hook', { seen: messages.length, pieces: 1 }, now);
        poke('capture'); // digested a few seconds from now (the quiet scheduler; poll mode: the next minute)
        return { queued: messages.length, capture: CAPTURE_PROTOCOL };
    }

    // Message numbers: under the person's lock, take only what is past the session's mark; the last
    // message already read comes along as context. The mark and the piece are one transaction.
    const { withPersonLock } = await import('./threads');
    const taken = await withPersonLock(userId, async (tx) => {
        const mark = await tx.buddySessionMark.findUnique({ where: { userId_sessionKey: { userId, sessionKey } } });
        const readTo = mark?.readTo ?? 0;
        const ordered = [...input.messages].sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
        const newOnes = ordered.filter((m) => (m.n ?? 0) > readTo && !m.context);
        if (!newOnes.length) return { queued: 0, read: readTo, duplicate: true as const };
        const contextOne = [...ordered].reverse().find((m) => (m.n ?? 0) <= readTo);
        const messages = [
            ...(contextOne ? [clean(contextOne)].filter((m): m is ChunkMessage => !!m).map((m) => ({ ...m, context: true })) : []),
            ...newOnes.map(clean).filter((m): m is ChunkMessage => !!m),
        ];
        const read = Math.max(readTo, ...newOnes.map((m) => m.n ?? 0));
        await tx.buddySessionMark.upsert({ where: { userId_sessionKey: { userId, sessionKey } }, create: { userId, sessionKey, readTo: read }, update: { readTo: read } });
        const reading = messages.filter((m) => !m.context);
        if (!reading.length) return { queued: 0, read };
        await tx.buddyChunk.create({
            data: {
                userId,
                sessionKey,
                // The first new message's number: a piece sent again carries the same, never two pieces of the same words.
                seq: newOnes[0]!.n!,
                project: input.project ? input.project.toLowerCase().slice(0, 100) : null,
                office,
                saidFrom: new Date(Math.min(...reading.map((m) => Date.parse(m.at)))),
                messages: messages as unknown as Prisma.InputJsonValue,
                createdAt: now,
            },
            select: { id: true },
        });
        return { queued: reading.length, read };
    });
    if (taken.queued) {
        await bumpDay(userId, today, { seen: taken.queued, chunks: 1, secrets });
        await bumpSource(userId, today, 'hook', { seen: taken.queued, pieces: 1 }, now);
        poke('capture');
    }
    return { ...taken, capture: CAPTURE_PROTOCOL };
}

/** Marks a session's messages up to `n` as taken (never moves back). */
async function markRead(userId: string, sessionKey: string, n: number): Promise<number> {
    const mark = await prisma.buddySessionMark.upsert({ where: { userId_sessionKey: { userId, sessionKey } }, create: { userId, sessionKey, readTo: n }, update: {} });
    if (mark.readTo >= n) return mark.readTo;
    await prisma.buddySessionMark.updateMany({ where: { userId, sessionKey, readTo: { lt: n } }, data: { readTo: n } });
    return n;
}
