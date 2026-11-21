// The gate and the digest (BUDDY_MEMORY_PLAN §3.1, §3.3): a queued piece of his chat → which
// messages say something about him (Haiku 5.5, cheap, sees only his words) → notes about him and
// items for his inbox (Sonnet 5.5, low effort, sees the kept messages with their neighbours, his open
// tasks, what agents already saved in that session, and what the buddy already knows, so a repeat
// strengthens a memory instead of making a copy). Code checks every answer; the model never decides
// what is written without it.
import type { BuddyChunk, Memory, MemoryKind, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, type TxClient } from '../../db/prisma';
import { callClaude } from '../claude/client';
import { recordAiUsage } from '../claude/usage.service';
import { parseJson, responseText } from '../recall/output';
import { withRefusalFallbacks, type CreateParams } from '../recall/prompts';
import { addDays, dayOf, isValidDay, type DayString } from '../learning';
import { loadLearningContext, toDbDay } from '../learningDb/common';
import { bumpDay, type ChunkMessage } from './capture.service';
import { MEMORY_KINDS, cleanNoteText, memoryKey } from './memory.service';
import { summariseWork, workLogOn } from './work';
import { DIGEST_LOOP_SCHEMA, DIGEST_LOOP_SYSTEM, applyThreadOps, threadBlocks, zDigestLoop } from './understand';
import { threadIndex, withPersonLock } from './threads';
import { closeTasksFromWords, openTasksForDigest, tasksFromWordsOk, writeTasksFromWords } from './tasks';
import { applyScreenOps } from './screens';
import { freshToday, stampToday } from './liveDay';
import { scrubSecrets } from './scrub';
import { poke } from '../scheduler/scheduler';

export const GATE_MODEL = process.env['BUDDY_GATE_MODEL'] || 'claude-haiku-5-5';
export const DIGEST_MODEL = process.env['BUDDY_DIGEST_MODEL'] || 'claude-sonnet-5-5';
const EPHEMERAL = { type: 'ephemeral' } as const;
/** Notes and items one piece may give (more is noise). */
export const NOTES_PER_CHUNK = 8;
export const ITEMS_PER_CHUNK = 5;
/** Tasks due within two days go straight to Suggested, at most this many a day; the rest wait for the night. */
export const URGENT_ITEMS_PER_DAY = 3;
const ITEM_DAYS = 7;
const MEMORIES_SHOWN = 150;

// ─── The gate ──────────────────────────────────────────────────────────────

export const GATE_LABELS = ['none', 'about_him', 'item'] as const;
/** With his work log on (B9): a fourth label for the work itself. */
export const GATE_LABELS_WORK = ['none', 'about_him', 'item', 'work'] as const;
/** Stage 4, the loop on (ECOSYSTEM_V2_PLAN §10): the gate for anyone, with `update` (and `work` with the work log). */
export const GATE_LABELS_LOOP = ['none', 'personal', 'item', 'update'] as const;
export const GATE_LABELS_LOOP_WORK = ['none', 'personal', 'item', 'update', 'work'] as const;
const ALL_GATE_LABELS = ['none', 'about_him', 'personal', 'item', 'update', 'work'] as const;
export type GateLabel = (typeof ALL_GATE_LABELS)[number];

export const GATE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['labels'],
    properties: {
        labels: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['i', 'label'], properties: { i: { type: 'integer' }, label: { type: 'string', enum: [...GATE_LABELS] } } },
        },
    },
};

export const GATE_SYSTEM = `You sort the messages a software engineer typed to his AI agents (coding, studying, planning), for the memory of his personal assistant. For each numbered message, give one label:
- about_him: it says something about him as a person: a preference or habit, how he likes to work, a feeling, a worry or a stress, a plan, an aim or a value, a decision about his work, study or life, something he is proud of, something he promised.
- item: something for him to keep or do later: a task ("remind me…", "I need to… by Friday"), a thing to note or save, a decision he made with its reason.
- none: everything else: instructions to the agent about the code or the task at hand, questions about a topic, pasted logs, approvals like "yes, do it", small talk.
If a message is both about him and an item, answer item. Most messages are none. Judge only by what he wrote; when unsure, answer none.`;

/**
 * The gate with his work log on (B9, BUDDY_MEMORY_PLAN §11.2): the same labels and a fourth, `work`,
 * for the work itself (what to build, fix or check; a problem; a result). Work never becomes a note
 * about him: it goes to the work log (work.ts).
 */
