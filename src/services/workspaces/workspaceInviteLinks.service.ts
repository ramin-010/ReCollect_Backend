// Workspace invite links and join requests.
//
// Flow (unchanged): an admin generates a link (optionally for one space, optionally expiring);
// anyone can read its public info; a logged-in user "requests to join" through it, which sends an
// actionable 'workspace_join_request' notification to the owner and every admin and counts one use.
// Nobody joins until an admin approves: POST /api/notifications/:id/accept (approve: the requester
// becomes a member) or /decline (reject), in the notifications module (acceptNotification).
//
// Redone by hand: the token default (generateInviteToken), and the "max uses" check, which is now
// also enforced atomically when the use is counted.
import type { WorkspaceInviteLink } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { generateInviteToken } from '../../db/defaults';
import ErrorResponse from '../../utils/errorResponse';
import { createJoinRequestNotifications, findPendingJoinRequest } from './workspaceNotifications';
import { WORKSPACE_ADMIN_ROLES, requireWorkspaceAccess, requireWorkspaceRole } from './workspacePermissions';

const DAY_MS = 24 * 60 * 60 * 1000;

export const INVALID_INVITE_LINK = 'Invite link is invalid or has been revoked';
export const EXPIRED_INVITE_LINK = 'This invite link has expired';
export const USED_UP_INVITE_LINK = 'This invite link has reached its usage limit';

/** Not expired: no expiry, or expiresAt in the future. */
function notExpired(now: Date) {
    return [{ expiresAt: null }, { expiresAt: { gt: now } }];
}

type LinkState = Pick<WorkspaceInviteLink, 'isActive' | 'expiresAt' | 'maxUses' | 'useCount'>;

/** The old checks, in the old order: unknown/revoked → 404, expired → 410, used up → 410. */
function assertLinkUsable<T extends LinkState>(link: T | null): asserts link is T {
    if (!link || !link.isActive) {
        throw new ErrorResponse(404, INVALID_INVITE_LINK);
    }
    if (link.expiresAt && link.expiresAt < new Date()) {
        throw new ErrorResponse(410, EXPIRED_INVITE_LINK);
    }
    // `maxUses && …`: 0 / null mean unlimited, as before.
    if (link.maxUses && link.useCount >= link.maxUses) {
        throw new ErrorResponse(410, USED_UP_INVITE_LINK);
    }
}

/** `expiresInDays` → a date, as `new Date(Date.now() + days * 864e5)` did; falsy → never expires. */
function expiryFrom(expiresInDays: unknown, now: number): Date | null {
    if (!expiresInDays) return null;
    const date = new Date(now + Number(expiresInDays) * DAY_MS);
    if (Number.isNaN(date.getTime())) {
        // What Mongoose's cast error said (the error handler answered 400 with it).
        throw new ErrorResponse(400, 'Cast to date failed for value "Invalid Date" (type Date) at path "expiresAt"');
    }
    return date;
}

export interface InviteLinkSummary {
    token: string;
    expiresAt: Date | null;
    useCount: number;
}

/**
 * POST /api/workspaces/:id/invite-link (owner/admin). Returns the existing active, unexpired link
 * for the same workspace + space if there is one (`created: false`), else a new one.
 */
