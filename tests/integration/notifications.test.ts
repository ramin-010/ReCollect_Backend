// /api/notifications: inbox, unread count + workspace role hash, read, read-all, accept, decline, delete.
// Rows are inserted directly, the way other modules (workspaces, todos, reminders) create them.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { authCookie, createTestUser } from '../helpers/auth';

type NotificationData = Parameters<typeof prisma.notification.create>[0]['data'];

function notify(recipientId: string, data: Partial<Record<string, unknown>> = {}) {
    return prisma.notification.create({
        data: { recipientId, category: 'informational', type: 'task_assigned', title: 'Task Assigned', ...data } as NotificationData,
    });
}

describe('GET /api/notifications', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).get('/api/notifications')).status).toBe(401);
    });

    it("lists my visible notifications newest first, with the sender populated and any module's metadata untouched", async () => {
        const me = await createTestUser();
        const sender = await createTestUser({ name: 'Sender Sam' });
        const other = await createTestUser();

        await notify(me.id, { title: 'oldest', createdAt: new Date('2026-10-01T00:00:00Z') });
        const invite = await notify(me.id, {
            senderId: sender.id,
            category: 'actionable',
            type: 'workspace_invite',
            title: 'Workspace Invitation',
            message: 'Sender Sam invited you',
            metadata: { workspaceId: 'cws123', workspaceName: 'Team', role: 'member', nested: { id: 'stays' } },
            createdAt: new Date('2026-10-03T00:00:00Z'),
        });
        await notify(me.id, { type: 'task_reminder', title: 'past schedule', scheduledFor: new Date('2026-10-02T00:00:00Z'), createdAt: new Date('2026-10-02T00:00:00Z') });
        await notify(me.id, { title: 'future', scheduledFor: new Date(Date.now() + 3_600_000) });
        await notify(other.id, { title: 'not mine' });

        const res = await request(app).get('/api/notifications').set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.map((n: any) => n.title)).toEqual(['Workspace Invitation', 'past schedule', 'oldest']);
        expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1, hasMore: false });

        expect(res.body.data[0]).toEqual({
            _id: invite.id,
            recipient: me.id,
            sender: { _id: sender.id, name: 'Sender Sam', email: sender.email, avatar: '' },
            category: 'actionable',
            type: 'workspace_invite',
            title: 'Workspace Invitation',
            message: 'Sender Sam invited you',
            icon: null,
            metadata: { workspaceId: 'cws123', workspaceName: 'Team', role: 'member', nested: { id: 'stays' } },
            status: 'pending',
            isRead: false,
            scheduledFor: null,
            expiresAt: null,
            createdAt: '2026-10-03T00:00:00.000Z',
            updatedAt: expect.any(String),
        });
        expect(res.body.data[2].sender).toBeNull(); // no sender
    });

    it('filter=unread and filter=actionable (pending only); unknown filters show everything', async () => {
        const me = await createTestUser();
        await notify(me.id, { title: 'read', isRead: true });
        await notify(me.id, { title: 'unread' });
        await notify(me.id, { title: 'act-pending', category: 'actionable', type: 'workspace_invite' });
        await notify(me.id, { title: 'act-done', category: 'actionable', type: 'workspace_invite', status: 'accepted', isRead: true });

        const titles = async (filter?: string) =>
            (await request(app).get('/api/notifications').query(filter ? { filter } : {}).set('Cookie', authCookie(me))).body.data
                .map((n: any) => n.title)
                .sort();

        expect(await titles('unread')).toEqual(['act-pending', 'unread']);
        expect(await titles('actionable')).toEqual(['act-pending']);
        expect((await titles('whatever')).length).toBe(4);
        expect((await titles()).length).toBe(4);
    });

    it('paginates: page/limit (limit clamped to 1..50, bad values → defaults), totalPages, hasMore', async () => {
        const me = await createTestUser();
        await prisma.notification.createMany({
            data: Array.from({ length: 5 }, (_, i) => ({
                recipientId: me.id,
                category: 'informational' as const,
                type: 'task_assigned',
                title: `n${i}`,
                createdAt: new Date(Date.UTC(2026, 9, 1, i)),
            })),
        });

        const page2 = await request(app).get('/api/notifications').query({ page: 2, limit: 2 }).set('Cookie', authCookie(me));
        expect(page2.body.data.map((n: any) => n.title)).toEqual(['n2', 'n1']);
        expect(page2.body.pagination).toEqual({ page: 2, limit: 2, total: 5, totalPages: 3, hasMore: true });

        const last = await request(app).get('/api/notifications').query({ page: 3, limit: 2 }).set('Cookie', authCookie(me));
        expect(last.body.pagination.hasMore).toBe(false);

        const clamped = await request(app).get('/api/notifications').query({ page: 0, limit: 500 }).set('Cookie', authCookie(me));
        expect(clamped.body.pagination).toMatchObject({ page: 1, limit: 50 });
        const defaults = await request(app).get('/api/notifications').query({ page: 'x', limit: 0 }).set('Cookie', authCookie(me));
        expect(defaults.body.pagination).toMatchObject({ page: 1, limit: 20 });
    });
});

