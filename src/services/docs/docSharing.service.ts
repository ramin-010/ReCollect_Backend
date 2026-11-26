// Sharing, rebuilt (MANAGER_AND_DOCS_PLAN §2, 2026-11-15): Notion's two ideas and nothing else.
//
//   1. Publish: one switch. Anyone with /p/<slug> reads the doc (no login, never edit). The slug is
//      stable until he switches it off; switching on again makes a new one. A trashed doc is never shown.
//   2. People: named access by email ("can view" / "can edit"; they need an account). A logged-in reader
//      of a published doc can ask to edit; he answers in the Share popover (a notification + an email).
//
// Gone with ShareLink and DocBannedUser: expiring links, editor links, joining by a link, bans (a
// removed person can ask again, and he can decline). Every change to someone's access reaches their
// open editor at once (D6): a new role reconnects them with it; removal closes their connection.
//
//   PUT    /api/docs/:id/publish { on }            owner              → { published }
//   GET    /api/public/docs/:slug                  anyone             → the doc, read-only (readPublishedDoc)
//   POST   /api/public/docs/:slug/request          a logged-in reader → asks to edit
//   GET    /api/docs/:id/people                    owner, people      → DocPeopleJson (requests: owner only)
//   POST   /api/docs/:id/people { email, role }    owner              → DocPeopleJson
//   PATCH  /api/docs/:id/people/:userId { role }   owner              → DocPeopleJson
//   DELETE /api/docs/:id/people/:userId            owner, or oneself  → DocPeopleJson | { left: true }
//   POST   /api/docs/:id/requests/:reqId/approve   owner              → DocPeopleJson (they can edit)
//   POST   /api/docs/:id/requests/:reqId/decline   owner              → DocPeopleJson
import { randomBytes } from 'crypto';
import * as Y from 'yjs';
import type { CollaboratorRole } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { userSummarySelect, serializeUserSummary } from '../../db/serializers/user';
import {
    docPersonSelect,
    docRequestSelect,
    serializeDocPerson,
    serializeDocRequest,
    type DocPeopleJson,
    type PublishedJson,
} from '../../db/serializers/docSharing';
import { docCollaboratorOrder } from '../../db/serializers/doc';
import ErrorResponse from '../../utils/errorResponse';
import { LearningHttpError } from '../learning/http';
import { sendDocRequestEmail, sendDocSharedEmail, sendRequestApprovedEmail } from '../../utils/emailService';
import { disconnectUser, refreshUserAccess } from '../../collaboration/hocuspocus';
import { isDeliverableEmail } from '../learning/nudge';
import { createNotification } from '../notifications/notifications.service';
import { liveDocument } from '../agent/liveDoc';
import { publicDocState } from './blocks/publicState';
import { accessibleDocWhere, getDocRole, isDocOwner } from './docPermissions';

export type ShareRole = CollaboratorRole;
export const SHARE_ROLES: readonly ShareRole[] = ['viewer', 'editor'];

export const NOTIFY_DOC_REQUEST = 'doc_access_request';
export const NOTIFY_DOC_SHARED = 'doc_shared';
export const NOTIFY_DOC_APPROVED = 'doc_access_approved';

const appUrl = () => (process.env.FRONTEND_URL || 'http://localhost:3005').replace(/\/+$/, '');

/** The public page of a published doc. */
export function publicUrl(slug: string): string {
    return `${appUrl()}/p/${slug}`;
}

const SLUG_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789';

/**
 * "Caching, part 2" → "caching-part-2-k7m2x9q4hz3a": the title's first words (so the link says what
 * it is) and 12 random characters (about 60 bits; the slug is the only key to the page).
 */
export function newPublicSlug(title: string): string {
    let words = title
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (words.length > 40) {
        const head = words.slice(0, 41);
        const cut = head.lastIndexOf('-');
        words = (cut > 0 ? head.slice(0, cut) : head.slice(0, 40)).replace(/-+$/g, '');
    }
    const bytes = randomBytes(12);
    let tail = '';
    for (const b of bytes) tail += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
    return words ? `${words}-${tail}` : tail;
}

