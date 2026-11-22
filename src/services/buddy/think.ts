// The night step (BUDDY_MEMORY_PLAN §3.3): once per local day, after 04:00, Opus 5.5 reads the signals,
// the portrait, every lasting memory and the working ones, the notes no step has read yet, the
// buddy's items waiting, his notebook and what it said lately, and writes memory changes, the
// portrait, a line for each part of the day or silence, a thought for his home screen (or none), a
// note (or its silence), a follow-up for his next chat, which items to show, its notebook, and on
// Sundays the week's coach note. Code checks every op and every line before anything is written; a
// line that fails a guard is left out (the owner, 11-16: the buddy never forces a line; the lock screen
// then shows the dial of the day).
import type { Memory, MemoryKind, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { callClaude } from '../claude/client';
import { recordAiUsage } from '../claude/usage.service';
import { parseJson, responseText } from '../recall/output';
import { withRefusalFallbacks, type CreateParams } from '../recall/prompts';
import { addDays, dayOf, type DayString } from '../learning';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { coachWindow } from '../coach/evidence';
import { figuresIn } from '../coach/check';
import { characterPrompt } from './character';
import { personName, toneOf } from './state.service';
import { LASTING_KINDS, MEMORY_KINDS, cleanNoteText, memoryKey, normalizeTags } from './memory.service';
import { buddySignals, type BuddySignals } from './signals';
import { scrubSecrets } from './scrub';
import { buddyDayOf } from './voice';
import { unlabel } from './words';
import { settleWork, workForNight } from './work';
import { runRoutines } from './routines';
import { OLD_NEWS_MS, closePastEvents, fadeQuietThreads, withPersonLock, type About } from './threads';
import { activeScreenRules, rulesInWords, screenRulesBlock } from './screens';
import { NIGHT_LOOP_JOB, applyLoopExtra, loopSchema, threadsForNight, zLoopExtra } from './nightLoop';
import { aboutJson, aheadBlocks, leftOffSaidYesterday } from './aheadBlocks';
import { recordOutcomes } from './outcomes';
import { LINES_MAX, LINE_MIN_MINUTES, hasHours, lineKey, lineLabel, lineWindow, normTime, slotOfMinute } from './lineTimes';

export const THINK_MODEL = process.env['BUDDY_THINK_MODEL'] || 'claude-opus-5-5';
// The lock check decides what strangers may read on his phone: Sonnet 5.5 (the owner, 11-16: "that check is crucial"; a few calls a day).
export const CHECK_MODEL = process.env['BUDDY_CHECK_MODEL'] || 'claude-sonnet-5-5';
const EPHEMERAL = { type: 'ephemeral' } as const;
export const SLOTS = ['morning', 'afternoon', 'evening'] as const;
export type Slot = (typeof SLOTS)[number];
export const FORMS = ['observation', 'question', 'push', 'celebration', 'from_your_notes', 'plain'] as const;
const OPS = ['add', 'seen', 'update', 'merge', 'close'] as const;

/** The ceilings of what the night reads (§3.7): the cost of a day stays flat over the years. */
export const LASTING_MAX = 100;
export const WORKING_MAX = 120;
/** Notes not yet folded that one night reads (stage 4, H2: raised from 80 with the new sources; oldest first, so none waits behind newer ones). */
export const NOTES_MAX = 200;
const CANDIDATES_MAX = 20;
const SAID_DAYS = 14;
/**
 * A note that is old news (an export brought in, or words said over 48 hours before they arrived): a label that
 * says when, so the night and the pulses never read it as today's; null for a note of today. The week's simulation
 * (11-18): a September chat from an export, shown without its date, was answered as if said that evening.
 */
export function oldNote(n: { via?: string | null; saidAt?: Date | null; createdAt: Date }): string | null {
    const imported = n.via === 'import';
    const late = !!n.saidAt && n.createdAt.getTime() - n.saidAt.getTime() > OLD_NEWS_MS;
    if (!imported && !late) return null;
    return `old news: said ${n.saidAt ? n.saidAt.toISOString().slice(0, 10) : 'long ago'}${imported ? ', in an old chat brought in from an export' : ''}, not today`;
}

export const LINE_MAX = 90;

/**
 * A line a little over the limit keeps its whole first sentences that fit, instead of being dropped whole: in the
 * week's simulation (11-18) the one line before his mock interview ran 92 characters and the morning had none.
 * When even the first sentence is too long the line is returned as it is (and dropped as too long).
 */
export function fitLine(text: string, max: number): string {
    if (text.length <= max) return text;
    const sentences = text.split(/(?<=[.!?])\s+/);
    let kept = '';
    for (const s of sentences) {
        const next = kept ? `${kept} ${s}` : s;
        if (next.length > max) break;
        kept = next;
    }
    return kept || text;
}
/** The home screen's thought: up to three lines under his reminders. */
export const INSIGHT_MAX = 100;
const NOTE_MAX = 600;
const FOLLOW_UP_MAX = 200;
const NOTEBOOK_MAX = 1500;
const WHO_WORDS = 120;
const HEADING_WORDS = 80;
const NOW_WORDS = 120;
const SUGGEST_MAX = 3;

// ─── The request ───────────────────────────────────────────────────────────

/** The lines' part of the night's job: one per part of the day (the loop off). */
const SLOT_LINES = `- lines: one per slot (morning, afternoon, evening): what their lock screen and Home show at those hours. Write a line only when you have something worth their attention then; otherwise its text is "" (silence) and their lock screen shows the day's own dial (what is left and what is scheduled today), so a line that only restates those is never worth it. Silence is fine, for a slot or the whole day. A line: at most ${LINE_MAX} characters, one thought, said the way a friend would text it (no label in front). lockOk: true only if a stranger may read it. sourceId: the memory or note id it rests on, or "".`;

/** With the loop on (stage 7, V1; his point 4): 0 to 4 lines, each with its own hours, as many as it judges. */
const TIMED_LINES = `- lines: 0 to ${LINES_MAX} lines for their lock screen today, each shown in its own hours: from and until (HH:mm, their time; their day runs from 04:00 to 04:00, so 22:30 to 00:30 is fine), at least ${LINE_MIN_MINUTES} minutes, never overlapping. How many and when is your call: a line where it helps most (before the moment it is about, in the hours it matters), none where nothing is worth their attention. Between lines, and on a day without any, their lock screen shows the day's own dial (what is left and what is scheduled today), so a line that only restates those is never worth it. A line: at most ${LINE_MAX} characters, one thought, said the way a friend would text it (no label in front). lockOk: true only if a stranger may read it. sourceId: the memory or note id it rests on, or "".`;

const NIGHT_JOB = `Tonight you think about their day and answer with one JSON object:
- memory: changes to what you know about them.
  add: a memory from new notes worth keeping (kind; lasting true for fact, preference, value, aim, idea, decision, false for pattern, state, thread, win unless meant for years; private for health, money, family, other people, guilt, fear, work conflicts, leaving their job; from = the note ids).
  seen: a note repeats a memory (id, from). update: sharpen or correct one (id, text, from). merge: two or more say the same thing (ids, the merged text, kind). close: no longer true (id, reason).
  Memories marked "their own" are theirs: never update, merge or close them. Leave out notes not worth a memory. Keep memories short, specific, in the third person, without he or she (their first name, "they", or no pronoun). Unused fields: "" or [] or false.
- who (at most ${WHO_WORDS} words) and heading (at most ${HEADING_WORDS} words): rewrite only when a lasting memory changed tonight or none exists yet; else "".
- now (at most ${NOW_WORDS} words): this week in their life: what they are on, what weighs on them, what is going well.
${SLOT_LINES}
- insight: one thing for their home screen today, shown under their reminders all day: a suggestion, something you noticed, or a mindful nudge that would truly help them today. At most ${INSIGHT_MAX} characters, said the way a friend would text it, never what a line says, fit for anyone to read (nothing private, nothing about their job's work); or "" when nothing is worth it.
- note: a few sentences to them, like a message from a friend: natural and casual, straight to the point, no greeting or sign-off, no headings; or "" when there is nothing worth saying.
- A note about how a day went or felt, or a plan for a day that is over, belongs to that day (each note says when it was said): never say it as today's. It may shape one question ("Did 3Sum get done last night?") or how gently you start today.
- followUp: one question for their next chat with an agent, or "".
- suggestions: up to ${SUGGEST_MAX} candidate ids worth showing them now (the most useful, due soonest).
- notebook (at most ${NOTEBOOK_MAX} characters), for tomorrow night: what you watch, what you said tonight, what landed.
- weekly: on Sundays only (use true): the week's coach note: strong, slipping, fix, deadline (a sentence or two each, at most 220 characters) and exactly 3 focus lines (at most 140 characters) for the days ahead. Other days: use false, the rest empty.`;

const str = { type: 'string' } as const;
export const NIGHT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['memory', 'who', 'heading', 'now', 'lines', 'insight', 'note', 'followUp', 'suggestions', 'notebook', 'weekly'],
    properties: {
        memory: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['op', 'id', 'ids', 'kind', 'lasting', 'text', 'private', 'tags', 'from', 'reason'],
                properties: {
                    op: { type: 'string', enum: [...OPS] },
                    id: str,
                    ids: { type: 'array', items: str },
                    kind: { type: 'string', enum: [...MEMORY_KINDS, ''] },
                    lasting: { type: 'boolean' },
                    text: str,
                    private: { type: 'boolean' },
                    tags: { type: 'array', items: str },
                    from: { type: 'array', items: str },
                    reason: str,
                },
            },
        },
        who: str,
        heading: str,
        now: str,
        lines: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['slot', 'text', 'form', 'lockOk', 'sourceId'],
                properties: { slot: { type: 'string', enum: [...SLOTS] }, text: str, form: { type: 'string', enum: [...FORMS] }, lockOk: { type: 'boolean' }, sourceId: str },
            },
        },
        insight: str,
        note: str,
        followUp: str,
        suggestions: { type: 'array', items: str },
        notebook: str,
        weekly: {
            type: 'object',
            additionalProperties: false,
            required: ['use', 'strong', 'slipping', 'fix', 'deadline', 'focus'],
            properties: { use: { type: 'boolean' }, strong: str, slipping: str, fix: str, deadline: str, focus: { type: 'array', items: str } },
        },
    },
};

