// The buddy's memory (BUDDY_MEMORY_PLAN §3.2): notes about the user (Observation, raw and dated) and
// the curated memories they become (Memory). Code computes; models (B2+) only propose.
//
//   rememberNotes        POST /api/buddy/remember, PUT /api/sessions/by-key/:key {learned}   an agent's or his own note
//   listMemories         GET  /api/buddy/memories?q=&kind=&status=&limit=                   read (agents), the app
//   createMemoryByUser   POST /api/buddy/memories                                           the app (/you)
//   updateMemoryByUser   PATCH /api/buddy/memories/:id                                      the app: edit, pin, private, wrong
//   deleteMemory         DELETE /api/buddy/memories/:id                                     the app: forget for good, notes too
//   closeMemoryByAgent   POST /api/buddy/memories/:id/close                                 agents' forget (memory_close, Undo)
//   buddyBrief           the brief's buddy part (GET /api/brief)
//   exportBuddy          GET  /api/buddy/export
//
// Rules: his word wins (a memory he added, edited, pinned or marked wrong is `byUser`, and no agent
// or model changes or closes it); a note that repeats a memory makes it "seen again" instead of a
// copy; a note that repeats one he marked wrong is not saved; nothing is saved while he has paused
// the buddy. Every text passes the secret scrub first.
import { Prisma, type BuddySource, type Memory, type MemoryKind, type MemoryStatus, type Sensitivity } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { directSaveChangesToday, stampToday } from './liveDay';
import ErrorResponse from '../../utils/errorResponse';
import { closeToWrong, contentWords, nearSame, saidTimeOf, searchRoot, type Basis } from './recordRules';
import type { DayString } from '../learning';
import { badRequest, notFound } from '../learning/http';
import { fromDbDay, fromDbDayOrNull, loadLearningContext, toDbDay } from '../learningDb/common';
import { searchTerms } from '../docs/docSearch.service';
import { recordAgentEdit, quoted, type AgentActor } from '../agent/agentEditLog';
import { scrubSecrets } from './scrub';
import { buddySettings, isBuddyPaused } from './state.service';
import { briefNote } from './voice';
import { privateFromThumb, type ThumbReason } from './screens';

export const MEMORY_KINDS = ['fact', 'preference', 'value', 'aim', 'idea', 'decision', 'pattern', 'state', 'thread', 'win'] as const satisfies readonly MemoryKind[];
export const MEMORY_STATUSES = ['active', 'faded', 'closed', 'wrong'] as const satisfies readonly MemoryStatus[];
/** Lasting kinds never fade by time (plan §3.2); the rest are working memories. */
export const LASTING_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>(['fact', 'preference', 'value', 'aim', 'idea', 'decision']);
export const MEMORY_TEXT_MAX = 300;
export const TAGS_MAX = 8;
export const TAG_MAX = 40;
/** Notes one write may carry (checkpoint's learned takes 3; remember one). */
export const NOTES_PER_WRITE = 5;
export const LIST_LIMIT_DEFAULT = 30;
export const LIST_LIMIT_MAX = 500;
const CLOSE_REASON_MAX = 200;

export const isLastingKind = (kind: MemoryKind): boolean => LASTING_KINDS.has(kind);
/** Private unless said otherwise: a state (a worry, a mood). Agents mark the rest (health, money, people…). */
export const privateByDefault = (kind: MemoryKind): boolean => kind === 'state';

/** A tag: lower case, single spaces, at most 40 characters ('' when nothing is left). */
export const normalizeTag = (tag: string): string => tag.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, TAG_MAX);

export function normalizeTags(...lists: ReadonlyArray<readonly (string | null | undefined)[]>): string[] {
    const out: string[] = [];
    for (const list of lists) for (const t of list) {
        const tag = typeof t === 'string' ? normalizeTag(t) : '';
        if (tag && !out.includes(tag)) out.push(tag);
    }
    return out.slice(0, TAGS_MAX);
}

