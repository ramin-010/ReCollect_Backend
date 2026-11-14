// /api/docs endpoints (docs, saves, collaborators) on Postgres.
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
import { docJsonToYjsState, yjsStateToDocJson } from '../../src/services/docs/docContent';
import { authCookie, createTestUser } from '../helpers/auth';
import { clearUploadedFiles, fakeCloudFile, setUploadedFiles } from '../helpers/uploads';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

async function makeDoc(owner: TestUser, data: { title?: string; cloudImages?: unknown[]; yjsState?: string } = {}) {
    return prisma.doc.create({
        data: { userId: owner.id, title: data.title ?? 'A doc', cloudImages: (data.cloudImages ?? []) as any, yjsState: data.yjsState ?? null },
    });
}

/** A doc owned by `owner` with an editor, a viewer and a banned user; plus a stranger. */
async function sharedDocFixture(title = 'Shared doc') {
    const [owner, editor, viewer, banned, stranger] = await Promise.all([
        createTestUser({ name: 'Owner' }),
        createTestUser({ name: 'Editor' }),
        createTestUser({ name: 'Viewer' }),
        createTestUser({ name: 'Banned' }),
        createTestUser({ name: 'Stranger' }),
    ]);
    const doc = await makeDoc(owner, { title });
    await prisma.docCollaborator.create({ data: { docId: doc.id, userId: editor.id, role: 'editor' } });
    await prisma.docCollaborator.create({ data: { docId: doc.id, userId: viewer.id, role: 'viewer' } });
    await prisma.docBannedUser.create({ data: { docId: doc.id, userId: banned.id } });
    return { owner, editor, viewer, banned, stranger, doc };
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
            request(app).get('/api/docs/shared-by-me'),
            request(app).get('/api/docs/pending-requests'),
            request(app).get(`/api/docs/${id}`),
            request(app).patch(`/api/docs/${id}`),
            request(app).post(`/api/docs/${id}`),
            request(app).delete(`/api/docs/${id}`),
            request(app).patch(`/api/docs/${id}/collaborators/x`),
            request(app).delete(`/api/docs/${id}/collaborators/x`),
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
            docType: 'notes',
            yjsState: null,
            previewState: null,
            coverImage: null,
            isPinned: false,
            isArchived: false,
            cloudImages: [],
            collaborators: [],
            bannedUsers: [],
        });
        expect(typeof res.body.data._id).toBe('string');
        expect(res.body.data).not.toHaveProperty('id');
        expect(res.body.data).not.toHaveProperty('userId');
    });

    it('takes a trimmed title and a docType', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/docs').set('Cookie', authCookie(user)).send({ title: '  Plan  ', docType: 'project' });
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ title: 'Plan', docType: 'project' });
    });

    it('400 for an unknown docType (Mongoose enum message)', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/docs').set('Cookie', authCookie(user)).send({ docType: 'diary' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: '`diary` is not a valid enum value for path `docType`.' });
    });
});

