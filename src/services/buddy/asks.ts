// The buddy's questions that know when they were answered (ECOSYSTEM_V2_PLAN §4.4, §4.14; stage 3), and
// the check every word of the buddy's passes at the moment it shows (§4.5). Code only: no model call.
import type { BuddyAsk, Prisma } from '@prisma/client';
import { prisma, type TxClient } from '../../db/prisma';
import { badRequest, notFound } from '../learning/http';
import { addDays, startOfDay, type DayString } from '../learning';
import { loadLearningContext, toDbDay, fromDbDay } from '../learningDb/common';
import { OPEN_STAGES, addThreadEvent, dayFor, withPersonLock, type About, type EventKind } from './threads';
import { queueOwnWords } from './capture.service';
import { poke } from '../scheduler/scheduler';
import { THUMB_REASONS, activeScreenRules, askWindow, offScreensFromThumb, type ThumbReason } from './screens';

export const ASKS_PER_DAY = 2;
/** Stage 5b: an event's one follow-up may come up to this many days after its day. */
export const EVENT_ASK_DAYS = 3;
export const ANSWER_MEANINGS = ['done', 'skipped', 'yes', 'no', 'later'] as const;
export type AnswerMeaning = (typeof ANSWER_MEANINGS)[number];
export interface QuickAnswer {
    label: string;
    meaning: AnswerMeaning;
}

/** Where words show. The screens are seen by others: a sensitive thread, or one he took off them, never shows there. */
export type Surface = 'lock' | 'home' | 'widget' | 'notification' | 'push' | 'web' | 'chat' | 'brief';
const SCREENS: ReadonlySet<Surface> = new Set(['lock', 'home', 'widget', 'notification', 'push']);

interface ThreadView {
    id: string;
    revision: number;
    stage: string;
    quietUntil: Date | null;
    noAsk: boolean;
    onScreens: boolean;
    sensitive: boolean;
}

/** A thread that takes no words of any kind now (§4.4): closed, quiet, or "don't ask me about this". */
const silenced = (t: ThreadView, now: Date) => !(OPEN_STAGES as readonly string[]).includes(t.stage) || t.noAsk || (!!t.quietUntil && t.quietUntil > now);

/**
 * True when shown (§4.5): an item passes only inside its hours, while every thread it rests on still
 * has the revision its writer saw, is open and not quiet, and (on a screen others see) is neither
 * sensitive nor taken off the screens by him. Items that rest on no thread pass on their hours alone.
 */
export async function stillTrue(
    userId: string,
    items: ReadonlyArray<{ about?: readonly About[] | null; until?: Date | string | null; refs?: readonly string[] | null; since?: Date | string | null }>,
    surface: Surface,
    now: Date = new Date()
): Promise<boolean[]> {
    const ids = [...new Set(items.flatMap((i) => (i.about ?? []).map((a) => a.threadId)))];
    const rows: ThreadView[] = ids.length
        ? await prisma.buddyThread.findMany({ where: { userId, id: { in: ids } }, select: { id: true, revision: true, stage: true, quietUntil: true, noAsk: true, onScreens: true, sensitive: true } })
        : [];
    const byId = new Map(rows.map((t) => [t.id, t]));
    // Stage 17: words resting on a left-off item or a to-do pass only while it is still open (asks.ts stays free of
    // that reader until a word carries a ref).
    const refs = [...new Set(items.flatMap((i) => i.refs ?? []))];
    const refOpen = refs.length ? await (await import('./aheadBlocks')).refsChecker(userId, refs, now, (await loadLearningContext(userId, now)).tz) : null;
    return items.map((item) => {
        if (item.until && new Date(item.until).getTime() <= now.getTime()) return false;
        if (refOpen && (item.refs ?? []).some((r) => !refOpen(r, item.since ? new Date(item.since) : null))) return false;
        return (item.about ?? []).every((a) => {
            const t = byId.get(a.threadId);
            if (!t || t.revision !== a.rev || silenced(t, now)) return false;
            // An agent's brief is read by another AI in his chats: nothing private there either (the week's
            // simulation, 11-18: "How's your mum doing after today?" would have reached a coding session).
            return !((SCREENS.has(surface) || surface === 'brief') && (t.sensitive || !t.onScreens));
        });
    });
}