export const GATE_SYSTEM_WORK = `You sort the messages a software engineer typed to his AI agents (coding, studying, planning), for his personal assistant: its memory of him, and a log of his work. For each numbered message, give one label:
- about_him: it says something about him as a person: a preference or habit, how he likes to work, a feeling, a worry or a stress, a plan, an aim or a value, a decision about his work, study or life, something he is proud of, something he promised.
- item: something he wants kept or brought back to him later, outside the work at hand: a reminder he asks for ("remind me…"), a task of his own with a day, a thing to save, a decision about his own life or study with its reason.
- work: he directs, describes or decides something about the work at hand, saying what it is: what to build, fix, change, test or check; a decision about the work and why; a problem he hit or parked; a result he reports; what comes next in the work.
- none: everything else: approvals like "yes, do it" or "ok", questions about a topic, pasted logs or code, small talk.
If a message is several of these, answer about_him first, then item, then work. A decision or a next step about the work itself is work, not an item. Judge only by what he wrote; when unsure, answer none.`;

export const GATE_SCHEMA_WORK: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['labels'],
    properties: {
        labels: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['i', 'label'], properties: { i: { type: 'integer' }, label: { type: 'string', enum: [...GATE_LABELS_WORK] } } },
        },
    },
};

const gateSchema = (labels: readonly string[]): Record<string, unknown> => ({
    type: 'object',
    additionalProperties: false,
    required: ['labels'],
    properties: {
        labels: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['i', 'label'], properties: { i: { type: 'integer' }, label: { type: 'string', enum: [...labels] } } },
        },
    },
});
export const GATE_SCHEMA_LOOP = gateSchema(GATE_LABELS_LOOP);
export const GATE_SCHEMA_LOOP_WORK = gateSchema(GATE_LABELS_LOOP_WORK);

const GATE_LOOP_LABELS = `- update: news about something on their mind, or an answer to one of the buddy's open questions, however short ("did my run", "yes", "skipped it today", "pushed it to Friday", "we moved the trip"), or a word that one of their open tasks is done ("booked it", "paid the bill"). Use it when the message names or clearly continues something in <on_their_mind> or <open_tasks>, or answers something in <open_questions>.
- personal: it says something about them as a person: a preference or habit, how they like to work, a feeling, a worry or a stress, a plan, an intention, an aim or a value, a decision about their work, study or life, something they are proud of, something they promised.
- item: something they want kept or brought back to them later, outside the work at hand: a reminder they ask for ("remind me…"), a task of their own with a day, a thing to save, a decision about their own life or study with its reason.`;

/**
 * The gate with the loop on (stage 4): written for any person and any kind of chat. It sees what is on
 * their mind (thread titles) and the buddy's open questions, so a short update or answer is kept.
 */
export const GATE_SYSTEM_LOOP = `You sort the messages a person typed to their AI agents (for work, study, planning or anything else), for the memory of their personal buddy. You get what is on their mind (<on_their_mind>: one title per line), their open tasks (<open_tasks>), the buddy's questions waiting for an answer (<open_questions>), then their numbered messages. For each numbered message, give one label:
${GATE_LOOP_LABELS}
- none: everything else: instructions to the agent about the code or the task at hand, questions about a topic, pasted logs or code, approvals of the agent's work ("yes, do it", "ok", "go on") when no question of the buddy is open, small talk.
A message marked (context only, already read) is there to help you read the next one: label it none. If a message is several of these, answer update first, then personal, then item. Judge only by what they wrote; when unsure, answer none, except that a short reply while one of the buddy's questions is open is an update when it can answer it.`;

/** The loop's gate with the work log on (B9): the same labels and `work` for the work itself. */
export const GATE_SYSTEM_LOOP_WORK = `You sort the messages a person typed to their AI agents (for work, study, planning or anything else), for their personal buddy: its memory of them, and a log of their work. You get what is on their mind (<on_their_mind>: one title per line), their open tasks (<open_tasks>), the buddy's questions waiting for an answer (<open_questions>), then their numbered messages. For each numbered message, give one label:
${GATE_LOOP_LABELS}
- work: they direct, describe or decide something about the work at hand, saying what it is: what to build, fix, change, test or check; a decision about the work and why; a problem they hit or parked; a result they report; what comes next in the work.
- none: everything else: approvals like "yes, do it" or "ok" when no question of the buddy is open, questions about a topic, pasted logs or code, small talk.
A message marked (context only, already read) is there to help you read the next one: label it none. If a message is several of these, answer update first, then personal, then item, then work. A decision or a next step about the work itself is work, not an item. Judge only by what they wrote; when unsure, answer none, except that a short reply while one of the buddy's questions is open is an update when it can answer it.`;

/** What the loop's gate is given beside the messages: the thread titles and the open questions (stage 5b: and the open tasks' titles). */
export interface GateLoopContext {
    titles: readonly string[];
    asks: readonly string[];
    tasks?: readonly string[];
}

