// Doc sharing on Postgres: share links (/api/create-doc-link, /api/doc/:slug, /api/save/:slug),
// access requests (/api/docs/:id/request-access, requests, approve, reject, pending-requests) and
// the expired-link cleanup that replaces Mongo's TTL index.
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { hocuspocusServer } from '../../src/collaboration/hocuspocus';
import { deleteExpiredShareLinks } from '../../src/services/docs/docSharing.service';
import { authCookie, createTestUser } from '../helpers/auth';
import { mailsTo } from '../helpers/mail';

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

const DAY_MS = 24 * 60 * 60 * 1000;

async function ownedDoc(title = 'Shared doc') {
    const owner = await createTestUser({ name: 'Owner' });
    const doc = await prisma.doc.create({ data: { userId: owner.id, title, yjsState: 'AAA=' } });
    return { owner, doc };
}

async function createLink(owner: TestUser, docId: string, role?: 'editor' | 'viewer'): Promise<string> {
    const res = await request(app).post('/api/create-doc-link').set('Cookie', authCookie(owner)).send({ type: 'doc', docId, ...(role ? { role } : {}) });
    expect(res.status).toBe(200);
    return String(res.body.data.url).split('/').pop()!;
}

const liveDocuments = () => (hocuspocusServer as any).hocuspocus.documents as Map<string, unknown>;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('POST /api/create-doc-link', () => {
    it('creates a 3-day viewer link and returns the frontend URL', async () => {
        const { owner, doc } = await ownedDoc();
        const before = Date.now();
        const res = await request(app).post('/api/create-doc-link').set('Cookie', authCookie(owner)).send({ type: 'doc', docId: doc.id });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, message: 'New share link generated. Previous links invalidated.' });
        const slug = String(res.body.data.url).split('/').pop()!;
        expect(res.body.data.url).toBe(`http://localhost:3005/doc/${slug}`);

        const link = await prisma.shareLink.findUniqueOrThrow({ where: { slug } });
        expect(link).toMatchObject({ docId: doc.id, userId: owner.id, type: 'doc', role: 'viewer' });
        const ttl = link.expiresAt.getTime() - before;
        expect(ttl).toBeGreaterThan(3 * DAY_MS - 2 * 60 * 60 * 1000); // DST-safe: calendar days
        expect(ttl).toBeLessThan(3 * DAY_MS + 2 * 60 * 60 * 1000);
    });

    it('a new link invalidates old links, access requests and bans', async () => {
        const { owner, doc } = await ownedDoc();
        const requester = await createTestUser();
        const banned = await createTestUser();
        const oldSlug = await createLink(owner, doc.id);
        await request(app).post(`/api/docs/${doc.id}/request-access`).set('Cookie', authCookie(requester)).send({ shareLinkSlug: oldSlug });
        await prisma.docBannedUser.create({ data: { docId: doc.id, userId: banned.id } });

        const newSlug = await createLink(owner, doc.id, 'editor');

        expect(await prisma.shareLink.findMany({ where: { docId: doc.id }, select: { slug: true, role: true } })).toEqual([
            { slug: newSlug, role: 'editor' },
        ]);
        expect(await prisma.accessRequest.count({ where: { docId: doc.id } })).toBe(0);
        expect(await prisma.docBannedUser.count({ where: { docId: doc.id } })).toBe(0);
        expect((await request(app).get(`/api/doc/${oldSlug}`)).status).toBe(404);
    });

    it('validation, not found and not-owner errors (old messages)', async () => {
        const { owner, doc } = await ownedDoc();
        const other = await createTestUser();
        const cases: Array<[object, number, string]> = [
            [{ type: 'doc' }, 400, 'Missing document ID'],
            [{ type: 'doc', docId: '  ' }, 400, 'Missing document ID'],
            [{ docId: doc.id }, 400, 'Type cannot be empty'],
            [{ type: 'content', docId: doc.id }, 400, 'Type should be doc'],
            [{ type: 'doc', docId: doc.id, role: 'owner' }, 400, '`owner` is not a valid enum value for path `role`.'],
            [{ type: 'doc', docId: 'missing-doc' }, 404, 'Document not found'],
        ];
        for (const [body, status, message] of cases) {
            const res = await request(app).post('/api/create-doc-link').set('Cookie', authCookie(owner)).send(body);
            expect([res.status, res.body.message]).toEqual([status, message]);
        }
        const notOwner = await request(app).post('/api/create-doc-link').set('Cookie', authCookie(other)).send({ type: 'doc', docId: doc.id });
        expect(notOwner.status).toBe(403);
        expect(notOwner.body).toEqual({ message: 'Only the document owner can generate share links' });

        expect((await request(app).post('/api/create-doc-link').send({ type: 'doc', docId: doc.id })).status).toBe(401);
    });
});

