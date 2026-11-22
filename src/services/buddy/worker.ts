// The capture worker (BUDDY_MEMORY_PLAN §3.1): every minute, the queued pieces of his chats go
// through the gate and the digest, oldest first, and are deleted once digested. A piece waits while
// the buddy may not spend (off, at a cap; the AI is down), is dropped (and counted) when he has paused
// the buddy, after 3 failed tries, or after 48 hours: his raw words never stay longer.
import cron from 'node-cron';
import type { BuddyChunk } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { isAiConfigured } from '../claude/client';
import { isAiPausedError, keyFor } from '../claude/access';
import { addDays, endOfMonth, startOfDay, type DayString } from '../learning';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { bumpDay, type ChunkMessage } from './capture.service';
import { digestChunk } from './digest';
import { buddyMaySpend } from './spend';
import { runNight, type BuddyDayJson } from './think';
import { PULSE_HOURS, pulseDue, pulseIfDue } from './pulse';
import { chapterIfDue, yearIfDue } from './chapter';

export const CHUNK_MAX_AGE_MS = 48 * 3600_000;

/**
 * A failure that says nothing about the piece: the model is overloaded or rate-limited, the account
 * is out of credit, the server or the network failed, a timeout. Such a piece waits for the next pass.
 */
export function isTransientAiError(err: unknown): boolean {
    const e = err as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown; message?: unknown } | null;
    const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : 0;
    if (status === 408 || status === 409 || status === 429 || status === 529 || status >= 500) return true;
    const code = typeof e?.code === 'string' ? e.code : '';
    if (/^(AI_BUSY|AI_UNAVAILABLE|AI_OVERLOADED|AI_TIMEOUT|AI_CREDIT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR)/.test(code)) return true;
    const name = typeof e?.name === 'string' ? e.name : '';
    if (/APIConnectionError|APIConnectionTimeoutError|InternalServerError|RateLimitError|AbortError|TimeoutError/.test(name)) return true;
    const message = typeof e?.message === 'string' ? e.message : '';
    return /overloaded|busy|rate.?limit|credit|timed? ?out|temporarily|unavailable|could not answer just now|socket hang up|network|ECONNRESET|ETIMEDOUT/i.test(message);
}
export const CHUNK_TRIES = 3;
const PER_TICK = 10;

export interface DrainResult {
    digested: number;
    dropped: number;
    failed: number;
    waiting: number;
}

const messageCount = (c: BuddyChunk) => (Array.isArray(c.messages) ? c.messages.length : 0);

/**
 * Stage 4: the hooks send at every message, each with its number in the session. The queue reads a
 * session's numbered pieces together once the oldest has waited this long or they hold 2,000
 * characters (the old flush's cadence, so the cost stays as it was), and at once while one of the
 * buddy's questions is open, so an answer typed in a chat clears it within seconds.
 */
export const HOOK_WAIT_MS = 10 * 60_000;
export const HOOK_CHARS = 2000;

type Unit = { chunks: BuddyChunk[]; piece: BuddyChunk; numbered: boolean };

const messagesOf = (c: BuddyChunk) => (Array.isArray(c.messages) ? (c.messages as unknown as ChunkMessage[]) : []);
const isNumbered = (c: BuddyChunk) => !c.via && messagesOf(c).some((m) => typeof m.n === 'number');

/**
 * One session's numbered pieces as one (pure): each message once, by its number, the version to read
 * winning over a context copy; one context message before the first new one; the earliest time said.
 */
