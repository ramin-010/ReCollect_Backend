// Personal todos: /api/todos (CRUD, search-references, assign, unassign).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import request from 'supertest';

// The multipart upload middleware (upfly → Cloudinary) is replaced by a fake: a test puts the
// "uploaded" files in the x-test-files header as JSON. Cloudinary deletes are a spy.
vi.mock('upfly', () => ({
    upflyUpload: () => (req: any, _res: any, next: any) => {
        const spec = req.headers['x-test-files'];
        if (typeof spec === 'string') req.files = JSON.parse(spec);
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

type TodoData = Parameters<typeof prisma.todo.create>[0]['data'];

function todoRow(userId: string, data: Partial<Record<string, unknown>> = {}) {
    return prisma.todo.create({ data: { userId, title: 'A task', ...data } as TodoData });
}

const userKeys = ['_id', 'avatar', 'email', 'name'];

describe('POST /api/todos', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).post('/api/todos').send({ title: 'x' })).status).toBe(401);
    });

    it('400 "Task title is required" for a missing or blank title', async () => {
        const user = await createTestUser();
        for (const body of [{}, { title: '   ' }, { title: 5 }]) {
            const res = await request(app).post('/api/todos').set('Cookie', authCookie(user)).send(body);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ message: 'Task title is required' });
        }
    });

    it('creates a personal task with the old defaults and shape', async () => {
        const user = await createTestUser({ name: 'Creator' });
        const res = await request(app).post('/api/todos').set('Cookie', authCookie(user)).send({ title: '  Write tests  ' });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toBe('Task created successfully');
        const todo = res.body.data;
        expect(todo).toMatchObject({
            title: 'Write tests',
            description: null,
            status: 'pending',
            priority: 'medium', // the old controller default (schema default was 'low')
            dueDate: null,
            reminderDate: null,
            completedAt: null,
            subtasks: [],
            cloudImages: [],
            tags: [],
            recurrence: null,
            assignees: [],
            assignedAt: null,
            visibility: 'private',
            workspace: null,
            spaceId: null,
            references: [],
        });
        expect(typeof todo._id).toBe('string');
        expect(todo.user).toEqual({ _id: user.id, name: 'Creator', email: user.email, avatar: '' });
        expect(todo).not.toHaveProperty('id');
        expect(todo).not.toHaveProperty('userId');
        expect(todo).not.toHaveProperty('workspaceId');
    });

    it('creates tags by name (trimmed, de-duplicated, reused, input order) and parses JSON-string fields', async () => {
        const user = await createTestUser();
        await prisma.tag.create({ data: { name: 'existing' } });

        const res = await request(app)
            .post('/api/todos')
            .set('Cookie', authCookie(user))
            .send({
                title: 'Tagged',
                tags: JSON.stringify(['brand-new', ' existing ', 'brand-new', '']),
                subtasks: JSON.stringify([{ id: 's1', text: 'Step one' }]),
                references: JSON.stringify([{ type: 'doc', refId: 'cdocref', title: 'Spec' }]),
                recurrence: JSON.stringify({ pattern: 'weekly', interval: 2 }),
                visibility: 'shared',
            });

        expect(res.status).toBe(201);
        expect(res.body.data.tags.map((t: any) => t.name)).toEqual(['brand-new', 'existing']);
        for (const tag of res.body.data.tags) expect(Object.keys(tag).sort()).toEqual(['_id', 'name']);
        expect(res.body.data).toMatchObject({
            subtasks: [{ id: 's1', text: 'Step one', isCompleted: false }],
            references: [{ type: 'doc', refId: 'cdocref', title: 'Spec' }],
            recurrence: { pattern: 'weekly', interval: 2 },
            visibility: 'shared',
        });
        expect(await prisma.tag.count({ where: { name: { in: ['brand-new', 'existing'] } } })).toBe(2);

        // A second task with the same names reuses the rows.
        const again = await request(app).post('/api/todos').set('Cookie', authCookie(user)).send({ title: 'Again', tags: ['existing', 'brand-new'] });
        expect(again.body.data.tags.map((t: any) => t.name)).toEqual(['existing', 'brand-new']);
        expect(await prisma.tag.count({ where: { name: { in: ['brand-new', 'existing'] } } })).toBe(2);
    });

    it('completing on creation stamps completedAt (the old pre-save hook)', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/todos').set('Cookie', authCookie(user)).send({ title: 'Done already', status: 'complete' });
        expect(res.status).toBe(201);
        expect(res.body.data.status).toBe('complete');
        expect(new Date(res.body.data.completedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('a reminderDate creates a pending todo reminder', async () => {
        const user = await createTestUser();
        const res = await request(app)
            .post('/api/todos')
            .set('Cookie', authCookie(user))
            .send({ title: ' Call the bank ', reminderDate: '2030-01-01T09:00:00.000Z' });

        expect(res.status).toBe(201);
        const reminders = await prisma.reminder.findMany({ where: { todoId: res.body.data._id } });
        expect(reminders).toHaveLength(1);
        expect(reminders[0]).toMatchObject({
            userId: user.id,
            type: 'todo',
            message: 'Reminder: Call the bank',
            emailSent: false,
            status: 'pending',
            reminderDate: new Date('2030-01-01T09:00:00.000Z'),
        });
    });

    it('a reminder already past moves to the due time while that is ahead, and is dropped when both have passed', async () => {
        const user = await createTestUser();
        const soon = new Date(Date.now() + 5 * 60_000);
        const past = new Date(Date.now() - 5 * 60_000);
        const a = await request(app).post('/api/todos').set('Cookie', authCookie(user)).send({ title: 'Soon', dueDate: soon.toISOString(), reminderDate: past.toISOString() });
        expect(a.status).toBe(201);
        expect(a.body.data.reminderDate).toBe(soon.toISOString());
        const ra = await prisma.reminder.findMany({ where: { todoId: a.body.data._id } });
        expect(ra.map((r) => r.reminderDate.toISOString())).toEqual([soon.toISOString()]);

        const b = await request(app)
            .post('/api/todos')
            .set('Cookie', authCookie(user))
            .send({ title: 'Gone by', dueDate: past.toISOString(), reminderDate: new Date(past.getTime() - 10 * 60_000).toISOString() });
        expect(b.status).toBe(201);
        expect(b.body.data.reminderDate).toBeNull();
        expect(await prisma.reminder.count({ where: { todoId: b.body.data._id } })).toBe(0);

        const c = await request(app).patch(`/api/todos/${b.body.data._id}`).set('Cookie', authCookie(user)).send({ dueDate: soon.toISOString(), reminderDate: past.toISOString() });
        expect(c.status).toBe(200);
        expect(c.body.data.reminderDate).toBe(soon.toISOString());
    });

    it('ticking a repeating task brings its next time; un-ticking takes it back', async () => {
        const user = await createTestUser();
        const due = new Date(Date.now() + 2 * 3_600_000);
        const created = await request(app)
            .post('/api/todos')
            .set('Cookie', authCookie(user))
            .send({ title: 'Gym', dueDate: due.toISOString(), reminderDate: new Date(due.getTime() - 10 * 60_000).toISOString(), recurrence: { pattern: 'weekly', interval: 1 }, tags: ['health'] });
        expect(created.status).toBe(201);
        const id = created.body.data._id;

        const done = await request(app).patch(`/api/todos/${id}`).set('Cookie', authCookie(user)).send({ status: 'complete' });
        expect(done.status).toBe(200);
        const next = await prisma.todo.findMany({ where: { userId: user.id, title: 'Gym', status: 'pending' }, include: { tags: true, reminders: true } });
        expect(next).toHaveLength(1);
        const spawned = next[0]!;
        expect(spawned.dueDate!.getTime()).toBe(due.getTime() + 7 * 86_400_000);
        expect(spawned.reminderDate!.getTime()).toBe(due.getTime() + 7 * 86_400_000 - 10 * 60_000);
        expect(spawned.tags).toHaveLength(1);
        expect(spawned.reminders).toHaveLength(1);
        expect(spawned.recurrence).toEqual({ pattern: 'weekly', interval: 1 });

        const back = await request(app).patch(`/api/todos/${id}`).set('Cookie', authCookie(user)).send({ status: 'pending' });
        expect(back.status).toBe(200);
        expect(await prisma.todo.count({ where: { userId: user.id, title: 'Gym' } })).toBe(1);
    });

    it('a repeating task ticked late comes back on its next day still ahead', async () => {
        const user = await createTestUser();
        const due = new Date(Date.now() - 3 * 86_400_000);
        const created = await request(app).post('/api/todos').set('Cookie', authCookie(user)).send({ title: 'Water plants', dueDate: due.toISOString(), recurrence: { pattern: 'daily', interval: 1 } });
        await request(app).patch(`/api/todos/${created.body.data._id}`).set('Cookie', authCookie(user)).send({ status: 'complete' });
        const next = await prisma.todo.findFirst({ where: { userId: user.id, title: 'Water plants', status: 'pending' } });
        expect(next!.dueDate!.getTime()).toBe(due.getTime() + 4 * 86_400_000);
        expect(next!.dueDate!.getTime()).toBeGreaterThan(Date.now());
    });

    it("a date-only dueDate is that day in the user's time zone (18:00 IST), not UTC midnight", async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/todos').set('Cookie', authCookie(user)).send({ title: 'AI task', dueDate: '2026-10-22' });
        expect(res.status).toBe(201);
        expect(res.body.data.dueDate).toBe('2026-10-22T12:30:00.000Z');

        const exact = await request(app)
            .post('/api/todos')
            .set('Cookie', authCookie(user))
            .send({ title: 'Exact', dueDate: '2026-10-22T04:15:00.000Z' });
        expect(exact.body.data.dueDate).toBe('2026-10-22T04:15:00.000Z');
    });

    it('400 with the Mongoose messages for bad enums, dates and subdocuments', async () => {
        const user = await createTestUser();
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ status: 'done' }, '`done` is not a valid enum value for path `status`.'],
            [{ priority: 'critical' }, '`critical` is not a valid enum value for path `priority`.'],
            [{ dueDate: 'someday' }, 'Cast to date failed for value "Invalid Date" (type Date) at path "dueDate"'],
            [{ subtasks: [{ text: 'no id' }] }, 'Path `id` is required.'],
            [{ references: [{ type: 'video', refId: 'x' }] }, '`video` is not a valid enum value for path `type`.'],
            [{ recurrence: { pattern: 'yearly' } }, '`yearly` is not a valid enum value for path `pattern`.'],
        ];
        for (const [extra, message] of cases) {
            const res = await request(app).post('/api/todos').set('Cookie', authCookie(user)).send({ title: 'Bad', ...extra });
            expect(res.status, JSON.stringify(extra)).toBe(400);
            expect(res.body).toEqual({ message });
        }
        expect(await prisma.todo.count({ where: { userId: user.id } })).toBe(0);
    });

    it('replaces uploaded image placeholders and records the cloud images', async () => {
        const user = await createTestUser();
        const files = { image_img1: [{ cloudUrl: 'https://cdn.example.test/img1.webp', cloudPublicId: 'recollect-todos/img1' }] };
        const res = await request(app)
            .post('/api/todos')
            .set('Cookie', authCookie(user))
            .set('x-test-files', JSON.stringify(files))
            .send({ title: 'With image', description: '<p><img src="__PENDING_UPLOAD_img1__"></p>', imageNodeIds: JSON.stringify(['img1']) });

        expect(res.status).toBe(201);
        expect(res.body.data.description).toBe('<p><img src="https://cdn.example.test/img1.webp"></p>');
        expect(res.body.data.cloudImages).toEqual([{ imageId: 'img1', cloudPublicId: 'recollect-todos/img1' }]);
    });

    it('assignee ids on create: real users are kept (populated), unknown ids dropped', async () => {
        const user = await createTestUser();
        const helper = await createTestUser({ name: 'Helper' });
        const res = await request(app)
            .post('/api/todos')
            .set('Cookie', authCookie(user))
            .send({ title: 'Shared work', assignees: [helper.id, 'cnotauser000000000000000'] });

        expect(res.status).toBe(201);
        expect(res.body.data.assignees).toEqual([{ _id: helper.id, name: 'Helper', email: helper.email, avatar: '' }]);
        expect(res.body.data.assignedAt).not.toBeNull();
    });
});

