// Threads: what is in motion in a person's life (ECOSYSTEM_V2_PLAN §4.1, §4.11, §4.12; stage 3). A model
// says what a message means; code alone keeps the rules: a piece read once only, the order he said
// things in (never the order they arrived), his own word over what was passed on, the stage ladder
// (only code raises a stage; only his yes makes one committed), and the revision that withdraws every
// word written about a thread before its newest news (§4.5).
import { Prisma, type BuddyThread, type BuddyThreadEvent } from '@prisma/client';
import { prisma, type TxClient } from '../../db/prisma';
import { addDays, dayOf, type DayString } from '../learning';
import { fromDbDay, toDbDay } from '../learningDb/common';
import { searchTerms } from '../docs/docSearch.service';
import { memoryKey } from './memory.service';
import { searchRoot } from './recordRules';
import { poke } from '../scheduler/scheduler';

export const THREAD_STAGES = ['noticed', 'active', 'committed', 'paused', 'done', 'dropped'] as const;
export type ThreadStage = (typeof THREAD_STAGES)[number];
export const OPEN_STAGES: readonly ThreadStage[] = ['noticed', 'active', 'committed'];
export const EVENT_KINDS = ['said', 'progress', 'done', 'skipped', 'finished', 'changed', 'paused', 'resumed', 'dropped', 'answered', 'steer'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** A person's open threads at most (§4.12): past it the oldest quiet `noticed` one fades to make room. */
export const OPEN_MAX = 200;
/** Closed threads stay in view (to be opened again, with his steers) this long. */
export const CLOSED_IN_VIEW_DAYS = 180;
/** His day ends at 04:00, as the buddy's day does. */
export const DAY_ENDS_HOUR = 4;

/** Said this long before it arrived (held words, a late note, an import): old news (§4.11 rule 7). */
export const OLD_NEWS_MS = 48 * 3600_000;

/** Events that show he came back to it or acted on it: a `noticed` thread becomes `active`. */
const RAISES: ReadonlySet<EventKind> = new Set(['progress', 'done', 'skipped', 'changed', 'answered', 'resumed']);
/** Statements about one day's doing. */
const DAY_KINDS: ReadonlySet<EventKind> = new Set(['done', 'skipped']);
/**
 * The same news about a day: she did (some of) it (progress, done), or she did not (skipped). An agent's note of it
 * after her own word that day says nothing new, whichever of the two kinds each reading chose (J4 on the real
 * models, 11-18: "played guitar for twenty minutes" came once as progress and once as done).
 */
const sameDayNews = (a: string, b: string): boolean => (a === 'skipped' || b === 'skipped' ? a === b : ['progress', 'done'].includes(a) && ['progress', 'done'].includes(b));

const isOpen = (stage: string) => (OPEN_STAGES as readonly string[]).includes(stage);
const hourIn = (tz: string, at: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(at)) % 24;

/** His day for an instant: before 04:00 it is still the day before (§4.11 rule 1). */
export function dayFor(at: Date, tz: string): DayString {
    const local = dayOf(at, tz);
    return hourIn(tz, at) < DAY_ENDS_HOUR ? addDays(local, -1) : local;
}

/** The stage after a new event that is his newest word about the thread (pure). */
export function nextStage(stage: string, kind: EventKind, opts: { firstDay: DayString; forDay: DayString }): ThreadStage {
    const s = (THREAD_STAGES as readonly string[]).includes(stage) ? (stage as ThreadStage) : 'noticed';
    if (kind === 'paused') return 'paused';
    if (kind === 'dropped') return 'dropped';
    if (kind === 'finished') return 'done';
    if (kind === 'steer') return s;
    // A word about a closed thread opens it again (its steers stay as he left them).
    if (!isOpen(s)) return 'active';
    if (s === 'noticed' && (RAISES.has(kind) || opts.forDay !== opts.firstDay)) return 'active';
    return s;
}

export interface DayEvent {
    kind: string;
    saidAt: Date;
    direct: boolean;
    duplicate?: boolean;
    /** MCP_MEMORY_PLAN §4.4: 'said' weighs as the person's own word; 'inferred' never decides; null as before. */
    basis?: string | null;
    /** Said on that day, its time unknown: it never overrules a statement with a time. */
    dayOnly?: boolean;
}

/** The person's word: heard by Recollect itself, or passed on by an assistant as what they said (§4.4). */
export const weighs = (e: { direct: boolean; basis?: string | null }): boolean => e.direct || e.basis === 'said';

/** Whose word an event is, for the night's and the pulses' inputs (§4.4). */
export function whoseWord(e: { direct: boolean; basis?: string | null }): string {
    if (e.direct) return 'said directly';
    if (e.basis === 'said') return 'said via a connected assistant';
    if (e.basis === 'inferred') return 'inferred by a connected assistant, not said';
    return 'passed on';
}

/**
 * One day's state of a thread from its events (pure; §4.11 rules 5 and 6): his direct statements in the
 * order he made them, the later one winning, even seconds later; an indirect one (an agent's note)
 * never overrules a direct one; two indirect ones that disagree leave the day unclear.
 */
export function dayState(events: readonly DayEvent[]): 'done' | 'skipped' | 'unclear' | null {
    const said = events.filter((e) => !e.duplicate && DAY_KINDS.has(e.kind as EventKind) && e.basis !== 'inferred');
    const theirs = said.filter(weighs);
    // A statement with its time wins over one known only by its day (§4.4); among those with times, the later one.
    const timed = theirs.filter((e) => !e.dayOnly).sort((a, b) => a.saidAt.getTime() - b.saidAt.getTime());
    if (timed.length) return timed[timed.length - 1]!.kind as 'done' | 'skipped';
    if (theirs.length) {
        const kinds = new Set(theirs.map((e) => e.kind));
        return kinds.size > 1 ? 'unclear' : (theirs[0]!.kind as 'done' | 'skipped');
    }
    const kinds = new Set(said.map((e) => e.kind));
    if (kinds.size > 1) return 'unclear';
    return said.length ? (said[0]!.kind as 'done' | 'skipped') : null;
}

const words = (text: string) => new Set(memoryKey(text).split(' ').filter((w) => w.length > 2));

/** How much two threads' words overlap (0 to 1): the shared words over the smaller set (pure). */
export function overlap(a: { title: string; keywords?: readonly string[] }, b: { title: string; keywords?: readonly string[] }): number {
    const x = words(`${a.title} ${(a.keywords ?? []).join(' ')}`);
    const y = words(`${b.title} ${(b.keywords ?? []).join(' ')}`);
    if (!x.size || !y.size) return 0;
    return [...x].filter((w) => y.has(w)).length / Math.min(x.size, y.size);
}

/** A thread this close in words is the same thread (§4.12: the compare before one is made). */
export const SAME_THREAD = 0.6;
/** ...and a dated event joins a thread without its day only this close (near-identical words). */
export const DATED_SAME_THREAD = 0.9;

/** One person's writes one after another (§4.11 rule 9): a lock held only inside the transaction. */
export async function withPersonLock<T>(userId: string, fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(
        async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buddy:${userId}`}))`;
            return fn(tx);
        },
        { timeout: 20_000 }
    );
}

