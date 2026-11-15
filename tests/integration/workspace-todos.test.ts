// Workspace tasks on Postgres: /api/workspace-todos create/update/delete/activity + assign/unassign.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// upfly (multer + Cloudinary) is replaced by a middleware that "uploads" whatever the test put in
// globalThis.__uploadedFiles; Cloudinary deletes are a spy. Nothing leaves the machine.
const uploads = globalThis as unknown as { __uploadedFiles?: Record<string, unknown[]> };
vi.mock('upfly', () => ({
    upflyUpload: () => (req: any, _res: any, next: any) => {
        if (uploads.__uploadedFiles) req.files = uploads.__uploadedFiles;
        next();
    },
}));
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

const TODO_KEYS = [
    '_id', 'assignedAt', 'assignees', 'cloudImages', 'completedAt', 'createdAt', 'description', 'dueDate', 'goalType', 'priority',
    'recurrence', 'references', 'reminderDate', 'spaceId', 'status', 'subtasks', 'tags', 'title', 'updatedAt', 'user',
    'visibility', 'workspace',
].sort();

function summary(user: { id: string; name: string; email: string; avatar: string }) {
    return { _id: user.id, name: user.name, email: user.email, avatar: user.avatar };
}

beforeEach(() => {
    delete uploads.__uploadedFiles;
    vi.mocked(batchDeleteFromCloud).mockClear();
});

