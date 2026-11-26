// The record (MCP_MEMORY_PLAN §4.2-§4.6): what connected assistants save and change, kept true by code with no
// model call. update_memory's rules (progress strengthens one memory; a said change replaces the old version,
// with Undo; an older statement arriving late joins the history; two versions of one day in an unknown order are
// never guessed: the current one stays, marked "check"; an inference only ever adds a marked note), and the
// "Related" and "In motion" lists every answer carries, so one app sees what another saved or corrected.
//
//   updateRecord     POST /api/buddy/update {on, update, text, saidOn?, inferred?}
//   relatedTo        the answers' "Related": memories and threads that share the words
//   inMotionOf       the answers' and the buddy brief's "In motion"
import type { BuddySource, BuddyThread, Memory, MemoryKind } from '@prisma/client';
import { prisma, type TxClient } from '../../db/prisma';
import { directSaveChangesToday, stampToday } from './liveDay';
import ErrorResponse from '../../utils/errorResponse';
import { addDays, type DayString } from '../learning';
import { badRequest } from '../learning/http';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { quoted, recordAgentEdit, type AgentActor } from '../agent/agentEditLog';
import { chainHead, cleanNoteText, memoriesSharingWords, memoryKey, rememberNotes, serializeMemory, type MemoryJson, type NoteOutcome } from './memory.service';
import {
    aboutThing,
    contentWords,
    dayNewsOn,
    laterOf,
    MAY_REPLACE_MIN_SHARED,
    related,
    saidTimeOf,
    shapeOf,
    soundsLikeChange,
    soundsRoutine,
    topicCover,
    topicOverlap,
    topicStems,
    updateFromWords,
    wordMatch,
    type Basis,
    type SaidTime,
    type Statement,
    type StoredUpdateKind,
    type UpdateKind,
} from './recordRules';
import { isBuddyPaused } from './state.service';
import { overlap, withPersonLock } from './threads';
import { workForWebBrief, type WebWorkBrief } from './work';

export interface RecordWriter {
    actor: AgentActor;
    source: BuddySource;
    /** 'connector' (a signed-in app), 'agent' (a token), 'app' (the person in Kaaga). */
    via: string | null;
    sessionKey?: string | null | undefined;
    project?: string | null | undefined;
}

export interface UpdateInput {
    /** The id of the known thing: a memory or a thread. */
    on: string;
    update: UpdateKind;
    text: string;
    saidOn?: string | null | undefined;
    inferred?: boolean | undefined;
}

export type UpdateOutcome =
    /** A note on it and nothing else (an inference, a pause, or something closed). */
    | 'noted'
    /** Progress or a mention: seen again. */
    | 'seen'
    /** The change says what it already says: seen again. */
    | 'already'
    /** A said change: the new version replaced it (Undo on Home). */
    | 'replaced'
    /** Said before the current version: kept as history, nothing replaced (R4). */
    | 'history'
    /** Said on the current version's day in an unknown order: the current version stays, marked "check". */
    | 'check'
    /** Dropped or finished: closed (Undo on Home). */
    | 'closed'
    /** Resumed: active again. */
    | 'reopened'
    /** On a thread: the same thing again (that day, or the same call): nothing new. */
    | 'repeat'
    /** Not about the thing it named (its words share nothing with it): kept as its own note instead, the thing untouched. */
    | 'apart';

export interface Provenance {
    text: string;
    day: DayString;
    app: string;
}

export interface UpdateResult {
    paused: boolean;
    target?: 'memory' | 'thread';
    outcome?: UpdateOutcome;
    /** The current version after the update. */
    memory?: MemoryJson;
    /** The version it replaced or closed. */
    replaced?: MemoryJson | null;
    /** The stale id it was given, when the chain led to a newer version. */
    movedFrom?: string | null;
    /** For history and check: the version that stays, with when and where it came from. */
    current?: Provenance | null;
    editId?: string | null;
    /** On a thread: the thread after it. */
    thread?: { _id: string; title: string; stage: string };
    /** Apart: the thing it named, and what became of the words (a new note, or one already known). */
    apart?: { from: { _id: string; text: string }; note: NoteOutcome };
    /** The words named something other than the kind chosen (one day's doing, not a change or an end): recorded as `to`. */
    readAs?: { from: UpdateKind; to: UpdateKind };
}

/** Where a memory came from, in a word an assistant can repeat. */
export function appOf(m: Pick<Memory, 'source' | 'agentName'>): string {
    if (m.agentName) return m.agentName;
    switch (m.source) {
        case 'app':
        case 'tell':
        case 'feedback':
            return 'Kaaga';
        case 'hook':
            return 'Claude Code';
        case 'buddy':
            return 'the buddy';
        default:
            return 'an agent';
    }
}

// ─── The current version's own statements ─────────────────────────────────────

