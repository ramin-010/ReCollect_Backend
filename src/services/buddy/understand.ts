// Understanding at once (ECOSYSTEM_V2_PLAN §4.2, stage 3): with the loop on, the digest also says what a
// message means for what is in motion in the person's life: a new thread, or an event on one (an
// update, an answer to one of the buddy's questions, a change of plan). The model proposes; code
// checks every id, day and limit, and applies the operations under the person's lock with the rules of
// ./threads.ts. Written for any person: no profession, no routine, no pronoun built in.
import type { BuddyChunk } from '@prisma/client';
import { z } from 'zod';
import { prisma, type TxClient } from '../../db/prisma';
import { addDays, isValidDay, type DayString } from '../learning';
import { toDbDay } from '../learningDb/common';
import { EVENT_KINDS, addThreadEvent, dayFor, openOrFindThread, threadIndex, type EventKind } from './threads';
import type { ChunkMessage } from './capture.service';
import { MEMORY_KINDS } from './memory.service';
import { minuteOf } from './tasks';

/** Threads whose last events the digest also sees (every open title is always in view: §4.12). */
export const DETAIL_THREADS = 40;
const EVENTS_PER_THREAD = 3;
/** A day named in his words may reach this far back; never into the future beyond tomorrow. */
const DAYS_BACK = 60;

export const THREAD_OPS = ['open', 'event'] as const;
/** Stage 5: how they want a thread treated, said in a chat (§4.9): ask less, don't ask, keep it off their screens, ask again. */
export const STEERS = ['', 'less', 'none', 'off_screens', 'again'] as const;
const str = { type: 'string' } as const;

/** Stage 5b, part B: the screen rules their words can make (asks_from: questions not before a time; asks_days: only on some days; topic: kept off their lock screen). */
export const SCREEN_KINDS = ['asks_from', 'asks_days', 'topic'] as const;
export const SCREEN_DAYS = ['', 'weekdays', 'weekends'] as const;

/** The digest's answer with the loop on: today's notes and items (each with the message it rests on), thread operations, and (stage 5b) tasks their words close and screen rules. */
export const DIGEST_LOOP_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['notes', 'items', 'tasksDone', 'threads', 'screens', 'today'],
    properties: {
        notes: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['text', 'kind', 'private', 'seenMemoryId'],
                properties: { text: str, kind: { type: 'string', enum: [...MEMORY_KINDS] }, private: { type: 'boolean' }, seenMemoryId: str },
            },
        },
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'text', 'dueDay', 'deadline', 'time', 'why', 'message'],
                properties: { kind: { type: 'string', enum: ['task', 'note', 'decision'] }, text: str, dueDay: str, deadline: { type: 'boolean' }, time: str, why: str, message: { type: 'integer' } },
            },
        },
        tasksDone: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['taskId', 'message'], properties: { taskId: str, message: { type: 'integer' } } },
        },
        threads: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['op', 'threadId', 'title', 'keywords', 'kind', 'text', 'day', 'message', 'askId', 'sensitive', 'lookAgainOn', 'rhythm', 'steer', 'event', 'time'],
                properties: {
                    op: { type: 'string', enum: [...THREAD_OPS] },
                    threadId: str,
                    title: str,
                    keywords: { type: 'array', items: str },
                    kind: { type: 'string', enum: [...EVENT_KINDS] },
                    text: str,
                    day: str,
                    message: { type: 'integer' },
                    askId: str,
                    sensitive: { type: 'boolean' },
                    lookAgainOn: str,
                    rhythm: { type: 'string', enum: ['none', 'daily', 'weekly'] },
                    steer: { type: 'string', enum: [...STEERS] },
                    event: { type: 'boolean' },
                    time: str,
                },
            },
        },
        screens: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'threadId', 'time', 'days', 'words', 'askId', 'message'],
                properties: { kind: { type: 'string', enum: [...SCREEN_KINDS] }, threadId: str, time: str, days: { type: 'string', enum: [...SCREEN_DAYS] }, words: str, askId: str, message: { type: 'integer' } },
            },
        },
        /** Stage 18: these words change what is fit to say to them later today (a plan for tonight, how today is going). */
        today: { type: 'boolean' },
    },
};