describe('GET /api/doc/:slug (public)', () => {
    it('returns the link with the shared doc, without a login', async () => {
        const { owner, doc } = await ownedDoc('Public read');
        const slug = await createLink(owner, doc.id);

        const res = await request(app).get(`/api/doc/${slug}`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, message: 'Successfully fetched the document' });
        expect(res.body.data).toMatchObject({ _id: expect.any(String), user: owner.id, type: 'doc', role: 'viewer', slug });
        expect(res.body.data.doc).toEqual({
            _id: doc.id,
            title: 'Public read',
            yjsState: 'AAA=',
            docType: 'notes',
            isPinned: false,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
            coverImage: null,
            cloudImages: [],
        });
    });

    it('404 for expired and unknown links', async () => {
        const { owner, doc } = await ownedDoc();
        const slug = await createLink(owner, doc.id);
        await prisma.shareLink.update({ where: { slug }, data: { expiresAt: new Date(Date.now() - 1000) } });

        for (const s of [slug, 'no-such-slug']) {
            const res = await request(app).get(`/api/doc/${s}`);
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ message: 'URL is expired or not found' });
        }
    });
});

describe('POST /api/save/:slug (save to my profile)', () => {
    it('adds the user as a collaborator with the link role and tells live editors', async () => {
        const { owner, doc } = await ownedDoc();
        const slug = await createLink(owner, doc.id, 'editor');
        const user = await createTestUser();
        const live = { broadcastStateless: vi.fn() };
        liveDocuments().set(`doc_${doc.id}`, live);
        try {
            const res = await request(app).post(`/api/save/${slug}`).set('Cookie', authCookie(user));
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ success: true, message: 'Document saved to your profile successfully' });
            expect(await prisma.docCollaborator.findFirst({ where: { docId: doc.id, userId: user.id }, select: { role: true } })).toEqual({ role: 'editor' });
            expect(live.broadcastStateless).toHaveBeenCalledWith(JSON.stringify({ type: 'COLLABORATOR_JOINED', userId: user.id }));
        } finally {
            liveDocuments().delete(`doc_${doc.id}`);
        }

        const again = await request(app).post(`/api/save/${slug}`).set('Cookie', authCookie(user));
        expect(again.status).toBe(200);
        expect(again.body).toEqual({ success: true, message: 'You are already a collaborator on this document' });
    });

    it('owner → 400, banned → 403, expired → 404 (old bodies)', async () => {
        const { owner, doc } = await ownedDoc();
        const slug = await createLink(owner, doc.id);
        const banned = await createTestUser();
        await prisma.docBannedUser.create({ data: { docId: doc.id, userId: banned.id } });

        const asOwner = await request(app).post(`/api/save/${slug}`).set('Cookie', authCookie(owner));
        expect(asOwner.status).toBe(400);
        expect(asOwner.body).toEqual({ success: false, message: 'You are the owner of this document' });

        const asBanned = await request(app).post(`/api/save/${slug}`).set('Cookie', authCookie(banned));
        expect(asBanned.status).toBe(403);
        expect(asBanned.body).toEqual({ success: false, message: 'Your access to this document has been revoked' });

        await prisma.shareLink.update({ where: { slug }, data: { expiresAt: new Date(Date.now() - 1) } });
        const expired = await request(app).post(`/api/save/${slug}`).set('Cookie', authCookie(banned));
        expect(expired.status).toBe(404);
        expect(expired.body).toEqual({ message: 'Invalid or expired share link' });
    });
});