/** Notes that support a memory's current text: their words or an update on it, not an inference, not history. */
async function supportOf(db: TxClient | typeof prisma, m: Memory): Promise<Statement[]> {
    const notes = await db.observation.findMany({
        where: {
            memoryId: m.id,
            AND: [{ OR: [{ basis: null }, { basis: 'said' }] }, { OR: [{ updateKind: null }, { updateKind: { notIn: ['history', 'unclear'] } }] }],
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { saidAt: true, dayOnly: true, createdAt: true },
    });
    const out: Statement[] = notes.map((n) => ({ at: n.saidAt ?? n.createdAt, dayOnly: n.dayOnly, arrivedAt: n.createdAt }));
    // The person's own edit on /you is a statement too; a memory with no notes stands from when it was made.
    if (m.byUser) out.push({ at: m.updatedAt, dayOnly: false, arrivedAt: m.updatedAt });
    if (!out.length) out.push({ at: m.createdAt, dayOnly: false, arrivedAt: m.createdAt });
    return out;
}

/** 1 when the new statement surely came after every statement of the current version, -1 when one of them surely came after it, 0 when nobody can know. */
export function againstSupport(incoming: Statement, support: readonly Statement[]): 1 | -1 | 0 {
    if (support.some((s) => laterOf(s, incoming) === 1)) return -1;
    return support.every((s) => laterOf(incoming, s) === 1) ? 1 : 0;
}

function provenance(m: Memory, said?: { day: DayString }): Provenance {
    return { text: m.text, day: said?.day ?? fromDbDay(m.lastSeenDay), app: appOf(m) };
}

const monthOf = (day: DayString): string => day.slice(0, 7);

function seenOn(m: Pick<Memory, 'firstSeenDay' | 'lastSeenDay' | 'monthsSeen'>, day: DayString) {
    return {
        seenCount: { increment: 1 },
        ...(day > fromDbDay(m.lastSeenDay) ? { lastSeenDay: toDbDay(day) } : {}),
        ...(day < fromDbDay(m.firstSeenDay) ? { firstSeenDay: toDbDay(day) } : {}),
        ...(m.monthsSeen.includes(monthOf(day)) ? {} : { monthsSeen: [...m.monthsSeen, monthOf(day)] }),
    };
}

const CLOSE_REASON_MAX = 200;
/** "Changed: now Walks in the mornings", "Finished: Learned enough about RAG for now". */
const reasonOf = (lead: string, text: string) => (lead.endsWith('now') ? `${lead} ${text}` : `${lead}: ${text}`).slice(0, CLOSE_REASON_MAX);

// ─── update_memory ───────────────────────────────────────────────────────────

/**
 * Progress on, a change to, or the end of something known (§4.3). `on` names a memory (any version: the chain is
 * followed to the newest) or a thread (stage 2). Paused: nothing is kept. Every write is under the person's lock.
 */
export async function updateRecord(w: RecordWriter, input: UpdateInput, now: Date = new Date()): Promise<UpdateResult> {
    const userId = w.actor.userId;
    if (await isBuddyPaused(userId)) return { paused: true };
    const ctx = await loadLearningContext(userId, now);
    const text = cleanNoteText(input.text);
    if (!text || !memoryKey(text)) throw badRequest('Say what they said (text)');
    const said = saidTimeOf(input.saidOn, ctx, now);
    const basis: Basis = input.inferred ? 'inferred' : 'said';
    // Stage 18: news passed on as their word that names today changes today (a pulse follows within minutes).
    if (basis === 'said' && directSaveChangesToday(text, said, now, ctx.tz, ctx.today)) await stampToday(userId, ctx.today, now, text);
    const found = await prisma.memory.findFirst({ where: { id: input.on, userId } });
    if (!found) {
        const thread = await prisma.buddyThread.findFirst({ where: { id: input.on, userId } });
        if (thread) {
            // An inference only ever adds a marked note (R7): the words are checked on the person's own statements.
            const words = basis === 'said' ? await checkWords({ type: 'thread', row: thread }, input.update, text, ctx.today) : { apart: false as const, update: input.update };
            if (words.apart) return keepApart(w, input, text, { _id: thread.id, text: thread.title }, now);
            const { updateThreadRecord } = await import('./recordThreads');
            const r = await updateThreadRecord(w, { ...input, text, update: words.update }, said, basis, ctx, now);
            return words.update !== input.update ? { ...r, readAs: { from: input.update, to: words.update } } : r;
        }
        throw new ErrorResponse(404, 'Nothing with that id: look it up with recall_memory (or take the id from get_brief)');
    }
    let update = input.update;
    if (basis === 'said') {
        const head = await chainHead(userId, found);
        const words = await checkWords({ type: 'memory', row: head }, input.update, text, ctx.today);
        if (words.apart) return keepApart(w, input, text, { _id: head.id, text: head.text }, now);
        update = words.update;
    }
    const r = await withPersonLock(userId, (tx) => updateMemoryRecord(tx, w, input.on, update, text, said, basis, now));
    return update !== input.update ? { ...r, readAs: { from: input.update, to: update } } : r;
}

// ─── The words, checked (after the live hour, 11-19) ────────────────────────

/** Day news: what one day of a thing's doing is recorded as. */
const DAY_NEWS = ['done', 'progress', 'skipped'];

/**
 * A thing's own words: a thread's title, search words and the day news said on it; a memory's text, the version it
 * replaced and the day news noted on it. Changes and ends are left out, so a misfiled one never widens it.
 */
async function vocabularyOf(target: { type: 'thread'; row: BuddyThread } | { type: 'memory'; row: Memory }): Promise<string> {
    if (target.type === 'thread') {
        const t = target.row;
        const [events, memory] = await Promise.all([
            prisma.buddyThreadEvent.findMany({ where: { threadId: t.id, duplicate: false, kind: { in: DAY_NEWS }, OR: [{ basis: null }, { basis: { not: 'inferred' } }] }, orderBy: { saidAt: 'desc' }, take: 20, select: { text: true } }),
            t.memoryId ? prisma.memory.findFirst({ where: { id: t.memoryId }, select: { text: true } }) : Promise.resolve(null),
        ]);
        return [t.title, ...t.keywords, memory?.text ?? '', ...events.map((e) => e.text)].join(' ');
    }
    const m = target.row;
    const [older, notes] = await Promise.all([
        m.supersedesId ? prisma.memory.findFirst({ where: { id: m.supersedesId }, select: { text: true } }) : Promise.resolve(null),
        prisma.observation.findMany({ where: { memoryId: m.id, updateKind: { in: DAY_NEWS }, OR: [{ basis: null }, { basis: { not: 'inferred' } }] }, orderBy: { createdAt: 'desc' }, take: 20, select: { text: true } }),
    ]);
    return [m.text, older?.text ?? '', ...notes.map((n) => n.text)].join(' ');
}

/** Whether a thing recurs (a habit, a daily or weekly thread): one day's "finished" is that day's doing, not its end. */
async function recurs(target: { type: 'thread'; row: BuddyThread } | { type: 'memory'; row: Memory }, today: DayString): Promise<boolean> {
    if (target.type === 'memory') return target.row.kind === 'pattern' || soundsRoutine(target.row.text);
    const t = target.row;
    if (t.rhythm !== 'none' || soundsRoutine(t.title)) return true;
    // Day news said on an earlier day: it comes back day after day.
    return (await prisma.buddyThreadEvent.count({ where: { threadId: t.id, duplicate: false, kind: { in: DAY_NEWS }, forDay: { lt: toDbDay(today) } } })) > 0;
}

/** The update the person's words support on this thing: apart (not about it), or the kind to apply (§4.3, pure rules in recordRules). */
async function checkWords(
    target: { type: 'thread'; row: BuddyThread } | { type: 'memory'; row: Memory },
    update: UpdateKind,
    text: string,
    today: DayString
): Promise<{ apart: true } | { apart: false; update: UpdateKind }> {
    if (aboutThing(text, await vocabularyOf(target)) === 'no') return { apart: true };
    return { apart: false, update: updateFromWords(update, text, await recurs(target, today)) };
}

/**
 * Not about the thing it named: the words are kept as their own note, dated and sourced as remember keeps them (a
 * routine's words as a habit), and the thing is not touched. With the buddy's AI on, the note is read as any save is;
 * without it, it waits there, and nothing true was overwritten.
 */
async function keepApart(w: RecordWriter, input: UpdateInput, text: string, from: { _id: string; text: string }, now: Date): Promise<UpdateResult> {
    const r = await rememberNotes(
        { userId: w.actor.userId, source: w.source, agentName: w.actor.agentName, sessionKey: w.sessionKey ?? null, project: w.project ?? null, via: w.via },
        [{ text, kind: soundsRoutine(text) ? 'pattern' : undefined, saidOn: input.saidOn, inferred: false }],
        now
    );
    if (r.paused) return { paused: true };
    const note = r.notes[0]!;
    return { paused: false, outcome: 'apart', apart: { from, note }, ...(note.status !== 'empty' ? { memory: note.memory } : {}) };
}

export { DAY_NEWS_COVER, DAY_NEWS_MAX_WORDS } from './recordRules';
const OPEN_STAGES = ['noticed', 'active', 'committed'];
const FOLLOWED_KINDS: MemoryKind[] = ['pattern', 'aim', 'thread'];

/**
 * remember for one day's news about something already followed ("Got my steps in today" while "Walk 10,000 steps a day"
 * is followed; "Had two coffees today, the cutting down isn't going great" while "Cutting down to one coffee a day"
 * is): which thing it is, and the day news, when the words leave no doubt (§4.3 after the live hour; §12.4 B1). A day
 * named, no routine, no end, a short statement (recordRules.dayNewsOn); exactly one open thread it fits (threads first:
 * with the loop on, they are what the buddy follows), or else exactly one active habit, aim or plan, listed in the
 * brief or not. Anything less clear is saved as it came, for the buddy's AI to tie when it can run.
 */
export async function dayNewsTarget(userId: string, text: string): Promise<{ id: string; type: 'thread' | 'memory'; label: string; update: 'done' | 'skipped' | 'progress' } | null> {
    const s = shapeOf(text);
    if (!s.once || s.routine || s.ending || !topicStems(text).size) return null;
    const threads = await prisma.buddyThread.findMany({ where: { userId, stage: { in: OPEN_STAGES } }, select: { id: true, title: true, keywords: true }, take: 200 });
    const onThreads = threads.flatMap((t) => {
        const update = dayNewsOn(text, `${t.title} ${t.keywords.join(' ')}`);
        return update ? [{ id: t.id, type: 'thread' as const, label: t.title, update }] : [];
    });
    if (onThreads.length > 1) return null;
    if (onThreads.length === 1) return onThreads[0]!;
    const memories = await prisma.memory.findMany({ where: { userId, status: 'active', kind: { in: FOLLOWED_KINDS } }, select: { id: true, text: true }, take: 300 });
    const onMemories = memories.flatMap((m) => {
        const update = dayNewsOn(text, m.text);
        return update ? [{ id: m.id, type: 'memory' as const, label: m.text, update }] : [];
    });
    return onMemories.length === 1 ? onMemories[0]! : null;
}

/**
 * New words that may replace one older memory (§12.4 B2): a newly saved memory whose words carry a change, an end or
 * a correction, sharing two or more topic words with exactly one other active, open memory. That one is marked to
 * check (the existing mark: /you's line, recall's `check`, left out of In motion); both are kept, and the answer names
 * it, so the assistant can pass the change on. Never a replacement by code: a wrong one would lose a true memory.
 */
export async function markMayReplace(userId: string, saved: { _id: string; text: string }, now: Date = new Date()): Promise<{ _id: string; text: string } | null> {
    // One day's news ("did not read before bed last night") replaces nothing, whatever its words.
    const s = shapeOf(saved.text);
    if (!soundsLikeChange(saved.text) || (s.once && !s.routine && !s.ending)) return null;
    const candidates = await prisma.memory.findMany({ where: { userId, status: 'active', sensitivity: 'open', id: { not: saved._id } }, select: { id: true, text: true, checkSince: true }, take: 500 });
    const hits = candidates.filter((m) => topicOverlap(saved.text, m.text).shared >= MAY_REPLACE_MIN_SHARED);
    if (hits.length !== 1) return null;
    const old = hits[0]!;
    if (!old.checkSince) await prisma.memory.update({ where: { id: old.id }, data: { checkSince: now } });
    return { _id: old.id, text: old.text };
}

async function updateMemoryRecord(tx: TxClient, w: RecordWriter, on: string, update: UpdateKind, text: string, said: SaidTime, basis: Basis, now: Date): Promise<UpdateResult> {
    const userId = w.actor.userId;
    const target = await tx.memory.findFirstOrThrow({ where: { id: on, userId } });
    if (target.status === 'wrong') throw new ErrorResponse(409, 'The user marked this memory wrong: it is not kept');
    const head = await chainHead(userId, target, tx);
    if (head.status === 'wrong') throw new ErrorResponse(409, 'The user marked the newest version of this memory wrong');
    // His word wins (decision 3): his explicit statement may update a memory he wrote; an inference may not.
    if (head.byUser && basis === 'inferred') throw new ErrorResponse(403, 'The user wrote or changed this memory: an inference cannot change it');
    const base = { paused: false, target: 'memory' as const, movedFrom: head.id !== target.id ? target.id : null };
    const note = (kind: StoredUpdateKind, memoryId: string, memoryKind: MemoryKind = head.kind) =>
        tx.observation.create({
            data: {
                userId,
                text,
                kind: memoryKind,
                sensitivity: head.sensitivity,
                source: w.source,
                agentName: w.actor.agentName,
                sessionKey: w.sessionKey ?? null,
                project: w.project ?? null,
                day: toDbDay(said.day),
                saidAt: said.at,
                dayOnly: said.dayOnly,
                via: w.via,
                basis,
                updateKind: kind,
                memoryId,
            },
            select: { id: true },
        });
    const incoming: Statement = { at: said.at, dayOnly: said.dayOnly, arrivedAt: now };
    // A later statement of theirs settles two versions of one day (the check mark).
    const settles = (m: Memory) => m.checkSince !== null && !said.dayOnly && said.at.getTime() > m.checkSince.getTime();

    // R7: an inference never changes, closes or replaces anything: a marked note until their own words confirm it.
    if (basis === 'inferred') {
        await note(update, head.id);
        return { ...base, outcome: 'noted', memory: serializeMemory(head) };
    }

    const close = async (lead: string, outcome: 'closed' | 'replaced', replacement: { id: string; createdNew: boolean } | null): Promise<{ closed: Memory; editId: string }> => {
        const closed = await tx.memory.update({
            where: { id: head.id },
            data: { status: 'closed', closedDay: toDbDay(said.day), closeReason: reasonOf(lead, text), pinned: false, checkSince: null },
        });
        const editId = await recordAgentEdit(
            w.actor,
            {
                kind: 'memory_close',
                summary: outcome === 'replaced' ? `Changed ${quoted(head.text, 70)} to ${quoted(text, 70)}` : `${lead} ${quoted(head.text, 90)}`,
                entityId: head.id,
                undoData: {
                    before: { status: head.status, closedDay: head.closedDay ? fromDbDay(head.closedDay) : null, closeReason: head.closeReason, pinned: head.pinned },
                    ...(replacement ? { replacedBy: replacement.id, createdNew: replacement.createdNew } : {}),
                },
            },
            tx
        );
        return { closed, editId };
    };

    switch (update) {
        case 'said':
        case 'progress':
        case 'done':
        case 'skipped': {
            // Progress strengthens the one memory and makes no new one (R8). A closed one keeps the note: resumed opens it.
            if (head.status === 'closed') {
                await note(update, head.id);
                return { ...base, outcome: 'noted', memory: serializeMemory(head) };
            }
            const updated = await tx.memory.update({
                where: { id: head.id },
                data: { ...seenOn(head, said.day), ...(head.status === 'faded' ? { status: 'active' } : {}), ...(settles(head) ? { checkSince: null } : {}) },
            });
            await note(update, head.id);
            return { ...base, outcome: 'seen', memory: serializeMemory(updated) };
        }
        case 'paused': {
            await note(update, head.id);
            return { ...base, outcome: 'noted', memory: serializeMemory(head) };
        }
        case 'resumed': {
            if (head.status === 'active') {
                const updated = await tx.memory.update({ where: { id: head.id }, data: { ...seenOn(head, said.day), ...(settles(head) ? { checkSince: null } : {}) } });
                await note(update, head.id);
                return { ...base, outcome: 'already', memory: serializeMemory(updated) };
            }
            // Closed after this was said: it stays closed, and this joins the history.
            if (head.closedDay && said.day < fromDbDay(head.closedDay)) {
                await note('history', head.id);
                return { ...base, outcome: 'history', memory: serializeMemory(head), current: provenance(head) };
            }
            const updated = await tx.memory.update({ where: { id: head.id }, data: { ...seenOn(head, said.day), status: 'active', closedDay: null, closeReason: null } });
            await note(update, head.id);
            return { ...base, outcome: 'reopened', memory: serializeMemory(updated) };
        }
        case 'changed':
        case 'dropped':
        case 'finished': {
            if (update === 'changed' && memoryKey(text) === memoryKey(head.text)) {
                const updated = await tx.memory.update({ where: { id: head.id }, data: { ...seenOn(head, said.day), ...(settles(head) ? { checkSince: null } : {}) } });
                await note('said', head.id);
                return { ...base, outcome: 'already', memory: serializeMemory(updated) };
            }
            if (head.status === 'closed') {
                await note(update === 'changed' ? 'history' : update, head.id);
                return { ...base, outcome: 'noted', memory: serializeMemory(head) };
            }
            const order = againstSupport(incoming, await supportOf(tx, head));
            if (order === -1) {
                // Said before the current version: it joins the history and replaces nothing (R4).
                await note('history', head.id);
                return { ...base, outcome: 'history', memory: serializeMemory(head), current: provenance(head) };
            }
            if (order === 0) {
                // The current version's own day, the order unknown (the owner's case, 11-19): no guess.
                await note('unclear', head.id);
                const marked = await tx.memory.update({ where: { id: head.id }, data: { checkSince: now } });
                return { ...base, outcome: 'check', memory: serializeMemory(marked), current: provenance(head) };
            }
            if (update !== 'changed') {
                const { closed, editId } = await close(update === 'dropped' ? 'Dropped' : 'Finished', 'closed', null);
                await note(update, head.id);
                return { ...base, outcome: 'closed', memory: serializeMemory(closed), replaced: serializeMemory(closed), editId };
            }
            // A said change: a new version replaces it (tags, pin and privacy carried over). The same words as another
            // active memory (a remember made a moment ago) make that one the replacement: no third row.
            const twins = await memoriesSharingWords(userId, text, ['active']);
            const twin = twins.find((m) => m.id !== head.id && m.supersedesId === null && memoryKey(m.text) === memoryKey(text)) ?? null;
            const replacement = twin
                ? await tx.memory.update({ where: { id: twin.id }, data: { ...seenOn(twin, said.day), supersedesId: head.id } })
                : await tx.memory.create({
                      data: {
                          userId,
                          text,
                          kind: head.kind,
                          sensitivity: head.sensitivity,
                          lasting: head.lasting,
                          pinned: head.pinned,
                          tags: head.tags,
                          source: w.source,
                          agentName: w.actor.agentName,
                          firstSeenDay: toDbDay(said.day),
                          lastSeenDay: toDbDay(said.day),
                          monthsSeen: [monthOf(said.day)],
                          supersedesId: head.id,
                      },
                  });
            await note('changed', replacement.id, replacement.kind);
            const { closed, editId } = await close('Changed: now', 'replaced', { id: replacement.id, createdNew: !twin });
            return { ...base, outcome: 'replaced', memory: serializeMemory(replacement), replaced: serializeMemory(closed), editId };
        }
    }
}

// ─── Related, and In motion ──────────────────────────────────────────────────

export interface RelatedMemory {
    _id: string;
    text: string;
    kind: MemoryKind;
    lastSeenDay: DayString;
    app: string;
    /** It shares most of its words (0.6): if the new detail replaces it, update_memory with update changed. */
    looksLikeOld: boolean;
}

export interface ThreadLast {
    day: DayString;
    kind: string;
    text: string;
}

export interface RelatedThread {
    _id: string;
    title: string;
    stage: string;
    last: ThreadLast | null;
}

export interface Related {
    memories: RelatedMemory[];
    threads: RelatedThread[];
}

export const RELATED_MEMORIES = 3;
export const RELATED_THREADS = 2;

/** The newest event of each thread, not a duplicate. */
async function lastEvents(threadIds: readonly string[]): Promise<Map<string, ThreadLast>> {
    if (!threadIds.length) return new Map();
    const events = await prisma.buddyThreadEvent.findMany({
        where: { threadId: { in: [...threadIds] }, duplicate: false },
        orderBy: { saidAt: 'desc' },
        take: threadIds.length * 8,
        select: { threadId: true, kind: true, text: true, forDay: true },
    });
    const out = new Map<string, ThreadLast>();
    for (const e of events) if (!out.has(e.threadId)) out.set(e.threadId, { day: fromDbDay(e.forDay), kind: e.kind, text: e.text });
    return out;
}

/**
 * "Related" (§4.2): at most 3 active memories and 2 open threads that share the detail's words, newest first among
 * equals, never private ones (R12). No model: two word lookups.
 */
export async function relatedTo(userId: string, text: string, exclude: readonly string[] = []): Promise<Related> {
    const skip = new Set(exclude);
    const candidates = (await memoriesSharingWords(userId, text, ['active'], 30, true)).filter((m) => !skip.has(m.id));
    const memories = candidates
        .filter((m) => related(text, m.text))
        .map((m) => ({ m, shared: wordMatch(text, m.text).shared }))
        .sort((a, b) => b.shared - a.shared || (a.m.lastSeenDay < b.m.lastSeenDay ? 1 : -1))
        .slice(0, RELATED_MEMORIES)
        .map(({ m }) => ({ _id: m.id, text: m.text, kind: m.kind, lastSeenDay: fromDbDay(m.lastSeenDay), app: appOf(m), looksLikeOld: overlap({ title: text }, { title: m.text }) >= 0.6 }));
    const words = [...contentWords(text)].filter((w) => w.length >= 4);
    let threads: RelatedThread[] = [];
    if (words.length) {
        const open = await prisma.buddyThread.findMany({
            where: { userId, stage: { in: ['noticed', 'active', 'committed'] }, sensitive: false },
            orderBy: { lastSaidAt: 'desc' },
            take: 200,
            select: { id: true, title: true, stage: true, keywords: true },
        });
        const hits = open
            .filter((t) => related(text, `${t.title} ${t.keywords.join(' ')}`))
            .map((t) => {
                const theirs = contentWords(`${t.title} ${t.keywords.join(' ')}`);
                return { t, shared: words.filter((w) => theirs.has(w)).length };
            })
            .filter((x) => x.shared > 0)
            .sort((a, b) => b.shared - a.shared)
            .slice(0, RELATED_THREADS);
        const last = await lastEvents(hits.map((h) => h.t.id));
        threads = hits.map(({ t }) => ({ _id: t.id, title: t.title, stage: t.stage, last: last.get(t.id) ?? null }));
    }
    return { memories, threads };
}

export interface InMotion {
    _id: string;
    /** A thread the buddy follows (the loop on), or a memory of a kind that moves (the loop off, or no threads yet). */
    type: 'thread' | 'memory';
    text: string;
    stage?: string;
    kind?: MemoryKind;
    last: ThreadLast | null;
    /** A thread whose way of going the person changed since its title was written: their newest change, in their words. */
    now?: { day: DayString; text: string } | null;
}

/**
 * Each thread's newest change in the person's word (theirs, or said through an assistant; never an inference). A change
 * said again later counts as said then: a repeat is stored as a duplicate, but it is still their newest word.
 */
async function newestChanges(threadIds: readonly string[]): Promise<Map<string, { day: DayString; text: string }>> {
    if (!threadIds.length) return new Map();
    const events = await prisma.buddyThreadEvent.findMany({
        where: { threadId: { in: [...threadIds] }, kind: 'changed', OR: [{ direct: true }, { basis: 'said' }] },
        orderBy: { saidAt: 'desc' },
        take: threadIds.length * 3,
        select: { threadId: true, text: true, forDay: true },
    });
    const out = new Map<string, { day: DayString; text: string }>();
    for (const e of events) if (!out.has(e.threadId)) out.set(e.threadId, { day: fromDbDay(e.forDay), text: e.text });
    return out;
}

// ─── The buddy brief (§4.6) ─────────────────────────────────────────────────

export interface BuddyView {
    now: { day: DayString; weekday: string; time: string; timezone: string };
    who: string | null;
    inMotion: InMotion[];
    savedLately: Array<{ text: string; day: DayString; app: string; update: string | null }>;
    asks: Array<{ _id: string; threadId: string | null; text: string; answers: string[] }>;
    howTo: string[];
    /** ECOSYSTEM_V2_PLAN stage 12: their work as connected chats see it (null while the work log is off). */
    work: WebWorkBrief | null;
}

/**
 * Stage 12 (§12.5): the brief's work rule, only while the work log is on. Stage 13: one line per result (the others of
 * one message in more); the owner parked the "Did that fix it?" ask: their own word that it is done is what logs it.
 */
export const WORK_HOW_TO =
    "Work: log what they confirm done, decide or leave open (log_work, one line per result; the others of one message in more). News on a line below goes with its id in on. Already below: don't log it again. A draft, a plan or a fix they are about to try is not logged; when their own words say it is done (fixed, shipped, sent, merged, works now), log it. Studying or going through a doc to understand it is not work; a project decision or something finished still is.";

export const WHO_MAX = 200;
export const SAVED_LATELY_MAX = 3;
export const SAVED_LATELY_DAYS = 7;
export const BRIEF_ASKS_MAX = 2;
export const HOW_TO = [
    "Pass on what the user says about their own life, even mid-chat: news about one of these with update_memory and its id (one day's doing is done or skipped, never a change); anything else is new: remember.",
    // §12.4 C: an end or a correction of something not listed (the ride, the allergy) needs its id: found first.
    'If they end or correct something not listed: find it with recall_memory, then update_memory on its id. Read this again when a chat goes on on a later day.',
    // Stage 15's live hour: claude.ai explained "my sliding window note" without ever reading it (0/4), so no offer came.
    "'My note' or 'my doc' means one of their docs here: search_docs with its words and read_doc before you explain it, and answer from it. When a part took real work to explain, offer once to add it under its heading.",
];

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * The buddy brief: what the web's get_brief returns (§4.6), about 1,400 characters at most. Its work never grows with
 * history: the portrait row, In motion (capped lookups), the last 3 saves of the week, at most 2 open questions. Never
 * private: private memories, sensitive threads and their questions stay out (R12). Reading it marks the questions
 * shown, as the brief always has.
 */
export async function buddyView(userId: string, now: Date = new Date()): Promise<BuddyView> {
    const ctx = await loadLearningContext(userId, now);
    const { openAsks } = await import('./asks');
    const [state, inMotion, saved, asks, work] = await Promise.all([
        prisma.buddyState.findUnique({ where: { userId }, select: { who: true } }),
        inMotionOf(userId, now),
        prisma.observation.findMany({
            where: { userId, sensitivity: 'open', source: { in: ['agent', 'app'] }, createdAt: { gte: new Date(now.getTime() - SAVED_LATELY_DAYS * 86_400_000) }, OR: [{ basis: null }, { basis: 'said' }] },
            orderBy: { createdAt: 'desc' },
            take: SAVED_LATELY_MAX,
            select: { text: true, day: true, agentName: true, source: true, updateKind: true },
        }),
        openAsks(userId, 'brief', now),
        workForWebBrief(userId, now),
    ]);
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: ctx.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    const part = (type: string) => clock.find((p) => p.type === type)?.value ?? '';
    return {
        now: { day: ctx.today, weekday: part('weekday'), time: `${part('hour')}:${part('minute')}`, timezone: ctx.tz },
        who: state?.who ? cut(state.who, WHO_MAX) : null,
        inMotion,
        savedLately: saved.map((o) => ({ text: cut(o.text, 120), day: fromDbDay(o.day), app: o.agentName ?? (o.source === 'app' ? 'Kaaga' : 'an agent'), update: o.updateKind })),
        asks: asks.slice(0, BRIEF_ASKS_MAX).map((a) => ({ _id: a._id, threadId: a.threadId ?? null, text: cut(a.text, 160), answers: a.answers.map((x) => x.label) })),
        howTo: work ? [...HOW_TO, WORK_HOW_TO] : HOW_TO,
        work,
    };
}

export const IN_MOTION_MAX = 6;
/** Spoken of within this many days (the brief's on-mind rule). */
export const IN_MOTION_DAYS = 30;
const MOVING_KINDS: MemoryKind[] = ['aim', 'idea', 'pattern', 'state', 'thread'];

/**
 * "In motion" (§4.6): with the loop on, the open threads by the brief's on-mind rule (not private, not quiet, spoken of in
 * the last 30 days), committed first; with the loop off or no threads yet, the active open memories that move (aims, ideas,
 * habits, states, plans) seen in the last 30 days. At most 6, each with its id and its newest update. Capped lookups only.
 */
export async function inMotionOf(userId: string, now: Date = new Date()): Promise<InMotion[]> {
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { loop: true } });
    if (state?.loop) {
        const rows = await prisma.buddyThread.findMany({
            where: {
                userId,
                stage: { in: ['committed', 'active', 'noticed'] },
                sensitive: false,
                onScreens: true,
                noAsk: false,
                lastSaidAt: { gte: new Date(now.getTime() - IN_MOTION_DAYS * 86_400_000) },
                OR: [{ quietUntil: null }, { quietUntil: { lte: now } }],
            },
            orderBy: [{ lastSaidAt: 'desc' }],
            take: 30,
            select: { id: true, title: true, stage: true },
        });
        const rank = (stage: string) => (stage === 'committed' ? 0 : stage === 'active' ? 1 : 2);
        const picked = [...rows].sort((a, b) => rank(a.stage) - rank(b.stage)).slice(0, IN_MOTION_MAX);
        if (picked.length) {
            // With no AI to rewrite a title, a said change shows beside it ("Walking after work", now: "walks in the evenings").
            const [last, changes, kept] = await Promise.all([lastEvents(picked.map((t) => t.id)), newestChanges(picked.map((t) => t.id)), followedMemories(userId, picked, now)]);
            return [...picked.map((t) => ({ _id: t.id, type: 'thread' as const, text: t.title, stage: t.stage, last: last.get(t.id) ?? null, now: changes.get(t.id) ?? null })), ...kept];
        }
    }
    const { today } = await loadLearningContext(userId, now);
    const memories = await prisma.memory.findMany({
        where: { userId, status: 'active', sensitivity: 'open', kind: { in: MOVING_KINDS }, lastSeenDay: { gte: toDbDay(addDays(today, -IN_MOTION_DAYS)) } },
        orderBy: [{ lastSeenDay: 'desc' }, { updatedAt: 'desc' }],
        take: IN_MOTION_MAX + 10,
    });
    return withNewestUpdates((await notInDoubt(userId, memories)).slice(0, IN_MOTION_MAX));
}