export const DIGEST_LOOP_SYSTEM = `You are the listening part of a personal buddy inside Recollect, an app where a person keeps what they learn, their goals and their plans. You read the messages the person wrote (to their AI agents, or to the buddy itself) and write down what is worth remembering about them, what they want kept or done, and what it means for the things going on in their life.

You get, in tags:
- <chat>: their messages in order, numbered. Lines marked KEEP are the ones to read; lines marked context only help the KEEP lines make sense. "buddy:" is what the buddy said just before; "agent:" is the start of an agent's reply.
- <known>: what the buddy already knows about them, one memory per line with its id.
- <threads>: what is going on in their life that the buddy keeps an eye on: id · stage · title. <thread_events>: the last updates of some of them. <open_questions>: questions the buddy asked that wait for an answer: id · thread id · question.
- <open_tasks>: their open tasks: id · title · its day (or "no day"). <saved>, <today>: as named.

Write:
- notes: things about the person, short and in the third person, without he or she unless their own words show it ("they", or no pronoun) (kind, private, seenMemoryId).
- items: only what they clearly want kept or done (a task, a note to keep, a decision with its reason), never what they ask an agent to do right now. message: the number of the message it rests on. deadline false and time "" for a note or a decision.
  - A task is something they have to do themselves (book, call, pay, send, buy, renew, submit, finish, deliver, sort out) on or by a day they name: kind task; text: the to-do in a few words ("Book the dentist"); dueDay: that day as YYYY-MM-DD, worked out from <today>; deadline: true when it must be done by that day ("by Friday", "before the 5th", "due on the 27th"), false when they mean to do it on that day ("on Monday", "tomorrow"); time: "HH:mm" when their words give a time for it, else "". Never a task without a day of its own, and never one already in <open_tasks>.
- tasksDone: an open task from <open_tasks>, by its id, that their own words say is done ("booked it", "paid the bill", "sent the form off"). message: the number of the message.
- threads: what their words mean for what is in motion.
  - op "event": the message is about a thread in <threads> (match by meaning, not only by words; a closed one too). kind: said (they talked about it), progress (they did some of it), done (they did it, for that day), skipped (they say they did not, in their own words), finished (the whole thing is complete), changed (a change of plan or of timing), paused, resumed, dropped (they let it go), answered (an answer to an open question), steer (they tell you how to treat it: "stop asking about my diet", "ask me less about the gym", "keep that off my lock screen", "you can ask about it again"; then steer: none, less, off_screens or again, else ""). askId: the open question it answers, only when it clearly answers it; else "". title: "", except for a change of plan that makes the thread's title wrong: then the title as it is now ("Run three mornings a week" → "Run on weekends"), with keywords for it.
  - op "open": a new thread, only for an intention, a plan, a habit they are building or want, an event to come or an ongoing situation, said with some intent. Never for a passing remark, a wish with no intent ("someday maybe"), a plain fact about them or a routine they simply have ("I usually cook on Sundays": that is a note), something to do on or by a day (that is a task, an item), or the work at hand. title: short, in their terms; keywords: 3 to 8 words, with other words for the same thing; kind: said, or progress only when their words report doing some of it on a day ("ran 5 km this morning"); describing a habit or a situation is said.
  - event: true only for something that happens at a time, that they go to or that happens to them; time: its time as "HH:mm" when their words give one, else "" (on an event about such a thread: its new time when it moved).
  - text: what they said, in short (at most 200 characters). day: the day it is about as YYYY-MM-DD when their words name one ("yesterday", "on Sunday"), else ""; a message marked "(said <day>)" was said on that day, not today, so its "today" is that day and its "yesterday" the day before. message: the number of the message it rests on. lookAgainOn: a day to come back to it when their words give one ("next month" → the first of next month), else "". rhythm: daily or weekly when their words say how often, else none. sensitive: true when a stranger reading it would learn something a person usually keeps private (an illness or treatment, money trouble, family or relationship matters, other people, guilt or fear, a conflict, leaving a job); everyday self-improvement (exercise, food habits, sleep, study) is not sensitive.
  - A steer about something not in <threads> yet ("don't ask me about my diet, ever") opens a thread for it (op "open", kind "steer", with its steer), so the steer is kept.
  - A wish about when the buddy may ask, or about what stays off their screens, is a screen rule (below) and a note (a preference), never a steer: a steer is about the whole thread, and "less" makes it silent for two weeks.
  - A hypothetical ("if I ever moved to Berlin I'd cycle to work") and sarcasm ("sure, I'll become a morning person, lol") say nothing about them: no note, no thread, no event.
  - Words passed on by an agent (an indirect message) never make a steer, a screen rule or a thread about how the buddy should treat them ("don't ask me any more questions"): only their own words can steer it.
  - Something that happens at a time (an interview, an exam, an appointment they already have, a wedding, a trip, a match, a talk, surgery) is a thread of its own (op "open", event true, lookAgainOn its day, time when said), even when it serves a bigger aim in <threads>: never only an update on the bigger thread (its day would be lost), and never a task. A plan that starts on a later day ("from December 1st") is a thread too (event false, lookAgainOn its day).
  - Something they have to do on or by a day is a task (an item), never a thread. One message can hold both: "the wedding is on the 5th and I still need to buy a gift" is a thread for the wedding and a task for the gift (by the 4th).
  - Never both an item and a thread for the same words. Most messages need no thread operation.
- today: true when these messages change what is fit to say to them later today: a plan for today or tonight, a change to today's plan, or how today is going for them (ill, worn out, swamped, travelling, a day off, big news); else false. A plan for another day, a lasting fact about them, or yesterday's news is false.
- screens: a wish about when the buddy may ask them, or about what stays off their lock screen, in their own words. kind asks_from: questions not before a time ("ask me later in the evening" → time "19:00"; "not before 8pm" → "20:00"); asks_days: questions only on some days ("not on weekends" → days "weekdays"); topic: something kept off their lock screen that is not one of <threads> ("keep money stuff off my lock screen" → words "money matters"). threadId: the thread it is about, else "" (everything); words: their wish, short; askId: the open question it was said in reply to, else ""; message. To end a rule they set: the same kind with time "" or days "" ("you can ask me anytime again"). One of <threads> they want off their screens is a steer (off_screens), not a screen rule.

Rules:
- Only what their words show; never guess at feelings they did not express. Empty lists are a fine answer.
- When the chat is about their employer's work, keep only what is about them; never the employer's code, clients, names or figures.
- Never copy a secret, a password, a key or a link with a token in it.
- At most 8 notes, 5 items, 5 tasks done, 6 thread operations and 3 screen rules.`;