export function mergePieces(chunks: readonly BuddyChunk[]): BuddyChunk {
    const first = chunks[0]!;
    if (chunks.length === 1) return first;
    const byN = new Map<number, ChunkMessage>();
    for (const m of chunks.flatMap(messagesOf)) {
        const n = m.n ?? 0;
        const had = byN.get(n);
        if (!had || (had.context && !m.context)) byN.set(n, m);
    }
    const all = [...byN.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
    const firstNew = all.findIndex((m) => !m.context);
    const context = firstNew > 0 ? [all[firstNew - 1]!] : [];
    const messages = [...context, ...all.slice(Math.max(firstNew, 0)).filter((m) => !m.context)];
    const said = chunks.map((c) => c.saidFrom?.getTime()).filter((t): t is number => typeof t === 'number');
    return { ...first, messages: messages as unknown as BuddyChunk['messages'], saidFrom: said.length ? new Date(Math.min(...said)) : first.saidFrom };
}

/** MCP_MEMORY_PLAN §4.5: saves by the same app within this span are read as one unit. */
export const SAVES_TOGETHER_MS = 10 * 60_000;
/** A new build's save waits this long, so a related one said a moment later joins it. */
export const SAVE_SETTLE_MS = 2 * 60_000;

/** Saved notes read together: each message once, in the order they were saved. */
function mergeNotes(chunks: readonly BuddyChunk[]): BuddyChunk {
    const first = chunks[0]!;
    return chunks.length === 1 ? first : { ...first, messages: chunks.flatMap(messagesOf) as unknown as BuddyChunk['messages'] };
}

/**
 * A person's waiting pieces as units: a session's numbered pieces together; saved notes from the same app within 10
 * minutes together (§4.5); every other piece alone (oldest first).
 */
function unitsOf(chunks: readonly BuddyChunk[]): Unit[] {
    const units: Unit[] = [];
    const sessions = new Map<string, Unit>();
    const saves: Unit[] = [];
    for (const c of chunks) {
        // A catch-up's batches are read one by one (each is up to 15 things already).
        if (c.noteId && c.via !== 'catchup') {
            const u = saves.find((s) => s.piece.via === c.via && s.piece.source === c.source && c.createdAt.getTime() - s.chunks[0]!.createdAt.getTime() <= SAVES_TOGETHER_MS);
            if (u) {
                u.chunks.push(c);
                u.piece = mergeNotes(u.chunks);
                continue;
            }
            const unit: Unit = { chunks: [c], piece: c, numbered: false };
            saves.push(unit);
            units.push(unit);
            continue;
        }
        if (!isNumbered(c)) {
            units.push({ chunks: [c], piece: c, numbered: false });
            continue;
        }
        const u = sessions.get(c.sessionKey);
        if (u) u.chunks.push(c);
        else {
            const unit: Unit = { chunks: [c], piece: c, numbered: true };
            sessions.set(c.sessionKey, unit);
            units.push(unit);
        }
    }
    for (const u of units) if (u.numbered) u.piece = mergePieces([...u.chunks].sort((a, b) => (messagesOf(a)[0]?.n ?? 0) - (messagesOf(b)[0]?.n ?? 0)));
    return units;
}

/** A session's numbered pieces are due: waited long enough, long enough, or a question is open. */
function unitDue(u: Unit, now: Date, askOpen: boolean): boolean {
    // A new build's saves (they say whose word they are) settle a moment, so the next save can join them (§4.5).
    if (u.piece.noteId && messagesOf(u.piece).some((m) => m.basis)) {
        const newest = Math.max(...u.chunks.map((c) => c.createdAt.getTime()));
        const oldest = Math.min(...u.chunks.map((c) => c.createdAt.getTime()));
        return now.getTime() - newest >= SAVE_SETTLE_MS || now.getTime() - oldest >= SAVES_TOGETHER_MS;
    }
    if (!u.numbered || askOpen) return true;
    const oldest = Math.min(...u.chunks.map((c) => c.createdAt.getTime()));
    const chars = messagesOf(u.piece).filter((m) => !m.context).reduce((n, m) => n + m.text.length, 0);
    return now.getTime() - oldest >= HOOK_WAIT_MS || chars >= HOOK_CHARS;
}

/** A piece of saved notes that can't be read: the notes it names wait for the catch-up, and the piece goes (no words are dropped). */
async function markNotesWaiting(chunks: readonly BuddyChunk[], now: Date): Promise<void> {
    const ids = new Set<string>();
    for (const c of chunks) {
        if (c.noteId) ids.add(c.noteId);
        for (const m of messagesOf(c)) if (typeof m.noteId === 'string') ids.add(m.noteId);
    }
    const userId = chunks[0]!.userId;
    await prisma.observation.updateMany({ where: { userId, id: { in: [...ids] }, waitingSince: null }, data: { waitingSince: now } });
    await prisma.buddyChunk.deleteMany({ where: { id: { in: chunks.map((c) => c.id) } } });
}

async function drop(c: BuddyChunk, now: Date): Promise<void> {
    await prisma.buddyChunk.deleteMany({ where: { id: c.id } });
    const { today } = await loadLearningContext(c.userId, now);
    await bumpDay(c.userId, today, { dropped: messageCount(c) });
}

/** One person's pieces handled in one pass, so nobody waits behind one long queue. */
export const PIECES_PER_PERSON = 3;

/**
 * One pass over the queue (at most `limit` pieces), person by person (ECOSYSTEM_V2_PLAN §4.15): the
 * people whose oldest piece has waited longest go first, up to PIECES_PER_PERSON each. A person who
 * must wait (the buddy off or at a cap, the AI paused on their key) is passed over without holding
 * anyone back. An outage of the AI itself (busy, unreachable) passes over the people on that key for
 * this pass; only a failure of the piece itself counts toward its 3 tries.
 */
export async function drainBuddyQueue(now: Date = new Date(), limit = PER_TICK): Promise<DrainResult> {
    const result: DrainResult = { digested: 0, dropped: 0, failed: 0, waiting: 0 };
    // MCP_MEMORY_PLAN §4.7: saved details that waited for the AI are queued again, or caught up on, when it can run.
    const { catchUpPass } = await import('./catchup');
    await catchUpPass(now);
    const people = await prisma.buddyChunk.groupBy({ by: ['userId'], _min: { createdAt: true }, _count: { _all: true }, orderBy: { _min: { createdAt: 'asc' } } });
    const busyKeys = new Set<string>();
    let handled = 0;
    for (const person of people) {
        const count = person._count._all;
        if (handled >= limit) {
            result.waiting += count;
            continue;
        }
        const { userId } = person;
        const [may, { keyId }] = await Promise.all([buddyMaySpend(userId, now), keyFor(userId)]);
        const chunks = await prisma.buddyChunk.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, take: 100 });
        // Stage 8: his live words first; an import's pieces after them (they are old news and may be many).
        const units = unitsOf(chunks).sort((a, b) => Number(a.piece.via === 'import') - Number(b.piece.via === 'import'));
        const askOpen = units.some((u) => u.numbered) && (await prisma.buddyAsk.count({ where: { userId, state: 'open', fromAt: { lte: now }, untilAt: { gt: now } } })) > 0;
        let done = 0;
        let read = 0;
        for (const u of units) {
            if (handled >= limit || read >= PIECES_PER_PERSON) break;
            const ids = u.chunks.map((c) => c.id);
            const c = u.piece;
            // Too old or tried too often; the buddy paused by him, or an account the AI is not for
            // (AI_ALLOWED_EMAILS): its words are dropped, counted. A saved note waiting to be linked
            // is not raw chat: no 48-hour limit (§4.15).
            const oldest = Math.min(...u.chunks.map((x) => x.createdAt.getTime()));
            const expired = !c.noteId && now.getTime() - oldest > CHUNK_MAX_AGE_MS;
            if (expired || u.chunks.some((x) => x.attempts >= CHUNK_TRIES) || may === 'paused' || may === 'not_allowed') {
                // Saved notes are kept already (MCP_MEMORY_PLAN §4.7, R1): their piece goes, and each note is marked
                // waiting for the catch-up, so nothing saved is lost for lack of AI.
                if (u.chunks.every((x) => x.noteId)) {
                    await markNotesWaiting(u.chunks, now);
                    handled++;
                    done += u.chunks.length;
                    continue;
                }
                for (const x of u.chunks) await drop(x, now);
                result.dropped++;
                handled++;
                done += u.chunks.length;
                continue;
            }
            // Off, at a cap, or the AI paused on this key: it waits (the 48-hour limit above still holds).
            if (may !== 'ok' || (keyId && busyKeys.has(keyId))) break;
            // A session's numbered pieces wait a little, to be read together.
            if (!unitDue(u, now, askOpen)) continue;
            read++;
            try {
                const r = await digestChunk(c, now, { alsoIds: ids.filter((id) => id !== c.id) });
                await prisma.buddyChunk.deleteMany({ where: { id: { in: ids } } });
                const { today } = await loadLearningContext(c.userId, now);
                await bumpDay(c.userId, today, { kept: r.kept, notes: r.notes, items: r.items, work: r.work });
                result.digested++;
                handled++;
                done += u.chunks.length;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                // The key ran out of credit or was rejected just now: callClaude paused it; the pieces wait.
                if (isAiPausedError(err)) break;
                // A model or network outage is not the piece's fault: it waits (kept, its tries untouched),
                // and so does everyone on that key until the next pass (the quiet scheduler: 1, 2, 5, then
                // every 15 minutes).
                if (isTransientAiError(err)) {
                    await prisma.buddyChunk.updateMany({ where: { id: { in: ids } }, data: { lastError: message.slice(0, 300) } });
                    console.error(`[buddy] the AI is unavailable; the queue waits (${message.slice(0, 120)})`);
                    if (keyId) busyKeys.add(keyId);
                    result.failed++;
                    break;
                }
                await prisma.buddyChunk.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 }, lastError: message.slice(0, 300) } });
                console.error(`[buddy] a piece of a chat could not be digested (try ${c.attempts + 1}): ${message}`);
                result.failed++;
                handled++;
                done += u.chunks.length;
            }
        }
        result.waiting += count - done;
    }
    return result;
}