/** NIGHT_SCHEMA without the week's note: a weekday night with the loop on (nightLoopSchema). */
const NIGHT_SCHEMA_WEEKDAY: Record<string, unknown> = (() => {
    const s = JSON.parse(JSON.stringify(NIGHT_SCHEMA)) as { required: string[]; properties: Record<string, unknown> };
    delete s.properties['weekly'];
    s.required = s.required.filter((r) => r !== 'weekly');
    return s;
})();

export interface NightMemoryRow {
    id: string;
    kind: MemoryKind;
    lasting: boolean;
    private: boolean;
    byUser: boolean;
    seenCount: number;
    lastSeenDay: string;
    text: string;
}

export interface NightInput {
    name: string | null;
    tone: 'candid' | 'gentle' | 'bro';
    /** Stage 5: the loop is on (the character's two changes, §4.3). */
    loop?: boolean;
    /** The account's own name (the buddy's prompt uses its first word; none: "the user"). */
    person?: string | null;
    signals: BuddySignals;
    portrait: { who: string | null; heading: string | null; now: string | null };
    memories: NightMemoryRow[];
    /** `old`: said long before it arrived (an export brought in, held words): when, so it is never read as today's. */
    notes: Array<{ id: string; kind: MemoryKind; private: boolean; source: string; text: string; old?: string | undefined; /** Stage 18: the day it was said ("Thu 19 Nov"). */ said?: string | undefined }>;
    candidates: Array<{ id: string; kind: string; text: string; due: string | null }>;
    hisNotes: Array<{ title: string; text: string }>;
    notebook: string | null;
    said: Array<{ day: string; what: string; text: string }>;
    timezone: string;
    /** What his routines did by themselves just now (B6): the note names them. */
    doneForHim?: string[];
    /** Open threads quiet for five weeks or more, about to fade: the night may ask about one once. */
    quietThreads?: string[];
    /** B9: his last day's work log (per project: time and lines; office ones marked), when it is on. */
    workYesterday?: { text: string; lines: string[] } | null;
}

export function nightTask(input: NightInput): string {
    const s = input.signals;
    const mem = (m: NightMemoryRow) =>
        `${m.id} · ${m.kind} · ${m.lasting ? 'lasting' : 'working'} · ${m.private ? 'private' : 'open'}${m.byUser ? " · their own" : ''} · seen ${m.seenCount} · last ${m.lastSeenDay} · ${m.text}`;
    return [
        `<today>${s.today.weekday} ${s.today.day}, ${s.today.time} (${input.timezone})${s.today.isSunday ? ' · Sunday: write the weekly note' : ''}</today>`,
        `<signals>\n${JSON.stringify(s)}\n</signals>`,
        `<portrait>\nwho: ${input.portrait.who ?? 'not written yet'}\nheading: ${input.portrait.heading ?? 'not written yet'}\nnow: ${input.portrait.now ?? 'not written yet'}\n</portrait>`,
        `<memories>\n${input.memories.map(mem).join('\n') || 'none yet'}\n</memories>`,
        `<new_notes>\n${input.notes.map((n) => `${n.id} · ${n.kind} · ${n.private ? 'private' : 'open'} · from ${n.source}${n.old ? ` · ${n.old}` : n.said ? ` · said ${n.said}` : ''} · ${n.text}`).join('\n') || 'none'}\n</new_notes>`,
        `<candidates>\n${input.candidates.map((c) => `${c.id} · ${c.kind} · ${c.text}${c.due ? ` · due ${c.due}` : ''}`).join('\n') || 'none'}\n</candidates>`,
        `<their_notes>\n${input.hisNotes.map((n) => `"${n.title}": ${n.text}`).join('\n') || 'none'}\n</their_notes>`,
        `<notebook>\n${input.notebook ?? 'empty: this is your first night'}\n</notebook>`,
        `<said>\n${input.said.map((x) => `${x.day} ${x.what}: ${x.text}`).join('\n') || 'nothing yet'}\n</said>`,
        ...(input.quietThreads?.length
            ? [`<quiet_threads>\n${input.quietThreads.join('\n')}\nThese open threads have been quiet for over five weeks and fade within a week. If one still matters, ask them about it once, in followUp ("still on?"); else let it go.\n</quiet_threads>`]
            : []),
        ...(input.workYesterday
            ? [`<work_yesterday>\n${input.workYesterday.text}\nWhat they worked on yesterday, from their work log: so you know where their hours went. You may speak of it in the note (how the day went, what is next); never in the lines, which show on their lock screen. Never turn it into a memory about them.\n</work_yesterday>`]
            : []),
        ...(input.doneForHim?.length ? [`<done_for_them>\nBy their standing yes you just: ${input.doneForHim.join('; ')}. Name it in the note.\n</done_for_them>`] : []),
        'Write tonight’s step.',
    ].join('\n\n');
}

export function nightRequest(input: NightInput): CreateParams {
    return {
        model: THINK_MODEL,
        max_tokens: 16_000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: NIGHT_SCHEMA } },
        system: [{ type: 'text', text: `${characterPrompt({ name: input.name, tone: input.tone, person: input.person, loop: input.loop })}\n\n${input.loop ? NIGHT_JOB.replace(SLOT_LINES, () => TIMED_LINES) : NIGHT_JOB}`, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: [{ type: 'text', text: nightTask(input) }] }],
    } as CreateParams;
}