const zLoopOp = z.object({
    op: z.enum(THREAD_OPS),
    threadId: z.string(),
    title: z.string(),
    keywords: z.array(z.string()),
    kind: z.enum(EVENT_KINDS),
    text: z.string(),
    day: z.string(),
    message: z.number().int(),
    askId: z.string(),
    sensitive: z.boolean(),
    lookAgainOn: z.string(),
    rhythm: z.enum(['none', 'daily', 'weekly']),
    steer: z.enum(STEERS).default(''),
    // Stage 5b (an answer without them: false and "").
    event: z.boolean().default(false),
    time: z.string().default(''),
});
export type ThreadOp = z.input<typeof zLoopOp>;
const zScreen = z.object({ kind: z.enum(SCREEN_KINDS), threadId: z.string(), time: z.string(), days: z.enum(SCREEN_DAYS).default(''), words: z.string(), askId: z.string().default(''), message: z.number().int() });
export type ScreenOp = z.infer<typeof zScreen>;
export const zDigestLoop = z.object({
    notes: z.array(z.object({ text: z.string(), kind: z.enum(MEMORY_KINDS), private: z.boolean(), seenMemoryId: z.string() })),
    items: z.array(z.object({ kind: z.enum(['task', 'note', 'decision']), text: z.string(), dueDay: z.string(), deadline: z.boolean().default(false), time: z.string().default(''), why: z.string(), message: z.number().int() })),
    tasksDone: z.array(z.object({ taskId: z.string(), message: z.number().int() })).default([]),
    threads: z.array(zLoopOp),
    screens: z.array(zScreen).default([]),
    // Stage 18 (an answer without it: false).
    today: z.boolean().default(false),
});
export type DigestLoopOutput = z.infer<typeof zDigestLoop>;