/** A slug we could have made (anything else is not looked up). */
export function isPublicSlug(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z0-9-]{12,60}$/.test(value);
}

function published(doc: { publicSlug: string | null; publishedAt: Date | null }): PublishedJson | null {
    return doc.publicSlug && doc.publishedAt ? { url: publicUrl(doc.publicSlug), slug: doc.publicSlug, since: doc.publishedAt } : null;
}

const notFound = () => new ErrorResponse(404, 'Doc not found');

async function ownedDoc(docId: string, ownerId: string) {
    const doc = await prisma.doc.findFirst({
        where: { id: docId, ...accessibleDocWhere(ownerId) },
        select: { id: true, title: true, userId: true, trashedAt: true, publicSlug: true, publishedAt: true, user: { select: { name: true } } },
    });
    if (!doc) throw notFound();
    if (!isDocOwner(doc, ownerId)) throw new ErrorResponse(403, 'Only the owner can change who has this doc');
    return doc;
}

const titleOf = (doc: { title: string }) => doc.title.trim() || 'Untitled';

// ─── Publish ───────────────────────────────────────────────────────────

/**
 * Publish or unpublish (owner only). On: the doc's link (the same one when it is already on). Off:
 * the link stops working. `updatedAt` stays (raw SQL), so the library's order doesn't move.
 */
export async function setDocPublished(ownerId: string, docId: string, on: boolean, now: Date = new Date()): Promise<PublishedJson | null> {
    const doc = await ownedDoc(docId, ownerId);
    if (!on) {
        if (doc.publicSlug) await prisma.$executeRaw`UPDATE "Doc" SET "publicSlug" = NULL, "publishedAt" = NULL WHERE "id" = ${docId}`;
        return null;
    }
    if (doc.trashedAt) throw new ErrorResponse(409, 'This doc is in the trash. Restore it to publish it.');
    if (doc.publicSlug) return published(doc);
    const slug = newPublicSlug(titleOf(doc));
    await prisma.$executeRaw`UPDATE "Doc" SET "publicSlug" = ${slug}, "publishedAt" = ${now} WHERE "id" = ${docId} AND "publicSlug" IS NULL`;
    const after = await prisma.doc.findUniqueOrThrow({ where: { id: docId }, select: { publicSlug: true, publishedAt: true } });
    return published(after);
}

// ─── The public page ───────────────────────────────────────────────────

/**
 * What the reader may do besides reading: 'anonymous' (not logged in), 'none' (may ask to edit),
 * 'requested' (asked, waiting), or their own access in the app.
 */
export type PublicAccess = 'anonymous' | 'none' | 'requested' | 'owner' | 'editor' | 'viewer';

export interface PublicDocJson {
    title: string;
    coverImage: string | null;
    updatedAt: Date;
    publishedAt: Date;
    owner: { name: string };
    /** The page's Y.Doc (blocks + their boards; ./blocks/publicState.ts), base64. */
    state: string;
    access: PublicAccess;
    /** Only for someone who has the doc in the app ("Open in Kaaga"). */
    docId: string | null;
}

