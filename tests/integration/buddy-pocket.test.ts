// The week's simulation, issue 9 (SIMULATION_PLAN §12, 11-18): his own pocket notes are one of the buddy's ears.
// "idea: a CLI that turns my notes into drills" never came back because nothing read it. Now a new note he jots
// in the app is queued as his own words (via "pocket") and read without the gate, so an idea can open a thread;
// an edit, a link alone, a page pasted in, a note an agent pinned for him, the loop off and a paused buddy are not.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { drainBuddyQueue } from '../../src/services/buddy/worker';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
import { asAgent, createTestToken } from '../helpers/agent';
import { api } from '../helpers/learning';

const fake = new FakeClaude();
beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    setAiClientForTests(fake);
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = '';
    setAiClientForTests(null);
});
beforeEach(() => fake.reset());

type User = Awaited<ReturnType<typeof createTestUser>>;
async function person(settings: Record<string, boolean> = { enabled: true, loop: true }): Promise<User> {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', settings);
    return user;
}
const jot = (user: User, content: string, id: string = randomUUID()) => api(user).put(`/api/quick-notes/${id}`, { content, category: 'PRIMARY' });
const pieces = (userId: string) => prisma.buddyChunk.findMany({ where: { userId, via: 'pocket' } });
const IDEA = 'idea: a CLI that turns my notes into drills, like flashcards in the terminal';

describe('his pocket notes (the week’s simulation, issue 9)', () => {
    it('a new note of his own is queued once, as his own words; an edit, a link, a pasted page and an agent’s note are not', async () => {
        const user = await person();
        const id = randomUUID();
        expect((await jot(user, IDEA, id)).status).toBe(201);
        const [piece, ...more] = await pieces(user.id);
        expect(more).toHaveLength(0);
        expect(piece).toMatchObject({ source: 'app', via: 'pocket', sessionKey: `pocket:${id}`, noteId: null });
        expect((piece!.messages as Array<{ text: string }>)[0]!.text).toBe(IDEA);
        // Edited later: still the one piece.
        expect((await jot(user, `${IDEA} (markdown in, cards out)`, id)).status).toBe(200);
        // A link alone, a page pasted in, a note of attachments only, and an agent's pinned note: none.
        expect((await jot(user, '  https://example.com/some/article  ')).status).toBe(201);
        expect((await jot(user, 'word '.repeat(500))).status).toBe(201);
        const agent = asAgent((await createTestToken(user)).token);
        expect((await agent.put(`/api/quick-notes/${randomUUID()}`, { content: 'Idea: try the drills CLI on the train', category: 'PRIMARY' })).status).toBe(201);
        expect(await pieces(user.id)).toHaveLength(1);
        // What it hears counts it under its own name.
        const day = await prisma.buddyCaptureDay.findFirstOrThrow({ where: { userId: user.id } });
        expect((day.bySource as Record<string, { seen: number }>)['pocket']?.seen).toBe(1);
    });

    it('with the loop off, the buddy off or paused, nothing is queued (the note itself is saved as ever)', async () => {
        for (const settings of [{ enabled: true, loop: false }, { enabled: false }, { enabled: true, loop: true, paused: true }]) {
            const user = await person(settings);
            expect((await jot(user, IDEA)).status).toBe(201);
            expect(await pieces(user.id)).toHaveLength(0);
            expect(await prisma.quickNote.count({ where: { userId: user.id } })).toBe(1);
        }
    });

    it('it is read without the gate, and the idea opens a thread said through the pocket', async () => {
        // The other tests' pieces wait in the same queue: only this one is read here.
        await prisma.buddyChunk.deleteMany({ where: { via: 'pocket' } });
        const user = await person();
        await jot(user, IDEA);
        fake.push(
            fakeMessage(
                {
                    notes: [],
                    items: [],
                    threads: [{ op: 'open', threadId: '', title: 'A CLI that turns notes into drills', keywords: ['cli', 'drills', 'flashcards'], kind: 'said', text: 'Has an idea for a CLI that turns notes into drills', day: '', message: 1, askId: '', sensitive: false, lookAgainOn: '', rhythm: 'none', steer: '' }],
                },
                { model: 'claude-sonnet-5-5' }
            )
        );
        await drainBuddyQueue(new Date(Date.now() + 20 * 60_000));
        // One call, the reading itself: no gate before it.
        expect(fake.calls).toHaveLength(1);
        expect(JSON.stringify(fake.calls[0])).toContain('pocket of quick notes');
        const thread = await prisma.buddyThread.findFirstOrThrow({ where: { userId: user.id, title: { contains: 'CLI' } } });
        const event = await prisma.buddyThreadEvent.findFirstOrThrow({ where: { threadId: thread.id } });
        expect(event).toMatchObject({ via: 'pocket', direct: true });
        expect(await pieces(user.id)).toHaveLength(0);
    });
});
