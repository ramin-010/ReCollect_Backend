// A subject's path (BUDDY_PLAN B1): its topics in order, each planned, in progress, done or
// skipped, and the one to do next. Order is Topic.sortOrder (ascending; unset ones last, then by
// creation); every change renumbers the subject 1, 2, 3… so places never collide.
//
//   readPath            GET   /api/subjects/:id/path
//   planTopics          POST  /api/subjects/:id/path   {titles, after?}
//   updateTopicOnPath   PATCH /api/topics/:id/path     {title?, status?, nextStep?, after?}
//
// "Next" is worked out, never stored: the first topic in progress, else the first planned one.
import type { TopicStatus } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { LearningHttpError, badRequest, conflict, notFound } from '../learning/http';
import { fromDbDay, loadLearningContext } from './common';
import { createRevisionChain } from './revisions.service';

export const PATH_TITLE_MAX = 200;
export const NEXT_STEP_MAX = 300;
export const PLAN_MAX = 50;

export interface PathTopicJson {
    _id: string;
    title: string;
    status: TopicStatus;
    /** 1-based place on the path. */
    position: number;
    docId: string | null;
    nextStep: string | null;
    startedAt: string | null;
    doneAt: string | null;
    /** GET only: the topic's open weak spots (SYNC_SPINE_SPEC 1.2), oldest first. */
    weakSpots?: Array<{ _id: string; text: string }>;
}

export interface PathJson {
    subject: { _id: string; name: string };
    topics: PathTopicJson[];
    next: PathTopicJson | null;
    done: number;
    total: number;
}

type Row = {
    id: string;
    title: string;
    status: TopicStatus;
    sortOrder: number | null;
    createdAt: Date;
    docId: string | null;
    nextStep: string | null;
    startedAt: Date | null;
    doneAt: Date | null;
    doc: { title: string } | null;
};

const ROW = {
    id: true,
    title: true,
    status: true,
    sortOrder: true,
    createdAt: true,
    docId: true,
    nextStep: true,
    startedAt: true,
    doneAt: true,
    doc: { select: { title: true } },
} as const;