describe('GET /api/todos', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).get('/api/todos')).status).toBe(401);
    });

    it("returns my own and assigned personal tasks, newest update first, never workspace tasks or others' tasks", async () => {
        const me = await createTestUser();
        const other = await createTestUser();
        const ws = await prisma.workspace.create({ data: { name: 'WS', ownerId: me.id } });

        const older = await todoRow(me.id, { title: 'Mine older', updatedAt: new Date('2026-01-01T00:00:00Z') });
        const assignedToMe = await todoRow(other.id, { title: 'Assigned to me', visibility: 'shared' });
        await prisma.todoAssignee.create({ data: { todoId: assignedToMe.id, userId: me.id } });
        await todoRow(other.id, { title: 'Not mine' });
        await todoRow(me.id, { title: 'Workspace task', visibility: 'workspace', workspaceId: ws.id });
        const newest = await todoRow(me.id, { title: 'Mine newest' });

        const res = await request(app).get('/api/todos').set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const titles = res.body.data.map((t: any) => t.title);
        expect(new Set(titles)).toEqual(new Set(['Mine older', 'Assigned to me', 'Mine newest']));
        expect(res.body.count).toBe(3);
        expect(titles[titles.length - 1]).toBe('Mine older');
        expect(titles.indexOf('Mine newest')).toBeLessThan(titles.indexOf('Mine older'));

        const shared = res.body.data.find((t: any) => t._id === assignedToMe.id);
        expect(shared.user._id).toBe(other.id);
        expect(shared.assignees).toHaveLength(1);
        expect(Object.keys(shared.assignees[0]).sort()).toEqual(userKeys);
        expect(res.body.data.find((t: any) => t._id === newest.id).workspace).toBeNull();
        expect(older.id).toBeTruthy();
    });

    it('filters by status (pending|complete), priority (low|medium|high) and refType+refId; other values are ignored', async () => {
        const me = await createTestUser();
        await todoRow(me.id, { title: 'P-low', status: 'pending', priority: 'low' });
        await todoRow(me.id, { title: 'C-high', status: 'complete', priority: 'high' });
        await todoRow(me.id, { title: 'Linked', references: [{ type: 'doc', refId: 'cdocA', title: 'A' }] });
        await todoRow(me.id, { title: 'Linked slide', references: [{ type: 'slide', refId: 'cdocA' }] });

        const get = async (query: Record<string, string>) =>
            (await request(app).get('/api/todos').query(query).set('Cookie', authCookie(me))).body.data.map((t: any) => t.title).sort();

        expect(await get({ status: 'complete' })).toEqual(['C-high']);
        expect(await get({ priority: 'high' })).toEqual(['C-high']);
        expect((await get({ status: 'in_progress' })).length).toBe(4); // ignored, like before
        expect((await get({ priority: 'urgent' })).length).toBe(4);
        expect(await get({ refType: 'doc', refId: 'cdocA' })).toEqual(['Linked']);
        expect(await get({ refType: 'slide', refId: 'cdocA' })).toEqual(['Linked slide']);
        expect((await get({ refId: 'cdocA' })).length).toBe(4); // refType is required, as before
    });
});

