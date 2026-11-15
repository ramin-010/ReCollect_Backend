// The capture worker (BUDDY_MEMORY_PLAN §3.1): every minute, the queued pieces of his chats go
// through the gate and the digest, oldest first, and are deleted once digested. A piece waits while
// the buddy may not spend (off, at a cap; the AI is down), is dropped (and counted) when he has paused
// the buddy, after 3 failed tries, or after 48 hours: his raw words never stay longer.
import cron from 'node-cron';
import type { BuddyChunk } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { isAiConfigured } from '../claude/client';
import { loadLearningContext } from '../learningDb/common';
import { bumpDay } from './capture.service';
import { digestChunk } from './digest';
import { buddyMaySpend } from './spend';

export const CHUNK_MAX_AGE_MS = 48 * 3600_000;
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
        if (may === 'paused') {
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
            await bumpDay(c.userId, today, { kept: r.kept, notes: r.notes, items: r.items });
            result.digested++;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await prisma.buddyChunk.updateMany({ where: { id: c.id }, data: { attempts: { increment: 1 }, lastError: message.slice(0, 300) } });
            console.error(`[buddy] a piece of a chat could not be digested (try ${c.attempts + 1}): ${message}`);
            result.failed++;
            // An AI outage: leave the rest of the queue for the next tick.
            if (/busy|overloaded|credit|AI_/i.test(message)) break;
        }
    }
    return result;
}

let running = false;

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
}
