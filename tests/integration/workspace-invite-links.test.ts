// Workspace invite links and join requests on Postgres, end to end: request to join through a link,
// then an admin approves or rejects it through the notification accept/decline endpoints (and the
// same for a direct invite from POST /api/workspaces/:id/members).
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Prisma } from '@prisma/client';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { authCookie, createTestUser } from '../helpers/auth';
import { createRoleFixture } from '../helpers/workspaces';

const DAY = 24 * 60 * 60 * 1000;

async function newLink(
    workspace: { id: string },
    creator: { id: string },
    data: Partial<Prisma.WorkspaceInviteLinkUncheckedCreateInput> = {}
) {
    return prisma.workspaceInviteLink.create({
        data: { workspaceId: workspace.id, createdById: creator.id, token: `t-${Math.random().toString(36).slice(2)}`, ...data },
    });
}

describe('POST /api/workspaces/:id/invite-link', () => {
    it('generates a token (201), then returns the same active link (200)', async () => {
        const { workspace, admin } = await createRoleFixture();
        const first = await request(app).post(`/api/workspaces/${workspace.id}/invite-link`).set('Cookie', authCookie(admin)).send({});
        expect(first.status).toBe(201);
        expect(first.body).toEqual({
            success: true,
            data: { token: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/), expiresAt: null, useCount: 0 },
            message: 'Invite link generated',
        });

        const second = await request(app).post(`/api/workspaces/${workspace.id}/invite-link`).set('Cookie', authCookie(admin));
        expect(second.status).toBe(200);
        expect(second.body).toEqual({
            success: true,
            data: { token: first.body.data.token, expiresAt: null, useCount: 0 },
            message: 'Existing invite link returned',
        });
        const row = await prisma.workspaceInviteLink.findUniqueOrThrow({ where: { token: first.body.data.token } });
        expect(row).toMatchObject({ workspaceId: workspace.id, spaceId: null, createdById: admin.id, isActive: true, maxUses: null });
    });

    it('makes one link per space, validates the space, and sets expiresAt from expiresInDays', async () => {
        const { workspace, owner } = await createRoleFixture();
        const spaceId = workspace.spaceIds[0]!;
        const forSpace = await request(app)
            .post(`/api/workspaces/${workspace.id}/invite-link`)
            .set('Cookie', authCookie(owner))
            .send({ spaceId, expiresInDays: 7 });
        expect(forSpace.status).toBe(201);
        const expiresAt = new Date(forSpace.body.data.expiresAt).getTime();
        expect(Math.abs(expiresAt - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
        expect((await prisma.workspaceInviteLink.findUniqueOrThrow({ where: { token: forSpace.body.data.token } })).spaceId).toBe(spaceId);

        const general = await request(app).post(`/api/workspaces/${workspace.id}/invite-link`).set('Cookie', authCookie(owner)).send({});
        expect(general.status).toBe(201);
        expect(general.body.data.token).not.toBe(forSpace.body.data.token);

        const other = await createRoleFixture();
        const foreignSpace = await request(app)
            .post(`/api/workspaces/${workspace.id}/invite-link`)
            .set('Cookie', authCookie(owner))
            .send({ spaceId: other.workspace.spaceIds[0] });
        expect(foreignSpace.status).toBe(404);
        expect(foreignSpace.body).toEqual({ message: 'Space not found in this workspace' });

        // The space already has an active link, so it is returned before expiresInDays is looked at (as before).
        const existing = await request(app)
            .post(`/api/workspaces/${workspace.id}/invite-link`)
            .set('Cookie', authCookie(owner))
            .send({ spaceId, expiresInDays: 'soon' });
        expect(existing.status).toBe(200);

        // A new link with a non-numeric expiry: Mongoose's cast error message, 400.
        const freshSpace = await prisma.space.create({ data: { workspaceId: workspace.id, name: 'Fresh' } });
        const badExpiry = await request(app)
            .post(`/api/workspaces/${workspace.id}/invite-link`)
            .set('Cookie', authCookie(owner))
            .send({ spaceId: freshSpace.id, expiresInDays: 'soon' });
        expect(badExpiry.status).toBe(400);
        expect(badExpiry.body).toEqual({ message: 'Cast to date failed for value "Invalid Date" (type Date) at path "expiresAt"' });
    });

    it('does not reuse expired or revoked links', async () => {
        const { workspace, owner } = await createRoleFixture();
        await newLink(workspace, owner, { expiresAt: new Date(Date.now() - 1000) });
        await newLink(workspace, owner, { isActive: false });
        const res = await request(app).post(`/api/workspaces/${workspace.id}/invite-link`).set('Cookie', authCookie(owner)).send({});
        expect(res.status).toBe(201);
    });

    it('403 for members, viewers and outsiders; 404 for unknown workspaces', async () => {
        const { workspace, member, viewer, outsider } = await createRoleFixture();
        for (const user of [member, viewer, outsider]) {
            const res = await request(app).post(`/api/workspaces/${workspace.id}/invite-link`).set('Cookie', authCookie(user)).send({});
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ message: 'Only admins can generate invite links' });
        }
        const missing = await request(app).post('/api/workspaces/missing/invite-link').set('Cookie', authCookie(member)).send({});
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ message: 'Workspace not found' });
    });
});

