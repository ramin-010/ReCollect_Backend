// Subjects, topics, captures, uploads and quick notes (#8–24). Thin controllers.
import { z } from 'zod';
import { requireUser } from '../../middlwares/auth';
import { badRequest } from '../../services/learning/http';
import { deleteSubjectWithUndo, deletionPreview, listSubjectDeletions, undoSubjectDeletion } from '../../services/learningDb/subjectDeletion.service';
import {
    createCapture,
    createSubject,
    createTopic,
    deleteCapture,
    deleteQuickNote,
    deleteTopic,
    ensureTopicDoc,
    CAPTURES_LIST_MAX,
    listCaptureCategories,
    listCaptures,
    listSubjects,
    pinQuickNote,
    putQuickNote,
    topicByDoc,
    topicStatuses,
    updateCapture,
    updateSubject,
    updateTopic,
} from '../../services/learningDb/items.service';
import { uploadToCloud } from '../../services/learningDb/uploads.service';
import { appendDocCloudImage } from '../../services/docs/docs.service';
import { hearPocketNote } from '../../services/buddy/chatEar';
import { handler, ok, param, parse, zAttachment, zId } from './common';

const text = (max: number) => z.string().max(max);
const optText = (max: number) => text(max).nullable().optional();
const zTags = z.array(z.string().max(64)).max(50);

// ─── Subjects ──────────────────────────────────────────────────────────

const subjectCreateSchema = z.object({
    name: z.string().trim().min(1, 'Subject name is required').max(100),
    description: optText(2000),
    color: optText(32),
    icon: optText(64),
});
const subjectPatchSchema = subjectCreateSchema.partial();

export const listSubjectsHandler = handler(async (req, res) => {
    ok(res, await listSubjects(requireUser(req).id));
});
export const createSubjectHandler = handler(async (req, res) => {
    ok(res, await createSubject(requireUser(req).id, parse(subjectCreateSchema, req.body)), 201);
});
export const updateSubjectHandler = handler(async (req, res) => {
    ok(res, await updateSubject(requireUser(req).id, param(req, 'id'), parse(subjectPatchSchema, req.body)));
});
/** The subject and everything in it, undoable for a week (services/learningDb/subjectDeletion.service.ts). */
export const deleteSubjectHandler = handler(async (req, res) => {
    ok(res, await deleteSubjectWithUndo(requireUser(req).id, param(req, 'id')));
});
export const subjectDeletionPreviewHandler = handler(async (req, res) => {
    ok(res, await deletionPreview(requireUser(req).id, param(req, 'id')));
});
export const listSubjectDeletionsHandler = handler(async (req, res) => {
    ok(res, await listSubjectDeletions(requireUser(req).id));
});
export const undoSubjectDeletionHandler = handler(async (req, res) => {
    ok(res, await undoSubjectDeletion(requireUser(req).id, param(req, 'id')));
});

// ─── Topics ────────────────────────────────────────────────────────────

const topicCreateSchema = z.object({
    docId: zId,
    subjectId: zId,
    tags: zTags.optional(),
    startRevisions: z.boolean().optional(),
});
const topicPatchSchema = z.object({
    subjectId: zId.optional(),
    tags: zTags.optional(),
    isArchived: z.boolean().optional(),
});

export const topicByDocHandler = handler(async (req, res) => {
    ok(res, await topicByDoc(requireUser(req).id, param(req, 'docId')));
});
export const topicStatusesHandler = handler(async (req, res) => {
    ok(res, await topicStatuses(requireUser(req).id));
});
export const createTopicHandler = handler(async (req, res) => {
    ok(res, await createTopic(requireUser(req).id, parse(topicCreateSchema, req.body)), 201);
});
export const updateTopicHandler = handler(async (req, res) => {
    ok(res, await updateTopic(requireUser(req).id, param(req, 'id'), parse(topicPatchSchema, req.body)));
});
export const deleteTopicHandler = handler(async (req, res) => {
    ok(res, await deleteTopic(requireUser(req).id, param(req, 'id')));
});
export const ensureTopicDocHandler = handler(async (req, res) => {
    ok(res, await ensureTopicDoc(requireUser(req).id, param(req, 'id')));
});

// ─── Captures ──────────────────────────────────────────────────────────

