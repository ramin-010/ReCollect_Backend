// Nightly pre-writing of Recall questions with the Message Batches API (half price), so pressing
// Revise opens a ready set instead of waiting for the model.
//
//   02:30 server time  submitNightlyRecallBatch: for each recently active user under their cap, the
//                      earliest pending revision of each item due by the user's tomorrow (overdue
//                      and today's included) that has no live set (a failed one is retried). One
//                      batch for everyone, custom_id = revisionId; each gets a `pending` RecallSet.
//   every 10 minutes   pollRecallBatches: an ended batch's results become `ready` sets (or `failed`
//                      ones: errored, expired, declined or unreadable), each request an AiUsage row
//                      with batch = true, all in one transaction per batch.
// A set the user starts before its batch ends is written on demand and taken over (startRecall);
// the batch's result for it is then only billed, not stored. A failed set is rewritten on demand.
// RECALL_NIGHTLY_BATCH=off turns the nightly submission off (the poller keeps running).
import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { poke } from '../scheduler/scheduler';
import { addDays, resolveTimeZone, today as todayIn } from '../learning';
import { fromDbDay, toDbDay } from '../learningDb/common';
import { aiModel, getAiClient, isAiConfigured, type BatchRequest, type BatchResultLine, type MessageBatch } from '../claude/client';
import { HOUSE_KEY, keyFor, keyState, noteAiFailure } from '../claude/access';
import { allowanceOf } from '../claude/allowance';
import { isUnderCap, recordAiUsage } from '../claude/usage.service';
import { earlierQuestions, materialOf, recallRevisionInclude } from './material';
import { ModelOutputError, type RecallQuestion } from './output';
import { hasEnoughContent, questionsRequest } from './prompts';
import { openWeakSpotsOf } from '../learningDb/sessions.service';
import { questionsFromMessage } from './recall.service';

/** At most this many sets per user per night (a long backlog fills up over several nights). */
export const NIGHTLY_MAX_PER_USER = 25;
/** Only users who opened the app (POST /api/learning/ensure-today) within this many days. */
export const ACTIVE_WITHIN_DAYS = 7;
/** A batch still open after this long is given up on (the API ends every batch within 24 h). */
const GIVE_UP_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export interface PlannedRecall {
    userId: string;
    revisionId: string;
    cycleNumber: number;
    docId: string | null;
    request: BatchRequest;
}

/** What tonight's batch should write, with each request built (no writes, no API calls). */
export async function planNightlyRecall(now: Date = new Date()): Promise<PlannedRecall[]> {
    const model = aiModel();
    const users = await prisma.user.findMany({
        where: { revisions: { some: { status: 'pending' } } },
        select: { id: true, timezone: true, lastSeenDay: true },
        orderBy: { id: 'asc' },
    });
    const planned: PlannedRecall[] = [];
    for (const user of users) {
        const today = todayIn(resolveTimeZone(user.timezone), now);
        if (!user.lastSeenDay || fromDbDay(user.lastSeenDay) < addDays(today, -ACTIVE_WITHIN_DAYS)) continue;
        if (!(await isUnderCap(user.id, now))) continue;
        // Only accounts on the server's key (a person's own key gets Recall on demand: stage 10).
        if ((await keyFor(user.id)).keyId !== HOUSE_KEY) continue;
        // Stage 11: a friend whose free AI waits gets no questions written tonight (Recall on demand once it runs again).
        const allowance = await allowanceOf(user.id, now);
        if (allowance?.reason) continue;

        const revisions = await prisma.revision.findMany({
            where: { userId: user.id, status: 'pending', scheduledFor: { lte: toDbDay(addDays(today, 1)) } },
            orderBy: [{ scheduledFor: 'asc' }, { cycleNumber: 'asc' }],
            include: { ...recallRevisionInclude, recallSets: { where: { finishedAt: null }, select: { status: true } } },
        });
        const seenItems = new Set<string>();
        let count = 0;
        for (const rev of revisions) {
            if (count >= NIGHTLY_MAX_PER_USER) break;
            // Home shows an item's earliest pending cycle only; later ones wait for it.
            const item = rev.topicId ?? rev.captureId ?? rev.id;
            if (seenItems.has(item)) continue;
            seenItems.add(item);
            if (rev.recallSets.some((s) => s.status !== 'failed')) continue;
            const material = await materialOf(user.id, rev);
            if (!hasEnoughContent(material)) continue;
            const earlier = await earlierQuestions(rev);
            const weakSpots = rev.topicId ? (await openWeakSpotsOf(user.id, [rev.topicId])).get(rev.topicId) ?? [] : [];
            planned.push({
                userId: user.id,
                revisionId: rev.id,
                cycleNumber: rev.cycleNumber,
                docId: material.docId,
                request: { custom_id: rev.id, params: questionsRequest({ model, material, cycleNumber: rev.cycleNumber, earlier, weakSpots }) },
            });
            count += 1;
        }
    }
    return planned;
}

