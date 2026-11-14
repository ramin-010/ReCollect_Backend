// Doc sharing: share links (ShareLink), access requests (AccessRequest) and joining a doc through a
// link. Only doc links exist now (content/dashboard/slide links were cut).
//
// Rules carried over from Mongo:
//   - A link lives 3 days (defaultShareLinkExpiry()); every lookup filters expiresAt > now.
//   - Creating a link deletes the doc's previous links and access requests and lifts every ban.
//   - One access request per user and doc (unique userId+docId): asking again resets it to pending.
// Postgres has no TTL index, so deleteExpiredShareLinks() / startShareLinkCleanupCron() delete
// expired links. A link that still has a PENDING request is kept until the request is answered:
// requests cascade with their link, and in Mongo a pending request outlived its expired link.
import { randomUUID } from 'crypto';
import cron from 'node-cron';
import type { CollaboratorRole } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { defaultShareLinkExpiry } from '../../db/defaults';
import { isUniqueViolation } from '../../db/errors';
import { userSummarySelect } from '../../db/serializers';
import {
    accessRequestInclude,
    accessRequestWithDocInclude,
    sharedDocLinkInclude,
    type AccessRequestRow,
    type AccessRequestWithDocRow,
    type SharedDocLinkRow,
} from '../../db/serializers/docSharing';
import ErrorResponse from '../../utils/errorResponse';
import { sendAccessApprovedEmail, sendAccessRequestEmail } from '../../utils/emailService';
import { findDocCollaborator, isBannedFromDoc, isDocOwner } from './docPermissions';

/** A share link that has not expired (and is a doc link). */
function activeLinkWhere(now: Date) {
    return { type: 'doc' as const, expiresAt: { gt: now } };
}

// ─── Share links ───────────────────────────────────────────────────────

/**
 * POST /api/create-doc-link (owner only). Replaces the doc's links with a new one; its previous
 * links, access requests and bans are deleted in the same transaction. Returns the new slug.
 */
export async function createDocShareLink(ownerId: string, docId: string, role: CollaboratorRole): Promise<{ slug: string }> {
    const doc = await prisma.doc.findUnique({ where: { id: docId }, select: { id: true, userId: true } });
    if (!doc) throw new ErrorResponse(404, 'Document not found');
    if (!isDocOwner(doc, ownerId)) throw new ErrorResponse(403, 'Only the document owner can generate share links');

    const slug = randomUUID();
    await prisma.$transaction(async (tx) => {
        await tx.shareLink.deleteMany({ where: { docId } });
        await tx.docBannedUser.deleteMany({ where: { docId } });
        await tx.accessRequest.deleteMany({ where: { docId } });
        await tx.shareLink.create({
            data: { userId: ownerId, docId, type: 'doc', role, slug, expiresAt: defaultShareLinkExpiry() },
        });
    });
    return { slug };
}

/** GET /api/doc/:slug (public): an unexpired doc link with the shared doc's fields, or null. */
export function findActiveDocShareLink(slug: string, now: Date = new Date(), db: DbClient = prisma): Promise<SharedDocLinkRow | null> {
    return db.shareLink.findFirst({ where: { slug, ...activeLinkWhere(now) }, include: sharedDocLinkInclude });
}

export type JoinViaShareLinkResult = 'owner' | 'banned' | 'already-collaborator' | 'joined';

/**
 * POST /api/save/:slug ("save to my profile"): add the user as a collaborator with the link's role.
 * The doc is shared, not copied.
 */
export async function joinDocViaShareLink(
    slug: string,
    userId: string,
    db: DbClient = prisma
): Promise<{ result: JoinViaShareLinkResult; docId: string }> {
    const link = await db.shareLink.findFirst({ where: { slug, ...activeLinkWhere(new Date()) } });
    if (!link) throw new ErrorResponse(404, 'Invalid or expired share link');

    const doc = await db.doc.findUnique({
        where: { id: link.docId },
        select: {
            id: true,
            userId: true,
            collaborators: { where: { userId }, select: { userId: true, role: true } },
            bannedUsers: { where: { userId }, select: { userId: true } },
        },
    });
    if (!doc) throw new ErrorResponse(404, 'Document not found');

    if (isDocOwner(doc, userId)) return { result: 'owner', docId: doc.id };
    if (isBannedFromDoc(doc, userId)) return { result: 'banned', docId: doc.id };
    if (findDocCollaborator(doc, userId)) return { result: 'already-collaborator', docId: doc.id };

    try {
        await db.docCollaborator.create({ data: { docId: doc.id, userId, role: link.role } });
    } catch (err) {
        if (isUniqueViolation(err)) return { result: 'already-collaborator', docId: doc.id };
        throw err;
    }
    return { result: 'joined', docId: doc.id };
}

/** Delete expired links, except those with a pending access request. Returns how many were removed. */
export async function deleteExpiredShareLinks(now: Date = new Date(), db: DbClient = prisma): Promise<number> {
    const { count } = await db.shareLink.deleteMany({
        where: { expiresAt: { lte: now }, accessRequests: { none: { status: 'pending' } } },
    });
    return count;
}

/**
 * Hourly cleanup of expired share links (Mongo had a TTL index). Meant to be started by
 * src/index.ts next to the other crons, never by the app (tests must not schedule it).
 */
export function startShareLinkCleanupCron() {
    const task = cron.schedule('17 * * * *', async () => {
        try {
            const removed = await deleteExpiredShareLinks();
            if (removed > 0) console.log(`🧹 Removed ${removed} expired share link(s)`);
        } catch (err) {
            console.error('Share link cleanup failed:', err);
        }
    });
    console.log('✓ Share link cleanup scheduled hourly.');
    return task;
}