describe('GET /api/docs', () => {
    it('lists own and shared docs with the role, newest first, without yjsState', async () => {
        const { owner, editor, viewer, banned, stranger, doc } = await sharedDocFixture('Team notes');
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
        expect(team).toMatchObject({ _id: doc.id, user: owner.id, docType: 'notes', isPinned: false, isArchived: false });
        expect(team).not.toHaveProperty('yjsState');
        expect(team).not.toHaveProperty('cloudImages');
        expect(team.collaborators).toEqual([
            { role: 'editor', addedAt: expect.any(String), user: { _id: editor.id, name: 'Editor', email: editor.email, avatar: '' } },
            { role: 'viewer', addedAt: expect.any(String), user: { _id: viewer.id, name: 'Viewer', email: viewer.email, avatar: '' } },
        ]);

        const forViewer = await request(app).get('/api/docs').set('Cookie', authCookie(viewer));
        expect(forViewer.body.data.map((d: any) => d.role)).toEqual(['viewer']);

        const forBanned = await request(app).get('/api/docs').set('Cookie', authCookie(banned));
        expect(forBanned.body.data).toEqual([]);
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
        expect(asOwner.body.data.bannedUsers).toEqual([{ _id: expect.any(String), user: expect.any(String), bannedAt: expect.any(String) }]);

        expect((await request(app).get(`/api/docs/${doc.id}`).set('Cookie', authCookie(editor))).body.role).toBe('editor');
        expect((await request(app).get(`/api/docs/${doc.id}`).set('Cookie', authCookie(viewer))).body.role).toBe('viewer');
    });

    it('404 "Doc not found" for strangers, banned users and unknown ids', async () => {
        const { banned, stranger, doc } = await sharedDocFixture();
        for (const user of [banned, stranger]) {
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
    it('the owner can rename, retype, pin and archive', async () => {
        const { owner, doc } = await sharedDocFixture();
        const res = await request(app)
            .patch(`/api/docs/${doc.id}`)
            .set('Cookie', authCookie(owner))
            .send({ title: '  Renamed ', docType: 'meeting', isPinned: true, isArchived: true, coverImage: 'https://img/c.png' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, message: 'Doc updated successfully' });
        expect(res.body.data).toMatchObject({
            _id: doc.id,
            user: owner.id,
            title: 'Renamed',
            docType: 'meeting',
            isPinned: true,
            isArchived: true,
            coverImage: 'https://img/c.png',
        });
        expect(res.body.data.collaborators[0]).toMatchObject({ user: expect.any(String), role: 'editor' });
    });

    it('collaborators may not rename/retype/pin (403); editors may change the cover, viewers may not', async () => {
        const { editor, viewer, doc } = await sharedDocFixture();
        for (const body of [{ title: 'x' }, { docType: 'project' }, { isPinned: true }, { isArchived: false }]) {
            const res = await request(app).patch(`/api/docs/${doc.id}`).set('Cookie', authCookie(editor)).send(body);
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ message: 'Only the owner can rename, change type, or pin this document' });
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

        const badType = await request(app).patch(`/api/docs/${doc.id}`).set('Cookie', authCookie(owner)).send({ docType: 'x' });
        expect(badType.status).toBe(400);

        const notMine = await request(app).patch(`/api/docs/${doc.id}`).set('Cookie', authCookie(stranger)).send({ coverImage: 'x' });
        expect(notMine.status).toBe(404);
        expect(notMine.body).toEqual({ message: 'Doc not found' });
    });
});

describe('POST /api/docs/:id (cloud save)', () => {
    it('saves a doc with textStyle, highlight and a task list (was 500 "no mark type textStyle")', async () => {
        const owner = await createTestUser();
        const doc = await makeDoc(owner, { title: 'Styled' });

        const res = await request(app)
            .post(`/api/docs/${doc.id}`)
            .set('Cookie', authCookie(owner))
            .send({ content: styledContent, title: 'Styled v2', coverImage: null, allImageIds: [] });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, message: 'Doc updated successfully' });
        expect(res.body.data).toMatchObject({ _id: doc.id, title: 'Styled v2', coverImage: null });
        expect(typeof res.body.data.yjsState).toBe('string');

        // The returned (and stored) Yjs state decodes to the same content the browser sent.
        const back = yjsStateToDocJson(res.body.data.yjsState) as any;
        expect(back.content[0].content[0]).toEqual({ type: 'text', text: 'red', marks: [{ type: 'textStyle', attrs: { color: '#ff0000' } }] });
        expect(back.content[0].content[1].marks).toEqual([{ type: 'highlight', attrs: { color: '#fef08a' } }]);
        expect(back.content[1].type).toBe('taskList');
        expect(back.content[1].content.map((item: any) => item.attrs.checked)).toEqual([true, false]);

        const stored = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        expect(stored.yjsState).toBe(res.body.data.yjsState);
        expect(stored.previewState).toContain('ship it');
    });

    it('multipart-style save: uploaded images get their cloud URL, orphans are deleted from Cloudinary', async () => {
        const owner = await createTestUser();
        const doc = await makeDoc(owner, {
            cloudImages: [
                { imageId: 'keep', cloudUrl: 'https://cdn/keep.webp', cloudPublicId: 'recollect-docs/keep' },
                { imageId: 'gone', cloudUrl: 'https://cdn/gone.webp', cloudPublicId: 'recollect-docs/gone' },
            ],
        });
        setUploadedFiles({ image_new1: [fakeCloudFile('image_new1', 'new1')] });
        const content = {
            type: 'doc',
            content: [
                { type: 'resizableImage', attrs: { src: 'https://cdn/keep.webp', imageId: 'keep' } },
                { type: 'resizableImage', attrs: { src: 'blob:http://localhost/1', imageId: 'new1' } },
            ],
        };

        // FormData fields arrive as strings.
        const res = await request(app)
            .post(`/api/docs/${doc.id}`)
            .set('Cookie', authCookie(owner))
            .send({
                content: JSON.stringify(content),
                title: 'With images',
                coverImage: '',
                imageNodeIds: JSON.stringify(['new1']),
                allImageIds: JSON.stringify(['keep', 'new1']),
            });

        expect(res.status).toBe(200);
        expect(res.body.data.cloudImages).toEqual([
            { imageId: 'keep', cloudUrl: 'https://cdn/keep.webp', cloudPublicId: 'recollect-docs/keep' },
            { imageId: 'new1', cloudUrl: 'https://cdn.example.test/new1.webp', cloudPublicId: 'test/new1' },
        ]);
        expect(vi.mocked(batchDeleteFromCloud)).toHaveBeenCalledWith(['recollect-docs/gone']);
        const back = yjsStateToDocJson(res.body.data.yjsState) as any;
        expect(back.content[1].attrs).toMatchObject({ src: 'https://cdn.example.test/new1.webp', imageId: 'new1' });
        expect(res.body.data.coverImage).toBe('');
    });

    it('an editor saves content but cannot rename; a viewer gets 403', async () => {
        const { editor, viewer, doc } = await sharedDocFixture('Keep my name');
        const asEditor = await request(app)
            .post(`/api/docs/${doc.id}`)
            .set('Cookie', authCookie(editor))
            .send({ content: styledContent, title: 'Hijacked', docType: 'personal' });
        expect(asEditor.status).toBe(200);
        expect(asEditor.body.data).toMatchObject({ title: 'Keep my name', docType: 'notes' });
        expect(asEditor.body.data.yjsState).toBeTruthy();

        const asViewer = await request(app).post(`/api/docs/${doc.id}`).set('Cookie', authCookie(viewer)).send({ content: styledContent });
        expect(asViewer.status).toBe(403);
        expect(asViewer.body).toEqual({ message: 'Viewers cannot edit this document' });
    });

    it('keeps the stored content when no content is sent', async () => {
        const owner = await createTestUser();
        const first = await request(app).post('/api/docs').set('Cookie', authCookie(owner)).send({ title: 'T' });
        const id = first.body.data._id;
        const saved = await request(app).post(`/api/docs/${id}`).set('Cookie', authCookie(owner)).send({ content: styledContent });
        const again = await request(app).post(`/api/docs/${id}`).set('Cookie', authCookie(owner)).send({ title: 'Only the title' });
        expect(again.status).toBe(200);
        expect(again.body.data.yjsState).toBe(saved.body.data.yjsState);
        expect(again.body.data.title).toBe('Only the title');
    });

    it('creates the doc with the client id when it does not exist (201)', async () => {
        const owner = await createTestUser();
        const id = 'cclientid000000000000001';
        const res = await request(app).post(`/api/docs/${id}`).set('Cookie', authCookie(owner)).send({ content: styledContent, title: 'Recreated' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ success: true, message: 'Doc created successfully' });
        expect(res.body.data).toMatchObject({ _id: id, user: owner.id, title: 'Recreated', docType: 'notes' });
        expect(res.body.data.previewState).toContain('red');
    });

    it('a browser-only local_ id is not created (404, as with Mongo CastError)', async () => {
        const owner = await createTestUser();
        const res = await request(app).post('/api/docs/local_1700000000000_abc').set('Cookie', authCookie(owner)).send({ content: styledContent });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ message: 'Resource not found with id of local_1700000000000_abc' });
    });

    it("someone else's doc id: 400 duplicate, like the Mongo duplicate key", async () => {
        const { stranger, banned, doc } = await sharedDocFixture();
        for (const user of [stranger, banned]) {
            const res = await request(app).post(`/api/docs/${doc.id}`).set('Cookie', authCookie(user)).send({ content: styledContent });
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ message: 'Duplicate field value entered: _id' });
        }
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).yjsState).toBeNull();
    });

    it('canvas boards live in the Y.Doc, not the JSON: a save keeps the boards of canvases still in the content', async () => {
        const owner = await createTestUser();
        const kept = 'cv_keepKeepKeep';
        const gone = 'cv_goneGoneGone';
        const board = (text: string) => ({ nodes: [{ id: 'a', shape: 'rect', text, x: 0, y: 0, w: 160, h: 64, color: 'default', z: 0 }], edges: [] });
        const canvas = (canvasId: string, data: unknown = null) => ({ type: 'canvas', attrs: { canvasId, height: 440, data } });
        const doc = await makeDoc(owner, { yjsState: docJsonToYjsState({ type: 'doc', content: [canvas(kept, board('Kept box')), canvas(gone, board('Gone box'))] }) });

        // The editor's JSON has the canvas blocks without their boards (data null); one block was deleted.
        const res = await request(app)
            .post(`/api/docs/${doc.id}`)
            .set('Cookie', authCookie(owner))
            .send({ content: { type: 'doc', content: [canvas(kept), { type: 'paragraph', content: [{ type: 'text', text: 'after' }] }] }, allImageIds: [] });
        expect(res.status).toBe(200);
        const back = yjsStateToDocJson(res.body.data.yjsState) as any;
        expect(back.content[0]).toEqual(canvas(kept, board('Kept box')));
        expect(Buffer.from(res.body.data.yjsState, 'base64').toString('latin1')).not.toContain('Gone box');
    });

    it('400 for malformed content', async () => {
        const owner = await createTestUser();
        const doc = await makeDoc(owner);
        const res = await request(app)
            .post(`/api/docs/${doc.id}`)
            .set('Cookie', authCookie(owner))
            .send({ content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] } });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/^Invalid doc content: /);
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