/** The gate's request; `work`: his work log is on (else the request is exactly the one before B9); `loop`: the loop's gate (stage 4). */
export function gateRequest(messages: readonly ChunkMessage[], opts: { work?: boolean; loop?: GateLoopContext } = {}): CreateParams {
    if (opts.loop) return gateLoopRequest(messages, opts.loop, opts.work === true);
    // A message already read comes along as context only (stage 4): shown, never to be labelled for keeping.
    const numbered = messages.map((m, i) => `[${i + 1}] ${m.context ? '(context only, already read) ' : ''}${m.text.replace(/\s+/g, ' ').slice(0, 1500)}`).join('\n');
    return {
        model: GATE_MODEL,
        // Haiku 5.5 at high effort (the owner, 11-16: the gate decides what of his chats reaches the buddy; it
        // runs on every chunk, so Haiku, thinking hard), with room to think so the labels are never cut off.
        max_tokens: Math.min(12_000, 3000 + 120 * messages.length),
        output_config: { effort: 'high', format: { type: 'json_schema', schema: opts.work ? GATE_SCHEMA_WORK : GATE_SCHEMA } },
        system: [{ type: 'text', text: opts.work ? GATE_SYSTEM_WORK : GATE_SYSTEM, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: [{ type: 'text', text: `<messages>\n${numbered}\n</messages>` }] }],
    } as CreateParams;
}

function gateLoopRequest(messages: readonly ChunkMessage[], loop: GateLoopContext, work: boolean): CreateParams {
    const numbered = messages.map((m, i) => `[${i + 1}] ${m.context ? '(context only, already read) ' : ''}${m.text.replace(/\s+/g, ' ').slice(0, 1500)}`).join('\n');
    const text = [
        `<on_their_mind>\n${loop.titles.slice(0, 200).join('\n') || 'nothing yet'}\n</on_their_mind>`,
        `<open_tasks>\n${(loop.tasks ?? []).slice(0, 30).join('\n') || 'none'}\n</open_tasks>`,
        `<open_questions>\n${loop.asks.join('\n') || 'none'}\n</open_questions>`,
        `<messages>\n${numbered}\n</messages>`,
    ].join('\n\n');
    return {
        model: GATE_MODEL,
        max_tokens: Math.min(12_000, 3000 + 120 * messages.length),
        output_config: { effort: 'high', format: { type: 'json_schema', schema: work ? GATE_SCHEMA_LOOP_WORK : GATE_SCHEMA_LOOP } },
        system: [{ type: 'text', text: work ? GATE_SYSTEM_LOOP_WORK : GATE_SYSTEM_LOOP, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    } as CreateParams;
}

/** What the loop's gate sees of the person: every open thread's title (and those closed lately), the open questions. */
export async function gateLoopContext(userId: string, now: Date): Promise<GateLoopContext> {
    const [index, asks, tasks] = await Promise.all([
        threadIndex(userId, now),
        prisma.buddyAsk.findMany({ where: { userId, state: { in: ['open', 'replied'] }, untilAt: { gt: new Date(now.getTime() - 24 * 3600_000) } }, select: { text: true }, take: 10 }),
        prisma.todo.findMany({ where: { userId, workspaceId: null, status: { not: 'complete' } }, select: { title: true }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    return { titles: index.map((t) => t.title), asks: asks.map((a) => a.text), tasks: tasks.map((t) => t.title) };
}

const zGate = z.object({ labels: z.array(z.object({ i: z.number().int(), label: z.enum(ALL_GATE_LABELS) })) });

function labelled(output: unknown, count: number, want: (label: GateLabel) => boolean): number[] {
    const parsed = zGate.safeParse(output);
    if (!parsed.success) throw new Error('the gate answered in the wrong shape');
    return [...new Set(parsed.data.labels.filter((l) => want(l.label) && l.i >= 1 && l.i <= count).map((l) => l.i - 1))].sort((a, b) => a - b);
}

/** The indexes (0-based) the gate kept for his memory (about him, or an item); a message it didn't label is dropped. */
export function keptIndexes(output: unknown, count: number): number[] {
    return labelled(output, count, (l) => l === 'about_him' || l === 'personal' || l === 'item' || l === 'update');
}

/** The indexes (0-based) the gate marked as work (B9: they send the piece to the work log). */
export function workIndexes(output: unknown, count: number): number[] {
    return labelled(output, count, (l) => l === 'work');
}

// ─── The digest ────────────────────────────────────────────────────────────

const ITEM_KINDS = ['task', 'note', 'decision'] as const;

export const DIGEST_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['notes', 'items'],
    properties: {
        notes: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['text', 'kind', 'private', 'seenMemoryId'],
                properties: { text: { type: 'string' }, kind: { type: 'string', enum: [...MEMORY_KINDS] }, private: { type: 'boolean' }, seenMemoryId: { type: 'string' } },
            },
        },
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'text', 'dueDay', 'why'],
                properties: { kind: { type: 'string', enum: [...ITEM_KINDS] }, text: { type: 'string' }, dueDay: { type: 'string' }, why: { type: 'string' } },
            },
        },
    },
};

