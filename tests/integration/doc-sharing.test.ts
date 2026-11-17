// Sharing, rebuilt (MANAGER_AND_DOCS_PLAN §2): publish (a stable read-only link, /api/public/docs/:slug),
// people by email (can view / can edit), requests to edit from readers of a published doc, the live
// connection following every change (D6), the actions an agent can only ask for, and what is gone
// (share links, editor links, bans).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stateBytes } from '../../src/services/docs/docState';
import request from 'supertest';
import * as Y from 'yjs';

vi.mock('../../src/collaboration/hocuspocus', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/collaboration/hocuspocus')>()),
    disconnectUser: vi.fn(() => true),
    refreshUserAccess: vi.fn(() => 0),
}));

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { disconnectUser, refreshUserAccess } from '../../src/collaboration/hocuspocus';
import { docJsonToYjsState } from '../../src/services/docs/docContent';
import { normalizeBoard, writeBoard } from '../../src/services/docs/canvas';
import { BLOCKS_FRAGMENT, blocksToYElements } from '../../src/services/docs/blocks/serverEditor';
import { newPublicSlug } from '../../src/services/docs/docSharing.service';
import { authCookie, createTestUser } from '../helpers/auth';
import { asAgent, createTestToken } from '../helpers/agent';
import { mailsTo } from '../helpers/mail';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

let n = 0;
/** A user with a deliverable address (test users are @test.local, which the sharing emails skip). */
const person = (name: string) => createTestUser({ name, email: `${name.toLowerCase().replace(/\W+/g, '')}-${Date.now()}-${++n}@example.com` });

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

async function ownedDoc(owner: TestUser, title = 'Caching, part 2', content: unknown[] = [para('Write-through keeps the cache warm.')]) {
    return prisma.doc.create({ data: { userId: owner.id, title, yjsState: docJsonToYjsState({ type: 'doc', content }) } });
}

const as = (user: TestUser) => ({
    get: (url: string) => request(app).get(url).set('Cookie', authCookie(user)),
    put: (url: string, body: object) => request(app).put(url).set('Cookie', authCookie(user)).send(body),
    post: (url: string, body: object = {}) => request(app).post(url).set('Cookie', authCookie(user)).send(body),
    patch: (url: string, body: object) => request(app).patch(url).set('Cookie', authCookie(user)).send(body),
    delete: (url: string) => request(app).delete(url).set('Cookie', authCookie(user)),
});

async function publish(owner: TestUser, docId: string): Promise<string> {
    const res = await as(owner).put(`/api/docs/${docId}/publish`, { on: true });
    expect(res.status).toBe(200);
    return res.body.data.published.slug as string;
}

/** The public page's Y.Doc, decoded. */
function pageDoc(state: string): Y.Doc {
    const y = new Y.Doc();
    Y.applyUpdate(y, new Uint8Array(Buffer.from(state, 'base64')));
    return y;
}

beforeEach(() => {
    vi.mocked(disconnectUser).mockClear();
    vi.mocked(refreshUserAccess).mockClear();
});