/** The words of a text without case or punctuation: two notes with the same key are the same memory. */
export const memoryKey = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A note's text: scrubbed, single-spaced, at most 300 characters (cut at a word, with "…"). */
export function cleanNoteText(text: string): string {
    const clean = scrubSecrets(text).replace(/\s+/g, ' ').trim();
    if (clean.length <= MEMORY_TEXT_MAX) return clean;
    const cut = clean.slice(0, MEMORY_TEXT_MAX - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > MEMORY_TEXT_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const monthOf = (day: DayString): string => day.slice(0, 7);

export interface MemoryJson {
    _id: string;
    text: string;
    kind: MemoryKind;
    sensitivity: Sensitivity;
    status: MemoryStatus;
    lasting: boolean;
    pinned: boolean;
    byUser: boolean;
    tags: string[];
    source: BuddySource;
    agentName: string | null;
    decisionId: string | null;
    seenCount: number;
    firstSeenDay: DayString;
    lastSeenDay: DayString;
    monthsSeen: string[];
    closedDay: DayString | null;
    closeReason: string | null;
    supersedesId: string | null;
    /** MCP_MEMORY_PLAN §4.3: an assistant's conclusion, not the person's words. */
    inferred: boolean;
    /** §4.3: two versions said on one day in an unknown order, since then (null: settled). */
    checkSince: string | null;
    createdAt: string;
    updatedAt: string;
}

export function serializeMemory(m: Memory): MemoryJson {
    return {
        _id: m.id,
        text: m.text,
        kind: m.kind,
        sensitivity: m.sensitivity,
        status: m.status,
        lasting: m.lasting,
        pinned: m.pinned,
        byUser: m.byUser,
        tags: m.tags,
        source: m.source,
        agentName: m.agentName,
        decisionId: m.decisionId,
        seenCount: m.seenCount,
        firstSeenDay: fromDbDay(m.firstSeenDay),
        lastSeenDay: fromDbDay(m.lastSeenDay),
        monthsSeen: m.monthsSeen,
        closedDay: fromDbDayOrNull(m.closedDay),
        closeReason: m.closeReason,
        supersedesId: m.supersedesId,
        inferred: m.inferred === true,
        checkSince: m.checkSince ? m.checkSince.toISOString() : null,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
    };
}

// Every column but the search vector (Prisma can't read an Unsupported column; it never selects it).
export const MEMORY_COLUMNS = Prisma.sql`m."id", m."userId", m."text", m."kind", m."sensitivity", m."status", m."lasting", m."pinned", m."byUser", m."tags", m."source", m."agentName",
    m."decisionId", m."seenCount", m."firstSeenDay", m."lastSeenDay", m."monthsSeen", m."closedDay", m."closeReason", m."supersedesId", m."inferred", m."checkSince", m."createdAt", m."updatedAt"`;

// ─── Notes (an agent's remember / checkpoint.learned, or his own) ──────────────

export interface NoteInput {
    text: string;
    kind?: MemoryKind | undefined;
    /** true / false; left out: privateByDefault(kind). */
    private?: boolean | undefined;
    tags?: readonly string[] | undefined;
    /** MCP_MEMORY_PLAN §4.2: when it was said, if not now (a day, or a day and a time). */
    saidOn?: string | null | undefined;
    /** §4.4: set by the new tools (false: the person said it; true: the assistant concludes it); left out by older builds (passed on). */
    inferred?: boolean | undefined;
}

export interface NoteWriter {
    userId: string;
    source: BuddySource;
    agentName?: string | null | undefined;
    sessionKey?: string | null | undefined;
    /** The project (folder) key of the session: kept on the note and added to the memory's tags. */
    project?: string | null | undefined;
    /** More tags for every note of this write (the session's subject). */
    tags?: readonly string[] | undefined;
    /** §4.3: how it came in ('connector' for a signed-in app, 'agent' for a token). */
    via?: string | null | undefined;
}

export type NoteOutcome =
    /** A new memory; mayReplace (MCP_MEMORY_PLAN §12.4 B2): an older one its words may replace, marked to check. */
    | { status: 'saved'; memory: MemoryJson; mayReplace?: { _id: string; text: string } }
    /** It repeated a memory, which is now seen again (a faded one is active again; a closed one only when said after its close). */
    | { status: 'seen'; memory: MemoryJson; reopened?: true; noted?: true }
    /** It repeated a memory that is closed: kept as a note on it, which stays closed (§4.3 rule 1; R6). */
    | { status: 'closed'; memory: MemoryJson; replacedBy: MemoryJson | null }
    /** It repeated a memory the user marked wrong, or came close to one (§4.3 rule 3): not saved. */
    | { status: 'wrong'; memory: MemoryJson; similar?: true }
    /** Nothing left after the scrub. */
    | { status: 'empty' };

export interface NotesResult {
    /** True when he has paused the buddy: nothing was saved. */
    paused: boolean;
    notes: NoteOutcome[];
}

/** The memories whose words are a note's (the GIN index finds the candidates; the keys decide). */
async function sameMemory(userId: string, text: string): Promise<Memory | null> {
    const key = memoryKey(text);
    if (!key) return null;
    const rows = await prisma.$queryRaw<Memory[]>`
        SELECT ${MEMORY_COLUMNS} FROM "Memory" m
        WHERE m."userId" = ${userId} AND m."searchVector" @@ plainto_tsquery('simple', ${key})
        ORDER BY (m."status" = 'active') DESC, m."updatedAt" DESC
        LIMIT 50`;
    return rows.find((r) => memoryKey(r.text) === key) ?? null;
}

/** Memories in these states that share a content word with the text (the GIN index finds them; the rules decide). */
export async function memoriesSharingWords(userId: string, text: string, statuses: readonly MemoryStatus[], limit = 30, openOnly = false): Promise<Memory[]> {
    const words = [...contentWords(text)].slice(0, 12);
    if (!words.length || !statuses.length) return [];
    const query = words.join(' | ');
    const status = Prisma.join(statuses.map((s) => Prisma.sql`${s}::"MemoryStatus"`));
    const open = openOnly ? Prisma.sql`m."sensitivity" = 'open'` : Prisma.sql`TRUE`;
    return prisma.$queryRaw<Memory[]>`
        SELECT ${MEMORY_COLUMNS} FROM "Memory" m
        WHERE m."userId" = ${userId} AND m."status" IN (${status}) AND ${open} AND m."searchVector" @@ to_tsquery('simple', ${query})
        ORDER BY m."lastSeenDay" DESC, m."id" DESC
        LIMIT ${limit}`;
}

/** The kinds that can be in motion: a new one is read by the understanding step (MCP_MEMORY_PLAN §4.5). */
export const MOTION_KINDS: ReadonlySet<MemoryKind> = new Set<MemoryKind>(['aim', 'idea', 'pattern', 'state', 'thread', 'win']);

/** §4.5: a saved detail that may be progress on something followed: it shares a word (four letters or more) with an open thread. */
async function touchesOpenThread(userId: string, text: string): Promise<boolean> {
    const words = [...contentWords(text)].filter((w) => w.length >= 4);
    if (!words.length) return false;
    const threads = await prisma.buddyThread.findMany({ where: { userId, stage: { in: ['noticed', 'active', 'committed'] } }, select: { title: true, keywords: true }, take: 200 });
    return threads.some((t) => {
        const theirs = contentWords(`${t.title} ${t.keywords.join(' ')}`);
        return words.some((w) => theirs.has(w));
    });
}

/** The months and days a statement adds to a memory seen again (its last day never moves back; its first day may). */
function seenOn(m: Pick<Memory, 'firstSeenDay' | 'lastSeenDay' | 'monthsSeen'>, day: DayString) {
    return {
        seenCount: { increment: 1 },
        ...(day > fromDbDay(m.lastSeenDay) ? { lastSeenDay: toDbDay(day) } : {}),
        ...(day < fromDbDay(m.firstSeenDay) ? { firstSeenDay: toDbDay(day) } : {}),
        ...(m.monthsSeen.includes(monthOf(day)) ? {} : { monthsSeen: [...m.monthsSeen, monthOf(day)] }),
    };
}

/**
 * Save notes about the user (MCP_MEMORY_PLAN §4.3). Each becomes a note (Observation) and a memory at once;
 * a repeat makes a memory "seen again". The rules, in code: one he marked wrong (or a near copy of it) is not
 * saved; a closed one comes back only when the person says it on a later day than it was closed; nearly the
 * same words are the same memory; an inference is a working memory marked inferred, and never strengthens.
 * Each note keeps when it was said, whose word it is and how it came in. Paused: nothing is saved.
 */
export async function rememberNotes(writer: NoteWriter, notes: readonly NoteInput[], now: Date = new Date()): Promise<NotesResult> {
    if (notes.length > NOTES_PER_WRITE) throw badRequest(`At most ${NOTES_PER_WRITE} notes at once`);
    if (await isBuddyPaused(writer.userId)) return { paused: true, notes: [] };
    const ctx = await loadLearningContext(writer.userId, now);
    const { today } = ctx;
    const project = writer.project ? normalizeTag(writer.project) : null;
    const out: NoteOutcome[] = [];
    // Notes from older builds (no basis) keep today's path; the new ones go by §4.5.
    const legacy: Array<{ id: string; text: string }> = [];
    const toUnderstand: Array<{ id: string; text: string; basis: string | null }> = [];
    let changesToday = '';
    for (const note of notes) {
        const text = cleanNoteText(note.text);
        if (!text || !memoryKey(text)) {
            out.push({ status: 'empty' });
            continue;
        }
        const said = saidTimeOf(note.saidOn, ctx, now);
        const basis: Basis | null = note.inferred === undefined ? null : note.inferred ? 'inferred' : 'said';
        const inferred = basis === 'inferred';
        // The person's own word: Recollect heard it (the app, "Tell"), or an assistant passed it on as said.
        const theirWord = writer.source !== 'agent' || basis === 'said';
        if (theirWord && !inferred && directSaveChangesToday(text, said, now, ctx.tz, today)) changesToday = changesToday ? `${changesToday} / ${text}` : text;
        const kind: MemoryKind = note.kind ?? 'fact';
        const isPrivate = note.private ?? privateByDefault(kind);
        const sensitivity: Sensitivity = isPrivate ? 'private' : 'open';
        const tags = normalizeTags(note.tags ?? [], writer.tags ?? [], project ? [project] : []);
        const exact = await sameMemory(writer.userId, text);
        const near = exact ? null : (await memoriesSharingWords(writer.userId, text, ['active', 'faded'])).find((m) => nearSame(m.text, text)) ?? null;
        const existing = exact ?? near;

        if (existing?.status === 'wrong') {
            out.push({ status: 'wrong', memory: serializeMemory(existing) });
            continue;
        }
        if (!existing) {
            const wrong = (await memoriesSharingWords(writer.userId, text, ['wrong'])).find((m) => closeToWrong(text, m.text));
            if (wrong) {
                out.push({ status: 'wrong', memory: serializeMemory(wrong), similar: true });
                continue;
            }
        }

        let memory: Memory;
        let outcome: NoteOutcome['status'];
        let extra: { reopened?: true; noted?: true; replacedBy?: MemoryJson | null } = {};
        if (existing?.status === 'closed') {
            // §4.3 rule 1 (R6): a closed memory comes back only when the person says it, on a day after it was closed,
            // and only when nothing replaced it (a changed version is followed with update_memory instead).
            const successor = await chainHead(writer.userId, existing);
            const closedDay = existing.closedDay ? fromDbDay(existing.closedDay) : null;
            if (theirWord && !inferred && successor.id === existing.id && closedDay !== null && said.day > closedDay) {
                memory = await prisma.memory.update({ where: { id: existing.id }, data: { ...seenOn(existing, said.day), status: 'active', closedDay: null, closeReason: null } });
                outcome = 'seen';
                extra = { reopened: true };
            } else {
                memory = existing;
                outcome = 'closed';
                extra = { replacedBy: successor.id === existing.id ? null : serializeMemory(successor) };
            }
        } else if (existing) {
            const settles = theirWord && !inferred && existing.checkSince !== null && !said.dayOnly && said.at.getTime() > existing.checkSince.getTime();
            memory = inferred
                ? existing
                : await prisma.memory.update({
                      where: { id: existing.id },
                      data: {
                          ...seenOn(existing, said.day),
                          // A note seen again wakes a faded memory; privacy only ever goes up.
                          ...(existing.status !== 'active' ? { status: 'active', closedDay: null, closeReason: null } : {}),
                          ...(!existing.byUser && sensitivity === 'private' && existing.sensitivity === 'open' ? { sensitivity: 'private' } : {}),
                          ...(!existing.byUser ? { tags: normalizeTags(existing.tags, tags) } : {}),
                          // Their own words confirm an inference: the mark goes, and the kind decides lasting again.
                          ...(existing.inferred && theirWord ? { inferred: false, ...(existing.byUser ? {} : { lasting: isLastingKind(existing.kind) }) } : {}),
                          ...(settles ? { checkSince: null } : {}),
                      },
                  });
            outcome = 'seen';
            if (inferred) extra = { noted: true };
        } else {
            memory = await prisma.memory.create({
                data: {
                    userId: writer.userId,
                    text,
                    kind,
                    sensitivity,
                    // An inference is a working memory until their own words confirm it (§4.3).
                    lasting: inferred ? false : isLastingKind(kind),
                    inferred,
                    tags,
                    source: writer.source,
                    agentName: writer.agentName ?? null,
                    firstSeenDay: toDbDay(said.day),
                    lastSeenDay: toDbDay(said.day),
                    monthsSeen: [monthOf(said.day)],
                    byUser: writer.source === 'app',
                },
            });
            outcome = 'saved';
        }
        const observation = await prisma.observation.create({
            data: {
                userId: writer.userId,
                text,
                kind,
                sensitivity,
                source: writer.source,
                agentName: writer.agentName ?? null,
                sessionKey: writer.sessionKey ?? null,
                project,
                day: toDbDay(said.day),
                saidAt: said.at,
                dayOnly: said.dayOnly,
                via: writer.via ?? null,
                basis,
                memoryId: memory.id,
            },
            select: { id: true },
        });
        if (basis === null) legacy.push({ id: observation.id, text });
        else if (outcome === 'saved' && !inferred && (MOTION_KINDS.has(kind) || (await touchesOpenThread(writer.userId, text)))) toUnderstand.push({ id: observation.id, text, basis });
        if (outcome === 'closed') out.push({ status: 'closed', memory: serializeMemory(memory), replacedBy: extra.replacedBy ?? null });
        else if (outcome === 'seen') out.push({ status: 'seen', memory: serializeMemory(memory), ...(extra.reopened ? { reopened: true as const } : {}), ...(extra.noted ? { noted: true as const } : {}) });
        else out.push({ status: 'saved', memory: serializeMemory(memory) });
    }
    await queueSavedNotes(writer.userId, writer.source, legacy, now, today);
    await understandOrWait(writer.userId, writer.source, toUnderstand, now, today);
    // Stage 18: a save passed on as their word that names today (tonight's plan, how today is going) changes today.
    if (changesToday) await stampToday(writer.userId, today, now, changesToday);
    return { paused: false, notes: out };
}

/** The newest version of a memory: the chain of replacements followed to its end (§4.3: a correction against a stale id). */
export async function chainHead(userId: string, m: Memory, db: DbClient = prisma): Promise<Memory> {
    let head = m;
    for (let i = 0; i < 50; i++) {
        const next = await db.memory.findFirst({ where: { userId, supersedesId: head.id }, orderBy: { createdAt: 'desc' } });
        if (!next) return head;
        head = next;
    }
    return head;
}

/**
 * §4.5, §4.7: saved details the buddy's AI should read. Read now when it can run (a piece, as before);
 * otherwise each note is marked waiting and nothing is dropped: the catch-up reads it when the AI returns.
 */
export async function understandOrWait(userId: string, source: BuddySource, notes: ReadonlyArray<{ id: string; text: string; basis?: string | null }>, now: Date, today: DayString): Promise<void> {
    if (!notes.length) return;
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { enabled: true, loop: true } });
    const { buddyMaySpend } = await import('./spend');
    if (state?.enabled && state.loop && (await buddyMaySpend(userId, now)) === 'ok') {
        await queueSavedNotes(userId, source, notes, now, today);
        return;
    }
    await prisma.observation.updateMany({ where: { userId, id: { in: notes.map((n) => n.id) }, waitingSince: null }, data: { waitingSince: now } });
}