export const DIGEST_SYSTEM = `You are the listening part of a personal buddy in Recollect, the app where its user keeps what he learns and plans. He is a software engineer who spends his day with AI agents: coding, studying, brainstorming, and sometimes sharing what weighs on him. You read the messages he typed in one of those chats and write down what is worth remembering about him, and the things he wants kept or done.

You get, in tags:
- <chat>: his messages in order. Lines marked KEEP are the ones to read for notes and items; lines marked context are only there so the KEEP lines make sense. "agent:" is the start of the agent's reply.
- <known>: what the buddy already knows about him, one memory per line with its id.
- <saved>: what an agent in this same chat already saved about him.
- <open_tasks>: his open tasks.
- <today>: his date and weekday, and the project folder of the chat.

Write:
- notes: things about THEM, not about the code or the topic. Each one short and specific, in the third person without he or she ("Studies best after 9 pm", "Worried their DSA is behind for the job search this month"), with its time frame when it has one. kind:
  fact (about his life or work), preference (how he likes things), value (what matters to him), aim (a direction with no date), idea (something he wants to build or try), decision (a choice with its reason), pattern (a habit he shows), state (a mood, a worry, a stress: now, not forever), thread (a promise or a plan he means to follow up), win (something he did and is glad of).
  private: true for health, money, family, other people, guilt, fear, conflicts at work, and anything about leaving his job; else false.
  seenMemoryId: when the note says the same as a line in <known>, that line's id (it then counts as seen again); else "".
- items: only what he clearly wants kept or done later, never what he is asking the agent to do right now in this chat. kind task (with dueDay "YYYY-MM-DD" when he named a day, worked out from <today>; else ""), note (something to save for later), decision (a choice with its reason; put the reason in why). Leave out anything already in <open_tasks> or <saved>. why: one short line, or "".

Rules:
- Only what his words show. Never guess at feelings he didn't express. Nothing is a fine answer: return empty lists.
- When the chat is about his employer's work, keep only what is about him (how he works, what weighed on him, what he decided for himself); never the employer's code, clients, names or figures.
- Never copy a secret, a password, a key or a link with a token in it.
- At most ${NOTES_PER_CHUNK} notes and ${ITEMS_PER_CHUNK} items.`;

export interface DigestInput {
    chat: string;
    known: ReadonlyArray<Pick<Memory, 'id' | 'text' | 'kind'>>;
    saved: readonly string[];
    openTasks: readonly string[];
    today: DayString;
    weekday: string;
    project: string | null;
}

/** The chat block: KEEP lines and one neighbour each side as context. */
export function chatBlock(messages: readonly ChunkMessage[], kept: readonly number[]): string {
    const show = new Set<number>();
    for (const i of kept) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < messages.length) show.add(j);
    const keep = new Set(kept);
    const lines: string[] = [];
    let last = -1;
    for (const i of [...show].sort((a, b) => a - b)) {
        if (last >= 0 && i > last + 1) lines.push('…');
        const m = messages[i]!;
        lines.push(`${keep.has(i) ? 'KEEP' : 'context'}: ${m.text.replace(/\s+/g, ' ')}${m.reply ? `\n  agent: ${m.reply}` : ''}`);
        last = i;
    }
    return lines.join('\n');
}

export function digestRequest(input: DigestInput): CreateParams {
    const text = [
        `<chat>\n${input.chat}\n</chat>`,
        `<known>\n${input.known.map((m) => `${m.id} · ${m.kind} · ${m.text}`).join('\n') || 'nothing yet'}\n</known>`,
        `<saved>\n${input.saved.join('\n') || 'nothing'}\n</saved>`,
        `<open_tasks>\n${input.openTasks.join('\n') || 'none'}\n</open_tasks>`,
        `<today>${input.weekday} ${input.today}${input.project ? ` · project ${input.project}` : ''}</today>`,
    ].join('\n\n');
    return {
        model: DIGEST_MODEL,
        max_tokens: 6000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: DIGEST_SCHEMA } },
        system: [{ type: 'text', text: DIGEST_SYSTEM, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    } as CreateParams;
}

const zDigest = z.object({
    notes: z.array(z.object({ text: z.string(), kind: z.enum(MEMORY_KINDS), private: z.boolean(), seenMemoryId: z.string() })),
    items: z.array(z.object({ kind: z.enum(ITEM_KINDS), text: z.string(), dueDay: z.string(), why: z.string() })),
});
export type DigestOutput = z.infer<typeof zDigest>;

export function parseDigest(output: unknown): DigestOutput {
    const parsed = zDigest.safeParse(output);
    if (!parsed.success) throw new Error('the digest answered in the wrong shape');
    return { notes: parsed.data.notes.slice(0, NOTES_PER_CHUNK), items: parsed.data.items.slice(0, ITEMS_PER_CHUNK) };
}

// ─── Writing what the digest found ─────────────────────────────────────────