export interface AskJson {
    _id: string;
    text: string;
    answers: QuickAnswer[];
    threadId: string | null;
    until: string;
    /** Stage 6: the lock check passed its words (app 0.6.0 may show it on the lock screen). */
    lockOk: boolean;
}

const answersOf = (value: Prisma.JsonValue): QuickAnswer[] =>
    Array.isArray(value)
        ? value.flatMap((v) => {
              const o = v as { label?: unknown; meaning?: unknown } | null;
              return o && typeof o.label === 'string' && (ANSWER_MEANINGS as readonly string[]).includes(String(o.meaning)) ? [{ label: o.label, meaning: o.meaning as AnswerMeaning }] : [];
          })
        : [];

const askJson = (a: BuddyAsk): AskJson => ({ _id: a.id, text: a.text, answers: answersOf(a.answers), threadId: a.threadId, until: a.untilAt.toISOString(), lockOk: a.lockOk });

/** The questions to show now on a surface (§4.4): open, inside their hours, still true; marked as shown there. */
export async function openAsks(userId: string, surface: Surface, now: Date = new Date()): Promise<AskJson[]> {
    const rows = await prisma.buddyAsk.findMany({ where: { userId, state: 'open', fromAt: { lte: now }, untilAt: { gt: now } }, orderBy: { fromAt: 'asc' } });
    if (!rows.length) return [];
    // His switch off (stage 5): questions written before it stop showing at once.
    if ((await prisma.buddyState.findUnique({ where: { userId }, select: { asksOn: true } }))?.asksOn === false) return [];
    const ok = await stillTrue(userId, rows.map((a) => ({ about: a.threadId && a.seenRevision != null ? [{ threadId: a.threadId, rev: a.seenRevision }] : [], until: a.untilAt })), surface, now);
    const shown = rows.filter((_, i) => ok[i]);
    for (const a of shown) {
        if (a.shownOn.includes(surface)) continue;
        await prisma.buddyAsk.update({ where: { id: a.id }, data: { shownOn: [...a.shownOn, surface], firstShownAt: a.firstShownAt ?? now }, select: { id: true } });
    }
    return shown.map(askJson);
}

export interface ProposedAsk {
    threadId: string;
    /** Stage 5: an offer ("want me to keep an eye on this?"): once per thread; his yes makes it committed. */
    kind?: 'ask' | 'offer';
    text: string;
    answers: QuickAnswer[];
    from: Date;
    until: Date;
    /** Stage 6: the lock check passed its words (the phone may show it on the lock screen). */
    lockOk?: boolean;
}

export interface AskDrop {
    what: string;
    why: string;
}

/**
 * Writes a step's questions within the limits held by code (§4.4): at most 2 a day (one that never
 * showed does not count) and 1 per thread per day; none about a thread he only mentioned once, before
 * he comes back to it or its day comes; none about a closed or quiet thread. Each keeps the revision
 * of its thread, so any new word about the thread withdraws it.
 */
