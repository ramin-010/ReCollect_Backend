// Subjects, topics, captures and quick notes (LEARNING_SPEC §2 #8–20, #22–24). Owner only:
// every query is scoped by the logged-in user, and another user's id is a 404 `Not found`.
import { Prisma } from '@prisma/client';
import type { CaptureType, QuickNoteCategory } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { isUniqueViolation } from '../../db/errors';
import { batchDeleteFromCloud } from '../../utils/cloudinary';
import { findAccessibleDoc } from '../docs/docs.service';
import { assertCanBeLesson, lessonOf } from '../docs/docTree.service';
import { nextRevisionAction } from '../learning';
import { badRequest, conflict, notFound } from '../learning/http';
import {
    serializeCapture,
    serializeChain,
    serializeChainRevision,
    serializeQuickNote,
    serializeSubject,
    serializeTopic,
    topicTitle,
    type ChainRevisionJson,
} from '../../db/serializers/learning';
import { loadLearningContext, toEngineRevision } from './common';
import { createRevisionChain, loadChain, rethrowAlreadyStarted } from './revisions.service';
import { deleteStoredFiles } from './uploads.service';

/** Revise's default subject colour. */
export const DEFAULT_SUBJECT_COLOR = '#007acc';

const subjectRefSelect = { id: true, name: true, color: true } as const;

/** [{ url, publicId, fileName, fileType }] */
export type AttachmentJson = { url: string; publicId: string; fileName: string; fileType: string };

const publicIdsOf = (attachments: Prisma.JsonValue): string[] =>
    Array.isArray(attachments)
        ? attachments
              .map((a) => (a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>).publicId : null))
              .filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];

/** Cloudinary cleanup after a commit: failures are logged and ignored. */
function cleanupCloud(publicIds: string[]): void {
    if (publicIds.length === 0) return;
    batchDeleteFromCloud(publicIds).catch((err) => console.error('[learning] Cloudinary cleanup failed:', err));
}

async function ownedSubjectOr404(userId: string, subjectId: string) {
    const s = await prisma.subject.findFirst({ where: { id: subjectId, userId }, select: { id: true } });
    if (!s) throw notFound();
    return s;
}

// ─── Subjects ──────────────────────────────────────────────────────────

/** #8: subjects (oldest first) with their non-archived topics. */
export async function listSubjects(userId: string) {
    const subjects = await prisma.subject.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
            topics: {
                where: { isArchived: false },
                select: { id: true, title: true, docId: true, doc: { select: { title: true } } },
                orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            },
        },
    });
    return subjects.map(({ topics, ...s }) => ({
        ...serializeSubject(s),
        topics: topics.map((t) => ({ _id: t.id, title: topicTitle(t, t.doc?.title), docId: t.docId })),
    }));
}

export interface SubjectInput {
    name?: string | undefined;
    description?: string | null | undefined;
    color?: string | null | undefined;
    icon?: string | null | undefined;
}

function subjectData(input: SubjectInput): Prisma.SubjectUpdateInput {
    const data: Prisma.SubjectUpdateInput = {};
    if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw badRequest('Subject name is required');
        data.name = name;
    }
    if (input.description !== undefined) data.description = input.description?.trim() || null;
    if (input.color !== undefined) data.color = input.color?.trim() || null;
    if (input.icon !== undefined) data.icon = input.icon?.trim() || null;
    return data;
}

/** #9 */
export async function createSubject(userId: string, input: SubjectInput) {
    const data = subjectData({ ...input, name: input.name ?? '' });
    const row = await prisma.subject.create({
        data: {
            userId,
            name: data.name as string,
            description: (data.description as string | null | undefined) ?? null,
            icon: (data.icon as string | null | undefined) ?? null,
            color: (data.color as string | null | undefined) ?? DEFAULT_SUBJECT_COLOR,
        },
    });
    return serializeSubject(row);
}

/** #10 */
export async function updateSubject(userId: string, subjectId: string, input: SubjectInput) {
    await ownedSubjectOr404(userId, subjectId);
    const row = await prisma.subject.update({ where: { id: subjectId }, data: subjectData(input) });
    return serializeSubject(row);
}

// #11, deleting a subject: services/learningDb/subjectDeletion.service.ts (everything in it, a week's undo).

// ─── Topics ────────────────────────────────────────────────────────────

const chainOrder = { cycleNumber: 'asc' } as const;