export interface ThreadIndexRow {
    id: string;
    title: string;
    stage: string;
    keywords: string[];
    lastSaidAt: Date;
    lookAgainOn: string | null;
}

/** Every open thread, and those closed in the last 180 days (§4.12): what the digest and the chat see. */
export async function threadIndex(userId: string, now: Date = new Date(), db: TxClient | typeof prisma = prisma): Promise<ThreadIndexRow[]> {
    const rows = await db.buddyThread.findMany({
        where: { userId, OR: [{ stage: { in: [...OPEN_STAGES] } }, { closedAt: { gte: new Date(now.getTime() - CLOSED_IN_VIEW_DAYS * 86_400_000) } }] },
        orderBy: [{ lastSaidAt: 'desc' }],
        take: OPEN_MAX + 100,
        select: { id: true, title: true, stage: true, keywords: true, lastSaidAt: true, lookAgainOn: true },
    });
    return rows.map((r) => ({ ...r, lookAgainOn: r.lookAgainOn ? fromDbDay(r.lookAgainOn) : null }));
}

export interface ThreadFound {
    _id: string;
    title: string;
    stage: string;
    sensitive: boolean;
    rhythm: string;
    firstDay: string;
    lastSaidAt: string;
    lookAgainOn: string | null;
    /** Its last events, newest first (duplicates left out). */
    last: Array<{ day: string; kind: string; text: string }>;
    /** His controls (/you): don't ask, may show on his screens, quiet until. */
    noAsk: boolean;
    onScreens: boolean;
    quietUntil: string | null;
}

const FOUND_EVENTS = 3;