describe('GET /api/notifications/unread-count', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).get('/api/notifications/unread-count')).status).toBe(401);
    });

    it('counts visible unread notifications and hashes my workspace roles', async () => {
        const me = await createTestUser();
        const owner = await createTestUser();
        await notify(me.id);
        await notify(me.id, { isRead: true });
        await notify(me.id, { scheduledFor: new Date(Date.now() + 3_600_000) });

        const empty = await request(app).get('/api/notifications/unread-count').set('Cookie', authCookie(me));
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual({ success: true, data: { count: 1, workspaceRoleHash: '' } });

        const wsA = await prisma.workspace.create({ data: { name: 'A', ownerId: owner.id } });
        const wsB = await prisma.workspace.create({ data: { name: 'B', ownerId: owner.id } });
        await prisma.workspaceMember.createMany({
            data: [
                { workspaceId: wsA.id, userId: me.id, role: 'viewer' },
                { workspaceId: wsB.id, userId: me.id, role: 'admin' },
                { workspaceId: wsB.id, userId: owner.id, role: 'admin' },
            ],
        });
        const res = await request(app).get('/api/notifications/unread-count').set('Cookie', authCookie(me));
        expect(res.body.data.workspaceRoleHash).toBe([`${wsA.id}:viewer`, `${wsB.id}:admin`].sort().join('|'));
    });
});

describe('PATCH /api/notifications/:id/read and /read-all', () => {
    it("marks one as read (404 for someone else's) and returns it with the bare sender id", async () => {
        const me = await createTestUser();
        const other = await createTestUser();
        const sender = await createTestUser();
        const mine = await notify(me.id, { senderId: sender.id });
        const theirs = await notify(other.id);

        const res = await request(app).patch(`/api/notifications/${mine.id}/read`).set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toMatchObject({ _id: mine.id, isRead: true, sender: sender.id, recipient: me.id });

        const denied = await request(app).patch(`/api/notifications/${theirs.id}/read`).set('Cookie', authCookie(me));
        expect(denied.status).toBe(404);
        expect(denied.body).toEqual({ message: 'Notification not found' });
        expect((await prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).isRead).toBe(false);
    });

    it('read-all marks only my notifications that show now; one scheduled for later stays unread', async () => {
        const me = await createTestUser();
        const other = await createTestUser();
        const now = await notify(me.id);
        const later = await notify(me.id, { scheduledFor: new Date(Date.now() + 3_600_000) });
        const theirs = await notify(other.id);

        const res = await request(app).patch('/api/notifications/read-all').set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'All notifications marked as read' });
        expect((await prisma.notification.findUniqueOrThrow({ where: { id: now.id } })).isRead).toBe(true);
        expect((await prisma.notification.findUniqueOrThrow({ where: { id: later.id } })).isRead).toBe(false);
        expect((await prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).isRead).toBe(false);
    });
});

