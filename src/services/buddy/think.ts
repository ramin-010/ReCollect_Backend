// The night step (BUDDY_MEMORY_PLAN §3.3): once per local day, after 04:00, Opus 5.5 reads the signals,
// the portrait, every lasting memory and the working ones, the notes no step has read yet, the
// buddy's items waiting, his notebook and what it said lately, and writes memory changes, the
// portrait, three lines for the day, a note (or its silence), a follow-up for his next chat, which
// items to show, its notebook, and on Sundays the week's coach note. Code checks every op and every
// line before anything is written; a line that fails a guard becomes the plain line from today's counts.
import type { Memory, MemoryKind, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { callClaude } from '../claude/client';
import { recordAiUsage } from '../claude/usage.service';
import { parseJson, responseText } from '../recall/output';
import { withRefusalFallbacks, type CreateParams } from '../recall/prompts';
import { addDays, type DayString } from '../learning';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { coachWindow } from '../coach/evidence';
import { numbersIn } from '../coach/check';
import { characterPrompt } from './character';
import { LASTING_KINDS, MEMORY_KINDS, cleanNoteText, memoryKey, normalizeTags } from './memory.service';
import { buddySignals, plainLine, type BuddySignals } from './signals';
import { scrubSecrets } from './scrub';
import { buddyDayOf } from './voice';
import { runRoutines } from './routines';

export const THINK_MODEL = process.env['BUDDY_THINK_MODEL'] || 'claude-opus-5-5';
// The lock check decides what strangers may read on his phone: Sonnet 5.5 (Ramin 11-16: "that check is crucial"; a few calls a day).
export const CHECK_MODEL = process.env['BUDDY_CHECK_MODEL'] || 'claude-sonnet-5-5';
const EPHEMERAL = { type: 'ephemeral' } as const;
export const SLOTS = ['morning', 'afternoon', 'evening'] as const;
export type Slot = (typeof SLOTS)[number];
export const FORMS = ['observation', 'question', 'push', 'celebration', 'from_your_notes', 'plain'] as const;
const OPS = ['add', 'seen', 'update', 'merge', 'close'] as const;

/** The ceilings of what the night reads (§3.7): the cost of a day stays flat over the years. */
export const LASTING_MAX = 100;
export const WORKING_MAX = 120;
export const NOTES_MAX = 80;
const CANDIDATES_MAX = 20;
const SAID_DAYS = 14;
export const LINE_MAX = 90;
const NOTE_MAX = 600;
const FOLLOW_UP_MAX = 200;
const NOTEBOOK_MAX = 1500;
const WHO_WORDS = 120;
const HEADING_WORDS = 80;
const NOW_WORDS = 120;
const SUGGEST_MAX = 3;

// ─── The request ───────────────────────────────────────────────────────────

const NIGHT_JOB = `Tonight you think about his day and answer with one JSON object:
- memory: changes to what you know about him.
  add: a memory from new notes worth keeping (kind; lasting true for fact, preference, value, aim, idea, decision, false for pattern, state, thread, win unless meant for years; private for health, money, family, other people, guilt, fear, work conflicts, leaving his job; from = the note ids).
  seen: a note repeats a memory (id, from). update: sharpen or correct one (id, text, from). merge: two or more say the same thing (ids, the merged text, kind). close: no longer true (id, reason).
  Memories marked "his own" are his: never update, merge or close them. Leave out notes not worth a memory. Keep memories short, specific, in the third person. Unused fields: "" or [] or false.
- who (at most ${WHO_WORDS} words) and heading (at most ${HEADING_WORDS} words): rewrite only when a lasting memory changed tonight or none exists yet; else "".
- now (at most ${NOW_WORDS} words): this week in his life: what he is on, what weighs on him, what is going well.
- lines: exactly three, slot morning, afternoon, evening: what his phone and Home show at those hours. Each at most ${LINE_MAX} characters, one thought, said the way a friend would text it (no label in front). lockOk: true only if a stranger may read it. sourceId: the memory or note id it rests on, or "".
- note: a few sentences to him, like a message from a friend: natural and casual, straight to the point, no greeting or sign-off, no headings; or "" when there is nothing worth saying.
- followUp: one question for his next chat with an agent, or "".
- suggestions: up to ${SUGGEST_MAX} candidate ids worth showing him now (the most useful, due soonest).
- notebook (at most ${NOTEBOOK_MAX} characters), for tomorrow night: what you watch, what you said tonight, what landed.
- weekly: on Sundays only (use true): the week's coach note: strong, slipping, fix, deadline (a sentence or two each, at most 220 characters) and exactly 3 focus lines (at most 140 characters) for the days ahead. Other days: use false, the rest empty.`;

const str = { type: 'string' } as const;
export const NIGHT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['memory', 'who', 'heading', 'now', 'lines', 'note', 'followUp', 'suggestions', 'notebook', 'weekly'],
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
    tone: 'candid' | 'gentle';
    signals: BuddySignals;
    portrait: { who: string | null; heading: string | null; now: string | null };
    memories: NightMemoryRow[];
    notes: Array<{ id: string; kind: MemoryKind; private: boolean; source: string; text: string }>;
    candidates: Array<{ id: string; kind: string; text: string; due: string | null }>;
    hisNotes: Array<{ title: string; text: string }>;
    notebook: string | null;
    said: Array<{ day: string; what: string; text: string }>;
    timezone: string;
    /** What his routines did by themselves just now (B6): the note names them. */
    doneForHim?: string[];
    /** Open threads quiet for five weeks or more, about to fade: the night may ask about one once. */
    quietThreads?: string[];
}