// ─── Access requests ───────────────────────────────────────────────────

export interface Requester {
    id: string;
    name: string;
    email: string;
}

/**
 * POST /api/docs/:id/request-access. Returns 'already-pending' when a pending request exists,
 * otherwise creates the request (or resets an answered one to pending) and emails the owner.
 */
export async function requestDocAccess(
    docId: string,
    requester: Requester,
    shareLinkSlug: unknown
): Promise<'already-pending' | 'requested'> {
    // A missing slug must not reach the query: `slug: undefined` would match any link of the doc.
    if (typeof shareLinkSlug !== 'string' || !shareLinkSlug) {
        throw new ErrorResponse(404, 'Share link is invalid or expired');
    }
    const link = await prisma.shareLink.findFirst({ where: { slug: shareLinkSlug, docId, ...activeLinkWhere(new Date()) } });
    if (!link) throw new ErrorResponse(404, 'Share link is invalid or expired');

    const doc = await prisma.doc.findUnique({
        where: { id: docId },
        select: {
            id: true,
            title: true,
            userId: true,
            user: { select: userSummarySelect },
            collaborators: { where: { userId: requester.id }, select: { userId: true, role: true } },
            bannedUsers: { where: { userId: requester.id }, select: { userId: true } },
        },
    });
    if (!doc) throw new ErrorResponse(404, 'Document not found');
    if (isDocOwner(doc, requester.id)) throw new ErrorResponse(400, 'You are the owner of this document');
    if (findDocCollaborator(doc, requester.id)) throw new ErrorResponse(400, 'You are already a collaborator');
    if (isBannedFromDoc(doc, requester.id)) throw new ErrorResponse(403, 'Your access to this document has been revoked');

    const key = { userId_docId: { userId: requester.id, docId } };
    const existing = await prisma.accessRequest.findUnique({ where: key, select: { status: true } });
    if (existing?.status === 'pending') return 'already-pending';

    const request = await prisma.accessRequest.upsert({
        where: key,
        create: { userId: requester.id, docId, shareLinkId: link.id, role: link.role, status: 'pending' },
        update: { status: 'pending', shareLinkId: link.id, role: link.role, requestedAt: new Date(), respondedAt: null },
        select: { id: true },
    });

    sendAccessRequestEmail(
        { name: doc.user.name, email: doc.user.email },
        { name: requester.name, email: requester.email },
        doc.title,
        docId,
        request.id
    ).catch((err) => console.error('Failed to send access request email:', err));

    return 'requested';
}

async function assertDocOwner(docId: string, ownerId: string, message: string): Promise<{ id: string; title: string }> {
    const doc = await prisma.doc.findFirst({ where: { id: docId, userId: ownerId }, select: { id: true, title: true } });
    if (!doc) throw new ErrorResponse(403, message);
    return doc;
}

/** GET /api/docs/:id/requests (owner only): pending requests, newest first. */
export async function listPendingDocAccessRequests(docId: string, ownerId: string): Promise<AccessRequestRow[]> {
    await assertDocOwner(docId, ownerId, 'Only the document owner can view access requests');
    return prisma.accessRequest.findMany({
        where: { docId, status: 'pending' },
        include: accessRequestInclude,
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    });
}

/** GET /api/docs/pending-requests: pending requests on every doc the user owns, newest first. */
export function listPendingAccessRequestsForOwner(ownerId: string, db: DbClient = prisma): Promise<AccessRequestWithDocRow[]> {
    return db.accessRequest.findMany({
        where: { status: 'pending', doc: { userId: ownerId } },
        include: accessRequestWithDocInclude,
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    });
}

/**
 * POST /api/docs/:id/requests/:reqId/approve (owner only): the requester becomes a collaborator
 * with the requested role (an existing collaborator keeps theirs) and any ban on them is lifted.
 * The requester is emailed afterwards.
 */
export async function approveDocAccessRequest(docId: string, requestId: string, owner: { id: string; name: string }): Promise<void> {
    const doc = await assertDocOwner(docId, owner.id, 'Only the document owner can approve requests');

    const request = await prisma.accessRequest.findFirst({
        where: { id: requestId, docId, status: 'pending' },
        include: accessRequestInclude,
    });
    if (!request) throw new ErrorResponse(404, 'Access request not found or already processed');

    await prisma.$transaction(async (tx) => {
        // Claim it first, so two approvals of the same request can't both go through.
        const { count } = await tx.accessRequest.updateMany({
            where: { id: request.id, status: 'pending' },
            data: { status: 'approved', respondedAt: new Date() },
        });
        if (count === 0) throw new ErrorResponse(404, 'Access request not found or already processed');
        await tx.docCollaborator.upsert({
            where: { docId_userId: { docId, userId: request.userId } },
            create: { docId, userId: request.userId, role: request.role },
            update: {},
        });
        await tx.docBannedUser.deleteMany({ where: { docId, userId: request.userId } });
    });

    sendAccessApprovedEmail(
        { name: request.user.name, email: request.user.email },
        owner.name || 'The owner',
        doc.title,
        docId
    ).catch((err) => console.error('Failed to send approval email:', err));
}

/** POST /api/docs/:id/requests/:reqId/reject (owner only). */
export async function rejectDocAccessRequest(docId: string, requestId: string, ownerId: string): Promise<void> {
    await assertDocOwner(docId, ownerId, 'Only the document owner can reject requests');
    const { count } = await prisma.accessRequest.updateMany({
        where: { id: requestId, docId, status: 'pending' },
        data: { status: 'rejected', respondedAt: new Date() },
    });
    if (count === 0) throw new ErrorResponse(404, 'Access request not found or already processed');
}