/**
 * Memories without a newer version waiting to be settled (§12.4 B2): one marked to check because newer words may
 * replace it is left out of In motion while that newer memory is there; a check from the ordering rule (two versions
 * of one day, order unknown) leaves its only version listed.
 */
async function notInDoubt(userId: string, memories: readonly Memory[]): Promise<Memory[]> {
    const checked = memories.filter((m) => m.checkSince);
    if (!checked.length) return [...memories];
    const since = new Date(Math.min(...checked.map((m) => m.checkSince!.getTime())) - 60_000);
    const newer = await prisma.memory.findMany({ where: { userId, status: 'active', createdAt: { gte: since } }, select: { id: true, text: true, createdAt: true }, take: 200 });
    const doubted = new Set(
        checked
            .filter((m) => newer.some((n) => n.id !== m.id && n.createdAt.getTime() >= m.checkSince!.getTime() - 60_000 && topicOverlap(n.text, m.text).shared >= MAY_REPLACE_MIN_SHARED))
            .map((m) => m.id)
    );
    return memories.filter((m) => !doubted.has(m.id));
}

/** Memories as In motion lines, each with its newest said update (one capped lookup). */
async function withNewestUpdates(memories: readonly Memory[]): Promise<InMotion[]> {
    if (!memories.length) return [];
    const updates = await prisma.observation.findMany({
        where: { memoryId: { in: memories.map((m) => m.id) }, updateKind: { not: null }, OR: [{ basis: null }, { basis: 'said' }] },
        orderBy: { createdAt: 'desc' },
        take: memories.length * 6,
        select: { memoryId: true, updateKind: true, text: true, day: true },
    });
    const newest = new Map<string, ThreadLast>();
    for (const u of updates) if (u.memoryId && !newest.has(u.memoryId)) newest.set(u.memoryId, { day: fromDbDay(u.day), kind: u.updateKind ?? 'said', text: u.text });
    return memories.map((m) => ({ _id: m.id, type: 'memory' as const, text: m.text, kind: m.kind, last: newest.get(m.id) ?? null }));
}