/**
 * Stage 4 (ECOSYSTEM_V2_PLAN §10, item 5): with the loop on, saved notes also go through the understanding
 * step, so a note can be tied to what is going on in his life (an event on a thread, an answer to a
 * question). They are stored as before; the piece carries their words and the first note's id, waits
 * however long the AI is paused (it is not raw chat), and is read without the gate. An agent's note is
 * passed on (indirect); "Tell" and the app are his own words. Each message names its note (MCP_MEMORY_PLAN
 * §4.7), so a piece that can't be read marks exactly its notes waiting.
 */
export async function queueSavedNotes(userId: string, source: BuddySource, notes: ReadonlyArray<{ id: string; text: string; basis?: string | null }>, now: Date, today: DayString): Promise<void> {
    if (!notes.length) return;
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { enabled: true, loop: true } });
    if (!state?.enabled || !state.loop) return;
    const via = source === 'agent' ? 'agent' : source === 'tell' ? 'tell' : 'app';
    await prisma.buddyChunk.create({
        data: {
            userId,
            sessionKey: `note:${notes[0]!.id}`.slice(0, 80),
            seq: 1,
            source,
            via,
            noteId: notes[0]!.id,
            saidFrom: now,
            messages: notes.map((n) => ({ at: now.toISOString(), text: n.text, noteId: n.id, ...(n.basis ? { basis: n.basis } : {}) })) as unknown as Prisma.InputJsonValue,
            createdAt: now,
        },
        select: { id: true },
    });
    const { bumpSource } = await import('./capture.service');
    await bumpSource(userId, today, via, { seen: notes.length, pieces: 1 }, now);
    const { poke } = await import('../scheduler/scheduler');
    poke('capture');
}