export async function generateInviteLink(
    workspaceId: string,
    userId: string,
    input: { spaceId?: unknown; expiresInDays?: unknown }
): Promise<{ created: boolean; link: InviteLinkSummary }> {
    const access = await requireWorkspaceAccess(workspaceId, userId);
    requireWorkspaceRole(access, WORKSPACE_ADMIN_ROLES, 'Only admins can generate invite links');

    let spaceId: string | null = null;
    if (input.spaceId) {
        const space =
            typeof input.spaceId === 'string'
                ? await prisma.space.findFirst({ where: { id: input.spaceId, workspaceId }, select: { id: true } })
                : null;
        if (!space) {
            throw new ErrorResponse(404, 'Space not found in this workspace');
        }
        spaceId = space.id;
    }

    const now = new Date();
    const existing = await prisma.workspaceInviteLink.findFirst({
        where: { workspaceId, spaceId, isActive: true, OR: notExpired(now) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (existing) {
        return { created: false, link: { token: existing.token, expiresAt: existing.expiresAt, useCount: existing.useCount } };
    }

    const link = await prisma.workspaceInviteLink.create({
        data: {
            workspaceId,
            spaceId,
            token: generateInviteToken(),
            createdById: userId,
            expiresAt: expiryFrom(input.expiresInDays, now.getTime()),
        },
    });
    return { created: true, link: { token: link.token, expiresAt: link.expiresAt, useCount: 0 } };
}

/** GET /api/workspaces/:id/invite-links (owner/admin): active, unexpired links, newest first. */
export async function listInviteLinks(workspaceId: string, userId: string): Promise<WorkspaceInviteLink[]> {
    const access = await requireWorkspaceAccess(workspaceId, userId);
    requireWorkspaceRole(access, WORKSPACE_ADMIN_ROLES, 'Only admins can view invite links');
    return prisma.workspaceInviteLink.findMany({
        where: { workspaceId, isActive: true, OR: notExpired(new Date()) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
}

/** DELETE /api/workspaces/:id/invite-link/:linkId (owner/admin): deactivate the link. */
export async function revokeInviteLink(workspaceId: string, userId: string, linkId: string): Promise<void> {
    const access = await requireWorkspaceAccess(workspaceId, userId);
    requireWorkspaceRole(access, WORKSPACE_ADMIN_ROLES, 'Only admins can revoke invite links');
    const { count } = await prisma.workspaceInviteLink.updateMany({
        where: { id: linkId, workspaceId },
        data: { isActive: false },
    });
    if (count === 0) {
        throw new ErrorResponse(404, 'Invite link not found');
    }
}

export interface InviteLinkInfo {
    workspaceName: string;
    spaceName: string | null;
    invitedBy: { name: string; avatar: string | null };
}

/** GET /api/workspaces/invite-link/:token/info (public, no auth): what the landing page shows. */
export async function getInviteLinkInfo(token: string): Promise<InviteLinkInfo> {
    const link = await prisma.workspaceInviteLink.findUnique({
        where: { token },
        include: {
            createdBy: { select: { name: true, avatar: true } },
            workspace: { select: { name: true } },
            space: { select: { name: true } },
        },
    });
    assertLinkUsable(link);
    return {
        workspaceName: link.workspace.name,
        spaceName: link.space?.name || null,
        invitedBy: { name: link.createdBy.name || 'Someone', avatar: link.createdBy.avatar || null },
    };
}

export interface JoinRequester {
    id: string;
    name: string | null | undefined;
    email: string | null | undefined;
    avatar: string | null | undefined;
}

/**
 * POST /api/workspaces/invite-link/:token/request. Sends one join request to the owner and each
 * admin and counts one use of the link, in one transaction. The requester is NOT added yet.
 */
export async function requestToJoinViaLink(token: string, requester: JoinRequester): Promise<void> {
    const link = await prisma.workspaceInviteLink.findUnique({
        where: { token },
        include: { space: { select: { name: true } } },
    });
    assertLinkUsable(link);

    const workspace = await prisma.workspace.findUnique({
        where: { id: link.workspaceId },
        select: {
            id: true,
            name: true,
            ownerId: true,
            members: { select: { userId: true, role: true }, orderBy: [{ joinedAt: 'asc' }, { userId: 'asc' }] },
        },
    });
    if (!workspace) {
        throw new ErrorResponse(404, 'Workspace no longer exists');
    }

    if (workspace.ownerId === requester.id || workspace.members.some((m) => m.userId === requester.id)) {
        throw new ErrorResponse(400, 'You are already a member of this workspace');
    }
    if (await findPendingJoinRequest(requester.id, workspace.id)) {
        throw new ErrorResponse(400, 'You already have a pending join request for this workspace');
    }

    // The owner and every admin, without duplicates (the owner is normally an admin member too).
    const recipientIds = [
        ...new Set([workspace.ownerId, ...workspace.members.filter((m) => m.role === 'admin').map((m) => m.userId)]),
    ];

    await prisma.$transaction(async (tx) => {
        // Count the use only while the link is still usable (closes the check-then-increment race).
        const counted = await tx.workspaceInviteLink.updateMany({
            where: {
                id: link.id,
                isActive: true,
                OR: [{ maxUses: null }, { maxUses: 0 }, { useCount: { lt: tx.workspaceInviteLink.fields.maxUses } }],
            },
            data: { useCount: { increment: 1 } },
        });
        if (counted.count === 0) {
            throw new ErrorResponse(410, USED_UP_INVITE_LINK);
        }
        await createJoinRequestNotifications(
            {
                recipientIds,
                requester,
                workspaceId: workspace.id,
                workspaceName: workspace.name,
                spaceId: link.spaceId,
                spaceSuffix: link.space ? ` (${link.space.name})` : '',
                inviteLinkId: link.id,
            },
            tx
        );
    });
}
