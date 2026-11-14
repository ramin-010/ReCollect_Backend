// Hocuspocus doc handler (authorize, load, save, cleanup) and POST /api/collab/upload, on
// Postgres: the handler is called directly. The last block also starts the real WebSocket server.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

vi.mock('upfly', async () => (await import('../helpers/uploads')).createUpflyMock());
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    deleteFromCloud: vi.fn(async () => {}),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { batchDeleteFromCloud } from '../../src/utils/cloudinary';
import { hocuspocusServer } from '../../src/collaboration/hocuspocus';
import { initializeCollaboration } from '../../src/collaboration';
import { signAuthToken } from '../../src/services/auth/token';
import docHandler from '../../src/collaboration/docHandler';
import { docJsonToYjsState } from '../../src/services/docs/docContent';
import { removeDocCloudImages } from '../../src/services/docs/docs.service';
import { readCloudImages } from '../../src/services/uploads/cloudImages';
import { authCookie, createTestUser } from '../helpers/auth';
import { clearUploadedFiles, fakeCloudFile, setUploadedFiles } from '../helpers/uploads';

const image = (imageId: string) => ({ imageId, cloudUrl: `https://cdn/${imageId}.webp`, cloudPublicId: `recollect/${imageId}` });
const imageNode = (imageId: string) => ({ type: 'resizableImage', attrs: { src: `https://cdn/${imageId}.webp`, imageId } });
const liveDocuments = () => (hocuspocusServer as any).hocuspocus.documents as Map<string, unknown>;

/** A Base64 Yjs state with a `metadata` map, like the live editor writes. */
function stateWithMetadata(title: string, coverImage: string | null): string {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Buffer.from(docJsonToYjsState({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'live text' }] }] }), 'base64'));
    ydoc.getMap('metadata').set('title', title);
    ydoc.getMap('metadata').set('coverImage', coverImage);
    const state = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
    ydoc.destroy();
    return state;
}

async function docFixture() {
    const [owner, editor, viewer, banned, stranger] = await Promise.all([
        createTestUser(),
        createTestUser(),
        createTestUser(),
        createTestUser(),
        createTestUser(),
    ]);
    const doc = await prisma.doc.create({ data: { userId: owner.id, title: 'Live doc' } });
    await prisma.docCollaborator.createMany({
        data: [
            { docId: doc.id, userId: editor.id, role: 'editor' },
            { docId: doc.id, userId: viewer.id, role: 'viewer' },
        ],
    });
    await prisma.docBannedUser.create({ data: { docId: doc.id, userId: banned.id } });
    return { owner, editor, viewer, banned, stranger, doc };
}

beforeEach(() => vi.mocked(batchDeleteFromCloud).mockClear());
afterEach(() => {
    clearUploadedFiles();
    vi.restoreAllMocks();
});

