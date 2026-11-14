// Workspace endpoints on Postgres: CRUD, members + roles, spaces, settings, tasks, stats, activity.
// Same routes, status codes, messages and JSON shapes as the Mongo version.
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// Deleting a workspace now cascades to its todos, so their Cloudinary images are deleted: spy on it.
vi.mock('../../src/utils/cloudinary', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/utils/cloudinary')>()),
    batchDeleteFromCloud: vi.fn(async () => {}),
}));

import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { batchDeleteFromCloud } from '../../src/utils/cloudinary';
import { authCookie, createTestUser } from '../helpers/auth';
import { mailsTo } from '../helpers/mail';
import { createRoleFixture, createTestWorkspace, createWorkspaceTodoRow } from '../helpers/workspaces';

const WORKSPACE_KEYS = ['_id', 'createdAt', 'members', 'name', 'owner', 'settings', 'spaces', 'updatedAt'];
const USER_SUMMARY_KEYS = ['_id', 'avatar', 'email', 'name'];

function summary(user: { id: string; name: string; email: string; avatar: string }) {
    return { _id: user.id, name: user.name, email: user.email, avatar: user.avatar };
}

describe('POST /api/workspaces', () => {
    it('creates the workspace: owner is an admin member, default space "Team 1", workspace_created activity', async () => {
        const owner = await createTestUser({ name: 'Creator' });
        const res = await request(app).post('/api/workspaces').set('Cookie', authCookie(owner)).send({ name: '  Acme  ' });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        const ws = res.body.data;
        expect(Object.keys(ws).sort()).toEqual(WORKSPACE_KEYS);
        expect(ws).toMatchObject({
            name: 'Acme',
            owner: summary(owner),
            settings: { membersCanViewOverview: false },
        });
        expect(Object.keys(ws.owner).sort()).toEqual(USER_SUMMARY_KEYS);
        expect(ws.members).toHaveLength(1);
        expect(Object.keys(ws.members[0]).sort()).toEqual(['joinedAt', 'role', 'user']);
        expect(ws.members[0]).toMatchObject({ user: summary(owner), role: 'admin' });
        expect(ws.spaces).toEqual([{ _id: expect.any(String), name: 'Team 1' }]);

        const activity = await prisma.activityLog.findMany({ where: { workspaceId: ws._id } });
        expect(activity).toMatchObject([{ action: 'workspace_created', actorId: owner.id, metadata: 'Acme', targetUserId: null }]);
    });

    it('uses the trimmed defaultSpaceName', async () => {
        const owner = await createTestUser();
        const res = await request(app)
            .post('/api/workspaces')
            .set('Cookie', authCookie(owner))
            .send({ name: 'Named', defaultSpaceName: '  Design  ' });
        expect(res.status).toBe(201);
        expect(res.body.data.spaces.map((s: any) => s.name)).toEqual(['Design']);
    });

    it('400 "Workspace name is required" for a missing, blank or non-string name', async () => {
        const owner = await createTestUser();
        for (const body of [{}, { name: '   ' }, { name: 42 }]) {
            const res = await request(app).post('/api/workspaces').set('Cookie', authCookie(owner)).send(body);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ message: 'Workspace name is required' });
        }
    });

    it('enforces the Mongoose maxlength (name 100, space 50) with the old message', async () => {
        const owner = await createTestUser();
        const longName = await request(app).post('/api/workspaces').set('Cookie', authCookie(owner)).send({ name: 'w'.repeat(101) });
        expect(longName.status).toBe(400);
        expect(longName.body.message).toBe(`Path \`name\` (\`${'w'.repeat(101)}\`) is longer than the maximum allowed length (100).`);

        const longSpace = await request(app)
            .post('/api/workspaces')
            .set('Cookie', authCookie(owner))
            .send({ name: 'ok', defaultSpaceName: 's'.repeat(51) });
        expect(longSpace.status).toBe(400);
        expect(longSpace.body.message).toBe(`Path \`name\` (\`${'s'.repeat(51)}\`) is longer than the maximum allowed length (50).`);
        expect(await prisma.workspace.count({ where: { ownerId: owner.id } })).toBe(0);
    });

    it('401 without a cookie', async () => {
        const res = await request(app).post('/api/workspaces').send({ name: 'x' });
        expect(res.status).toBe(401);
    });
});

