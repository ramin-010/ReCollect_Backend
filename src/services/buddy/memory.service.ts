// The buddy's memory (BUDDY_MEMORY_PLAN §3.2): notes about Ramin (Observation, raw and dated) and
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
import { prisma } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import type { DayString } from '../learning';
import { badRequest, notFound } from '../learning/http';
import { fromDbDay, fromDbDayOrNull, loadLearningContext, toDbDay } from '../learningDb/common';
import { searchTerms } from '../docs/docSearch.service';
import { recordAgentEdit, quoted, type AgentActor } from '../agent/agentEditLog';
import { scrubSecrets } from './scrub';
import { buddySettings, isBuddyPaused } from './state.service';
import { briefNote } from './voice';

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
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
    };
}

// Every column but the search vector (Prisma can't read an Unsupported column; it never selects it).
const MEMORY_COLUMNS = Prisma.sql`m."id", m."userId", m."text", m."kind", m."sensitivity", m."status", m."lasting", m."pinned", m."byUser", m."tags", m."source", m."agentName",
    m."decisionId", m."seenCount", m."firstSeenDay", m."lastSeenDay", m."monthsSeen", m."closedDay", m."closeReason", m."supersedesId", m."createdAt", m."updatedAt"`;

// ─── Notes (an agent's remember / checkpoint.learned, or his own) ──────────────

export interface NoteInput {
    text: string;
    kind?: MemoryKind | undefined;
    /** true / false; left out: privateByDefault(kind). */
    private?: boolean | undefined;
    tags?: readonly string[] | undefined;
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
}

export type NoteOutcome =
    /** A new memory. */
    | { status: 'saved'; memory: MemoryJson }
    /** It repeated a memory, which is now seen again (a faded or closed one is active again). */
    | { status: 'seen'; memory: MemoryJson }
    /** It repeated a memory Ramin marked wrong: not saved. */
    | { status: 'wrong'; memory: MemoryJson }
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

/**
 * Save notes about Ramin. Each becomes a note (Observation) and a memory at once (until the night
 * step exists, plan B1; a note that repeats one bumps it). Paused: nothing is saved.
 */