describe('docHandler', () => {
    it('authorize: owner and editors edit, viewers connect read-only; banned, strangers, guests may not connect', async () => {
        const { owner, editor, viewer, banned, stranger, doc } = await docFixture();
        expect(await docHandler.authorize(owner.id, doc.id)).toBe('edit');
        expect(await docHandler.authorize(editor.id, doc.id)).toBe('edit');
        expect(await docHandler.authorize(viewer.id, doc.id)).toBe('view');
        expect(await docHandler.authorize(banned.id, doc.id)).toBeNull();
        expect(await docHandler.authorize(stranger.id, doc.id)).toBeNull();
        expect(await docHandler.authorize(null, doc.id, 'any-token')).toBeNull();
        expect(await docHandler.authorize(owner.id, 'no-such-doc')).toBeNull();
    });

    it('load returns the stored Base64 state; unknown docs load as null', async () => {
        const { owner } = await docFixture();
        const doc = await prisma.doc.create({ data: { userId: owner.id, title: 'x', yjsState: 'AQID' } });
        expect(await docHandler.load(doc.id)).toEqual({ id: doc.id, yjsState: 'AQID' });
        expect(await docHandler.load('no-such-doc')).toBeNull();
    });

    it('save stores the state, the preview and the title/cover from the metadata map', async () => {
        const { doc } = await docFixture();
        const state = stateWithMetadata('  Live title ', 'https://img/cover.png');
        await docHandler.save(doc.id, state);

        const stored = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        expect(stored.yjsState).toBe(state);
        expect(stored.previewState).toContain('live text');
        expect(stored.title).toBe('Live title');
        expect(stored.coverImage).toBe('https://img/cover.png');

        await expect(docHandler.save('no-such-doc', state)).resolves.toBeUndefined();
    });

    it('cleanup deletes images the doc no longer uses and keeps the rest', async () => {
        const { owner } = await docFixture();
        const doc = await prisma.doc.create({
            data: {
                userId: owner.id,
                title: 'Images',
                yjsState: docJsonToYjsState({ type: 'doc', content: [imageNode('used')] }),
                cloudImages: [image('used'), image('orphan')],
            },
        });

        await docHandler.cleanup!(doc.id);

        expect(vi.mocked(batchDeleteFromCloud)).toHaveBeenCalledWith(['recollect/orphan']);
        const stored = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        expect(readCloudImages(stored.cloudImages)).toEqual([image('used')]);
    });

    it('cleanup keeps images only the live (not yet stored) document uses', async () => {
        const { owner } = await docFixture();
        const doc = await prisma.doc.create({
            data: {
                userId: owner.id,
                title: 'Live images',
                yjsState: docJsonToYjsState({ type: 'doc', content: [] }),
                cloudImages: [image('just-pasted')],
            },
        });
        const live = new Y.Doc();
        Y.applyUpdate(live, Buffer.from(docJsonToYjsState({ type: 'doc', content: [imageNode('just-pasted')] }), 'base64'));
        liveDocuments().set(`doc_${doc.id}`, live);
        try {
            await docHandler.cleanup!(doc.id);
        } finally {
            liveDocuments().delete(`doc_${doc.id}`);
            live.destroy();
        }
        expect(vi.mocked(batchDeleteFromCloud)).not.toHaveBeenCalled();
        expect(readCloudImages((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).cloudImages)).toEqual([image('just-pasted')]);
    });

    it('cleanup does nothing for an unreadable state (it used to delete every image)', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { owner } = await docFixture();
        const doc = await prisma.doc.create({
            data: { userId: owner.id, title: 'Corrupt', yjsState: Buffer.from([0xff, 0xff, 0xff, 0x01]).toString('base64'), cloudImages: [image('a')] },
        });
        await docHandler.cleanup!(doc.id);
        expect(vi.mocked(batchDeleteFromCloud)).not.toHaveBeenCalled();
    });

    it('removeDocCloudImages removes only the given ids and keeps the order of the rest', async () => {
        const { owner } = await docFixture();
        const doc = await prisma.doc.create({
            data: { userId: owner.id, title: 'Order', cloudImages: [image('a'), image('b'), image('c'), { note: 'no image id' }] },
        });
        await removeDocCloudImages(doc.id, ['b', 'zzz']);
        const stored = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        expect(stored.cloudImages).toEqual([image('a'), image('c'), { note: 'no image id' }]);
    });
});