describe('GET /api/workspaces', () => {
    it('lists the workspaces the user owns or is a member of, most recently updated first', async () => {
        const me = await createTestUser();
        const other = await createTestUser();
        const owned = await createTestWorkspace(me, { name: 'Mine' });
        const joined = await createTestWorkspace(other, { name: 'Theirs', members: [{ user: me, role: 'viewer' }] });
        await createTestWorkspace(other, { name: 'Not mine' });
        await prisma.workspace.update({ where: { id: owned.id }, data: { updatedAt: new Date(Date.now() + 60_000) } });

        const res = await request(app).get('/api/workspaces').set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.map((w: any) => w._id)).toEqual([owned.id, joined.id]);
        const theirs = res.body.data[1];
        expect(theirs.owner).toEqual(summary(other));
        expect(theirs.members.map((m: any) => [m.user._id, m.role])).toEqual([
            [other.id, 'admin'],
            [me.id, 'viewer'],
        ]);
    });

    it('401 without a cookie', async () => {
        expect((await request(app).get('/api/workspaces')).status).toBe(401);
    });
});

describe('GET /api/workspaces/:id', () => {
    it('returns the populated workspace to any member', async () => {
        const { workspace, viewer, owner } = await createRoleFixture();
        const res = await request(app).get(`/api/workspaces/${workspace.id}`).set('Cookie', authCookie(viewer));
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data).sort()).toEqual(WORKSPACE_KEYS);
        expect(res.body.data).toMatchObject({ _id: workspace.id, owner: summary(owner) });
        expect(res.body.data.members).toHaveLength(4);
    });

    it('403 for a non-member, 404 for an unknown id', async () => {
        const { workspace, outsider } = await createRoleFixture();
        const forbidden = await request(app).get(`/api/workspaces/${workspace.id}`).set('Cookie', authCookie(outsider));
        expect(forbidden.status).toBe(403);
        expect(forbidden.body).toEqual({ message: 'You are not a member of this workspace' });

        const missing = await request(app).get('/api/workspaces/does-not-exist').set('Cookie', authCookie(outsider));
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ message: 'Workspace not found' });
    });
});