// ─── Reading ───────────────────────────────────────────────────────────────

export type StatusFilter = MemoryStatus | 'all' | 'mind';

export interface ListOptions {
    q?: string | undefined;
    kind?: MemoryKind | undefined;
    /** Default `mind` (active); `all` for /you. */
    status?: StatusFilter | undefined;
    limit?: number | undefined;
    /** Leave private memories out (the brief). */
    openOnly?: boolean | undefined;
}

const clampLimit = (limit: number | undefined, max = LIST_LIMIT_MAX): number => Math.min(Math.max(Math.trunc(limit ?? LIST_LIMIT_DEFAULT), 1), max);

function statusSql(status: StatusFilter): Prisma.Sql {
    if (status === 'all') return Prisma.sql`TRUE`;
    if (status === 'mind') return Prisma.sql`m."status" = 'active'`;
    return Prisma.sql`m."status" = ${status}::"MemoryStatus"`;
}

/** His memories: a full-text search (best first), or the list (pinned, then most recently seen). */
export async function listMemories(userId: string, options: ListOptions = {}): Promise<MemoryJson[]> {
    const limit = clampLimit(options.limit);
    const status = statusSql(options.status ?? 'mind');
    const kind = options.kind ? Prisma.sql`m."kind" = ${options.kind}::"MemoryKind"` : Prisma.sql`TRUE`;
    const open = options.openOnly ? Prisma.sql`m."sensitivity" = 'open'` : Prisma.sql`TRUE`;
    const terms = searchTerms((options.q ?? '').slice(0, 200));
    if (terms.length === 0) {
        const rows = await prisma.$queryRaw<Memory[]>`
            SELECT ${MEMORY_COLUMNS} FROM "Memory" m
            WHERE m."userId" = ${userId} AND ${status} AND ${kind} AND ${open}
            ORDER BY m."pinned" DESC, m."lastSeenDay" DESC, m."updatedAt" DESC, m."id" DESC
            LIMIT ${limit}`;
        return rows.map(serializeMemory);
    }
    const search = (statusIn: Prisma.Sql, join: ' && ' | ' || ') => {
        const query = Prisma.join(
            terms.map((t) => {
                // §12.4 D: the word's root too, so other forms meet ("allergies" finds "Allergic to cashews").
                const root = searchRoot(t);
                return root
                    ? Prisma.sql`(to_tsquery('english', ${t}) || to_tsquery('simple', ${`${t}:*`}) || to_tsquery('simple', ${`${root}:*`}))`
                    : Prisma.sql`(to_tsquery('english', ${t}) || to_tsquery('simple', ${`${t}:*`}))`;
            }),
            join
        );
        return prisma.$queryRaw<Memory[]>`
            WITH q AS (SELECT ${query} AS "query")
            SELECT ${MEMORY_COLUMNS} FROM "Memory" m, q
            WHERE m."userId" = ${userId} AND ${statusIn} AND ${kind} AND ${open} AND m."searchVector" @@ q."query"
            ORDER BY ts_rank(m."searchVector", q."query") DESC, m."lastSeenDay" DESC, m."id" DESC
            LIMIT ${limit}`;
    };
    let rows = await search(status, ' && ');
    // When nothing holds every word, any of the words (with a status named too: on the live rerun of 11-19 an
    // assistant asked "seat window aisle flight" with status all and found nothing, "aisle" being new).
    if (!rows.length && terms.length > 1) rows = await search(status, ' || ');
    // A search that names no status (an agent's lookup): then what has faded or closed, every word and then any
    // (never what he marked wrong). A fact that faded is still true more often than not (an evaluation on 11-17 lost
    // a health limit this way).
    if (!rows.length && options.status === undefined) {
        const past = Prisma.sql`m."status" IN ('faded', 'closed')`;
        rows = await search(past, ' && ');
        if (!rows.length && terms.length > 1) rows = await search(past, ' || ');
    }
    return rows.map(serializeMemory);
}