// ─── The nights ─────────────────────────────────────────────────────────────

const NIGHT_HOUR = 4;
const NIGHT_TRIES = 3;
const nightTries = new Map<string, number>();

const hourIn = (tz: string, now: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now)) % 24;

/**
 * The night for one user when it is due: after 04:00 his time, once per local day (claimed first, so
 * two passes never run it twice); `fresh` runs it again today (his button). Null when it isn't due
 * or the buddy may not spend.
 */
export async function nightIfDue(userId: string, now: Date = new Date(), opts: { fresh?: boolean } = {}): Promise<BuddyDayJson | null> {
    const ctx = await loadLearningContext(userId, now);
    if (!opts.fresh && hourIn(ctx.tz, now) < NIGHT_HOUR) return null;
    if ((await buddyMaySpend(userId, now)) !== 'ok') return null;
    const day = toDbDay(ctx.today);
    if (!opts.fresh) {
        const claimed = await prisma.buddyState.updateMany({ where: { userId, OR: [{ lastNightDay: null }, { lastNightDay: { not: day } }] }, data: { lastNightDay: day } });
        if (claimed.count === 0) return null;
    }
    const key = `${userId}:${ctx.today}`;
    try {
        const r = await runNight(userId, now);
        nightTries.delete(key);
        return r;
    } catch (err) {
        const tries = (nightTries.get(key) ?? 0) + 1;
        nightTries.set(key, tries);
        // A failed night may try again on the next pass, three times a day at most.
        if (!opts.fresh && tries < NIGHT_TRIES) await prisma.buddyState.updateMany({ where: { userId, lastNightDay: day }, data: { lastNightDay: null } });
        throw err;
    }
}

