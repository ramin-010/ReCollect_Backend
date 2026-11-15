// Personal tasks for agents (LOOP_COMPLETE_SPEC 4.1): add, list by due window, change, tick; every
// write logged and undoable; workspace tasks are out of reach; scopes; the brief counts them.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

const inDays = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86400_000).toISOString().slice(0, 10);

describe('/api/tasks', () => {
    it('an agent adds, lists, changes and ticks personal tasks; each write is logged and undone', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token, 'study-chat');
        const a = await chat.post('/api/tasks', { title: 'Book the mock interview', due: inDays(0), priority: 'high' });
        expect(a.status).toBe(201);
        expect(a.body.data).toMatchObject({ title: 'Book the mock interview', status: 'pending', priority: 'high' });
        await chat.post('/api/tasks', { title: 'Renew the domain', due: inDays(-2) });
        await chat.post('/api/tasks', { title: 'Read DDIA ch. 6', due: inDays(5) });
        await chat.post('/api/tasks', { title: 'Someday: learn Rust' });

        const titles = async (due: string) => (await chat.get(`/api/tasks?due=${due}`)).body.data.map((t: { title: string }) => t.title);
        expect(await titles('overdue')).toEqual(['Renew the domain']);
        expect(await titles('today')).toEqual(['Renew the domain', 'Book the mock interview']);
        expect(await titles('week')).toEqual(['Renew the domain', 'Book the mock interview', 'Read DDIA ch. 6']);
        expect(await titles('all')).toHaveLength(4);

        const ticked = await chat.patch(`/api/tasks/${a.body.data._id}`, { status: 'complete' });
        expect(ticked.body.data).toMatchObject({ status: 'complete', completedAt: expect.any(String) });
        const edits = await prisma.agentEdit.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        expect(edits.map((e) => e.summary)).toEqual([
            'Added the task "Book the mock interview"',
            'Added the task "Renew the domain"',
            'Added the task "Read DDIA ch. 6"',
            'Added the task "Someday: learn Rust"',
            'Ticked the task "Book the mock interview"',
        ]);
        // Undo the tick, then the add.
        expect((await api(user).post(`/api/agent/edits/${edits[4]!.id}/undo`)).status).toBe(200);
        expect(await prisma.todo.findUniqueOrThrow({ where: { id: a.body.data._id } })).toMatchObject({ status: 'pending', completedAt: null });
        expect((await api(user).post(`/api/agent/edits/${edits[0]!.id}/undo`)).status).toBe(200);
        expect(await prisma.todo.count({ where: { id: a.body.data._id } })).toBe(0);

        // The brief counts what is due.
        const brief = (await chat.get('/api/brief')).body.data;
        expect(brief.tasks).toMatchObject({ dueToday: 0, overdue: 1, titles: ['Renew the domain'] });
    });

    it('workspace tasks are out of reach; no delete; a token without tasks:write may only read', async () => {
        const user = await createTestUser();
        const ws = await prisma.workspace.create({ data: { name: 'Team', ownerId: user.id } as never });
        const shared = await prisma.todo.create({ data: { userId: user.id, title: 'Team task', workspaceId: ws.id } });
        const chat = asAgent((await createTestToken(user)).token);
        expect((await chat.get('/api/tasks?due=all')).body.data).toEqual([]);
        expect((await chat.patch(`/api/tasks/${shared.id}`, { title: 'x' })).status).toBe(404);
        expect((await chat.delete(`/api/tasks/${shared.id}`)).status).toBe(403);
        const reader = asAgent((await createTestToken(user, ['read'])).token);
        expect((await reader.get('/api/tasks')).status).toBe(200);
        expect((await reader.post('/api/tasks', { title: 'x' })).status).toBe(403);
    });
});