describe('POST /api/workspace-todos', () => {
    it('creates a workspace task with tags, assignees, reminder, activity and notifications', async () => {
        const { workspace, member, admin } = await createRoleFixture();
        const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
        const remind = new Date(Date.now() + 86_400_000).toISOString();

        const res = await request(app)
            .post('/api/workspace-todos')
            .set('Cookie', authCookie(member))
            .send({
                title: '  Ship the port  ',
                description: '<p>details</p>',
                workspace: workspace.id,
                spaceId: workspace.spaceIds[0],
                tags: ['backend', ' urgent ', 'backend'],
                subtasks: [{ id: 's1', text: 'write tests', isCompleted: false, extra: 'dropped' }],
                references: [{ type: 'doc', refId: 'doc-1', title: 'Spec' }],
                assignees: [admin.id, member.id],
                dueDate: due,
                reminderDate: remind,
                visibility: 'private', // ignored: always a workspace task
            });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toBe('Task created successfully');
        const task = res.body.data;
        expect(Object.keys(task).sort()).toEqual(TODO_KEYS);
        expect(task).toMatchObject({
            title: 'Ship the port',
            description: '<p>details</p>',
            status: 'pending',
            priority: 'medium', // the workspace default, not the schema's 'low'
            visibility: 'workspace',
            workspace: workspace.id,
            spaceId: workspace.spaceIds[0],
            user: summary(member),
            assignees: [summary(admin), summary(member)],
            subtasks: [{ id: 's1', text: 'write tests', isCompleted: false }],
            references: [{ type: 'doc', refId: 'doc-1', title: 'Spec' }],
            dueDate: due,
            reminderDate: remind,
            completedAt: null,
        });
        expect(task.tags.map((t: any) => t.name)).toEqual(['backend', 'urgent']);
        expect(task.assignedAt).not.toBeNull();

        const reminder = await prisma.reminder.findFirstOrThrow({ where: { todoId: task._id } });
        expect(reminder).toMatchObject({ userId: member.id, message: 'Reminder: Ship the port', status: 'pending', emailSent: false });

        const activity = await prisma.activityLog.findMany({ where: { targetTaskId: task._id }, orderBy: { createdAt: 'asc' } });
        expect(activity.map((a) => [a.action, a.actorId, a.targetUserId, a.metadata])).toEqual([
            ['task_created', member.id, null, 'Ship the port'],
            ['task_assigned', member.id, admin.id, 'Ship the port'],
        ]);

        // Only the other assignee is notified (never the creator).
        const notifications = await prisma.notification.findMany({ where: { type: 'task_assigned', metadata: { path: ['taskId'], equals: task._id } } });
        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toMatchObject({
            recipientId: admin.id,
            senderId: member.id,
            category: 'informational',
            title: 'Task Assigned',
            message: 'Member assigned you "Ship the port"',
            metadata: { taskId: task._id, taskTitle: 'Ship the port', workspaceId: workspace.id },
        });
        await vi.waitFor(() => expect(mailsTo(admin.email)).toHaveLength(1));
        expect(mailsTo(admin.email)[0]!.subject).toBe('New task assigned: Ship the port');
        expect(mailsTo(member.email)).toHaveLength(0);
    });

    it('stamps completedAt when created complete; parses multipart-style JSON strings', async () => {
        const { workspace, owner, viewer } = await createRoleFixture();
        const res = await request(app)
            .post('/api/workspace-todos')
            .set('Cookie', authCookie(owner))
            .send({
                title: 'Done already',
                status: 'complete',
                priority: 'high',
                workspace: workspace.id,
                tags: JSON.stringify(['from-form']),
                assignees: JSON.stringify([viewer.id]),
                recurrence: JSON.stringify({ pattern: 'weekly' }),
            });
        expect(res.status).toBe(201);
        expect(res.body.data.completedAt).not.toBeNull();
        expect(res.body.data.tags.map((t: any) => t.name)).toEqual(['from-form']);
        expect(res.body.data.assignees.map((a: any) => a._id)).toEqual([viewer.id]);
        expect(res.body.data.recurrence).toEqual({ pattern: 'weekly', interval: 1 });
    });

    it('replaces __PENDING_UPLOAD_<id>__ placeholders with the uploaded image URLs', async () => {
        const { workspace, owner } = await createRoleFixture();
        uploads.__uploadedFiles = {
            image_img1: [{ cloudUrl: 'https://cdn.example.test/img1.webp', cloudPublicId: 'recollect-todos-workspace/img1' }],
        };
        const res = await request(app)
            .post('/api/workspace-todos')
            .set('Cookie', authCookie(owner))
            .send({
                title: 'With image',
                workspace: workspace.id,
                description: '<img src="__PENDING_UPLOAD_img1__">',
                imageNodeIds: JSON.stringify(['img1']),
            });
        expect(res.status).toBe(201);
        expect(res.body.data.description).toBe('<img src="https://cdn.example.test/img1.webp">');
        expect(res.body.data.cloudImages).toEqual([{ imageId: 'img1', cloudPublicId: 'recollect-todos-workspace/img1' }]);
    });

    it('validates input and permissions with the old messages', async () => {
        const { workspace, owner, viewer, outsider } = await createRoleFixture();
        const other = await createTestWorkspace(outsider);
        const post = (user: { id: string }, body: object) => request(app).post('/api/workspace-todos').set('Cookie', authCookie(user)).send(body);

        for (const body of [{ workspace: workspace.id }, { title: '   ', workspace: workspace.id }]) {
            const res = await post(owner, body);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ message: 'Task title is required' });
        }
        expect((await post(owner, { title: 'x' })).body).toEqual({ message: 'Workspace ID is required for a workspace task' });

        const missing = await post(owner, { title: 'x', workspace: 'nope' });
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ message: 'Workspace not found' });

        for (const user of [viewer, outsider]) {
            const res = await post(user, { title: 'x', workspace: workspace.id });
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ message: 'Viewers cannot create tasks in this workspace' });
        }

        const badStatus = await post(owner, { title: 'x', workspace: workspace.id, status: 'done' });
        expect(badStatus.status).toBe(400);
        expect(badStatus.body).toEqual({ message: '`done` is not a valid enum value for path `status`.' });

        const badDate = await post(owner, { title: 'x', workspace: workspace.id, dueDate: 'not a date' });
        expect(badDate.status).toBe(400);
        expect(badDate.body).toEqual({ message: 'Cast to date failed for value "Invalid Date" (type Date) at path "dueDate"' });

        const foreignSpace = await post(owner, { title: 'x', workspace: workspace.id, spaceId: other.spaceIds[0] });
        expect(foreignSpace.status).toBe(404);
        expect(foreignSpace.body).toEqual({ message: 'Space not found in this workspace' });

        expect(await prisma.todo.count({ where: { workspaceId: workspace.id } })).toBe(0);
        expect((await request(app).post('/api/workspace-todos').send({ title: 'x' })).status).toBe(401);
    });
});