/** GET /api/public/docs/:slug: a published doc as anyone reads it. A trashed or unpublished doc is 404. */
export async function readPublishedDoc(slug: string, viewerId: string | null): Promise<PublicDocJson> {
    if (!isPublicSlug(slug)) throw new ErrorResponse(404, 'This page is not published');
    const doc = await prisma.doc.findFirst({
        where: { publicSlug: slug, trashedAt: null },
        select: { id: true, title: true, coverImage: true, updatedAt: true, publishedAt: true, yjsState: true, userId: true, user: { select: { name: true } } },
    });
    if (!doc || !doc.publishedAt) throw new ErrorResponse(404, 'This page is not published');

    // The live doc when an editor has it open (what he sees now), else the stored state.
    const live = liveDocument(doc.id);
    const ydoc = live ?? new Y.Doc();
    let state: Uint8Array;
    let title = doc.title;
    let coverImage = doc.coverImage;
    try {
        if (!live && doc.yjsState) Y.applyUpdate(ydoc, doc.yjsState);
        state = publicDocState(ydoc);
        const meta = ydoc.getMap('metadata');
        const metaTitle = meta.get('title');
        if (typeof metaTitle === 'string' && metaTitle.trim()) title = metaTitle;
        const metaCover = meta.get('coverImage');
        if (metaCover !== undefined) coverImage = typeof metaCover === 'string' && metaCover ? metaCover : null;
    } finally {
        if (!live) ydoc.destroy();
    }

    return {
        title: title.trim() || 'Untitled',
        coverImage,
        updatedAt: doc.updatedAt,
        publishedAt: doc.publishedAt,
        owner: { name: doc.user.name },
        state: Buffer.from(state).toString('base64'),
        ...(await readerAccess(doc, viewerId)),
    };
}

async function readerAccess(doc: { id: string; userId: string }, viewerId: string | null): Promise<{ access: PublicAccess; docId: string | null }> {
    if (!viewerId) return { access: 'anonymous', docId: null };
    if (doc.userId === viewerId) return { access: 'owner', docId: doc.id };
    const [person, request] = await Promise.all([
        prisma.docCollaborator.findUnique({ where: { docId_userId: { docId: doc.id, userId: viewerId } }, select: { role: true } }),
        prisma.accessRequest.findUnique({ where: { userId_docId: { userId: viewerId, docId: doc.id } }, select: { status: true } }),
    ]);
    if (person?.role === 'editor') return { access: 'editor', docId: doc.id };
    if (request?.status === 'pending') return { access: 'requested', docId: person ? doc.id : null };
    if (person) return { access: 'viewer', docId: doc.id };
    return { access: 'none', docId: null };
}

// ─── People ────────────────────────────────────────────────────────────

/** GET /api/docs/:id/people: the owner, the people with their roles, pending requests (owner only), the link. */
export async function docPeople(docId: string, userId: string): Promise<DocPeopleJson> {
    const doc = await prisma.doc.findFirst({
        where: { id: docId, ...accessibleDocWhere(userId) },
        select: {
            id: true,
            title: true,
            userId: true,
            publicSlug: true,
            publishedAt: true,
            user: { select: userSummarySelect },
            collaborators: { select: docPersonSelect, orderBy: docCollaboratorOrder },
        },
    });
    if (!doc) throw notFound();
    const you = getDocRole(doc, userId);
    if (!you) throw notFound();
    const requests =
        you === 'owner'
            ? await prisma.accessRequest.findMany({ where: { docId, status: 'pending' }, select: docRequestSelect, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] })
            : [];
    return {
        docId: doc.id,
        title: titleOf(doc),
        owner: serializeUserSummary(doc.user),
        you,
        people: doc.collaborators.map(serializeDocPerson),
        requests: requests.map(serializeDocRequest),
        published: published(doc),
    };
}

function assertRole(role: unknown): ShareRole {
    if (role !== 'editor' && role !== 'viewer') throw new ErrorResponse(400, 'The role is "viewer" (can view) or "editor" (can edit)');
    return role;
}

const ROLE_WORDS: Record<ShareRole, string> = { editor: 'can edit', viewer: 'can view' };

/**
 * POST /api/docs/:id/people (owner): add someone by their account's email, or change the role of
 * someone already added (`already`). A pending request of theirs is answered by it.
 */
