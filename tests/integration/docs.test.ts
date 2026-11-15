// /api/docs endpoints (docs, saves) on Postgres. Sharing (publish, people, requests): doc-sharing.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('upfly', async () => (await import('../helpers/uploads')).createUpflyMock());
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));
vi.mock('../../src/collaboration/hocuspocus', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/collaboration/hocuspocus')>()),
    disconnectUser: vi.fn(() => true),
}));

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { batchDeleteFromCloud } from '../../src/utils/cloudinary';
import { disconnectUser } from '../../src/collaboration/hocuspocus';
import { authCookie, createTestUser } from '../helpers/auth';
import { clearUploadedFiles, fakeCloudFile, setUploadedFiles } from '../helpers/uploads';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

async function makeDoc(owner: TestUser, data: { title?: string; cloudImages?: unknown[]; yjsState?: Uint8Array<ArrayBuffer> } = {}) {
    return prisma.doc.create({
        data: { userId: owner.id, title: data.title ?? 'A doc', cloudImages: (data.cloudImages ?? []) as any, yjsState: data.yjsState ?? null },
    });
}

/** A doc owned by `owner` with an editor and a viewer; plus someone removed from it and a stranger. */
async function sharedDocFixture(title = 'Shared doc') {
    const [owner, editor, viewer, removed, stranger] = await Promise.all([
        createTestUser({ name: 'Owner' }),
        createTestUser({ name: 'Editor' }),
        createTestUser({ name: 'Viewer' }),
        createTestUser({ name: 'Removed' }),
        createTestUser({ name: 'Stranger' }),
    ]);
    const doc = await makeDoc(owner, { title });
    await prisma.docCollaborator.create({ data: { docId: doc.id, userId: editor.id, role: 'editor' } });
    await prisma.docCollaborator.create({ data: { docId: doc.id, userId: viewer.id, role: 'viewer' } });
    return { owner, editor, viewer, removed, stranger, doc };
}

const styledContent = {
    type: 'doc',
    content: [
        {
            type: 'paragraph',
            content: [
                { type: 'text', text: 'red', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] },
                { type: 'text', text: ' and marked', marks: [{ type: 'highlight', attrs: { color: '#fef08a' } }] },
            ],
        },
        {
            type: 'taskList',
            content: [
                { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ship it' }] }] },
                { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'test it' }] }] },
            ],
        },
    ],
};

beforeEach(() => {
    vi.mocked(batchDeleteFromCloud).mockClear();
    vi.mocked(disconnectUser).mockClear();
});
afterEach(() => clearUploadedFiles());

describe('auth', () => {
    it('401 without a cookie on every doc route', async () => {
        const id = 'cnonexistent0000000000000';
        const calls = [
            request(app).get('/api/docs'),
            request(app).post('/api/docs'),
            request(app).get(`/api/docs/${id}`),
            request(app).patch(`/api/docs/${id}`),
            request(app).delete(`/api/docs/${id}`),
            request(app).put(`/api/docs/${id}/publish`),
            request(app).get(`/api/docs/${id}/people`),
            request(app).post(`/api/docs/${id}/people`),
            request(app).patch(`/api/docs/${id}/people/x`),
            request(app).delete(`/api/docs/${id}/people/x`),
            request(app).post(`/api/docs/${id}/requests/x/approve`),
            request(app).post(`/api/docs/${id}/requests/x/decline`),
        ];
        for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
    });
});

describe('POST /api/docs', () => {
    it('creates an Untitled notes doc in the old shape', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/docs').set('Cookie', authCookie(user)).send({ title: '' });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ success: true, message: 'Doc created successfully' });
        expect(res.body.data).toMatchObject({
            user: user.id,
            title: 'Untitled',
            previewState: null,
            coverImage: null,
            isPinned: false,
            isArchived: false,
            cloudImages: [],
            collaborators: [],
        });
        expect(typeof res.body.data._id).toBe('string');
        expect(res.body.data).not.toHaveProperty('id');
        // The Yjs state is never sent (D3: bytes, read through the live server).
        expect(res.body.data).not.toHaveProperty('yjsState');
        expect(res.body.data).not.toHaveProperty('userId');
    });

    it('takes a trimmed title; a docType (dropped with D8) is ignored and never sent back', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/docs').set('Cookie', authCookie(user)).send({ title: '  Plan  ', docType: 'project' });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ title: 'Plan' });
        expect(res.body.data).not.toHaveProperty('docType');
    });
});