/** The path's order: places first (unset last), then creation, then id. */
export function pathOrder(rows: readonly Row[]): Row[] {
    const place = (r: Row) => (r.sortOrder === null ? Number.POSITIVE_INFINITY : r.sortOrder);
    return [...rows].sort((a, b) => place(a) - place(b) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

/** The topic to do next: the first in progress, else the first planned. */
export function nextOf<T extends { status: TopicStatus }>(topics: readonly T[]): T | null {
    return topics.find((t) => t.status === 'in_progress') ?? topics.find((t) => t.status === 'planned') ?? null;
}

async function loadRows(db: DbClient, userId: string, subjectId: string): Promise<Row[]> {
    const rows = await db.topic.findMany({ where: { userId, subjectId, isArchived: false }, select: ROW });
    return pathOrder(rows);
}

function toJson(subject: { id: string; name: string }, rows: readonly Row[]): PathJson {
    const topics = rows.map(
        (r, i): PathTopicJson => ({
            _id: r.id,
            // A topic with a doc shows the doc's title (as everywhere in the app).
            title: r.doc?.title || r.title,
            status: r.status,
            position: i + 1,
            docId: r.docId,
            nextStep: r.nextStep,
            startedAt: r.startedAt?.toISOString() ?? null,
            doneAt: r.doneAt?.toISOString() ?? null,
        })
    );
    return { subject: { _id: subject.id, name: subject.name }, topics, next: nextOf(topics), done: topics.filter((t) => t.status === 'done').length, total: topics.length };
}

async function ownedSubject(db: DbClient, userId: string, subjectId: string): Promise<{ id: string; name: string }> {
    const subject = await db.subject.findFirst({ where: { id: subjectId, userId }, select: { id: true, name: true } });
    if (!subject) throw notFound();
    return subject;
}

/** Write places 1..n for the ids in this order (only the rows whose place changed). */
async function renumber(db: DbClient, rows: readonly Row[], orderIds: readonly string[]): Promise<void> {
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const [i, id] of orderIds.entries()) {
        const place = i + 1;
        if (byId.get(id)?.sortOrder !== place) await db.topic.update({ where: { id }, data: { sortOrder: place }, select: { id: true } });
    }
}

/** `ids` with `moving` placed right after `after` (first when null; the end when undefined). */
function placed(ids: readonly string[], moving: readonly string[], after: string | null | undefined): string[] {
    const rest = ids.filter((id) => !moving.includes(id));
    if (after === undefined) return [...rest, ...moving];
    if (after === null) return [...moving, ...rest];
    const at = rest.indexOf(after);
    if (at < 0) throw badRequest(`after must be a topic of this subject (get_path shows them); ${after} is not`);
    return [...rest.slice(0, at + 1), ...moving, ...rest.slice(at + 1)];
}

export async function readPath(userId: string, subjectId: string, db: DbClient = prisma): Promise<PathJson> {
    const subject = await ownedSubject(db, userId, subjectId);
    const path = toJson(subject, await loadRows(db, userId, subjectId));
    const open = await db.weakSpot.findMany({
        where: { userId, status: 'open', topicId: { in: path.topics.map((t) => t._id) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, text: true, topicId: true },
    });
    for (const t of path.topics) t.weakSpots = open.filter((w) => w.topicId === t._id).map((w) => ({ _id: w.id, text: w.text }));
    return path;
}

/** Planned topics (no doc yet) put on the path after `after` (the end when left out). */
export async function planTopics(userId: string, subjectId: string, input: { titles: string[]; after?: string | null | undefined }): Promise<{ created: string[]; path: PathJson }> {
    const titles = input.titles.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (titles.length === 0) throw badRequest('titles needs at least one topic title');
    if (titles.length > PLAN_MAX) throw badRequest(`At most ${PLAN_MAX} topics at once`);
    const long = titles.find((t) => t.length > PATH_TITLE_MAX);
    if (long) throw badRequest(`A topic title is at most ${PATH_TITLE_MAX} characters: "${long.slice(0, 40)}…"`);
    return prisma.$transaction(async (tx) => {
        const subject = await ownedSubject(tx, userId, subjectId);
        await tx.$queryRaw`SELECT "id" FROM "Subject" WHERE "id" = ${subject.id} FOR UPDATE`;
        const rows = await loadRows(tx, userId, subjectId);
        const created: string[] = [];
        for (const title of titles) {
            const row = await tx.topic.create({ data: { userId, subjectId, title, status: 'planned' }, select: { id: true } });
            created.push(row.id);
        }
        const fresh = await loadRows(tx, userId, subjectId);
        await renumber(tx, fresh, placed(rows.map((r) => r.id), created, input.after));
        return { created, path: toJson(subject, await loadRows(tx, userId, subjectId)) };
    });
}

export interface TopicPathPatch {
    title?: string | undefined;
    status?: TopicStatus | undefined;
    /** null clears it. */
    nextStep?: string | null | undefined;
    /** A topic id to go after, or null to go first. */
    after?: string | null | undefined;
}

/** A topic changed on its path; `now` stamps the first start and the finish. */
export async function updateTopicOnPath(userId: string, topicId: string, patch: TopicPathPatch, now: Date = new Date()): Promise<{ topic: PathTopicJson; path: PathJson }> {
    return prisma.$transaction(async (tx) => {
        const topic = await tx.topic.findFirst({ where: { id: topicId, userId, isArchived: false }, select: { id: true, subjectId: true, docId: true, status: true, startedAt: true } });
        if (!topic) throw notFound();
        await tx.$queryRaw`SELECT "id" FROM "Subject" WHERE "id" = ${topic.subjectId} FOR UPDATE`;
        const subject = await ownedSubject(tx, userId, topic.subjectId);
        if (patch.title !== undefined) {
            const title = patch.title.replace(/\s+/g, ' ').trim();
            if (!title) throw badRequest('title cannot be empty');
            if (topic.docId) throw badRequest("This topic's title is its doc's title: rename the doc in Recollect");
        }
        const nextStep = patch.nextStep === undefined ? undefined : patch.nextStep === null ? null : patch.nextStep.trim().slice(0, NEXT_STEP_MAX) || null;
        await tx.topic.update({
            where: { id: topic.id },
            data: {
                ...(patch.title !== undefined ? { title: patch.title.replace(/\s+/g, ' ').trim() } : {}),
                ...(patch.status !== undefined ? { status: patch.status } : {}),
                ...(patch.status === 'in_progress' && !topic.startedAt ? { startedAt: now } : {}),
                ...(patch.status === 'done' ? { doneAt: now, ...(topic.startedAt ? {} : { startedAt: now }) } : {}),
                ...(patch.status !== undefined && patch.status !== 'done' ? { doneAt: null } : {}),
                ...(nextStep !== undefined ? { nextStep } : {}),
            },
            select: { id: true },
        });
        if (patch.after !== undefined) {
            if (patch.after === topic.id) throw badRequest('A topic cannot go after itself');
            const rows = await loadRows(tx, userId, topic.subjectId);
            await renumber(tx, rows, placed(rows.map((r) => r.id), [topic.id], patch.after));
        }
        const path = toJson(subject, await loadRows(tx, userId, topic.subjectId));
        return { topic: path.topics.find((t) => t._id === topic.id)!, path };
    });
}

// ─── Next up (SYNC_SPINE_SPEC 1.1): GET /api/today's `next`, and the brief ───────────────────────

export const NEXT_UP_LIMIT = 3;

export interface NextUpJson {
    subject: { _id: string; name: string; color: string | null };
    topic: { _id: string; title: string; position: number; status: TopicStatus };
    done: number;
    total: number;
    nextStep: string | null;
}

export type NextUpRow = Row & { subjectId: string; updatedAt: Date; subject: { id: string; name: string; color: string | null; lastActiveAt: Date } };

/** Every live topic of the subjects that have something planned or in progress. */
export function loadNextUpRows(userId: string, db: DbClient = prisma): Promise<NextUpRow[]> {
    const open = { status: { in: ['planned', 'in_progress'] as TopicStatus[] }, isArchived: false };
    return db.topic.findMany({
        where: { userId, isArchived: false, subject: { topics: { some: open } } },
        select: { ...ROW, subjectId: true, updatedAt: true, subject: { select: { id: true, name: true, color: true, lastActiveAt: true } } },
    });
}

/**
 * One entry per subject with a next topic: subjects of an active goal first, then the most
 * recently active (a topic changed, a revision done, a topic made), then by name. Pure.
 */
export function nextUpOf(rows: readonly NextUpRow[], goalSubjectIds: readonly string[], limit = NEXT_UP_LIMIT): NextUpJson[] {
    const bySubject = new Map<string, NextUpRow[]>();
    for (const row of rows) bySubject.set(row.subjectId, [...(bySubject.get(row.subjectId) ?? []), row]);
    const goal = new Set(goalSubjectIds);
    const entries: Array<{ json: NextUpJson; active: number; goal: boolean }> = [];
    for (const subjectRows of bySubject.values()) {
        const subject = subjectRows[0]!.subject;
        const path = toJson(subject, pathOrder(subjectRows));
        if (!path.next) continue;
        const active = Math.max(subject.lastActiveAt.getTime(), ...subjectRows.map((r) => r.updatedAt.getTime()));
        entries.push({
            json: {
                subject: { ...path.subject, color: subject.color },
                topic: { _id: path.next._id, title: path.next.title, position: path.next.position, status: path.next.status },
                done: path.done,
                total: path.total,
                nextStep: path.next.nextStep,
            },
            active,
            goal: goal.has(subject.id),
        });
    }
    entries.sort((a, b) => Number(b.goal) - Number(a.goal) || b.active - a.active || a.json.subject.name.localeCompare(b.json.subject.name));
    return entries.slice(0, limit).map((e) => e.json);
}

/** Next up for a user (loads the active goals' subjects itself). */
export async function nextUp(userId: string, db: DbClient = prisma): Promise<NextUpJson[]> {
    const [rows, links] = await Promise.all([
        loadNextUpRows(userId, db),
        db.goalSubject.findMany({ where: { goal: { userId, status: 'active' } }, select: { subjectId: true } }),
    ]);
    return nextUpOf(rows, links.map((l) => l.subjectId));
}

// ─── A doc becomes a topic's note (create_doc / update_doc with topicId) ──────────────────────────

/** The topic as it was before a doc was attached (Undo, or a failed create, puts it back). */
export interface TopicBeforeAttach {
    topicId: string;
    title: string;
    status: TopicStatus;
    startedAt: string | null;
    doneAt: string | null;
    /** The attach started the topic's revisions (Undo removes them while none is done). */
    startedRevisions: boolean;
}

export interface AttachedTopic {
    before: TopicBeforeAttach;
    subject: { id: string; name: string };
    status: TopicStatus;
    /** The first revision's day when the attach started them. */
    nextRevision: string | null;
}

/**
 * `docId` becomes the note of a topic on a path (SYNC_SPINE_SPEC 1.1): the topic takes the doc and
 * its title; with `revise` it is done and its revisions start (1, 3, 7, 21 days), otherwise it is in
 * progress (a done topic stays done). 404 for an unknown topic; 400 when it has a doc already or is
 * in another subject than `subjectId`; 409 when the doc is already another topic.
 */
export async function attachDocToTopic(
    userId: string,
    input: { topicId: string; docId: string; title: string; revise: boolean; subjectId?: string | undefined },
    now: Date = new Date()
): Promise<AttachedTopic> {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Topic" WHERE "id" = ${input.topicId} AND "userId" = ${userId} FOR UPDATE`;
        const topic = await tx.topic.findFirst({
            where: { id: input.topicId, userId, isArchived: false },
            select: { id: true, title: true, status: true, startedAt: true, doneAt: true, docId: true, subject: { select: { id: true, name: true } } },
        });
        if (!topic) throw new LearningHttpError(404, 'NOT_FOUND', `No topic with id ${input.topicId} (get_path shows them)`);
        if (topic.docId) throw badRequest(`Topic ${topic.id} already has a doc (${topic.docId}): write into that doc, or plan a new topic`, 'TOPIC_HAS_DOC');
        if (input.subjectId && input.subjectId !== topic.subject.id) {
            throw badRequest(`Topic ${topic.id} is on the path of "${topic.subject.name}", not of the subject you named`, 'TOPIC_SUBJECT_MISMATCH');
        }
        const other = await tx.topic.findUnique({ where: { userId_docId: { userId, docId: input.docId } }, select: { id: true } });
        if (other) throw conflict(`This doc is already topic ${other.id}`, 'TOPIC_EXISTS');

        const status: TopicStatus = input.revise || topic.status === 'done' ? 'done' : 'in_progress';
        await tx.topic.update({
            where: { id: topic.id },
            data: {
                docId: input.docId,
                title: input.title,
                status,
                startedAt: topic.startedAt ?? now,
                doneAt: status === 'done' ? (topic.doneAt ?? now) : null,
            },
            select: { id: true },
        });
        let startedRevisions = false;
        let nextRevision: string | null = null;
        if (input.revise && (await tx.revision.count({ where: { topicId: topic.id } })) === 0) {
            const ctx = await loadLearningContext(userId, now, tx);
            await createRevisionChain(tx, userId, { topicId: topic.id }, ctx.today);
            startedRevisions = true;
            const first = await tx.revision.findFirst({ where: { topicId: topic.id, status: 'pending' }, orderBy: { cycleNumber: 'asc' }, select: { scheduledFor: true } });
            nextRevision = first ? fromDbDay(first.scheduledFor) : null;
        }
        await tx.subject.update({ where: { id: topic.subject.id }, data: { lastActiveAt: now }, select: { id: true } });
        return {
            before: {
                topicId: topic.id,
                title: topic.title,
                status: topic.status,
                startedAt: topic.startedAt?.toISOString() ?? null,
                doneAt: topic.doneAt?.toISOString() ?? null,
                startedRevisions,
            },
            subject: topic.subject,
            status,
            nextRevision,
        };
    });
}