// ─── The next moments (the quiet scheduler, hosting P1-11) ──────────────────

/** Waiting pieces (the AI down, a cap reached) are tried again this often while any wait. */
export const CAPTURE_RETRY_MS = 15 * 60_000;

/**
 * The queue's next moment: none without pieces or without the AI; else a retry for the ones that wait,
 * or sooner when a session's numbered pieces fall due (stage 4: they wait HOOK_WAIT_MS to be read together).
 */
export async function nextCaptureDue(now: Date = new Date()): Promise<Date | null> {
    if (!isAiConfigured()) return null;
    const waiting = await prisma.buddyChunk.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    if (!waiting) return null;
    const retry = now.getTime() + CAPTURE_RETRY_MS;
    const due = waiting.createdAt.getTime() + HOOK_WAIT_MS;
    return new Date(due > now.getTime() && due < retry ? due : retry);
}

/** `hour`:00 on `day` in `tz`. */
const atHour = (day: DayString, tz: string, hour: number) => new Date(startOfDay(day, tz).getTime() + hour * 3600_000);

/**
 * The buddy's next moment for one user: the night after 04:00 his time (once a day), then a pulse
 * at 09:00, 12:00, 15:00, 18:00 and 21:00 when something new arrived (their own doings in the app included, 11-22), and with the loop on a pulse on an event when it falls
 * due (§4.13). A buddy that may not spend waits for a change (a poke from his settings) or, at a cap, for
 * the next month; a buddy that is off has none.
 */
