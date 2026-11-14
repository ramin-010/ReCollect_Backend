// /api/drawings endpoints on Postgres, including the public share link that anonymous viewers open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('upfly', async () => (await import('../helpers/uploads')).createUpflyMock());
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { batchDeleteFromCloud } from '../../src/utils/cloudinary';
import { authCookie, createTestUser } from '../helpers/auth';
import { clearUploadedFiles, fakeCloudFile, setUploadedFiles } from '../helpers/uploads';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

let counter = 0;
async function makeDrawing(owner: TestUser, data: { name?: string; cloudImages?: unknown[]; yjsState?: string } = {}) {
    counter += 1;
    return prisma.drawing.create({
        data: {
            userId: owner.id,
            localId: `local-${counter}`,
            name: data.name ?? `Drawing ${counter}`,
            yjsState: data.yjsState ?? null,
            cloudImages: (data.cloudImages ?? []) as any,
        },
    });
}

async function sharedDrawingFixture() {
    const [owner, editor, viewer, stranger] = await Promise.all([
        createTestUser({ name: 'Owner' }),
        createTestUser({ name: 'Editor' }),
        createTestUser({ name: 'Viewer' }),
        createTestUser({ name: 'Stranger' }),
    ]);
    const drawing = await makeDrawing(owner, { name: 'Board' });
    await prisma.drawingCollaborator.create({ data: { drawingId: drawing.id, userId: editor.id, role: 'editor' } });
    await prisma.drawingCollaborator.create({ data: { drawingId: drawing.id, userId: viewer.id, role: 'viewer' } });
    return { owner, editor, viewer, stranger, drawing };
}

beforeEach(() => vi.mocked(batchDeleteFromCloud).mockClear());
afterEach(() => clearUploadedFiles());

describe('GET /api/drawings/public/shared/:token (no login)', () => {
    it('anonymous viewers can open an enabled share link (was 401: mounted behind the /api auth)', async () => {
        const owner = await createTestUser({ name: 'Artist' });
        const drawing = await makeDrawing(owner, {
            name: 'Public board',
            yjsState: 'AQID',
            cloudImages: [{ imageId: 'f1', cloudUrl: 'https://cdn/f1.webp', cloudPublicId: 'recollect-drawings/f1' }],
        });
        const enabled = await request(app).post(`/api/drawings/${drawing.id}/share`).set('Cookie', authCookie(owner));
        const token = enabled.body.shareToken as string;

        const res = await request(app).get(`/api/drawings/public/shared/${token}`); // no cookie
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            data: {
                _id: drawing.id,
                name: 'Public board',
                yjsState: 'AQID',
                owner: { _id: owner.id, name: 'Artist', email: owner.email, avatar: '' },
                cloudImages: [{ imageId: 'f1', cloudUrl: 'https://cdn/f1.webp', cloudPublicId: 'recollect-drawings/f1' }],
            },
        });
    });

    it('404 when sharing is disabled or the token is unknown', async () => {
        const owner = await createTestUser();
        const drawing = await makeDrawing(owner);
        const { body } = await request(app).post(`/api/drawings/${drawing.id}/share`).set('Cookie', authCookie(owner));
        await request(app).delete(`/api/drawings/${drawing.id}/share`).set('Cookie', authCookie(owner));

        for (const token of [body.shareToken, 'unknownToken1234']) {
            const res = await request(app).get(`/api/drawings/public/shared/${token}`);
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ message: 'Drawing not found or sharing is disabled' });
        }
    });

    it('the other drawing routes still need a login', async () => {
        const responses = await Promise.all([
            request(app).get('/api/drawings'),
            request(app).post('/api/drawings'),
            request(app).get('/api/drawings/x'),
            request(app).post('/api/drawings/x/save'),
            request(app).patch('/api/drawings/x'),
            request(app).delete('/api/drawings/x'),
            request(app).get('/api/drawings/x/share'),
            request(app).post('/api/drawings/x/share'),
            request(app).delete('/api/drawings/x/share'),
            request(app).post('/api/drawings/ai/generate'),
        ]);
        for (const res of responses) expect(res.status).toBe(401);
    });
});