/** A memory with its place in a chain of corrections (MCP_MEMORY_PLAN §4.8): what replaced it, what it replaced. */
export interface MemoryWithChain extends MemoryJson {
    replacedBy: { _id: string; text: string } | null;
    replaces: { _id: string; text: string } | null;
}

/** Each memory's neighbours in its chain of corrections: two lookups for the whole page. */
export async function withChains(userId: string, rows: readonly MemoryJson[]): Promise<MemoryWithChain[]> {
    if (!rows.length) return [];
    const olderIds = [...new Set(rows.map((r) => r.supersedesId).filter((x): x is string => !!x))];
    const [newer, older] = await Promise.all([
        prisma.memory.findMany({ where: { userId, supersedesId: { in: rows.map((r) => r._id) } }, orderBy: { createdAt: 'desc' }, select: { id: true, text: true, supersedesId: true } }),
        olderIds.length ? prisma.memory.findMany({ where: { userId, id: { in: olderIds } }, select: { id: true, text: true } }) : Promise.resolve([]),
    ]);
    return rows.map((r) => {
        const next = newer.find((n) => n.supersedesId === r._id);
        const prev = r.supersedesId ? older.find((o) => o.id === r.supersedesId) : undefined;
        return { ...r, replacedBy: next ? { _id: next.id, text: next.text } : null, replaces: prev ? { _id: prev.id, text: prev.text } : null };
    });
}

export interface MemoryCounts {
    active: number;
    lasting: number;
    working: number;
    faded: number;
    closed: number;
    wrong: number;
    notes: number;
    /** Notes from his chats the night step has not folded into a memory yet. */
    pending: number;
}

export async function memoryCounts(userId: string): Promise<MemoryCounts> {
    const [byStatus, lasting, notes, pending] = await Promise.all([
        prisma.memory.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } }),
        prisma.memory.count({ where: { userId, status: 'active', lasting: true } }),
        prisma.observation.count({ where: { userId } }),
        prisma.observation.count({ where: { userId, memoryId: null, foldedAt: null } }),
    ]);
    const n = (s: MemoryStatus) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
    return { active: n('active'), lasting, working: n('active') - lasting, faded: n('faded'), closed: n('closed'), wrong: n('wrong'), notes, pending };
}