describe('PATCH /api/todos/:id', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).patch('/api/todos/whatever').send({ title: 'x' })).status).toBe(401);
    });

    it('404 "Task not found" for an unknown id', async () => {
        const me = await createTestUser();
        const res = await request(app).patch('/api/todos/cdoesnotexist000000000000').set('Cookie', authCookie(me)).send({ title: 'x' });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ message: 'Task not found' });
    });

    it("403 for someone else's task and for a workspace task; an assignee may update", async () => {
        const owner = await createTestUser();
        const stranger = await createTestUser();
        const assignee = await createTestUser();
        const todo = await todoRow(owner.id, { visibility: 'shared' });
        await prisma.todoAssignee.create({ data: { todoId: todo.id, userId: assignee.id } });
        const ws = await prisma.workspace.create({ data: { name: 'W', ownerId: owner.id } });
        const wsTodo = await todoRow(owner.id, { visibility: 'workspace', workspaceId: ws.id });

        const denied = await request(app).patch(`/api/todos/${todo.id}`).set('Cookie', authCookie(stranger)).send({ title: 'Hijack' });
        expect(denied.status).toBe(403);
        expect(denied.body).toEqual({ message: "You don't have permission to update this personal task" });

        const workspace = await request(app).patch(`/api/todos/${wsTodo.id}`).set('Cookie', authCookie(owner)).send({ title: 'Nope' });
        expect(workspace.status).toBe(403);

        const ok = await request(app).patch(`/api/todos/${todo.id}`).set('Cookie', authCookie(assignee)).send({ status: 'complete' });
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ success: true, message: 'Task updated successfully', data: { _id: todo.id, status: 'complete' } });
    });

    it('completedAt: set when it becomes complete, cleared when it leaves complete for any state', async () => {
        const me = await createTestUser();
        const todo = await todoRow(me.id);
        const patch = (body: Record<string, unknown>) => request(app).patch(`/api/todos/${todo.id}`).set('Cookie', authCookie(me)).send(body);

        const done = await patch({ status: 'complete' });
        const completedAt = done.body.data.completedAt;
        expect(completedAt).not.toBeNull();

        const again = await patch({ status: 'complete' }); // already complete: unchanged
        expect(again.body.data.completedAt).toBe(completedAt);

        // Back to review (or in progress, or blocked): no longer completed (the Mongo-era handler kept the date).
        const reviewing = await patch({ status: 'review' });
        expect(reviewing.body.data).toMatchObject({ status: 'review', completedAt: null });

        const restamped = await patch({ status: 'complete' }); // review → complete stamps it again
        expect(restamped.body.data.completedAt).not.toBeNull();
        expect(new Date(restamped.body.data.completedAt).getTime()).toBeGreaterThanOrEqual(new Date(completedAt).getTime());

        // A change that doesn't touch the status keeps the date.
        const renamed = await patch({ title: 'Renamed while complete' });
        expect(renamed.body.data.completedAt).toBe(restamped.body.data.completedAt);

        for (const status of ['in_progress', 'blocked'] as const) {
            await patch({ status: 'complete' });
            expect((await patch({ status })).body.data).toMatchObject({ status, completedAt: null });
        }

        await patch({ status: 'complete' });
        const reopened = await patch({ status: 'pending' });
        expect(reopened.body.data).toMatchObject({ status: 'pending', completedAt: null });
    });

    it('complete → pending clears completedAt', async () => {
        const me = await createTestUser();
        const todo = await todoRow(me.id, { status: 'complete', completedAt: new Date('2026-01-01T00:00:00Z') });
        const res = await request(app).patch(`/api/todos/${todo.id}`).set('Cookie', authCookie(me)).send({ status: 'pending' });
        expect(res.body.data).toMatchObject({ status: 'pending', completedAt: null });
    });

    it('applies only the allowed keys, trims the title and ignores the rest', async () => {
        const me = await createTestUser();
        const other = await createTestUser();
        const todo = await todoRow(me.id);
        const res = await request(app)
            .patch(`/api/todos/${todo.id}`)
            .set('Cookie', authCookie(me))
            .send({
                title: '  Renamed  ',
                description: '<p>new</p>',
                priority: 'urgent',
                subtasks: [{ id: 'a', text: 'A', isCompleted: true }],
                references: JSON.stringify([{ type: 'doc', refId: 'cdocZ' }]),
                recurrence: { pattern: 'daily' },
                labels: [{ id: 'l1', name: 'ignored', color: 'blue' }],
                spaceId: 'cspace',
                workspace: 'cws',
                userId: other.id,
            });

        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({
            title: 'Renamed',
            description: '<p>new</p>',
            priority: 'urgent',
            subtasks: [{ id: 'a', text: 'A', isCompleted: true }],
            references: [{ type: 'doc', refId: 'cdocZ' }],
            recurrence: { pattern: 'daily', interval: 1 },
            spaceId: null,
            workspace: null,
            user: { _id: me.id },
        });
        expect(res.body.data).not.toHaveProperty('labels');

        const cleared = await request(app).patch(`/api/todos/${todo.id}`).set('Cookie', authCookie(me)).send({ recurrence: null });
        expect(cleared.body.data.recurrence).toBeNull();
    });

    it('400 with the Mongoose messages (empty title, bad enum)', async () => {
        const me = await createTestUser();
        const todo = await todoRow(me.id);
        const blank = await request(app).patch(`/api/todos/${todo.id}`).set('Cookie', authCookie(me)).send({ title: '   ' });
        expect(blank.status).toBe(400);
        expect(blank.body).toEqual({ message: 'Path `title` is required.' });

        const bad = await request(app).patch(`/api/todos/${todo.id}`).set('Cookie', authCookie(me)).send({ status: 'done' });
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ message: '`done` is not a valid enum value for path `status`.' });
    });

    it("dates: 'null', empty and unparsable values clear the date; date-only is the local day", async () => {
        const me = await createTestUser();
        const todo = await todoRow(me.id, { dueDate: new Date('2026-05-01T00:00:00Z') });
        const patch = (body: Record<string, unknown>) => request(app).patch(`/api/todos/${todo.id}`).set('Cookie', authCookie(me)).send(body);

        expect((await patch({ dueDate: '2026-10-22' })).body.data.dueDate).toBe('2026-10-22T12:30:00.000Z');
        expect((await patch({ dueDate: 'null' })).body.data.dueDate).toBeNull();
        await patch({ dueDate: '2026-11-01T10:00:00.000Z' });
        expect((await patch({ dueDate: 'garbage' })).body.data.dueDate).toBeNull();
    });

    it('reminderDate replaces the reminders; absent leaves them alone; null removes them', async () => {
        const me = await createTestUser();
        const todo = await todoRow(me.id, { title: 'Pay rent' });
        await prisma.reminder.create({ data: { userId: me.id, todoId: todo.id, reminderDate: new Date('2030-01-01T00:00:00Z') } });
        const patch = (body: Record<string, unknown>) => request(app).patch(`/api/todos/${todo.id}`).set('Cookie', authCookie(me)).send(body);

        await patch({ title: 'Pay rent today' });
        expect(await prisma.reminder.count({ where: { todoId: todo.id } })).toBe(1);

        const res = await patch({ reminderDate: '2030-02-02T08:00:00.000Z' });
        expect(res.body.data.reminderDate).toBe('2030-02-02T08:00:00.000Z');
        const reminders = await prisma.reminder.findMany({ where: { todoId: todo.id } });
        expect(reminders).toHaveLength(1);
        expect(reminders[0]).toMatchObject({ message: 'Reminder: Pay rent today', status: 'pending', reminderDate: new Date('2030-02-02T08:00:00.000Z') });

        await patch({ reminderDate: null });
        expect(await prisma.reminder.count({ where: { todoId: todo.id } })).toBe(0);
    });

    it('tags: a list replaces them, an empty list clears them, no tags key leaves them', async () => {
        const me = await createTestUser();
        const todo = await todoRow(me.id);
        const patch = (body: Record<string, unknown>) => request(app).patch(`/api/todos/${todo.id}`).set('Cookie', authCookie(me)).send(body);

        expect((await patch({ tags: ['one', 'two'] })).body.data.tags.map((t: any) => t.name)).toEqual(['one', 'two']);
        expect((await patch({ tags: JSON.stringify(['three']) })).body.data.tags.map((t: any) => t.name)).toEqual(['three']);
        expect((await patch({ priority: 'high' })).body.data.tags.map((t: any) => t.name)).toEqual(['three']);
        const cleared = await patch({ tags: [] });
        expect(cleared.status).toBe(200);
        expect(cleared.body.data.tags).toEqual([]);
        expect(await prisma.todoTag.count({ where: { todoId: todo.id } })).toBe(0);
        expect(await prisma.tag.count({ where: { name: 'three' } })).toBe(1); // tags are global: the label stays
        // A JSON-string empty list (multipart) clears too.
        await patch({ tags: ['four'] });
        expect((await patch({ tags: '[]' })).body.data.tags).toEqual([]);
    });

    it('goalType: accepted on create and update; a dateless goal gets its due day at 18:00 local', async () => {
        const me = await createTestUser();
        const post = (body: Record<string, unknown>) => request(app).post('/api/todos').set('Cookie', authCookie(me)).send(body);

        const plain = await post({ title: 'No goal' });
        expect(plain.body.data.goalType).toBe('NONE');
        expect(plain.body.data.dueDate).toBeNull();

        const weekly = await post({ title: 'Weekly goal', goalType: 'WEEKLY' });
        expect(weekly.status).toBe(201);
        expect(weekly.body.data.goalType).toBe('WEEKLY');
        const due = new Date(weekly.body.data.dueDate);
        // 18:00 in Asia/Kolkata (the default zone) = 12:30Z, on a Sunday there.
        expect(due.getUTCHours() * 60 + due.getUTCMinutes()).toBe(12 * 60 + 30);
        expect(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(due)).toBe('Sun');

        const dated = await post({ title: 'Monthly with date', goalType: 'MONTHLY', dueDate: '2030-01-05' });
        expect(dated.body.data.dueDate).toBe('2030-01-05T12:30:00.000Z'); // an explicit date wins

        expect((await post({ title: 'Bad', goalType: 'YEARLY' })).status).toBe(400);

        const patched = await request(app).patch(`/api/todos/${plain.body.data._id}`).set('Cookie', authCookie(me)).send({ goalType: 'MONTHLY' });
        expect(patched.body.data.goalType).toBe('MONTHLY');
        expect(patched.body.data.dueDate).not.toBeNull();
    });

    it('assignees: a list replaces them (assignedAt set), anything else clears them', async () => {
        const me = await createTestUser();
        const a = await createTestUser({ name: 'A' });
        const b = await createTestUser({ name: 'B' });
        const todo = await todoRow(me.id);
        const patch = (body: Record<string, unknown>) => request(app).patch(`/api/todos/${todo.id}`).set('Cookie', authCookie(me)).send(body);

        const set = await patch({ assignees: [b.id, a.id] });
        expect(set.body.data.assignees.map((u: any) => u._id)).toEqual([b.id, a.id]);
        expect(set.body.data.assignedAt).not.toBeNull();

        const cleared = await patch({ assignees: 'nobody' });
        expect(cleared.body.data).toMatchObject({ assignees: [], assignedAt: null });
    });

    it('appends newly uploaded images to cloudImages', async () => {
        const me = await createTestUser();
        const todo = await todoRow(me.id, { cloudImages: [{ imageId: 'old', cloudPublicId: 'recollect-todos/old' }] });
        const files = { image_new1: [{ cloudUrl: 'https://cdn.example.test/new1.webp', cloudPublicId: 'recollect-todos/new1' }] };
        const res = await request(app)
            .patch(`/api/todos/${todo.id}`)
            .set('Cookie', authCookie(me))
            .set('x-test-files', JSON.stringify(files))
            .send({ description: '<img src="__PENDING_UPLOAD_new1__">', imageNodeIds: '["new1"]' });

        expect(res.status).toBe(200);
        expect(res.body.data.description).toBe('<img src="https://cdn.example.test/new1.webp">');
        expect(res.body.data.cloudImages).toEqual([
            { imageId: 'old', cloudPublicId: 'recollect-todos/old' },
            { imageId: 'new1', cloudPublicId: 'recollect-todos/new1' },
        ]);
    });
});