describe('POST /api/collab/upload', () => {
    it('400 without a file, 500 when the provider returned no URL, 401 without a cookie', async () => {
        const user = await createTestUser();
        const none = await request(app).post('/api/collab/upload').set('Cookie', authCookie(user)).send({});
        expect(none.status).toBe(400);
        expect(none.body).toEqual({ error: 'No image file uploaded' });

        vi.spyOn(console, 'error').mockImplementation(() => {});
        setUploadedFiles({ image: [{ cloudPublicId: 'x' }] });
        const noUrl = await request(app).post('/api/collab/upload').set('Cookie', authCookie(user)).send({});
        expect(noUrl.status).toBe(500);
        expect(noUrl.body).toEqual({ error: 'Upload provider failed to return URL' });

        expect((await request(app).post('/api/collab/upload')).status).toBe(401);
    });

    it('returns the cloud file and records it on the doc for owners and editors (concurrent uploads kept)', async () => {
        const { owner, editor, doc } = await docFixture();
        await prisma.doc.update({ where: { id: doc.id }, data: { cloudImages: [image('existing')] } });
        setUploadedFiles({ image: [fakeCloudFile('image', 'pasted')] });

        const [a, b] = await Promise.all([
            request(app).post('/api/collab/upload').set('Cookie', authCookie(owner)).send({ docId: doc.id, imageId: 'img_a' }),
            request(app).post('/api/collab/upload').set('Cookie', authCookie(editor)).send({ docId: doc.id, imageId: 'img_b' }),
        ]);
        expect(a.status).toBe(200);
        expect(a.body).toEqual({ url: 'https://cdn.example.test/pasted.webp', publicId: 'test/pasted', provider: 'cloudinary', imageId: 'img_a' });
        expect(b.status).toBe(200);

        const row = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        // updatedAt is bumped like Mongoose timestamps did, in UTC like Prisma's own writes.
        expect(Math.abs(row.updatedAt.getTime() - Date.now())).toBeLessThan(60_000);
        const stored = readCloudImages(row.cloudImages);
        expect(stored[0]).toEqual(image('existing'));
        expect(stored.map((img) => img.imageId).sort()).toEqual(['existing', 'img_a', 'img_b']);
        expect(stored.find((img) => img.imageId === 'img_a')).toEqual({
            imageId: 'img_a',
            cloudUrl: 'https://cdn.example.test/pasted.webp',
            cloudPublicId: 'test/pasted',
        });
    });

    it('viewers, banned users and strangers still get the URL, but nothing is recorded on the doc', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { viewer, banned, stranger, doc } = await docFixture();
        setUploadedFiles({ image: [fakeCloudFile('image', 'nope')] });
        for (const user of [viewer, banned, stranger]) {
            const res = await request(app).post('/api/collab/upload').set('Cookie', authCookie(user)).send({ docId: doc.id, imageId: `img_${user.id}` });
            expect(res.status).toBe(200);
        }
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).cloudImages).toEqual([]);
    });
});

// ─── Live connections: a real Hocuspocus server on a free port, real providers ───────────────