export async function writeAsks(tx: TxClient, userId: string, buddyDayId: string | null, proposed: readonly ProposedAsk[], ctx: { now: Date; tz: string }): Promise<{ kept: number; dropped: AskDrop[] }> {
    const dropped: AskDrop[] = [];
    let kept = 0;
    // His switch (stage 5): no questions at all while it is off.
    const state = await tx.buddyState.findUnique({ where: { userId }, select: { asksOn: true } });
    if (state && !state.asksOn) return { kept: 0, dropped: proposed.map((p) => ({ what: `ask ${p.text.slice(0, 40)}`, why: 'questions are switched off' })) };
    const day = dayFor(ctx.now, ctx.tz);
    const since = new Date(ctx.now.getTime() - 30 * 3600_000);
    const recent = await tx.buddyAsk.findMany({ where: { userId, createdAt: { gte: since } }, select: { threadId: true, fromAt: true, state: true, firstShownAt: true } });
    const today = recent.filter((a) => dayFor(a.fromAt, ctx.tz) === day && (a.firstShownAt || a.state === 'open' || a.state === 'replied' || a.state === 'answered' || a.state === 'passed'));
    let count = today.length;
    // Stage 5b, part B: what they asked about when questions may come.
    const rules = (await activeScreenRules(userId, tx)).filter((r) => r.kind !== 'topic');
    for (const p of proposed) {
        const text = p.text.replace(/\s+/g, ' ').trim().slice(0, 200);
        const t = await tx.buddyThread.findFirst({ where: { id: p.threadId, userId } });
        let why: string | null = null;
        if (!text) why = 'no words';
        else if (!t) why = 'no such thread';
        else if (silenced(t, ctx.now)) why = 'the thread is closed or quiet';
        else if (t.stage === 'noticed' && !(t.lookAgainOn && fromDbDay(t.lookAgainOn) <= day)) why = 'mentioned once: silent until it comes up again';
        // A plan with a time comes back at its time (§4.3, stage 5): never a question before its day.
        else if (t.lookAgainOn && fromDbDay(t.lookAgainOn) > day) why = 'its day has not come';
        else if (p.kind === 'offer' && t.stage === 'committed') why = 'it is followed already';
        else if (p.kind === 'offer' && (await tx.buddyAsk.count({ where: { userId, threadId: t.id, kind: 'offer' } })) > 0) why = 'offered once already';
        else if (count >= ASKS_PER_DAY) why = 'two questions today already';
        else if (today.some((a) => a.threadId === p.threadId)) why = 'a question about it today already';
        // Not two days running: the day after he answered a question about it, none of any kind (an offer too).
        else if (recent.some((a) => a.threadId === p.threadId && a.state === 'answered' && dayFor(a.fromAt, ctx.tz) === addDays(day, -1))) why = 'answered about it yesterday';
        // Stage 5b (A5): an event is followed up at most once after it, and only within 3 days of its day.
        else if (t.event && t.lookAgainOn && day > addDays(fromDbDay(t.lookAgainOn), EVENT_ASK_DAYS)) why = 'the moment has passed';
        else if (t.event && t.lookAgainOn && (await tx.buddyAsk.count({ where: { userId, threadId: t.id, state: { in: ['open', 'replied', 'answered', 'passed'] }, fromAt: { gte: startOfDay(fromDbDay(t.lookAgainOn), ctx.tz) } } })) > 0) why = 'asked about it once already';
        if (why || !t) {
            dropped.push({ what: `ask ${text.slice(0, 40)}`, why: why ?? 'no such thread' });
            continue;
        }
        let from = p.from.getTime() < ctx.now.getTime() ? ctx.now : p.from;
        // Stage 5b (A5): never before the event is over: an hour after its time, or 18:00 of its day.
        if (t.event && t.lookAgainOn) {
            const over = new Date(startOfDay(fromDbDay(t.lookAgainOn), ctx.tz).getTime() + (t.eventMinute != null ? t.eventMinute + 60 : 18 * 60) * 60_000);
            if (from.getTime() < over.getTime()) from = over;
        }
        let until = p.until.getTime() > from.getTime() + 30 * 60_000 ? p.until : new Date(from.getTime() + 3 * 3600_000);
        // Stage 5b (B): their rules about when questions may come.
        const window = askWindow(rules, t.id, from, until, ctx.tz);
        if ('why' in window) {
            dropped.push({ what: `ask ${text.slice(0, 40)}`, why: window.why });
            continue;
        }
        from = window.from;
        until = window.until;
        await tx.buddyAsk.create({
            // Its time from the step's `now` (the limits read it; a test can move the clock: §10.1).
            data: { userId, threadId: t.id, kind: p.kind === 'offer' ? 'offer' : 'ask', text, answers: p.answers.slice(0, 3) as unknown as Prisma.InputJsonValue, seenRevision: t.revision, buddyDayId, fromAt: from, untilAt: until, lockOk: p.lockOk === true, createdAt: ctx.now },
            select: { id: true },
        });
        today.push({ threadId: t.id, fromAt: from, state: 'open', firstShownAt: null });
        count++;
        kept++;
    }
    return { kept, dropped };
}