/**
 * Undo of attachDocToTopic: the topic loses the doc and gets its old title, status and dates back,
 * and the revisions the attach started go. 409 once one of those revisions was done (the topic
 * has been learned since). A topic deleted since counts as done.
 */
export async function detachDocFromTopic(userId: string, before: TopicBeforeAttach): Promise<void> {
    await prisma.$transaction(async (tx) => {
        const topic = await tx.topic.findFirst({ where: { id: before.topicId, userId }, select: { id: true } });
        if (!topic) return;
        if (before.startedRevisions) {
            const done = await tx.revision.count({ where: { topicId: topic.id, status: 'done' } });
            if (done > 0) throw conflict("Can't undo: a revision of this topic was done since", 'TOPIC_REVISED');
            await tx.revision.deleteMany({ where: { topicId: topic.id } });
        }
        await tx.topic.update({
            where: { id: topic.id },
            data: {
                docId: null,
                title: before.title,
                status: before.status,
                startedAt: before.startedAt ? new Date(before.startedAt) : null,
                doneAt: before.doneAt ? new Date(before.doneAt) : null,
            },
            select: { id: true },
        });
    });
}

/** Every place on a subject's path (Undo of a topic change puts them back). */
export async function pathPlaces(userId: string, subjectId: string, db: DbClient = prisma): Promise<Record<string, number | null>> {
    const rows = await db.topic.findMany({ where: { userId, subjectId }, select: { id: true, sortOrder: true } });
    return Object.fromEntries(rows.map((r) => [r.id, r.sortOrder]));
}
