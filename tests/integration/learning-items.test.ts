// LEARNING_SPEC §2 #8–24: subjects, topics, captures, uploads, quick notes. Owner only (another
// user's ids are 404), zod validation (400), Cloudinary mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));
vi.mock('../../src/services/learningDb/uploads.service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/services/learningDb/uploads.service')>()),
    uploadToCloud: vi.fn(async (file: { originalname: string; mimetype: string }) => ({
        url: `https://cdn.test/${file.originalname}`,
        publicId: `recollect-learning/${file.originalname}`,
        fileName: file.originalname,
        fileType: file.mimetype,
    })),
}));

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { batchDeleteFromCloud } from '../../src/utils/cloudinary';
import { addDays, today as todayIn } from '../../src/services/learning';
import { authCookie } from '../helpers/auth';
import { api, createChainRows, createLearner, createSubjectRow, createTopicRow } from '../helpers/learning';

const IST = 'Asia/Kolkata';

beforeEach(() => vi.mocked(batchDeleteFromCloud).mockClear());

describe('subjects', () => {
    it('create (201, default colour), list with topics, patch, delete', async () => {
        const user = await createLearner();
        const created = await api(user).post('/api/subjects', { name: '  Graphs ', description: 'BFS/DFS' });
        expect(created.status).toBe(201);
        expect(created.body.data).toMatchObject({ name: 'Graphs', description: 'BFS/DFS', color: '#007acc', icon: null });
        const id = created.body.data._id;
        await createTopicRow(user.id, id, 'BFS');

        const list = await api(user).get('/api/subjects');
        expect(list.body.data).toEqual([expect.objectContaining({ _id: id, name: 'Graphs', topics: [expect.objectContaining({ title: 'BFS' })] })]);

        const patched = await api(user).patch(`/api/subjects/${id}`, { color: '#ff0000', icon: 'graph' });
        expect(patched.body.data).toMatchObject({ name: 'Graphs', color: '#ff0000', icon: 'graph' });

        expect((await api(user).post('/api/subjects', { name: '   ' })).status).toBe(400);
        expect((await api(user).post('/api/subjects', {})).status).toBe(400);
    });

    it("404 for another user's subject; list is scoped", async () => {
        const owner = await createLearner();
        const stranger = await createLearner();
        const s = await createSubjectRow(owner.id);
        expect((await api(stranger).patch(`/api/subjects/${s.id}`, { name: 'x' })).status).toBe(404);
        expect((await api(stranger).delete(`/api/subjects/${s.id}`)).status).toBe(404);
        expect((await api(stranger).get('/api/subjects')).body.data).toEqual([]);
    });

    it('delete: everything in the subject goes (docs to the trash, tasks on them, notes); sessions only lose the link; undo brings it all back', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id);
        const { topic, doc } = await createTopicRow(user.id, s.id);
        await createChainRows(user.id, { topicId: topic.id }, todayIn(IST));
        const note = await prisma.capture.create({ data: { userId: user.id, content: 'filed', subjectId: s.id } });
        const tag = await prisma.tag.create({ data: { name: `t-${user.id.slice(-6)}` } });
        const task = await prisma.todo.create({ data: { userId: user.id, title: 'Revise it', references: [{ type: 'doc', refId: doc.id, title: 'Doc' }], reminderDate: new Date('2030-01-01T09:00:00Z') } });
        await prisma.todoTag.create({ data: { todoId: task.id, tagId: tag.id } });
        await prisma.reminder.create({ data: { userId: user.id, todoId: task.id, reminderDate: new Date('2030-01-01T09:00:00Z') } });
        const other = await prisma.todo.create({ data: { userId: user.id, title: 'Unrelated' } });
        const session = await prisma.workSession.create({ data: { userId: user.id, kind: 'study', day: new Date('2026-11-20'), startedAt: new Date('2026-11-20T10:00:00Z'), minutes: 30, subjectId: s.id, topicId: topic.id, title: 'Studied' } });
        const revisions = await prisma.revision.count({ where: { topicId: topic.id } });

        const preview = await api(user).get(`/api/subjects/${s.id}/deletion`);
        expect(preview.body.data).toMatchObject({ undoDays: 7, counts: { docs: 1, topics: 1, notes: 1, revisions, tasks: 1, sessions: 1 } });

        const del = await api(user).delete(`/api/subjects/${s.id}`);
        expect(del.status).toBe(200);
        const deletionId = del.body.data._id;
        expect(await prisma.subject.count({ where: { id: s.id } })).toBe(0);
        expect(await prisma.topic.count({ where: { id: topic.id } })).toBe(0);
        expect(await prisma.revision.count({ where: { topicId: topic.id } })).toBe(0);
        expect(await prisma.capture.count({ where: { id: note.id } })).toBe(0);
        expect(await prisma.todo.count({ where: { id: task.id } })).toBe(0);
        expect(await prisma.todo.count({ where: { id: other.id } })).toBe(1);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).trashedAt).not.toBeNull();
        expect(await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ subjectId: null, topicId: null, minutes: 30 });
        expect((await api(user).get('/api/subject-deletions')).body.data).toEqual([expect.objectContaining({ _id: deletionId, subjectId: s.id })]);

        // Emptying the trash leaves a deleted subject's docs for its week (they come back with it).
        await api(user).post('/api/docs/trash/empty', {});
        expect(await prisma.doc.count({ where: { id: doc.id } })).toBe(1);

        const undo = await api(user).post(`/api/subject-deletions/${deletionId}/undo`, {});
        expect(undo.status).toBe(200);
        expect(await prisma.subject.count({ where: { id: s.id } })).toBe(1);
        expect(await prisma.topic.findUniqueOrThrow({ where: { id: topic.id } })).toMatchObject({ subjectId: s.id, docId: doc.id });
        expect(await prisma.revision.count({ where: { topicId: topic.id } })).toBe(revisions);
        expect(await prisma.capture.findUniqueOrThrow({ where: { id: note.id } })).toMatchObject({ subjectId: s.id });
        expect(await prisma.todoTag.count({ where: { todoId: task.id, tagId: tag.id } })).toBe(1);
        expect(await prisma.reminder.count({ where: { todoId: task.id } })).toBe(1);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).trashedAt).toBeNull();
        expect(await prisma.workSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ subjectId: s.id, topicId: topic.id });
        expect((await api(user).get('/api/subject-deletions')).body.data).toEqual([]);
    });

    it('a deleted subject is final after its week: its docs are deleted for good', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id);
        const { doc } = await createTopicRow(user.id, s.id);
        const del = await api(user).delete(`/api/subjects/${s.id}`);
        expect((await api(user).post(`/api/subject-deletions/nope/undo`, {})).status).toBe(404);
        const { purgeSubjectDeletions } = await import('../../src/services/learningDb/subjectDeletion.service');
        expect(await purgeSubjectDeletions(new Date(Date.now() + 6 * 86_400_000))).toBe(0);
        expect(await purgeSubjectDeletions(new Date(Date.now() + 8 * 86_400_000))).toBe(1);
        expect(await prisma.doc.count({ where: { id: doc.id } })).toBe(0);
        expect((await api(user).post(`/api/subject-deletions/${del.body.data._id}/undo`, {})).status).toBe(404);
    });
});