/**
 * The night's schema with the loop on. The API compiles a structured-output schema into a grammar whose size is
 * limited: with the loop's fields, the buddy's own reminders (stage 7) and the Sunday note together it was refused
 * ("The compiled grammar is too large", found by the week's simulation, 11-18). So the week's note is in it only on
 * Sundays, and a Sunday night writes no reminders of its own (that day's pulses still may). Measured against the
 * API on 11-18: weight 76 refused, 70 accepted; tests/unit/buddy/nightSchema.test.ts holds every variant at 70 or
 * less (scripts/sim/schema-probe.ts checks a heavier one against the API before the limit is raised).
 */
export function nightLoopSchema(sunday: boolean): Record<string, unknown> {
    return loopSchema(sunday ? NIGHT_SCHEMA : NIGHT_SCHEMA_WEEKDAY, { threadOps: true, reminders: !sunday });
}

/**
 * The night's request with the loop on (stage 3): its job about the threads, the threads themselves and the
 * loop's schema (each line with its hours from stage 7). The night and the night's test set build it the same way.
 */
export function withLoop(request: CreateParams, threadsBlock: string, opts: { sunday: boolean }): CreateParams {
    const r = request as unknown as { system: Array<{ text: string }>; messages: Array<{ content: Array<{ text: string }> }>; output_config: { format: { schema: unknown } } };
    // Sunday: the week's note, no reminders of its own; other days the other way round (nightLoopSchema).
    const job = opts.sunday ? NIGHT_LOOP_JOB.replace(/^- reminders:.*\n?/m, '') : NIGHT_LOOP_JOB;
    if (!opts.sunday) r.system[0]!.text = r.system[0]!.text.replace(/^- weekly:.*\n?/m, '');
    r.system[0]!.text += `\n${job}`;
    r.messages[0]!.content[0]!.text = r.messages[0]!.content[0]!.text.replace('Write tonight’s step.', () => `<threads>\n${threadsBlock}\n</threads>\n\nWrite tonight’s step.`);
    r.output_config.format.schema = nightLoopSchema(opts.sunday);
    return request;
}

const zOp = z.object({
    op: z.enum(OPS),
    id: z.string(),
    ids: z.array(z.string()),
    kind: z.union([z.enum(MEMORY_KINDS), z.literal('')]),
    lasting: z.boolean(),
    text: z.string(),
    private: z.boolean(),
    tags: z.array(z.string()),
    from: z.array(z.string()),
    reason: z.string(),
});
const zNight = z.object({
    memory: z.array(zOp),
    who: z.string(),
    heading: z.string(),
    now: z.string(),
    // A line names its part of the day, or with the loop on (stage 7) its own hours.
    lines: z.array(z.object({ slot: z.enum(SLOTS).optional(), from: z.string().optional(), until: z.string().optional(), text: z.string(), form: z.enum(FORMS), lockOk: z.boolean(), sourceId: z.string() })),
    // An answer from before the home screen's thought (11-16) has none.
    insight: z.string().default(''),
    note: z.string(),
    followUp: z.string(),
    suggestions: z.array(z.string()),
    notebook: z.string(),
    // Absent on a weekday night with the loop on (nightLoopSchema): no note that day.
    weekly: z.object({ use: z.boolean(), strong: z.string(), slipping: z.string(), fix: z.string(), deadline: z.string(), focus: z.array(z.string()) }).default({ use: false, strong: '', slipping: '', fix: '', deadline: '', focus: [] }),
});
export type NightOutput = z.infer<typeof zNight>;
export type NightOp = z.infer<typeof zOp>;

export function parseNight(output: unknown): NightOutput {
    const parsed = zNight.safeParse(output);
    if (!parsed.success) throw new Error('the night step answered in the wrong shape');
    return parsed.data;
}

// ─── Checking the ops ──────────────────────────────────────────────────────

export interface OpContext {
    memories: Map<string, Pick<Memory, 'id' | 'status' | 'byUser'>>;
    noteIds: Set<string>;
}

export interface Dropped {
    what: string;
    why: string;
}

/** The ops code accepts (the rest are dropped and counted, never fatal). */
export function checkOps(ops: readonly NightOp[], ctx: OpContext): { valid: NightOp[]; dropped: Dropped[] } {
    const valid: NightOp[] = [];
    const dropped: Dropped[] = [];
    const usable = (id: string) => {
        const m = ctx.memories.get(id);
        return !!m && (m.status === 'active' || m.status === 'faded');
    };
    const his = (id: string) => ctx.memories.get(id)?.byUser === true;
    for (const op of ops.slice(0, 60)) {
        const from = op.from.filter((f) => ctx.noteIds.has(f));
        const text = cleanNoteText(op.text);
        let why: string | null = null;
        if (op.op === 'add') {
            if (!op.kind) why = 'add without a kind';
            else if (!text || !memoryKey(text)) why = 'add without words';
        } else if (op.op === 'seen') {
            if (!usable(op.id)) why = 'seen: no such memory';
        } else if (op.op === 'update') {
            if (!usable(op.id)) why = 'update: no such memory';
            else if (his(op.id)) why = 'update: their own memory';
            else if (!text && op.tags.length === 0) why = 'update: nothing to change';
        } else if (op.op === 'merge') {
            const ids = [...new Set(op.ids)];
            if (ids.length < 2 || !ids.every(usable)) why = 'merge: needs two of their memories';
            else if (ids.some(his)) why = 'merge: one is their own';
            else if (!text || !op.kind) why = 'merge: needs the merged text and kind';
        } else if (op.op === 'close') {
            if (!usable(op.id)) why = 'close: no such memory';
            else if (his(op.id)) why = 'close: their own memory';
        }
        if (why) dropped.push({ what: `op ${op.op}`, why });
        else valid.push({ ...op, from, text });
    }
    return { valid, dropped };
}

const monthOf = (day: DayString) => day.slice(0, 7);

/** Applies the checked ops in one transaction; answers what was done (the BuddyDay's audit). */
export async function applyOps(userId: string, ops: readonly NightOp[], today: DayString, now: Date): Promise<Array<Record<string, unknown>>> {
    const applied: Array<Record<string, unknown>> = [];
    await prisma.$transaction(async (tx) => {
        const link = (ids: readonly string[], memoryId: string) =>
            ids.length ? tx.observation.updateMany({ where: { userId, id: { in: [...ids] } }, data: { memoryId, foldedAt: now } }) : Promise.resolve();
        for (const op of ops) {
            if (op.op === 'add') {
                const kind = op.kind as MemoryKind;
                const m = await tx.memory.create({
                    data: {
                        userId,
                        text: op.text,
                        kind,
                        sensitivity: op.private ? 'private' : 'open',
                        lasting: op.lasting || LASTING_KINDS.has(kind),
                        tags: normalizeTags(op.tags),
                        source: 'buddy',
                        firstSeenDay: toDbDay(today),
                        lastSeenDay: toDbDay(today),
                        monthsSeen: [monthOf(today)],
                    },
                    select: { id: true },
                });
                await link(op.from, m.id);
                applied.push({ op: 'add', id: m.id, from: op.from });
            } else if (op.op === 'seen' || op.op === 'update') {
                const m = await tx.memory.findUniqueOrThrow({ where: { id: op.id } });
                await tx.memory.update({
                    where: { id: m.id },
                    data: {
                        seenCount: { increment: op.op === 'seen' ? 1 : 0 },
                        lastSeenDay: toDbDay(today),
                        ...(m.monthsSeen.includes(monthOf(today)) ? {} : { monthsSeen: [...m.monthsSeen, monthOf(today)] }),
                        ...(m.status === 'faded' ? { status: 'active' } : {}),
                        ...(op.op === 'update' && op.text ? { text: op.text } : {}),
                        ...(op.op === 'update' && op.tags.length ? { tags: normalizeTags(m.tags, op.tags) } : {}),
                        ...(op.private && m.sensitivity === 'open' ? { sensitivity: 'private' } : {}),
                    },
                });
                await link(op.from, m.id);
                applied.push({ op: op.op, id: m.id, ...(op.op === 'update' ? { before: { text: m.text, tags: m.tags } } : {}) });
            } else if (op.op === 'merge') {
                const ids = [...new Set(op.ids)];
                const merged = await tx.memory.create({
                    data: {
                        userId,
                        text: op.text,
                        kind: op.kind as MemoryKind,
                        sensitivity: op.private ? 'private' : 'open',
                        lasting: op.lasting || LASTING_KINDS.has(op.kind as MemoryKind),
                        tags: normalizeTags(op.tags),
                        source: 'buddy',
                        firstSeenDay: toDbDay(today),
                        lastSeenDay: toDbDay(today),
                        monthsSeen: [monthOf(today)],
                        supersedesId: ids[0]!,
                    },
                    select: { id: true },
                });
                await tx.memory.updateMany({ where: { userId, id: { in: ids } }, data: { status: 'closed', closedDay: toDbDay(today), closeReason: 'Merged into a fuller memory' } });
                await tx.observation.updateMany({ where: { userId, memoryId: { in: ids } }, data: { memoryId: merged.id } });
                await link(op.from, merged.id);
                applied.push({ op: 'merge', id: merged.id, ids });
            } else if (op.op === 'close') {
                await tx.memory.update({ where: { id: op.id }, data: { status: 'closed', closedDay: toDbDay(today), closeReason: (op.reason || 'No longer true').slice(0, 200), pinned: false } });
                applied.push({ op: 'close', id: op.id, reason: op.reason.slice(0, 200) });
            }
        }
    });
    return applied;
}

