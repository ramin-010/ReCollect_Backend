// MCP_MEMORY_PLAN stage 3, catching up (§4.7), on scripted models: saved details the AI could not read wait; when it
// can run again a short gap is read as normal pieces and a long one is a catch-up run: the record settled by code
// (chains to their newest version; forgotten, deleted, wrong and inferred left out; progress folded into counts),
// only what can be in motion read, oldest first, in batches; old words never raise a stage, what ended ends; no
// question or pulse comes of it; bounded at 150; a run stopped by the cap goes on later without reading twice.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { setAiClientForTests } from '../../src/services/claude/client';
import { rememberNotes } from '../../src/services/buddy/memory.service';
import { updateRecord } from '../../src/services/buddy/record.service';
import { CATCHUP_BATCH, CATCHUP_MAX_THINGS, catchUpBlock, catchUpIfDue } from '../../src/services/buddy/catchup';
import { drainBuddyQueue, SAVE_SETTLE_MS } from '../../src/services/buddy/worker';

const fake = new FakeClaude();
const KEY = process.env.CLAUDE_API_KEY;
beforeAll(() => setAiClientForTests(fake));
afterAll(() => {
    process.env.CLAUDE_API_KEY = KEY ?? '';
    setAiClientForTests(null);
});
afterEach(async () => {
    fake.reset();
    process.env.CLAUDE_API_KEY = KEY ?? '';
    await prisma.buddyChunk.deleteMany({});
});

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const op = (over: Record<string, unknown>) => ({ op: 'open', threadId: '', title: '', keywords: [], kind: 'said', text: '', day: '', message: 1, askId: '', sensitive: false, lookAgainOn: '', rhythm: 'none', steer: '', ...over });
const digested = (threads: unknown[] = []) => fakeMessage({ notes: [], items: [], threads }, { model: 'claude-sonnet-5-5' });

/** A person with the buddy and the loop on, saving while the AI can't run (no key on the server). */
async function person() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true });
    await prisma.buddyState.update({ where: { userId: user.id }, data: { loop: true } });
    process.env.CLAUDE_API_KEY = '';
    return user;
}
const writer = (userId: string) => ({ userId, source: 'agent' as const, agentName: 'ChatGPT', via: 'connector' });
const save = async (userId: string, text: string, kind: string, at: Date, extra: Record<string, unknown> = {}) => {
    const r = await rememberNotes(writer(userId), [{ text, kind: kind as never, inferred: false, ...extra }], at);
    const n = r.notes[0]!;
    return n.status === 'saved' || n.status === 'seen' ? n.memory._id : '';
};
const actor = (userId: string) => ({ actor: { userId, agentName: 'ChatGPT', tokenId: null }, source: 'agent' as const, via: 'connector' });
const aiBack = () => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
};
const messagesOf = (i: number) => JSON.stringify(fake.calls[i]!.messages);