const EVENT_OF: Record<AnswerMeaning, EventKind> = { done: 'done', skipped: 'skipped', yes: 'answered', no: 'answered', later: 'answered' };

/**
 * His answer to a question (§4.14), safe to send twice:
 * - a quick answer is exact: the question is answered, and its thread gets the event (which withdraws
 *   every word written about it before);
 * - his own words hide the question at once and go to the digest, with the question as context;
 * - a thumb down withdraws it.
 * An answer after its hours still counts, for the day it asked about.
 */
export async function answerAsk(userId: string, askId: string, input: { choice?: number | undefined; text?: string | undefined; thumb?: 'less' | undefined; reason?: ThumbReason | undefined }, now: Date = new Date()): Promise<{ state: string }> {
    const { tz } = await loadLearningContext(userId, now);
    const result = await withPersonLock(userId, async (tx) => {
        const ask = await tx.buddyAsk.findFirst({ where: { id: askId, userId } });
        if (!ask) throw notFound();
        // A thumb (and, stage 5b, its reason sent a moment later: the question is withdrawn by then) on a question not answered.
        const thumbing = input.thumb === 'less' && ask.state !== 'answered' && (ask.state !== 'withdrawn' || ask.thumb === 'less');
        if (ask.state === 'withdrawn' && !thumbing) return { state: ask.state, queue: null as string | null, ask };
        const answers = answersOf(ask.answers);
        const choice = input.choice != null ? answers[input.choice] : undefined;
        // Answered already: the same answer again changes nothing (safe to send twice); another quick
        // answer is his correction, and his later word wins (§4.11 rule 6), whether 40 seconds or an hour later.
        if (ask.state === 'answered' && (!choice || choice.label.slice(0, 300) === ask.answer)) return { state: ask.state, queue: null as string | null, ask };
        if (thumbing) {
            const reason = input.reason && (THUMB_REASONS as readonly string[]).includes(input.reason) ? input.reason : null;
            await tx.buddyAsk.update({ where: { id: ask.id }, data: { state: 'withdrawn', answeredAt: ask.answeredAt ?? now, thumb: 'less', ...(reason ? { thumbReason: reason } : {}) }, select: { id: true } });
            // A thumbs-down on a question: its thread goes quiet for 14 days (§4.4). Stage 5b: "too private" also
            // takes the thread off the screens (On my mind shows it and puts it back).
            if (ask.threadId) {
                await tx.buddyThread.updateMany({ where: { id: ask.threadId, userId }, data: { quietUntil: new Date(now.getTime() + QUIET_AFTER_THUMB_DAYS * 86_400_000) } });
                if (reason === 'private') await offScreensFromThumb(tx, userId, [ask.threadId], ask.text);
            }
            return { state: 'withdrawn', queue: null, ask };
        }
        if (choice) {
            // The first answer keeps its origin key; each correction has its own (a retry of it writes nothing twice).
            const corrections = ask.state === 'answered' ? await tx.buddyThreadEvent.count({ where: { userId, askId: ask.id, via: 'answer' } }) : 0;
            const originKey = corrections ? `ask:${ask.id}:answer:${corrections + 1}` : `ask:${ask.id}:answer`;
            await tx.buddyAsk.update({ where: { id: ask.id }, data: { state: 'answered', answeredAt: now, answer: choice.label.slice(0, 300) }, select: { id: true } });
            const thread = ask.threadId ? await tx.buddyThread.findFirst({ where: { id: ask.threadId, userId } }) : null;
            // His yes to an offer makes the thread committed: only his word does (§4.1).
            if (thread && ask.kind === 'offer' && choice.meaning === 'yes') await tx.buddyThread.update({ where: { id: thread.id }, data: { stage: 'committed', closedAt: null }, select: { id: true } });
            if (thread) {
                // A dated one-time plan (a deadline, an event: no rhythm, its day come): "done" means it happened,
                // so the thread is finished and closes (J11). A habit's "done" is that day's statement.
                const oneTime = choice.meaning === 'done' && thread.rhythm === 'none' && !!thread.lookAgainOn && fromDbDay(thread.lookAgainOn) <= dayFor(now, tz);
                await addThreadEvent(tx, userId, thread, { kind: oneTime ? 'finished' : EVENT_OF[choice.meaning], text: `${choice.label} (to: ${ask.text})`, saidAt: now, forDay: dayFor(ask.fromAt, tz), direct: true, via: 'answer', originKey, askId: ask.id }, now);
            }
            return { state: 'answered', queue: null, ask };
        }
        const text = input.text?.replace(/\s+/g, ' ').trim();
        if (!text) throw badRequest('Send a choice, your words, or a thumb');
        if (ask.state === 'open') await tx.buddyAsk.update({ where: { id: ask.id }, data: { state: 'replied', answeredAt: now }, select: { id: true } });
        return { state: 'replied', queue: text, ask };
    });
    // His words are read like any of his messages, with the question as context (outside the lock).
    if (result.queue) await queueOwnWords(userId, { key: `answer:${askId}`, seq: 1, via: 'answer', messages: [{ at: now.toISOString(), text: result.queue, before: result.ask.text }] }, now);
    // An answer matters today: a pulse on it may fall due (§4.13).
    else if (result.state === 'answered') poke('buddy');
    return { state: result.state };
}