describe('POST /api/workspaces/:id/members (invite)', () => {
    it('sends an actionable invite notification + email to an existing user (does not add them)', async () => {
        const { workspace, admin } = await createRoleFixture();
        const invitee = await createTestUser({ name: 'Invitee', email: 'invitee@example.test' });

        const res = await request(app)
            .post(`/api/workspaces/${workspace.id}/members`)
            .set('Cookie', authCookie(admin))
            .send({ email: '  INVITEE@example.test ' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Invite sent to Invitee' });
        expect(await prisma.workspaceMember.count({ where: { workspaceId: workspace.id, userId: invitee.id } })).toBe(0);

        const notification = await prisma.notification.findFirstOrThrow({ where: { recipientId: invitee.id } });
        expect(notification).toMatchObject({
            senderId: admin.id,
            category: 'actionable',
            type: 'workspace_invite',
            title: 'Workspace Invite',
            message: `Admin invited you to join "${workspace.name}"`,
            metadata: { workspaceId: workspace.id, workspaceName: workspace.name, role: 'member' },
            status: 'pending',
            isRead: false,
        });

        await vi.waitFor(() => expect(mailsTo('invitee@example.test')).toHaveLength(1));
        const mail = mailsTo('invitee@example.test')[0]!;
        expect(mail.subject).toBe(`Admin invited you to join "${workspace.name}"`);
        expect(mail.html).toContain('/inbox');
    });

    it('creates a placeholder (ghost) user for an unknown email', async () => {
        const { workspace, owner } = await createRoleFixture();
        const res = await request(app)
            .post(`/api/workspaces/${workspace.id}/members`)
            .set('Cookie', authCookie(owner))
            .send({ email: 'New.Person@Example.test' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Invitation sent to new.person@example.test' });
        const ghost = await prisma.user.findUniqueOrThrow({ where: { email: 'new.person@example.test' } });
        expect(ghost).toMatchObject({ isGhost: true, status: 'pending', name: 'new.person' });
        expect(await prisma.notification.count({ where: { recipientId: ghost.id, type: 'workspace_invite' } })).toBe(1);

        await vi.waitFor(() => expect(mailsTo('new.person@example.test')).toHaveLength(1));
        expect(mailsTo('new.person@example.test')[0]!.html).toContain('/signup');
    });

    it('validates the email and the inviter', async () => {
        const { workspace, owner, admin, member, viewer, outsider } = await createRoleFixture();
        const invite = (user: { id: string }, body: object) =>
            request(app).post(`/api/workspaces/${workspace.id}/members`).set('Cookie', authCookie(user)).send(body);

        for (const body of [{}, { email: 42 }]) {
            const res = await invite(owner, body);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ message: 'Email is required' });
        }
        expect((await invite(owner, { email: '   ' })).body).toEqual({ message: 'Email is required' });

        for (const user of [member, viewer, outsider]) {
            const res = await invite(user, { email: 'someone@example.test' });
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ message: 'Only admins can invite members' });
        }

        const self = await invite(admin, { email: admin.email });
        expect(self.status).toBe(400);
        expect(self.body).toEqual({ message: 'You are already in this workspace' });

        const already = await invite(admin, { email: member.email });
        expect(already.status).toBe(400);
        expect(already.body).toEqual({ message: 'User is already a member of this workspace' });

        expect((await invite(admin, { email: outsider.email })).status).toBe(200);
        const pending = await invite(owner, { email: outsider.email });
        expect(pending.status).toBe(400);
        expect(pending.body).toEqual({ message: 'An invite is already pending for this user' });

        const missing = await request(app)
            .post('/api/workspaces/nope/members')
            .set('Cookie', authCookie(owner))
            .send({ email: 'a@example.test' });
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ message: 'Workspace not found' });
    });
});

describe('DELETE /api/workspaces/:id/members/:userId', () => {
    it('lets an admin remove a member: returns the updated workspace and logs member_removed', async () => {
        const { workspace, admin, member } = await createRoleFixture();
        const before = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });

        const res = await request(app)
            .delete(`/api/workspaces/${workspace.id}/members/${member.id}`)
            .set('Cookie', authCookie(admin));

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Member removed');
        expect(Object.keys(res.body.data).sort()).toEqual(WORKSPACE_KEYS);
        expect(res.body.data.members.map((m: any) => m.user._id)).not.toContain(member.id);
        expect(new Date(res.body.data.updatedAt).getTime()).toBeGreaterThan(before.updatedAt.getTime());

        const log = await prisma.activityLog.findFirstOrThrow({ where: { workspaceId: workspace.id, action: 'member_removed' } });
        expect(log).toMatchObject({ actorId: admin.id, targetUserId: member.id });
    });

    it('lets a member or viewer leave (remove themselves)', async () => {
        const { workspace, viewer } = await createRoleFixture();
        const res = await request(app)
            .delete(`/api/workspaces/${workspace.id}/members/${viewer.id}`)
            .set('Cookie', authCookie(viewer));
        expect(res.status).toBe(200);
        expect(await prisma.workspaceMember.count({ where: { workspaceId: workspace.id, userId: viewer.id } })).toBe(0);
    });

    it('403 for members removing others and for outsiders; 400 for the owner; 404 unknown workspace', async () => {
        const { workspace, owner, admin, member, viewer, outsider } = await createRoleFixture();
        const remove = (actor: { id: string }, target: { id: string }) =>
            request(app).delete(`/api/workspaces/${workspace.id}/members/${target.id}`).set('Cookie', authCookie(actor));

        for (const [actor, target] of [
            [member, viewer],
            [viewer, member],
            [outsider, member],
            // An outsider "removing themselves" used to answer 200 with the whole workspace.
            [outsider, outsider],
        ] as const) {
            const res = await remove(actor, target);
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ message: 'Only admins can remove members' });
        }

        for (const actor of [admin, owner]) {
            const res = await remove(actor, owner);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ message: 'Cannot remove the workspace owner' });
        }

        const missing = await request(app).delete(`/api/workspaces/nope/members/${member.id}`).set('Cookie', authCookie(owner));
        expect(missing.status).toBe(404);
        expect(await prisma.activityLog.count({ where: { workspaceId: workspace.id } })).toBe(0);
    });
});

