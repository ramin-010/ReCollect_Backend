// Stage 8 of ECOSYSTEM_V2_PLAN, E3: his words ride on tool calls. get_brief's `about` and checkpoint's `said`
// are queued for his buddy as an agent's relay (indirect, through the gate), only with the loop on, never from a
// work folder, and only from a token that may write sessions; scrubbed like every word.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { asAgent, createTestToken } from '../helpers/agent';
import { api } from '../helpers/learning';

async function person(loop = true) {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, loop });
    return user;
}

describe('words on tool calls (E3)', () => {
    it('about on the brief and said on a checkpoint are queued as an agent’s relay; never at work, never with read only, never with the loop off', async () => {
        const user = await person();
        const agent = asAgent((await createTestToken(user)).token, 'Claude');
        const brief = (await agent.get('/api/brief?about=Help%20me%20plan%20a%20calm%20week%20before%20the%20exam')).body.data;
        const key = brief.session.key as string;
        await agent.put(`/api/sessions/by-key/${key}`, { title: 'Exam week plan', said: ['I want to sleep before eleven this week', 'My key is sk-ant-QAQAQAQAQAQAQAQAQAQAQA by the way'] });
        const chunks = await prisma.buddyChunk.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        expect(chunks.map((c) => [c.source, c.via, c.sessionKey])).toEqual([
            ['agent', 'connector', `relay:${key}`],
            ['agent', 'connector', `relay:${key}`],
        ]);
        const words = chunks.flatMap((c) => (c.messages as Array<{ text: string }>).map((m) => m.text));
        expect(words[0]).toBe('Help me plan a calm week before the exam');
        expect(words[1]).toBe('I want to sleep before eleven this week');
        expect(words[2]).not.toContain('sk-ant-QAQA');

        // A work folder's brief, a read-only token, the loop off: nothing.
        await agent.get('/api/brief?work=1&about=Fix%20the%20invoice%20report');
        const readOnly = asAgent((await createTestToken(user, ['read'], 'Reader')).token);
        await readOnly.get('/api/brief?about=Something%20about%20me');
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(2);
        const off = await person(false);
        const offAgent = asAgent((await createTestToken(off)).token);
        await offAgent.get('/api/brief?about=Plan%20my%20week');
        expect(await prisma.buddyChunk.count({ where: { userId: off.id } })).toBe(0);
        await prisma.buddyChunk.deleteMany({ where: { userId: user.id } });
    });
});