/**
 * Threads that hold the words (recall_memory, §4.12): in their title and keywords, or in the words of
 * their history; open ones and those closed in the last 180 days. Every word first, then any of them;
 * without words, the open threads. Best match first, then the newest word; each with its last events.
 */
export async function searchThreads(userId: string, q: string, limit = 10, now: Date = new Date()): Promise<ThreadFound[]> {
    const take = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);
    const since = new Date(now.getTime() - CLOSED_IN_VIEW_DAYS * 86_400_000);
    const terms = searchTerms(q.slice(0, 200));
    let ids: string[];
    if (!terms.length) {
        ids = (await prisma.buddyThread.findMany({ where: { userId, stage: { in: [...OPEN_STAGES] } }, orderBy: { lastSaidAt: 'desc' }, take, select: { id: true } })).map((t) => t.id);
    } else {
        const find = (join: ' && ' | ' || ') => {
            const query = Prisma.join(
                terms.map((t) => {
                    // MCP_MEMORY_PLAN §12.4 D: the word's root too, so other forms meet ("cycling" finds "Cycle to work").
                    const root = searchRoot(t);
                    return root
                        ? Prisma.sql`(to_tsquery('english', ${t}) || to_tsquery('simple', ${`${t}:*`}) || to_tsquery('simple', ${`${root}:*`}))`
                        : Prisma.sql`(to_tsquery('english', ${t}) || to_tsquery('simple', ${`${t}:*`}))`;
                }),
                join
            );
            return prisma.$queryRaw<Array<{ id: string }>>`
                WITH q AS (SELECT ${query} AS "query")
                SELECT t."id" FROM "BuddyThread" t, q
                WHERE t."userId" = ${userId}
                  AND (t."stage" IN ('noticed', 'active', 'committed') OR t."closedAt" >= ${since})
                  AND (t."searchVector" @@ q."query" OR EXISTS (
                        SELECT 1 FROM "BuddyThreadEvent" e
                        WHERE e."threadId" = t."id" AND NOT e."duplicate"
                          AND (to_tsvector('english', e."text") || to_tsvector('simple', e."text")) @@ q."query"))
                ORDER BY ts_rank(COALESCE(t."searchVector", ''::tsvector), q."query") DESC, t."lastSaidAt" DESC, t."id" DESC
                LIMIT ${take}`;
        };
        let rows = await find(' && ');
        if (!rows.length && terms.length > 1) rows = await find(' || ');
        ids = rows.map((r) => r.id);
    }
    if (!ids.length) return [];
    const [threads, events] = await Promise.all([
        prisma.buddyThread.findMany({ where: { userId, id: { in: ids } } }),
        prisma.buddyThreadEvent.findMany({ where: { userId, threadId: { in: ids }, duplicate: false }, orderBy: { saidAt: 'desc' }, take: ids.length * 20 }),
    ]);
    const byId = new Map(threads.map((t) => [t.id, t]));
    return ids.flatMap((id) => {
        const t = byId.get(id);
        if (!t) return [];
        return [
            {
                _id: t.id,
                title: t.title,
                stage: t.stage,
                sensitive: t.sensitive,
                rhythm: t.rhythm,
                firstDay: fromDbDay(t.firstDay),
                lastSaidAt: t.lastSaidAt.toISOString(),
                lookAgainOn: t.lookAgainOn ? fromDbDay(t.lookAgainOn) : null,
                last: events
                    .filter((e) => e.threadId === id)
                    .slice(0, FOUND_EVENTS)
                    .map((e) => ({ day: fromDbDay(e.forDay), kind: e.kind, text: e.text })),
                noAsk: t.noAsk,
                onScreens: t.onScreens,
                quietUntil: t.quietUntil?.toISOString() ?? null,
            },
        ];
    });
}

export interface NewEvent {
    kind: EventKind;
    text: string;
    saidAt: Date;
    forDay: DayString;
    direct: boolean;
    via: string;
    originKey: string;
    receivedAt?: Date;
    /** An import (stage 8): old news whenever it was said. */
    imported?: boolean;
    observationId?: string | null;
    askId?: string | null;
    /** MCP_MEMORY_PLAN §4.4: an assistant's 'said' or 'inferred'; left out: own, or passed on as before. */
    basis?: 'said' | 'inferred' | null;
    /** Said on that day, its time unknown. */
    dayOnly?: boolean;
    /**
     * A catch-up (MCP_MEMORY_PLAN §4.7): the stage ladder is replayed only for words of the last 30 days, and what
     * ended (dropped, finished, paused) ends whenever it was said, so it is known as over.
     */
    replay?: boolean;
}