describe('PATCH /api/workspaces/:id/members/:userId/role', () => {
    it('lets the owner or an admin change a member role', async () => {
        const { workspace, admin, member } = await createRoleFixture();
        const res = await request(app)
            .patch(`/api/workspaces/${workspace.id}/members/${member.id}/role`)
            .set('Cookie', authCookie(admin))
            .send({ role: 'viewer' });

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Role updated');
        expect(res.body.data.members.find((m: any) => m.user._id === member.id).role).toBe('viewer');
        const row = await prisma.workspaceMember.findUniqueOrThrow({
            where: { workspaceId_userId: { workspaceId: workspace.id, userId: member.id } },
        });
        expect(row.role).toBe('viewer');
    });

    it('validates role, caller, target', async () => {
        const { workspace, owner, admin, member, viewer, outsider } = await createRoleFixture();
        const patch = (actor: { id: string }, target: { id: string }, body: object) =>
            request(app).patch(`/api/workspaces/${workspace.id}/members/${target.id}/role`).set('Cookie', authCookie(actor)).send(body);

        for (const body of [{}, { role: 'owner' }, { role: 'superuser' }]) {
            const res = await patch(owner, member, body);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ message: 'Invalid role' });
        }
        for (const actor of [member, viewer, outsider]) {
            const res = await patch(actor, viewer, { role: 'admin' });
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ message: 'Only admins can update roles' });
        }
        const ownerTarget = await patch(admin, owner, { role: 'viewer' });
        expect(ownerTarget.status).toBe(400);
        expect(ownerTarget.body).toEqual({ message: 'Cannot change the role of the workspace owner' });

        const notMember = await patch(owner, outsider, { role: 'member' });
        expect(notMember.status).toBe(400);
        expect(notMember.body).toEqual({ message: 'User is not a member of this workspace' });
    });
});

describe('DELETE /api/workspaces/:id', () => {
    it('owner only; cascades members, spaces, invite links, activity, todos and their images', async () => {
        const { workspace, owner, admin } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, admin, {
            cloudImages: [{ imageId: 'i1', cloudPublicId: 'recollect-todos-workspace/i1' }],
        });
        await prisma.reminder.create({ data: { userId: admin.id, todoId: todo.id, reminderDate: new Date(Date.now() + 3_600_000) } });
        await prisma.workspaceInviteLink.create({ data: { workspaceId: workspace.id, token: `tok-${workspace.id}`, createdById: owner.id } });
        await prisma.activityLog.create({ data: { workspaceId: workspace.id, actorId: owner.id, action: 'workspace_created' } });

        const forbidden = await request(app).delete(`/api/workspaces/${workspace.id}`).set('Cookie', authCookie(admin));
        expect(forbidden.status).toBe(403);
        expect(forbidden.body).toEqual({ message: 'Only the workspace owner can delete it' });

        const res = await request(app).delete(`/api/workspaces/${workspace.id}`).set('Cookie', authCookie(owner));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Workspace deleted' });

        expect(await prisma.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
        expect(await prisma.workspaceMember.count({ where: { workspaceId: workspace.id } })).toBe(0);
        expect(await prisma.space.count({ where: { workspaceId: workspace.id } })).toBe(0);
        expect(await prisma.workspaceInviteLink.count({ where: { workspaceId: workspace.id } })).toBe(0);
        expect(await prisma.activityLog.count({ where: { workspaceId: workspace.id } })).toBe(0);
        expect(await prisma.todo.count({ where: { id: todo.id } })).toBe(0);
        expect(await prisma.reminder.count({ where: { todoId: todo.id } })).toBe(0);
        expect(vi.mocked(batchDeleteFromCloud)).toHaveBeenCalledWith(['recollect-todos-workspace/i1']);

        const again = await request(app).delete(`/api/workspaces/${workspace.id}`).set('Cookie', authCookie(owner));
        expect(again.status).toBe(404);
        expect(again.body).toEqual({ message: 'Workspace not found' });
    });
});