describe('GET /api/docs', () => {
    it('lists own and shared docs with the role, newest first, without yjsState', async () => {
        const { owner, editor, viewer, removed, stranger, doc } = await sharedDocFixture('Team notes');
        const own = await makeDoc(editor, { title: 'Editor private' });
        await makeDoc(stranger, { title: 'Stranger private' });
        await prisma.doc.update({ where: { id: own.id }, data: { updatedAt: new Date(Date.now() + 60_000) } });

        const forEditor = await request(app).get('/api/docs').set('Cookie', authCookie(editor));
        expect(forEditor.status).toBe(200);
        expect(forEditor.body.success).toBe(true);
        expect(forEditor.body.data.map((d: any) => [d.title, d.role])).toEqual([
            ['Editor private', 'owner'],
            ['Team notes', 'editor'],
        ]);
        const team = forEditor.body.data[1];
        expect(team).toMatchObject({ _id: doc.id, user: owner.id, owner: { _id: owner.id, name: 'Owner' }, publishedAt: null, isPinned: false, isArchived: false });
        expect(team).not.toHaveProperty('yjsState');
        expect(team).not.toHaveProperty('cloudImages');
        expect(team.collaborators).toEqual([
            { role: 'editor', addedAt: expect.any(String), user: { _id: editor.id, name: 'Editor', email: editor.email, avatar: '' } },
            { role: 'viewer', addedAt: expect.any(String), user: { _id: viewer.id, name: 'Viewer', email: viewer.email, avatar: '' } },
        ]);

        const forViewer = await request(app).get('/api/docs').set('Cookie', authCookie(viewer));
        expect(forViewer.body.data.map((d: any) => d.role)).toEqual(['viewer']);

        const forRemoved = await request(app).get('/api/docs').set('Cookie', authCookie(removed));
        expect(forRemoved.body.data).toEqual([]);
        const forOwner = await request(app).get('/api/docs').set('Cookie', authCookie(owner));
        expect(forOwner.body.data.map((d: any) => [d.title, d.role])).toEqual([['Team notes', 'owner']]);
    });
});

describe('GET /api/docs/:id', () => {
    it('returns the populated doc and the real role', async () => {
        const { owner, editor, viewer, doc } = await sharedDocFixture();

        const asOwner = await request(app).get(`/api/docs/${doc.id}`).set('Cookie', authCookie(owner));
        expect(asOwner.status).toBe(200);
        expect(asOwner.body.role).toBe('owner');
        expect(asOwner.body.data).toMatchObject({
            _id: doc.id,
            title: 'Shared doc',
            user: { _id: owner.id, name: 'Owner', email: owner.email },
        });
        expect(asOwner.body.data.collaborators[0]).toMatchObject({ _id: expect.any(String), role: 'editor', user: { _id: editor.id, name: 'Editor' } });
        expect(asOwner.body.data).not.toHaveProperty('bannedUsers');

        expect((await request(app).get(`/api/docs/${doc.id}`).set('Cookie', authCookie(editor))).body.role).toBe('editor');
        expect((await request(app).get(`/api/docs/${doc.id}`).set('Cookie', authCookie(viewer))).body.role).toBe('viewer');
    });

    it('404 "Doc not found" for strangers, removed people and unknown ids', async () => {
        const { removed, stranger, doc } = await sharedDocFixture();
        for (const user of [removed, stranger]) {
            const res = await request(app).get(`/api/docs/${doc.id}`).set('Cookie', authCookie(user));
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ message: 'Doc not found' });
        }
        const unknown = await request(app).get('/api/docs/not-a-real-id').set('Cookie', authCookie(stranger));
        expect(unknown.status).toBe(404);
        expect(unknown.body).toEqual({ message: 'Doc not found' });
    });
});