describe('topics', () => {
    it('by-doc: start state, create (201 + chain), 409 when it exists, then the next action', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id);
        const doc = await prisma.doc.create({ data: { userId: user.id, title: 'Heaps' } });

        const before = await api(user).get(`/api/topics/by-doc/${doc.id}`);
        expect(before.body.data).toEqual({ topic: null, chain: [], nextAction: { kind: 'start' }, hasCard: false, lesson: null });

        const created = await api(user).post('/api/topics', { docId: doc.id, subjectId: s.id, tags: ['heap', ' heap ', 'pq'] });
        expect(created.status).toBe(201);
        expect(created.body.data.topic).toMatchObject({ subjectId: s.id, docId: doc.id, title: 'Heaps', tags: ['heap', 'pq'], isArchived: false });
        expect(created.body.data.chain).toHaveLength(4);

        const dup = await api(user).post('/api/topics', { docId: doc.id, subjectId: s.id });
        expect([dup.status, dup.body.code]).toEqual([409, 'TOPIC_EXISTS']);

        const after = await api(user).get(`/api/topics/by-doc/${doc.id}`);
        expect(after.body.data.nextAction).toMatchObject({ kind: 'early', next: { cycleNumber: 1, scheduledFor: addDays(todayIn(IST), 1) } });
        expect(Object.keys(after.body.data.nextAction.next).sort()).toEqual(['_id', 'completedAt', 'cycleNumber', 'intervalDays', 'scheduledFor', 'status']);

        // The doc title wins over the stored title.
        await prisma.doc.update({ where: { id: doc.id }, data: { title: 'Heaps & PQs' } });
        expect((await api(user).get(`/api/topics/by-doc/${doc.id}`)).body.data.topic.title).toBe('Heaps & PQs');
    });

    it('startRevisions:false creates no chain; a collaborator can make their own topic on a shared doc', async () => {
        const owner = await createLearner();
        const collab = await createLearner();
        const doc = await prisma.doc.create({ data: { userId: owner.id, title: 'Shared' } });
        await prisma.docCollaborator.create({ data: { docId: doc.id, userId: collab.id, role: 'viewer' } });
        const s1 = await createSubjectRow(owner.id);
        const s2 = await createSubjectRow(collab.id);
        const a = await api(owner).post('/api/topics', { docId: doc.id, subjectId: s1.id, startRevisions: false });
        expect(a.body.data.chain).toEqual([]);
        const b = await api(collab).post('/api/topics', { docId: doc.id, subjectId: s2.id });
        expect(b.status).toBe(201);
    });

    it("404: a doc you can't view, a subject you don't own, another user's topic; 400 bad body", async () => {
        const owner = await createLearner();
        const stranger = await createLearner();
        const s = await createSubjectRow(owner.id);
        const mine = await createSubjectRow(stranger.id);
        const { topic, doc } = await createTopicRow(owner.id, s.id);
        expect((await api(stranger).get(`/api/topics/by-doc/${doc.id}`)).status).toBe(404);
        expect((await api(stranger).post('/api/topics', { docId: doc.id, subjectId: mine.id })).status).toBe(404);
        const otherDoc = await prisma.doc.create({ data: { userId: owner.id, title: 'x' } });
        expect((await api(owner).post('/api/topics', { docId: otherDoc.id, subjectId: mine.id })).status).toBe(404);
        expect((await api(stranger).patch(`/api/topics/${topic.id}`, { isArchived: true })).status).toBe(404);
        expect((await api(stranger).delete(`/api/topics/${topic.id}`)).status).toBe(404);
        expect((await api(stranger).post(`/api/topics/${topic.id}/doc`)).status).toBe(404);
        expect((await api(owner).post('/api/topics', { docId: doc.id })).status).toBe(400);
        expect((await api(owner).patch(`/api/topics/${topic.id}`, { tags: 'nope' })).status).toBe(400);
    });

    it('patch moves subject / tags / archive; delete keeps the doc; POST :id/doc recreates a deleted doc', async () => {
        const user = await createLearner();
        const s1 = await createSubjectRow(user.id, 'A');
        const s2 = await createSubjectRow(user.id, 'B');
        const { topic, doc } = await createTopicRow(user.id, s1.id, 'Tries');
        const patched = await api(user).patch(`/api/topics/${topic.id}`, { subjectId: s2.id, tags: ['strings'], isArchived: true });
        expect(patched.body.data).toMatchObject({ subjectId: s2.id, tags: ['strings'], isArchived: true, title: 'Tries' });

        expect((await api(user).post(`/api/topics/${topic.id}/doc`)).body.data).toEqual({ docId: doc.id });
        await prisma.doc.delete({ where: { id: doc.id } }); // SET NULL: the topic survives
        const fresh = await api(user).post(`/api/topics/${topic.id}/doc`);
        expect(fresh.body.data.docId).not.toBe(doc.id);
        expect(await prisma.doc.findUniqueOrThrow({ where: { id: fresh.body.data.docId } })).toMatchObject({ userId: user.id, title: 'Tries' });

        expect((await api(user).delete(`/api/topics/${topic.id}`)).body.data).toEqual({ deleted: true });
        expect(await prisma.doc.count({ where: { id: fresh.body.data.docId } })).toBe(1);
    });
});