export async function addDocPerson(
    ownerId: string,
    docId: string,
    input: { email: unknown; role: unknown }
): Promise<{ people: DocPeopleJson; already: boolean; name: string }> {
    const email = typeof input.email === 'string' ? input.email.trim() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new ErrorResponse(400, 'Write their email address');
    const role = assertRole(input.role ?? 'editor');
    const doc = await ownedDoc(docId, ownerId);
    const person = await prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' }, isGhost: false },
        select: { id: true, name: true, email: true },
    });
    if (!person) throw new LearningHttpError(404, 'NO_ACCOUNT', 'No Kaaga account uses that email. They need to sign up first.');
    if (person.id === ownerId) throw new ErrorResponse(400, 'That is you: you own this doc');

    const before = await prisma.docCollaborator.findUnique({ where: { docId_userId: { docId, userId: person.id } }, select: { role: true } });
    await prisma.$transaction(async (tx) => {
        await tx.docCollaborator.upsert({
            where: { docId_userId: { docId, userId: person.id } },
            create: { docId, userId: person.id, role },
            update: { role },
        });
        await tx.accessRequest.updateMany({ where: { docId, userId: person.id, status: 'pending' }, data: { status: 'approved', respondedAt: new Date() } });
    });
    if (before && before.role !== role) refreshUserAccess(docId, person.id);
    if (!before) await tellShared(person, doc, ownerId, role);
    return { people: await docPeople(docId, ownerId), already: !!before, name: person.name };
}

async function tellShared(person: { id: string; name: string; email: string }, doc: { id: string; title: string; user: { name: string } }, ownerId: string, role: ShareRole) {
    const title = titleOf(doc);
    await createNotification({
        recipientId: person.id,
        senderId: ownerId,
        category: 'informational',
        type: NOTIFY_DOC_SHARED,
        title: `${doc.user.name} shared "${title}" with you`,
        message: `You ${ROLE_WORDS[role]}. It is in your Docs, under Shared.`,
        metadata: { docId: doc.id, url: `/docs/${doc.id}` },
    });
    if (isDeliverableEmail(person.email))
        sendDocSharedEmail(person, doc.user.name, title, doc.id, ROLE_WORDS[role]).catch((err) => console.error('Failed to send the shared-doc email:', err));
}

/** PATCH /api/docs/:id/people/:userId (owner). Their open editor reconnects with the new role. */
export async function changeDocPersonRole(ownerId: string, docId: string, personId: string, role: unknown): Promise<DocPeopleJson> {
    const next = assertRole(role);
    await ownedDoc(docId, ownerId);
    const { count } = await prisma.docCollaborator.updateMany({ where: { docId, userId: personId }, data: { role: next } });
    if (count === 0) throw new ErrorResponse(404, 'They are not on this doc');
    refreshUserAccess(docId, personId);
    return docPeople(docId, ownerId);
}

/**
 * DELETE /api/docs/:id/people/:userId: the owner removes someone, or someone leaves. Their live
 * connection closes at once. No ban: they may ask again (and he may decline).
 */
export async function removeDocPerson(actorId: string, docId: string, personId: string): Promise<DocPeopleJson | { left: true }> {
    const doc = await prisma.doc.findFirst({
        where: { id: docId, ...accessibleDocWhere(actorId) },
        select: { id: true, userId: true, collaborators: { select: { userId: true } } },
    });
    if (!doc) throw notFound();
    const leaving = personId === actorId;
    if (!leaving && !isDocOwner(doc, actorId)) throw new ErrorResponse(403, 'Only the owner can remove people');
    if (personId === doc.userId) throw new ErrorResponse(400, 'The owner stays on the doc');
    const { count } = await prisma.docCollaborator.deleteMany({ where: { docId, userId: personId } });
    if (count === 0) throw new ErrorResponse(404, 'They are not on this doc');
    disconnectUser(docId, personId, Math.max(0, doc.collaborators.length - 1), leaving, actorId);
    return leaving ? { left: true } : docPeople(docId, actorId);
}

// ─── Requests ──────────────────────────────────────────────────────────

export interface Requester {
    id: string;
    name: string;
    email: string;
}

/**
 * POST /api/public/docs/:slug/request: a logged-in reader of a published doc asks to edit it (a
 * viewer may ask too). One request per person and doc: asking again reopens an answered one.
 */