const clip = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);
const monthOf = (day: DayString) => day.slice(0, 7);

export interface DigestWrite {
    notes: number;
    seen: number;
    items: number;
}

/** Notes become Observations (a repeat also bumps its memory); items become the buddy's suggestions. */
export async function writeDigest(
    userId: string,
    chunk: Pick<BuddyChunk, 'sessionKey' | 'project'> & Partial<Pick<BuddyChunk, 'source' | 'via' | 'saidFrom'>>,
    out: DigestOutput,
    today: DayString,
    db: TxClient | typeof prisma = prisma,
    /** The loop (stage 3): rows take their times from the `now` they are given (ECOSYSTEM_V2_PLAN §10.1). */
    now?: Date
): Promise<DigestWrite> {
    const result: DigestWrite = { notes: 0, seen: 0, items: 0 };
    for (const n of out.notes) {
        const text = cleanNoteText(n.text);
        if (!text || !memoryKey(text)) continue;
        let memoryId: string | null = null;
        if (n.seenMemoryId) {
            const m = await db.memory.findFirst({ where: { id: n.seenMemoryId, userId, status: { in: ['active', 'faded'] } } });
            if (m) {
                memoryId = m.id;
                await db.memory.update({
                    where: { id: m.id },
                    data: {
                        seenCount: { increment: 1 },
                        lastSeenDay: toDbDay(today),
                        ...(m.monthsSeen.includes(monthOf(today)) ? {} : { monthsSeen: [...m.monthsSeen, monthOf(today)] }),
                        ...(m.status === 'faded' ? { status: 'active' } : {}),
                        ...(!m.byUser && n.private && m.sensitivity === 'open' ? { sensitivity: 'private' } : {}),
                    },
                });
                result.seen++;
            }
        }
        await db.observation.create({
            data: { userId, text, kind: n.kind as MemoryKind, sensitivity: n.private ? 'private' : 'open', source: chunk.source ?? 'hook', sessionKey: chunk.sessionKey, project: chunk.project, day: toDbDay(today), memoryId, saidAt: chunk.saidFrom ?? null, via: chunk.via ?? null, ...(now ? { createdAt: now } : {}) },
        });
        result.notes++;
    }

    const urgentToday = await db.suggestion.count({ where: { userId, proposedBy: 'buddy', status: 'pending', createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
    let urgentLeft = Math.max(0, URGENT_ITEMS_PER_DAY - urgentToday);
    for (const item of out.items) {
        const text = clip(cleanNoteText(item.text), 140);
        if (!text) continue;
        const dup = await db.suggestion.findFirst({ where: { userId, kind: item.kind, status: { in: ['pending', 'candidate'] }, text: { equals: text, mode: 'insensitive' } }, select: { id: true } });
        if (dup) continue;
        const dueDay = item.kind === 'task' && isValidDay(item.dueDay) && item.dueDay >= today ? (item.dueDay as DayString) : null;
        const urgent = !!dueDay && dueDay <= addDays(today, 2) && urgentLeft > 0;
        if (urgent) urgentLeft--;
        const why = clip(cleanNoteText(item.why), 200);
        await db.suggestion.create({
            data: {
                userId,
                kind: item.kind,
                text,
                reason: why || (chunk.project ? `From your chat in ${chunk.project}` : 'From your chats'),
                payload: { title: text, ...(dueDay ? { dueDay } : {}), ...(why ? { why } : {}), ...(chunk.project ? { project: chunk.project } : {}) } as Prisma.InputJsonValue,
                proposedBy: 'buddy',
                status: urgent ? 'pending' : 'candidate',
                expiresDay: toDbDay(addDays(today, ITEM_DAYS)),
            },
        });
        result.items++;
    }
    return result;
}

/**
 * One chunk through the gate (and the digest when the gate keeps anything; the work summary when his
 * work log is on and the gate marked work). Throws on a failed gate or digest call; a failed work
 * summary is logged and skipped (the next piece of that session rewrites its lines anyway).
 */
export async function digestChunk(chunk: BuddyChunk, now: Date = new Date(), opts: { alsoIds?: readonly string[] } = {}): Promise<{ kept: number; work: number } & DigestWrite> {
    const messages = (Array.isArray(chunk.messages) ? chunk.messages : []) as unknown as ChunkMessage[];
    const ctx = await loadLearningContext(chunk.userId, now);
    if (!messages.length) return { kept: 0, notes: 0, seen: 0, items: 0, work: 0 };

    // ECOSYSTEM_V2_PLAN stage 3: with the loop on, the digest also understands what is in motion.
    const loop = (await prisma.buddyState.findUnique({ where: { userId: chunk.userId }, select: { loop: true } }))?.loop === true;
    if (loop) return digestLoop(chunk, messages, ctx, now, opts.alsoIds ?? []);

    const workLog = await workLogOn(chunk.userId);
    const gate = await callClaude(chunk.userId, withRefusalFallbacks(gateRequest(messages, { work: workLog })), 'buddy gate');
    await recordAiUsage(chunk.userId, 'buddy_gate', gate);
    const labels = parseJson(responseText(gate));
    const kept = unread(keptIndexes(labels, messages.length), messages);
    let work = 0;
    if (workLog && workIndexes(labels, messages.length).length) {
        try {
            work = (await summariseWork(chunk, messages, now)).lines;
        } catch (err) {
            console.error(`[buddy] the work summary failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (!kept.length) return { kept: 0, notes: 0, seen: 0, items: 0, work };

    const [known, saved, tasks] = await Promise.all([
        prisma.memory.findMany({ where: { userId: chunk.userId, status: 'active' }, select: { id: true, text: true, kind: true }, orderBy: [{ lastSeenDay: 'desc' }], take: MEMORIES_SHOWN }),
        savedLately(chunk.userId, messages),
        prisma.todo.findMany({ where: { userId: chunk.userId, workspaceId: null, status: { not: 'complete' } }, select: { title: true }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: ctx.tz }).format(now);
    const digest = await callClaude(
        chunk.userId,
        withRefusalFallbacks(
            digestRequest({
                chat: chatBlock(messages, kept),
                known,
                saved: saved.map((s) => s.text),
                openTasks: tasks.map((t) => t.title),
                today: ctx.today,
                weekday,
                project: chunk.project,
            })
        ),
        'buddy digest'
    );
    await recordAiUsage(chunk.userId, 'buddy_digest', digest);
    const written = await writeDigest(chunk.userId, chunk, parseDigest(parseJson(responseText(digest))), ctx.today);
    return { kept: kept.length, work, ...written };
}

// ─── The loop (ECOSYSTEM_V2_PLAN §4.2, stage 3) ─────────────────────────────

/** The two hours a save counts as "already saved" for a piece: before its newest message (§4.9). */
const SAVED_WINDOW_MS = 2 * 3600_000;

/**
 * What any agent or the app saved for this person in the two hours before the piece's newest message (MCP_MEMORY_PLAN
 * §4.9): the digest's "already saved in this chat" hint, by time, since remember never sends the session.
 */
function savedLately(userId: string, messages: readonly ChunkMessage[]) {
    const times = messages.map((m) => Date.parse(m.at)).filter((t) => !Number.isNaN(t));
    const newest = times.length ? Math.max(...times) : Date.now();
    return prisma.observation.findMany({
        where: { userId, source: { in: ['agent', 'app'] }, createdAt: { gte: new Date(newest - SAVED_WINDOW_MS), lte: new Date(newest + 60_000) } },
        select: { text: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
    });
}

/** The loop's digest request text (the digest and the stage 5b sets build it the same way). */
export function digestLoopText(p: {
    chat: string;
    known: ReadonlyArray<{ id: string; kind: string; text: string }>;
    threads: string;
    events: string;
    asks: string;
    saved: readonly string[];
    tasks: ReadonlyArray<{ id: string; title: string; day: string | null }>;
    weekday: string;
    today: string;
    project?: string | null;
    source: string;
}): string {
    return [
        `<chat>\n${p.chat}\n</chat>`,
        `<known>\n${p.known.map((m) => `${m.id} · ${m.kind} · ${m.text}`).join('\n') || 'nothing yet'}\n</known>`,
        `<threads>\n${p.threads}\n</threads>`,
        `<thread_events>\n${p.events}\n</thread_events>`,
        `<open_questions>\n${p.asks}\n</open_questions>`,
        `<saved>\n${p.saved.join('\n') || 'nothing'}\n</saved>`,
        `<open_tasks>\n${p.tasks.map((t) => `${t.id} · ${t.title} · ${t.day ?? 'no day'}`).join('\n') || 'none'}\n</open_tasks>`,
        `<today>${p.weekday} ${p.today}${p.project ? ` · project ${p.project}` : ''} · ${p.source}</today>`,
    ].join('\n\n');
}

/** The loop's digest request (Sonnet 5.5, low effort, structured). */
export function digestLoopRequest(text: string): CreateParams {
    return {
        model: DIGEST_MODEL,
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: DIGEST_LOOP_SCHEMA } },
        system: [{ type: 'text', text: DIGEST_LOOP_SYSTEM, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    } as CreateParams;
}

/** What the piece is, for the digest's <today> line. */
export function sourceLine(chunk: Pick<BuddyChunk, 'via' | 'noteId'>): string {
    // MCP_MEMORY_PLAN §4.7: details they saved while the buddy could not read them, newest version only, oldest first.
    if (chunk.via === 'catchup') return 'details they saved while the buddy could not read them (a catch-up: each line has its own day; an ended one says so; it builds history with those dates, never a question)';
    if (chunk.noteId && chunk.via === 'agent') return 'notes an AI agent saved about them (each line said by them unless marked otherwise; their own later words win)';
    if (chunk.noteId) return 'their own words to the buddy ("Tell")';
    if (chunk.via === 'ask_ai' || chunk.via === 'answer') return 'their chat with the buddy';
    if (chunk.via === 'doc_ask') return 'their questions inside a document';
    // A note they jotted in the app's pocket (the simulation's issue 9): their own words, often an idea or a plan.
    if (chunk.via === 'pocket') return 'a note they jotted in their pocket of quick notes (their own words, often an idea or a plan; a snippet, command or quote kept for later says nothing about them)';
    // Stage 8: an export they brought in: their words from before, history only.
    if (chunk.via === 'import') return 'an old chat of theirs with another AI, brought in from an export (old news: it builds history, never a question)';
    return 'a chat with an AI agent';
}

/** The kept messages less those already read (a context message is never read twice: §4.11 rule 2). */
export const unread = (kept: readonly number[], messages: readonly ChunkMessage[]): number[] => kept.filter((i) => !messages[i]?.context);

/**
 * The chat block with numbers (the loop's operations name the message they rest on). Given the day, a message
 * said on an earlier day says so ("(said Sat 21 Nov, 2026-11-21)"): words held while the AI was paused, or a
 * session read late, keep their own "today" (J9 on the real models, 11-18: both held updates landed on the day
 * they arrived).
 */
export function numberedChat(messages: readonly ChunkMessage[], kept: readonly number[], when?: { today: DayString; tz: string }): string {
    const keep = new Set(kept);
    const lines: string[] = [];
    messages.forEach((m, i) => {
        if (m.before) lines.push(`buddy: ${m.before.replace(/\s+/g, ' ')}`);
        lines.push(`[${i + 1}] ${keep.has(i) ? 'KEEP' : 'context'}${when ? saidOn(m.at, when) : ''}: ${m.text.replace(/\s+/g, ' ')}`);
        if (m.reply) lines.push(`  agent: ${m.reply}`);
    });
    return lines.join('\n');
}

/** " (said Sat 21 Nov, 2026-11-21)" for a message said on an earlier calendar day than today, else nothing. */
function saidOn(at: string, when: { today: DayString; tz: string }): string {
    const t = Date.parse(at);
    if (Number.isNaN(t)) return '';
    const day = dayOf(new Date(t), when.tz);
    if (day >= when.today) return '';
    return ` (said ${new Intl.DateTimeFormat('en-GB', { timeZone: when.tz, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(t))}, ${day})`;
}

/**
 * One piece with the loop on: his own words from the app skip the gate (every message is read with its
 * context); other sources keep it. The digest writes notes, items and thread operations; code applies
 * them, and deletes the piece, in one transaction under the person's lock, so a piece read twice
 * writes nothing twice (§4.11).
 */
async function digestLoop(chunk: BuddyChunk, messages: readonly ChunkMessage[], ctx: Awaited<ReturnType<typeof loadLearningContext>>, now: Date, alsoIds: readonly string[] = []): Promise<{ kept: number; work: number } & DigestWrite> {
    // His own words in the app (the chat, his answers, his pocket notes), and saved notes (already curated), skip
    // the gate (stage 3, stage 4).
    const own = chunk.via === 'ask_ai' || chunk.via === 'answer' || chunk.via === 'pocket' || !!chunk.noteId;
    let kept: number[];
    let work = 0;
    if (own) kept = unread(messages.map((_, i) => i), messages);
    else {
        const workLog = await workLogOn(chunk.userId);
        // Stage 4: the gate for anyone, given what is on their mind and the open questions.
        const gate = await callClaude(chunk.userId, withRefusalFallbacks(gateRequest(messages, { work: workLog, loop: await gateLoopContext(chunk.userId, now) })), 'buddy gate');
        await recordAiUsage(chunk.userId, 'buddy_gate', gate);
        const labels = parseJson(responseText(gate));
        kept = unread(keptIndexes(labels, messages.length), messages);
        if (workLog && workIndexes(labels, messages.length).length) {
            try {
                work = (await summariseWork(chunk, messages, now)).lines;
            } catch (err) {
                console.error(`[buddy] the work summary failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    if (!kept.length) return { kept: 0, notes: 0, seen: 0, items: 0, work };

    const chat = numberedChat(messages, kept, { today: ctx.today, tz: ctx.tz });
    // Saved details (MCP_MEMORY_PLAN §4.5) are read with the threads and the open questions only: no notes or items are
    // written for them, so the memories and the tasks are not read. Stage 5b: "Tell" (his own words, saved as a note)
    // still makes his to-dos tasks and ticks his tasks done, so it is shown his open tasks.
    const savedDetails = !!chunk.noteId;
    const tellPiece = savedDetails && chunk.via === 'tell';
    const [known, saved, tasks, blocks] = await Promise.all([
        savedDetails ? Promise.resolve([]) : prisma.memory.findMany({ where: { userId: chunk.userId, status: 'active' }, select: { id: true, text: true, kind: true }, orderBy: [{ lastSeenDay: 'desc' }], take: MEMORIES_SHOWN }),
        savedDetails ? Promise.resolve([]) : savedLately(chunk.userId, messages),
        savedDetails && !tellPiece ? Promise.resolve([]) : openTasksForDigest(chunk.userId, ctx.tz),
        threadBlocks(chunk.userId, chat, now),
    ]);
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: ctx.tz }).format(now);
    const text = digestLoopText({ chat, known, ...blocks, saved: saved.map((s) => s.text), tasks, weekday, today: ctx.today, project: chunk.project, source: sourceLine(chunk) });
    const digest = await callClaude(chunk.userId, withRefusalFallbacks(digestLoopRequest(text)), 'buddy digest');
    await recordAiUsage(chunk.userId, 'buddy_digest', digest);
    const parsed = zDigestLoop.safeParse(parseJson(responseText(digest)));
    if (!parsed.success) throw new Error('the digest answered in the wrong shape');
    const out = parsed.data;

    // Stage 5b: a message the digest may act on (read now, not context), and whether this source's to-dos may become tasks.
    const readable = (n: number) => !!messages[n - 1] && !messages[n - 1]!.context && kept.includes(n - 1);
    const ownWords = tasksFromWordsOk(chunk);
    const result = await withPersonLock(chunk.userId, async (tx) => {
        const applied = await applyThreadOps(tx, chunk.userId, chunk, messages, out.threads, { now, tz: ctx.tz, today: ctx.today });
        // Never both an item and a thread for the same words (§4.2): code drops the item. Stage 5b: a task beside an event
        // on the same message is kept ("the wedding is on the 5th and I still need a gift").
        const items = out.items.filter((i) => !applied.threadMessages.has(i.message) || (i.kind === 'task' && applied.eventOnly.has(i.message)));
        // Stage 5b (A): their own to-dos with a day are tasks at once, with an early reminder; the rest stay suggestions.
        const asTasks = ownWords ? items.filter((i) => i.kind === 'task' && readable(i.message) && isValidDay(i.dueDay) && i.dueDay >= ctx.today) : [];
        const tasksMade = asTasks.length ? await writeTasksFromWords(tx, chunk.userId, asTasks, { now, tz: ctx.tz, today: ctx.today }) : { made: 0, reminders: 0, dropped: [] };
        const closed = ownWords ? await closeTasksFromWords(tx, chunk.userId, out.tasksDone.filter((d) => readable(d.message)), new Set(tasks.map((t) => t.id)), { now }) : { closed: 0, dropped: [] };
        // Stage 5b (B): their wishes about when it may ask and what stays off their screens.
        const screens = out.screens.length ? await applyScreenOps(tx, chunk.userId, out.screens, { now, tz: ctx.tz, direct: chunk.source !== 'agent' && ownWords, context: new Set(messages.flatMap((m, i) => (m.context ? [i + 1] : []))), messages: messages.length }) : null;
        const rest = items.filter((i) => !asTasks.includes(i)).map(({ message: _m, deadline: _d, time: _t, ...r }) => r);
        // Saved notes are stored already: only what they mean for the threads is written.
        const written = chunk.noteId
            ? { notes: 0, seen: 0, items: 0 }
            : await writeDigest(chunk.userId, { ...chunk, saidFrom: chunk.saidFrom ?? (messages[0] ? new Date(messages[0].at) : null) }, { notes: out.notes, items: rest }, ctx.today, tx, now);
        if (tasksMade.dropped.length || closed.dropped.length || screens?.dropped.length) console.log(`[buddy] 5b dropped: ${[...tasksMade.dropped, ...closed.dropped, ...(screens?.dropped ?? [])].map((d) => `${d.what} (${d.why})`).join('; ')}`);
        // The piece (and the pieces of its session read with it) go in the same transaction.
        await tx.buddyChunk.deleteMany({ where: { id: { in: [chunk.id, ...alsoIds] } } });
        return { kept: kept.length, work, ...written, tasks: tasksMade.made, reminders: tasksMade.reminders, tasksDone: closed.closed, screenRules: screens?.made ?? 0 };
    });
    if (result.reminders || result.tasksDone) poke('reminders');
    // Stage 18: their own fresh words that change what is fit to say today: a pulse follows within minutes (pulseDue).
    const todays = out.today && ownWords ? kept.filter((i) => !!messages[i] && !messages[i]!.context && freshToday(new Date(messages[i]!.at), now, ctx.tz, ctx.today)) : [];
    if (todays.length) await stampToday(chunk.userId, ctx.today, now, todays.map((i) => scrubSecrets(messages[i]!.text)).join(' / '));
    return result;
}