// ─── The guards ────────────────────────────────────────────────────────────

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const wordSet = (t: string) => new Set(memoryKey(t).split(' ').filter((w) => w.length > 2));

/** Two lines say the same thing: the same words, or most of them shared. */
export function tooClose(a: string, b: string): boolean {
    if (memoryKey(a) === memoryKey(b)) return true;
    const x = wordSet(a);
    const y = wordSet(b);
    if (!x.size || !y.size) return false;
    const shared = [...x].filter((w) => y.has(w)).length;
    return shared / Math.min(x.size, y.size) >= 0.75;
}

/** Numbers the text holds that its sources don't: digits, and from stage 5 the words two to twenty (§4.16 rule 9). */
export function strayNumbers(text: string, sources: string): string[] {
    const allowed = new Set(figuresIn(sources));
    return [...new Set(figuresIn(text).filter((n) => !allowed.has(n)))];
}

export interface Line {
    slot: Slot;
    text: string;
    form: string;
    lockOk: boolean;
    sourceId: string | null;
    /**
     * Written by code: steps before 11-16 put the plain line from the counts in place of a line a guard
     * threw out. Never shown; new steps leave such a slot silent.
     */
    fallback?: true;
    /** Stage 3: the threads it rests on, with the revision its writer saw (a newer word withdraws it). */
    about?: About[];
    /** Stage 17: the left-off items and to-dos it rests on (pu_…, tk_…): one that closes withdraws it. */
    refs?: string[];
    /**
     * Stage 7 (V1), the loop on: its own hours, HH:mm on his clock inside his buddy day (04:00 to 04:00); `slot` is
     * then the part of the day it starts in. Without them a line holds its part of the day (lineTimes.ts).
     */
    from?: string;
    until?: string;
}

export { unlabel };

/** A line with the refs it rests on (stage 17), none kept when it rests on none. */
export function withRefs<T extends Line>(l: T, refs: readonly string[] | undefined): T {
    const { refs: _old, ...rest } = l;
    void _old;
    return (refs?.length ? { ...rest, refs: [...refs] } : rest) as T;
}

/**
 * Lengths, numbers, repeats. Only the lines that pass come back, one per slot at most: a slot the
 * model left silent ("" or none) stays silent, and so does one whose line fails (counted in dropped).
 * A silent slot shows the dial of the day on the lock screen (the owner, 11-16: never a forced line).
 */
export function guardLines(lines: NightOutput['lines'], ctx: { sources: string; recent: readonly string[] }): { lines: Line[]; dropped: Dropped[] } {
    const dropped: Dropped[] = [];
    const out: Line[] = [];
    for (const slot of SLOTS) {
        const l = lines.find((x) => x.slot === slot);
        const text = l ? fitLine(unlabel(scrubSecrets(l.text).replace(/\s+/g, ' ').trim()), LINE_MAX) : '';
        if (!l || !text) continue;
        let why: string | null = null;
        if (text.length > LINE_MAX) why = 'too long';
        else if (strayNumbers(text, ctx.sources).length) why = 'a number it was not given';
        else if (ctx.recent.some((r) => tooClose(r, text))) why = 'said lately';
        if (why) dropped.push({ what: `line ${slot}`, why });
        else out.push({ slot, text, form: l.form, lockOk: l.lockOk, sourceId: l.sourceId || null });
    }
    return { lines: out, dropped };
}

/**
 * Timed lines (stage 7, V1; the loop on): 0 to 4 for the day, each with its own hours (at least half an hour,
 * inside his buddy day, never overlapping another), with the length and number checks of a slot's line. No rule
 * against saying again what it said on another day: relevance wins (his point 5; the character asks it softly).
 * `kept`: lines that stay as they are (a pulse keeps those whose hours are over), counted in the four; `after`:
 * a minute of his day by which a new line must not have ended (a pulse writes from now on).
 */
export function guardTimedLines(lines: NightOutput['lines'], ctx: { sources: string; kept?: readonly Line[]; after?: number }): { lines: Line[]; dropped: Dropped[] } {
    const dropped: Dropped[] = [];
    const fit: Array<{ line: Line; at: [number, number] }> = [];
    for (const l of lines) {
        const text = fitLine(unlabel(scrubSecrets(l.text).replace(/\s+/g, ' ').trim()), LINE_MAX);
        if (!text) continue;
        const from = normTime(l.from);
        const until = normTime(l.until);
        let why: string | null = null;
        let at: [number, number] = [0, 0];
        if (!from || !until) why = 'not a time of day';
        else {
            at = lineWindow({ slot: 'morning', from, until });
            if (at[1] <= at[0]) why = 'ends before it starts';
            else if (at[1] - at[0] < LINE_MIN_MINUTES) why = 'shorter than half an hour';
            else if (ctx.after !== undefined && at[1] <= ctx.after) why = 'its hours are over';
            else if (text.length > LINE_MAX) why = 'too long';
            else if (strayNumbers(text, ctx.sources).length) why = 'a number it was not given';
        }
        if (why || !from || !until) {
            dropped.push({ what: `line ${from ?? l.from ?? '?'}`, why: why ?? 'not a time of day' });
            continue;
        }
        fit.push({ line: { slot: slotOfMinute(at[0]), from, until, text, form: l.form, lockOk: l.lockOk, sourceId: l.sourceId || null }, at });
    }
    fit.sort((a, b) => a.at[0] - b.at[0]);
    const kept = ctx.kept ?? [];
    const taken = kept.map((k) => lineWindow(k));
    const out: Line[] = [];
    for (const { line, at } of fit) {
        let why: string | null = null;
        if (taken.some(([s, e]) => at[0] < e && s < at[1])) why = 'overlaps another line';
        else if (kept.length + out.length >= LINES_MAX) why = `more than ${LINES_MAX} lines today`;
        if (why) {
            dropped.push({ what: `line ${line.from}`, why });
            continue;
        }
        taken.push(at);
        out.push(line);
    }
    return { lines: out, dropped };
}