export async function requestToEdit(slug: string, requester: Requester): Promise<'requested' | 'already-pending'> {
    if (!isPublicSlug(slug)) throw new ErrorResponse(404, 'This page is not published');
    const doc = await prisma.doc.findFirst({
        where: { publicSlug: slug, trashedAt: null },
        select: { id: true, title: true, userId: true, user: { select: { id: true, name: true, email: true } } },
    });
    if (!doc) throw new ErrorResponse(404, 'This page is not published');
    if (doc.userId === requester.id) throw new ErrorResponse(400, 'You own this doc');
    const person = await prisma.docCollaborator.findUnique({ where: { docId_userId: { docId: doc.id, userId: requester.id } }, select: { role: true } });
    if (person?.role === 'editor') throw new ErrorResponse(400, 'You can already edit this doc');

    const key = { userId_docId: { userId: requester.id, docId: doc.id } };
    const existing = await prisma.accessRequest.findUnique({ where: key, select: { status: true } });
    if (existing?.status === 'pending') return 'already-pending';
    const request = await prisma.accessRequest.upsert({
        where: key,
        create: { userId: requester.id, docId: doc.id, role: 'editor', status: 'pending' },
        update: { status: 'pending', role: 'editor', requestedAt: new Date(), respondedAt: null },
        select: { id: true },
    });

    const title = titleOf(doc);
    await createNotification({
        recipientId: doc.userId,
        senderId: requester.id,
        category: 'informational',
        type: NOTIFY_DOC_REQUEST,
        title: `${requester.name} asks to edit "${title}"`,
        message: `${requester.email} · answer in the doc's Share menu`,
        metadata: { docId: doc.id, requestId: request.id, url: `/docs/${doc.id}?share=1` },
    });
    if (isDeliverableEmail(doc.user.email))
        sendDocRequestEmail(doc.user, requester, title, doc.id).catch((err) => console.error('Failed to send the request email:', err));
    return 'requested';
}

/**
 * POST /api/docs/:id/requests/:reqId/approve|decline (owner). Approve: they can edit (a viewer
 * becomes an editor, reconnected at once), with a notification and an email. Decline: nothing is
 * sent; they may ask again.
 */
export async function answerDocRequest(ownerId: string, docId: string, requestId: string, answer: 'approve' | 'decline'): Promise<DocPeopleJson> {
    const doc = await ownedDoc(docId, ownerId);
    const request = await prisma.accessRequest.findFirst({
        where: { id: requestId, docId, status: 'pending' },
        select: { id: true, userId: true, user: { select: { id: true, name: true, email: true } } },
    });
    if (!request) throw new ErrorResponse(404, 'This request was answered already');

    const status = answer === 'approve' ? 'approved' : 'rejected';
    let promoted = false;
    await prisma.$transaction(async (tx) => {
        // Claim it first, so two answers can't both go through.
        const { count } = await tx.accessRequest.updateMany({ where: { id: request.id, status: 'pending' }, data: { status, respondedAt: new Date() } });
        if (count === 0) throw new ErrorResponse(404, 'This request was answered already');
        if (answer === 'approve') {
            const before = await tx.docCollaborator.findUnique({ where: { docId_userId: { docId, userId: request.userId } }, select: { role: true } });
            promoted = !!before;
            await tx.docCollaborator.upsert({
                where: { docId_userId: { docId, userId: request.userId } },
                create: { docId, userId: request.userId, role: 'editor' },
                update: { role: 'editor' },
            });
        }
        // His notification about it is answered too.
        await tx.notification.updateMany({
            where: { recipientId: ownerId, type: NOTIFY_DOC_REQUEST, metadata: { path: ['requestId'], equals: request.id } },
            data: { isRead: true, status: answer === 'approve' ? 'accepted' : 'declined' },
        });
    });

    if (answer === 'approve') {
        if (promoted) refreshUserAccess(docId, request.userId);
        const title = titleOf(doc);
        await createNotification({
            recipientId: request.userId,
            senderId: ownerId,
            category: 'informational',
            type: NOTIFY_DOC_APPROVED,
            title: `You can edit "${title}"`,
            message: `${doc.user.name} said yes. It is in your Docs, under Shared.`,
            metadata: { docId, url: `/docs/${docId}` },
        });
        if (isDeliverableEmail(request.user.email))
            sendRequestApprovedEmail(request.user, doc.user.name, title, docId).catch((err) => console.error('Failed to send the approval email:', err));
    }
    return docPeople(docId, ownerId);
}