/** #12: the caller's topic for a doc they can view (404 otherwise), its chain and the button state. */
export async function topicByDoc(userId: string, docId: string, now: Date = new Date()) {
    const doc = await findAccessibleDoc(docId, userId);
    if (!doc) throw notFound();
    const ctx = await loadLearningContext(userId, now);
    const topic = await prisma.topic.findUnique({ where: { userId_docId: { userId, docId } } });
    // STUDY_FLOW_PLAN §4.4: the doc's revision card (its pointer; the card route says 404 if its heading is gone).
    const hasCard = !!doc.cardBlockId;
    // DOC_PAGES_PLAN §3.2 (D5): a page inside a lesson has no topic of its own; it is revised with that lesson.
    if (!topic) return { topic: null, chain: [] as ChainRevisionJson[], nextAction: { kind: 'start' as const }, hasCard, lesson: await lessonOf(docId, userId) };
    const rows = await prisma.revision.findMany({ where: { topicId: topic.id }, orderBy: chainOrder });
    const action = nextRevisionAction(rows.map(toEngineRevision), ctx.today);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const nextAction =
        action.kind === 'start' || action.kind === 'completed'
            ? action
            : { ...action, next: serializeChainRevision(byId.get(action.next.id)!) };
    return { topic: serializeTopic(topic, doc.title), chain: serializeChain(rows), nextAction, hasCard, lesson: null };
}

/**
 * The Docs library's status column in one call: every live topic of the caller with its doc,
 * subject and the same next-action the doc page shows (start / wait / early / due / completed).
 */
export async function topicStatuses(userId: string, now: Date = new Date()) {
    const ctx = await loadLearningContext(userId, now);
    const topics = await prisma.topic.findMany({
        where: { userId, isArchived: false },
        select: { id: true, docId: true, subjectId: true, title: true },
    });
    if (topics.length === 0) return [];
    const rows = await prisma.revision.findMany({
        where: { topicId: { in: topics.map((t) => t.id) } },
        orderBy: [{ topicId: 'asc' }, chainOrder],
    });
    const byTopic = new Map<string, typeof rows>();
    for (const r of rows) {
        if (!r.topicId) continue;
        const list = byTopic.get(r.topicId);
        if (list) list.push(r);
        else byTopic.set(r.topicId, [r]);
    }
    return topics.map((t) => {
        const chain = byTopic.get(t.id) ?? [];
        const action = nextRevisionAction(chain.map(toEngineRevision), ctx.today);
        const next = action.kind === 'start' || action.kind === 'completed' ? null : chain.find((r) => r.id === action.next.id) ?? null;
        return {
            topicId: t.id,
            docId: t.docId,
            subjectId: t.subjectId,
            title: t.title,
            state: action.kind,
            inDays: action.kind === 'wait' ? action.inDays : action.kind === 'early' ? 1 : action.kind === 'due' ? 0 : null,
            next: next ? serializeChainRevision(next) : null,
            done: chain.filter((r) => r.status === 'done').length,
            total: chain.length,
        };
    });
}

export interface CreateTopicInput {
    docId: string;
    subjectId: string;
    tags?: string[] | undefined;
    startRevisions?: boolean | undefined;
}

const normalizeTags = (tags: readonly string[]): string[] => [...new Set(tags.map((t) => t.trim()).filter(Boolean))];

/** #13: a topic for a doc the user can view, in one of their subjects; 409 when it exists. */
export async function createTopic(userId: string, input: CreateTopicInput, now: Date = new Date()) {
    const doc = await findAccessibleDoc(input.docId, userId);
    if (!doc) throw notFound();
    await ownedSubjectOr404(userId, input.subjectId);
    const existing = await prisma.topic.findUnique({ where: { userId_docId: { userId, docId: input.docId } }, select: { id: true } });
    if (existing) throw conflict('This doc is already a topic', 'TOPIC_EXISTS');
    // DOC_PAGES_PLAN D5: one lesson per branch.
    await assertCanBeLesson(input.docId, userId);

    let topicId: string;
    try {
        topicId = await prisma.$transaction(async (tx) => {
            const ctx = await loadLearningContext(userId, now, tx);
            const topic = await tx.topic.create({
                data: { userId, subjectId: input.subjectId, docId: input.docId, title: doc.title, tags: normalizeTags(input.tags ?? []) },
                select: { id: true },
            });
            if (input.startRevisions !== false) await createRevisionChain(tx, userId, { topicId: topic.id }, ctx.today);
            await tx.subject.update({ where: { id: input.subjectId }, data: { lastActiveAt: now }, select: { id: true } });
            return topic.id;
        });
    } catch (err) {
        if (isUniqueViolation(err, 'docId')) throw conflict('This doc is already a topic', 'TOPIC_EXISTS');
        return rethrowAlreadyStarted(err);
    }
    const topic = await prisma.topic.findUniqueOrThrow({ where: { id: topicId } });
    return { topic: serializeTopic(topic, doc.title), chain: await loadChain({ topicId }) };
}