describe('PATCH /api/workspace-todos/:id', () => {
    it('logs status, priority, content and due date changes with the old metadata', async () => {
        const { workspace, owner, member } = await createRoleFixture();
        const oldDue = new Date('2026-11-01T10:00:00.000Z');
        const todo = await createWorkspaceTodoRow(workspace, owner, { title: 'Original', priority: 'low', dueDate: oldDue });
        const newDue = '2026-11-05T10:00:00.000Z';

        const res = await request(app)
            .patch(`/api/workspace-todos/${todo.id}`)
            .set('Cookie', authCookie(member))
            .send({ status: 'complete', priority: 'urgent', title: '  Renamed ', dueDate: newDue, visibility: 'private' });

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Task updated successfully');
        expect(Object.keys(res.body.data).sort()).toEqual(TODO_KEYS);
        expect(res.body.data).toMatchObject({ title: 'Renamed', status: 'complete', priority: 'urgent', dueDate: newDue, visibility: 'workspace' });
        expect(res.body.data.completedAt).not.toBeNull();

        const activity = await prisma.activityLog.findMany({ where: { targetTaskId: todo.id }, orderBy: { createdAt: 'asc' } });
        expect(activity.map((a) => [a.action, a.metadata])).toEqual([
            ['task_completed', 'Original'],
            ['task_priority_changed', 'low → urgent'],
            ['task_content_changed', 'updated the content'],
            ['task_due_date_changed', `${oldDue.toISOString()} → ${newDue}`],
        ]);
        expect(activity.every((a) => a.actorId === member.id && a.workspaceId === workspace.id)).toBe(true);

        // complete → review clears completedAt too (the Mongo-era handler kept it; fixed 11-15).
        const reviewing = await request(app).patch(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(member)).send({ status: 'review' });
        expect(reviewing.body.data).toMatchObject({ status: 'review', completedAt: null });
        const again = await request(app).patch(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(member)).send({ status: 'complete' });
        expect(again.body.data.completedAt).not.toBeNull();

        // complete → pending clears completedAt and logs a status change.
        const back = await request(app).patch(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(member)).send({ status: 'pending' });
        expect(back.body.data.completedAt).toBeNull();
        expect(await prisma.activityLog.count({ where: { targetTaskId: todo.id, action: 'task_status_changed', metadata: 'complete → pending' } })).toBe(1);
    });

    it('replaces assignees: logs assigned/unassigned, notifies only new assignees (not yourself)', async () => {
        const { workspace, owner, admin, member, viewer } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, owner, { title: 'Team task' });
        await prisma.todoAssignee.create({ data: { todoId: todo.id, userId: viewer.id } });

        const res = await request(app)
            .patch(`/api/workspace-todos/${todo.id}`)
            .set('Cookie', authCookie(admin))
            .send({ assignees: [{ _id: member.id }, admin.id, 'not-a-user'] });

        expect(res.status).toBe(200);
        expect(res.body.data.assignees.map((a: any) => a._id)).toEqual([member.id, admin.id]);

        const activity = await prisma.activityLog.findMany({ where: { targetTaskId: todo.id }, orderBy: { createdAt: 'asc' } });
        expect(activity.map((a) => [a.action, a.targetUserId])).toEqual([
            ['task_unassigned', viewer.id],
            ['task_assigned', member.id],
            ['task_assigned', admin.id],
        ]);
        const notified = await prisma.notification.findMany({ where: { type: 'task_assigned', metadata: { path: ['taskId'], equals: todo.id } } });
        expect(notified.map((n) => n.recipientId)).toEqual([member.id]);
        expect(notified[0]!.message).toBe('Admin assigned you "Team task"');
        await vi.waitFor(() => expect(mailsTo(member.email)).toHaveLength(1));

        // A non-array clears them.
        const cleared = await request(app).patch(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(admin)).send({ assignees: 'nobody' });
        expect(cleared.body.data.assignees).toEqual([]);
        expect(cleared.body.data.assignedAt).toBeNull();
    });

    it('tags: a list replaces them, an empty list clears them, no tags key leaves them', async () => {
        const { workspace, owner } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, owner);
        const patch = (body: Record<string, unknown>) => request(app).patch(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(owner)).send(body);
        expect((await patch({ tags: ['a1', 'b1'] })).body.data.tags.map((t: any) => t.name)).toEqual(['a1', 'b1']);
        expect((await patch({ title: 'Renamed' })).body.data.tags.map((t: any) => t.name)).toEqual(['a1', 'b1']);
        expect((await patch({ tags: ['c1'] })).body.data.tags.map((t: any) => t.name)).toEqual(['c1']);
        const cleared = await patch({ tags: [] });
        expect(cleared.status).toBe(200);
        expect(cleared.body.data.tags).toEqual([]);
        expect(await prisma.todoTag.count({ where: { todoId: todo.id } })).toBe(0);
    });

    it('reminders are replaced only when the date changes', async () => {
        const { workspace, owner, member } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, owner, { title: 'Remind me' });
        const at = new Date(Date.now() + 3_600_000).toISOString();
        const patch = (body: object) => request(app).patch(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(member)).send(body);

        await patch({ reminderDate: at });
        const first = await prisma.reminder.findFirstOrThrow({ where: { todoId: todo.id } });
        expect(first).toMatchObject({ userId: member.id, message: 'Reminder: Remind me' });

        await patch({ reminderDate: at, title: 'Renamed' });
        expect((await prisma.reminder.findMany({ where: { todoId: todo.id } })).map((r) => r.id)).toEqual([first.id]);

        const later = new Date(Date.now() + 7_200_000).toISOString();
        await patch({ reminderDate: later });
        const replaced = await prisma.reminder.findMany({ where: { todoId: todo.id } });
        expect(replaced).toHaveLength(1);
        expect(replaced[0]!.id).not.toBe(first.id);
        expect(replaced[0]!.message).toBe('Reminder: Renamed');

        const cleared = await patch({ reminderDate: 'null' });
        expect(cleared.body.data.reminderDate).toBeNull();
        expect(await prisma.reminder.count({ where: { todoId: todo.id } })).toBe(0);
    });

    it('permissions: viewers and outsiders are refused; the creator can always edit', async () => {
        const { workspace, owner, member, viewer, outsider } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, owner);
        const patch = (user: { id: string }, id = todo.id) =>
            request(app).patch(`/api/workspace-todos/${id}`).set('Cookie', authCookie(user)).send({ title: 'Edited' });

        const asViewer = await patch(viewer);
        expect(asViewer.status).toBe(403);
        expect(asViewer.body).toEqual({ message: 'Viewers cannot edit tasks in this workspace' });

        // An assignee who is only a viewer still cannot edit.
        await prisma.todoAssignee.create({ data: { todoId: todo.id, userId: viewer.id } });
        expect((await patch(viewer)).status).toBe(403);

        const asOutsider = await patch(outsider);
        expect(asOutsider.status).toBe(403);
        expect(asOutsider.body).toEqual({ message: "You don't have permission to update this workspace task" });

        // The creator keeps edit rights even after being demoted to viewer (old rule).
        const own = await createWorkspaceTodoRow(workspace, member);
        await prisma.workspaceMember.update({
            where: { workspaceId_userId: { workspaceId: workspace.id, userId: member.id } },
            data: { role: 'viewer' },
        });
        expect((await patch(member, own.id)).status).toBe(200);

        const missing = await patch(owner, 'missing-task');
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ message: 'Task not found' });
    });

    it('validates fields with the Mongoose messages; spaceId must belong to the workspace', async () => {
        const { workspace, owner, outsider } = await createRoleFixture();
        const other = await createTestWorkspace(outsider);
        const todo = await createWorkspaceTodoRow(workspace, owner, { spaceId: workspace.spaceIds[0]! });
        const patch = (body: object) => request(app).patch(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(owner)).send(body);

        expect((await patch({ title: '  ' })).body).toEqual({ message: 'Path `title` is required.' });
        expect((await patch({ priority: 'meh' })).body).toEqual({ message: '`meh` is not a valid enum value for path `priority`.' });
        const foreign = await patch({ spaceId: other.spaceIds[0] });
        expect(foreign.status).toBe(404);
        expect(foreign.body).toEqual({ message: 'Space not found in this workspace' });

        const unset = await patch({ spaceId: 'null' });
        expect(unset.status).toBe(200);
        expect(unset.body.data.spaceId).toBeNull();
    });

    it('appends newly uploaded images to cloudImages', async () => {
        const { workspace, owner } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, owner, { cloudImages: [{ imageId: 'old', cloudPublicId: 'p/old' }] });
        uploads.__uploadedFiles = { image_new1: [{ cloudUrl: 'https://cdn.example.test/new1.webp', cloudPublicId: 'p/new1' }] };
        const res = await request(app)
            .patch(`/api/workspace-todos/${todo.id}`)
            .set('Cookie', authCookie(owner))
            .send({ description: '<img src="__PENDING_UPLOAD_new1__">', imageNodeIds: ['new1'] });
        expect(res.status).toBe(200);
        expect(res.body.data.description).toBe('<img src="https://cdn.example.test/new1.webp">');
        expect(res.body.data.cloudImages).toEqual([
            { imageId: 'old', cloudPublicId: 'p/old' },
            { imageId: 'new1', cloudPublicId: 'p/new1' },
        ]);
    });
});