describe('POST /api/workspaces/:id/spaces', () => {
    it('any member (viewers included, as before) can add a space; spaces keep their order', async () => {
        const { workspace, viewer } = await createRoleFixture();
        const res = await request(app)
            .post(`/api/workspaces/${workspace.id}/spaces`)
            .set('Cookie', authCookie(viewer))
            .send({ name: '  Marketing ' });

        expect(res.status).toBe(201);
        expect(res.body.message).toBe('Space created');
        expect(res.body.data.spaces.map((s: any) => s.name)).toEqual(['Team 1', 'Marketing']);
        expect(res.body.data.spaces[0]._id).toBe(workspace.spaceIds[0]);
    });

    it('400 for a missing/blank/too long name, 403 for outsiders, 404 for unknown workspaces', async () => {
        const { workspace, owner, outsider } = await createRoleFixture();
        const post = (user: { id: string }, body: object, id = workspace.id) =>
            request(app).post(`/api/workspaces/${id}/spaces`).set('Cookie', authCookie(user)).send(body);

        expect((await post(owner, {})).body).toEqual({ message: 'Space name is required' });
        expect((await post(owner, { name: '  ' })).status).toBe(400);
        const long = await post(owner, { name: 'x'.repeat(51) });
        expect(long.status).toBe(400);
        expect(long.body.message).toBe(`Path \`name\` (\`${'x'.repeat(51)}\`) is longer than the maximum allowed length (50).`);

        const forbidden = await post(outsider, { name: 'Nope' });
        expect(forbidden.status).toBe(403);
        expect(forbidden.body).toEqual({ message: 'Not a member of this workspace' });
        expect((await post(owner, { name: 'X' }, 'missing')).status).toBe(404);
    });
});

describe('GET /api/workspaces/:id/tasks', () => {
    it('returns the workspace tasks (newest first) with user, assignees and tags populated; filters by space', async () => {
        const { workspace, owner, member, viewer, outsider } = await createRoleFixture({});
        const space2 = await prisma.space.create({ data: { workspaceId: workspace.id, name: 'Two' } });
        const tag = await prisma.tag.create({ data: { name: `ws-tag-${workspace.id}` } });
        const older = await createWorkspaceTodoRow(workspace, owner, {
            title: 'Older',
            spaceId: workspace.spaceIds[0]!,
            createdAt: new Date(Date.now() - 60_000),
        });
        const newer = await createWorkspaceTodoRow(workspace, member, { title: 'Newer', spaceId: space2.id });
        await prisma.todoAssignee.create({ data: { todoId: newer.id, userId: viewer.id } });
        await prisma.todoTag.create({ data: { todoId: newer.id, tagId: tag.id } });
        // Not listed: a personal todo pointing at the workspace, and another workspace's task.
        await prisma.todo.create({ data: { userId: owner.id, title: 'Private', workspaceId: workspace.id, visibility: 'private' } });
        const other = await createTestWorkspace(outsider);
        await createWorkspaceTodoRow(other, outsider, { title: 'Elsewhere' });

        const res = await request(app).get(`/api/workspaces/${workspace.id}/tasks`).set('Cookie', authCookie(viewer));
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
        expect(res.body.data.map((t: any) => t.title)).toEqual(['Newer', 'Older']);
        expect(res.body.data[0]).toMatchObject({
            _id: newer.id,
            user: summary(member),
            assignees: [summary(viewer)],
            tags: [{ _id: tag.id, name: tag.name }],
            workspace: workspace.id,
            spaceId: space2.id,
            visibility: 'workspace',
        });

        const filtered = await request(app)
            .get(`/api/workspaces/${workspace.id}/tasks`)
            .query({ spaceId: workspace.spaceIds[0] })
            .set('Cookie', authCookie(viewer));
        expect(filtered.body.data.map((t: any) => t._id)).toEqual([older.id]);

        const all = await request(app).get(`/api/workspaces/${workspace.id}/tasks`).query({ spaceId: 'all' }).set('Cookie', authCookie(viewer));
        expect(all.body.count).toBe(2);

        const forbidden = await request(app).get(`/api/workspaces/${workspace.id}/tasks`).set('Cookie', authCookie(outsider));
        expect(forbidden.status).toBe(403);
        expect(forbidden.body).toEqual({ message: 'Not a member' });
    });
});