describe('publish', () => {
    it('a stable link with the title in it; on twice keeps it; off ends it; on again is a new one; updatedAt stays', async () => {
        const owner = await person('Owner');
        const doc = await ownedDoc(owner);
        const res = await as(owner).put(`/api/docs/${doc.id}/publish`, { on: true });
        expect(res.status).toBe(200);
        const { published } = res.body.data;
        expect(published.slug).toMatch(/^caching-part-2-[a-z0-9]{12}$/);
        expect(published.url).toBe(`http://localhost:3005/p/${published.slug}`);
        expect((await as(owner).put(`/api/docs/${doc.id}/publish`, { on: true })).body.data.published.slug).toBe(published.slug);
        const row = await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } });
        expect(row.updatedAt.getTime()).toBe(doc.updatedAt.getTime());
        expect(row.publicSlug).toBe(published.slug);

        expect((await request(app).get(`/api/public/docs/${published.slug}`)).status).toBe(200);
        const off = await as(owner).put(`/api/docs/${doc.id}/publish`, { on: false });
        expect(off.body.data).toEqual({ published: null });
        expect((await request(app).get(`/api/public/docs/${published.slug}`)).status).toBe(404);
        const again = await publish(owner, doc.id);
        expect(again).not.toBe(published.slug);
    });

    it('only the owner; a trashed doc is not published; a bad body is a 400', async () => {
        const [owner, editor, stranger] = await Promise.all([person('Owner'), person('Editor'), person('Stranger')]);
        const doc = await ownedDoc(owner);
        await prisma.docCollaborator.create({ data: { docId: doc.id, userId: editor.id, role: 'editor' } });
        expect((await as(editor).put(`/api/docs/${doc.id}/publish`, { on: true })).status).toBe(403);
        expect((await as(stranger).put(`/api/docs/${doc.id}/publish`, { on: true })).status).toBe(404);
        expect((await as(owner).put(`/api/docs/${doc.id}/publish`, { on: 'yes' })).status).toBe(400);
        await as(owner).post(`/api/docs/${doc.id}/trash`);
        const trashed = await as(owner).put(`/api/docs/${doc.id}/publish`, { on: true });
        expect(trashed.status).toBe(409);
        expect(trashed.body.message).toBe('This doc is in the trash. Restore it to publish it.');
    });

    it('slugs: the first words of the title, cut at a word; random only when the title has no letters', () => {
        expect(newPublicSlug('Café: the CAP theorem, explained simply for interviews and design reviews')).toMatch(/^cafe-the-cap-theorem-explained-simply-[a-z0-9]{12}$/);
        expect(newPublicSlug('A-word-that-ends-exactly-at-forty-chars-x and more')).toMatch(/^a-word-that-ends-exactly-at-forty-chars-[a-z0-9]{12}$/);
        expect(newPublicSlug('🙂 !!')).toMatch(/^[a-z0-9]{12}$/);
    });
});

describe('the public page', () => {
    it('anyone reads it without a login: the title, the owner, the blocks (old content converted) and the boards it shows', async () => {
        const owner = await person('Alex');
        const doc = await ownedDoc(owner, 'Rate limiter', [para('Token bucket per user.'), { type: 'canvas', attrs: { canvasId: 'cv_shownBoard01', height: 440 } }]);
        // A board the doc shows, and one left in its maps by a deleted canvas.
        const y = new Y.Doc();
        Y.applyUpdate(y, doc.yjsState!);
        writeBoard(y, 'cv_shownBoard01', normalizeBoard({ nodes: [{ id: 'api', text: 'API gateway' }], edges: [] }));
        writeBoard(y, 'cv_deletedOne01', normalizeBoard({ nodes: [{ id: 'old', text: 'Deleted board' }], edges: [] }));
        await prisma.doc.update({ where: { id: doc.id }, data: { yjsState: stateBytes(Y.encodeStateAsUpdate(y)) } });
        const slug = await publish(owner, doc.id);

        const res = await request(app).get(`/api/public/docs/${slug}`);
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body.data).toMatchObject({ title: 'Rate limiter', owner: { name: 'Alex' }, access: 'anonymous', docId: null, coverImage: null });
        const page = pageDoc(res.body.data.state);
        expect(page.getXmlFragment(BLOCKS_FRAGMENT).toString()).toContain('Token bucket per user.');
        expect(page.share.has('default')).toBe(false);
        expect([...page.getMap('canvas:cv_shownBoard01:nodes').keys()]).toEqual(['api']);
        expect(page.share.has('canvas:cv_deletedOne01:nodes')).toBe(false);
        expect(JSON.stringify(res.body)).not.toContain('yjsState');
    });

    it('a doc on the new editor shows its blocks, never the old copy beside them (words deleted since)', async () => {
        const owner = await person('Owner');
        const doc = await ownedDoc(owner, 'Migrated', [para('Stale secret line')]);
        const y = new Y.Doc();
        Y.applyUpdate(y, doc.yjsState!);
        const elements = blocksToYElements([{ type: 'paragraph', content: [{ type: 'text', text: 'Fresh text only', styles: {} }] }]);
        y.transact(() => {
            const group = new Y.XmlElement('blockGroup');
            y.getXmlFragment(BLOCKS_FRAGMENT).insert(0, [group]);
            group.insert(0, elements);
        });
        await prisma.doc.update({ where: { id: doc.id }, data: { yjsState: stateBytes(Y.encodeStateAsUpdate(y)) } });
        const slug = await publish(owner, doc.id);

        const res = await request(app).get(`/api/public/docs/${slug}`);
        const text = pageDoc(res.body.data.state).getXmlFragment(BLOCKS_FRAGMENT).toString();
        expect(text).toContain('Fresh text only');
        expect(text).not.toContain('Stale secret');
        expect(Buffer.from(res.body.data.state, 'base64').toString('latin1')).not.toContain('Stale secret');
    });

    it('what a logged-in reader may do: their own access, asked, or ask; never a trashed or unknown page', async () => {
        const [owner, editor, viewer, asker, other] = await Promise.all([person('Owner'), person('Editor'), person('Viewer'), person('Asker'), person('Other')]);
        const doc = await ownedDoc(owner);
        await prisma.docCollaborator.createMany({ data: [{ docId: doc.id, userId: editor.id, role: 'editor' }, { docId: doc.id, userId: viewer.id, role: 'viewer' }] });
        const slug = await publish(owner, doc.id);
        await as(asker).post(`/api/public/docs/${slug}/request`);
        const access = async (u: TestUser) => (await as(u).get(`/api/public/docs/${slug}`)).body.data;
        expect(await access(owner)).toMatchObject({ access: 'owner', docId: doc.id });
        expect(await access(editor)).toMatchObject({ access: 'editor', docId: doc.id });
        expect(await access(viewer)).toMatchObject({ access: 'viewer', docId: doc.id });
        expect(await access(asker)).toMatchObject({ access: 'requested', docId: null });
        expect(await access(other)).toMatchObject({ access: 'none', docId: null });

        await as(owner).post(`/api/docs/${doc.id}/trash`);
        expect((await request(app).get(`/api/public/docs/${slug}`)).status).toBe(404);
        expect((await request(app).get('/api/public/docs/not-a-page-at-all-x')).status).toBe(404);
        expect((await request(app).get('/api/public/docs/BAD_SLUG')).status).toBe(404);
    });
});