async function ownMemory(userId: string, id: string): Promise<Memory> {
    const m = await prisma.memory.findFirst({ where: { id, userId } });
    if (!m) throw notFound();
    return m;
}

// ─── His own changes (the app) ─────────────────────────────────────────────

export interface UserMemoryInput {
    text: string;
    kind: MemoryKind;
    private?: boolean | undefined;
    tags?: readonly string[] | undefined;
    lasting?: boolean | undefined;
    pinned?: boolean | undefined;
}

/** A memory he writes himself (byUser). A repeat of one he has makes that one his. */
export async function createMemoryByUser(userId: string, input: UserMemoryInput, now: Date = new Date()): Promise<MemoryJson> {
    const text = cleanNoteText(input.text);
    if (!text || !memoryKey(text)) throw badRequest('Write what to remember');
    const { today } = await loadLearningContext(userId, now);
    const existing = await sameMemory(userId, text);
    const sensitivity: Sensitivity = (input.private ?? privateByDefault(input.kind)) ? 'private' : 'open';
    const fields = {
        kind: input.kind,
        sensitivity,
        lasting: input.lasting ?? isLastingKind(input.kind),
        pinned: input.pinned ?? false,
        byUser: true,
        tags: normalizeTags(input.tags ?? []),
    };
    if (existing) {
        const updated = await prisma.memory.update({
            where: { id: existing.id },
            data: { ...fields, text, status: 'active', closedDay: null, closeReason: null, lastSeenDay: toDbDay(today), seenCount: { increment: 1 } },
        });
        return serializeMemory(updated);
    }
    const row = await prisma.memory.create({
        data: { userId, text, ...fields, source: 'app', firstSeenDay: toDbDay(today), lastSeenDay: toDbDay(today), monthsSeen: [monthOf(today)] },
    });
    return serializeMemory(row);
}

export interface UserMemoryPatch {
    text?: string | undefined;
    kind?: MemoryKind | undefined;
    private?: boolean | undefined;
    pinned?: boolean | undefined;
    lasting?: boolean | undefined;
    tags?: readonly string[] | undefined;
    /** active (put back), wrong (mark wrong), closed (no longer true). */
    status?: 'active' | 'wrong' | 'closed' | undefined;
    /** MCP_MEMORY_PLAN §4.3: "this one is right" on a memory marked check (an edit or a status settles it too). */
    settle?: boolean | undefined;
}

/** His change to a memory: from then on it is his (byUser), and no model changes it. */
export async function updateMemoryByUser(userId: string, id: string, patch: UserMemoryPatch, now: Date = new Date()): Promise<MemoryJson> {
    const m = await ownMemory(userId, id);
    const { today } = await loadLearningContext(userId, now);
    const text = patch.text !== undefined ? cleanNoteText(patch.text) : undefined;
    if (text !== undefined && !memoryKey(text)) throw badRequest('A memory needs words');
    const closing = patch.status === 'closed' || patch.status === 'wrong';
    const updated = await prisma.memory.update({
        where: { id: m.id },
        data: {
            byUser: true,
            ...(text !== undefined ? { text } : {}),
            ...(patch.kind ? { kind: patch.kind } : {}),
            ...(patch.private !== undefined ? { sensitivity: patch.private ? 'private' : 'open' } : {}),
            ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
            ...(patch.lasting !== undefined ? { lasting: patch.lasting } : {}),
            ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
            ...(patch.status === 'active' ? { status: 'active', closedDay: null, closeReason: null } : {}),
            ...(closing ? { status: patch.status === 'wrong' ? ('wrong' as const) : ('closed' as const), closedDay: toDbDay(today), closeReason: patch.status === 'wrong' ? 'Marked wrong by the user' : 'No longer true (closed by the user)', pinned: false } : {}),
            // His word settles two versions of one day (MCP_MEMORY_PLAN §4.3): a settle, an edit or a status.
            ...(patch.settle || text !== undefined || patch.status !== undefined ? { checkSince: null } : {}),
            // His own words are not an inference any more.
            ...(text !== undefined ? { inferred: false } : {}),
        },
    });
    return serializeMemory(updated);
}

/** Forget for good: the memory and the notes behind it are deleted. */
export async function deleteMemory(userId: string, id: string): Promise<{ deleted: true; notes: number }> {
    const m = await ownMemory(userId, id);
    const [notes] = await prisma.$transaction([prisma.observation.deleteMany({ where: { userId, memoryId: m.id } }), prisma.memory.delete({ where: { id: m.id } })]);
    return { deleted: true, notes: notes.count };
}

// ─── Agents' forget (closes, with Undo) ────────────────────────────────────

/** An agent's forget: the memory is closed (Undo makes it active again). His own memories are his. */
export async function closeMemoryByAgent(actor: AgentActor, id: string, reason: string | undefined, now: Date = new Date()): Promise<{ memory: MemoryJson; editId: string }> {
    const m = await ownMemory(actor.userId, id);
    if (m.byUser) throw new ErrorResponse(403, 'The user wrote or changed this memory: only they can change it (on /you)');
    if (m.status !== 'active' && m.status !== 'faded') throw new ErrorResponse(409, `This memory is already ${m.status}`);
    const { today } = await loadLearningContext(actor.userId, now);
    const closeReason = (reason ? scrubSecrets(reason).replace(/\s+/g, ' ').trim() : '').slice(0, CLOSE_REASON_MAX) || `Forgotten by ${actor.agentName}`;
    const updated = await prisma.memory.update({ where: { id: m.id }, data: { status: 'closed', closedDay: toDbDay(today), closeReason, pinned: false } });
    const editId = await recordAgentEdit(actor, {
        kind: 'memory_close',
        summary: `Forgot ${quoted(m.text, 80)}`,
        entityId: m.id,
        undoData: { before: { status: m.status, closedDay: fromDbDayOrNull(m.closedDay), closeReason: m.closeReason, pinned: m.pinned } },
    });
    return { memory: serializeMemory(updated), editId };
}