/** With the loop on, after the threads: at most this many habits, aims and plans kept as memories (§12.4 A). */
export const IN_MOTION_MEMORIES_MAX = 4;
/** ... said or seen within this many days. */
export const IN_MOTION_MEMORY_DAYS = 90;

/**
 * §12.4 A (the final look, 11-19): what the person has going, whatever it is stored as. Threads are made by the
 * buddy's AI, so with no credits every habit, aim or plan said since is a memory, and the brief showed none of them:
 * on the fresh live test ChatGPT could not pass on the end of a charity ride or correct an allergy it had no id for.
 * After the listed threads: the active, open habits, aims and plans no listed thread stands for (its memory, or most
 * of its words), newest said first, never one marked to check (in doubt until settled). Facts and likes stay out
 * (too many; found by search).
 */
async function followedMemories(userId: string, threads: ReadonlyArray<{ id: string; title: string }>, now: Date): Promise<InMotion[]> {
    const { today } = await loadLearningContext(userId, now);
    const [rows, behind] = await Promise.all([
        prisma.memory.findMany({
            where: { userId, status: 'active', sensitivity: 'open', kind: { in: FOLLOWED_KINDS }, lastSeenDay: { gte: toDbDay(addDays(today, -IN_MOTION_MEMORY_DAYS)) } },
            orderBy: [{ lastSeenDay: 'desc' }, { updatedAt: 'desc' }],
            take: 40,
        }),
        prisma.buddyThread.findMany({ where: { id: { in: threads.map((t) => t.id) } }, select: { memoryId: true, title: true, keywords: true } }),
    ]);
    const standsFor = (m: Memory) => behind.some((t) => t.memoryId === m.id || topicCover(m.text, `${t.title} ${t.keywords.join(' ')}`) >= 0.5);
    return withNewestUpdates((await notInDoubt(userId, rows.filter((m) => !standsFor(m)))).slice(0, IN_MOTION_MEMORIES_MAX));
}