describe('asking to edit', () => {
    it('a reader asks once (a notification and an email to the owner); the owner, an editor or a logged-out reader cannot', async () => {
        const [owner, reader, editor] = await Promise.all([person('Owner'), person('Asha'), person('Editor')]);
        const doc = await ownedDoc(owner);
        await prisma.docCollaborator.create({ data: { docId: doc.id, userId: editor.id, role: 'editor' } });
        const slug = await publish(owner, doc.id);

        const asked = await as(reader).post(`/api/public/docs/${slug}/request`);
        expect(asked.status).toBe(201);
        expect(asked.body).toMatchObject({ success: true, status: 'pending', already: false });
        expect((await as(reader).post(`/api/public/docs/${slug}/request`)).body.already).toBe(true);
        const note = await prisma.notification.findFirstOrThrow({ where: { recipientId: owner.id, type: 'doc_access_request' } });
        expect(note).toMatchObject({ senderId: reader.id, title: 'Asha asks to edit "Caching, part 2"', metadata: { docId: doc.id, url: `/docs/${doc.id}?share=1` } });
        const mails = mailsTo(owner.email);
        expect(mails).toHaveLength(1);
        expect(mails[0]!.subject).toBe('Asha asks to edit "Caching, part 2"');
        expect(mails[0]!.html).toContain(`/docs/${doc.id}?share=1`);

        expect((await as(owner).post(`/api/public/docs/${slug}/request`)).status).toBe(400);
        expect((await as(editor).post(`/api/public/docs/${slug}/request`)).body.message).toBe('You can already edit this doc');
        expect((await request(app).post(`/api/public/docs/${slug}/request`)).status).toBe(401);
        await as(owner).put(`/api/docs/${doc.id}/publish`, { on: false });
        expect((await as(editor).post(`/api/public/docs/${slug}/request`)).status).toBe(404);
    });

    it('approve: they can edit (a notification and an email; his notification answered); a viewer is promoted live', async () => {
        const [owner, reader, viewer] = await Promise.all([person('Owner'), person('Asha'), person('Viewer')]);
        const doc = await ownedDoc(owner);
        await prisma.docCollaborator.create({ data: { docId: doc.id, userId: viewer.id, role: 'viewer' } });
        const slug = await publish(owner, doc.id);
        await as(reader).post(`/api/public/docs/${slug}/request`);
        await as(viewer).post(`/api/public/docs/${slug}/request`);

        const people = (await as(owner).get(`/api/docs/${doc.id}/people`)).body.data;
        expect(people.requests.map((r: { user: { name: string } }) => r.user.name).sort()).toEqual(['Asha', 'Viewer']);
        const asha = people.requests.find((r: { user: { name: string } }) => r.user.name === 'Asha');
        const approved = await as(owner).post(`/api/docs/${doc.id}/requests/${asha._id}/approve`);
        expect(approved.status).toBe(200);
        expect(approved.body.data.people).toEqual(expect.arrayContaining([expect.objectContaining({ _id: reader.id, role: 'editor' })]));
        expect(approved.body.data.requests.map((r: { user: { name: string } }) => r.user.name)).toEqual(['Viewer']);
        expect(await prisma.notification.findFirst({ where: { recipientId: reader.id, type: 'doc_access_approved' } })).toMatchObject({ title: 'You can edit "Caching, part 2"' });
        expect(mailsTo(reader.email).map((m) => m.subject)).toEqual(['You can edit "Caching, part 2"']);
        expect(await prisma.notification.findFirst({ where: { recipientId: owner.id, metadata: { path: ['requestId'], equals: asha._id } } })).toMatchObject({ isRead: true, status: 'accepted' });
        expect(vi.mocked(refreshUserAccess)).not.toHaveBeenCalled();
        expect((await as(owner).post(`/api/docs/${doc.id}/requests/${asha._id}/approve`)).status).toBe(404);

        const viewerAsk = approved.body.data.requests[0];
        await as(owner).post(`/api/docs/${doc.id}/requests/${viewerAsk._id}/approve`);
        expect((await prisma.docCollaborator.findUniqueOrThrow({ where: { docId_userId: { docId: doc.id, userId: viewer.id } } })).role).toBe('editor');
        expect(vi.mocked(refreshUserAccess)).toHaveBeenCalledWith(doc.id, viewer.id);
        expect((await as(reader).get(`/api/docs/${doc.id}`)).body.role).toBe('editor');
    });

    it('decline: nothing is sent and nothing changes; they may ask again; only the owner answers', async () => {
        const [owner, reader] = await Promise.all([person('Owner'), person('Asha')]);
        const doc = await ownedDoc(owner);
        const slug = await publish(owner, doc.id);
        await as(reader).post(`/api/public/docs/${slug}/request`);
        const [req] = (await as(owner).get(`/api/docs/${doc.id}/people`)).body.data.requests;
        expect((await as(reader).post(`/api/docs/${doc.id}/requests/${req._id}/decline`)).status).toBe(404);
        const declined = await as(owner).post(`/api/docs/${doc.id}/requests/${req._id}/decline`);
        expect(declined.body.data).toMatchObject({ people: [], requests: [] });
        expect(mailsTo(reader.email)).toEqual([]);
        expect(await prisma.notification.count({ where: { recipientId: reader.id } })).toBe(0);
        expect((await as(reader).post(`/api/public/docs/${slug}/request`)).status).toBe(201);
    });
});