export function nightTask(input: NightInput): string {
    const s = input.signals;
    const mem = (m: NightMemoryRow) =>
        `${m.id} · ${m.kind} · ${m.lasting ? 'lasting' : 'working'} · ${m.private ? 'private' : 'open'}${m.byUser ? " · his own" : ''} · seen ${m.seenCount} · last ${m.lastSeenDay} · ${m.text}`;
    return [
        `<today>${s.today.weekday} ${s.today.day}, ${s.today.time} (${input.timezone})${s.today.isSunday ? ' · Sunday: write the weekly note' : ''}</today>`,
        `<signals>\n${JSON.stringify(s)}\n</signals>`,
        `<portrait>\nwho: ${input.portrait.who ?? 'not written yet'}\nheading: ${input.portrait.heading ?? 'not written yet'}\nnow: ${input.portrait.now ?? 'not written yet'}\n</portrait>`,
        `<memories>\n${input.memories.map(mem).join('\n') || 'none yet'}\n</memories>`,
        `<new_notes>\n${input.notes.map((n) => `${n.id} · ${n.kind} · ${n.private ? 'private' : 'open'} · from ${n.source} · ${n.text}`).join('\n') || 'none'}\n</new_notes>`,
        `<candidates>\n${input.candidates.map((c) => `${c.id} · ${c.kind} · ${c.text}${c.due ? ` · due ${c.due}` : ''}`).join('\n') || 'none'}\n</candidates>`,
        `<his_notes>\n${input.hisNotes.map((n) => `"${n.title}": ${n.text}`).join('\n') || 'none'}\n</his_notes>`,
        `<notebook>\n${input.notebook ?? 'empty: this is your first night'}\n</notebook>`,
        `<said>\n${input.said.map((x) => `${x.day} ${x.what}: ${x.text}`).join('\n') || 'nothing yet'}\n</said>`,
        ...(input.quietThreads?.length
            ? [`<quiet_threads>\n${input.quietThreads.join('\n')}\nThese open threads have been quiet for over five weeks and fade within a week. If one still matters, ask him about it once, in followUp ("still on?"); else let it go.\n</quiet_threads>`]
            : []),
        ...(input.doneForHim?.length ? [`<done_for_him>\nBy his standing yes you just: ${input.doneForHim.join('; ')}. Name it in the note.\n</done_for_him>`] : []),
        'Write tonight’s step.',
    ].join('\n\n');
}

