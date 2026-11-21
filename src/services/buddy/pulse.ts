// The pulses (BUDDY_MEMORY_PLAN §3.3): at 12:00 and 18:00 his time, a lighter step (Sonnet 5.5, low
// effort) may rewrite the lines still to come (or leave those hours silent), add a note and a new
// thought for his home screen, when something new arrived since the last step (notes from his chats,
// his own words, his thumbs). Nothing new: no model call. The night's lines for the hours gone stay;
// the note, the thought and the follow-up carry over unless the pulse writes new ones.
// Stage 5 (ECOSYSTEM_V2_PLAN §4.3, §4.13), with the loop on: also a pulse on an event, when a thread changed
// in a way that matters today (he answered a question, he changed a plan, a new word on a thread today's
// words rest on), 3 minutes after the last such event (a burst makes one), 30 after the step before it, at
// most 4 a day. Used up: nothing new is written until the next fixed step (withdrawal goes on: it is code),
// and the skipped pulse is counted for the usage view.
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { callClaude } from '../claude/client';
import { recordAiUsage } from '../claude/usage.service';
import { parseJson, responseText } from '../recall/output';
import { withRefusalFallbacks, type CreateParams } from '../recall/prompts';
import { loadLearningContext, toDbDay } from '../learningDb/common';
import type { DayString } from '../learning';
import { characterPrompt } from './character';
import { personName, toneOf } from './state.service';
import { buddySignals } from './signals';
import { scrubSecrets } from './scrub';
import { stillTrue } from './asks';
import { OLD_NEWS_MS, parseAbout, weighs, whoseWord, withPersonLock, type About } from './threads';
import { NIGHT_LOOP_JOB, applyLoopExtra, loopSchema, threadsForNight, zLoopExtra } from './nightLoop';
import { screenRulesBlock } from './screens';
import { FORMS, INSIGHT_MAX, LINE_MAX, SLOTS, oldNote, guardInsight, guardLines, guardTimedLines, lockCheck, strayNumbers, unlabel, withRefs, type Dropped, type Line, type Slot } from './think';
import { aboutJson, aheadBlocks, leftOffSaidYesterday } from './aheadBlocks';
import { refsSince } from './voice';
import { LINES_MAX, LINE_MIN_MINUTES, clockOf, hasHours, instantOf, lineKey, lineLabel, lineWindow, minuteOf } from './lineTimes';

export const PULSE_MODEL = process.env['BUDDY_PULSE_MODEL'] || 'claude-sonnet-5-5';
const EPHEMERAL = { type: 'ephemeral' } as const;

export const PULSE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['lines', 'note', 'insight'],
    properties: {
        lines: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['slot', 'text', 'form', 'lockOk', 'sourceId'],
                properties: { slot: { type: 'string', enum: [...SLOTS] }, text: { type: 'string' }, form: { type: 'string', enum: [...FORMS] }, lockOk: { type: 'boolean' }, sourceId: { type: 'string' } },
            },
        },
        note: { type: 'string' },
        insight: { type: 'string' },
    },
};

const PULSE_JOB = `It is the middle of their day. Something new arrived since you last thought (below). Answer only the slots you are given (the hours still to come): for each, its line (the same words to keep the one it has) or "" for silence in those hours (their lock screen then shows the day's dial: what is left and what is scheduled today; never a line that only restates those). A line: at most ${LINE_MAX} characters, one thought, said the way a friend would text it (no label in front), lockOk true only if a stranger may read it. note: a few casual sentences, like a friend's message, only if the new things truly call for one now, else "". insight: a new thought for their home screen (at most ${INSIGHT_MAX} characters, fit for anyone to read) only if the new things call for one, else "" to keep the one it has. Never repeat what you already said today.`;

/** With the loop on (stage 7, V1): the day's lines have their own hours, and a pulse answers every line from now on. */
const PULSE_TIMED_JOB = `It is the middle of their day. Something new arrived since you last thought (below). When their words today change the day (a plan for tonight, no time, worn out, ill), make the lines from now on fit it: name tonight's plan before its hour, drop a push that no longer fits, or say nothing. A hard day needs less from you, not more. <your_lines> holds today's lines for their lock screen with their hours. lines: every line from now on. To keep one, give it again unchanged; change its words or its hours; leave one out to end it; or add one. The lines whose hours are over stay as they were. At most ${LINES_MAX} lines in the whole day, those over included. Between lines their lock screen shows the day's dial (what is left and what is scheduled today), so never a line that only restates those. A line: from and until (HH:mm, their time; their day runs to 04:00), at least ${LINE_MIN_MINUTES} minutes, never overlapping another; at most ${LINE_MAX} characters, one thought, said the way a friend would text it (no label in front); lockOk true only if a stranger may read it. note: a few casual sentences, like a friend's message, only if the new things truly call for one now, else "". insight: a new thought for their home screen (at most ${INSIGHT_MAX} characters, fit for anyone to read) only if the new things call for one, else "" to keep the one it has. Never say again in new words what you already said today.`;