async function ownedTopicOr404(userId: string, topicId: string) {
    const t = await prisma.topic.findFirst({ where: { id: topicId, userId } });
    if (!t) throw notFound();
    return t;
}

async function docTitleOf(docId: string | null): Promise<string | null> {
    if (!docId) return null;
    return (await prisma.doc.findUnique({ where: { id: docId }, select: { title: true } }))?.title ?? null;
}

/** #14 */
export async function updateTopic(userId: string, topicId: string, input: { subjectId?: string | undefined; tags?: string[] | undefined; isArchived?: boolean | undefined }) {
    await ownedTopicOr404(userId, topicId);
    if (input.subjectId !== undefined) await ownedSubjectOr404(userId, input.subjectId);
    const data: Prisma.TopicUncheckedUpdateInput = {};
    if (input.subjectId !== undefined) data.subjectId = input.subjectId;
    if (input.tags !== undefined) data.tags = normalizeTags(input.tags);
    if (input.isArchived !== undefined) data.isArchived = input.isArchived;
    const row = await prisma.topic.update({ where: { id: topicId }, data });
    return serializeTopic(row, await docTitleOf(row.docId));
}

/** #15: the topic and its revisions go; the doc stays; its captures keep their subject (topicId SET NULL). */
export async function deleteTopic(userId: string, topicId: string): Promise<{ deleted: true }> {
    const { count } = await prisma.topic.deleteMany({ where: { id: topicId, userId } });
    if (count === 0) throw notFound();
    return { deleted: true };
}

/** #16: the topic's doc, creating an empty doc titled after the topic when it has none (or it was deleted). */
export async function ensureTopicDoc(userId: string, topicId: string): Promise<{ docId: string }> {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Topic" WHERE "id" = ${topicId} FOR UPDATE`;
        const topic = await tx.topic.findFirst({ where: { id: topicId, userId }, select: { id: true, docId: true, title: true } });
        if (!topic) throw notFound();
        if (topic.docId) return { docId: topic.docId };
        const doc = await tx.doc.create({ data: { userId, title: topic.title.trim() || 'Untitled', cloudImages: [] }, select: { id: true } });
        await tx.topic.update({ where: { id: topic.id }, data: { docId: doc.id }, select: { id: true } });
        return { docId: doc.id };
    });
}

// ─── Captures ──────────────────────────────────────────────────────────

/** #17: distinct categories, alphabetical. */
export async function listCaptureCategories(userId: string): Promise<string[]> {
    const rows = await prisma.capture.findMany({
        where: { userId, category: { not: null } },
        distinct: ['category'],
        select: { category: true },
        orderBy: { category: 'asc' },
    });
    return rows.map((r) => r.category).filter((c): c is string => !!c);
}

export interface ListCapturesInput {
    /** Keeps the captures that hold every word (in the title, the text or the link), case-insensitive. */
    q?: string | undefined;
    /** Only the inbox: captures not on a revision schedule (Home's inbox). */
    inbox?: boolean | undefined;
    /** STUDY_FLOW_PLAN §4.3: one lesson's notes (the doc's right sidebar). */
    topicId?: string | undefined;
    /** A subject's own notes; with `lessons`, its lessons' too (each names its lesson). */
    subjectId?: string | undefined;
    lessons?: boolean | undefined;
    limit?: number | undefined;
}

export const CAPTURES_LIST_DEFAULT = 20;
export const CAPTURES_LIST_MAX = 200;

/**
 * Ctrl K → Find and All notes › Inbox: the user's captures, pinned first, then newest. Find
 * searches all of them (also the ones being revised); the inbox lists the ones not on a schedule.
 */