/** A catch-up replays the stage ladder for words said this recently (§4.7). */
export const REPLAY_MS = 30 * 86_400_000;
const ENDINGS: ReadonlySet<string> = new Set(['dropped', 'finished', 'paused']);

export type EventOutcome = 'added' | 'duplicate' | 'repeat';

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

/**
 * Adds an event to a thread (§4.11): a repeat of the same origin writes nothing; the same thing said
 * twice on one day is kept as a duplicate and changes nothing; anything else raises the revision
 * (whenever it arrives: it withdraws what was written before it), and, when it is his newest word
 * about the thread, may move its stage.
 */
/**
 * The same thing said twice (§4.11 rule 4), against the day's other statements (pure). A day's
 * statement (done, skipped) repeats only what the day already says at that moment: his own word is
 * compared with his latest own word before it, so done, then skipped, then done again is a correction
 * each time (rule 6), never a duplicate; a passed-on one repeats any earlier one of its kind. Any other
 * event repeats an earlier one of its kind in the same words.
 */
export function isDuplicate(
    kind: EventKind,
    text: string,
    saidAt: Date,
    direct: boolean,
    sameDay: ReadonlyArray<{ kind: string; text: string; saidAt: Date; direct: boolean; basis?: string | null }>,
    basis: string | null = null
): boolean {
    // A passed-on word (an agent's note) of what her own words already said of that day is the same thing.
    if (!direct && sameDay.some((e) => e.direct && sameDayNews(e.kind, kind))) return true;
    if (!DAY_KINDS.has(kind)) {
        const key = memoryKey(text);
        return sameDay.some((e) => e.kind === kind && memoryKey(e.text) === key);
    }
    // MCP_MEMORY_PLAN §4.4: what an assistant passed on as said weighs as their own word here. Their own word heard by
    // Recollect is compared with its own kind only, so it stands over a said copy (which then becomes the duplicate).
    const theirs = weighs({ direct, basis });
    const earlier = sameDay.filter((e) => DAY_KINDS.has(e.kind as EventKind) && e.saidAt.getTime() <= saidAt.getTime() && (!theirs || (direct ? e.direct : weighs(e))));
    if (!theirs) return earlier.some((e) => e.kind === kind);
    const last = [...earlier].sort((a, b) => b.saidAt.getTime() - a.saidAt.getTime())[0];
    return last?.kind === kind;
}

export async function addThreadEvent(tx: TxClient, userId: string, thread: BuddyThread, ev: NewEvent, now: Date = new Date()): Promise<EventOutcome> {
    // Clocks (§4.11 rule 8): a time later than its arrival takes the arrival time.
    const receivedAt = ev.receivedAt ?? now;
    const saidAt = ev.saidAt.getTime() > receivedAt.getTime() ? receivedAt : ev.saidAt;
    const known = await tx.buddyThreadEvent.findUnique({ where: { userId_originKey: { userId, originKey: ev.originKey } }, select: { id: true } });
    if (known) return 'repeat';
    const sameDay = await tx.buddyThreadEvent.findMany({ where: { threadId: thread.id, forDay: toDbDay(ev.forDay), duplicate: false }, select: { id: true, kind: true, text: true, saidAt: true, direct: true, basis: true } });
    const duplicate = isDuplicate(ev.kind, ev.text, saidAt, ev.direct, sameDay, ev.basis ?? null);
    // Her own word arriving after an agent's note of the same news that day: hers stands, the passed-on one becomes
    // the duplicate (an agent's note is read at once, her session's words ten minutes later).
    if (ev.direct && !duplicate) {
        const passedOn = sameDay.filter((e) => !e.direct && sameDayNews(e.kind, ev.kind)).map((e) => e.id);
        if (passedOn.length) await tx.buddyThreadEvent.updateMany({ where: { id: { in: passedOn } }, data: { duplicate: true } });
    }
    await tx.buddyThreadEvent.create({
        data: {
            userId,
            threadId: thread.id,
            kind: ev.kind,
            text: clip(ev.text.replace(/\s+/g, ' ').trim(), 200),
            saidAt,
            receivedAt,
            forDay: toDbDay(ev.forDay),
            direct: ev.direct,
            duplicate,
            via: ev.via.slice(0, 20),
            originKey: ev.originKey.slice(0, 160),
            observationId: ev.observationId ?? null,
            askId: ev.askId ?? null,
            basis: ev.basis ?? null,
            dayOnly: ev.dayOnly ?? false,
        },
        select: { id: true },
    });
    if (duplicate) return 'duplicate';
    // An inference is history and a marked note for the night (§4.4, R7): it never moves a stage, never counts as the
    // newest word, and withdraws nothing.
    if (ev.basis === 'inferred') return 'added';
    // The newest word (or a tie): it may move the stage. An older one that arrived late only joins the history,
    // and so does old news (said over 48 hours before it arrived, or imported): it never moves a stage, so it
    // never starts a question; it still withdraws what was written about the thread before it (§4.11 rule 7).
    const newest = saidAt.getTime() >= thread.lastSaidAt.getTime();
    const oldNews = ev.imported === true || receivedAt.getTime() - saidAt.getTime() > (ev.replay ? REPLAY_MS : OLD_NEWS_MS);
    const stage = newest && (!oldNews || (ev.replay && ENDINGS.has(ev.kind))) ? nextStage(thread.stage, ev.kind, { firstDay: fromDbDay(thread.firstDay), forDay: ev.forDay }) : (thread.stage as ThreadStage);
    const closing = !isOpen(stage);
    await tx.buddyThread.update({
        where: { id: thread.id },
        data: {
            revision: { increment: 1 },
            ...(newest ? { lastSaidAt: saidAt } : {}),
            ...(stage !== thread.stage ? { stage, closedAt: closing ? now : null } : {}),
        },
        select: { id: true },
    });
    return 'added';
}