describe('POST /api/notifications/:id/accept', () => {
    it('404 unless it is my pending actionable notification', async () => {
        const me = await createTestUser();
        const other = await createTestUser();
        const info = await notify(me.id);
        const handled = await notify(me.id, { category: 'actionable', type: 'workspace_invite', status: 'declined' });
        const theirs = await notify(other.id, { category: 'actionable', type: 'workspace_invite' });

        for (const n of [info, handled, theirs]) {
            const res = await request(app).post(`/api/notifications/${n.id}/accept`).set('Cookie', authCookie(me));
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ message: 'Notification not found or already handled' });
        }
        expect((await request(app).post(`/api/notifications/${info.id}/accept`)).status).toBe(401);
    });

    it('workspace_invite: I join with the invited role, the join is logged, a second accept is 404', async () => {
        const me = await createTestUser();
        const admin = await createTestUser();
        const ws = await prisma.workspace.create({ data: { name: 'Invite WS', ownerId: admin.id } });
        const invite = await notify(me.id, {
            senderId: admin.id,
            category: 'actionable',
            type: 'workspace_invite',
            title: 'Workspace Invitation',
            metadata: { workspaceId: ws.id, workspaceName: ws.name, role: 'viewer' },
        });

        const res = await request(app).post(`/api/notifications/${invite.id}/accept`).set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            message: 'Notification accepted',
            data: { _id: invite.id, status: 'accepted', isRead: true, sender: admin.id },
        });

        const member = await prisma.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: ws.id, userId: me.id } } });
        expect(member.role).toBe('viewer');
        const activity = await prisma.activityLog.findMany({ where: { workspaceId: ws.id } });
        expect(activity).toHaveLength(1);
        expect(activity[0]).toMatchObject({ actorId: admin.id, action: 'member_joined', targetUserId: me.id, metadata: 'Accepted invite' });

        const again = await request(app).post(`/api/notifications/${invite.id}/accept`).set('Cookie', authCookie(me));
        expect(again.status).toBe(404);
    });

    it('workspace_invite when already a member: role unchanged, nothing logged; default role is member', async () => {
        const me = await createTestUser();
        const admin = await createTestUser();
        const ws = await prisma.workspace.create({ data: { name: 'Member WS', ownerId: admin.id } });
        await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: me.id, role: 'admin' } });
        const invite = await notify(me.id, { senderId: admin.id, category: 'actionable', type: 'workspace_invite', metadata: { workspaceId: ws.id, role: 'viewer' } });

        expect((await request(app).post(`/api/notifications/${invite.id}/accept`).set('Cookie', authCookie(me))).status).toBe(200);
        expect((await prisma.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: ws.id, userId: me.id } } })).role).toBe('admin');
        expect(await prisma.activityLog.count({ where: { workspaceId: ws.id } })).toBe(0);

        const ws2 = await prisma.workspace.create({ data: { name: 'Default role WS', ownerId: admin.id } });
        const noRole = await notify(me.id, { category: 'actionable', type: 'workspace_invite', metadata: { workspaceId: ws2.id } });
        expect((await request(app).post(`/api/notifications/${noRole.id}/accept`).set('Cookie', authCookie(me))).status).toBe(200);
        expect((await prisma.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: ws2.id, userId: me.id } } })).role).toBe('member');
        // No sender: the actor is me.
        expect((await prisma.activityLog.findFirstOrThrow({ where: { workspaceId: ws2.id } })).actorId).toBe(me.id);
    });

    it('workspace_invite errors roll back: 400 without a workspaceId, 404 when the workspace is gone', async () => {
        const me = await createTestUser();
        const broken = await notify(me.id, { category: 'actionable', type: 'workspace_invite', metadata: {} });
        const gone = await notify(me.id, { category: 'actionable', type: 'workspace_invite', metadata: { workspaceId: 'cgoneworkspace00000000000' } });

        const bad = await request(app).post(`/api/notifications/${broken.id}/accept`).set('Cookie', authCookie(me));
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ message: 'Invalid notification data' });

        const missing = await request(app).post(`/api/notifications/${gone.id}/accept`).set('Cookie', authCookie(me));
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ message: 'Workspace no longer exists' });

        // Still pending: the claim was rolled back.
        const rows = await prisma.notification.findMany({ where: { id: { in: [broken.id, gone.id] } } });
        expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
    });

    it('workspace_join_request: the requester joins, is told, and the copies sent to other admins are dismissed', async () => {
        const admin = await createTestUser({ name: 'Admin One' });
        const admin2 = await createTestUser();
        const requester = await createTestUser();
        const ws = await prisma.workspace.create({ data: { name: 'Join WS', ownerId: admin.id } });
        const otherWs = await prisma.workspace.create({ data: { name: 'Other WS', ownerId: admin.id } });

        const mine = await notify(admin.id, { senderId: requester.id, category: 'actionable', type: 'workspace_join_request', metadata: { workspaceId: ws.id } });
        const copy = await notify(admin2.id, { senderId: requester.id, category: 'actionable', type: 'workspace_join_request', metadata: { workspaceId: ws.id } });
        const unrelated = await notify(admin2.id, { senderId: requester.id, category: 'actionable', type: 'workspace_join_request', metadata: { workspaceId: otherWs.id } });

        const res = await request(app).post(`/api/notifications/${mine.id}/accept`).set('Cookie', authCookie(admin));
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ status: 'accepted', isRead: true });

        const member = await prisma.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: ws.id, userId: requester.id } } });
        expect(member.role).toBe('member');
        expect(await prisma.activityLog.findFirstOrThrow({ where: { workspaceId: ws.id } })).toMatchObject({
            actorId: admin.id,
            action: 'member_joined',
            targetUserId: requester.id,
            metadata: 'Approved join request',
        });
        const approved = await prisma.notification.findFirstOrThrow({ where: { recipientId: requester.id, type: 'workspace_join_approved' } });
        expect(approved).toMatchObject({
            senderId: admin.id,
            category: 'informational',
            title: 'Join Request Approved',
            message: 'Your request to join "Join WS" has been approved!',
            metadata: { workspaceId: ws.id, workspaceName: 'Join WS' },
            status: 'pending',
        });

        expect(await prisma.notification.findUniqueOrThrow({ where: { id: copy.id } })).toMatchObject({ status: 'dismissed', isRead: true });
        expect(await prisma.notification.findUniqueOrThrow({ where: { id: unrelated.id } })).toMatchObject({ status: 'pending', isRead: false });

        // The requester's inbox lists the approval (created here) like any other row.
        const inbox = await request(app).get('/api/notifications').set('Cookie', authCookie(requester));
        expect(inbox.body.data[0]).toMatchObject({ type: 'workspace_join_approved', sender: { _id: admin.id, name: 'Admin One' } });
    });

    it('workspace_join_request without a sender is 400', async () => {
        const admin = await createTestUser();
        const ws = await prisma.workspace.create({ data: { name: 'No sender WS', ownerId: admin.id } });
        const n = await notify(admin.id, { category: 'actionable', type: 'workspace_join_request', metadata: { workspaceId: ws.id } });
        const res = await request(app).post(`/api/notifications/${n.id}/accept`).set('Cookie', authCookie(admin));
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'Invalid notification data' });
    });

    it('any other actionable type is just marked accepted', async () => {
        const me = await createTestUser();
        const n = await notify(me.id, { category: 'actionable', type: 'doc_collab_invite', metadata: { docId: 'cdoc1' } });
        const res = await request(app).post(`/api/notifications/${n.id}/accept`).set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ status: 'accepted', isRead: true, metadata: { docId: 'cdoc1' } });
    });
});

