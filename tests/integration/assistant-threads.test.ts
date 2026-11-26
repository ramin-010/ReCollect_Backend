// The manager's conversations (src/services/assistant/threads.service.ts): titled by the first
// message, listed newest first, read, deleted, pruned after 90 days; his own only; cookie only.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { addMessage, createThread, pruneThreads, threadTitle } from '../../src/services/assistant/threads.service';
import { asAgent, createTestToken } from '../helpers/agent';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';

describe('the manager conversations', () => {
    it('lists, reads and deletes his threads; not someone else\'s; not with a token; pruned after 90 days', async () => {
        const [me, other] = await Promise.all([createTestUser(), createTestUser()]);
        expect(threadTitle('  \n Move tomorrow\'s reviews to Sunday\nplease')).toBe("Move tomorrow's reviews to Sunday");
        const t = await createThread(me.id, 'What did I do this week?');
        await addMessage(me.id, t._id, { role: 'user', text: 'What did I do this week?' });
        await addMessage(me.id, t._id, {
            role: 'assistant',
            text: '6 h of study, 2 topics done.',
            tools: [{ name: 'get_standing', level: 1, input: '{}', result: 'Hours per week…', ok: true }],
            costUsd: 0.0312,
        });

        const list = await api(me).get('/api/assistant/threads');
        expect(list.body.data.map((x: { title: string }) => x.title)).toEqual(['What did I do this week?']);
        const read = await api(me).get(`/api/assistant/threads/${t._id}`);
        expect(read.body.data.messages.map((m: { role: string; costUsd: number | null }) => [m.role, m.costUsd])).toEqual([
            ['user', null],
            ['assistant', 0.0312],
        ]);
        expect(read.body.data.messages[1].tools[0]).toMatchObject({ name: 'get_standing', level: 1, ok: true });

        expect((await api(other).get(`/api/assistant/threads/${t._id}`)).status).toBe(404);
        expect((await api(other).delete(`/api/assistant/threads/${t._id}`)).status).toBe(404);
        const { token } = await createTestToken(me);
        expect((await asAgent(token).get('/api/assistant/threads')).status).toBe(403);

        expect((await api(me).delete(`/api/assistant/threads/${t._id}`)).body.data).toEqual({ deleted: true });
        expect(await prisma.assistantMessage.count({ where: { threadId: t._id } })).toBe(0);

        const old = await createThread(me.id, 'Old one');
        await prisma.assistantThread.update({ where: { id: old._id }, data: { updatedAt: new Date(Date.now() - 91 * 86_400_000) } });
        expect(await pruneThreads()).toBe(1);
    });
});