describe('DELETE /api/todos/:id', () => {
    beforeEach(() => {
        vi.mocked(batchDeleteFromCloud).mockClear();
    });

    it('401 without a cookie; 404 for an unknown id', async () => {
        expect((await request(app).delete('/api/todos/x')).status).toBe(401);
        const me = await createTestUser();
        const res = await request(app).delete('/api/todos/cdoesnotexist000000000000').set('Cookie', authCookie(me));
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ message: 'Task not found' });
    });

    it('403 for a stranger, an assignee, and a workspace task', async () => {
        const owner = await createTestUser();
        const assignee = await createTestUser();
        const todo = await todoRow(owner.id);
        await prisma.todoAssignee.create({ data: { todoId: todo.id, userId: assignee.id } });
        const ws = await prisma.workspace.create({ data: { name: 'W2', ownerId: owner.id } });
        const wsTodo = await todoRow(owner.id, { visibility: 'workspace', workspaceId: ws.id });

        const asAssignee = await request(app).delete(`/api/todos/${todo.id}`).set('Cookie', authCookie(assignee));
        expect(asAssignee.status).toBe(403);
        expect(asAssignee.body).toEqual({ message: "You don't have permission to delete this personal task" });
        expect((await request(app).delete(`/api/todos/${wsTodo.id}`).set('Cookie', authCookie(owner))).status).toBe(403);
        expect(await prisma.todo.count({ where: { id: { in: [todo.id, wsTodo.id] } } })).toBe(2);
    });

    it('deletes the task with its reminders, tags and assignees, then its Cloudinary images', async () => {
        const me = await createTestUser();
        const helper = await createTestUser();
        const tag = await prisma.tag.create({ data: { name: `del-${Date.now()}` } });
        const todo = await todoRow(me.id, {
            cloudImages: [
                { imageId: 'a', cloudPublicId: 'recollect-todos/a' },
                { imageId: 'b', cloudPublicId: 'recollect-todos/b' },
            ],
        });
        await prisma.todoTag.create({ data: { todoId: todo.id, tagId: tag.id } });
        await prisma.todoAssignee.create({ data: { todoId: todo.id, userId: helper.id } });
        await prisma.reminder.create({ data: { userId: me.id, todoId: todo.id, reminderDate: new Date() } });

        const res = await request(app).delete(`/api/todos/${todo.id}`).set('Cookie', authCookie(me));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, message: 'Task deleted successfully' });
        expect(await prisma.todo.count({ where: { id: todo.id } })).toBe(0);
        expect(await prisma.reminder.count({ where: { todoId: todo.id } })).toBe(0);
        expect(await prisma.todoTag.count({ where: { todoId: todo.id } })).toBe(0);
        expect(await prisma.todoAssignee.count({ where: { todoId: todo.id } })).toBe(0);
        expect(await prisma.tag.count({ where: { id: tag.id } })).toBe(1); // tags are global
        expect(vi.mocked(batchDeleteFromCloud)).toHaveBeenCalledWith(['recollect-todos/a', 'recollect-todos/b']);
    });
});