// ─── For agents and the manager (read only; publishing and adding people need his tap) ──────

export interface DocSharingForAgent {
    _id: string;
    title: string;
    published: { url: string; since: string } | null;
    people: Array<{ name: string; role: ShareRole; addedAt: string }>;
    requests: Array<{ name: string; requestedAt: string }>;
}

/** GET /api/agent/docs/:id/sharing (his own docs only). */
export async function docSharingForAgent(userId: string, docId: string): Promise<DocSharingForAgent> {
    const doc = await prisma.doc.findFirst({ where: { id: docId, userId }, select: { id: true } });
    if (!doc) throw notFound();
    const p = await docPeople(docId, userId);
    return {
        _id: p.docId,
        title: p.title,
        published: p.published ? { url: p.published.url, since: p.published.since.toISOString() } : null,
        people: p.people.map((x) => ({ name: x.name, role: x.role, addedAt: x.addedAt.toISOString() })),
        requests: p.requests.map((r) => ({ name: r.user.name, requestedAt: r.requestedAt.toISOString() })),
    };
}

/** The words of a level-3 card (MANAGER_AND_DOCS_PLAN §3.2), checked now: what "Do it" will do. */
export async function describeShareAction(
    userId: string,
    input: { docId: string } & ({ kind: 'publish'; on: boolean } | { kind: 'person'; email: string; role: ShareRole | 'remove' })
): Promise<string> {
    const doc = await ownedDoc(input.docId, userId);
    const title = `"${titleOf(doc)}"`;
    if (input.kind === 'publish') {
        if (input.on && doc.trashedAt) throw new ErrorResponse(409, 'This doc is in the trash. Restore it to publish it.');
        if (input.on) return doc.publicSlug ? `${title} is published already` : `Publish ${title} to the web: anyone with the link can read it (never edit)`;
        if (!doc.publicSlug) throw new LearningHttpError(400, 'NOTHING_TO_DO', `${title} is not published`);
        return `Stop publishing ${title}: its link stops working`;
    }
    const person = await prisma.user.findFirst({ where: { email: { equals: input.email.trim(), mode: 'insensitive' }, isGhost: false }, select: { id: true, name: true } });
    if (!person) throw new LearningHttpError(404, 'NO_ACCOUNT', 'No Kaaga account uses that email. They need to sign up first.');
    if (person.id === userId) throw new ErrorResponse(400, 'That is him: he owns this doc');
    if (input.role === 'remove') return `Remove ${person.name} from ${title}`;
    return `Share ${title} with ${person.name} (${input.email.trim()}): they ${ROLE_WORDS[input.role]}`;
}

/** Runs a share action on his tap; says what happened. */
export async function runShareAction(
    userId: string,
    input: { docId: string } & ({ kind: 'publish'; on: boolean } | { kind: 'person'; email: string; role: ShareRole | 'remove' })
): Promise<string> {
    if (input.kind === 'publish') {
        const link = await setDocPublished(userId, input.docId, input.on);
        return link ? `Published: ${link.url}` : 'Not published any more';
    }
    if (input.role === 'remove') {
        const person = await prisma.user.findFirst({ where: { email: { equals: input.email.trim(), mode: 'insensitive' } }, select: { id: true, name: true } });
        if (!person) throw new ErrorResponse(404, 'No Kaaga account uses that email');
        await removeDocPerson(userId, input.docId, person.id);
        return `Removed ${person.name}`;
    }
    const { name, already } = await addDocPerson(userId, input.docId, { email: input.email, role: input.role });
    return already ? `${name} ${ROLE_WORDS[input.role]} now` : `Shared with ${name}: they ${ROLE_WORDS[input.role]}`;
}