/** What the digest sees of the person's threads and the buddy's open questions (§4.12). */
export async function threadBlocks(userId: string, chatText: string, now: Date): Promise<{ threads: string; events: string; asks: string }> {
    const index = await threadIndex(userId, now);
    if (!index.length) return { threads: 'none yet', events: 'none', asks: 'none' };
    const asks = await prisma.buddyAsk.findMany({ where: { userId, state: { in: ['open', 'replied'] }, untilAt: { gt: new Date(now.getTime() - 48 * 3600_000) } }, orderBy: { fromAt: 'desc' }, take: 10 });
    // Which threads also show their last events: an open question, the words of this piece, then the newest.
    const said = new Set(chatText.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
    const score = (t: (typeof index)[number]) =>
        (asks.some((a) => a.threadId === t.id) ? 100 : 0) + [...t.title.toLowerCase().split(/[^\p{L}\p{N}]+/u), ...t.keywords].filter((w) => w.length > 2 && said.has(w)).length * 10 + (t.stage === 'noticed' ? 0 : 1);
    const detail = [...index].sort((a, b) => score(b) - score(a) || b.lastSaidAt.getTime() - a.lastSaidAt.getTime()).slice(0, DETAIL_THREADS);
    const events = await prisma.buddyThreadEvent.findMany({ where: { userId, threadId: { in: detail.map((t) => t.id) }, duplicate: false }, orderBy: { saidAt: 'desc' }, take: DETAIL_THREADS * EVENTS_PER_THREAD });
    const lines: string[] = [];
    for (const t of detail) {
        const own = events.filter((e) => e.threadId === t.id).slice(0, EVENTS_PER_THREAD);
        for (const e of own.reverse()) lines.push(`${t.id} · ${e.forDay.toISOString().slice(0, 10)} · ${e.kind} · ${e.text}`);
    }
    return {
        threads: index.map((t) => `${t.id} · ${t.stage} · ${t.title}`).join('\n'),
        events: lines.join('\n') || 'none',
        asks: asks.map((a) => `${a.id} · ${a.threadId ?? '-'} · ${a.text}`).join('\n') || 'none',
    };
}

const clipTitle = (title: string) => {
    const t = title.replace(/\s+/g, ' ').trim();
    return t.length > 120 ? `${t.slice(0, 119)}…` : t;
};

export interface ApplyResult {
    opened: number;
    events: number;
    answered: number;
    /** Threads whose title a change of plan made wrong, renamed. */
    renamed: number;
    /** Steers from his own words, applied (stage 5). */
    steered: number;
    dropped: Array<{ what: string; why: string }>;
    /** Messages a thread operation rests on: an item on the same message is dropped (never both). */
    threadMessages: Set<number>;
    /** Stage 5b: messages whose thread operations are all about events (a task beside an event is kept: the wedding and the gift). */
    eventOnly: Set<number>;
}

/**
 * Applies the digest's thread operations inside the person's lock (§4.11, §4.12): every id is the
 * person's own; a day is valid and near; each event takes the time its message was said; the origin key
 * (the piece, the message, the operation) makes a retried piece write nothing twice.
 */
export async function applyThreadOps(
    tx: TxClient,
    userId: string,
    chunk: Pick<BuddyChunk, 'sessionKey' | 'seq' | 'via' | 'source'>,
    messages: readonly ChunkMessage[],
    ops: readonly ThreadOp[],
    ctx: { now: Date; tz: string; today: DayString }
): Promise<ApplyResult> {
    const result: ApplyResult = { opened: 0, events: 0, answered: 0, renamed: 0, steered: 0, dropped: [], threadMessages: new Set(), eventOnly: new Set() };
    const notEvent = new Set<number>();
    const via = chunk.via ?? (chunk.source === 'hook' ? 'hook' : String(chunk.source));
    // His own words (the hooks, his chat with the buddy, his answers) are direct; an agent's note is not (stage 4).
    const direct = chunk.source !== 'agent';
    for (const [i, op] of ops.slice(0, 6).entries()) {
        const m = messages[op.message - 1];
        const text = op.text.replace(/\s+/g, ' ').trim();
        let why: string | null = null;
        if (!m) why = 'no such message';
        else if (m.context) why = 'already read (context only)';
        else if (!text) why = 'no words';
        if (why || !m) {
            result.dropped.push({ what: `thread ${op.op}`, why: why ?? 'no such message' });
            continue;
        }
        const saidAt = new Date(m.at);
        // MCP_MEMORY_PLAN §4.4: a saved detail's level travels with it (a said one weighs as their own word).
        const basis = m.basis === 'said' || m.basis === 'inferred' ? m.basis : null;
        const theirs = direct || basis === 'said';
        const ownDay = dayFor(saidAt, ctx.tz);
        const forDay = isValidDay(op.day) && op.day <= addDays(ctx.today, 1) && op.day >= addDays(ctx.today, -DAYS_BACK) ? (op.day as DayString) : ownDay;
        const lookAgainOn = isValidDay(op.lookAgainOn) && op.lookAgainOn > ctx.today ? (op.lookAgainOn as DayString) : null;
        const originKey = `${chunk.sessionKey}:${chunk.seq}:${op.message}:${i}`;
        let thread = op.op === 'event' && op.threadId ? await tx.buddyThread.findFirst({ where: { id: op.threadId, userId } }) : null;
        if (op.op === 'event' && !thread) {
            result.dropped.push({ what: 'thread event', why: 'not one of their threads' });
            continue;
        }
        if (!thread) {
            const title = op.title.replace(/\s+/g, ' ').trim();
            if (!title) {
                result.dropped.push({ what: 'thread open', why: 'no title' });
                continue;
            }
            // Stage 5b: an event has its day (lookAgainOn) and its time when said; a plan or a habit is not one.
            const isEvent = op.event === true && !!lookAgainOn && op.rhythm === 'none';
            const made = await openOrFindThread(tx, userId, { title, keywords: op.keywords, sensitive: op.sensitive, lookAgainOn, rhythm: op.rhythm, event: isEvent, eventMinute: isEvent ? minuteOf(op.time) : null }, { saidAt, forDay }, ctx.now);
            thread = made.thread;
            if (!made.found) result.opened++;
            else if (isEvent && !thread.event && via !== 'import') thread = await tx.buddyThread.update({ where: { id: thread.id }, data: { event: true, eventMinute: minuteOf(op.time) } });
        } else if (via !== 'import' && (lookAgainOn || op.rhythm !== 'none' || (thread.event && minuteOf(op.time) != null))) {
            // (An import's old plan never changes a thread he has now.) An event that moved takes its new day and time.
            await tx.buddyThread.update({
                where: { id: thread.id },
                data: { ...(lookAgainOn ? { lookAgainOn: toDbDay(lookAgainOn) } : {}), ...(op.rhythm !== 'none' ? { rhythm: op.rhythm } : {}), ...(thread.event && minuteOf(op.time) != null ? { eventMinute: minuteOf(op.time) } : {}) },
                select: { id: true },
            });
        }
        if (thread.event) result.eventOnly.add(op.message);
        else notEvent.add(op.message);
        // An import's private words never join, or make private, a thread that is not private already: in the week's
        // simulation (11-18) one old worry from a September chat made his running habit private for good (nothing of
        // it could show on his screens again). They stay a private note, for the night's memory.
        if (via === 'import' && op.sensitive && !thread.sensitive) {
            result.dropped.push({ what: 'thread event', why: "an old chat's private words stay a note" });
            continue;
        }
        if (op.sensitive && !thread.sensitive) await tx.buddyThread.update({ where: { id: thread.id }, data: { sensitive: true }, select: { id: true } });
        // The question it answers: one of theirs, still waiting.
        const ask = op.askId ? await tx.buddyAsk.findFirst({ where: { id: op.askId, userId, state: { in: ['open', 'replied'] } } }) : null;
        const newest = saidAt.getTime() >= thread.lastSaidAt.getTime();
        // A steer from his own words (never one passed on): applied by code, kept with the thread (§4.9).
        // (Steers stay their own words only, in this plan: MCP_MEMORY_PLAN §9.)
        if (op.kind === 'steer' && op.steer && direct) {
            await tx.buddyThread.update({
                where: { id: thread.id },
                data: {
                    steer: text.slice(0, 200),
                    ...(op.steer === 'less' ? { quietUntil: new Date(ctx.now.getTime() + 14 * 86_400_000) } : {}),
                    ...(op.steer === 'none' ? { noAsk: true } : {}),
                    ...(op.steer === 'off_screens' ? { onScreens: false } : {}),
                    ...(op.steer === 'again' ? { noAsk: false, quietUntil: null } : {}),
                },
                select: { id: true },
            });
            result.steered++;
        }
        // Stage 8: an import's words are old news whatever their age (history only: no stage, question or pulse).
        const outcome = await addThreadEvent(tx, userId, thread, { kind: op.kind as EventKind, text, saidAt, forDay, direct, via, originKey, askId: ask?.id ?? null, imported: via === 'import', replay: via === 'catchup', basis }, ctx.now);
        if (outcome === 'repeat') continue;
        result.events++;
        result.threadMessages.add(op.message);
        // A change of plan that makes the title wrong renames the thread ("most evenings" → "weekend
        // mornings"): only his newest word, never a late older one, and never a passed-on one.
        const renamed = op.op === 'event' && op.kind === 'changed' && outcome === 'added' && newest && theirs ? clipTitle(op.title) : '';
        if (renamed && renamed !== thread.title) {
            const keywords = [...new Set([...op.keywords.map((k) => k.toLowerCase().trim()).filter(Boolean), ...thread.keywords])].slice(0, 8);
            await tx.buddyThread.update({ where: { id: thread.id }, data: { title: renamed, keywords }, select: { id: true } });
            result.renamed++;
        }
        if (ask) {
            await tx.buddyAsk.update({ where: { id: ask.id }, data: { state: 'answered', answeredAt: ctx.now, answer: text.slice(0, 300) }, select: { id: true } });
            result.answered++;
        }
    }
    for (const m of notEvent) result.eventOnly.delete(m);
    return result;
}
