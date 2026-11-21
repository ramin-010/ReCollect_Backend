// The night and the pulses with the loop on (ECOSYSTEM_V2_PLAN §4.3, §4.4, §4.5; stage 3): they read
// each open thread with its last events, the ones whose day has come, and the questions of the last
// week; they may write questions (asks), say what each line, thought and note rests on, and tidy
// threads (merge, pause, close). They never raise a stage: only code does (§4.1). Code keeps the
// revision each item's writer saw, so any newer word about a thread withdraws it when it would show.
import { z } from 'zod';
import { prisma, type TxClient } from '../../db/prisma';
import { addDays, startOfDay, type DayString } from '../learning';
import { fromDbDay } from '../learningDb/common';
import { OPEN_STAGES, whoseWord, type About } from './threads';
import { ANSWER_MEANINGS, EVENT_ASK_DAYS, writeAsks, type AskDrop, type ProposedAsk, type QuickAnswer } from './asks';
import { lineKey, normTime } from './lineTimes';
import { refsOf } from './aheadBlocks';

/** Open threads the night reads at most (every open one: the ceiling is 200). */
const NIGHT_THREADS = 200;
const EVENTS_PER_THREAD = 4;

/** An active or committed thread with no word for this long has gone quiet (the night is told). */
export const GONE_QUIET_DAYS = 10;

export const NIGHT_LOOP_JOB = `
- On your mind (<threads>): what is going on in their life that you keep an eye on, with each one's stage (noticed: mentioned once; active: they came back to it or acted on it; committed: they asked you to keep an eye on it), its last updates, and whether its day has come (due).
  - A noticed thread is silent: never ask about it or bring it up until they touch it again or its day comes.
  - A plan with a time comes back at its time, as a question, never as an assumption ("you mentioned starting around now: still on?").
  - An event (marked event, with its day and time) is remembered, not tracked. Before it, a line in its hours may help ("Interview at 3. You're ready."); never a question. After it, one question at most, and only when asking would truly help them, at a moment that fits (that evening, or the next day): a job interview, an exam, a hard appointment, yes; a routine one (a haircut, a delivery), no. A follow-up must feel useful, never automatic; often the right one is none.
  - Not hearing about something is not the same as them not doing it: ask, never say or imply they skipped it.
- asks: up to 2 questions for today about active, committed or due threads, only when asking would truly help them (a friend checking in, not a tracker). Each: threadId; text (at most 120 characters, said the way a friend would text it); answers: up to 3 short quick answers with what each means (done, skipped, yes, no, later), or none; from and until: the hours it makes sense (HH:mm, their time). Often the right number is 0. Never ask what their last updates already answer.
  - An offer is a question of the kind offer, not ask: "Want me to keep an eye on this?" (answers: yes, no). Only for an active thread they keep coming back to that matters to them, once per thread; a yes means you follow it closely, a no is kept. Every other question is of the kind ask.
  - A habit they are building (active, with a rhythm) is checked on at its natural time: on a day it would happen, one short question with quick answers ("A run tonight?": Did it / Not today) is how you learn how it is going, and it beats a line about it; never both a question and a line about the same thread on one day. Not two days running when they answered your question yesterday: a line on how it is going, or silence, is enough then. Skip the day when it plainly does not fit (a night shift, travel, illness).
- reminders: at most 2 silent reminders for active or committed threads, only when one would truly help today ("Guitar after dinner"), each: threadId, text (at most 60 characters, said the way a friend would) and at (HH:mm, their time, later today). They show quietly on their phone's home screen and never ring. Name one in your note when you set it. Usually none.
- left_off (when given): problems and topics they stopped before finishing this week, with where they stopped. One of them may be the evening's line when it would help them pick it up: name the thing and where they stopped, in their terms ("3Sum: you had the two-pointer idea, only the duplicates left. Finish it tonight?"), starting in the hours they usually begin (signals.usual), with its id in about. One such line a day at most; none in the morning.
- coming_up (when given): their dated to-dos in the days ahead. Raise one while there is still time when doing it takes more than its own day (a gift to buy, a form to send, something to prepare): a line or the home thought a day or a few before, with its id in about. A to-do that needs nothing ahead is left to its own reminder.
- about: for every line, the thought (insightAbout) and the note (noteAbout): the ids of the threads and of the left_off and coming_up items it rests on, or [] when it rests on none. A question about a thread is never a line: put it in asks.
- threadOps: tidy what you keep an eye on: merge (ids: the threads that are the same thing, the first one kept), pause or close (ids: one thread) when their own words say so. reason: a few words. Usually none.`;