describe('PATCH /api/docs/:id', () => {
    it('the owner can rename, pin and archive', async () => {
        const { owner, doc } = await sharedDocFixture();
        const res = await request(app)
            .patch(`/api/docs/${doc.id}`)
            .set('Cookie', authCookie(owner))
            .send({ title: '  Renamed ', isPinned: true, isArchived: true, coverImage: 'https://img/c.png' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, message: 'Doc updated successfully' });
        expect(res.body.data).toMatchObject({
            _id: doc.id,
            user: owner.id,
            title: 'Renamed',
            isPinned: true,
            isArchived: true,
            coverImage: 'https://img/c.png',
        });
        expect(res.body.data.collaborators[0]).toMatchObject({ user: expect.any(String), role: 'editor' });
    });

    it('collaborators may not rename or pin (403); editors may change the cover, viewers may not', async () => {
        const { editor, viewer, doc } = await sharedDocFixture();
        for (const body of [{ title: 'x' }, { isPinned: true }, { isArchived: false }]) {
            const res = await request(app).patch(`/api/docs/${doc.id}`).set('Cookie', authCookie(editor)).send(body);
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ message: 'Only the owner can rename or pin this document' });
        }
        const cover = await request(app).patch(`/api/docs/${doc.id}`).set('Cookie', authCookie(editor)).send({ coverImage: 'https://img/e.png' });
        expect(cover.status).toBe(200);
        expect(cover.body.data.coverImage).toBe('https://img/e.png');

        const viewerCover = await request(app).patch(`/api/docs/${doc.id}`).set('Cookie', authCookie(viewer)).send({ coverImage: null });
        expect(viewerCover.status).toBe(403);
        expect(viewerCover.body).toEqual({ message: 'Viewers cannot edit this document' });
    });

    it('validation and not-found errors', async () => {
        const { owner, stranger, doc } = await sharedDocFixture();
        const empty = await request(app).patch(`/api/docs/${doc.id}`).set('Cookie', authCookie(owner)).send({ title: '   ' });
        expect(empty.status).toBe(400);
        expect(empty.body).toEqual({ message: 'Path `title` is required.' });

        const notMine = await request(app).patch(`/api/docs/${doc.id}`).set('Cookie', authCookie(stranger)).send({ coverImage: 'x' });
        expect(notMine.status).toBe(404);
        expect(notMine.body).toEqual({ message: 'Doc not found' });
    });
});

describe('POST /api/docs/:id (the retired solo editor\'s save)', () => {
    it('is gone (D1): a live doc can only change through the live editor or the agent API', async () => {
        const owner = await createTestUser();
        const doc = await makeDoc(owner, { title: 'Live only' });
        const res = await request(app)
            .post(`/api/docs/${doc.id}`)
            .set('Cookie', authCookie(owner))
            .send({ content: styledContent, title: 'Overwritten', coverImage: null, allImageIds: [] });
        expect(res.status).toBe(404);
        const after = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        expect(after.title).toBe('Live only');
        expect(after.yjsState).toEqual(doc.yjsState);
    });
});

describe('DELETE /api/docs/:id', () => {
    it('the owner deletes the doc, its Cloudinary images and its collaborator rows', async () => {
        const { owner, editor } = await sharedDocFixture();
        const doc = await makeDoc(owner, { cloudImages: [{ imageId: 'a', cloudUrl: 'u', cloudPublicId: 'recollect-docs/a' }] });
        await prisma.docCollaborator.create({ data: { docId: doc.id, userId: editor.id } });

        const res = await request(app).delete(`/api/docs/${doc.id}`).set('Cookie', authCookie(owner));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Doc deleted successfully' });
        expect(vi.mocked(batchDeleteFromCloud)).toHaveBeenCalledWith(['recollect-docs/a']);
        expect(await prisma.doc.findUnique({ where: { id: doc.id } })).toBeNull();
        expect(await prisma.docCollaborator.count({ where: { docId: doc.id } })).toBe(0);
    });

    it('a collaborator only leaves the doc', async () => {
        const { viewer, doc } = await sharedDocFixture();
        const res = await request(app).delete(`/api/docs/${doc.id}`).set('Cookie', authCookie(viewer));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Removed from your library' });
        expect(await prisma.doc.findUnique({ where: { id: doc.id } })).not.toBeNull();
        expect(await prisma.docCollaborator.count({ where: { docId: doc.id, userId: viewer.id } })).toBe(0);
    });

    it('404 for strangers', async () => {
        const { stranger, doc } = await sharedDocFixture();
        const res = await request(app).delete(`/api/docs/${doc.id}`).set('Cookie', authCookie(stranger));
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ message: 'Doc not found' });
    });
});