/** Plans tonight's sets and submits them as one Message Batch. */
export async function submitNightlyRecallBatch(now: Date = new Date()): Promise<{ batchId: string | null; requests: number }> {
    if (!isAiConfigured()) return { batchId: null, requests: 0 };
    // The batch runs on the server's key, for the accounts on it; a paused key sends none (ECOSYSTEM_V2_PLAN stage 2).
    if ((await keyState(HOUSE_KEY)).state !== 'ok') return { batchId: null, requests: 0 };
    const planned = await planNightlyRecall(now);
    if (planned.length === 0) return { batchId: null, requests: 0 };

    const client = getAiClient(HOUSE_KEY);
    const model = aiModel();
    let batch: MessageBatch;
    try {
        batch = await client.createBatch(planned.map((p) => p.request));
    } catch (err) {
        await noteAiFailure(HOUSE_KEY, err, now);
        throw err;
    }
    try {
        await prisma.$transaction(
            async (tx) => {
                await tx.aiBatch.create({
                    data: {
                        id: batch.id,
                        feature: 'recall_questions',
                        model,
                        owners: Object.fromEntries(planned.map((p) => [p.revisionId, p.userId])),
                        requestCount: planned.length,
                    },
                    select: { id: true },
                });
                for (const p of planned) {
                    await tx.$queryRaw`SELECT "id" FROM "Revision" WHERE "id" = ${p.revisionId} FOR UPDATE`;
                    const live = await tx.recallSet.findFirst({
                        where: { revisionId: p.revisionId, finishedAt: null },
                        orderBy: { createdAt: 'desc' },
                        select: { id: true, status: true },
                    });
                    if (live && live.status !== 'failed') continue; // started meanwhile: the result will only be billed
                    const data = { status: 'pending' as const, questions: [], model, batchId: batch.id, error: null, docId: p.docId, cycleNumber: p.cycleNumber };
                    if (live) await tx.recallSet.update({ where: { id: live.id }, data, select: { id: true } });
                    else await tx.recallSet.create({ data: { userId: p.userId, revisionId: p.revisionId, ...data }, select: { id: true } });
                }
            },
            { timeout: 60_000 }
        );
    } catch (err) {
        // Without its rows nobody would ever store (or bill) this batch: cancel it.
        await client.cancelBatch(batch.id).catch((e: unknown) => console.error(`[recall] cancelling batch ${batch.id} failed: ${e instanceof Error ? e.message : String(e)}`));
        throw err;
    }
    poke('recallPoll'); // a batch is open: the quiet scheduler polls it every 10 minutes until it ends
    return { batchId: batch.id, requests: planned.length };
}

function ownersOf(value: Prisma.JsonValue): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

interface ReadLine {
    revisionId: string;
    /** A billed response (succeeded requests only). */
    message: { model: string; usage: Anthropic.Messages.Usage } | null;
    questions: RecallQuestion[] | null;
    error: string | null;
}

function readLine(line: BatchResultLine): ReadLine {
    const revisionId = line.custom_id;
    if (line.result.type !== 'succeeded') {
        const detail = line.result.type === 'errored' ? `: ${line.result.error.error.type}` : '';
        return { revisionId, message: null, questions: null, error: `Batch request ${line.result.type}${detail}` };
    }
    const message = line.result.message;
    try {
        return { revisionId, message, questions: questionsFromMessage(message), error: null };
    } catch (err) {
        return { revisionId, message, questions: null, error: err instanceof ModelOutputError ? err.message : String(err) };
    }
}

/**
 * An ended batch's results → its sets and AiUsage rows, in one transaction (a second poll of the
 * same batch stores nothing). Sets started meanwhile are no longer `pending` and stay as they are.
 */