describe('GET /api/workspaces/:id/stats', () => {
    it('counts tasks by status, overdue and members (admins always; members only if allowed)', async () => {
        const { workspace, owner, admin, member, viewer, outsider } = await createRoleFixture();
        const past = new Date(Date.now() - 86_400_000);
        await createWorkspaceTodoRow(workspace, owner, { status: 'pending', dueDate: past });
        await createWorkspaceTodoRow(workspace, owner, { status: 'in_progress' });
        await createWorkspaceTodoRow(workspace, owner, { status: 'complete', dueDate: past });
        await createWorkspaceTodoRow(workspace, owner, { status: 'review', spaceId: workspace.spaceIds[0]! });

        const res = await request(app).get(`/api/workspaces/${workspace.id}/stats`).set('Cookie', authCookie(admin));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            data: { totalMembers: 4, totalTasks: 4, pending: 1, inProgress: 1, completed: 1, overdue: 1 },
        });

        const bySpace = await request(app)
            .get(`/api/workspaces/${workspace.id}/stats`)
            .query({ spaceId: workspace.spaceIds[0] })
            .set('Cookie', authCookie(owner));
        expect(bySpace.body.data).toMatchObject({ totalTasks: 1, pending: 0, overdue: 0 });

        for (const user of [member, viewer]) {
            const res403 = await request(app).get(`/api/workspaces/${workspace.id}/stats`).set('Cookie', authCookie(user));
            expect(res403.status).toBe(403);
            expect(res403.body).toEqual({ message: 'You do not have permission to view the workspace overview.' });
        }
        const outsiderRes = await request(app).get(`/api/workspaces/${workspace.id}/stats`).set('Cookie', authCookie(outsider));
        expect(outsiderRes.status).toBe(403);
        expect(outsiderRes.body).toEqual({ message: 'Not a member' });

        await prisma.workspace.update({ where: { id: workspace.id }, data: { settings: { membersCanViewOverview: true } } });
        for (const user of [member, viewer]) {
            expect((await request(app).get(`/api/workspaces/${workspace.id}/stats`).set('Cookie', authCookie(user))).status).toBe(200);
        }
    });
});