const str = { type: 'string' } as const;
const ids = { type: 'array', items: str } as const;

/**
 * The night's (or a pulse's) schema with the loop's fields: each line with its own hours instead of a part of the
 * day (stage 7, V1) and `about`; the thought's and the note's `about`, the asks, the reminders (unless `reminders`
 * is false: a Sunday night, see think.ts nightLoopSchema), the thread operations.
 */
export function loopSchema(base: Record<string, unknown>, opts: { threadOps: boolean; reminders?: boolean }): Record<string, unknown> {
    const s = JSON.parse(JSON.stringify(base)) as { required: string[]; properties: Record<string, { items?: { required?: string[]; properties?: Record<string, unknown> } }> };
    const line = s.properties['lines']!.items!;
    line.required = ['from', 'until', ...(line.required ?? []).filter((r) => r !== 'slot'), 'about'];
    line.properties = Object.fromEntries([['from', str], ['until', str], ...Object.entries(line.properties ?? {}).filter(([k]) => k !== 'slot'), ['about', ids]]);
    s.properties['insightAbout'] = ids as never;
    s.properties['noteAbout'] = ids as never;
    s.properties['asks'] = {
        type: 'array',
        items: {
            type: 'object',
            additionalProperties: false,
            required: ['threadId', 'kind', 'text', 'answers', 'from', 'until'],
            properties: {
                threadId: str,
                kind: { type: 'string', enum: ['ask', 'offer'] },
                text: str,
                answers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'meaning'], properties: { label: str, meaning: { type: 'string', enum: [...ANSWER_MEANINGS] } } } },
                from: str,
                until: str,
            },
        },
    } as never;
    s.required = [...s.required, 'insightAbout', 'noteAbout', 'asks'];
    if (opts.reminders !== false) {
        s.properties['reminders'] = {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['threadId', 'text', 'at'], properties: { threadId: str, text: str, at: str } },
        } as never;
        s.required.push('reminders');
    }
    if (opts.threadOps) {
        s.properties['threadOps'] = {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['op', 'ids', 'reason'], properties: { op: { type: 'string', enum: ['merge', 'pause', 'close'] }, ids, reason: str } },
        } as never;
        s.required.push('threadOps');
    }
    return s as unknown as Record<string, unknown>;
}

export const zLoopExtra = z.object({
    lines: z.array(z.object({ slot: z.string().optional(), from: z.string().optional(), about: z.array(z.string()).default([]) }).passthrough()),
    insightAbout: z.array(z.string()).default([]),
    noteAbout: z.array(z.string()).default([]),
    asks: z.array(z.object({ threadId: z.string(), kind: z.enum(['ask', 'offer']).default('ask'), text: z.string(), answers: z.array(z.object({ label: z.string(), meaning: z.enum(ANSWER_MEANINGS) })), from: z.string(), until: z.string() })).default([]),
    threadOps: z.array(z.object({ op: z.enum(['merge', 'pause', 'close']), ids: z.array(z.string()), reason: z.string() })).default([]),
    reminders: z.array(z.object({ threadId: z.string(), text: z.string(), at: z.string() })).default([]),
});
export type LoopExtra = z.infer<typeof zLoopExtra>;