describe('GET /api/workspaces/:id/invite-links', () => {
    it('lists active, unexpired links, newest first, in the old shape', async () => {
        const { workspace, owner, member } = await createRoleFixture();
        const older = await newLink(workspace, owner, { createdAt: new Date(Date.now() - 5000) });
        const newer = await newLink(workspace, owner, { spaceId: workspace.spaceIds[0]!, expiresAt: new Date(Date.now() + DAY) });
        await newLink(workspace, owner, { isActive: false });
        await newLink(workspace, owner, { expiresAt: new Date(Date.now() - 1000) });

        const res = await request(app).get(`/api/workspaces/${workspace.id}/invite-links`).set('Cookie', authCookie(owner));
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual([
            {
                _id: newer.id,
                token: newer.token,
                spaceId: workspace.spaceIds[0],
                expiresAt: newer.expiresAt!.toISOString(),
                useCount: 0,
                createdAt: newer.createdAt.toISOString(),
            },
            { _id: older.id, token: older.token, spaceId: null, expiresAt: null, useCount: 0, createdAt: older.createdAt.toISOString() },
        ]);

        const forbidden = await request(app).get(`/api/workspaces/${workspace.id}/invite-links`).set('Cookie', authCookie(member));
        expect(forbidden.status).toBe(403);
        expect(forbidden.body).toEqual({ message: 'Only admins can view invite links' });
    });
});

describe('DELETE /api/workspaces/:id/invite-link/:linkId', () => {
    it('deactivates the link; 404 for a link of another workspace; 403 for non-admins', async () => {
        const { workspace, admin, member } = await createRoleFixture();
        const link = await newLink(workspace, admin);
        const other = await createRoleFixture();
        const foreign = await newLink(other.workspace, other.owner);

        const forbidden = await request(app).delete(`/api/workspaces/${workspace.id}/invite-link/${link.id}`).set('Cookie', authCookie(member));
        expect(forbidden.status).toBe(403);
        expect(forbidden.body).toEqual({ message: 'Only admins can revoke invite links' });

        const res = await request(app).delete(`/api/workspaces/${workspace.id}/invite-link/${link.id}`).set('Cookie', authCookie(admin));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Invite link revoked' });
        expect((await prisma.workspaceInviteLink.findUniqueOrThrow({ where: { id: link.id } })).isActive).toBe(false);

        const wrongWorkspace = await request(app)
            .delete(`/api/workspaces/${workspace.id}/invite-link/${foreign.id}`)
            .set('Cookie', authCookie(admin));
        expect(wrongWorkspace.status).toBe(404);
        expect(wrongWorkspace.body).toEqual({ message: 'Invite link not found' });
        expect((await prisma.workspaceInviteLink.findUniqueOrThrow({ where: { id: foreign.id } })).isActive).toBe(true);
    });
});