describe('DELETE /api/workspace-todos/:id', () => {
    it('owner/admin/member delete (reminders and images go too); viewers and outsiders cannot', async () => {
        const { workspace, owner, member, viewer, outsider } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, owner, { cloudImages: [{ imageId: 'i', cloudPublicId: 'p/i' }] });
        await prisma.reminder.create({ data: { userId: owner.id, todoId: todo.id, reminderDate: new Date(Date.now() + 60_000) } });

        const asViewer = await request(app).delete(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(viewer));
        expect(asViewer.status).toBe(403);
        expect(asViewer.body).toEqual({ message: 'Viewers cannot delete tasks in this workspace' });
        const asOutsider = await request(app).delete(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(outsider));
        expect(asOutsider.status).toBe(403);
        expect(asOutsider.body).toEqual({ message: "You don't have permission to delete this workspace task" });

        const res = await request(app).delete(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(member));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Task deleted successfully' });
        expect(await prisma.todo.findUnique({ where: { id: todo.id } })).toBeNull();
        expect(await prisma.reminder.count({ where: { todoId: todo.id } })).toBe(0);
        expect(vi.mocked(batchDeleteFromCloud)).toHaveBeenCalledWith(['p/i']);

        const again = await request(app).delete(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(member));
        expect(again.status).toBe(404);
        expect(again.body).toEqual({ message: 'Task not found' });
    });

    it('a creator who was demoted to viewer cannot delete a workspace task (old rule)', async () => {
        const { workspace, viewer } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, viewer);
        expect((await request(app).delete(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(viewer))).status).toBe(403);
    });
});