/** A thread goes quiet this long after two questions about it passed unanswered, or after a thumbs-down on one (§4.4). */
export const QUIET_AFTER_UNANSWERED_DAYS = 7;
export const QUIET_AFTER_THUMB_DAYS = 14;

/**
 * Questions past their hours (§4.4): one that showed and got no answer has passed, one that never showed
 * expired (it does not count). Two passed in a row about one thread make it quiet for 7 days: no words
 * of any kind about it, on any surface. Run at the start of each night, under the person's lock.
 */
export async function closeOldAsks(userId: string, now: Date = new Date()): Promise<{ passed: number; quieted: number }> {
    return withPersonLock(userId, async (tx) => {
        const due = await tx.buddyAsk.findMany({ where: { userId, state: 'open', untilAt: { lte: now } }, select: { id: true, firstShownAt: true, threadId: true } });
        for (const a of due) await tx.buddyAsk.update({ where: { id: a.id }, data: { state: a.firstShownAt ? 'passed' : 'expired' }, select: { id: true } });
        let quieted = 0;
        for (const threadId of new Set(due.filter((a) => a.firstShownAt && a.threadId).map((a) => a.threadId!))) {
            const last = await tx.buddyAsk.findMany({ where: { userId, threadId, state: { in: ['passed', 'answered', 'replied', 'withdrawn'] } }, orderBy: { fromAt: 'desc' }, take: 2, select: { state: true } });
            if (last.length === 2 && last.every((x) => x.state === 'passed')) {
                await tx.buddyThread.updateMany({ where: { id: threadId, userId }, data: { quietUntil: new Date(now.getTime() + QUIET_AFTER_UNANSWERED_DAYS * 86_400_000) } });
                quieted++;
            }
        }
        return { passed: due.filter((a) => a.firstShownAt).length, quieted };
    });
}

/** A reply in the chat that opened with a question closes it for the day, whether or not it answers it (§4.4). */
export async function markReplied(userId: string, askId: string, now: Date = new Date()): Promise<void> {
    await prisma.buddyAsk.updateMany({ where: { id: askId, userId, state: 'open' }, data: { state: 'replied', answeredAt: now } });
}

/** One question's day, for the day boundary used everywhere (his day ends at 04:00). */
export const askDay = (a: Pick<BuddyAsk, 'fromAt'>, tz: string): DayString => dayFor(a.fromAt, tz);
export { addDays, toDbDay };