describe('access requests', () => {
    it('request → owner sees it → approve → the requester becomes a collaborator (emails both ways)', async () => {
        const { owner, doc } = await ownedDoc('Requested doc');
        const slug = await createLink(owner, doc.id, 'editor');
        const requester = await createTestUser({ name: 'Requester' });

        const asked = await request(app).post(`/api/docs/${doc.id}/request-access`).set('Cookie', authCookie(requester)).send({ shareLinkSlug: slug });
        expect(asked.status).toBe(201);
        expect(asked.body).toEqual({ success: true, message: 'Access request sent. The owner will be notified.', status: 'pending' });
        await vi.waitFor(() => expect(mailsTo(owner.email).map((m) => m.subject)).toEqual(['Requester requested access to "Requested doc"']));

        const again = await request(app).post(`/api/docs/${doc.id}/request-access`).set('Cookie', authCookie(requester)).send({ shareLinkSlug: slug });
        expect(again.status).toBe(200);
        expect(again.body).toEqual({ success: true, message: 'You have already requested access. Please wait for approval.', status: 'pending' });
        expect(await prisma.accessRequest.count({ where: { docId: doc.id } })).toBe(1);

        const list = await request(app).get(`/api/docs/${doc.id}/requests`).set('Cookie', authCookie(owner));
        expect(list.status).toBe(200);
        expect(list.body.data).toEqual([
            {
                _id: expect.any(String),
                user: { _id: requester.id, name: 'Requester', email: requester.email, avatar: '' },
                doc: doc.id,
                shareLink: expect.any(String),
                status: 'pending',
                role: 'editor',
                requestedAt: expect.any(String),
                respondedAt: null,
                createdAt: expect.any(String),
                updatedAt: expect.any(String),
            },
        ]);
        const reqId = list.body.data[0]._id;

        const pending = await request(app).get('/api/docs/pending-requests').set('Cookie', authCookie(owner));
        expect(pending.status).toBe(200);
        expect(pending.body.data).toHaveLength(1);
        expect(pending.body.data[0]).toMatchObject({ _id: reqId, doc: { _id: doc.id, title: 'Requested doc' }, user: { _id: requester.id } });

        const approved = await request(app).post(`/api/docs/${doc.id}/requests/${reqId}/approve`).set('Cookie', authCookie(owner));
        expect(approved.status).toBe(200);
        expect(approved.body).toEqual({ success: true, message: 'Access request approved' });
        expect(await prisma.docCollaborator.findFirst({ where: { docId: doc.id, userId: requester.id }, select: { role: true } })).toEqual({ role: 'editor' });
        expect(await prisma.accessRequest.findUniqueOrThrow({ where: { id: reqId } })).toMatchObject({ status: 'approved', respondedAt: expect.any(Date) });
        await vi.waitFor(() => expect(mailsTo(requester.email)).toHaveLength(1));

        const twice = await request(app).post(`/api/docs/${doc.id}/requests/${reqId}/approve`).set('Cookie', authCookie(owner));
        expect(twice.status).toBe(404);
        expect(twice.body).toEqual({ message: 'Access request not found or already processed' });

        // Now a collaborator: asking again is refused, and the doc is listed with the role.
        const asCollaborator = await request(app).post(`/api/docs/${doc.id}/request-access`).set('Cookie', authCookie(requester)).send({ shareLinkSlug: slug });
        expect(asCollaborator.status).toBe(400);
        expect(asCollaborator.body).toEqual({ message: 'You are already a collaborator' });
        const docs = await request(app).get('/api/docs').set('Cookie', authCookie(requester));
        expect(docs.body.data.map((d: any) => [d._id, d.role])).toEqual([[doc.id, 'editor']]);
    });

    it('reject, then asking again resets the same request to pending (unique per user + doc)', async () => {
        const { owner, doc } = await ownedDoc();
        const slug = await createLink(owner, doc.id);
        const requester = await createTestUser();
        await request(app).post(`/api/docs/${doc.id}/request-access`).set('Cookie', authCookie(requester)).send({ shareLinkSlug: slug });
        const first = await prisma.accessRequest.findFirstOrThrow({ where: { docId: doc.id } });

        const rejected = await request(app).post(`/api/docs/${doc.id}/requests/${first.id}/reject`).set('Cookie', authCookie(owner));
        expect(rejected.status).toBe(200);
        expect(rejected.body).toEqual({ success: true, message: 'Access request rejected' });
        expect((await prisma.accessRequest.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('rejected');
        expect((await request(app).post(`/api/docs/${doc.id}/requests/${first.id}/reject`).set('Cookie', authCookie(owner))).status).toBe(404);

        const again = await request(app).post(`/api/docs/${doc.id}/request-access`).set('Cookie', authCookie(requester)).send({ shareLinkSlug: slug });
        expect(again.status).toBe(201);
        const rows = await prisma.accessRequest.findMany({ where: { docId: doc.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: first.id, status: 'pending', respondedAt: null });
    });

    it('request-access errors: owner, banned, missing/wrong/expired link', async () => {
        const { owner, doc } = await ownedDoc();
        const slug = await createLink(owner, doc.id);
        const { owner: otherOwner, doc: otherDoc } = await ownedDoc('Other');
        const otherSlug = await createLink(otherOwner, otherDoc.id);
        const banned = await createTestUser();
        await prisma.docBannedUser.create({ data: { docId: doc.id, userId: banned.id } });
        const user = await createTestUser();

        const send = (u: TestUser, body: object) => request(app).post(`/api/docs/${doc.id}/request-access`).set('Cookie', authCookie(u)).send(body);

        expect((await send(owner, { shareLinkSlug: slug })).body).toEqual({ message: 'You are the owner of this document' });
        const asBanned = await send(banned, { shareLinkSlug: slug });
        expect([asBanned.status, asBanned.body.message]).toEqual([403, 'Your access to this document has been revoked']);
        for (const body of [{}, { shareLinkSlug: '' }, { shareLinkSlug: otherSlug }, { shareLinkSlug: 'nope' }]) {
            const res = await send(user, body);
            expect([res.status, res.body.message]).toEqual([404, 'Share link is invalid or expired']);
        }
        await prisma.shareLink.update({ where: { slug }, data: { expiresAt: new Date(Date.now() - 1) } });
        expect((await send(user, { shareLinkSlug: slug })).status).toBe(404);
        expect(await prisma.accessRequest.count({ where: { userId: user.id } })).toBe(0);
    });

    it('only the owner can list, approve or reject (403 with the old messages)', async () => {
        const { owner, doc } = await ownedDoc();
        const slug = await createLink(owner, doc.id);
        const requester = await createTestUser();
        await request(app).post(`/api/docs/${doc.id}/request-access`).set('Cookie', authCookie(requester)).send({ shareLinkSlug: slug });
        const { id } = await prisma.accessRequest.findFirstOrThrow({ where: { docId: doc.id } });
        const cookie = authCookie(requester);

        const list = await request(app).get(`/api/docs/${doc.id}/requests`).set('Cookie', cookie);
        expect([list.status, list.body.message]).toEqual([403, 'Only the document owner can view access requests']);
        const approve = await request(app).post(`/api/docs/${doc.id}/requests/${id}/approve`).set('Cookie', cookie);
        expect([approve.status, approve.body.message]).toEqual([403, 'Only the document owner can approve requests']);
        const reject = await request(app).post(`/api/docs/${doc.id}/requests/${id}/reject`).set('Cookie', cookie);
        expect([reject.status, reject.body.message]).toEqual([403, 'Only the document owner can reject requests']);
        expect((await request(app).get('/api/docs/pending-requests').set('Cookie', cookie)).body.data).toEqual([]);
        expect((await prisma.accessRequest.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
    });
});

describe('expired share links (no TTL index in Postgres)', () => {
    it('deleteExpiredShareLinks removes expired links but keeps active ones and those with a pending request', async () => {
        const { owner, doc } = await ownedDoc();
        const { owner: owner2, doc: doc2 } = await ownedDoc();
        const { owner: owner3, doc: doc3 } = await ownedDoc();
        const active = await createLink(owner, doc.id);
        const expiredSlug = await createLink(owner2, doc2.id);
        const withPending = await createLink(owner3, doc3.id);
        const requester = await createTestUser();
        await request(app).post(`/api/docs/${doc3.id}/request-access`).set('Cookie', authCookie(requester)).send({ shareLinkSlug: withPending });
        const past = new Date(Date.now() - 1000);
        await prisma.shareLink.updateMany({ where: { slug: { in: [expiredSlug, withPending] } }, data: { expiresAt: past } });

        const removed = await deleteExpiredShareLinks();

        expect(removed).toBeGreaterThanOrEqual(1);
        const left = (await prisma.shareLink.findMany({ select: { slug: true } })).map((l) => l.slug);
        expect(left).toContain(active);
        expect(left).toContain(withPending);
        expect(left).not.toContain(expiredSlug);
        expect(await prisma.accessRequest.count({ where: { docId: doc3.id, status: 'pending' } })).toBe(1);
    });
});