describe('live collaboration over WebSocket (read-only viewers)', () => {
    let url = '';
    const providers: HocuspocusProvider[] = [];

    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        initializeCollaboration();
        const server = hocuspocusServer as any;
        server.configuration.port = 0; // a free port: never the dev server's 1234
        server.configuration.quiet = true;
        server.configuration.stopOnSignals = false;
        server.hocuspocus.configuration.debounce = 50;
        server.hocuspocus.configuration.maxDebounce = 200;
        await hocuspocusServer.listen();
        url = `ws://127.0.0.1:${hocuspocusServer.address.port}`;
    });

    afterEach(() => {
        for (const provider of providers.splice(0)) provider.destroy();
    });

    afterAll(async () => {
        await hocuspocusServer.destroy();
        vi.restoreAllMocks();
    });

    /** Connect like the editor does (Node's global WebSocket); resolves once synced or refused. */
    async function connect(name: string, auth: { token?: string; shareToken?: string }) {
        const document = new Y.Doc();
        const authenticated = { scope: undefined as string | undefined, failed: '' };
        const provider = new HocuspocusProvider({
            url: auth.shareToken ? `${url}?shareToken=${auth.shareToken}` : url,
            name,
            document,
            token: auth.token ?? '',
            onAuthenticated: ({ scope }) => {
                authenticated.scope = scope;
            },
            onAuthenticationFailed: ({ reason }) => {
                authenticated.failed = reason || 'denied';
            },
        });
        providers.push(provider);
        await vi.waitFor(() => expect(provider.synced || authenticated.failed).toBeTruthy(), { timeout: 10_000, interval: 20 });
        return { provider, document, text: () => document.getText('t').toString(), authenticated };
    }

    /**
     * Wait until the server has handled everything `from` sent so far: messages on one socket are
     * handled in order, so once `watcher` sees `from`'s new awareness marker, `from`'s earlier
     * document updates were processed (applied, or dropped for a read-only connection).
     */
    async function flush(from: HocuspocusProvider, watcher: HocuspocusProvider) {
        const marker = Math.random().toString(36).slice(2);
        from.setAwarenessField('marker', marker);
        await vi.waitFor(
            () => expect([...watcher.awareness!.getStates().values()].some((s) => s['marker'] === marker)).toBe(true),
            { timeout: 10_000, interval: 20 }
        );
    }

    function disconnectAll() {
        for (const provider of providers.splice(0)) provider.destroy();
    }

    async function roomUnloaded(room: string) {
        await vi.waitFor(() => expect(hocuspocusServer.hocuspocus.documents.has(room)).toBe(false), { timeout: 10_000, interval: 50 });
    }

    function liveText(room: string): string | undefined {
        return (hocuspocusServer.hocuspocus.documents.get(room) as unknown as Y.Doc | undefined)?.getText('t').toString();
    }

    async function storedText(docId: string): Promise<string | null> {
        const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
        if (!row.yjsState) return null;
        const ydoc = new Y.Doc();
        Y.applyUpdate(ydoc, Buffer.from(row.yjsState, 'base64'));
        const text = ydoc.getText('t').toString();
        ydoc.destroy();
        return text;
    }

    it("a doc viewer's update is neither applied to other clients nor stored; an editor's is", async () => {
        const { owner, editor, viewer, doc } = await docFixture();
        const room = `doc_${doc.id}`;

        const ownerClient = await connect(room, { token: signAuthToken(owner.id) });
        const editorClient = await connect(room, { token: signAuthToken(editor.id) });
        const viewerClient = await connect(room, { token: signAuthToken(viewer.id) });
        expect(ownerClient.authenticated.scope).toBe('read-write');
        expect(editorClient.authenticated.scope).toBe('read-write');
        expect(viewerClient.authenticated.scope).toBe('readonly');

        viewerClient.document.getText('t').insert(0, 'viewer-was-here ');
        await flush(viewerClient.provider, ownerClient.provider);
        expect(ownerClient.text()).toBe('');
        expect(editorClient.text()).toBe('');
        expect(liveText(room)).toBe('');

        editorClient.document.getText('t').insert(0, 'editor text');
        await vi.waitFor(() => expect(ownerClient.text()).toBe('editor text'), { timeout: 10_000, interval: 20 });
        await vi.waitFor(async () => expect(await storedText(doc.id)).toBe('editor text'), { timeout: 10_000, interval: 50 });
        // The viewer still receives the editor's changes live.
        await vi.waitFor(() => expect(viewerClient.text()).toContain('editor text'), { timeout: 10_000, interval: 20 });

        // After everyone leaves (final store), the stored state has no trace of the viewer's write.
        disconnectAll();
        await roomUnloaded(room);
        expect(await storedText(doc.id)).toBe('editor text');
    });

    it('a viewer writing alone stores nothing; banned users, strangers and anonymous share-link holders cannot connect', async () => {
        const { viewer, banned, stranger, doc } = await docFixture();
        const room = `doc_${doc.id}`;

        const viewerClient = await connect(room, { token: signAuthToken(viewer.id) });
        expect(viewerClient.authenticated.scope).toBe('readonly');
        viewerClient.document.getText('t').insert(0, 'nope');
        const watcher = await connect(room, { token: signAuthToken(viewer.id) });
        await flush(viewerClient.provider, watcher.provider);
        expect(watcher.text()).toBe('');
        expect(liveText(room)).toBe('');

        disconnectAll();
        await roomUnloaded(room);
        expect(await storedText(doc.id)).not.toBe('nope');

        for (const user of [banned, stranger]) {
            const denied = await connect(room, { token: signAuthToken(user.id) });
            expect(denied.authenticated.failed).toBeTruthy();
            expect(denied.provider.synced).toBe(false);
        }

        // No guest connections to docs: a share token without a login is refused.
        const guest = await connect(room, { shareToken: 'any-share-token' });
        expect(guest.authenticated.failed).toBeTruthy();
        expect(guest.provider.synced).toBe(false);
    });
});