describe('captures', () => {
    it('create a note (201), with revise:true the chain starts in the same transaction', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id);
        const plain = await api(user).post('/api/captures', { title: 'Idea', content: 'Use a monotonic stack', category: '#stack', subjectId: s.id });
        expect(plain.status).toBe(201);
        expect(plain.body.data.capture).toMatchObject({ type: 'NOTE', title: 'Idea', category: 'stack', subject: { _id: s.id, name: 'DSA' }, topicId: null, isPinned: false });
        expect(plain.body.data.chain).toBeUndefined();

        const revised = await api(user).post('/api/captures', { content: 'Kadane', revise: true });
        expect(revised.body.data.chain.map((r: any) => r.cycleNumber)).toEqual([1, 2, 3, 4]);

        const link = await api(user).post('/api/captures', { url: 'https://example.test/article' });
        expect(link.body.data.capture.type).toBe('LINK');

        expect((await api(user).get('/api/captures/categories')).body.data).toEqual(['stack']);
    });

    it('400 for an empty capture or bad fields; 404 for a foreign subject/topic', async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        const s = await createSubjectRow(stranger.id);
        const { topic } = await createTopicRow(stranger.id, s.id);
        expect((await api(user).post('/api/captures', { title: '  ', content: '' })).status).toBe(400);
        expect((await api(user).post('/api/captures', { content: 'x', type: 'TASK' })).status).toBe(400);
        expect((await api(user).post('/api/captures', { content: 'x', subjectId: s.id })).status).toBe(404);
        expect((await api(user).post('/api/captures', { content: 'x', topicId: topic.id })).status).toBe(404);
    });

    it('a topic resource inherits the topic subject; patch; move to Inbox with subjectId null', async () => {
        const user = await createLearner();
        const s = await createSubjectRow(user.id);
        const { topic } = await createTopicRow(user.id, s.id);
        const res = await api(user).post('/api/captures', { url: 'https://docs.test', topicId: topic.id });
        expect(res.body.data.capture).toMatchObject({ topicId: topic.id, subject: { _id: s.id } });
        const id = res.body.data.capture._id;
        const patched = await api(user).patch(`/api/captures/${id}`, { title: 'Docs', isPinned: true, subjectId: null });
        expect(patched.body.data).toMatchObject({ title: 'Docs', isPinned: true, subject: null });
    });

    it('delete removes it and its revisions, then cleans up Cloudinary; 404 foreign', async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        const c = await prisma.capture.create({
            data: { userId: user.id, content: 'with file', cloudPublicId: 'legacy/one', attachments: [{ url: 'u', publicId: 'recollect-learning/a', fileName: 'a', fileType: 'image/png' }] },
        });
        await createChainRows(user.id, { captureId: c.id }, todayIn(IST));
        expect((await api(stranger).delete(`/api/captures/${c.id}`)).status).toBe(404);
        expect((await api(stranger).patch(`/api/captures/${c.id}`, { title: 'x' })).status).toBe(404);
        expect((await api(user).delete(`/api/captures/${c.id}`)).body.data).toEqual({ deleted: true });
        expect(await prisma.revision.count({ where: { captureId: c.id } })).toBe(0);
        // Each file is deleted as its own storage type (TOOL_ACCESS_PLAN §11.2); the old single file on its own.
        expect(vi.mocked(batchDeleteFromCloud)).toHaveBeenCalledWith(['recollect-learning/a']);
        expect(vi.mocked(batchDeleteFromCloud)).toHaveBeenCalledWith(['legacy/one']);
    });

    it('GET /api/captures: Find searches every capture by each word (title, text, link); ?inbox=1 lists the inbox; owner only', async () => {
        const user = await createLearner();
        const stranger = await createLearner();
        const ago = (s: number) => new Date(Date.now() - s * 1000);
        const link = await prisma.capture.create({ data: { userId: user.id, type: 'LINK', title: 'Kafka partitions', url: 'https://kafka.test/Rebalance', createdAt: ago(40) } });
        const note = await prisma.capture.create({ data: { userId: user.id, content: 'Consumer groups rebalance when a member leaves', createdAt: ago(30) } });
        const revised = await prisma.capture.create({ data: { userId: user.id, title: 'Rebalance storms', createdAt: ago(20) } });
        await createChainRows(user.id, { captureId: revised.id }, todayIn(IST));
        const pinned = await prisma.capture.create({ data: { userId: user.id, title: 'Pinned one', isPinned: true, createdAt: ago(50) } });
        await prisma.capture.create({ data: { userId: stranger.id, title: 'Rebalance (not yours)' } });

        const ids = (res: { body: { data: Array<{ _id: string }> } }) => res.body.data.map((c) => c._id);
        // Every word, any field, any case; the one being revised is found too; pinned first, then newest.
        expect(ids(await api(user).get('/api/captures?q=REBALANCE'))).toEqual([revised.id, note.id, link.id]);
        expect(ids(await api(user).get('/api/captures?q=kafka%20rebalance'))).toEqual([link.id]);
        expect(ids(await api(user).get('/api/captures?q=consumer%20kafka'))).toEqual([]);
        // The inbox: not on a revision schedule; pinned first.
        expect(ids(await api(user).get('/api/captures?inbox=1'))).toEqual([pinned.id, note.id, link.id]);
        expect(ids(await api(user).get('/api/captures?limit=2'))).toEqual([pinned.id, revised.id]);
        const one = (await api(user).get(`/api/captures?q=partitions`)).body.data[0];
        expect(one).toMatchObject({ _id: link.id, type: 'LINK', title: 'Kafka partitions', url: 'https://kafka.test/Rebalance', subject: null });
        expect((await api(user).get('/api/captures?limit=0')).status).toBe(400);
        expect((await api(user).get('/api/captures?limit=500')).status).toBe(400);
        expect((await api(user).get(`/api/captures?q=${'x'.repeat(201)}`)).status).toBe(400);
    });
});