export function nightRequest(input: NightInput): CreateParams {
    return {
        model: THINK_MODEL,
        max_tokens: 16_000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: NIGHT_SCHEMA } },
        system: [{ type: 'text', text: `${characterPrompt({ name: input.name, tone: input.tone })}\n\n${NIGHT_JOB}`, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: [{ type: 'text', text: nightTask(input) }] }],
    } as CreateParams;
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
    lines: z.array(z.object({ slot: z.enum(SLOTS), text: z.string(), form: z.enum(FORMS), lockOk: z.boolean(), sourceId: z.string() })),
    note: z.string(),
    followUp: z.string(),
    suggestions: z.array(z.string()),
    notebook: z.string(),
    weekly: z.object({ use: z.boolean(), strong: z.string(), slipping: z.string(), fix: z.string(), deadline: z.string(), focus: z.array(z.string()) }),
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
            else if (his(op.id)) why = 'update: his own memory';
            else if (!text && op.tags.length === 0) why = 'update: nothing to change';
        } else if (op.op === 'merge') {
            const ids = [...new Set(op.ids)];
            if (ids.length < 2 || !ids.every(usable)) why = 'merge: needs two of his memories';
            else if (ids.some(his)) why = 'merge: one is his own';
            else if (!text || !op.kind) why = 'merge: needs the merged text and kind';
        } else if (op.op === 'close') {
            if (!usable(op.id)) why = 'close: no such memory';
            else if (his(op.id)) why = 'close: his own memory';
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

/** Numbers the text holds that its sources don't. */
export function strayNumbers(text: string, sources: string): string[] {
    const allowed = new Set(numbersIn(sources));
    return [...new Set(numbersIn(text).filter((n) => !allowed.has(n)))];
}

export interface Line {
    slot: Slot;
    text: string;
    form: string;
    lockOk: boolean;
    sourceId: string | null;
    /** Written by code (a guard threw the model's line out, or there was none). */
    fallback?: true;
}

/** Lengths, numbers, repeats: a line that fails becomes the plain line (never on the lock screen it fails for). */
/**
 * A label in front ("From your notes: …", "Reminder - …", "Tip: …") comes off: the buddy talks, it doesn't
 * file things (Ramin 11-16). The words after it stay, their first letter raised.
 */
export function unlabel(text: string): string {
    const t = text.replace(/^\s*(?:from (?:your |his )?(?:saved )?notes?|from your buddy|reminder|quick reminder|note|quick note|tip|today|tonight|heads[ -]?up|fyi|psst|ps)\s*[:\-\u2013\u2014]\s+/i, '');
    return t === text ? text : t.charAt(0).toUpperCase() + t.slice(1);
}

export function guardLines(lines: NightOutput['lines'], ctx: { sources: string; recent: readonly string[]; plain: string }): { lines: Line[]; dropped: Dropped[] } {
    const dropped: Dropped[] = [];
    const out: Line[] = SLOTS.map((slot) => {
        const l = lines.find((x) => x.slot === slot);
        const text = l ? unlabel(scrubSecrets(l.text).replace(/\s+/g, ' ').trim()) : '';
        let why: string | null = null;
        if (!l || !text) why = 'missing';
        else if (text.length > LINE_MAX) why = 'too long';
        else if (strayNumbers(text, ctx.sources).length) why = 'a number it was not given';
        else if (ctx.recent.some((r) => tooClose(r, text))) why = 'said lately';
        if (why) {
            dropped.push({ what: `line ${slot}`, why });
            return { slot, text: ctx.plain, form: 'plain', lockOk: true, sourceId: null, fallback: true };
        }
        return { slot, text, form: l!.form, lockOk: l!.lockOk, sourceId: l!.sourceId || null };
    });
    return { lines: out, dropped };
}

export const LOCK_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['lines', 'note'],
    properties: {
        lines: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['slot', 'reveals'], properties: { slot: { type: 'string', enum: [...SLOTS] }, reveals: { type: 'boolean' } } },
        },
        /** The note, as a phone notification (the lock screen shows those too): true when it reveals. */
        note: { type: 'boolean' },
    },
};

const LOCK_SYSTEM = `A line will show on a person's phone lock screen, where anyone nearby can read it. You get the person's private facts and the lines. For each line answer reveals: true when a stranger reading only the line would learn one of those private facts, or anything about health, money, family, other people, guilt, fear, conflicts at work or leaving a job. A line may be shaped by a private fact as long as it does not name it. When unsure, answer true.
The note (a few sentences) may show the same way, as a phone notification on the lock screen. Answer note with the same test for the whole note: true when it reveals any of that (or when there is no note).`;