describe('GET /api/todos/search-references', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).get('/api/todos/search-references')).status).toBe(401);
    });

    it('my own and shared docs, not archived, title contains q (literally), newest first, at most 10', async () => {
        const me = await createTestUser();
        const other = await createTestUser();
        const own = await prisma.doc.create({ data: { userId: me.id, title: 'Plan 100% done' } });
        const shared = await prisma.doc.create({ data: { userId: other.id, title: 'Shared PLAN' } });
        await prisma.docCollaborator.create({ data: { docId: shared.id, userId: me.id } });
        await prisma.doc.create({ data: { userId: me.id, title: 'Archived plan', isArchived: true } });
        await prisma.doc.create({ data: { userId: other.id, title: 'Plan of someone else' } });
        const untitled = await prisma.doc.create({ data: { userId: me.id, title: '' } });

        const search = async (q?: string) =>
            (await request(app).get('/api/todos/search-references').query(q === undefined ? {} : { q }).set('Cookie', authCookie(me))).body;

        const plan = await search('plan');
        expect(plan.success).toBe(true);
        expect(plan.data.map((r: any) => r.refId).sort()).toEqual([own.id, shared.id].sort());
        for (const r of plan.data) expect(Object.keys(r).sort()).toEqual(['refId', 'title', 'type']);
        expect(plan.data[0].type).toBe('doc');

        expect((await search('100%')).data.map((r: any) => r.refId)).toEqual([own.id]);
        expect((await search('_')).data).toEqual([]);

        const all = await search();
        expect(all.data.find((r: any) => r.refId === untitled.id).title).toBe('Untitled Doc');

        for (let i = 0; i < 11; i += 1) await prisma.doc.create({ data: { userId: me.id, title: `Bulk ${i}` } });
        expect((await search('bulk')).data).toHaveLength(10);
    });
});