export interface NewThread {
    title: string;
    keywords?: string[];
    sensitive?: boolean;
    lookAgainOn?: DayString | null;
    rhythm?: 'none' | 'daily' | 'weekly';
    memoryId?: string | null;
    /** Stage 5b: a one-time event on its day (lookAgainOn), and its time of day in minutes when said. */
    event?: boolean;
    eventMinute?: number | null;
}

/**
 * Opens a thread, or finds the one it is (§4.12): a thread of this person, open or closed in the last
 * 180 days, whose words overlap enough is the same thread (a closed one opens again with its steers,
 * through its first new event). Returns the thread and whether it was found rather than made.
 */
export async function openOrFindThread(tx: TxClient, userId: string, input: NewThread, first: { saidAt: Date; forDay: DayString }, now: Date = new Date()): Promise<{ thread: BuddyThread; found: boolean }> {
    const title = clip(input.title.replace(/\s+/g, ' ').trim(), 120);
    const keywords = [...new Set((input.keywords ?? []).map((k) => k.toLowerCase().trim()).filter(Boolean))].slice(0, 8);
    const index = await threadIndex(userId, now, tx);
    let best: { id: string; score: number } | null = null;
    for (const t of index) {
        const score = overlap({ title, keywords }, t);
        // A dated event (its own day) is never folded into a thread without that day by shared words alone
        // ("mock interview on Thursday" into "prepare for backend interviews"): its day would be lost (the week's
        // simulation, 11-18). Only a near-identical one counts.
        const datedApart = !!input.lookAgainOn && t.lookAgainOn !== input.lookAgainOn && score < DATED_SAME_THREAD;
        if (score >= SAME_THREAD && !datedApart && (!best || score > best.score)) best = { id: t.id, score };
    }
    if (best) return { thread: await tx.buddyThread.findUniqueOrThrow({ where: { id: best.id } }), found: true };
    // The ceiling (§4.12): the oldest quiet `noticed` thread with no day fades to make room.
    const open = index.filter((t) => isOpen(t.stage));
    if (open.length >= OPEN_MAX) {
        const oldest = [...open].reverse().find((t) => t.stage === 'noticed' && !t.lookAgainOn);
        if (!oldest) throw new Error('every open thread is active or committed: the night is told to tidy');
        await tx.buddyThread.update({ where: { id: oldest.id }, data: { stage: 'dropped', closedAt: now, revision: { increment: 1 } }, select: { id: true } });
    }
    const thread = await tx.buddyThread.create({
        data: {
            userId,
            title,
            keywords,
            sensitive: input.sensitive ?? false,
            lookAgainOn: input.lookAgainOn ? toDbDay(input.lookAgainOn) : null,
            rhythm: input.rhythm ?? 'none',
            event: input.event === true && !!input.lookAgainOn,
            eventMinute: input.event === true && input.lookAgainOn ? (input.eventMinute ?? null) : null,
            memoryId: input.memoryId ?? null,
            lastSaidAt: first.saidAt,
            firstDay: toDbDay(first.forDay),
        },
    });
    return { thread, found: false };
}