describe('GET /api/workspace-todos/:id/activity', () => {
    it('returns the task activity newest first to members only', async () => {
        const { workspace, owner, viewer, outsider } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, owner);
        await prisma.activityLog.create({
            data: { workspaceId: workspace.id, actorId: owner.id, action: 'task_created', targetTaskId: todo.id, createdAt: new Date(Date.now() - 1000) },
        });
        await prisma.activityLog.create({
            data: { workspaceId: workspace.id, actorId: owner.id, action: 'task_assigned', targetTaskId: todo.id, targetUserId: viewer.id },
        });

        const res = await request(app).get(`/api/workspace-todos/${todo.id}/activity`).set('Cookie', authCookie(viewer));
        expect(res.status).toBe(200);
        expect(res.body.data.map((a: any) => a.action)).toEqual(['task_assigned', 'task_created']);
        expect(res.body.data[0]).toMatchObject({ targetTask: todo.id, actor: summary(owner), targetUser: summary(viewer), workspace: workspace.id });

        const forbidden = await request(app).get(`/api/workspace-todos/${todo.id}/activity`).set('Cookie', authCookie(outsider));
        expect(forbidden.status).toBe(403);
        expect(forbidden.body).toEqual({ message: 'Not a member' });
        expect((await request(app).get('/api/workspace-todos/missing/activity').set('Cookie', authCookie(owner))).status).toBe(404);
    });
});