describe('POST /api/drawings', () => {
    it('creates a drawing in the old shape', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/drawings').set('Cookie', authCookie(user)).send({ name: '  Sketch ', localId: 'abc' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ success: true, message: 'Drawing created successfully' });
        expect(res.body.data).toMatchObject({
            _id: expect.any(String),
            user: user.id,
            localId: 'abc',
            name: 'Sketch',
            yjsState: null,
            thumbnail: '',
            collaborators: [],
            cloudImages: [],
            shareToken: null,
            shareEnabled: false,
        });
    });

    it('defaults the name and localId; a duplicate localId is 400 with the old message', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/drawings').set('Cookie', authCookie(user)).send({});
        expect(res.status).toBe(201);
        expect(res.body.data.name).toBe('Untitled Drawing');
        expect(res.body.data.localId).toMatch(/^drawing_\d+$/);

        await request(app).post('/api/drawings').set('Cookie', authCookie(user)).send({ localId: 'dup' });
        const dup = await request(app).post('/api/drawings').set('Cookie', authCookie(user)).send({ localId: 'dup' });
        expect(dup.status).toBe(400);
        expect(dup.body).toEqual({ message: 'Duplicate field value entered: user,localId' });

        // localId is unique per user only.
        const other = await createTestUser();
        expect((await request(app).post('/api/drawings').set('Cookie', authCookie(other)).send({ localId: 'dup' })).status).toBe(201);
    });
});

describe('GET /api/drawings and /api/drawings/:id', () => {
    it('lists own and shared drawings with the role and populated collaborators', async () => {
        const { owner, editor, viewer, stranger, drawing } = await sharedDrawingFixture();
        await makeDrawing(stranger, { name: 'Private' });

        const res = await request(app).get('/api/drawings').set('Cookie', authCookie(viewer));
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0]).toMatchObject({ _id: drawing.id, user: owner.id, name: 'Board', role: 'viewer' });
        expect(res.body.data[0].collaborators).toEqual([
            { user: { _id: editor.id, name: 'Editor', email: editor.email, avatar: '' }, role: 'editor', addedAt: expect.any(String) },
            { user: { _id: viewer.id, name: 'Viewer', email: viewer.email, avatar: '' }, role: 'viewer', addedAt: expect.any(String) },
        ]);
        expect((await request(app).get('/api/drawings').set('Cookie', authCookie(owner))).body.data[0].role).toBe('owner');
    });

    it('returns one drawing with the owner populated, or 404 for strangers', async () => {
        const { owner, editor, stranger, drawing } = await sharedDrawingFixture();
        const res = await request(app).get(`/api/drawings/${drawing.id}`).set('Cookie', authCookie(editor));
        expect(res.status).toBe(200);
        expect(res.body.role).toBe('editor');
        expect(res.body.data).toMatchObject({ _id: drawing.id, user: { _id: owner.id, name: 'Owner', email: owner.email } });

        const denied = await request(app).get(`/api/drawings/${drawing.id}`).set('Cookie', authCookie(stranger));
        expect(denied.status).toBe(404);
        expect(denied.body).toEqual({ message: 'Drawing not found' });
    });
});

describe('POST /api/drawings/:id/save', () => {
    it('saves the Yjs state, records uploads, deletes orphaned images and returns imageUrlMap', async () => {
        const owner = await createTestUser();
        const drawing = await makeDrawing(owner, {
            cloudImages: [
                { imageId: 'keep', cloudUrl: 'https://cdn/keep.webp', cloudPublicId: 'recollect-drawings/keep' },
                { imageId: 'gone', cloudUrl: 'https://cdn/gone.webp', cloudPublicId: 'recollect-drawings/gone' },
            ],
        });
        setUploadedFiles({ image_f9: [fakeCloudFile('image_f9', 'f9')] });

        const res = await request(app)
            .post(`/api/drawings/${drawing.id}/save`)
            .set('Cookie', authCookie(owner))
            .send({
                yjsState: 'BASE64STATE',
                name: '  Renamed board ',
                thumbnail: 'data:image/png;base64,xx',
                imageFileIds: JSON.stringify(['f9']),
                allImageIds: JSON.stringify(['keep', 'f9']),
            });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            message: 'Drawing saved successfully',
            imageUrlMap: { f9: { url: 'https://cdn.example.test/f9.webp', publicId: 'test/f9' } },
        });
        expect(res.body.data).toMatchObject({ _id: drawing.id, user: owner.id, yjsState: 'BASE64STATE', name: 'Renamed board', thumbnail: 'data:image/png;base64,xx' });
        expect(res.body.data.cloudImages).toEqual([
            { imageId: 'keep', cloudUrl: 'https://cdn/keep.webp', cloudPublicId: 'recollect-drawings/keep' },
            { imageId: 'f9', cloudUrl: 'https://cdn.example.test/f9.webp', cloudPublicId: 'test/f9' },
        ]);
        expect(vi.mocked(batchDeleteFromCloud)).toHaveBeenCalledWith(['recollect-drawings/gone']);
    });

    it('editors may save; viewers get 403; strangers 404; an empty name is 400', async () => {
        const { editor, viewer, stranger, drawing } = await sharedDrawingFixture();
        const asEditor = await request(app).post(`/api/drawings/${drawing.id}/save`).set('Cookie', authCookie(editor)).send({ yjsState: 'E' });
        expect(asEditor.status).toBe(200);
        expect(asEditor.body.data).toMatchObject({ yjsState: 'E', name: 'Board' });

        const asViewer = await request(app).post(`/api/drawings/${drawing.id}/save`).set('Cookie', authCookie(viewer)).send({ yjsState: 'V' });
        expect(asViewer.status).toBe(403);
        expect(asViewer.body).toEqual({ message: 'Viewers cannot edit this drawing' });

        const asStranger = await request(app).post(`/api/drawings/${drawing.id}/save`).set('Cookie', authCookie(stranger)).send({ yjsState: 'S' });
        expect(asStranger.status).toBe(404);
        expect(asStranger.body).toEqual({ message: 'Drawing not found' });

        const emptyName = await request(app).post(`/api/drawings/${drawing.id}/save`).set('Cookie', authCookie(editor)).send({ name: '  ' });
        expect(emptyName.status).toBe(400);
        expect(emptyName.body).toEqual({ message: 'Path `name` is required.' });
        expect((await prisma.drawing.findUniqueOrThrow({ where: { id: drawing.id } })).yjsState).toBe('E');
    });
});