describe('POST /api/todos/:id/assign', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).post('/api/todos/x/assign').send({ emails: ['a@b.c'] })).status).toBe(401);
    });

    it('400 for a missing emails array or no valid email', async () => {
        const me = await createTestUser();
        const todo = await todoRow(me.id);
        const missing = await request(app).post(`/api/todos/${todo.id}/assign`).set('Cookie', authCookie(me)).send({ emails: 'a@b.c' });
        expect(missing.status).toBe(400);
        expect(missing.body).toEqual({ message: 'Emails array is required' });
        const empty = await request(app).post(`/api/todos/${todo.id}/assign`).set('Cookie', authCookie(me)).send({ emails: ['  '] });
        expect(empty.status).toBe(400);
        expect(empty.body).toEqual({ message: 'At least one valid email is required' });
    });

    it("404 when the task isn't mine or is a workspace task", async () => {
        const owner = await createTestUser();
        const stranger = await createTestUser();
        const todo = await todoRow(owner.id);
        const ws = await prisma.workspace.create({ data: { name: 'W3', ownerId: owner.id } });
        const wsTodo = await todoRow(owner.id, { visibility: 'workspace', workspaceId: ws.id });

        const res = await request(app).post(`/api/todos/${todo.id}/assign`).set('Cookie', authCookie(stranger)).send({ emails: ['x@example.test'] });
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ message: 'Task not found or you do not own it' });
        const workspace = await request(app).post(`/api/todos/${wsTodo.id}/assign`).set('Cookie', authCookie(owner)).send({ emails: ['x@example.test'] });
        expect(workspace.status).toBe(404);
    });

    it('assigns existing users and new emails (placeholder users), notifies each, skips self and duplicates', async () => {
        const me = await createTestUser({ name: 'Boss' });
        const colleague = await createTestUser({ email: 'colleague@example.test', name: 'Colleague' });
        const todo = await todoRow(me.id, { title: 'Ship it' });

        const res = await request(app)
            .post(`/api/todos/${todo.id}/assign`)
            .set('Cookie', authCookie(me))
            .send({ emails: ['Colleague@Example.test', ' newbie@example.test ', me.email, 'newbie@example.test'] });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toBe('Task assigned. Invitations sent to newbie@example.test.');
        expect(res.body.data).toMatchObject({ _id: todo.id, visibility: 'shared' });
        expect(res.body.data.assignedAt).not.toBeNull();
        const assignees = res.body.data.assignees;
        expect(assignees.map((a: any) => a.email)).toEqual(['colleague@example.test', 'newbie@example.test']);
        for (const a of assignees) expect(Object.keys(a).sort()).toEqual(userKeys);

        const ghost = await prisma.user.findUniqueOrThrow({ where: { email: 'newbie@example.test' } });
        expect(ghost).toMatchObject({ isGhost: true, status: 'pending', name: 'newbie' });

        const notifications = await prisma.notification.findMany({ where: { type: 'task_assigned', senderId: me.id }, orderBy: { createdAt: 'asc' } });
        expect(notifications.map((n) => n.recipientId).sort()).toEqual([colleague.id, ghost.id].sort());
        expect(notifications[0]).toMatchObject({
            category: 'informational',
            title: 'Task Assigned',
            message: 'Boss assigned you "Ship it"',
            metadata: { taskId: todo.id, taskTitle: 'Ship it', workspaceId: null },
            status: 'pending',
            isRead: false,
        });

        // Again: nobody new → no new notifications, the plain message.
        const again = await request(app).post(`/api/todos/${todo.id}/assign`).set('Cookie', authCookie(me)).send({ emails: ['colleague@example.test'] });
        expect(again.body.message).toBe('Task assigned successfully.');
        expect(await prisma.notification.count({ where: { type: 'task_assigned', senderId: me.id } })).toBe(2);

        // The assignee now sees the task.
        const theirs = await request(app).get('/api/todos').set('Cookie', authCookie(colleague));
        expect(theirs.body.data.map((t: any) => t._id)).toContain(todo.id);
    });
});