/** The lock check for the lines (and the note, when there is one): Haiku, structured, fail closed by the caller. */
export function lockRequest(lines: readonly Line[], privateTexts: readonly string[], note: string | null = null): CreateParams {
    return {
        model: CHECK_MODEL,
        // The model thinks by default (adaptive): low effort, and room for it (400 cut the answer off
        // once the note joined the check, 11-16; a cut answer fails closed).
        max_tokens: 4000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: LOCK_SCHEMA } },
        system: [{ type: 'text', text: LOCK_SYSTEM }],
        messages: [
            {
                role: 'user',
                content: [{ type: 'text', text: `<private>\n${privateTexts.join('\n') || '(none)'}\n</private>\n<lines>\n${lines.map((l) => `${l.slot}: ${l.text}`).join('\n') || '(none)'}\n</lines>\n<note>\n${note ?? '(none)'}\n</note>` }],
            },
        ],
    } as CreateParams;
}

/** `note` is optional for an older answer: a missing verdict keeps the note's words out of notifications. */
export const zLock = z.object({ lines: z.array(z.object({ slot: z.enum(SLOTS), reveals: z.boolean() })), note: z.boolean().optional() });

/**
 * The lock check of a step (the night and the pulses): the lines marked lockOk, when there are private
 * things to check them against (otherwise their own lockOk stands), and the note always (it may show in
 * the phone's notification). A failed check keeps every checked line and the note off the lock screen.
 * `only`: the slots this step wrote (a pulse); the others keep what they had.
 */
export async function lockCheck(
    userId: string,
    lines: Line[],
    privateTexts: readonly string[],
    note: string | null,
    dropped: Dropped[],
    only: readonly Slot[] = SLOTS
): Promise<{ lines: Line[]; noteLockOk: boolean; costUsd: number }> {
    const toCheck = privateTexts.length ? lines.filter((l) => only.includes(l.slot) && l.lockOk && !l.fallback) : [];
    if (!toCheck.length && !note) return { lines, noteLockOk: false, costUsd: 0 };
    let costUsd = 0;
    try {
        const check = await callClaude(lockRequest(toCheck, privateTexts.slice(0, 60), note), 'buddy lock check');
        costUsd = (await recordAiUsage(userId, 'buddy_check', check)).costUsd;
        const verdict = zLock.parse(parseJson(responseText(check)));
        const out = lines.map((l) => {
            if (!toCheck.includes(l)) return l;
            const v = verdict.lines.find((x) => x.slot === l.slot);
            if (v && !v.reveals) return l;
            dropped.push({ what: `lock ${l.slot}`, why: v ? 'names a private thing' : 'not checked' });
            return { ...l, lockOk: false };
        });
        return { lines: out, noteLockOk: !!note && verdict.note === false, costUsd };
    } catch (err) {
        // The reason in the log (never his words): a failed check is otherwise silent.
        console.warn(`[buddy] lock check failed: ${err instanceof Error ? err.message : String(err)}`);
        if (toCheck.length) dropped.push({ what: 'lock check', why: 'failed: no line on the lock screen today' });
        return { lines: lines.map((l) => (toCheck.includes(l) ? { ...l, lockOk: false } : l)), noteLockOk: false, costUsd };
    }
}

// ─── The step ──────────────────────────────────────────────────────────────

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);
const capWords = (t: string, max: number) => (words(t) > max ? `${t.split(/\s+/).slice(0, max).join(' ')}…` : t);