describe('catching up', () => {
    it('details saved while the AI could not run wait on their notes; a short gap is read as normal pieces', async () => {
        const user = await person();
        await save(user.id, 'Started walking after work', 'pattern', new Date(Date.now() - 3 * 3600_000));
        const [note] = await prisma.observation.findMany({ where: { userId: user.id } });
        expect(note!.waitingSince).not.toBeNull();
        aiBack();
        expect(await catchUpIfDue(user.id)).toBe('short');
        expect(await prisma.buddyChunk.count({ where: { userId: user.id, via: 'agent', noteId: note!.id } })).toBe(1);
        expect((await prisma.observation.findUniqueOrThrow({ where: { id: note!.id } })).waitingSince).toBeNull();
        expect(await prisma.buddyCatchUp.count({ where: { userId: user.id } })).toBe(0);
    });

    it('a long gap runs once: the record settled by code, only what can be in motion read, oldest first, with its own dates', async () => {
        const user = await person();
        // A chain of corrections: only the newest version is read.
        const walk = await save(user.id, 'Walks after work', 'pattern', ago(150));
        await updateRecord(actor(user.id), { on: walk, update: 'changed', text: 'Walks in the mornings now' }, ago(120));
        for (const d of [100, 90, 80]) await updateRecord(actor(user.id), { on: walk, update: 'done', text: 'Got my walk in' }, ago(d));
        await updateRecord(actor(user.id), { on: walk, update: 'skipped', text: 'No walk today' }, ago(70));
        // Forgotten, marked wrong, deleted, inferred, a plain fact: never read.
        const forgotten = await save(user.id, 'Plans to learn the cello', 'aim', ago(140));
        await prisma.memory.update({ where: { id: forgotten }, data: { status: 'closed', closeReason: 'Forgotten by ChatGPT', closedDay: ago(130) } });
        const wrong = await save(user.id, 'Wants to move to Berlin', 'aim', ago(140));
        await prisma.memory.update({ where: { id: wrong }, data: { status: 'wrong' } });
        const gone = await save(user.id, 'Training for a marathon', 'aim', ago(140));
        await api(user).delete(`/api/buddy/memories/${gone}`);
        await rememberNotes(writer(user.id), [{ text: 'Seems to like podcasts', kind: 'idea', inferred: true }], ago(110));
        await save(user.id, 'Prefers backend work', 'preference', ago(100));
        // Something they moved on from lately: read, so it is known as over.
        const rag = await save(user.id, 'Learning about RAG', 'aim', ago(60));
        await updateRecord(actor(user.id), { on: rag, update: 'finished', text: 'Learned enough about RAG for now' }, ago(20));

        aiBack();
        await drainBuddyQueue(new Date());
        const runs = await prisma.buddyCatchUp.findMany({ where: { userId: user.id } });
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ state: 'running', things: 2, batches: 1 });
        const pieces = await prisma.buddyChunk.findMany({ where: { userId: user.id, via: 'catchup' } });
        expect(pieces).toHaveLength(1);
        const lines = (pieces[0]!.messages as Array<{ text: string; at: string }>).map((m) => m.text);
        expect(lines).toEqual(['Walks in the mornings now (done on 3 days, ' + lines[0]!.split('(done on 3 days, ')[1], expect.stringMatching(/^Learning about RAG \[ended \d{4}-\d{2}-\d{2}: Finished: Learned enough about RAG for now\]$/)]);
        expect(lines[0]).toMatch(/; skipped 1\)$/);
        expect(JSON.stringify(lines)).not.toMatch(/Walks after work|cello|Berlin|marathon|podcasts|backend/);
        // Every waiting note was settled: none waits any more, and a second pass starts nothing new.
        expect(await prisma.observation.count({ where: { userId: user.id, waitingSince: { not: null } } })).toBe(0);
        expect(await catchUpIfDue(user.id)).toBeNull();

        // Read through the understanding step: old words build history; what ended ends; no question, no pulse.
        fake.push(
            digested([
                op({ op: 'open', title: 'Walking in the mornings', keywords: ['walk'], kind: 'progress', text: 'Walks in the mornings now', message: 1 }),
                op({ op: 'open', title: 'Learning about RAG', keywords: ['rag'], kind: 'finished', text: 'Learned enough about RAG for now', message: 2 }),
            ])
        );
        expect(await drainBuddyQueue(new Date(Date.now() + SAVE_SETTLE_MS + 1000))).toMatchObject({ digested: 1 });
        expect(messagesOf(0)).toContain('a catch-up');
        const threads = await prisma.buddyThread.findMany({ where: { userId: user.id }, orderBy: { title: 'asc' } });
        expect(threads.map((t) => [t.title, t.stage])).toEqual([
            ['Learning about RAG', 'done'],
            ['Walking in the mornings', 'noticed'],
        ]);
        expect(await prisma.buddyAsk.count({ where: { userId: user.id } })).toBe(0);
        // The run is done once its pieces are read; the night is told its dates.
        await drainBuddyQueue(new Date(Date.now() + SAVE_SETTLE_MS + 2000));
        expect((await prisma.buddyCatchUp.findFirstOrThrow({ where: { userId: user.id } })).state).toBe('done');
        expect(await catchUpBlock(user.id, new Date())).toMatch(/^<caught_up>Since the last night the buddy read saved details from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/);
    });

    it('words said in the last 30 days replay the stage ladder', async () => {
        const user = await person();
        await save(user.id, 'Swims on Saturdays', 'pattern', ago(10));
        await save(user.id, 'An old plan to paint', 'aim', ago(90));
        aiBack();
        await drainBuddyQueue(new Date());
        fake.push(
            digested([
                op({ op: 'open', title: 'An old plan to paint', keywords: ['paint'], kind: 'progress', text: 'An old plan to paint', message: 1 }),
                op({ op: 'open', title: 'Swimming on Saturdays', keywords: ['swim'], kind: 'progress', text: 'Swims on Saturdays', message: 2 }),
            ])
        );
        await drainBuddyQueue(new Date(Date.now() + SAVE_SETTLE_MS + 1000));
        const threads = await prisma.buddyThread.findMany({ where: { userId: user.id }, orderBy: { title: 'asc' } });
        expect(threads.map((t) => [t.title, t.stage])).toEqual([
            ['An old plan to paint', 'noticed'],
            ['Swimming on Saturdays', 'active'],
        ]);
    });

    it(`is bounded at ${CATCHUP_MAX_THINGS} things in batches of ${CATCHUP_BATCH}; what is left out is still found by search`, async () => {
        const user = await person();
        const at = ago(200);
        await prisma.memory.createMany({
            data: Array.from({ length: CATCHUP_MAX_THINGS + 10 }, (_, i) => ({ id: `cu${user.id.slice(-8)}${String(i).padStart(4, '0')}`, userId: user.id, text: `Habit number ${i} with word${i}`, kind: 'pattern' as const, source: 'agent' as const, firstSeenDay: at, lastSeenDay: at, monthsSeen: [] })),
        });
        await prisma.observation.createMany({
            data: Array.from({ length: CATCHUP_MAX_THINGS + 10 }, (_, i) => ({ userId: user.id, text: `Habit number ${i} with word${i}`, kind: 'pattern' as const, source: 'agent' as const, day: at, saidAt: new Date(at.getTime() + i * 60_000), basis: 'said', memoryId: `cu${user.id.slice(-8)}${String(i).padStart(4, '0')}`, waitingSince: at })),
        });
        aiBack();
        await catchUpIfDue(user.id);
        const run = await prisma.buddyCatchUp.findFirstOrThrow({ where: { userId: user.id } });
        expect(run).toMatchObject({ things: CATCHUP_MAX_THINGS, batches: CATCHUP_MAX_THINGS / CATCHUP_BATCH, notes: CATCHUP_MAX_THINGS + 10 });
        const read = (await prisma.buddyChunk.findMany({ where: { userId: user.id, via: 'catchup' } })).flatMap((c) => (c.messages as Array<{ text: string }>).map((m) => m.text));
        expect(read).toHaveLength(CATCHUP_MAX_THINGS);
        // The oldest ten were left out (the newest 150 are read), and are still found by search.
        expect(read.some((t) => t.startsWith('Habit number 0 '))).toBe(false);
        const found = (await api(user).get('/api/buddy/memories?q=word0')).body.data;
        expect(found.map((m: { text: string }) => m.text)).toEqual(['Habit number 0 with word0']);
    });

    it('a run stopped by the cap goes on later, reading nothing twice', async () => {
        const user = await person();
        for (let i = 0; i < 20; i++) await save(user.id, `Plan ${i}: practise skill${i}`, 'aim', ago(100 + i));
        aiBack();
        await drainBuddyQueue(new Date());
        expect(await prisma.buddyChunk.count({ where: { userId: user.id, via: 'catchup' } })).toBe(2);
        // One batch is read; then the buddy's cap is reached: the other waits, kept.
        fake.push(digested());
        await drainBuddyQueue(new Date(Date.now() + SAVE_SETTLE_MS + 1000), 1);
        expect(await prisma.buddyChunk.count({ where: { userId: user.id, via: 'catchup' } })).toBe(1);
        await prisma.buddyState.update({ where: { userId: user.id }, data: { capUsd: 0 } });
        await drainBuddyQueue(new Date(Date.now() + SAVE_SETTLE_MS + 2000));
        expect(await prisma.buddyChunk.count({ where: { userId: user.id, via: 'catchup' } })).toBe(1);
        expect((await prisma.buddyCatchUp.findFirstOrThrow({ where: { userId: user.id } })).state).toBe('running');
        // The cap resets: the second batch is read, once; the run is done; nothing is read twice.
        await prisma.buddyState.update({ where: { userId: user.id }, data: { capUsd: 25 } });
        fake.push(digested());
        await drainBuddyQueue(new Date(Date.now() + SAVE_SETTLE_MS + 3000));
        await drainBuddyQueue(new Date(Date.now() + SAVE_SETTLE_MS + 4000));
        expect(fake.calls).toHaveLength(2);
        expect(new Set([messagesOf(0), messagesOf(1)]).size).toBe(2);
        expect((await prisma.buddyCatchUp.findFirstOrThrow({ where: { userId: user.id } })).state).toBe('done');
        expect(await prisma.buddyCatchUp.count({ where: { userId: user.id } })).toBe(1);
    });
});