export async function rememberNotes(writer: NoteWriter, notes: readonly NoteInput[], now: Date = new Date()): Promise<NotesResult> {
    if (notes.length > NOTES_PER_WRITE) throw badRequest(`At most ${NOTES_PER_WRITE} notes at once`);
    if (await isBuddyPaused(writer.userId)) return { paused: true, notes: [] };
    const { today } = await loadLearningContext(writer.userId, now);
    const project = writer.project ? normalizeTag(writer.project) : null;
    const out: NoteOutcome[] = [];
    for (const note of notes) {
        const text = cleanNoteText(note.text);
        if (!text || !memoryKey(text)) {
            out.push({ status: 'empty' });
            continue;
        }
        const kind: MemoryKind = note.kind ?? 'fact';
        const isPrivate = note.private ?? privateByDefault(kind);
        const sensitivity: Sensitivity = isPrivate ? 'private' : 'open';
        const tags = normalizeTags(note.tags ?? [], writer.tags ?? [], project ? [project] : []);
        const existing = await sameMemory(writer.userId, text);

        if (existing?.status === 'wrong') {
            out.push({ status: 'wrong', memory: serializeMemory(existing) });
            continue;
        }
        const memory = existing
            ? await prisma.memory.update({
                  where: { id: existing.id },
                  data: {
                      seenCount: { increment: 1 },
                      lastSeenDay: toDbDay(today),
                      ...(existing.monthsSeen.includes(monthOf(today)) ? {} : { monthsSeen: [...existing.monthsSeen, monthOf(today)] }),
                      // A note seen again wakes a faded or closed memory; privacy only ever goes up.
                      ...(existing.status !== 'active' ? { status: 'active', closedDay: null, closeReason: null } : {}),
                      ...(!existing.byUser && sensitivity === 'private' && existing.sensitivity === 'open' ? { sensitivity: 'private' } : {}),
                      ...(!existing.byUser ? { tags: normalizeTags(existing.tags, tags) } : {}),
                  },
              })
            : await prisma.memory.create({
                  data: {
                      userId: writer.userId,
                      text,
                      kind,
                      sensitivity,
                      lasting: isLastingKind(kind),
                      tags,
                      source: writer.source,
                      agentName: writer.agentName ?? null,
                      firstSeenDay: toDbDay(today),
                      lastSeenDay: toDbDay(today),
                      monthsSeen: [monthOf(today)],
                      byUser: writer.source === 'app',
                  },
              });
        await prisma.observation.create({
            data: {
                userId: writer.userId,
                text,
                kind,
                sensitivity,
                source: writer.source,
                agentName: writer.agentName ?? null,
                sessionKey: writer.sessionKey ?? null,
                project,
                day: toDbDay(today),
                memoryId: memory.id,
            },
        });
        out.push({ status: existing ? 'seen' : 'saved', memory: serializeMemory(memory) });
    }
    return { paused: false, notes: out };
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
    const query = Prisma.join(
        terms.map((t) => Prisma.sql`(to_tsquery('english', ${t}) || to_tsquery('simple', ${`${t}:*`}))`),
        ' && '
    );
    const rows = await prisma.$queryRaw<Memory[]>`
        WITH q AS (SELECT ${query} AS "query")
        SELECT ${MEMORY_COLUMNS} FROM "Memory" m, q
        WHERE m."userId" = ${userId} AND ${status} AND ${kind} AND ${open} AND m."searchVector" @@ q."query"
        ORDER BY ts_rank(m."searchVector", q."query") DESC, m."lastSeenDay" DESC, m."id" DESC
        LIMIT ${limit}`;
    return rows.map(serializeMemory);
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
            ...(closing ? { status: patch.status === 'wrong' ? ('wrong' as const) : ('closed' as const), closedDay: toDbDay(today), closeReason: patch.status === 'wrong' ? 'Marked wrong by Ramin' : 'No longer true (Ramin)', pinned: false } : {}),
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
    if (m.byUser) throw new ErrorResponse(403, 'Ramin wrote or changed this memory himself: only he can change it (on /you)');
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

/** Undo of memory_close: back as it was, unless he changed it since. */
export async function undoMemoryClose(userId: string, id: string, before: Record<string, unknown>): Promise<void> {
    const m = await prisma.memory.findFirst({ where: { id, userId } });
    if (!m) throw new ErrorResponse(409, "Can't undo: that memory was deleted since");
    if (m.status !== 'closed') throw new ErrorResponse(409, "Can't undo: that memory has changed since");
    const status = before['status'] === 'faded' ? 'faded' : 'active';
    const closedDay = typeof before['closedDay'] === 'string' ? toDbDay(before['closedDay'] as DayString) : null;
    await prisma.memory.update({
        where: { id: m.id },
        data: { status, closedDay, closeReason: typeof before['closeReason'] === 'string' ? before['closeReason'] : null, pinned: before['pinned'] === true },
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
    await prisma.observation.create({ data: { userId, text: clean, kind: 'fact', sensitivity: 'private', source: 'tell', day: toDbDay(today) } });
    return { saved: true };
}

export const FEEDBACK_TARGETS = ['morning', 'afternoon', 'evening', 'note'] as const;

/** A thumb on a line or the note of one of its steps (his own steps only). One per target: the last one counts. */
export async function feedback(userId: string, input: { buddyDayId: string; target: (typeof FEEDBACK_TARGETS)[number]; verdict: 'more' | 'less' }): Promise<{ saved: true }> {
    const day = await prisma.buddyDay.findFirst({ where: { id: input.buddyDayId, userId }, select: { id: true } });
    if (!day) throw notFound();
    await prisma.buddyFeedback.deleteMany({ where: { userId, buddyDayId: day.id, target: input.target } });
    await prisma.buddyFeedback.create({ data: { userId, buddyDayId: day.id, target: input.target, verdict: input.verdict } });
    return { saved: true };
}

// ─── Export ────────────────────────────────────────────────────────────────

/** Everything the buddy keeps about him, as JSON (/you → Export). */
export async function exportBuddy(userId: string, now: Date = new Date()) {
    const [settings, memories, notes, work] = await Promise.all([
        buddySettings(userId),
        prisma.memory.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        prisma.observation.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        prisma.workLine.findMany({ where: { userId }, orderBy: [{ day: 'asc' }, { createdAt: 'asc' }, { position: 'asc' }] }),
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
        work: work.map((w) => ({ _id: w.id, day: fromDbDay(w.day), project: w.project, kind: w.kind, text: w.text, at: w.at, source: w.source, office: w.office, removed: w.hidden, sessionKey: w.sessionKey })),
    };
}