export interface NightThreads {
    /** The <threads> block for the prompt. */
    block: string;
    /** Each thread's revision when the step read it: what its items rest on. */
    revisions: Map<string, number>;
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Stage 5b (A5): how an event thread reads for the night: before it, a line may help and a question never; after it,
 * one question at most within 3 days of its day, and only if asking would truly help (code holds the same limits).
 */
function eventFlag(t: { lookAgainOn: Date | null; eventMinute: number | null; id: string }, asks: ReadonlyArray<{ threadId: string | null; fromAt: Date; state: string }>, today: DayString, _now: Date): string {
    const day = fromDbDay(t.lookAgainOn!);
    const at = t.eventMinute != null ? ` at ${hhmm(t.eventMinute)}` : '';
    if (day > today) return `event on ${day}${at}: before it a line may help, never a question`;
    const followed = asks.some((a) => a.threadId === t.id && ['open', 'replied', 'answered', 'passed'].includes(a.state) && a.fromAt.toISOString().slice(0, 10) >= day);
    if (followed) return `event ${day === today ? 'today' : `was ${day}`}${at}: followed up already, no more questions`;
    if (day < addDays(today, -EVENT_ASK_DAYS)) return `event was ${day}: the moment for a question has passed`;
    return day === today ? `event today${at}: a line before it may help; after it, one question at most, only if it would truly help` : `event was ${day}${at}: one question at most, only if it would truly help`;
}

/** What the night and the pulses read of the threads (§4.3): every open one, with its last events; due ones marked; the questions of the last week. */
export async function threadsForNight(userId: string, today: DayString, now: Date): Promise<NightThreads> {
    const threads = await prisma.buddyThread.findMany({ where: { userId, stage: { in: [...OPEN_STAGES] } }, orderBy: { lastSaidAt: 'desc' }, take: NIGHT_THREADS });
    const revisions = new Map(threads.map((t) => [t.id, t.revision]));
    if (!threads.length) return { block: 'none yet', revisions };
    const [events, asks] = await Promise.all([
        prisma.buddyThreadEvent.findMany({ where: { userId, threadId: { in: threads.map((t) => t.id) }, duplicate: false }, orderBy: { saidAt: 'desc' }, take: threads.length * EVENTS_PER_THREAD }),
        prisma.buddyAsk.findMany({ where: { userId, createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, orderBy: { createdAt: 'asc' } }),
    ]);
    const out: string[] = [];
    for (const t of threads) {
        const quiet = t.noAsk || (t.quietUntil && t.quietUntil > now);
        const due = t.lookAgainOn && fromDbDay(t.lookAgainOn) <= today;
        // Gone quiet (stage 5): followed, but no word from them for 10 days (not news: they may simply not have said).
        const silentDays = Math.floor((now.getTime() - t.lastSaidAt.getTime()) / 86_400_000);
        const goneQuiet = (t.stage === 'active' || t.stage === 'committed') && silentDays >= GONE_QUIET_DAYS ? `nothing from them for ${silentDays} days` : '';
        const flags = [t.stage, t.event && t.lookAgainOn ? eventFlag(t, asks, today, now) : due ? `due (${fromDbDay(t.lookAgainOn!)})` : t.lookAgainOn ? `day ${fromDbDay(t.lookAgainOn)}: not before it` : '', t.rhythm !== 'none' ? t.rhythm : '', goneQuiet, t.sensitive ? 'private' : '', !t.onScreens ? 'off their screens' : '', quiet ? 'quiet: say nothing about it' : ''].filter(Boolean);
        out.push(`${t.id} · ${flags.join(' · ')} · ${t.title}`);
        for (const e of events.filter((x) => x.threadId === t.id).slice(0, EVENTS_PER_THREAD).reverse()) out.push(`    ${fromDbDay(e.forDay)} · ${e.kind}${e.direct ? '' : ` (${whoseWord(e)})`} · ${e.text}`);
        for (const a of asks.filter((x) => x.threadId === t.id)) out.push(`    you asked ${a.createdAt.toISOString().slice(0, 10)}: "${a.text}" · ${a.state}${a.answer ? `: ${a.answer}` : ''}`);
    }
    return { block: out.join('\n'), revisions };
}

/** Thread ids the step named, as what its item rests on: only threads it read, with the revision it saw. */
export function aboutOf(idList: readonly string[] | undefined, revisions: ReadonlyMap<string, number>): About[] {
    return [...new Set(idList ?? [])].flatMap((id) => (revisions.has(id) ? [{ threadId: id, rev: revisions.get(id)! }] : []));
}

/** HH:mm of `day` in the person's zone, as an instant (null when it is not a time). */
const clock = (hhmm: string, day: DayString, tz: string): Date | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    const [h, min] = [Number(m[1]), Number(m[2])];
    if (h > 23 || min > 59) return null;
    return new Date(startOfDay(day, tz).getTime() + (h * 60 + min) * 60_000);
};

/** The buddy's reminders a day at most (§4.7). */
export const BUDDY_REMINDERS_PER_DAY = 2;

/**
 * Stage 7 (§4.7): the buddy's own silent reminders, held by code: only for a thread it read that is active or
 * committed, not quiet, not "don't ask", not private or off his screens (they show on the home picture); later
 * today; 2 a day at most; never a task, never ringing.
 */
export async function writeBuddyReminders(
    tx: TxClient,
    userId: string,
    buddyDayId: string | null,
    proposed: ReadonlyArray<{ threadId: string; text: string; at: string }>,
    ctx: { now: Date; tz: string; today: DayString; revisions: ReadonlyMap<string, number> }
): Promise<AskDrop[]> {
    const dropped: AskDrop[] = [];
    if (!proposed.length) return dropped;
    const dayStart = startOfDay(ctx.today, ctx.tz);
    let count = await tx.buddyReminder.count({ where: { userId, at: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) } } });
    for (const r of proposed) {
        const text = r.text.replace(/\s+/g, ' ').trim().slice(0, 120);
        const at = clock(r.at, ctx.today, ctx.tz);
        const t = ctx.revisions.has(r.threadId) ? await tx.buddyThread.findFirst({ where: { id: r.threadId, userId } }) : null;
        let why: string | null = null;
        if (!text) why = 'no words';
        else if (!t) why = 'not a thread it read';
        else if (t.stage !== 'active' && t.stage !== 'committed') why = 'only for an active or committed thread';
        else if (t.noAsk || (t.quietUntil && t.quietUntil > ctx.now)) why = 'the thread is quiet';
        else if (t.sensitive || !t.onScreens) why = 'kept off the screens';
        else if (!at || at.getTime() <= ctx.now.getTime()) why = 'not later today';
        else if (count >= BUDDY_REMINDERS_PER_DAY) why = 'two reminders today already';
        if (why || !t || !at) {
            dropped.push({ what: `reminder ${text.slice(0, 40)}`, why: why ?? 'not later today' });
            continue;
        }
        await tx.buddyReminder.create({ data: { userId, threadId: t.id, text, at, buddyDayId, createdAt: ctx.now }, select: { id: true } });
        count++;
    }
    return dropped;
}

