// The capture worker (BUDDY_MEMORY_PLAN §3.1): every minute, the queued pieces of his chats go
// through the gate and the digest, oldest first, and are deleted once digested. A piece waits while
// the buddy may not spend (off, at a cap; the AI is down), is dropped (and counted) when he has paused
// the buddy, after 3 failed tries, or after 48 hours: his raw words never stay longer.
import cron from 'node-cron';
import type { BuddyChunk } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { isAiConfigured } from '../claude/client';
import { addDays, endOfMonth, startOfDay, type DayString } from '../learning';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { bumpDay } from './capture.service';
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

async function drop(c: BuddyChunk, now: Date): Promise<void> {
    await prisma.buddyChunk.deleteMany({ where: { id: c.id } });
    const { today } = await loadLearningContext(c.userId, now);
    await bumpDay(c.userId, today, { dropped: messageCount(c) });
}

/** One pass over the queue (at most PER_TICK pieces). */
export async function drainBuddyQueue(now: Date = new Date(), limit = PER_TICK): Promise<DrainResult> {
    const result: DrainResult = { digested: 0, dropped: 0, failed: 0, waiting: 0 };
    const chunks = await prisma.buddyChunk.findMany({ orderBy: { createdAt: 'asc' }, take: limit });
    const mayCache = new Map<string, string>();
    for (const c of chunks) {
        if (now.getTime() - c.createdAt.getTime() > CHUNK_MAX_AGE_MS || c.attempts >= CHUNK_TRIES) {
            await drop(c, now);
            result.dropped++;
            continue;
        }
        let may = mayCache.get(c.userId);
        if (!may) {
            may = await buddyMaySpend(c.userId, now);
            mayCache.set(c.userId, may);
        }
        // Paused, or an account the AI is not for (AI_ALLOWED_EMAILS): its words are dropped, counted.
        if (may === 'paused' || may === 'not_allowed') {
            await drop(c, now);
            result.dropped++;
            continue;
        }
        if (may !== 'ok') {
            result.waiting++;
            continue;
        }
        try {
            const r = await digestChunk(c, now);
            await prisma.buddyChunk.deleteMany({ where: { id: c.id } });
            const { today } = await loadLearningContext(c.userId, now);
            await bumpDay(c.userId, today, { kept: r.kept, notes: r.notes, items: r.items, work: r.work });
            result.digested++;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // A model or network outage is not the piece's fault: it waits (kept, its tries untouched) and
            // the whole queue is tried again later (the quiet scheduler: 1, 2, 5, then every 15 minutes).
            // Only a failure of the piece itself counts toward its 3 tries. Either way the 48-hour limit
            // still bounds how long his words are kept.
            if (isTransientAiError(err)) {
                await prisma.buddyChunk.updateMany({ where: { id: c.id }, data: { lastError: message.slice(0, 300) } });
                console.error(`[buddy] the AI is unavailable; the queue waits (${message.slice(0, 120)})`);
                result.failed++;
                result.waiting += chunks.length - chunks.indexOf(c) - 1;
                break;
            }
            await prisma.buddyChunk.updateMany({ where: { id: c.id }, data: { attempts: { increment: 1 }, lastError: message.slice(0, 300) } });
            console.error(`[buddy] a piece of a chat could not be digested (try ${c.attempts + 1}): ${message}`);
            result.failed++;
        }
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

/** The queue's next moment: none without pieces or without the AI; else a retry for the ones that wait. */
export async function nextCaptureDue(now: Date = new Date()): Promise<Date | null> {
    if (!isAiConfigured()) return null;
    const waiting = await prisma.buddyChunk.findFirst({ select: { id: true } });
    return waiting ? new Date(now.getTime() + CAPTURE_RETRY_MS) : null;
}

/** `hour`:00 on `day` in `tz`. */
const atHour = (day: DayString, tz: string, hour: number) => new Date(startOfDay(day, tz).getTime() + hour * 3600_000);

/**
 * The buddy's next moment for one user: the night after 04:00 his time (once a day), then a pulse
 * at 12:00 and 18:00 when something new arrived. A buddy that may not spend waits for a change
 * (a poke from his settings) or, at a cap, for the next month; a buddy that is off has none.
 */
export async function nextBuddyMomentFor(userId: string, now: Date = new Date()): Promise<Date | null> {
    const ctx = await loadLearningContext(userId, now);
    const gate = await buddyMaySpend(userId, now);
    if (gate === 'buddy_cap' || gate === 'account_cap') return atHour(addDays(endOfMonth(ctx.today), 1), ctx.tz, 0);
    if (gate !== 'ok') return null;
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { lastNightDay: true } });
    const hour = hourIn(ctx.tz, now);
    const nightDone = state?.lastNightDay && fromDbDay(state.lastNightDay) === ctx.today;
    if (!nightDone) return hour >= NIGHT_HOUR ? now : atHour(ctx.today, ctx.tz, NIGHT_HOUR);
    if ((await pulseDue(userId, now)).due) return now;
    const pulseLater = PULSE_HOURS.find((h) => h > hour);
    // Something new before the next pulse hour reaches the scheduler as a poke (a digest, a thumb).
    return pulseLater !== undefined ? atHour(ctx.today, ctx.tz, pulseLater) : atHour(addDays(ctx.today, 1), ctx.tz, NIGHT_HOUR);
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

/** Every user whose buddy is on gets the night when it is due, and the pulses at 12:00 and 18:00 when something new arrived. */
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