/** Everything the night reads, within its ceilings. */
export async function loadNightInput(userId: string, now: Date): Promise<NightInput & { tz: string; today: DayString }> {
    const ctx = await loadLearningContext(userId, now);
    const [state, lasting, working, notes, candidates, captures, recent, thumbs] = await Promise.all([
        prisma.buddyState.findUnique({ where: { userId } }),
        prisma.memory.findMany({ where: { userId, status: 'active', lasting: true }, orderBy: [{ pinned: 'desc' }, { lastSeenDay: 'desc' }], take: LASTING_MAX }),
        prisma.memory.findMany({ where: { userId, status: 'active', lasting: false }, orderBy: [{ lastSeenDay: 'desc' }], take: WORKING_MAX }),
        prisma.observation.findMany({ where: { userId, foldedAt: null, memoryId: null }, orderBy: [{ sensitivity: 'desc' }, { createdAt: 'desc' }], take: NOTES_MAX }),
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
        return t ? (t.verdict === 'more' ? ' (he liked this: more like it)' : ' (he said: not this)') : '';
    };
    for (const d of recent) {
        for (const l of (Array.isArray(d.lines) ? d.lines : []) as unknown as Line[]) if (!l.fallback) said.push({ day: fromDbDay(d.day), what: l.slot, text: `${l.text}${thumb(d.id, l.slot)}` });
        if (d.note) said.push({ day: fromDbDay(d.day), what: 'note', text: `${clip(d.note, 200)}${thumb(d.id, 'note')}` });
    }
    const row = (m: Memory): NightMemoryRow => ({ id: m.id, kind: m.kind, lasting: m.lasting, private: m.sensitivity === 'private', byUser: m.byUser, seenCount: m.seenCount, lastSeenDay: fromDbDay(m.lastSeenDay), text: m.text });
    return {
        name: state?.name ?? null,
        tone: state?.tone === 'gentle' ? 'gentle' : 'candid',
        signals,
        portrait: { who: state?.who ?? null, heading: state?.heading ?? null, now: state?.now ?? null },
        memories: [...lasting, ...working].map(row),
        notes: notes.map((n) => ({ id: n.id, kind: n.kind, private: n.sensitivity === 'private', source: n.source, text: n.text })),
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
    lines: Line[];
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
    const input = { ...(await loadNightInput(userId, now)), doneForHim };
    const { today } = input;
    let cost = 0;
    const message = await callClaude(withRefusalFallbacks(nightRequest(input)), 'buddy night');
    cost += (await recordAiUsage(userId, 'buddy_think', message)).costUsd;
    const out = parseNight(parseJson(responseText(message)));

    // Ops: checked, then applied in one transaction.
    const all = await prisma.memory.findMany({ where: { userId, id: { in: [...new Set(out.memory.flatMap((o) => [o.id, ...o.ids]).filter(Boolean))] } }, select: { id: true, status: true, byUser: true } });
    const { valid, dropped } = checkOps(out.memory, { memories: new Map(all.map((m) => [m.id, m])), noteIds: new Set(input.notes.map((n) => n.id)) });
    const applied = await applyOps(userId, valid, today, now);
    // Every note it was given has been read (kept in a memory or judged not worth one).
    await prisma.observation.updateMany({ where: { userId, id: { in: input.notes.map((n) => n.id) }, foldedAt: null }, data: { foldedAt: now } });

    // The words it may use: numbers only from what it was given.
    const sources = [JSON.stringify(input.signals), ...input.memories.map((m) => m.text), ...input.notes.map((n) => n.text), ...input.candidates.map((c) => `${c.text} ${c.due ?? ''}`), ...input.hisNotes.map((n) => `${n.title} ${n.text}`)].join('\n');
    const recent = input.said.filter((x) => x.what !== 'note').map((x) => x.text);
    const guarded = guardLines(out.lines, { sources, recent, plain: plainLine(input.signals) });
    dropped.push(...guarded.dropped);
    let lines = guarded.lines;

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
    const privateTexts = input.memories.filter((m) => m.private).map((m) => m.text).concat(input.notes.filter((n) => n.private).map((n) => n.text));
    const checked = await lockCheck(userId, lines, privateTexts, note, dropped);
    lines = checked.lines;
    cost += checked.costUsd;

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
            note,
            noteLockOk: checked.noteLockOk,
            followUp,
            ops: applied as unknown as Prisma.InputJsonValue,
            dropped: dropped as unknown as Prisma.InputJsonValue,
            model: message.model.slice(0, 100),
            costUsd: cost.toFixed(6),
            createdAt: now,
        },
    });
    await fadeMemories(userId, today);
    return { _id: row.id, day: today, kind: 'night', lines, note, followUp, ops: applied.length, dropped, costUsd: Math.round(cost * 1e4) / 1e4 };
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