// ─── His controls (§4.9, stage 5: /you's "On my mind") ─────────────────────

export interface ThreadDetail extends ThreadFound {
    steer: string | null;
    history: Array<{ day: string; kind: string; text: string; direct: boolean; via: string }>;
}

/** One of his threads with its whole history (oldest first; duplicates left out). */
export async function threadDetail(userId: string, id: string): Promise<ThreadDetail | null> {
    const t = await prisma.buddyThread.findFirst({ where: { id, userId } });
    if (!t) return null;
    const events = await prisma.buddyThreadEvent.findMany({ where: { threadId: t.id, duplicate: false }, orderBy: { saidAt: 'asc' }, take: 200 });
    return {
        _id: t.id,
        title: t.title,
        stage: t.stage,
        sensitive: t.sensitive,
        rhythm: t.rhythm,
        firstDay: fromDbDay(t.firstDay),
        lastSaidAt: t.lastSaidAt.toISOString(),
        lookAgainOn: t.lookAgainOn ? fromDbDay(t.lookAgainOn) : null,
        last: [...events].reverse().slice(0, FOUND_EVENTS).map((e) => ({ day: fromDbDay(e.forDay), kind: e.kind, text: e.text })),
        noAsk: t.noAsk,
        onScreens: t.onScreens,
        quietUntil: t.quietUntil?.toISOString() ?? null,
        steer: t.steer,
        history: events.map((e) => ({ day: fromDbDay(e.forDay), kind: e.kind, text: e.text, direct: e.direct, via: e.via })),
    };
}

export interface ThreadPatch {
    /** Ask me less: quiet for 14 days. */
    askLess?: true | undefined;
    /** Don't ask me about it (until he says otherwise). */
    noAsk?: boolean | undefined;
    /** May its words show on his lock and home screen. */
    onScreens?: boolean | undefined;
    /** Drop it (closed, still in view to be opened again), pause it, or pick it up again. */
    stage?: 'dropped' | 'paused' | 'active' | undefined;
}

/**
 * His control on a thread, under his lock. Each raises the revision, so whatever was written about it
 * before is withdrawn at once; dropping or pausing keeps it in view, to be opened again with his steers.
 */
export async function updateThreadByUser(userId: string, id: string, patch: ThreadPatch, now: Date = new Date()): Promise<ThreadDetail | null> {
    const done = await withPersonLock(userId, async (tx) => {
        const t = await tx.buddyThread.findFirst({ where: { id, userId } });
        if (!t) return false;
        const stage = patch.stage;
        await tx.buddyThread.update({
            where: { id: t.id },
            data: {
                revision: { increment: 1 },
                ...(patch.askLess ? { quietUntil: new Date(now.getTime() + 14 * 86_400_000) } : {}),
                ...(patch.noAsk !== undefined ? { noAsk: patch.noAsk } : {}),
                ...(patch.onScreens !== undefined ? { onScreens: patch.onScreens } : {}),
                ...(stage ? { stage, closedAt: stage === 'active' ? null : now, ...(stage === 'active' ? { quietUntil: null } : {}) } : {}),
            },
            select: { id: true },
        });
        // The step he took is part of its history (his own act).
        await tx.buddyThreadEvent.create({
            data: {
                userId,
                threadId: t.id,
                kind: stage === 'dropped' ? 'dropped' : stage === 'paused' ? 'paused' : stage === 'active' ? 'resumed' : 'steer',
                text: stage ? `On /you: ${stage === 'active' ? 'picked up again' : stage}` : `On /you: ${patch.askLess ? 'ask me less' : patch.noAsk === true ? "don't ask" : patch.noAsk === false ? 'ask again' : patch.onScreens === false ? 'keep off my screens' : 'may show on my screens'}`,
                saidAt: now,
                receivedAt: now,
                forDay: toDbDay(dayOf(now, 'UTC')),
                direct: true,
                via: 'you',
                originKey: `you:${t.id}:${now.getTime()}`,
            },
            select: { id: true },
        });
        return true;
    });
    // What he changed may withdraw today's words: a pulse on it may fall due (§4.13).
    if (done) poke('buddy');
    return done ? threadDetail(userId, id) : null;
}