/**
 * The home screen's thought: the same guards as a line, with its own length, and never what a line of
 * the day says. Null when there is none or it fails (counted in dropped).
 */
export function guardInsight(raw: string, ctx: { sources: string; recent: readonly string[]; lines: readonly Line[] }, dropped: Dropped[]): string | null {
    const text = unlabel(scrubSecrets(raw).replace(/\s+/g, ' ').trim());
    if (!text) return null;
    let why: string | null = null;
    if (text.length > INSIGHT_MAX) why = 'too long';
    else if (strayNumbers(text, ctx.sources).length) why = 'a number it was not given';
    else if (ctx.lines.some((l) => tooClose(l.text, text))) why = 'a line says it';
    else if (ctx.recent.some((r) => tooClose(r, text))) why = 'said lately';
    if (!why) return text;
    dropped.push({ what: 'insight', why });
    return null;
}

export const LOCK_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['lines', 'note', 'insight', 'asks'],
    properties: {
        lines: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['slot', 'reveals'], properties: { slot: { type: 'string', enum: [...SLOTS] }, reveals: { type: 'boolean' } } },
        },
        /** Stage 6 (§4.14): each question, by its number, as it may show on the lock screen (app 0.6.0). */
        asks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 'reveals'], properties: { i: { type: 'integer' }, reveals: { type: 'boolean' } } } },
        /** The note, as a phone notification (the lock screen shows those too): true when it reveals. */
        note: { type: 'boolean' },
        /** The home screen's thought (others see a home screen too): true when it reveals. */
        insight: { type: 'boolean' },
    },
};

/** Stage 7: timed lines go to the lock check by number (two may share a part of the day). */
export const LOCK_SCHEMA_TIMED: Record<string, unknown> = {
    ...LOCK_SCHEMA,
    properties: {
        ...(LOCK_SCHEMA['properties'] as Record<string, unknown>),
        lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['i', 'reveals'], properties: { i: { type: 'integer' }, reveals: { type: 'boolean' } } } },
    },
};

// Stage 5b (the owner's answer, 11-18 evening): ordinary routines may show; the whole message is judged in context;
// private details about other people never show; his own rules (<their_rules>) keep more off.
export const LOCK_SYSTEM = `A line will show on a person's phone lock screen, where anyone nearby can read it. You get the person's private facts, the rules they set for their screens, and the lines. Judge each line whole, the way a stranger nearby would read it, and answer reveals: true when that stranger would learn something private:
- about the person: an illness, injury, treatment or medical worry; money trouble; relationship or family matters; guilt, fear or a conflict; leaving a job; what they work on at their job (its projects, code, clients);
- any private detail about another person (their health, relationships, money or troubles);
- one of their private facts below, or anything their rules keep off the lock screen.
Ordinary routines may show: exercise, sleep, food habits, study, chores and errands, the day's plan ("Run before work?", "Lights out by 11 tonight", "Two reviews left, then you're free"). A line may be shaped by a private fact as long as it does not name it. When unsure, answer true.
The note (a few sentences) may show the same way, as a phone notification on the lock screen. Answer note with the same test for the whole note: true when it reveals any of that (or when there is no note).
The home line shows all day on the phone's home screen, which others see too. Answer insight with the same test: true when it reveals any of that (or when there is no home line).
Each question (<asks>, by its number) may show the same way, on the lock screen or in a notification there. Answer each with the same test: true when it reveals any of that.`;

/** The lock check for the lines (and the note and the home screen's thought, when there are some): structured, fail closed by the caller. `rules`: his screen rules in words (stage 5b). */
export function lockRequest(lines: readonly Line[], privateTexts: readonly string[], note: string | null = null, insight: string | null = null, asks: readonly string[] = [], rules: readonly string[] = []): CreateParams {
    // Stage 7: timed lines go by number; a day of slots keeps its slots (the loop off: the same request as before).
    const timed = lines.some((l) => l.from !== undefined);
    return {
        model: CHECK_MODEL,
        // The model thinks by default (adaptive): low effort, and room for it (400 cut the answer off
        // once the note joined the check, 11-16; a cut answer fails closed).
        max_tokens: 4000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: timed ? LOCK_SCHEMA_TIMED : LOCK_SCHEMA } },
        system: [{ type: 'text', text: timed ? `${LOCK_SYSTEM}\nThe lines come by number: answer each line by its number (i).` : LOCK_SYSTEM }],
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `<private>\n${privateTexts.join('\n') || '(none)'}\n</private>\n<their_rules>\n${rules.join('\n') || '(none)'}\n</their_rules>\n<lines>\n${lines.map((l, i) => `${timed ? i : l.slot}: ${l.text}`).join('\n') || '(none)'}\n</lines>\n<note>\n${note ?? '(none)'}\n</note>\n<home>\n${insight ?? '(none)'}\n</home>\n<asks>\n${asks.map((a, i) => `${i}: ${a}`).join('\n') || '(none)'}\n</asks>`,
                    },
                ],
            },
        ],
    } as CreateParams;
}

/** `note` and `insight` are optional for an older answer: a missing verdict keeps them off the phone's screens. */
export const zLock = z.object({ lines: z.array(z.object({ slot: z.enum(SLOTS).optional(), i: z.number().int().optional(), reveals: z.boolean() })), note: z.boolean().optional(), insight: z.boolean().optional(), asks: z.array(z.object({ i: z.number().int(), reveals: z.boolean() })).optional() });

/**
 * The lock check of a step (the night and the pulses): the lines marked lockOk, when there are private
 * things to check them against (otherwise their own lockOk stands), and the note and the home screen's
 * thought always (a notification and a home screen are seen by others too). A failed check keeps every
 * checked line, the note and the thought off the phone's screens. `only`: the keys of the lines this step
 * wrote (a pulse: its slots, or its timed lines' starts); the others keep what they had. Null: all of them.
 */
export async function lockCheck(
    userId: string,
    lines: Line[],
    privateTexts: readonly string[],
    said: { note: string | null; insight?: string | null; asks?: readonly string[] },
    dropped: Dropped[],
    only: readonly string[] | null = null
): Promise<{ lines: Line[]; noteLockOk: boolean; insightLockOk: boolean; asksLockOk: boolean[]; costUsd: number }> {
    const { note } = said;
    const insight = said.insight ?? null;
    // Stage 6 (§4.14): its questions too, for the lock screen and the notification of app 0.6.0.
    const asks = said.asks ?? [];
    const none = asks.map(() => false);
    // Stage 3 (ECOSYSTEM_V2_PLAN §4.8): every line that could reach a screen is checked, for every person. It was
    // skipped when a person had no private memories or notes, so the night's own mark stood unchecked.
    const toCheck = lines.filter((l) => (!only || only.includes(lineKey(l))) && l.lockOk && !l.fallback);
    const byNumber = toCheck.some((l) => l.from !== undefined);
    if (!toCheck.length && !note && !insight && !asks.length) return { lines, noteLockOk: false, insightLockOk: false, asksLockOk: none, costUsd: 0 };
    let costUsd = 0;
    try {
        // Stage 5b: what he keeps off his lock screen (his words, or a "too private" thumb on a line about no thread).
        const rules = rulesInWords((await activeScreenRules(userId)).filter((r) => r.kind === 'topic')).slice(0, 30);
        const check = await callClaude(userId, lockRequest(toCheck, privateTexts.slice(0, 60), note, insight, asks, rules), 'buddy lock check');
        costUsd = (await recordAiUsage(userId, 'buddy_check', check)).costUsd;
        const verdict = zLock.parse(parseJson(responseText(check)));
        const out = lines.map((l) => {
            if (!toCheck.includes(l)) return l;
            const v = byNumber ? verdict.lines.find((x) => x.i === toCheck.indexOf(l)) : verdict.lines.find((x) => x.slot === l.slot);
            if (v && !v.reveals) return l;
            dropped.push({ what: `lock ${lineKey(l)}`, why: v ? 'names a private thing' : 'not checked' });
            return { ...l, lockOk: false };
        });
        const insightLockOk = !!insight && verdict.insight === false;
        if (insight && !insightLockOk) dropped.push({ what: 'lock insight', why: verdict.insight === undefined ? 'not checked' : 'names a private thing' });
        // A question with no verdict, or one that reveals, stays off the lock screen (fail closed).
        const asksLockOk = asks.map((_, i) => verdict.asks?.find((x) => x.i === i)?.reveals === false);
        return { lines: out, noteLockOk: !!note && verdict.note === false, insightLockOk, asksLockOk, costUsd };
    } catch (err) {
        // The reason in the log (never his words): a failed check is otherwise silent.
        console.warn(`[buddy] lock check failed: ${err instanceof Error ? err.message : String(err)}`);
        if (toCheck.length || insight) dropped.push({ what: 'lock check', why: 'failed: nothing of it on the phone today' });
        return { lines: lines.map((l) => (toCheck.includes(l) ? { ...l, lockOk: false } : l)), noteLockOk: false, insightLockOk: false, asksLockOk: none, costUsd };
    }
}