describe('people', () => {
    it('the owner adds someone by email (any case): a notification and an email; again changes the role; a pending ask is answered', async () => {
        const [owner, friend] = await Promise.all([person('Owner'), person('Friend')]);
        const doc = await ownedDoc(owner);
        const slug = await publish(owner, doc.id);
        await as(friend).post(`/api/public/docs/${slug}/request`);

        const added = await as(owner).post(`/api/docs/${doc.id}/people`, { email: friend.email.toUpperCase(), role: 'viewer' });
        expect(added.status).toBe(201);
        expect(added.body).toMatchObject({ already: false, name: 'Friend' });
        expect(added.body.data).toMatchObject({ you: 'owner', owner: { _id: owner.id }, people: [{ _id: friend.id, name: 'Friend', role: 'viewer' }], requests: [] });
        expect(added.body.data.published.slug).toBe(slug);
        expect(await prisma.notification.findFirst({ where: { recipientId: friend.id, type: 'doc_shared' } })).toMatchObject({ title: 'Owner shared "Caching, part 2" with you', metadata: { url: `/docs/${doc.id}` } });
        expect(mailsTo(friend.email).map((m) => m.subject)).toEqual(['Owner shared "Caching, part 2" with you']);
        expect((await as(friend).get(`/api/docs/${doc.id}`)).body.role).toBe('viewer');

        const again = await as(owner).post(`/api/docs/${doc.id}/people`, { email: friend.email, role: 'editor' });
        expect(again.status).toBe(200);
        expect(again.body.already).toBe(true);
        expect(again.body.data.people[0].role).toBe('editor');
        expect(vi.mocked(refreshUserAccess)).toHaveBeenCalledWith(doc.id, friend.id);
        expect(mailsTo(friend.email)).toHaveLength(1);
    });

    it('needs an account (a placeholder is not one); not yourself; only the owner; a real address', async () => {
        const [owner, editor] = await Promise.all([person('Owner'), person('Editor')]);
        const doc = await ownedDoc(owner);
        await prisma.docCollaborator.create({ data: { docId: doc.id, userId: editor.id, role: 'editor' } });
        await prisma.user.create({ data: { email: 'ghost@example.com', name: 'Ghost', isGhost: true } });
        const none = await as(owner).post(`/api/docs/${doc.id}/people`, { email: 'nobody@example.com' });
        expect(none.status).toBe(404);
        expect(none.body).toMatchObject({ code: 'NO_ACCOUNT', message: 'No Recollect account uses that email. They need to sign up first.' });
        expect((await as(owner).post(`/api/docs/${doc.id}/people`, { email: 'ghost@example.com' })).status).toBe(404);
        expect((await as(owner).post(`/api/docs/${doc.id}/people`, { email: owner.email })).status).toBe(400);
        expect((await as(owner).post(`/api/docs/${doc.id}/people`, { email: 'not an email' })).status).toBe(400);
        expect((await as(owner).post(`/api/docs/${doc.id}/people`, { email: editor.email, role: 'admin' })).status).toBe(400);
        expect((await as(editor).post(`/api/docs/${doc.id}/people`, { email: owner.email })).status).toBe(403);
    });

    it('the list: the owner sees requests, people see the list without them, strangers nothing', async () => {
        const [owner, viewer, reader, stranger] = await Promise.all([person('Owner'), person('Viewer'), person('Reader'), person('Stranger')]);
        const doc = await ownedDoc(owner);
        await prisma.docCollaborator.create({ data: { docId: doc.id, userId: viewer.id, role: 'viewer' } });
        const slug = await publish(owner, doc.id);
        await as(reader).post(`/api/public/docs/${slug}/request`);
        expect((await as(owner).get(`/api/docs/${doc.id}/people`)).body.data.requests).toHaveLength(1);
        const forViewer = (await as(viewer).get(`/api/docs/${doc.id}/people`)).body.data;
        expect(forViewer).toMatchObject({ you: 'viewer', people: [{ _id: viewer.id }], requests: [], published: { slug } });
        expect((await as(stranger).get(`/api/docs/${doc.id}/people`)).status).toBe(404);
    });

    it('a role change reconnects them live; removing closes their connection, no ban (they may ask again); leaving; the owner stays', async () => {
        const [owner, editor, viewer] = await Promise.all([person('Owner'), person('Editor'), person('Viewer')]);
        const doc = await ownedDoc(owner);
        await prisma.docCollaborator.createMany({ data: [{ docId: doc.id, userId: editor.id, role: 'editor' }, { docId: doc.id, userId: viewer.id, role: 'viewer' }] });

        const demoted = await as(owner).patch(`/api/docs/${doc.id}/people/${editor.id}`, { role: 'viewer' });
        expect(demoted.status).toBe(200);
        expect(vi.mocked(refreshUserAccess)).toHaveBeenCalledWith(doc.id, editor.id);
        expect((await as(owner).patch(`/api/docs/${doc.id}/people/${editor.id}`, { role: 'owner' })).status).toBe(400);
        expect((await as(viewer).patch(`/api/docs/${doc.id}/people/${editor.id}`, { role: 'editor' })).status).toBe(403);
        expect((await as(owner).patch(`/api/docs/${doc.id}/people/${owner.id}`, { role: 'viewer' })).status).toBe(404);

        expect((await as(viewer).delete(`/api/docs/${doc.id}/people/${editor.id}`)).status).toBe(403);
        const removed = await as(owner).delete(`/api/docs/${doc.id}/people/${editor.id}`);
        expect(removed.status).toBe(200);
        expect(removed.body.data.people.map((p: { _id: string }) => p._id)).toEqual([viewer.id]);
        expect(vi.mocked(disconnectUser)).toHaveBeenCalledWith(doc.id, editor.id, 1, false, owner.id);
        expect((await as(editor).get(`/api/docs/${doc.id}`)).status).toBe(404);
        const slug = await publish(owner, doc.id);
        expect((await as(editor).post(`/api/public/docs/${slug}/request`)).status).toBe(201);

        const left = await as(viewer).delete(`/api/docs/${doc.id}/people/${viewer.id}`);
        expect(left.body).toEqual({ success: true, left: true });
        expect(vi.mocked(disconnectUser)).toHaveBeenCalledWith(doc.id, viewer.id, 0, true, viewer.id);
        expect((await as(owner).delete(`/api/docs/${doc.id}/people/${owner.id}`)).status).toBe(400);
        expect((await as(owner).delete(`/api/docs/${doc.id}/people/${viewer.id}`)).status).toBe(404);
    });
});