/** A line, a thought or a note that asks something about a thread is a question: it belongs in the asks (§4.3). */
export const isQuestion = (text: string) => /\?\s*$/.test(text.trim());

/** A model's line as the lines' key reads it (its start, or its part of the day). */
const rawKey = (x: { slot?: string | undefined; from?: string | undefined }) => normTime(x.from) ?? x.slot ?? '';

/**
 * Stores a step's loop fields under the person's lock: its questions (with the limits of §4.4, and the
 * lines that were questions about a thread moved there), and the night's thread tidying. Returns the
 * lines' `about` and the lines that became questions (by each line's key), the thought's and the note's
 * `about`, and what was dropped and why.
 */
export async function applyLoopExtra(
    tx: TxClient,
    userId: string,
    buddyDayId: string | null,
    extra: LoopExtra,
    lines: ReadonlyArray<{ slot: string; from?: string | undefined; text: string; lockOk?: boolean }>,
    ctx: { now: Date; tz: string; today: DayString; revisions: ReadonlyMap<string, number>; threadOps: boolean; askLockOk?: readonly boolean[]; refs?: ReadonlySet<string> }
): Promise<{
    lineAbout: Map<string, About[]>;
    /** Stage 17: the left-off items and to-dos each line rests on (ids it was shown in <left_off> and <coming_up>). */
    lineRefs: Map<string, string[]>;
    questionKeys: Set<string>;
    insightAbout: About[];
    noteAbout: About[];
    insightRefs: string[];
    noteRefs: string[];
    asks: number;
    dropped: AskDrop[];
}> {
    const dropped: AskDrop[] = [];
    const lineAbout = new Map<string, About[]>();
    const lineRefs = new Map<string, string[]>();
    const shownRefs = ctx.refs ?? new Set<string>();
    const questionKeys = new Set<string>();
    const proposed: ProposedAsk[] = [];
    const defaultUntil = clock('22:30', ctx.today, ctx.tz) ?? new Date(ctx.now.getTime() + 6 * 3600_000);
    for (const [i, a] of extra.asks.entries()) {
        if (!ctx.revisions.has(a.threadId)) {
            dropped.push({ what: `ask ${a.text.slice(0, 40)}`, why: 'not a thread it read' });
            continue;
        }
        const answers: QuickAnswer[] = a.answers.slice(0, 3).map((x) => ({ label: x.label.slice(0, 40), meaning: x.meaning }));
        // Stage 6: the lock check's verdict on its words (by its place in the step's questions).
        proposed.push({ threadId: a.threadId, kind: a.kind, text: a.text.slice(0, 200), answers, from: clock(a.from, ctx.today, ctx.tz) ?? ctx.now, until: clock(a.until, ctx.today, ctx.tz) ?? defaultUntil, lockOk: ctx.askLockOk?.[i] === true });
    }
    for (const l of lines) {
        const key = lineKey(l);
        const own = extra.lines.find((x) => rawKey(x) === key);
        const about = aboutOf(own?.about, ctx.revisions);
        const refs = refsOf(own?.about, shownRefs);
        if (refs.length) lineRefs.set(key, refs);
        // A question about a thread written as a line goes to the asks, where the limits hold (§4.3).
        if (about.length && isQuestion(l.text)) {
            questionKeys.add(key);
            proposed.push({ threadId: about[0]!.threadId, text: l.text.slice(0, 200), answers: [], from: ctx.now, until: defaultUntil, lockOk: l.lockOk === true });
            continue;
        }
        lineAbout.set(key, about);
    }
    const written = await writeAsks(tx, userId, buddyDayId, proposed, { now: ctx.now, tz: ctx.tz });
    dropped.push(...written.dropped);
    // Stage 7 (§4.7): its own silent reminders, within the limits held here.
    dropped.push(...(await writeBuddyReminders(tx, userId, buddyDayId, extra.reminders, ctx)));
    if (ctx.threadOps) {
        for (const op of extra.threadOps) {
            const own = await tx.buddyThread.findMany({ where: { userId, id: { in: op.ids } } });
            if (!own.length || own.length !== new Set(op.ids).size) {
                dropped.push({ what: `thread ${op.op}`, why: 'not their threads' });
                continue;
            }
            if (op.op === 'merge') {
                const [keep, ...rest] = op.ids.map((id) => own.find((t) => t.id === id)!);
                if (!keep || !rest.length) continue;
                const restIds = rest.map((t) => t.id);
                await tx.buddyThreadEvent.updateMany({ where: { threadId: { in: restIds } }, data: { threadId: keep.id } });
                await tx.buddyAsk.updateMany({ where: { threadId: { in: restIds } }, data: { threadId: keep.id } });
                // The stricter steers win: off the screens, sensitive, no questions.
                await tx.buddyThread.update({
                    where: { id: keep.id },
                    data: { revision: { increment: 1 }, sensitive: own.some((t) => t.sensitive), onScreens: own.every((t) => t.onScreens), noAsk: own.some((t) => t.noAsk) },
                    select: { id: true },
                });
                await tx.buddyThread.updateMany({ where: { id: { in: restIds } }, data: { stage: 'dropped', closedAt: ctx.now, steer: `merged into ${keep.id}`.slice(0, 200) } });
            } else {
                const t = own[0]!;
                await tx.buddyThread.update({ where: { id: t.id }, data: { stage: op.op === 'pause' ? 'paused' : 'done', closedAt: ctx.now, revision: { increment: 1 } }, select: { id: true } });
            }
        }
    }
    return {
        lineAbout,
        lineRefs,
        questionKeys,
        insightAbout: aboutOf(extra.insightAbout, ctx.revisions),
        noteAbout: aboutOf(extra.noteAbout, ctx.revisions),
        insightRefs: refsOf(extra.insightAbout, shownRefs),
        noteRefs: refsOf(extra.noteAbout, shownRefs),
        asks: written.kept,
        dropped,
    };
}