describe('GET /api/docs/shared-by-me', () => {
    it("lists the user's docs that have collaborators, with populated users", async () => {
        const { owner, editor, doc } = await sharedDocFixture('Shared one');
        await makeDoc(owner, { title: 'Not shared' });

        const res = await request(app).get('/api/docs/shared-by-me').set('Cookie', authCookie(owner));
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0]).toEqual({
            _id: doc.id,
            title: 'Shared one',
            docType: 'notes',
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
            collaborators: [
                { _id: expect.any(String), user: { _id: editor.id, name: 'Editor', email: editor.email, avatar: '' }, role: 'editor', addedAt: expect.any(String) },
                expect.objectContaining({ role: 'viewer' }),
            ],
        });
        expect((await request(app).get('/api/docs/shared-by-me').set('Cookie', authCookie(editor))).body.data).toEqual([]);
    });
});

describe('PATCH /api/docs/:id/collaborators/:collaboratorId', () => {
    it('the owner changes a role', async () => {
        const { owner, viewer, doc } = await sharedDocFixture();
        const res = await request(app)
            .patch(`/api/docs/${doc.id}/collaborators/${viewer.id}`)
            .set('Cookie', authCookie(owner))
            .send({ role: 'editor' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Collaborator role updated to editor' });
        expect((await prisma.docCollaborator.findFirstOrThrow({ where: { docId: doc.id, userId: viewer.id } })).role).toBe('editor');
    });

    it('400 bad role, 404 not the owner, 404 not a collaborator', async () => {
        const { owner, editor, stranger, doc } = await sharedDocFixture();
        const bad = await request(app).patch(`/api/docs/${doc.id}/collaborators/${editor.id}`).set('Cookie', authCookie(owner)).send({ role: 'admin' });
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ message: "Invalid role. Must be 'editor' or 'viewer'" });

        const notOwner = await request(app).patch(`/api/docs/${doc.id}/collaborators/${editor.id}`).set('Cookie', authCookie(editor)).send({ role: 'viewer' });
        expect(notOwner.status).toBe(404);
        expect(notOwner.body).toEqual({ message: 'Doc not found or you are not the owner' });

        const missing = await request(app).patch(`/api/docs/${doc.id}/collaborators/${stranger.id}`).set('Cookie', authCookie(owner)).send({ role: 'viewer' });
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ message: 'Collaborator not found' });
    });
});

