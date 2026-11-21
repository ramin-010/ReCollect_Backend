// What the week's simulation found (SIMULATION_PLAN §12, 11-18), held by code on scripted models: an old chat
// brought in from an export never makes a thread he has now private, and the night and the pulses are told
// it is old; what is on his mind in an agent's brief is what he spoke of lately; a dated event keeps its own
// thread (and day) instead of folding into a bigger aim by shared words; an agent's brief carries only a note
// the lock check passed.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { approveImport, estimateImport } from '../../src/services/buddy/import.service';
import { drainBuddyQueue } from '../../src/services/buddy/worker';
import { openOrFindThread, withPersonLock } from '../../src/services/buddy/threads';
import { oldNote } from '../../src/services/buddy/think';
import { briefNote } from '../../src/services/buddy/voice';
import { getBrief } from '../../src/services/brief/brief.service';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
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

async function person() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, loop: true });
    return user;
}
const open = (userId: string, title: string, keywords: string[], saidAt: Date, over: { lookAgainOn?: string } = {}) =>
    withPersonLock(userId, (tx) => openOrFindThread(tx, userId, { title, keywords, ...(over.lookAgainOn ? { lookAgainOn: over.lookAgainOn as never } : {}) }, { saidAt, forDay: saidAt.toISOString().slice(0, 10) as never }, saidAt));