describe('GET /api/workspaces/:id/activity', () => {
    it('returns the last 30 entries, newest first, with actor/targetUser populated', async () => {
        const { workspace, owner, member, outsider } = await createRoleFixture();
        const base = Date.now() - 100_000;
        for (let i = 0; i < 32; i += 1) {
            await prisma.activityLog.create({
                data: {
                    workspaceId: workspace.id,
                    actorId: owner.id,
                    action: 'member_joined',
                    targetUserId: member.id,
                    metadata: `entry ${i}`,
                    createdAt: new Date(base + i * 1000),
                },
            });
        }

        const res = await request(app).get(`/api/workspaces/${workspace.id}/activity`).set('Cookie', authCookie(member));
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(30);
        expect(res.body.data[0].metadata).toBe('entry 31');
        expect(Object.keys(res.body.data[0]).sort()).toEqual(
            ['_id', 'action', 'actor', 'createdAt', 'metadata', 'targetTask', 'targetUser', 'updatedAt', 'workspace'].sort()
        );
        expect(res.body.data[0]).toMatchObject({
            workspace: workspace.id,
            actor: summary(owner),
            targetUser: summary(member),
            targetTask: null,
            action: 'member_joined',
        });

        const forbidden = await request(app).get(`/api/workspaces/${workspace.id}/activity`).set('Cookie', authCookie(outsider));
        expect(forbidden.status).toBe(403);
        expect(forbidden.body).toEqual({ message: 'Not a member' });
    });
});

describe('PATCH /api/workspaces/:id/settings', () => {
    it('admins toggle membersCanViewOverview; other values are ignored', async () => {
        const { workspace, admin, member } = await createRoleFixture();
        const res = await request(app)
            .patch(`/api/workspaces/${workspace.id}/settings`)
            .set('Cookie', authCookie(admin))
            .send({ membersCanViewOverview: true });
        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Settings updated');
        expect(res.body.data.settings).toEqual({ membersCanViewOverview: true });

        const ignored = await request(app)
            .patch(`/api/workspaces/${workspace.id}/settings`)
            .set('Cookie', authCookie(admin))
            .send({ membersCanViewOverview: 'yes' });
        expect(ignored.status).toBe(200);
        expect(ignored.body.data.settings).toEqual({ membersCanViewOverview: true });

        const forbidden = await request(app)
            .patch(`/api/workspaces/${workspace.id}/settings`)
            .set('Cookie', authCookie(member))
            .send({ membersCanViewOverview: false });
        expect(forbidden.status).toBe(403);
        expect(forbidden.body).toEqual({ message: 'Only admins can update workspace settings' });
    });
});

describe('role matrix (shared permission helpers, end to end)', () => {
    it('owner / admin / member / viewer / outsider get the documented access', async () => {
        const fx = await createRoleFixture();
        const ws = fx.workspace.id;
        const status = async (user: { id: string }, method: 'get' | 'post' | 'patch', url: string, body?: object) => {
            const req = request(app)[method](url).set('Cookie', authCookie(user));
            return (await (body ? req.send(body) : req)).status;
        };

        const table: Array<[string, (u: { id: string }) => Promise<number>, Record<'owner' | 'admin' | 'member' | 'viewer' | 'outsider', number>]> = [
            ['read workspace', (u) => status(u, 'get', `/api/workspaces/${ws}`), { owner: 200, admin: 200, member: 200, viewer: 200, outsider: 403 }],
            ['list tasks', (u) => status(u, 'get', `/api/workspaces/${ws}/tasks`), { owner: 200, admin: 200, member: 200, viewer: 200, outsider: 403 }],
            ['stats', (u) => status(u, 'get', `/api/workspaces/${ws}/stats`), { owner: 200, admin: 200, member: 403, viewer: 403, outsider: 403 }],
            ['settings', (u) => status(u, 'patch', `/api/workspaces/${ws}/settings`, {}), { owner: 200, admin: 200, member: 403, viewer: 403, outsider: 403 }],
            ['invite links', (u) => status(u, 'get', `/api/workspaces/${ws}/invite-links`), { owner: 200, admin: 200, member: 403, viewer: 403, outsider: 403 }],
        ];

        for (const [label, call, expected] of table) {
            for (const role of ['owner', 'admin', 'member', 'viewer', 'outsider'] as const) {
                expect(`${label}/${role}: ${await call(fx[role])}`).toBe(`${label}/${role}: ${expected[role]}`);
            }
        }
    });
});
