// Capture (BUDDY_MEMORY_PLAN §3.1): his typed words from the Claude Code hooks, scrubbed of secrets,
// queued as one BuddyChunk per piece of a session; the worker (./worker.ts) gates and digests them,
// then deletes the chunk. Only counts are kept per day (BuddyCaptureDay), never words.
//
//   queueWords   POST /api/buddy/words {sessionKey, seq, project?, office?, messages[≤ 50]}   sessions:write → 202
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import type { DayString } from '../learning';
import { badRequest } from '../learning/http';
import { loadLearningContext, toDbDay } from '../learningDb/common';
import { scrubSecrets } from './scrub';
import { isBuddyPaused } from './state.service';

export const WORDS_PER_CHUNK = 50;
/** One message's words as the buddy keeps them (the hook already cuts long pastes). */
export const WORD_TEXT_MAX = 4000;
/** The agent's reply, for context only. */
export const REPLY_MAX = 300;

export interface ChunkMessage {
    at: string;
    text: string;
    reply?: string;
}

export interface WordsInput {
    sessionKey: string;
    seq: number;
    project?: string | null | undefined;
    /** B9: from a folder that never gets his brief (office work). */
    office?: boolean | undefined;
    messages: ReadonlyArray<{ at?: string | undefined; text: string; reply?: string | undefined }>;
}

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

/** Queue a piece of a session's words. Paused: dropped (counted). A retried piece is not queued twice. */
export async function queueWords(userId: string, input: WordsInput, now: Date = new Date()): Promise<{ queued: number; paused?: true; duplicate?: true }> {
    if (input.messages.length > WORDS_PER_CHUNK) throw badRequest(`At most ${WORDS_PER_CHUNK} messages at once`);
    const { today } = await loadLearningContext(userId, now);
    if (await isBuddyPaused(userId)) {
        await bumpDay(userId, today, { seen: input.messages.length, dropped: input.messages.length });
        return { queued: 0, paused: true };
    }
    let secrets = 0;
    const messages: ChunkMessage[] = [];
    for (const m of input.messages) {
        const text = scrubSecrets(m.text);
        const reply = m.reply ? scrubSecrets(m.reply) : '';
        if (text !== m.text || reply !== (m.reply ?? '')) secrets++;
        const clean = cut(text.trim(), WORD_TEXT_MAX);
        if (!clean) continue;
        const at = m.at && !Number.isNaN(Date.parse(m.at)) ? new Date(m.at).toISOString() : now.toISOString();
        messages.push({ at, text: clean, ...(reply.trim() ? { reply: cut(reply.replace(/\s+/g, ' ').trim(), REPLY_MAX) } : {}) });
    }
    if (!messages.length) return { queued: 0 };
    try {
        await prisma.buddyChunk.create({
            data: {
                userId,
                sessionKey: input.sessionKey.slice(0, 80),
                seq: input.seq,
                project: input.project ? input.project.toLowerCase().slice(0, 100) : null,
                office: input.office === true,
                messages: messages as unknown as Prisma.InputJsonValue,
            },
            select: { id: true },
        });
    } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { queued: 0, duplicate: true };
        throw err;
    }
    await bumpDay(userId, today, { seen: messages.length, chunks: 1, secrets });
    return { queued: messages.length };
}