// A line names its part of the day, or with the loop on (stage 7) its own hours.
const zPulse = z.object({ lines: z.array(z.object({ slot: z.enum(SLOTS).optional(), from: z.string().optional(), until: z.string().optional(), text: z.string(), form: z.enum(FORMS), lockOk: z.boolean(), sourceId: z.string() })), note: z.string(), insight: z.string().default('') });

const hourIn = (tz: string, at: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(at)) % 24;

/** The hours a pulse may run, his time: 12:00 (the afternoon and evening lines) and 18:00 (the evening's). */
export const PULSE_HOURS = [12, 18] as const;

/** Stage 5 (§4.13): at most this many pulses on events a day, besides the two fixed ones. */
export const EVENT_PULSES_MAX = 4;
/** A pulse on an event waits this long after the last such event (a burst makes one pulse)... */
export const EVENT_SETTLE_MS = 3 * 60_000;
/** ...and this long after the step before it. */
export const EVENT_GAP_MS = 30 * 60_000;

type StepRow = Awaited<ReturnType<typeof prisma.buddyDay.findMany>>[number];
/** A change on a thread that matters today, as the pulse reads it. */
export interface PulseEvent {
    id: string;
    threadId: string;
    title: string;
    kind: string;
    text: string;
    via: string;
    direct: boolean;
    receivedAt: Date;
}
export type PulseDue =
    /** `at`: when a pulse on an event falls due; `skip`: one is due but the day's are used up (count it). */
    | { due: false; reason: string; at?: Date; skip?: DayString }
    | {
          due: true;
          /** A pulse on an event (not one of the fixed pulses). */
          onEvent: boolean;
          ctx: Awaited<ReturnType<typeof loadLearningContext>>;
          steps: StepRow[];
          slots: Slot[];
          last: StepRow;
          notes: Awaited<ReturnType<typeof prisma.observation.findMany>>;
          thumbs: Awaited<ReturnType<typeof prisma.buddyFeedback.findMany>>;
          events: PulseEvent[];
          /** Stage 18: their own words today that changed the day (why this pulse runs), when they did. */
          todayWords?: string;
          /** 11-21: a Later tapped since the last step that comes back today (why this pulse runs): what, and when. */
          laterBack?: { text: string; at: Date };
      };

/** The slots still to come from this hour, the one now included. */
const slotsFrom = (hour: number): Slot[] => (hour >= 18 || hour < 4 ? ['evening'] : hour >= 12 ? ['afternoon', 'evening'] : ['morning', 'afternoon', 'evening']);

/**
 * What changed on his threads since `since` in a way that matters today (§4.3): an answer to a question, a
 * plan he changed in his own words, or any new word about a thread today's words rest on (it withdrew them:
 * a line, the thought, the note or an open question). A duplicate never counts.
 */
async function eventsThatMatter(userId: string, steps: StepRow[], since: Date): Promise<PulseEvent[]> {
    const last = steps[steps.length - 1]!;
    const lines = (Array.isArray(last.lines) ? last.lines : []) as unknown as Line[];
    const resting = new Set<string>([...lines.flatMap((l) => (l.about ?? []).map((a) => a.threadId)), ...parseAbout(last.insightAbout).map((a) => a.threadId), ...parseAbout(last.noteAbout).map((a) => a.threadId)]);
    const [asks, events] = await Promise.all([
        prisma.buddyAsk.findMany({ where: { userId, state: 'open', buddyDayId: { in: steps.map((s) => s.id) }, threadId: { not: null } }, select: { threadId: true } }),
        prisma.buddyThreadEvent.findMany({
            where: { userId, receivedAt: { gt: since }, duplicate: false },
            orderBy: { receivedAt: 'asc' },
            take: 50,
            select: { id: true, threadId: true, kind: true, text: true, via: true, direct: true, basis: true, saidAt: true, receivedAt: true, thread: { select: { title: true } } },
        }),
    ]);
    for (const a of asks) if (a.threadId) resting.add(a.threadId);
    // Old news (an import, or words said over 48 hours before they arrived) builds history only: never a pulse.
    // The week's simulation (11-18) saw a September chat brought in from an export start a pulse that told him
    // to stop running until he saw a doctor.
    const fresh = events.filter((e) => e.via !== 'import' && e.via !== 'catchup' && e.receivedAt.getTime() - e.saidAt.getTime() <= OLD_NEWS_MS);
    // A said change from a connected assistant fires as their own does (MCP_MEMORY_PLAN §4.4); an inference never.
    return fresh
        .filter((e) => e.basis !== 'inferred' && (e.via === 'answer' || (e.kind === 'changed' && weighs(e)) || resting.has(e.threadId)))
        .map(({ thread, saidAt: _said, ...e }) => ({ ...e, title: thread.title }));
}