describe('PATCH and DELETE /api/drawings/:id (owner only)', () => {
    it('the owner renames; collaborators get 404 "not authorized"', async () => {
        const { owner, editor, drawing } = await sharedDrawingFixture();
        const res = await request(app).patch(`/api/drawings/${drawing.id}`).set('Cookie', authCookie(owner)).send({ name: 'New name' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, message: 'Drawing updated successfully', data: { _id: drawing.id, name: 'New name' } });

        const denied = await request(app).patch(`/api/drawings/${drawing.id}`).set('Cookie', authCookie(editor)).send({ name: 'x' });
        expect(denied.status).toBe(404);
        expect(denied.body).toEqual({ message: 'Drawing not found or not authorized' });
    });

    it('the owner deletes the drawing and its Cloudinary images', async () => {
        const { owner, editor } = await sharedDrawingFixture();
        const drawing = await makeDrawing(owner, { cloudImages: [{ imageId: 'a', cloudUrl: 'u', cloudPublicId: 'recollect-drawings/a' }] });
        await prisma.drawingCollaborator.create({ data: { drawingId: drawing.id, userId: editor.id } });

        const denied = await request(app).delete(`/api/drawings/${drawing.id}`).set('Cookie', authCookie(editor));
        expect(denied.status).toBe(404);

        const res = await request(app).delete(`/api/drawings/${drawing.id}`).set('Cookie', authCookie(owner));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Drawing deleted successfully' });
        expect(vi.mocked(batchDeleteFromCloud)).toHaveBeenCalledWith(['recollect-drawings/a']);
        expect(await prisma.drawing.findUnique({ where: { id: drawing.id } })).toBeNull();
        expect(await prisma.drawingCollaborator.count({ where: { drawingId: drawing.id } })).toBe(0);
    });
});

describe('share management (owner only)', () => {
    it('enable → status → disable → re-enable keeps the same token', async () => {
        const { owner, editor, drawing } = await sharedDrawingFixture();
        const cookie = authCookie(owner);

        const initial = await request(app).get(`/api/drawings/${drawing.id}/share`).set('Cookie', cookie);
        expect(initial.body).toEqual({ success: true, shareToken: null, shareEnabled: false });

        const enabled = await request(app).post(`/api/drawings/${drawing.id}/share`).set('Cookie', cookie);
        expect(enabled.status).toBe(200);
        expect(enabled.body).toMatchObject({ success: true, shareEnabled: true, message: 'Sharing enabled' });
        expect(enabled.body.shareToken).toMatch(/^[A-Za-z0-9]{16}$/);

        const status = await request(app).get(`/api/drawings/${drawing.id}/share`).set('Cookie', cookie);
        expect(status.body).toEqual({ success: true, shareToken: enabled.body.shareToken, shareEnabled: true });

        const disabled = await request(app).delete(`/api/drawings/${drawing.id}/share`).set('Cookie', cookie);
        expect(disabled.body).toEqual({ success: true, shareEnabled: false, message: 'Sharing disabled' });
        expect((await request(app).get(`/api/drawings/${drawing.id}/share`).set('Cookie', cookie)).body.shareToken).toBeNull();

        const again = await request(app).post(`/api/drawings/${drawing.id}/share`).set('Cookie', cookie);
        expect(again.body.shareToken).toBe(enabled.body.shareToken);

        for (const method of ['get', 'post', 'delete'] as const) {
            const res = await request(app)[method](`/api/drawings/${drawing.id}/share`).set('Cookie', authCookie(editor));
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ message: 'Drawing not found or not authorized' });
        }
    });
});