/** He adds a thread himself on /you: committed at once (his own act, §4.1). An existing one with the same words is returned instead. */
export async function addThreadByUser(userId: string, title: string, now: Date = new Date()): Promise<ThreadDetail> {
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120);
    const keywords = [...new Set(memoryKey(clean).split(' ').filter((w) => w.length > 2))].slice(0, 8);
    const id = await withPersonLock(userId, async (tx) => {
        const { thread } = await openOrFindThread(tx, userId, { title: clean, keywords }, { saidAt: now, forDay: dayOf(now, 'UTC') }, now);
        await tx.buddyThread.update({ where: { id: thread.id }, data: { stage: 'committed', closedAt: null, revision: { increment: 1 } }, select: { id: true } });
        return thread.id;
    });
    return (await threadDetail(userId, id))!;
}

/** Forget a thread for good (its history and its questions go with it). */
export async function forgetThread(userId: string, id: string): Promise<boolean> {
    const r = await prisma.buddyThread.deleteMany({ where: { id, userId } });
    return r.count > 0;
}

/** A noticed thread with no day of its own fades after this many quiet days (§4.12, as the old thread memories did). */
export const NOTICED_QUIET_DAYS = 45;

/**
 * Quiet noticed threads fade (§4.12): mentioned once, no day of their own, nothing said about them for
 * 45 days. They close (dropped, by code, with no word of his), stay in view 180 days, and a new word
 * about one opens it again. Never an active or committed one, never one with a day. Under the person's lock.
 */
export async function fadeQuietThreads(userId: string, now: Date = new Date()): Promise<number> {
    const quietSince = new Date(now.getTime() - NOTICED_QUIET_DAYS * 86_400_000);
    const r = await withPersonLock(userId, (tx) =>
        tx.buddyThread.updateMany({ where: { userId, stage: 'noticed', lookAgainOn: null, lastSaidAt: { lt: quietSince } }, data: { stage: 'dropped', closedAt: now, revision: { increment: 1 } } })
    );
    return r.count;
}

/** Stage 5b: an event thread closes by itself this many days after its day ("it happened"). */
export const EVENT_CLOSE_DAYS = 7;

/**
 * Stage 5b (ECOSYSTEM_V2_PLAN, A5): an event thread whose day passed a week ago closes by itself as done ("it
 * happened"): it stays in view and findable, and nothing asks about it again. A new day said for it has moved its
 * day already, so only the ones truly past close. Under the person's lock, at the start of each night.
 */
export async function closePastEvents(userId: string, today: DayString, now: Date = new Date()): Promise<number> {
    const before = toDbDay(addDays(today, -EVENT_CLOSE_DAYS));
    return withPersonLock(userId, async (tx) => {
        const past = await tx.buddyThread.findMany({ where: { userId, event: true, stage: { in: [...OPEN_STAGES] }, lookAgainOn: { lte: before } }, select: { id: true, lookAgainOn: true } });
        for (const t of past) {
            await tx.buddyThread.update({ where: { id: t.id }, data: { stage: 'done', closedAt: now, revision: { increment: 1 } }, select: { id: true } });
            await tx.buddyThreadEvent.create({
                data: { userId, threadId: t.id, kind: 'finished', text: 'Its day passed a week ago: closed by itself', saidAt: now, receivedAt: now, forDay: toDbDay(today), direct: false, via: 'buddy', originKey: `event-closed:${t.id}:${fromDbDay(t.lookAgainOn!)}` },
                select: { id: true },
            });
        }
        return past.length;
    });
}

/** A thread's events of one day, for the day's state (§4.11). */
export async function eventsOn(threadId: string, day: DayString, db: TxClient | typeof prisma = prisma): Promise<BuddyThreadEvent[]> {
    return db.buddyThreadEvent.findMany({ where: { threadId, forDay: toDbDay(day) }, orderBy: { saidAt: 'asc' } });
}

/** What a step or an item rests on: each thread with the revision its writer saw (§4.5). */
export interface About {
    threadId: string;
    rev: number;
}

export function parseAbout(value: Prisma.JsonValue | undefined | null): About[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((v) => {
        const o = v as { threadId?: unknown; rev?: unknown } | null;
        return o && typeof o.threadId === 'string' && typeof o.rev === 'number' ? [{ threadId: o.threadId, rev: o.rev }] : [];
    });
}