/**
 * Whether a pulse is due for this user now: a fixed one (noon or later, a night today, a slot not pulsed yet,
 * something new since), or with the loop on one on an event (§4.13). A fixed pulse due takes precedence: it
 * reads the threads too.
 */
export async function pulseDue(userId: string, now: Date = new Date()): Promise<PulseDue> {
    const ctx = await loadLearningContext(userId, now);
    const hour = hourIn(ctx.tz, now);
    // Stage 5: with the loop on, a pulse may come on an event at any hour of the day.
    const loop = (await prisma.buddyState.findUnique({ where: { userId }, select: { loop: true } }))?.loop === true;
    if (hour < PULSE_HOURS[0] && !loop) return { due: false, reason: 'not yet noon' };
    const steps = await prisma.buddyDay.findMany({ where: { userId, day: toDbDay(ctx.today) }, orderBy: { createdAt: 'asc' } });
    const night = steps.find((s) => s.kind === 'night');
    if (!night) return { due: false, reason: 'no night today' };
    const last = steps[steps.length - 1]!;
    const newSince = (at: Date) =>
        Promise.all([
            // An import's notes are old news (history for the night), never a reason for a pulse or its news.
            prisma.observation.findMany({ where: { userId, createdAt: { gt: at }, OR: [{ via: null }, { via: { not: 'import' } }] }, orderBy: { createdAt: 'desc' }, take: 30 }),
            prisma.buddyFeedback.findMany({ where: { userId, createdAt: { gt: at } } }),
        ]);

    let reason = 'not yet noon';
    if (hour >= PULSE_HOURS[0]) {
        // The fixed pulses, each once in its hours (a pulse on an event does not take its place).
        const fixed = steps.filter((s) => s.kind === 'pulse' && !s.onEvent);
        const ranAt = (h: number) => fixed.some((p) => hourIn(ctx.tz, p.createdAt) >= h);
        const slots: Slot[] = hour >= 18 ? (ranAt(18) ? [] : ['evening']) : ranAt(12) ? [] : ['afternoon', 'evening'];
        if (!slots.length) reason = 'already pulsed';
        else {
            const [notes, thumbs] = await newSince(last.createdAt);
            if (notes.length || thumbs.length) return { due: true, onEvent: false, ctx, steps, slots, last, notes, thumbs, events: [] };
            reason = 'nothing new';
        }
    }
    if (!loop) return { due: false, reason };

    // A pulse on an event: what changed since the last step (or since the last one skipped, counted once).
    const capture = await prisma.buddyCaptureDay.findUnique({ where: { userId_day: { userId, day: toDbDay(ctx.today) } }, select: { pulseSkippedAt: true, todayAt: true, todayWords: true } });
    const since = capture?.pulseSkippedAt && capture.pulseSkippedAt > last.createdAt ? capture.pulseSkippedAt : last.createdAt;
    const events = await eventsThatMatter(userId, steps, since);
    // Stage 18: their own words that changed today (a plan for tonight, how today is going) are an event too.
    const todayWords = capture?.todayAt && capture.todayAt > since ? capture.todayAt : null;
    // 11-21 (the owner: "bring Buddy's nudge back at the time shown"): a Later tapped since, that comes back today, is an
    // event too: the pulse may give it a line from its time (<later> says how). One for tomorrow is the night's.
    const dayEnd = instantOf(ctx.today, ctx.tz, 24 * 60);
    const later = await prisma.buddyReminder.findFirst({ where: { userId, origin: 'later', status: 'pending', createdAt: { gt: since }, at: { gt: now, lt: dayEnd } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, text: true, at: true } });
    const laterTap = later?.createdAt ?? null;
    if (!events.length && !todayWords && !laterTap) return { due: false, reason };
    const lastNews = Math.max(events.length ? events[events.length - 1]!.receivedAt.getTime() : 0, todayWords?.getTime() ?? 0, laterTap?.getTime() ?? 0);
    const at = new Date(Math.max(lastNews + EVENT_SETTLE_MS, last.createdAt.getTime() + EVENT_GAP_MS));
    if (at > now) return { due: false, reason: 'a pulse on an event waits', at };
    if (steps.filter((s) => s.onEvent).length >= EVENT_PULSES_MAX) return { due: false, reason: 'the pulses on events are used up today', skip: ctx.today };
    const [notes, thumbs] = await newSince(last.createdAt);
    return { due: true, onEvent: true, ctx, steps, slots: slotsFrom(hour), last, notes, thumbs, events, ...(todayWords && capture?.todayWords ? { todayWords: capture.todayWords } : {}), ...(later ? { laterBack: { text: later.text, at: later.at } } : {}) };
}