describe('GET /api/workspaces/invite-link/:token/info (public)', () => {
    it('works without a cookie and returns workspace, space and inviter', async () => {
        const { workspace, owner } = await createRoleFixture();
        await prisma.user.update({ where: { id: owner.id }, data: { avatar: 'https://cdn.example.test/owner.png' } });
        const general = await newLink(workspace, owner);
        const forSpace = await newLink(workspace, owner, { spaceId: workspace.spaceIds[0]! });

        const res = await request(app).get(`/api/workspaces/invite-link/${general.token}/info`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            data: {
                workspaceName: workspace.name,
                spaceName: null,
                invitedBy: { name: 'Owner', avatar: 'https://cdn.example.test/owner.png' },
            },
        });

        const spaceRes = await request(app).get(`/api/workspaces/invite-link/${forSpace.token}/info`);
        expect(spaceRes.body.data.spaceName).toBe('Team 1');
    });

    it('an empty avatar is null; 404 unknown or revoked, 410 expired or used up', async () => {
        const { workspace, admin } = await createRoleFixture();
        const ok = await newLink(workspace, admin);
        expect((await request(app).get(`/api/workspaces/invite-link/${ok.token}/info`)).body.data.invitedBy).toEqual({ name: 'Admin', avatar: null });

        const unknown = await request(app).get('/api/workspaces/invite-link/nope/info');
        expect(unknown.status).toBe(404);
        expect(unknown.body).toEqual({ message: 'Invite link is invalid or has been revoked' });

        const revoked = await newLink(workspace, admin, { isActive: false });
        expect((await request(app).get(`/api/workspaces/invite-link/${revoked.token}/info`)).status).toBe(404);

        const expired = await newLink(workspace, admin, { expiresAt: new Date(Date.now() - 1000) });
        const expiredRes = await request(app).get(`/api/workspaces/invite-link/${expired.token}/info`);
        expect(expiredRes.status).toBe(410);
        expect(expiredRes.body).toEqual({ message: 'This invite link has expired' });

        const usedUp = await newLink(workspace, admin, { maxUses: 2, useCount: 2 });
        const usedUpRes = await request(app).get(`/api/workspaces/invite-link/${usedUp.token}/info`);
        expect(usedUpRes.status).toBe(410);
        expect(usedUpRes.body).toEqual({ message: 'This invite link has reached its usage limit' });
    });
});

describe('POST /api/workspaces/invite-link/:token/request (join request)', () => {
    it('notifies the owner and every admin (once each), counts a use, and adds nobody yet', async () => {
        const { workspace, owner, admin, member } = await createRoleFixture();
        const link = await newLink(workspace, admin, { spaceId: workspace.spaceIds[0]! });
        const requester = await createTestUser({ name: 'Requester', email: 'requester@example.test' });

        const res = await request(app).post(`/api/workspaces/invite-link/${link.token}/request`).set('Cookie', authCookie(requester));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: "Your request has been sent to the workspace admins. You'll be notified once approved.",
        });

        const requests = await prisma.notification.findMany({ where: { type: 'workspace_join_request', senderId: requester.id } });
        expect(requests.map((n) => n.recipientId).sort()).toEqual([owner.id, admin.id].sort());
        expect(requests.map((n) => n.recipientId)).not.toContain(member.id);
        expect(requests[0]).toMatchObject({
            category: 'actionable',
            title: 'Join Request',
            message: `Requester wants to join "${workspace.name}" (Team 1)`,
            status: 'pending',
            metadata: {
                workspaceId: workspace.id,
                workspaceName: workspace.name,
                spaceId: workspace.spaceIds[0],
                inviteLinkId: link.id,
                requesterName: 'Requester',
                requesterEmail: 'requester@example.test',
                requesterAvatar: null,
            },
        });
        expect((await prisma.workspaceInviteLink.findUniqueOrThrow({ where: { id: link.id } })).useCount).toBe(1);
        expect(await prisma.workspaceMember.count({ where: { workspaceId: workspace.id, userId: requester.id } })).toBe(0);

        const again = await request(app).post(`/api/workspaces/invite-link/${link.token}/request`).set('Cookie', authCookie(requester));
        expect(again.status).toBe(400);
        expect(again.body).toEqual({ message: 'You already have a pending join request for this workspace' });
    });

    it('rejects members, bad links, and enforces maxUses', async () => {
        const { workspace, owner, viewer } = await createRoleFixture();
        const link = await newLink(workspace, owner);
        const join = (user: { id: string }, token: string) =>
            request(app).post(`/api/workspaces/invite-link/${token}/request`).set('Cookie', authCookie(user));

        for (const user of [owner, viewer]) {
            const res = await join(user, link.token);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ message: 'You are already a member of this workspace' });
        }
        expect((await join(viewer, 'unknown-token')).status).toBe(404);

        const expired = await newLink(workspace, owner, { expiresAt: new Date(Date.now() - 1000) });
        const expiredRes = await join(await createTestUser(), expired.token);
        expect(expiredRes.status).toBe(410);
        expect(expiredRes.body).toEqual({ message: 'This invite link has expired' });

        const single = await newLink(workspace, owner, { maxUses: 1 });
        expect((await join(await createTestUser(), single.token)).status).toBe(200);
        const usedUp = await join(await createTestUser(), single.token);
        expect(usedUp.status).toBe(410);
        expect(usedUp.body).toEqual({ message: 'This invite link has reached its usage limit' });
        expect((await prisma.workspaceInviteLink.findUniqueOrThrow({ where: { id: single.id } })).useCount).toBe(1);

        // maxUses 0 meant "unlimited" in the old `maxUses && …` check.
        const zero = await newLink(workspace, owner, { maxUses: 0 });
        expect((await join(await createTestUser(), zero.token)).status).toBe(200);
    });

    it('401 without a cookie', async () => {
        expect((await request(app).post('/api/workspaces/invite-link/anything/request')).status).toBe(401);
    });
});