describe('POST /api/notifications/:id/decline', () => {
    it('declines my pending actionable notification once', async () => {
        const me = await createTestUser();
        const n = await notify(me.id, { category: 'actionable', type: 'workspace_invite' });

        const res = await request(app).post(`/api/notifications/${n.id}/decline`).set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, message: 'Notification declined', data: { _id: n.id, status: 'declined', isRead: true } });

        const again = await request(app).post(`/api/notifications/${n.id}/decline`).set('Cookie', authCookie(me));
        expect(again.status).toBe(404);
        expect(again.body).toEqual({ message: 'Notification not found or already handled' });
        expect((await request(app).post(`/api/notifications/${n.id}/decline`)).status).toBe(401);
    });
});

describe('DELETE /api/notifications/:id', () => {
    it("deletes mine; 404 for someone else's", async () => {
        const me = await createTestUser();
        const other = await createTestUser();
        const mine = await notify(me.id);
        const theirs = await notify(other.id);

        const res = await request(app).delete(`/api/notifications/${mine.id}`).set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Notification deleted' });
        expect(await prisma.notification.count({ where: { id: mine.id } })).toBe(0);

        const denied = await request(app).delete(`/api/notifications/${theirs.id}`).set('Cookie', authCookie(me));
        expect(denied.status).toBe(404);
        expect(denied.body).toEqual({ message: 'Notification not found' });
        expect((await request(app).delete(`/api/notifications/${mine.id}`)).status).toBe(401);
    });
});