describe('DELETE /api/docs/:id/collaborators/:collaboratorId', () => {
    it('the owner removes and bans a collaborator and disconnects them live', async () => {
        const { owner, editor, doc } = await sharedDocFixture();
        const res = await request(app).delete(`/api/docs/${doc.id}/collaborators/${editor.id}`).set('Cookie', authCookie(owner));

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Collaborator removed', remainingCount: 1 });
        expect(await prisma.docCollaborator.count({ where: { docId: doc.id, userId: editor.id } })).toBe(0);
        expect(await prisma.docBannedUser.count({ where: { docId: doc.id, userId: editor.id } })).toBe(1);
        expect(vi.mocked(disconnectUser)).toHaveBeenCalledWith(doc.id, editor.id, 1, false, owner.id);

        // Banned now: no access.
        expect((await request(app).get(`/api/docs/${doc.id}`).set('Cookie', authCookie(editor))).status).toBe(404);
    });

    it('a collaborator can leave (no ban), but not remove others', async () => {
        const { editor, viewer, doc } = await sharedDocFixture();
        const other = await request(app).delete(`/api/docs/${doc.id}/collaborators/${editor.id}`).set('Cookie', authCookie(viewer));
        expect(other.status).toBe(403);
        expect(other.body).toEqual({ message: 'Only the owner can remove other collaborators' });

        const leave = await request(app).delete(`/api/docs/${doc.id}/collaborators/${viewer.id}`).set('Cookie', authCookie(viewer));
        expect(leave.status).toBe(200);
        expect(leave.body.remainingCount).toBe(1);
        expect(await prisma.docBannedUser.count({ where: { docId: doc.id, userId: viewer.id } })).toBe(0);
        expect(vi.mocked(disconnectUser)).toHaveBeenCalledWith(doc.id, viewer.id, 1, true, viewer.id);
    });

    it('404 for an unknown collaborator or doc', async () => {
        const { owner, stranger, doc } = await sharedDocFixture();
        const res = await request(app).delete(`/api/docs/${doc.id}/collaborators/${stranger.id}`).set('Cookie', authCookie(owner));
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ message: 'Collaborator not found' });
        expect(await prisma.docBannedUser.count({ where: { docId: doc.id, userId: stranger.id } })).toBe(0);

        const noDoc = await request(app).delete(`/api/docs/${doc.id}/collaborators/${owner.id}`).set('Cookie', authCookie(stranger));
        expect(noDoc.status).toBe(404);
        expect(noDoc.body).toEqual({ message: 'Doc not found' });
    });
});