describe('POST /api/learning/uploads', () => {
    it('uploads one file and returns the attachment shape', async () => {
        const user = await createLearner();
        const res = await request(app)
            .post('/api/learning/uploads')
            .set('Cookie', authCookie(user))
            .attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'notes.pdf', contentType: 'application/pdf' });
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            url: 'https://cdn.test/notes.pdf',
            publicId: 'recollect-learning/notes.pdf',
            fileName: 'notes.pdf',
            fileType: 'application/pdf',
        });
    });

    it('400 without a file, 413 over 10 MB (TOOL_ACCESS_PLAN §11.2), 400 for a video, 401 without a cookie', async () => {
        const user = await createLearner();
        const none = await request(app).post('/api/learning/uploads').set('Cookie', authCookie(user)).field('x', '1');
        expect([none.status, none.body.code]).toEqual([400, 'NO_FILE']);
        const big = await request(app)
            .post('/api/learning/uploads')
            .set('Cookie', authCookie(user))
            .attach('file', Buffer.alloc(10 * 1024 * 1024 + 1), { filename: 'big.bin', contentType: 'application/octet-stream' });
        expect([big.status, big.body.code, big.body.message]).toEqual([413, 'FILE_TOO_LARGE', 'Files can be at most 10 MB']);
        const video = await request(app).post('/api/learning/uploads').set('Cookie', authCookie(user)).attach('file', Buffer.from('x'), { filename: 'clip.mov', contentType: 'text/plain' });
        expect([video.status, video.body.code, video.body.message]).toEqual([400, 'VIDEO_NOT_ALLOWED', "Videos can't be attached. Save the link instead."]);
        expect((await request(app).post('/api/learning/uploads')).status).toBe(401);
    });
});

