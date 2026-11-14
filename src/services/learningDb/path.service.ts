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
import { badRequest, notFound } from '../learning/http';

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
    return toJson(subject, await loadRows(db, userId, subjectId));
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

/** Every place on a subject's path (Undo of a topic change puts them back). */
export async function pathPlaces(userId: string, subjectId: string, db: DbClient = prisma): Promise<Record<string, number | null>> {
    const rows = await db.topic.findMany({ where: { userId, subjectId }, select: { id: true, sortOrder: true } });
    return Object.fromEntries(rows.map((r) => [r.id, r.sortOrder]));
}