export async function listCaptures(userId: string, input: ListCapturesInput = {}) {
    const terms = (input.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
    const rows = await prisma.capture.findMany({
        where: {
            userId,
            ...(input.inbox ? { revisions: { none: { status: 'pending' } } } : {}),
            ...(input.topicId ? { topicId: input.topicId } : {}),
            ...(input.subjectId ? { subjectId: input.subjectId, ...(input.lessons ? {} : { topicId: null }) } : {}),
            AND: terms.map((t) => ({
                OR: [
                    { title: { contains: t, mode: 'insensitive' as const } },
                    { content: { contains: t, mode: 'insensitive' as const } },
                    { url: { contains: t, mode: 'insensitive' as const } },
                ],
            })),
        },
        include: { subject: { select: subjectRefSelect }, topic: { select: { title: true, docId: true, doc: { select: { title: true } } } }, doc: { select: { id: true, title: true } } },
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: Math.min(CAPTURES_LIST_MAX, Math.max(1, input.limit ?? CAPTURES_LIST_DEFAULT)),
    });
    // DOC_PAGES_PLAN D4: each note names the page it was written on.
    return rows.map(({ subject, topic, doc, ...c }) => ({
        ...serializeCapture(c, subject),
        lesson: topic ? { docId: topic.docId, title: topic.doc?.title || topic.title } : null,
        page: doc ? { id: doc.id, title: doc.title } : null,
    }));
}

/** '#Tag' / ' tag ' → 'Tag' / 'tag'; empty → null. */
export function normalizeCategory(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const c = value.trim().replace(/^#+/, '').trim();
    return c || null;
}

const trimOrNull = (v: string | null | undefined): string | null => (v === null || v === undefined ? null : v.trim() || null);

export interface CreateCaptureInput {
    type?: CaptureType | undefined;
    title?: string | undefined;
    content?: string | undefined;
    url?: string | undefined;
    category?: string | undefined;
    subjectId?: string | undefined;
    topicId?: string | undefined;
    isPinned?: boolean | undefined;
    attachments?: AttachmentJson[] | undefined;
    revise?: boolean | undefined;
    /** DOC_PAGES_PLAN D4: the page it is written on; kept only when that page is revised with the note's lesson (topicId). */
    docId?: string | undefined;
}

async function loadCaptureJson(captureId: string) {
    const row = await prisma.capture.findUniqueOrThrow({ where: { id: captureId }, include: { subject: { select: subjectRefSelect } } });
    const { subject, ...capture } = row;
    return serializeCapture(capture, subject);
}

/** #18: a NOTE/LINK capture; `revise` starts its cycles in the same transaction. */
export async function createCapture(userId: string, input: CreateCaptureInput, now: Date = new Date()) {
    const title = trimOrNull(input.title);
    const content = input.content?.trim() ? input.content : null;
    const url = trimOrNull(input.url);
    const attachments = input.attachments ?? [];
    if (!title && !content && !url && attachments.length === 0) throw badRequest('A capture needs a title, content, a link or a file');

    let subjectId: string | null = input.subjectId ?? null;
    if (input.subjectId) await ownedSubjectOr404(userId, input.subjectId);
    if (input.topicId) {
        const topic = await ownedTopicOr404(userId, input.topicId);
        subjectId ??= topic.subjectId; // a topic's resource belongs to the topic's subject
    }
    let docId: string | null = null;
    if (input.docId && input.topicId && (await findAccessibleDoc(input.docId, userId)) && (await lessonOf(input.docId, userId))?.topicId === input.topicId) docId = input.docId;

    let captureId: string;
    try {
        captureId = await prisma.$transaction(async (tx) => {
            const ctx = await loadLearningContext(userId, now, tx);
            const created = await tx.capture.create({
                data: {
                    userId,
                    type: input.type ?? (url && !content ? 'LINK' : 'NOTE'),
                    title,
                    content,
                    url,
                    category: normalizeCategory(input.category),
                    isPinned: input.isPinned ?? false,
                    subjectId,
                    topicId: input.topicId ?? null,
                    docId,
                    attachments,
                },
                select: { id: true },
            });
            if (input.revise) await createRevisionChain(tx, userId, { captureId: created.id }, ctx.today);
            return created.id;
        });
    } catch (err) {
        return rethrowAlreadyStarted(err);
    }
    return { capture: await loadCaptureJson(captureId), ...(input.revise ? { chain: await loadChain({ captureId }) } : {}) };
}

export interface UpdateCaptureInput {
    title?: string | null | undefined;
    content?: string | null | undefined;
    url?: string | null | undefined;
    category?: string | null | undefined;
    isPinned?: boolean | undefined;
    /** null = move to the Inbox */
    subjectId?: string | null | undefined;
    /** TOOL_ACCESS_PLAN §11.3: the whole new list of files. */
    attachments?: Array<{ url: string; publicId: string; fileName: string; fileType: string; size?: number | undefined; resourceType?: string | undefined }> | undefined;
}

/** #19 */
export async function updateCapture(userId: string, captureId: string, input: UpdateCaptureInput) {
    const owned = await prisma.capture.findFirst({ where: { id: captureId, userId }, select: { id: true } });
    if (!owned) throw notFound();
    if (input.subjectId) await ownedSubjectOr404(userId, input.subjectId);
    const data: Prisma.CaptureUncheckedUpdateInput = {};
    if (input.title !== undefined) data.title = trimOrNull(input.title);
    if (input.content !== undefined) data.content = input.content?.trim() ? input.content : null;
    if (input.url !== undefined) data.url = trimOrNull(input.url);
    if (input.category !== undefined) data.category = normalizeCategory(input.category);
    if (input.isPinned !== undefined) data.isPinned = input.isPinned;
    if (input.subjectId !== undefined) data.subjectId = input.subjectId;
    // TOOL_ACCESS_PLAN §11.3: the whole new list of files; one dropped from it leaves storage after the save.
    const before = input.attachments !== undefined ? await prisma.capture.findUniqueOrThrow({ where: { id: captureId }, select: { attachments: true } }) : null;
    if (input.attachments !== undefined) data.attachments = input.attachments as unknown as Prisma.InputJsonValue;
    await prisma.capture.update({ where: { id: captureId }, data, select: { id: true } });
    if (before && input.attachments) {
        const kept = new Set(input.attachments.map((f) => f.publicId));
        deleteStoredFiles((Array.isArray(before.attachments) ? (before.attachments as Array<{ publicId?: unknown; resourceType?: unknown; fileType?: unknown }>) : []).filter((f) => typeof f?.publicId === 'string' && !kept.has(f.publicId)));
    }
    return loadCaptureJson(captureId);
}

/** #20: the capture and its revisions; its files are deleted from Cloudinary after the commit. */
export async function deleteCapture(userId: string, captureId: string): Promise<{ deleted: true }> {
    const row = await prisma.capture.findFirst({ where: { id: captureId, userId }, select: { id: true, attachments: true, cloudPublicId: true } });
    if (!row) throw notFound();
    const { count } = await prisma.capture.deleteMany({ where: { id: captureId, userId } });
    if (count === 0) throw notFound();
    deleteStoredFiles(Array.isArray(row.attachments) ? (row.attachments as Array<{ publicId?: unknown; resourceType?: unknown; fileType?: unknown }>) : []);
    cleanupCloud(row.cloudPublicId ? [row.cloudPublicId] : []);
    return { deleted: true };
}

// ─── Quick notes ───────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertQuickNoteId(id: string): void {
    if (!UUID_RE.test(id)) throw badRequest('A quick note id must be a UUID', 'INVALID_ID');
}

/** #22: create (201) or update (200) by the client's UUID; another user's id is a 404. */
export async function putQuickNote(
    userId: string,
    id: string,
    input: { content: string; category: QuickNoteCategory; attachments?: AttachmentJson[] | undefined }
): Promise<{ created: boolean; note: ReturnType<typeof serializeQuickNote> }> {
    assertQuickNoteId(id);
    const attachments = input.attachments;
    if (!input.content.trim() && !(attachments && attachments.length > 0)) throw badRequest('A quick note cannot be empty');

    const write = async (): Promise<{ created: boolean; note: ReturnType<typeof serializeQuickNote> }> => {
        const existing = await prisma.quickNote.findUnique({ where: { id }, select: { userId: true } });
        if (existing && existing.userId !== userId) throw notFound();
        if (existing) {
            const note = await prisma.quickNote.update({
                where: { id },
                data: { content: input.content, category: input.category, ...(attachments !== undefined ? { attachments } : {}) },
            });
            return { created: false, note: serializeQuickNote(note) };
        }
        const note = await prisma.quickNote.create({
            data: { id, userId, content: input.content, category: input.category, attachments: attachments ?? [] },
        });
        return { created: true, note: serializeQuickNote(note) };
    };

    try {
        return await write();
    } catch (err) {
        // Two saves of a brand-new note raced: the other one created it, so this one updates.
        if (isUniqueViolation(err)) return write();
        throw err;
    }
}

/** #23 */
export async function pinQuickNote(userId: string, id: string, isPinned: boolean) {
    const { count } = await prisma.quickNote.updateMany({ where: { id, userId }, data: { isPinned } });
    if (count === 0) throw notFound();
    return serializeQuickNote(await prisma.quickNote.findUniqueOrThrow({ where: { id } }));
}

/** #24 */
export async function deleteQuickNote(userId: string, id: string): Promise<{ deleted: true }> {
    const row = await prisma.quickNote.findFirst({ where: { id, userId }, select: { attachments: true } });
    if (!row) throw notFound();
    await prisma.quickNote.deleteMany({ where: { id, userId } });
    deleteStoredFiles(Array.isArray(row.attachments) ? (row.attachments as Array<{ publicId?: unknown; resourceType?: unknown; fileType?: unknown }>) : []);
    return { deleted: true };
}