/**
 * Stage 3's copy (ECOSYSTEM_V2_PLAN §10.1): each open `thread` memory of an account becomes a thread,
 * with its notes as history. The memories stay as they are, so switching the loop off goes back to
 * today's behaviour at once. Safe to run again (a memory already copied is skipped).
 */
export async function copyThreadMemories(userId: string, now: Date = new Date()): Promise<{ copied: number }> {
    const memories = await prisma.memory.findMany({ where: { userId, kind: 'thread', status: { in: ['active', 'faded'] } }, include: { observations: { orderBy: { createdAt: 'asc' }, take: 20 } } });
    const done = new Set((await prisma.buddyThread.findMany({ where: { userId, memoryId: { in: memories.map((m) => m.id) } }, select: { memoryId: true } })).map((t) => t.memoryId));
    let copied = 0;
    for (const m of memories) {
        if (done.has(m.id)) continue;
        await withPersonLock(userId, async (tx) => {
            const first = m.observations[0];
            const thread = await tx.buddyThread.create({
                data: {
                    userId,
                    title: clip(m.text.replace(/\s+/g, ' ').trim(), 120),
                    stage: m.seenCount > 1 ? 'active' : 'noticed',
                    sensitive: m.sensitivity === 'private',
                    memoryId: m.id,
                    lastSaidAt: m.updatedAt,
                    firstDay: m.firstSeenDay,
                },
            });
            for (const o of m.observations) {
                await tx.buddyThreadEvent.create({
                    data: { userId, threadId: thread.id, kind: 'said', text: clip(o.text, 200), saidAt: o.saidAt ?? o.createdAt, receivedAt: o.createdAt, forDay: o.day, direct: o.source !== 'agent', via: o.via ?? o.source, observationId: o.id, originKey: `memory:${m.id}:${o.id}` },
                    select: { id: true },
                });
            }
            if (!first) {
                await tx.buddyThreadEvent.create({ data: { userId, threadId: thread.id, kind: 'said', text: clip(m.text, 200), saidAt: m.createdAt, forDay: m.firstSeenDay, direct: m.source !== 'agent', via: String(m.source), originKey: `memory:${m.id}` }, select: { id: true } });
            }
        });
        copied++;
    }
    void now;
    return { copied };
}

/** Why a copied thread memory closed when the loop's switch came off (the undo finds it by this). */
export const MOVED_REASON = 'moved to On my mind';

/**
 * When the loop's switch comes off (§10.1, stage 5 accepted): each open `thread` memory that has a thread made
 * from it closes, "moved to On my mind" (its old status kept in the reason, for the undo). A thread memory with
 * no thread is left as it is.
 */
export async function closeCopiedMemories(userId: string, today: DayString, opts: { dryRun?: boolean } = {}): Promise<{ closed: number }> {
    const copied = await prisma.buddyThread.findMany({ where: { userId, memoryId: { not: null } }, select: { memoryId: true } });
    const memories = await prisma.memory.findMany({ where: { userId, id: { in: copied.map((t) => t.memoryId!) }, kind: 'thread', status: { in: ['active', 'faded'] } }, select: { id: true, status: true } });
    if (opts.dryRun) return { closed: memories.length };
    for (const m of memories) await prisma.memory.update({ where: { id: m.id }, data: { status: 'closed', closedDay: toDbDay(today), closeReason: `${MOVED_REASON} (was ${m.status})` }, select: { id: true } });
    return { closed: memories.length };
}

/** closeCopiedMemories' undo: each memory it closed is as it was (active or faded) again. */
export async function undoCloseCopiedMemories(userId: string): Promise<{ reopened: number }> {
    const rows = await prisma.memory.findMany({ where: { userId, status: 'closed', closeReason: { startsWith: MOVED_REASON } }, select: { id: true, closeReason: true } });
    for (const m of rows) await prisma.memory.update({ where: { id: m.id }, data: { status: /\(was faded\)$/.test(m.closeReason ?? '') ? 'faded' : 'active', closedDay: null, closeReason: null }, select: { id: true } });
    return { reopened: rows.length };
}

/** The copy's undo: the threads made from memories are deleted (with their history); the memories never changed. */
export async function undoThreadCopy(userId: string): Promise<{ deleted: number }> {
    const { count } = await prisma.buddyThread.deleteMany({ where: { userId, memoryId: { not: null } } });
    return { deleted: count };
}