describe('admin approval: join request → POST /api/notifications/:id/accept | decline', () => {
    async function pendingRequest() {
        const fx = await createRoleFixture();
        const link = await newLink(fx.workspace, fx.owner);
        const requester = await createTestUser({ name: 'Joiner' });
        const res = await request(app).post(`/api/workspaces/invite-link/${link.token}/request`).set('Cookie', authCookie(requester));
        expect(res.status).toBe(200);
        const forAdmin = await prisma.notification.findFirstOrThrow({ where: { recipientId: fx.admin.id, senderId: requester.id } });
        const forOwner = await prisma.notification.findFirstOrThrow({ where: { recipientId: fx.owner.id, senderId: requester.id } });
        return { ...fx, requester, forAdmin, forOwner };
    }

    it('approve: the requester becomes a member, is notified, and the other admins\' copies are dismissed', async () => {
        const { workspace, admin, requester, forAdmin, forOwner } = await pendingRequest();

        const res = await request(app).post(`/api/notifications/${forAdmin.id}/accept`).set('Cookie', authCookie(admin));
        expect(res.status).toBe(200);

        const member = await prisma.workspaceMember.findUniqueOrThrow({
            where: { workspaceId_userId: { workspaceId: workspace.id, userId: requester.id } },
        });
        expect(member.role).toBe('member');
        expect(await prisma.activityLog.findFirst({ where: { workspaceId: workspace.id, action: 'member_joined' } })).toMatchObject({
            actorId: admin.id,
            targetUserId: requester.id,
            metadata: 'Approved join request',
        });
        expect(await prisma.notification.findFirst({ where: { recipientId: requester.id, type: 'workspace_join_approved' } })).toMatchObject({
            senderId: admin.id,
            message: `Your request to join "${workspace.name}" has been approved!`,
            metadata: { workspaceId: workspace.id, workspaceName: workspace.name },
        });
        expect(await prisma.notification.findUniqueOrThrow({ where: { id: forAdmin.id } })).toMatchObject({ status: 'accepted', isRead: true });
        expect(await prisma.notification.findUniqueOrThrow({ where: { id: forOwner.id } })).toMatchObject({ status: 'dismissed', isRead: true });

        // The new member now sees the workspace.
        const ws = await request(app).get(`/api/workspaces/${workspace.id}`).set('Cookie', authCookie(requester));
        expect(ws.status).toBe(200);
        expect(ws.body.data.members.map((m: any) => m.user._id)).toContain(requester.id);
    });

    it('reject: nobody is added', async () => {
        const { workspace, owner, requester, forOwner } = await pendingRequest();
        const res = await request(app).post(`/api/notifications/${forOwner.id}/decline`).set('Cookie', authCookie(owner));
        expect(res.status).toBe(200);
        expect((await prisma.notification.findUniqueOrThrow({ where: { id: forOwner.id } })).status).toBe('declined');
        expect(await prisma.workspaceMember.count({ where: { workspaceId: workspace.id, userId: requester.id } })).toBe(0);
        const ws = await request(app).get(`/api/workspaces/${workspace.id}`).set('Cookie', authCookie(requester));
        expect(ws.status).toBe(403);
    });

    it('a direct invite (POST /:id/members) is accepted by the invitee and adds them as member', async () => {
        const { workspace, admin } = await createRoleFixture();
        const invitee = await createTestUser();
        const invite = await request(app)
            .post(`/api/workspaces/${workspace.id}/members`)
            .set('Cookie', authCookie(admin))
            .send({ email: invitee.email });
        expect(invite.status).toBe(200);

        const notification = await prisma.notification.findFirstOrThrow({ where: { recipientId: invitee.id, type: 'workspace_invite' } });
        const res = await request(app).post(`/api/notifications/${notification.id}/accept`).set('Cookie', authCookie(invitee));
        expect(res.status).toBe(200);

        const member = await prisma.workspaceMember.findUniqueOrThrow({
            where: { workspaceId_userId: { workspaceId: workspace.id, userId: invitee.id } },
        });
        expect(member.role).toBe('member');
        expect(await prisma.activityLog.findFirst({ where: { workspaceId: workspace.id, action: 'member_joined' } })).toMatchObject({
            actorId: admin.id,
            targetUserId: invitee.id,
            metadata: 'Accepted invite',
        });
    });
});