const captureCreateSchema = z.object({
    type: z.enum(['NOTE', 'LINK']).optional(),
    title: text(500).optional(),
    content: text(100_000).optional(),
    url: text(2048).optional(),
    category: text(64).optional(),
    subjectId: zId.optional(),
    topicId: zId.optional(),
    isPinned: z.boolean().optional(),
    attachments: z.array(zAttachment).max(20).optional(),
    revise: z.boolean().optional(),
    // DOC_PAGES_PLAN D4: the page it is written on (with topicId, its lesson).
    docId: zId.optional(),
});
const capturePatchSchema = z.object({
    title: optText(500),
    content: optText(100_000),
    url: optText(2048),
    category: optText(64),
    isPinned: z.boolean().optional(),
    subjectId: zId.nullable().optional(),
    // TOOL_ACCESS_PLAN §11.3: the whole new list of files (one dropped from it leaves storage after the save).
    attachments: z.array(zAttachment).max(20).optional(),
});

const flag = z.enum(['1', '0', 'true', 'false']).optional();
const captureListSchema = z.object({
    q: text(200).optional(),
    inbox: flag,
    topicId: zId.optional(),
    subjectId: zId.optional(),
    lessons: flag,
    limit: z.coerce.number().int().min(1).max(CAPTURES_LIST_MAX).optional(),
});
const on = (v: string | undefined) => v === '1' || v === 'true';

export const listCapturesHandler = handler(async (req, res) => {
    const query = parse(captureListSchema, req.query);
    ok(res, await listCaptures(requireUser(req).id, { q: query.q, inbox: on(query.inbox), topicId: query.topicId, subjectId: query.subjectId, lessons: on(query.lessons), limit: query.limit }));
});
export const captureCategoriesHandler = handler(async (req, res) => {
    ok(res, await listCaptureCategories(requireUser(req).id));
});
export const createCaptureHandler = handler(async (req, res) => {
    ok(res, await createCapture(requireUser(req).id, parse(captureCreateSchema, req.body)), 201);
});
export const updateCaptureHandler = handler(async (req, res) => {
    ok(res, await updateCapture(requireUser(req).id, param(req, 'id'), parse(capturePatchSchema, req.body)));
});
export const deleteCaptureHandler = handler(async (req, res) => {
    ok(res, await deleteCapture(requireUser(req).id, param(req, 'id')));
});

// ─── #21 Uploads ───────────────────────────────────────────────────────

export const uploadHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const file = req.file;
    if (!file || !file.buffer) throw badRequest('No file uploaded (field "file")', 'NO_FILE');
    const stored = await uploadToCloud({ buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype });
    // 11-27: a doc's File block sends its doc's id; the file is listed on the doc (Doc.cloudImages, with its kind), so the
    // doc's cleanup deletes it once no block or link in the doc points at it, as it does images. Not recorded (no edit
    // right on that doc): the upload still answers, as an image's does.
    const docId = typeof req.body?.docId === 'string' ? req.body.docId.trim() : '';
    if (docId && stored.publicId) {
        await appendDocCloudImage(docId, userId, { imageId: stored.publicId, cloudUrl: stored.url, cloudPublicId: stored.publicId, ...(stored.resourceType ? { resourceType: stored.resourceType } : {}) }).catch((err: unknown) =>
            console.error('[uploads] a doc file was not recorded on its doc:', err),
        );
    }
    ok(res, stored);
});

// ─── Quick notes ───────────────────────────────────────────────────────

const quickNotePutSchema = z.object({
    content: text(100_000),
    category: z.enum(['PRIMARY', 'TEMPORARY']),
    attachments: z.array(zAttachment).max(20).optional(),
});
const quickNotePatchSchema = z.object({ isPinned: z.boolean() });

export const putQuickNoteHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const { created, note } = await putQuickNote(userId, param(req, 'id'), parse(quickNotePutSchema, req.body));
    // A new note of his own (not an agent's) is one of the buddy's ears; a failure there never fails the save.
    if (created && req.auth?.via !== 'token') {
        await hearPocketNote(userId, { id: note._id, content: note.content }).catch((err: unknown) => console.warn(`[buddy] a pocket note was not queued: ${(err as Error).message}`));
    }
    ok(res, note, created ? 201 : 200);
});
export const pinQuickNoteHandler = handler(async (req, res) => {
    const { isPinned } = parse(quickNotePatchSchema, req.body);
    ok(res, await pinQuickNote(requireUser(req).id, param(req, 'id'), isPinned));
});
export const deleteQuickNoteHandler = handler(async (req, res) => {
    ok(res, await deleteQuickNote(requireUser(req).id, param(req, 'id')));
});