describe('agents ask, he taps', () => {
    it('publish_doc and share_doc are cards with the exact words; his tap does it; checked when asked', async () => {
        const [owner, friend] = await Promise.all([person('Owner'), person('Friend')]);
        const doc = await ownedDoc(owner, 'Kafka notes');
        const agent = asAgent((await createTestToken(owner)).token);

        const pub = await agent.post('/api/actions', { action: 'publish_doc', input: { docId: doc.id, on: true } });
        expect(pub.status).toBe(201);
        expect(pub.body.data.text).toBe('Publish "Kafka notes" to the web: anyone with the link can read it (never edit)');
        const share = await agent.post('/api/actions', { action: 'share_doc', input: { docId: doc.id, email: friend.email, role: 'editor' } });
        expect(share.body.data.text).toBe(`Share "Kafka notes" with Friend (${friend.email}): they can edit`);
        expect((await agent.post('/api/actions', { action: 'share_doc', input: { docId: doc.id, email: 'nobody@example.com', role: 'viewer' } })).body.code).toBe('NO_ACCOUNT');
        expect((await agent.post('/api/actions', { action: 'publish_doc', input: { docId: doc.id, on: false } })).body.code).toBe('NOTHING_TO_DO');
        // Nothing happened yet; the agent can't tap; the public and people routes refuse tokens.
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).publicSlug).toBeNull();
        expect((await agent.post(`/api/suggestions/${pub.body.data._id}/accept`)).status).toBe(403);
        expect((await agent.put(`/api/docs/${doc.id}/publish`, { on: true })).status).toBe(403);
        expect((await agent.post(`/api/docs/${doc.id}/people`, { email: friend.email })).status).toBe(403);

        expect((await as(owner).post(`/api/suggestions/${pub.body.data._id}/accept`)).status).toBe(200);
        expect((await prisma.doc.findUniqueOrThrow({ where: { id: doc.id } })).publicSlug).toMatch(/^kafka-notes-/);
        expect((await as(owner).post(`/api/suggestions/${share.body.data._id}/accept`)).status).toBe(200);
        expect((await prisma.docCollaborator.findUniqueOrThrow({ where: { docId_userId: { docId: doc.id, userId: friend.id } } })).role).toBe('editor');

        const remove = await agent.post('/api/actions', { action: 'share_doc', input: { docId: doc.id, email: friend.email, role: 'remove' } });
        expect(remove.body.data.text).toBe('Remove Friend from "Kafka notes"');
        await as(owner).post(`/api/suggestions/${remove.body.data._id}/accept`);
        expect(await prisma.docCollaborator.count({ where: { docId: doc.id } })).toBe(0);
    });
});

describe('what is gone', () => {
    it('no share links, editor links, joining by a link or the old request routes', async () => {
        const owner = await person('Owner');
        const doc = await ownedDoc(owner);
        expect((await as(owner).post('/api/create-doc-link', { type: 'doc', docId: doc.id, role: 'editor' })).status).toBe(404);
        expect([401, 404]).toContain((await request(app).get('/api/doc/some-slug')).status);
        expect((await as(owner).post('/api/save/some-slug')).status).toBe(404);
        expect((await as(owner).post(`/api/docs/${doc.id}/request-access`, {})).status).toBe(404);
        expect((await as(owner).get('/api/docs/pending-requests')).status).toBe(404);
        expect((await as(owner).get('/api/docs/shared-by-me')).status).toBe(404);
    });
});
