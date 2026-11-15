// The gate and the digest (BUDDY_MEMORY_PLAN §3.1, §3.3): a queued piece of his chat → which
// messages say something about him (Haiku 5.5, cheap, sees only his words) → notes about him and
// items for his inbox (Sonnet 5.5, low effort, sees the kept messages with their neighbours, his open
// tasks, what agents already saved in that session, and what the buddy already knows, so a repeat
// strengthens a memory instead of making a copy). Code checks every answer; the model never decides
// what is written without it.
import type { BuddyChunk, Memory, MemoryKind, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { callClaude } from '../claude/client';
import { recordAiUsage } from '../claude/usage.service';
import { parseJson, responseText } from '../recall/output';
import { withRefusalFallbacks, type CreateParams } from '../recall/prompts';
import { addDays, isValidDay, type DayString } from '../learning';
import { loadLearningContext, toDbDay } from '../learningDb/common';
import { bumpDay, type ChunkMessage } from './capture.service';
import { MEMORY_KINDS, cleanNoteText, memoryKey } from './memory.service';

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
export type GateLabel = (typeof GATE_LABELS)[number];

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

export function gateRequest(messages: readonly ChunkMessage[]): CreateParams {
    const numbered = messages.map((m, i) => `[${i + 1}] ${m.text.replace(/\s+/g, ' ').slice(0, 1500)}`).join('\n');
    return {
        model: GATE_MODEL,
        max_tokens: 200 + 24 * messages.length,
        output_config: { format: { type: 'json_schema', schema: GATE_SCHEMA } },
        system: [{ type: 'text', text: GATE_SYSTEM, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: [{ type: 'text', text: `<messages>\n${numbered}\n</messages>` }] }],
    } as CreateParams;
}

const zGate = z.object({ labels: z.array(z.object({ i: z.number().int(), label: z.enum(GATE_LABELS) })) });

/** The indexes (0-based) the gate kept; a message it didn't label is dropped. */
export function keptIndexes(output: unknown, count: number): number[] {
    const parsed = zGate.safeParse(output);
    if (!parsed.success) throw new Error('the gate answered in the wrong shape');
    return [...new Set(parsed.data.labels.filter((l) => l.label !== 'none' && l.i >= 1 && l.i <= count).map((l) => l.i - 1))].sort((a, b) => a - b);
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

export const DIGEST_SYSTEM = `You are the listening part of Ramin's personal buddy in Recollect, the app where he keeps what he learns and plans. He is a software engineer who spends his day with AI agents: coding, studying, brainstorming, and sometimes sharing what weighs on him. You read the messages he typed in one of those chats and write down what is worth remembering about him, and the things he wants kept or done.

You get, in tags:
- <chat>: his messages in order. Lines marked KEEP are the ones to read for notes and items; lines marked context are only there so the KEEP lines make sense. "agent:" is the start of the agent's reply.
- <known>: what the buddy already knows about him, one memory per line with its id.
- <saved>: what an agent in this same chat already saved about him.
- <open_tasks>: his open tasks.
- <today>: his date and weekday, and the project folder of the chat.

Write:
- notes: things about HIM, not about the code or the topic. Each one short and specific, in the third person ("Studies best after 9 pm", "Worried his DSA is behind for the job search this month"), with its time frame when it has one. kind:
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
export async function writeDigest(userId: string, chunk: Pick<BuddyChunk, 'sessionKey' | 'project'>, out: DigestOutput, today: DayString): Promise<DigestWrite> {
    const result: DigestWrite = { notes: 0, seen: 0, items: 0 };
    for (const n of out.notes) {
        const text = cleanNoteText(n.text);
        if (!text || !memoryKey(text)) continue;
        let memoryId: string | null = null;
        if (n.seenMemoryId) {
            const m = await prisma.memory.findFirst({ where: { id: n.seenMemoryId, userId, status: { in: ['active', 'faded'] } } });
            if (m) {
                memoryId = m.id;
                await prisma.memory.update({
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
        await prisma.observation.create({
            data: { userId, text, kind: n.kind as MemoryKind, sensitivity: n.private ? 'private' : 'open', source: 'hook', sessionKey: chunk.sessionKey, project: chunk.project, day: toDbDay(today), memoryId },
        });
        result.notes++;
    }

    const urgentToday = await prisma.suggestion.count({ where: { userId, proposedBy: 'buddy', status: 'pending', createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
    let urgentLeft = Math.max(0, URGENT_ITEMS_PER_DAY - urgentToday);
    for (const item of out.items) {
        const text = clip(cleanNoteText(item.text), 140);
        if (!text) continue;
        const dup = await prisma.suggestion.findFirst({ where: { userId, kind: item.kind, status: { in: ['pending', 'candidate'] }, text: { equals: text, mode: 'insensitive' } }, select: { id: true } });
        if (dup) continue;
        const dueDay = item.kind === 'task' && isValidDay(item.dueDay) && item.dueDay >= today ? (item.dueDay as DayString) : null;
        const urgent = !!dueDay && dueDay <= addDays(today, 2) && urgentLeft > 0;
        if (urgent) urgentLeft--;
        const why = clip(cleanNoteText(item.why), 200);
        await prisma.suggestion.create({
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

/** One chunk through the gate (and the digest when the gate keeps anything). Throws on a failed call. */
export async function digestChunk(chunk: BuddyChunk, now: Date = new Date()): Promise<{ kept: number } & DigestWrite> {
    const messages = (Array.isArray(chunk.messages) ? chunk.messages : []) as unknown as ChunkMessage[];
    const ctx = await loadLearningContext(chunk.userId, now);
    if (!messages.length) return { kept: 0, notes: 0, seen: 0, items: 0 };

    const gate = await callClaude(withRefusalFallbacks(gateRequest(messages)), 'buddy gate');
    await recordAiUsage(chunk.userId, 'buddy_gate', gate);
    const kept = keptIndexes(parseJson(responseText(gate)), messages.length);
    if (!kept.length) {
        await bumpDay(chunk.userId, ctx.today, {});
        return { kept: 0, notes: 0, seen: 0, items: 0 };
    }

    const [known, saved, tasks] = await Promise.all([
        prisma.memory.findMany({ where: { userId: chunk.userId, status: 'active' }, select: { id: true, text: true, kind: true }, orderBy: [{ lastSeenDay: 'desc' }], take: MEMORIES_SHOWN }),
        prisma.observation.findMany({ where: { userId: chunk.userId, sessionKey: chunk.sessionKey, source: 'agent' }, select: { text: true }, take: 20 }),
        prisma.todo.findMany({ where: { userId: chunk.userId, workspaceId: null, status: { not: 'complete' } }, select: { title: true }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: ctx.tz }).format(now);
    const digest = await callClaude(
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
    return { kept: kept.length, ...written };
}