/** A pulse on an event that could not run (the day's are used up): counted once for the usage view. */
async function countSkipped(userId: string, day: DayString, now: Date): Promise<void> {
    await prisma.buddyCaptureDay.upsert({
        where: { userId_day: { userId, day: toDbDay(day) } },
        create: { userId, day: toDbDay(day), pulsesSkipped: 1, pulseSkippedAt: now },
        update: { pulsesSkipped: { increment: 1 }, pulseSkippedAt: now },
    });
}

/** A pulse for one user when one is due (12:00 and 18:00 when something new arrived; with the loop on, on an event). */
export async function pulseIfDue(userId: string, now: Date = new Date()): Promise<{ ran: boolean; reason: string; costUsd?: number }> {
    const due = await pulseDue(userId, now);
    if (!due.due) {
        if (due.skip) await countSkipped(userId, due.skip, now);
        return { ran: false, reason: due.reason };
    }
    const { ctx, steps, slots, last, notes, thumbs, events, onEvent, todayWords, laterBack } = due;

    const state = await prisma.buddyState.findUnique({ where: { userId } });
    const person = await personName(userId);
    const signals = await buddySignals(userId, now);
    const current = (Array.isArray(last.lines) ? last.lines : []) as unknown as Line[];
    // Stage 7 (V1): with the loop on the lines have their own hours, and the pulse writes them from now on.
    const loopTimed = !!state?.loop;
    const nowMin = minuteOf(ctx.today, ctx.tz, now);
    const yourLines = current
        .filter((l) => l.text && !l.fallback)
        .map((l) => {
            const [s, e] = lineWindow(l);
            return `${clockOf(s)}-${clockOf(e)}${e <= nowMin ? ' (over)' : s <= nowMin ? ' (showing now)' : ''}: ${l.text}`;
        });
    const said = steps.flatMap((s) => [
        ...((Array.isArray(s.lines) ? s.lines : []) as unknown as Line[]).filter((l) => l.text && !l.fallback).map((l) => `${lineLabel(l)}: ${l.text}`),
        ...(s.insight ? [`home: ${s.insight}`] : []),
        ...(s.note ? [`note: ${s.note}`] : []),
    ]);
    const text = [
        `<today>${signals.today.weekday} ${signals.today.day}, ${signals.today.time} (${ctx.tz}) · rewrite: ${loopTimed ? 'your lines from now on' : slots.join(', ')}</today>`,
        `<signals>\n${JSON.stringify(signals)}\n</signals>`,
        `<right_now>${state?.now ?? 'not written yet'}</right_now>`,
        `<new>\n${notes.map((n) => `${n.kind} · ${n.sensitivity} · from ${n.source}${oldNote(n) ? ` · ${oldNote(n)}` : ''} · ${n.text}`).join('\n') || 'no new notes'}${thumbs.length ? `\nhis thumbs: ${thumbs.map((t) => `${t.target} ${t.verdict}`).join(', ')}` : ''}\n</new>`,
        `<said_today>\n${said.join('\n')}\n</said_today>`,
        ...(loopTimed ? [`<your_lines>\n${yourLines.join('\n') || 'none: the dial so far'}\n</your_lines>`] : []),
        // Stage 5: why a pulse on an event runs now (the threads below hold the rest).
        ...(onEvent
            ? [
                  `<changed>\nYou are thinking now because ${todayWords ? 'their own words today changed the day' : events.length ? 'a thread changed in a way that matters today' : 'they put something off with Later and it comes back today'}. Rewrite only what this calls for; the same words keep a line.${todayWords ? `\ntheir words today: "${todayWords}"` : ''}${events.length ? `\n${events.map((e) => `${e.threadId} · ${e.title}: ${e.kind} · ${e.text} (${whoseWord(e)}, via ${e.via})`).join('\n')}` : ''}${laterBack ? `\nLater: "${laterBack.text}" comes back at ${clockOf(minuteOf(ctx.today, ctx.tz, laterBack.at))} (see <later>)` : ''}\n</changed>`,
              ]
            : []),
    ].join('\n\n');
    // Stage 3 (ECOSYSTEM_V2_PLAN §4.3): with the loop on, the pulse reads the threads too and may ask.
    const threads = state?.loop ? await threadsForNight(userId, ctx.today, now) : null;
    // Stage 5b (B): his screen rules, with the threads.
    const rules = threads ? await screenRulesBlock(userId) : null;
    // Stage 17: what is ahead, as the night sees it.
    const ahead = threads ? await aheadBlocks(userId, now, ctx.tz) : null;
    const request = {
        model: PULSE_MODEL,
        max_tokens: 4000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: threads ? loopSchema(PULSE_SCHEMA, { threadOps: false }) : PULSE_SCHEMA } },
        system: [{ type: 'text', text: `${characterPrompt({ name: state?.name ?? null, tone: toneOf(state?.tone), person, loop: !!threads })}\n\n${loopTimed ? PULSE_TIMED_JOB : PULSE_JOB}${threads ? `\n${NIGHT_LOOP_JOB}` : ''}`, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: [{ type: 'text', text: threads ? `${text}\n\n<threads>\n${threads.block}\n</threads>${rules ? `\n\n${rules}` : ''}${ahead?.text ? `\n\n${ahead.text}` : ''}` : text }] }],
    } as CreateParams;
    let cost = 0;
    const message = await callClaude(userId, withRefusalFallbacks(request), 'buddy pulse');
    cost += (await recordAiUsage(userId, 'buddy_pulse', message)).costUsd;
    const raw = parseJson(responseText(message));
    const out = zPulse.parse(raw);
    const extra = threads ? zLoopExtra.safeParse(raw) : null;

    const sources = [JSON.stringify(signals), state?.now ?? '', ...notes.map((n) => n.text), ahead?.sources ?? ''].join('\n');
    const recent = said.map((s) => s.replace(/^([a-z]+|\d{2}:\d{2}-\d{2}:\d{2}): /, ''));
    const dropped: Dropped[] = [];
    // Stage 7 (V1), the loop on (an answer of slots still reads as slots): the lines whose hours are over stay as
    // they were; the rest is what it answered (a line it left out ends); four at most in the day, those over counted.
    const timed = loopTimed && (out.lines.some(hasHours) || !out.lines.length);
    let lines: Line[];
    let freshKeys: Set<string>;
    if (timed) {
        const gone = current.filter((l) => l.text && !l.fallback && lineWindow(l)[1] <= nowMin);
        const g = guardTimedLines(out.lines, { sources, kept: gone, after: nowMin });
        dropped.push(...g.dropped);
        lines = [...gone, ...g.lines].sort((a, b) => lineWindow(a)[0] - lineWindow(b)[0]);
        freshKeys = new Set(g.lines.map((l) => lineKey(l)));
    } else {
        const wanted = out.lines.filter((l) => !!l.slot && slots.includes(l.slot));
        const guarded = guardLines(wanted, { sources, recent: recent.filter((r) => !current.some((c) => c.text === r)) });
        dropped.push(...guarded.dropped);
        // A slot it answered gets its new line or silence; the hours gone and a slot it left out keep theirs.
        lines = SLOTS.flatMap((slot) => {
            const l = wanted.some((w) => w.slot === slot) ? guarded.lines.find((g) => g.slot === slot) : current.find((c) => c.slot === slot);
            return l ? [l] : [];
        });
        freshKeys = new Set(wanted.map((w) => w.slot!));
    }
    // Stage 3 (§4.5): a line it keeps from before is carried only while it is still true.
    const carried = await stillTrue(userId, lines.map((l) => ({ about: l.about ?? [], refs: l.refs ?? null, since: refsSince(instantOf(ctx.today, ctx.tz, lineWindow(l)[0])) })), 'lock', now);
    lines = lines.filter((_, i) => carried[i]);

    const noteText = unlabel(scrubSecrets(out.note).trim());
    const note = noteText && !strayNumbers(noteText, sources).length ? noteText.slice(0, 600) : null;
    // A new thought for the home screen, or the one it has (with its verdict).
    // With the loop on nothing is refused for having been said before: relevance wins (his point 5).
    const insight = guardInsight(out.insight, { sources, recent: threads ? [] : recent.filter((r) => r !== last.insight), lines }, dropped);
    // The lock check on the lines it wrote and its own note and thought; one carried over keeps its verdict.
    const privateTexts = (await prisma.memory.findMany({ where: { userId, status: 'active', sensitivity: 'private' }, select: { text: true }, take: 60 })).map((m) => m.text).concat(notes.filter((n) => n.sensitivity === 'private').map((n) => n.text));
    const checked = await lockCheck(userId, lines, privateTexts, { note, insight, asks: threads && extra?.success ? extra.data.asks.map((a) => a.text) : [] }, dropped, timed ? [...freshKeys] : slots);
    lines = checked.lines;
    cost += checked.costUsd;
    // Stage 3: the lines it wrote now say what they rest on; its questions keep the limits held by code.
    let insightAbout: Prisma.InputJsonValue | null = null;
    let noteAbout: Prisma.InputJsonValue | null = null;
    if (threads && extra?.success) {
        const fresh = lines.filter((l) => freshKeys.has(lineKey(l)));
        const loop = await withPersonLock(userId, (tx) =>
            applyLoopExtra(tx, userId, null, extra.data, fresh, { now, tz: ctx.tz, today: ctx.today, revisions: threads.revisions, threadOps: false, askLockOk: checked.asksLockOk, refs: ahead?.refs ?? new Set() })
        );
        lines = lines.filter((l) => !loop.questionKeys.has(lineKey(l))).map((l) => (freshKeys.has(lineKey(l)) ? withRefs({ ...l, about: loop.lineAbout.get(lineKey(l)) ?? [] }, loop.lineRefs.get(lineKey(l))) : l));
        insightAbout = aboutJson(loop.insightAbout, loop.insightRefs);
        noteAbout = aboutJson(loop.noteAbout, loop.noteRefs);
        dropped.push(...loop.dropped);
        // Stage 17: never two days running about the same left-off item.
        const yesterday = await leftOffSaidYesterday(userId, ctx.today);
        const kept = lines.filter((l) => !freshKeys.has(lineKey(l)) || !(l.refs ?? []).some((r) => yesterday.has(r)));
        if (kept.length < lines.length) dropped.push({ what: 'line', why: 'two days running about a left-off item' });
        lines = kept;
    }
    const row = await prisma.buddyDay.create({
        data: {
            userId,
            day: toDbDay(ctx.today),
            kind: 'pulse',
            lines: lines as unknown as Prisma.InputJsonValue,
            insight: insight ?? last.insight,
            insightLockOk: insight ? checked.insightLockOk : last.insightLockOk,
            note: note ?? last.note,
            noteLockOk: note ? checked.noteLockOk : last.noteLockOk,
            // A new thought or note keeps what it rests on; one carried over keeps its own.
            ...(threads ? { insightAbout: ((insight ? insightAbout : last.insightAbout) ?? []) as Prisma.InputJsonValue, noteAbout: ((note ? noteAbout : last.noteAbout) ?? []) as Prisma.InputJsonValue } : {}),
            followUp: last.followUp,
            dropped: dropped as unknown as Prisma.InputJsonValue,
            model: message.model.slice(0, 100),
            costUsd: cost.toFixed(6),
            onEvent,
            createdAt: now,
        },
    });
    // The questions this step wrote (inside the lock, before the row existed) name it.
    if (threads) await prisma.buddyAsk.updateMany({ where: { userId, buddyDayId: null, createdAt: now }, data: { buddyDayId: row.id } });
    await prisma.buddyState.update({ where: { userId }, data: { lastStepAt: now } });
    return { ran: true, reason: `${onEvent ? 'on an event: ' : ''}${timed ? `lines from ${clockOf(nowMin)}` : slots.join(' and ')}${note ? ' with a note' : ''}${insight ? ' and a new thought' : ''}`, costUsd: Math.round(cost * 1e4) / 1e4 };
}