describe('POST /api/todos/:id/unassign', () => {
    it('401 without a cookie; 404 when not mine', async () => {
        expect((await request(app).post('/api/todos/x/unassign').send({})).status).toBe(401);
        const owner = await createTestUser();
        const stranger = await createTestUser();
        const todo = await todoRow(owner.id);
        const res = await request(app).post(`/api/todos/${todo.id}/unassign`).set('Cookie', authCookie(stranger)).send({});
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ message: 'Task not found or you do not own it' });
    });

    it('leaves a workspace task alone (its assignees are the workspace\'s): 404, nothing changed', async () => {
        const me = await createTestUser();
        const a = await createTestUser();
        const todo = await todoRow(me.id, { visibility: 'workspace', assignedAt: new Date() });
        await prisma.todoAssignee.create({ data: { todoId: todo.id, userId: a.id } });
        const res = await request(app).post(`/api/todos/${todo.id}/unassign`).set('Cookie', authCookie(me)).send({});
        expect(res.status).toBe(404);
        const after = await prisma.todo.findUniqueOrThrow({ where: { id: todo.id }, include: { assignees: true } });
        expect(after.visibility).toBe('workspace');
        expect(after.assignees).toHaveLength(1);
    });

    it('removes one assignee by email, then all; with none left the task is private again', async () => {
        const me = await createTestUser();
        const a = await createTestUser({ email: `una-${Date.now()}@example.test` });
        const b = await createTestUser();
        const todo = await todoRow(me.id, { visibility: 'shared', assignedAt: new Date() });
        await prisma.todoAssignee.createMany({ data: [{ todoId: todo.id, userId: a.id }, { todoId: todo.id, userId: b.id }] });

        const one = await request(app).post(`/api/todos/${todo.id}/unassign`).set('Cookie', authCookie(me)).send({ email: a.email.toUpperCase() });
        expect(one.status).toBe(200);
        expect(one.body.message).toBe('Assignee removed');
        expect(one.body.data.assignees.map((u: any) => u._id)).toEqual([b.id]);
        expect(one.body.data.visibility).toBe('shared');

        const all = await request(app).post(`/api/todos/${todo.id}/unassign`).set('Cookie', authCookie(me)).send({});
        expect(all.body.message).toBe('All assignees removed');
        expect(all.body.data).toMatchObject({ assignees: [], assignedAt: null, visibility: 'private' });
    });
});