export async function storeBatchResults(batchId: string, lines: readonly BatchResultLine[], now: Date = new Date()): Promise<{ ready: number; failed: number }> {
    const read = lines.map(readLine);
    return prisma.$transaction(
        async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "AiBatch" WHERE "id" = ${batchId} FOR UPDATE`;
            const batch = await tx.aiBatch.findUnique({ where: { id: batchId }, select: { endedAt: true, owners: true } });
            if (!batch || batch.endedAt) return { ready: 0, failed: 0 };
            const owners = ownersOf(batch.owners);
            let ready = 0;
            let failed = 0;
            for (const r of read) {
                const userId = owners[r.revisionId];
                if (r.message && userId) await recordAiUsage(userId, 'recall_questions', r.message, { batch: true, db: tx });
                const where = { revisionId: r.revisionId, batchId, status: 'pending' as const };
                if (r.questions && r.message) {
                    const res = await tx.recallSet.updateMany({
                        where,
                        data: { status: 'ready', questions: r.questions as unknown as Prisma.InputJsonValue, model: r.message.model.slice(0, 100), error: null },
                    });
                    ready += res.count;
                } else {
                    const res = await tx.recallSet.updateMany({ where, data: { status: 'failed', error: (r.error ?? 'No questions').slice(0, 500) } });
                    failed += res.count;
                }
            }
            const missing = await tx.recallSet.updateMany({ where: { batchId, status: 'pending' }, data: { status: 'failed', error: 'No result in the batch' } });
            failed += missing.count;
            const summary = `${lines.length} results: ${ready} sets ready, ${failed} failed`;
            await tx.aiBatch.update({ where: { id: batchId }, data: { endedAt: now, summary }, select: { id: true } });
            return { ready, failed };
        },
        { timeout: 60_000 }
    );
}

/** A batch that can't be read any more: its pending sets fail (they are written on demand). */
async function giveUpBatch(batchId: string, why: string, now: Date): Promise<void> {
    await prisma.$transaction(async (tx) => {
        await tx.recallSet.updateMany({ where: { batchId, status: 'pending' }, data: { status: 'failed', error: why.slice(0, 500) } });
        await tx.aiBatch.update({ where: { id: batchId }, data: { endedAt: now, summary: `Given up: ${why}`.slice(0, 300) }, select: { id: true } });
    });
}

/** Stores every open batch that has ended. */
export async function pollRecallBatches(now: Date = new Date()): Promise<{ open: number; stored: number }> {
    const open = await prisma.aiBatch.findMany({ where: { endedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true } });
    if (open.length === 0 || !isAiConfigured()) return { open: open.length, stored: 0 };
    const client = getAiClient();
    let stored = 0;
    for (const b of open) {
        try {
            const batch = await client.retrieveBatch(b.id);
            if (batch.processing_status !== 'ended') {
                if (now.getTime() - b.createdAt.getTime() > GIVE_UP_AFTER_MS) await giveUpBatch(b.id, 'still not ended after 3 days', now);
                continue;
            }
            const lines: BatchResultLine[] = [];
            for await (const line of await client.batchResults(b.id)) lines.push(line);
            await storeBatchResults(b.id, lines, now);
            stored += 1;
        } catch (err) {
            if (err instanceof Anthropic.NotFoundError) {
                await giveUpBatch(b.id, 'the batch no longer exists', now);
                continue;
            }
            console.error(`[recall] polling batch ${b.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return { open: open.length, stored };
}

let submitting = false;
let polling = false;

// ─── The quiet scheduler's moments (hosting P1-11) ───────────────────────────

/** While a batch is open it is polled this often; with none open there is no poll at all. */
export const RECALL_POLL_MS = 10 * 60_000;

export async function nextRecallPollDue(now: Date = new Date()): Promise<Date | null> {
    if (!isAiConfigured()) return null;
    const open = await prisma.aiBatch.findFirst({ where: { endedAt: null }, select: { id: true } });
    return open ? new Date(now.getTime() + RECALL_POLL_MS) : null;
}

/** RECALL_NIGHTLY_BATCH=off stops the nightly questions. */
export const recallNightlyOn = (): boolean => process.env.RECALL_NIGHTLY_BATCH?.trim().toLowerCase() !== 'off';

/** The next 02:30 on the server's clock (the cron's '30 2 * * *'); no query. */
export function nextRecallNightly(now: Date = new Date()): Date | null {
    if (!recallNightlyOn() || !isAiConfigured()) return null;
    const at = new Date(now);
    at.setHours(2, 30, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    return at;
}

/** The two crons (src/index.ts). They do nothing while CLAUDE_API_KEY is missing. */
export function startRecallCrons(): void {
    const nightly = recallNightlyOn();
    if (nightly) {
        cron.schedule('30 2 * * *', async () => {
            if (submitting || !isAiConfigured()) return;
            submitting = true;
            try {
                const r = await submitNightlyRecallBatch();
                if (r.requests > 0) console.log(`[recall] nightly batch ${r.batchId}: ${r.requests} question sets`);
            } catch (err) {
                console.error(`[recall] nightly batch failed: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                submitting = false;
            }
        });
    }
    cron.schedule('*/10 * * * *', async () => {
        if (polling) return; // a slow poll never overlaps the next one
        polling = true;
        try {
            const r = await pollRecallBatches();
            if (r.stored > 0) console.log(`[recall] stored ${r.stored} finished batch(es)`);
        } catch (err) {
            console.error(`[recall] batch poll failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            polling = false;
        }
    });
    console.log(`✓ Recall crons started (nightly questions ${nightly ? 'at 02:30' : 'off'}, batch poll every 10 min)`);
}