describe('POST /api/workspace-todos/:id/assign', () => {
    it('assigns by email: ghosts for unknown emails, invites for non-members, notifications, activity, emails', async () => {
        const { workspace, owner, member } = await createRoleFixture();
        const stranger = await createTestUser({ name: 'Stranger', email: 'stranger@example.test' });
        const todo = await createWorkspaceTodoRow(workspace, owner, { title: 'Assign me', visibility: 'workspace' });

        const res = await request(app)
            .post(`/api/workspace-todos/${todo.id}/assign`)
            .set('Cookie', authCookie(owner))
            .send({ emails: [member.email.toUpperCase(), 'ghost.person@example.test', ' stranger@example.test ', owner.email, member.email, 42] });

        expect(res.status).toBe(200);
        expect(res.body.message).toBe('Task assigned. Invitations sent to ghost.person@example.test.');
        expect(Object.keys(res.body.data).sort()).toEqual(TODO_KEYS);
        const ghost = await prisma.user.findUniqueOrThrow({ where: { email: 'ghost.person@example.test' } });
        expect(ghost).toMatchObject({ isGhost: true, status: 'pending' });
        expect(res.body.data.assignees.map((a: any) => a._id)).toEqual([member.id, ghost.id, stranger.id]);
        expect(res.body.data.assignedAt).not.toBeNull();

        const invites = await prisma.notification.findMany({ where: { type: 'workspace_invite', metadata: { path: ['workspaceId'], equals: workspace.id } } });
        expect(invites.map((n) => n.recipientId).sort()).toEqual([ghost.id, stranger.id].sort());
        const assignedNotes = await prisma.notification.findMany({ where: { type: 'task_assigned', metadata: { path: ['taskId'], equals: todo.id } } });
        expect(assignedNotes.map((n) => n.recipientId).sort()).toEqual([member.id, ghost.id, stranger.id].sort());
        expect(assignedNotes[0]).toMatchObject({ message: 'Owner assigned you "Assign me"', metadata: { taskId: todo.id, taskTitle: 'Assign me', workspaceId: workspace.id } });
        expect(await prisma.activityLog.count({ where: { targetTaskId: todo.id, action: 'task_assigned' } })).toBe(3);

        await vi.waitFor(() => expect(mailsTo('ghost.person@example.test')).toHaveLength(1));
        expect(mailsTo('ghost.person@example.test')[0]!.subject).toBe(`Owner assigned you a task in "${workspace.name}"`);
        expect(mailsTo('stranger@example.test')[0]!.subject).toBe('New task assigned: Assign me');

        // Again: nothing new, no second invite.
        const again = await request(app).post(`/api/workspace-todos/${todo.id}/assign`).set('Cookie', authCookie(owner)).send({ emails: [stranger.email] });
        expect(again.body.message).toBe('Task assigned successfully.');
        expect(again.body.data.assignees).toHaveLength(3);
        expect(await prisma.notification.count({ where: { recipientId: stranger.id, type: 'workspace_invite' } })).toBe(1);
    });

    it('validates emails, task and role', async () => {
        const { workspace, owner, viewer, outsider } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, owner);
        const personal = await prisma.todo.create({ data: { userId: owner.id, title: 'Personal' } });
        const assign = (user: { id: string }, id: string, body: object) =>
            request(app).post(`/api/workspace-todos/${id}/assign`).set('Cookie', authCookie(user)).send(body);

        expect((await assign(owner, todo.id, {})).body).toEqual({ message: 'Emails array is required' });
        expect((await assign(owner, todo.id, { emails: 'a@b.c' })).body).toEqual({ message: 'Emails array is required' });
        expect((await assign(owner, todo.id, { emails: ['  ', 7] })).body).toEqual({ message: 'At least one valid email is required' });

        for (const id of ['missing', personal.id]) {
            const res = await assign(owner, id, { emails: ['x@example.test'] });
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ message: 'Task not found or you do not own it' });
        }
        for (const user of [viewer, outsider]) {
            const res = await assign(user, todo.id, { emails: ['x@example.test'] });
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ message: 'Viewers cannot modify task assignments' });
        }
        expect(await prisma.user.count({ where: { email: 'x@example.test' } })).toBe(0);
    });
});

describe('POST /api/workspace-todos/:id/unassign', () => {
    it('removes one assignee by email, or all of them', async () => {
        const { workspace, owner, admin, member, viewer } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, owner, { assignedAt: new Date() });
        await prisma.todoAssignee.createMany({
            data: [
                { todoId: todo.id, userId: admin.id, createdAt: new Date(Date.now() - 2) },
                { todoId: todo.id, userId: member.id, createdAt: new Date(Date.now() - 1) },
            ],
        });
        const unassign = (user: { id: string }, body: object) =>
            request(app).post(`/api/workspace-todos/${todo.id}/unassign`).set('Cookie', authCookie(user)).send(body);

        const one = await unassign(member, { email: admin.email.toUpperCase() });
        expect(one.status).toBe(200);
        expect(one.body.message).toBe('Assignee removed');
        expect(one.body.data.assignees.map((a: any) => a._id)).toEqual([member.id]);
        expect(one.body.data.assignedAt).not.toBeNull();

        const all = await unassign(member, {});
        expect(all.body.message).toBe('All assignees removed');
        expect(all.body.data.assignees).toEqual([]);
        expect(all.body.data.assignedAt).toBeNull();
        expect(all.body.data.visibility).toBe('workspace');

        const asViewer = await unassign(viewer, {});
        expect(asViewer.status).toBe(403);
        expect(asViewer.body).toEqual({ message: 'Viewers cannot modify task assignments' });

        const missing = await request(app).post('/api/workspace-todos/missing/unassign').set('Cookie', authCookie(owner)).send({});
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ message: 'Task not found' });
    });
});