describe('quick notes', () => {
    const ID = '0b6f3a52-5d1e-4c8a-9f3e-7a1b2c3d4e5f';

    it('PUT creates (201) then updates (200) by client UUID; PATCH pins; DELETE removes', async () => {
        const user = await createLearner();
        const created = await api(user).put(`/api/quick-notes/${ID}`, { content: 'first', category: 'TEMPORARY' });
        expect(created.status).toBe(201);
        expect(created.body.data).toMatchObject({ _id: ID, content: 'first', category: 'TEMPORARY', isPinned: false, attachments: [] });

        const updated = await api(user).put(`/api/quick-notes/${ID}`, { content: 'second', category: 'PRIMARY', attachments: [{ url: 'u', publicId: 'p', fileName: 'f', fileType: 't' }] });
        expect(updated.status).toBe(200);
        expect(updated.body.data).toMatchObject({ content: 'second', category: 'PRIMARY', attachments: [{ publicId: 'p' }] });

        expect((await api(user).patch(`/api/quick-notes/${ID}`, { isPinned: true })).body.data.isPinned).toBe(true);
        expect((await api(user).delete(`/api/quick-notes/${ID}`)).body.data).toEqual({ deleted: true });
        expect(vi.mocked(batchDeleteFromCloud)).toHaveBeenCalledWith(['p']);
        expect((await api(user).delete(`/api/quick-notes/${ID}`)).status).toBe(404);
    });

    it("400 for a bad id or empty note; 404 for another user's id", async () => {
        const owner = await createLearner();
        const stranger = await createLearner();
        const id = 'c3d4e5f6-0000-4000-8000-000000000001';
        await api(owner).put(`/api/quick-notes/${id}`, { content: 'mine', category: 'PRIMARY' });
        expect((await api(stranger).put(`/api/quick-notes/${id}`, { content: 'steal', category: 'PRIMARY' })).status).toBe(404);
        expect((await api(stranger).patch(`/api/quick-notes/${id}`, { isPinned: true })).status).toBe(404);
        expect((await api(stranger).delete(`/api/quick-notes/${id}`)).status).toBe(404);
        expect((await prisma.quickNote.findUniqueOrThrow({ where: { id } })).content).toBe('mine');
        const badId = await api(owner).put('/api/quick-notes/not-a-uuid', { content: 'x', category: 'PRIMARY' });
        expect([badId.status, badId.body.code]).toEqual([400, 'INVALID_ID']);
        expect((await api(owner).put(`/api/quick-notes/${id}`, { content: '   ', category: 'PRIMARY' })).status).toBe(400);
        expect((await api(owner).put(`/api/quick-notes/${id}`, { content: 'x', category: 'VAULT' })).status).toBe(400);
    });
});