/**
 * Undo of memory_close: back as it was, unless he changed it since. A replacement (MCP_MEMORY_PLAN §4.3,
 * `replacedBy`) is undone too: the new version goes while it is unchanged (seen once, not his, not replaced
 * itself), or, when it was a memory of its own already, it just stops being the replacement.
 */
export async function undoMemoryClose(userId: string, id: string, before: Record<string, unknown>, data: Record<string, unknown> = {}): Promise<void> {
    const m = await prisma.memory.findFirst({ where: { id, userId } });
    if (!m) throw new ErrorResponse(409, "Can't undo: that memory was deleted since");
    if (m.status !== 'closed') throw new ErrorResponse(409, "Can't undo: that memory has changed since");
    const replacedBy = typeof data['replacedBy'] === 'string' ? data['replacedBy'] : null;
    const replacement = replacedBy ? await prisma.memory.findFirst({ where: { id: replacedBy, userId } }) : null;
    if (replacement) {
        const replacedAgain = await prisma.memory.count({ where: { userId, supersedesId: replacement.id } });
        if (data['createdNew'] === true && (replacement.byUser || replacement.seenCount > 1 || replacedAgain > 0 || replacement.status !== 'active')) {
            throw new ErrorResponse(409, "Can't undo: the new version has changed since");
        }
    }
    const status = before['status'] === 'faded' ? 'faded' : 'active';
    const closedDay = typeof before['closedDay'] === 'string' ? toDbDay(before['closedDay'] as DayString) : null;
    await prisma.$transaction(async (tx) => {
        await tx.memory.update({
            where: { id: m.id },
            data: { status, closedDay, closeReason: typeof before['closeReason'] === 'string' ? before['closeReason'] : null, pinned: before['pinned'] === true },
        });
        if (!replacement) return;
        if (data['createdNew'] === true) {
            await tx.observation.deleteMany({ where: { userId, memoryId: replacement.id } });
            await tx.memory.delete({ where: { id: replacement.id } });
        } else {
            await tx.memory.update({ where: { id: replacement.id }, data: { supersedesId: null } });
        }
    });
}

// ─── The brief's part ──────────────────────────────────────────────────────

export const BRIEF_MEMORIES_MAX = 8;
const BRIEF_PINNED_MAX = 6;
const BRIEF_TAGGED_MAX = 5;
/** The memories' share of the brief, in characters (about 350 tokens). */
const BRIEF_MEMORY_CHARS = 1400;

export interface BuddyBrief {
    who: string | null;
    heading: string | null;
    now: string | null;
    memories: Array<{ kind: MemoryKind; text: string; pinned: boolean }>;
    note: string | null;
    followUp: string | null;
    /** The note's id as GET /api/buddy/note gives it, and its day: the hooks mark it shown for the session. */
    noteId: string | null;
    noteDay: string | null;
}

/**
 * The buddy's part of the brief: the portrait (once the night step writes it), then the memories a
 * chat should start with: pinned ones, then those tagged with this project; while there is no
 * portrait yet, the most seen lasting ones fill up. Private memories stay out unless pinned.
 */
export async function buddyBrief(userId: string, options: { project?: string | undefined } = {}): Promise<BuddyBrief> {
    const [state, pinned, lasting, said] = await Promise.all([
        buddySettings(userId),
        prisma.memory.findMany({ where: { userId, status: 'active', pinned: true }, orderBy: { lastSeenDay: 'desc' }, take: BRIEF_PINNED_MAX }),
        prisma.memory.findMany({ where: { userId, status: 'active', lasting: true, sensitivity: 'open', pinned: false }, orderBy: [{ seenCount: 'desc' }, { lastSeenDay: 'desc' }], take: BRIEF_MEMORIES_MAX }),
        briefNote(userId),
    ]);
    const tag = options.project ? normalizeTag(options.project) : '';
    const tagged = tag
        ? await prisma.memory.findMany({ where: { userId, status: 'active', sensitivity: 'open', pinned: false, tags: { has: tag } }, orderBy: { lastSeenDay: 'desc' }, take: BRIEF_TAGGED_MAX })
        : [];
    const picked: Memory[] = [];
    const add = (m: Memory) => {
        if (picked.length < BRIEF_MEMORIES_MAX && !picked.some((p) => p.id === m.id)) picked.push(m);
    };
    pinned.forEach(add);
    tagged.forEach(add);
    if (!state.portrait.who) lasting.forEach(add);
    let room = BRIEF_MEMORY_CHARS;
    const memories: BuddyBrief['memories'] = [];
    for (const m of picked) {
        if (m.text.length > room) continue;
        room -= m.text.length;
        memories.push({ kind: m.kind, text: m.text, pinned: m.pinned });
    }
    return { who: state.portrait.who, heading: state.portrait.heading, now: state.portrait.now, memories, note: said.note, followUp: said.followUp, noteId: said.noteId, noteDay: said.noteDay };
}

// ─── His own words and thumbs (BUDDY_MEMORY_PLAN §3.1 D, §3.5) ────────────

export const TELL_MAX = 1000;