// ─── The step ──────────────────────────────────────────────────────────────

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);
const capWords = (t: string, max: number) => (words(t) > max ? `${t.split(/\s+/).slice(0, max).join(' ')}…` : t);

/** Stage 5b: a thumb's reason in the night's words. */
const THUMB_WORDS: Record<string, string> = { private: 'too private for their screen', time: 'wrong time', useless: 'not useful', wrong: 'not true' };

/** "Thu 19 Nov": the day a note was said, their clock (stage 18). */
const saidDay = (at: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(at).replace(',', '');

/** Everything the night reads, within its ceilings. */
export async function loadNightInput(userId: string, now: Date): Promise<NightInput & { tz: string; today: DayString }> {
    const ctx = await loadLearningContext(userId, now);
    const [state, lasting, working, notes, candidates, captures, recent, thumbs] = await Promise.all([
        prisma.buddyState.findUnique({ where: { userId } }),
        prisma.memory.findMany({ where: { userId, status: 'active', lasting: true }, orderBy: [{ pinned: 'desc' }, { lastSeenDay: 'desc' }], take: LASTING_MAX }),
        prisma.memory.findMany({ where: { userId, status: 'active', lasting: false }, orderBy: [{ lastSeenDay: 'desc' }], take: WORKING_MAX }),
        prisma.observation.findMany({ where: { userId, foldedAt: null, memoryId: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: NOTES_MAX }),
        prisma.suggestion.findMany({ where: { userId, proposedBy: 'buddy', status: 'candidate', OR: [{ expiresDay: null }, { expiresDay: { gte: toDbDay(ctx.today) } }] }, orderBy: { createdAt: 'desc' }, take: CANDIDATES_MAX }),
        prisma.capture.findMany({ where: { userId, type: 'NOTE' }, orderBy: { createdAt: 'desc' }, take: 40, select: { title: true, content: true } }),
        prisma.buddyDay.findMany({ where: { userId, day: { gte: toDbDay(addDays(ctx.today, -SAID_DAYS)) } }, orderBy: { createdAt: 'asc' } }),
        prisma.buddyFeedback.findMany({ where: { userId, createdAt: { gte: new Date(now.getTime() - SAID_DAYS * 86_400_000) } } }),
    ]);
    const signals = await buddySignals(userId, now);
    // Up to 5 of his saved notes, picked by the day (a different handful each night), scrubbed and short.
    const offset = captures.length ? Number(ctx.today.replace(/-/g, '')) % captures.length : 0;
    const hisNotes = [...captures.slice(offset), ...captures.slice(0, offset)]
        .filter((c) => c.title || c.content)
        .slice(0, 5)
        .map((c) => ({ title: clip(scrubSecrets(c.title ?? 'a note').replace(/\s+/g, ' '), 80), text: clip(scrubSecrets(c.content ?? '').replace(/\s+/g, ' ').trim(), 200) }));
    const said: NightInput['said'] = [];
    const thumb = (dayId: string, target: string) => {
        const t = thumbs.find((x) => x.buddyDayId === dayId && x.target === target);
        // Stage 5b: why, when they said ("not this: wrong time"), and their few words.
        const why = t?.reason ? `: ${THUMB_WORDS[t.reason] ?? t.reason}` : '';
        return t ? (t.verdict === 'more' ? ' (they liked this: more like it)' : ` (they said: not this${why}${t.words ? `, "${t.words}"` : ''})`) : '';
    };
    for (const d of recent) {
        for (const l of (Array.isArray(d.lines) ? d.lines : []) as unknown as Line[]) if (!l.fallback && l.text) said.push({ day: fromDbDay(d.day), what: lineLabel(l), text: `${l.text}${thumb(d.id, lineKey(l)) || thumb(d.id, l.slot)}` });
        if (d.insight) said.push({ day: fromDbDay(d.day), what: 'home', text: d.insight });
        if (d.note) said.push({ day: fromDbDay(d.day), what: 'note', text: `${clip(d.note, 200)}${thumb(d.id, 'note')}` });
    }
    const row = (m: Memory): NightMemoryRow => ({ id: m.id, kind: m.kind, lasting: m.lasting, private: m.sensitivity === 'private', byUser: m.byUser, seenCount: m.seenCount, lastSeenDay: fromDbDay(m.lastSeenDay), text: m.text });
    return {
        name: state?.name ?? null,
        tone: toneOf(state?.tone),
        person: await personName(userId),
        signals,
        portrait: { who: state?.who ?? null, heading: state?.heading ?? null, now: state?.now ?? null },
        memories: [...lasting, ...working].map(row),
        notes: notes.map((n) => ({ id: n.id, kind: n.kind, private: n.sensitivity === 'private', source: n.source, text: n.text, ...(oldNote(n) ? { old: oldNote(n)! } : { said: saidDay(n.saidAt ?? n.createdAt, ctx.tz) }) })),
        candidates: candidates.map((c) => ({ id: c.id, kind: c.kind, text: c.text, due: typeof (c.payload as Record<string, unknown>)?.['dueDay'] === 'string' ? String((c.payload as Record<string, unknown>)['dueDay']) : null })),
        hisNotes,
        notebook: state?.notebook ?? null,
        // Threads quiet 38-45 days: the week before they fade (fadeMemories, THREAD_QUIET_DAYS).
        quietThreads: working
            .filter((m) => m.kind === 'thread' && !m.byUser && !m.pinned && fromDbDay(m.lastSeenDay) <= addDays(ctx.today, -38) && fromDbDay(m.lastSeenDay) >= addDays(ctx.today, -45))
            .map((m) => `${m.id} · quiet since ${fromDbDay(m.lastSeenDay)} · ${m.text}`),
        said,
        timezone: ctx.tz,
        tz: ctx.tz,
        today: ctx.today,
    };
}

export interface BuddyDayJson {
    _id: string;
    day: DayString;
    kind: 'night' | 'pulse';
    /** The lines it spoke (a silent slot has none). */
    lines: Line[];
    /** The home screen's thought, or null. */
    insight: string | null;
    note: string | null;
    followUp: string | null;
    ops: number;
    dropped: Dropped[];
    costUsd: number;
}

/** The night for one user (the caller has checked the buddy may spend and claimed the day). */
export async function runNight(userId: string, now: Date = new Date()): Promise<BuddyDayJson> {
    // His routines run first, so the night can name what they did (B6).
    const doneForHim = await runRoutines(userId, now);
    const loaded = await loadNightInput(userId, now);
    // Stage 20: what followed yesterday's words (a quiet record, before thinking; its failure never stops the night).
    await recordOutcomes(userId, addDays(loaded.today, -1), loaded.tz).catch((err) => console.error(`[buddy] the outcomes record failed: ${err instanceof Error ? err.message : String(err)}`));
    // Stage 12: first settle what the writers left open (a fix not linked, an open problem logged twice), so the night,
    // the briefs and "what's still open?" read a settled log. Its failure never stops the night.
    await settleWork(userId, now).catch((err) => console.error(`[buddy] settling the work log failed: ${err instanceof Error ? err.message : String(err)}`));
    const input = { ...loaded, doneForHim, workYesterday: await workForNight(userId, loaded.today, now) };
    const { today } = input;
    let cost = 0;
    // Stage 3 (ECOSYSTEM_V2_PLAN §4.3): with the loop on, the night reads the threads and may ask.
    const loopOn = (await prisma.buddyState.findUnique({ where: { userId }, select: { loop: true } }))?.loop === true;
    // Quiet noticed threads fade first, so the night never sees them as open (§4.12).
    if (loopOn) {
        await fadeQuietThreads(userId, now);
        // Stage 5b: an event whose day passed a week ago closes by itself ("it happened").
        await closePastEvents(userId, today, now);
        // Questions past their hours: passed or expired; two passed in a row make a thread quiet (§4.4).
        const { closeOldAsks } = await import('./asks');
        await closeOldAsks(userId, now);
    }
    const threads = loopOn ? await threadsForNight(userId, today, now) : null;
    // Stage 17: what is ahead (left off this week, dated to-dos of the next days), with the loop on.
    const ahead = loopOn ? await aheadBlocks(userId, now, input.tz) : null;
    const request = nightRequest({ ...input, loop: loopOn });
    // The first night back after the AI was paused (stage 4, §4.15): the days it could not listen.
    const deaf = await deafBlock(userId, input.tz, now);
    if (deaf) {
        const r = request as unknown as { messages: Array<{ content: Array<{ text: string }> }> };
        r.messages[0]!.content[0]!.text = r.messages[0]!.content[0]!.text.replace('Write tonight’s step.', `${deaf}\n\nWrite tonight’s step.`);
    }
    // MCP_MEMORY_PLAN §4.7: a catch-up since the last night: its dates, so six months of notes are not greeted as today's news.
    const { catchUpBlock } = await import('./catchup');
    const caught = await catchUpBlock(userId, now);
    if (caught) {
        const r = request as unknown as { messages: Array<{ content: Array<{ text: string }> }> };
        r.messages[0]!.content[0]!.text = r.messages[0]!.content[0]!.text.replace('Write tonight’s step.', `${caught}\n\nWrite tonight’s step.`);
    }
    if (threads) {
        withLoop(request, threads.block, { sunday: input.signals.today.isSunday });
        // Stage 5b (B): what they asked about when questions may come and what stays off their lock screen.
        const rules = await screenRulesBlock(userId);
        if (rules) {
            const r = request as unknown as { messages: Array<{ content: Array<{ text: string }> }> };
            r.messages[0]!.content[0]!.text = r.messages[0]!.content[0]!.text.replace('Write tonight’s step.', `${rules}\n\nWrite tonight’s step.`);
        }
        if (ahead?.text) {
            const r = request as unknown as { messages: Array<{ content: Array<{ text: string }> }> };
            r.messages[0]!.content[0]!.text = r.messages[0]!.content[0]!.text.replace('Write tonight’s step.', () => `${ahead.text}\n\nWrite tonight’s step.`);
        }
    }
    const message = await callClaude(userId, withRefusalFallbacks(request), 'buddy night');
    cost += (await recordAiUsage(userId, 'buddy_think', message)).costUsd;
    const raw = parseJson(responseText(message));
    const out = parseNight(raw);
    const extra = threads ? zLoopExtra.safeParse(raw) : null;

    // Ops: checked, then applied in one transaction.
    const all = await prisma.memory.findMany({ where: { userId, id: { in: [...new Set(out.memory.flatMap((o) => [o.id, ...o.ids]).filter(Boolean))] } }, select: { id: true, status: true, byUser: true } });
    const { valid, dropped } = checkOps(out.memory, { memories: new Map(all.map((m) => [m.id, m])), noteIds: new Set(input.notes.map((n) => n.id)) });
    const applied = await applyOps(userId, valid, today, now);
    // Every note it was given has been read (kept in a memory or judged not worth one).
    await prisma.observation.updateMany({ where: { userId, id: { in: input.notes.map((n) => n.id) }, foldedAt: null }, data: { foldedAt: now } });

    // The words it may use: numbers only from what it was given.
    const sources = [JSON.stringify(input.signals), ...input.memories.map((m) => m.text), ...input.notes.map((n) => n.text), ...input.candidates.map((c) => `${c.text} ${c.due ?? ''}`), ...input.hisNotes.map((n) => `${n.title} ${n.text}`), input.workYesterday?.text ?? '', ahead?.sources ?? ''].join('\n');
    const recent = input.said.filter((x) => x.what !== 'note').map((x) => x.text);
    // Stage 7: with the loop on the lines come with their own hours, 0 to 4 (an answer of slots still reads as slots).
    const timed = !!threads && out.lines.some(hasHours);
    const guarded = timed ? guardTimedLines(out.lines, { sources }) : guardLines(out.lines, { sources, recent });
    dropped.push(...guarded.dropped);
    let lines = guarded.lines;
    // With the loop on nothing is refused for having been said another day: relevance wins (his point 5).
    const insight = guardInsight(out.insight, { sources, recent: threads ? [] : recent, lines }, dropped);

    // The note, the follow-up and the portrait: lengths and numbers.
    const guardText = (text: string, max: number, what: string): string | null => {
        const t = unlabel(scrubSecrets(text).replace(/[ \t]+/g, ' ').trim());
        if (!t) return null;
        if (strayNumbers(t, sources).length) {
            dropped.push({ what, why: 'a number it was not given' });
            return null;
        }
        return clip(t, max);
    };
    const note = guardText(out.note, NOTE_MAX, 'note');
    const followUp = guardText(out.followUp, FOLLOW_UP_MAX, 'follow-up');
    const who = out.who.trim() ? guardText(capWords(out.who, WHO_WORDS), 1200, 'who') : null;
    const heading = out.heading.trim() ? guardText(capWords(out.heading, HEADING_WORDS), 800, 'heading') : null;
    const nowText = guardText(capWords(out.now, NOW_WORDS), 1200, 'now');

    // The lock check: a line marked lockOk is checked against his private memories, and the note
    // (for the phone's notification) always; a failed or missing check keeps them off the lock
    // screen (fail closed).
    // His work log counts as private here (B9): no work line ever reaches the lock screen.
    const privateTexts = input.memories.filter((m) => m.private).map((m) => m.text).concat(input.notes.filter((n) => n.private).map((n) => n.text), input.workYesterday?.lines ?? []);
    const checked = await lockCheck(userId, lines, privateTexts, { note, insight, asks: extra?.success ? extra.data.asks.map((a) => a.text) : [] }, dropped);
    lines = checked.lines;
    cost += checked.costUsd;

    // Stage 3: its questions (within the limits held by code), what each word rests on, its thread tidying.
    let insightAbout: About[] = [];
    let noteAbout: About[] = [];
    let insightRefs: string[] = [];
    let noteRefs: string[] = [];
    if (threads && extra?.success) {
        const loop = await withPersonLock(userId, (tx) =>
            applyLoopExtra(tx, userId, null, extra.data, lines, { now, tz: input.tz, today, revisions: threads.revisions, threadOps: true, askLockOk: checked.asksLockOk, refs: ahead?.refs ?? new Set() })
        );
        lines = lines.filter((l) => !loop.questionKeys.has(lineKey(l))).map((l) => withRefs({ ...l, about: loop.lineAbout.get(lineKey(l)) ?? [] }, loop.lineRefs.get(lineKey(l))));
        insightAbout = loop.insightAbout;
        noteAbout = loop.noteAbout;
        insightRefs = loop.insightRefs;
        noteRefs = loop.noteRefs;
        dropped.push(...loop.dropped);
        // Stage 17: never two days running about the same left-off item (a nudge, not a nag).
        const yesterday = await leftOffSaidYesterday(userId, today);
        const kept = lines.filter((l) => !(l.refs ?? []).some((r) => yesterday.has(r)));
        if (kept.length < lines.length) dropped.push({ what: 'line', why: 'two days running about a left-off item' });
        lines = kept;
    } else if (threads) dropped.push({ what: 'loop', why: 'the answer had no loop fields' });

    // The items it picked go to Suggested.
    const picked = out.suggestions.filter((id) => input.candidates.some((c) => c.id === id)).slice(0, SUGGEST_MAX);
    if (picked.length) await prisma.suggestion.updateMany({ where: { userId, id: { in: picked }, status: 'candidate' }, data: { status: 'pending', expiresDay: toDbDay(addDays(today, 7)) } });

    // Sunday: the week's coach note, in the coach's own table and shape (Home's card reads it).
    if (input.signals.today.isSunday && out.weekly.use) {
        const w = out.weekly;
        const lineOk = (t: string) => t.trim() && !strayNumbers(t, sources).length;
        if ([w.strong, w.slipping, w.fix, w.deadline].every(lineOk) && w.focus.length === 3 && w.focus.every(lineOk)) {
            const window = coachWindow(today);
            await prisma.coachNote.create({
                data: {
                    userId,
                    weekStart: toDbDay(window.weekStart),
                    weekEnd: toDbDay(window.weekEnd),
                    lines: { strong: clip(w.strong, 220), slipping: clip(w.slipping, 220), fix: clip(w.fix, 220), deadline: clip(w.deadline, 220) },
                    focus: w.focus.map((f) => clip(f, 140)),
                    model: message.model.slice(0, 100),
                },
            });
        } else {
            dropped.push({ what: 'weekly', why: 'a line failed the checks' });
        }
    }

    await prisma.buddyState.update({
        where: { userId },
        data: {
            ...(who ? { who } : {}),
            ...(heading ? { heading } : {}),
            ...(nowText ? { now: nowText } : {}),
            ...(out.notebook.trim() ? { notebook: clip(scrubSecrets(out.notebook.trim()), NOTEBOOK_MAX) } : {}),
            lastStepAt: now,
        },
    });
    const row = await prisma.buddyDay.create({
        data: {
            userId,
            // His buddy day: a step run before 04:00 (his button) belongs to the day still going.
            day: toDbDay(buddyDayOf(today, Number(new Intl.DateTimeFormat('en-GB', { timeZone: input.tz, hour: '2-digit', hour12: false }).format(now)) % 24)),
            kind: 'night',
            lines: lines as unknown as Prisma.InputJsonValue,
            insight,
            insightLockOk: checked.insightLockOk,
            note,
            noteLockOk: checked.noteLockOk,
            followUp,
            ...(threads ? { insightAbout: aboutJson(insightAbout, insightRefs), noteAbout: aboutJson(noteAbout, noteRefs) } : {}),
            ops: applied as unknown as Prisma.InputJsonValue,
            dropped: dropped as unknown as Prisma.InputJsonValue,
            model: message.model.slice(0, 100),
            costUsd: cost.toFixed(6),
            createdAt: now,
        },
    });
    // The questions this step wrote (inside the lock, before the row existed) name it.
    if (threads) await prisma.buddyAsk.updateMany({ where: { userId, buddyDayId: null, createdAt: now }, data: { buddyDayId: row.id } });
    await fadeMemories(userId, today);
    return { _id: row.id, day: today, kind: 'night', lines, insight, note, followUp, ops: applied.length, dropped, costUsd: Math.round(cost * 1e4) / 1e4 };
}

/**
 * A pause of the AI that ended lately (stage 4, hold and replay): which days the buddy could not listen,
 * how many messages it dropped meanwhile, and that silence in those days is not news. Null otherwise.
 */
export async function deafBlock(userId: string, tz: string, now: Date): Promise<string | null> {
    const { recentPause } = await import('../claude/access');
    const pause = await recentPause(userId, now);
    if (!pause) return null;
    const from = dayOf(pause.from, tz);
    const to = dayOf(pause.to, tz);
    const days = await prisma.buddyCaptureDay.findMany({ where: { userId, day: { gte: toDbDay(from), lte: toDbDay(to) } }, select: { dropped: true } });
    const dropped = days.reduce((n, d) => n + d.dropped, 0);
    return `<could_not_listen>From ${from} to ${to} the AI was paused, so the buddy could not listen.${dropped ? ` ${dropped} messages were dropped.` : ''} Words held on their computer arrived late, with their own dates. Do not read their silence in those days as news, and do not say they were quiet.</could_not_listen>`;
}

// ─── Fading and pruning (code, never the model: §3.7) ──────────────────────

const STATE_QUIET_DAYS = 14;
const THREAD_QUIET_DAYS = 45;
const NOTES_KEEP_DAYS = 180;
const DAYS_KEEP = 400;
const KIND_WEIGHT: Partial<Record<MemoryKind, number>> = { pattern: 1.2, thread: 1, state: 0.8, win: 0.7 };

/** States quiet for 14 days and threads for 45 fade; past 120 working memories, the lowest scored fade. Never lasting, pinned or his own. */
export async function fadeMemories(userId: string, today: DayString): Promise<number> {
    // A working memory seen in three different months is lasting now (§3.2): never faded by time again.
    const recurring = await prisma.memory.findMany({ where: { userId, status: 'active', lasting: false }, select: { id: true, monthsSeen: true } });
    const promote = recurring.filter((m) => new Set(m.monthsSeen).size >= 3).map((m) => m.id);
    if (promote.length) await prisma.memory.updateMany({ where: { id: { in: promote } }, data: { lasting: true } });
    const keep = { lasting: false, pinned: false, byUser: false } as const;
    const a = await prisma.memory.updateMany({ where: { userId, status: 'active', kind: 'state', lastSeenDay: { lt: toDbDay(addDays(today, -STATE_QUIET_DAYS)) }, ...keep }, data: { status: 'faded' } });
    const b = await prisma.memory.updateMany({ where: { userId, status: 'active', kind: 'thread', lastSeenDay: { lt: toDbDay(addDays(today, -THREAD_QUIET_DAYS)) }, ...keep }, data: { status: 'faded' } });
    const working = await prisma.memory.findMany({ where: { userId, status: 'active', ...keep }, select: { id: true, kind: true, seenCount: true, lastSeenDay: true } });
    let c = 0;
    if (working.length > WORKING_MAX) {
        const t = Date.parse(`${today}T00:00:00Z`);
        const score = (m: (typeof working)[number]) => (KIND_WEIGHT[m.kind] ?? 1) * Math.log(1 + m.seenCount) * Math.pow(0.5, (t - m.lastSeenDay.getTime()) / 86_400_000 / 60);
        const out = [...working].sort((x, y) => score(x) - score(y)).slice(0, working.length - WORKING_MAX);
        c = (await prisma.memory.updateMany({ where: { id: { in: out.map((m) => m.id) } }, data: { status: 'faded' } })).count;
    }
    await prisma.observation.deleteMany({ where: { userId, foldedAt: { lt: new Date(t0(today) - NOTES_KEEP_DAYS * 86_400_000) } } });
    await prisma.buddyDay.deleteMany({ where: { userId, day: { lt: toDbDay(addDays(today, -DAYS_KEEP)) } } });
    return a.count + b.count + c;
}

const t0 = (day: DayString) => Date.parse(`${day}T00:00:00Z`);