export async function nextBuddyMomentFor(userId: string, now: Date = new Date()): Promise<Date | null> {
    const ctx = await loadLearningContext(userId, now);
    const gate = await buddyMaySpend(userId, now);
    if (gate === 'buddy_cap' || gate === 'account_cap') return atHour(addDays(endOfMonth(ctx.today), 1), ctx.tz, 0);
    // Stage 11: a friend's free AI: today's limit ends at midnight, the friends' ceiling with the month; used up waits
    // for a top-up (the owner's top-up pokes the scheduler).
    if (gate === 'allowance') {
        const { allowanceOf } = await import('../claude/allowance');
        const reason = (await allowanceOf(userId, now))?.reason;
        if (reason === 'day') return atHour(addDays(ctx.today, 1), ctx.tz, 0);
        if (reason === 'ceiling') return atHour(addDays(endOfMonth(ctx.today), 1), ctx.tz, 0);
        return null;
    }
    if (gate !== 'ok') return null;
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { lastNightDay: true } });
    const hour = hourIn(ctx.tz, now);
    const nightDone = state?.lastNightDay && fromDbDay(state.lastNightDay) === ctx.today;
    if (!nightDone) return hour >= NIGHT_HOUR ? now : atHour(ctx.today, ctx.tz, NIGHT_HOUR);
    const pulse = await pulseDue(userId, now);
    // Due now, or one on an event to count as skipped (the day's are used up).
    if (pulse.due || pulse.skip) return now;
    const pulseLater = PULSE_HOURS.find((h) => h > hour);
    // Something new before the next pulse hour reaches the scheduler as a poke (a digest, a thumb, an answer).
    const fixed = pulseLater !== undefined ? atHour(ctx.today, ctx.tz, pulseLater) : atHour(addDays(ctx.today, 1), ctx.tz, NIGHT_HOUR);
    return pulse.at && pulse.at < fixed ? pulse.at : fixed;
}

/** The earliest next moment over every user whose buddy is on. */
export async function nextBuddyDue(now: Date = new Date()): Promise<Date | null> {
    if (!isAiConfigured()) return null;
    const users = await prisma.buddyState.findMany({ where: { enabled: true, paused: false }, select: { userId: true } });
    let soonest: Date | null = null;
    for (const { userId } of users) {
        const at = await nextBuddyMomentFor(userId, now);
        if (at && (!soonest || at < soonest)) soonest = at;
    }
    return soonest;
}

/** Every user whose buddy is on gets the night when it is due, and the fixed pulses (09:00 to 21:00, every 3 hours) when something new arrived. */
export async function runDueNights(now: Date = new Date()): Promise<{ ran: number; failed: number }> {
    const users = await prisma.buddyState.findMany({ where: { enabled: true, paused: false }, select: { userId: true } });
    let ran = 0;
    let failed = 0;
    for (const { userId } of users) {
        try {
            if (await nightIfDue(userId, now)) {
                ran++;
                // The first nights of a month also write the month that ended (B7).
                if (await chapterIfDue(userId, now)) ran++;
                else if (await yearIfDue(userId, now)) ran++;
            } else if ((await buddyMaySpend(userId, now)) === 'ok' && (await pulseIfDue(userId, now)).ran) ran++;
        } catch (err) {
            failed++;
            console.error(`[buddy] a step failed for a user: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { ran, failed };
}

let running = false;
let nightsRunning = false;

/** Every minute (not in tests; BUDDY_WORKER=off turns it off). */
export function startBuddyWorker(): void {
    if (process.env['NODE_ENV'] === 'test' || /^(off|0|false)$/i.test(process.env['BUDDY_WORKER'] ?? '')) return;
    cron.schedule('* * * * *', async () => {
        if (running || !isAiConfigured()) return;
        running = true;
        try {
            const r = await drainBuddyQueue();
            if (r.digested || r.dropped || r.failed) console.log(`[buddy] queue: ${r.digested} digested, ${r.dropped} dropped, ${r.failed} failed, ${r.waiting} waiting`);
        } catch (err) {
            console.error('[buddy] queue pass failed:', err);
        } finally {
            running = false;
        }
    });
    // The nights: every 15 minutes, for whoever's 04:00 has passed (a laptop that was off catches up).
    const nights = async () => {
        if (nightsRunning || !isAiConfigured()) return;
        nightsRunning = true;
        try {
            const r = await runDueNights();
            if (r.ran || r.failed) console.log(`[buddy] nights: ${r.ran} ran, ${r.failed} failed`);
        } catch (err) {
            console.error('[buddy] nights pass failed:', err);
        } finally {
            nightsRunning = false;
        }
    };
    cron.schedule('*/15 * * * *', () => void nights());
}