/** "Tell your buddy": straight in as a note for tonight (no gate), scrubbed like everything else. */
export async function tellBuddy(userId: string, text: string, now: Date = new Date()): Promise<{ saved: boolean; paused?: true }> {
    if (await isBuddyPaused(userId)) return { saved: false, paused: true };
    const clean = cleanNoteText(text.slice(0, TELL_MAX));
    if (!clean || !memoryKey(clean)) throw badRequest('Tell it something');
    const { today } = await loadLearningContext(userId, now);
    const note = await prisma.observation.create({ data: { userId, text: clean, kind: 'fact', sensitivity: 'private', source: 'tell', day: toDbDay(today) }, select: { id: true } });
    await queueSavedNotes(userId, 'tell', [{ id: note.id, text: clean }], now, today);
    return { saved: true };
}

export const FEEDBACK_TARGETS = ['morning', 'afternoon', 'evening', 'note'] as const;
/** Stage 7: a timed line is named by its start (HH:mm). */
export const LINE_KEY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * A thumb on a line (its part of the day, or a timed line's start) or the note of one of its steps (his own steps only). One
 * per target: the last one counts. Stage 5b: a "not this" may say why (too private, wrong time, not useful, not true) and
 * a few words; "too private" takes the threads it rests on off the screens, or keeps lines like it off the lock screen.
 */
export async function feedback(userId: string, input: { buddyDayId: string; target: string; verdict: 'more' | 'less'; reason?: ThumbReason | undefined; words?: string | undefined }, now: Date = new Date()): Promise<{ saved: true; offScreens?: 'threads' | 'topic' }> {
    const day = await prisma.buddyDay.findFirst({ where: { id: input.buddyDayId, userId }, select: { id: true } });
    if (!day) throw notFound();
    const reason = input.verdict === 'less' ? (input.reason ?? null) : null;
    const words = input.verdict === 'less' && input.words ? scrubSecrets(input.words).replace(/\s+/g, ' ').trim().slice(0, 200) || null : null;
    await prisma.buddyFeedback.deleteMany({ where: { userId, buddyDayId: day.id, target: input.target } });
    await prisma.buddyFeedback.create({ data: { userId, buddyDayId: day.id, target: input.target, verdict: input.verdict, reason, words, createdAt: now } });
    // With the loop off the reason is kept and nothing else changes (stage 5b is the loop's).
    if (reason !== 'private' || (await prisma.buddyState.findUnique({ where: { userId }, select: { loop: true } }))?.loop !== true) return { saved: true };
    const did = await privateFromThumb(userId, day.id, input.target, now);
    return did === 'none' ? { saved: true } : { saved: true, offScreens: did };
}

// ─── Export ────────────────────────────────────────────────────────────────

/** Everything the buddy keeps about him, as JSON (/you → Export). */
export async function exportBuddy(userId: string, now: Date = new Date()) {
    const [settings, memories, notes, work, threads, asks] = await Promise.all([
        buddySettings(userId),
        prisma.memory.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        prisma.observation.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        prisma.workLine.findMany({ where: { userId }, orderBy: [{ day: 'asc' }, { createdAt: 'asc' }, { position: 'asc' }] }),
        prisma.buddyThread.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, include: { events: { orderBy: { saidAt: 'asc' } } } }),
        prisma.buddyAsk.findMany({ where: { userId }, orderBy: { fromAt: 'asc' } }),
    ]);
    return {
        exportedAt: now.toISOString(),
        settings,
        memories: memories.map(serializeMemory),
        notes: notes.map((o) => ({
            _id: o.id,
            text: o.text,
            kind: o.kind,
            sensitivity: o.sensitivity,
            source: o.source,
            agentName: o.agentName,
            sessionKey: o.sessionKey,
            project: o.project,
            day: fromDbDay(o.day),
            memoryId: o.memoryId,
            createdAt: o.createdAt.toISOString(),
        })),
        // B9: his work log, the lines he removed too (marked).
        // Stage 12: when it happened, the app that wrote it, the line it is news on, the line it repeats (folded).
        work: work.map((w) => ({
            _id: w.id,
            day: fromDbDay(w.day),
            project: w.project,
            kind: w.kind,
            text: w.text,
            at: w.at,
            source: w.source,
            office: w.office,
            removed: w.hidden,
            sessionKey: w.sessionKey,
            happenedAt: (w.happenedAt ?? w.createdAt).toISOString(),
            app: w.app,
            follows: w.followsId,
            sameAs: w.sameAsId,
        })),
        // Stage 5: what it keeps an eye on, with each thread's history, and its questions with his answers.
        threads: threads.map((t) => ({
            _id: t.id,
            title: t.title,
            keywords: t.keywords,
            stage: t.stage,
            lookAgainOn: t.lookAgainOn ? fromDbDay(t.lookAgainOn) : null,
            rhythm: t.rhythm,
            sensitive: t.sensitive,
            onScreens: t.onScreens,
            noAsk: t.noAsk,
            steer: t.steer,
            quietUntil: t.quietUntil?.toISOString() ?? null,
            firstDay: fromDbDay(t.firstDay),
            closedAt: t.closedAt?.toISOString() ?? null,
            history: t.events.map((e) => ({ kind: e.kind, text: e.text, saidAt: e.saidAt.toISOString(), forDay: fromDbDay(e.forDay), direct: e.direct, duplicate: e.duplicate, via: e.via })),
        })),
        asks: asks.map((a) => ({ _id: a.id, threadId: a.threadId, kind: a.kind, text: a.text, from: a.fromAt.toISOString(), until: a.untilAt.toISOString(), state: a.state, answer: a.answer, thumb: a.thumb, shownOn: a.shownOn })),
    };
}