describe('what the week’s simulation found', () => {
    it('an old chat’s private words stay a private note: they never join, or make private, a thread he has now', async () => {
        const user = await person();
        const now = new Date();
        const run = (await open(user.id, 'Run three mornings a week', ['run', 'running'], now)).thread;
        await prisma.buddyThread.update({ where: { id: run.id }, data: { stage: 'active', rhythm: 'weekly' } });
        const exp = [{ uuid: 'c-1', name: 'Chest pain', chat_messages: [{ uuid: 'm1', sender: 'human', text: 'Had a weird chest pain after a run today, should I see a doctor?', created_at: '2026-09-10T18:00:00Z' }] }];
        const est = await estimateImport(user.id, exp, null, now);
        await approveImport(user.id, est._id, 1, now);
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'personal' }] }, { model: 'claude-haiku-5-5' }));
        fake.push(
            fakeMessage(
                {
                    notes: [{ text: 'Had chest pain after a run and wondered about a doctor', kind: 'state', private: true, seenMemoryId: '' }],
                    items: [],
                    threads: [{ op: 'event', threadId: run.id, title: '', keywords: [], kind: 'said', text: 'Had chest pain after a run', day: '', message: 1, askId: '', sensitive: true, lookAgainOn: '', rhythm: 'none', steer: '' }],
                },
                { model: 'claude-sonnet-5-5' }
            )
        );
        await drainBuddyQueue(new Date(now.getTime() + 20 * 60_000));
        const after = await prisma.buddyThread.findUniqueOrThrow({ where: { id: run.id } });
        expect(after.sensitive).toBe(false);
        expect(await prisma.buddyThreadEvent.count({ where: { threadId: run.id, via: 'import' } })).toBe(0);
        const note = await prisma.observation.findFirstOrThrow({ where: { userId: user.id, via: 'import' } });
        expect(note.sensitivity).toBe('private');
        // The night and the pulses are told when it was said.
        expect(oldNote(note)).toBe('old news: said 2026-09-10, in an old chat brought in from an export, not today');
    });

    it('a note is old news when brought in from an export or said over 48 hours before it arrived; else it is today’s', () => {
        const createdAt = new Date('2026-11-23T16:00:00Z');
        expect(oldNote({ via: 'ask_ai', saidAt: new Date('2026-11-23T15:59:00Z'), createdAt })).toBeNull();
        expect(oldNote({ via: 'hook', saidAt: new Date('2026-11-20T10:00:00Z'), createdAt })).toBe('old news: said 2026-11-20, not today');
        expect(oldNote({ via: 'import', saidAt: null, createdAt })).toBe('old news: said long ago, in an old chat brought in from an export, not today');
    });

    it('on his mind in an agent’s brief: only threads spoken of in the last 30 days', async () => {
        const user = await person();
        const now = new Date();
        const gym = (await open(user.id, 'Gym three times a week', ['gym', 'workout'], new Date(now.getTime() - 76 * 86_400_000))).thread;
        const guitar = (await open(user.id, 'Guitar most evenings', ['guitar'], new Date(now.getTime() - 2 * 86_400_000))).thread;
        expect([gym.stage, guitar.stage]).toEqual(['noticed', 'noticed']);
        const brief = await getBrief(user.id, { project: 'side-project' }, now);
        expect(brief.onMind.map((t) => t.title)).toEqual(['Guitar most evenings']);
    });

    it('a dated event keeps its own thread: shared words never fold it into a bigger aim without its day', async () => {
        const user = await person();
        const now = new Date();
        const aim = (await open(user.id, 'Prepare for backend interviews', ['interview', 'interviews', 'dsa', 'system design', 'prep'], now)).thread;
        const mock = await open(user.id, 'Mock interview with Priya', ['mock interview', 'interview', 'dsa', 'system design'], now, { lookAgainOn: '2026-11-26' });
        expect(mock.found).toBe(false);
        expect(mock.thread.id).not.toBe(aim.id);
        // The same dated event said again (the same day) is the same thread.
        const again = await open(user.id, 'Mock interview with Priya', ['mock interview', 'priya', 'dsa'], now, { lookAgainOn: '2026-11-26' });
        expect(again).toMatchObject({ found: true, thread: { id: mock.thread.id } });
    });

    it('a steer about something with no thread yet opens one that keeps the steer', async () => {
        const user = await person();
        const now = new Date();
        const { queueOwnWords } = await import('../../src/services/buddy/capture.service');
        await queueOwnWords(user.id, { key: 'ask:diet', seq: 1, via: 'ask_ai', messages: [{ at: now.toISOString(), text: "don't ask me about my diet, ever. i'll handle it myself" }] }, now);
        fake.push(
            fakeMessage(
                { notes: [], items: [], threads: [{ op: 'open', threadId: '', title: 'His diet', keywords: ['diet', 'food', 'eating'], kind: 'steer', text: "Don't ask about the diet, ever", day: '', message: 1, askId: '', sensitive: false, lookAgainOn: '', rhythm: 'none', steer: 'none' }] },
                { model: 'claude-sonnet-5-5' }
            )
        );
        await drainBuddyQueue(new Date(now.getTime() + 60_000));
        const diet = await prisma.buddyThread.findFirstOrThrow({ where: { userId: user.id } });
        expect(diet).toMatchObject({ title: 'His diet', noAsk: true });
    });

    it('a question about a private thread stays in the app and the chat: never in an agent’s brief', async () => {
        const user = await person();
        const now = new Date();
        const t = (await open(user.id, "Mum's surgery", ['surgery', 'mum'], now)).thread;
        await prisma.buddyThread.update({ where: { id: t.id }, data: { sensitive: true, stage: 'active' } });
        await prisma.buddyAsk.create({ data: { userId: user.id, threadId: t.id, text: "How's your mum doing after today?", answers: [], seenRevision: t.revision, fromAt: new Date(now.getTime() - 60_000), untilAt: new Date(now.getTime() + 3600_000) } });
        const { openAsks } = await import('../../src/services/buddy/asks');
        expect((await openAsks(user.id, 'brief', now)).map((a) => a.text)).toEqual([]);
        expect((await openAsks(user.id, 'web', now)).map((a) => a.text)).toEqual(["How's your mum doing after today?"]);
    });

    it('an agent’s brief carries only a note the lock check passed', async () => {
        const user = await person();
        const now = new Date();
        // The buddy's day (it ends at 04:00), not the calendar's: between midnight and 04:00 they differ.
        const { latestStep } = await import('../../src/services/buddy/voice');
        const day = new Date(`${(await latestStep(user.id, now)).day}T00:00:00Z`);
        const step = await prisma.buddyDay.create({ data: { userId: user.id, day, kind: 'night', lines: [], note: 'Go easy on that back tonight.', noteLockOk: false, model: 'claude-opus-5-5', createdAt: now } });
        expect((await briefNote(user.id, now)).note).toBeNull();
        await prisma.buddyDay.update({ where: { id: step.id }, data: { note: 'Two problems tonight, out loud.', noteLockOk: true } });
        expect((await briefNote(user.id, now)).note).toBe('Two problems tonight, out loud.');
    });
});
