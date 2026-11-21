// MCP_MEMORY_PLAN stage 2: the early brief, and progress on what the buddy follows. The buddy brief (GET
// /api/brief?view=buddy: today, who, in motion with ids, saved lately, questions with their thread; nothing private;
// capped on a seeded year); update_memory on a thread (an event by code, whose word it is, the question answered and
// withdrawn); the levels at the thread layer (a said word weighs as their own, newest by the time said; a day-only one
// never overrules a timed one; an inference never moves a stage); the understanding step only where §4.5 says (saves
// read together, with no memories or tasks); and the journeys JW1, JW3, JW4, scripted.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { setAiClientForTests } from '../../src/services/claude/client';
import { openOrFindThread, withPersonLock, dayState, addThreadEvent } from '../../src/services/buddy/threads';
import { openAsks } from '../../src/services/buddy/asks';
import { drainBuddyQueue, SAVE_SETTLE_MS } from '../../src/services/buddy/worker';

const fake = new FakeClaude();
const KEY = process.env.CLAUDE_API_KEY;
beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    setAiClientForTests(fake);
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = KEY ?? '';
    setAiClientForTests(null);
});
afterEach(async () => {
    fake.reset();
    await prisma.buddyChunk.deleteMany({});
});

const op = (over: Record<string, unknown>) => ({ op: 'open', threadId: '', title: '', keywords: [], kind: 'said', text: '', day: '', message: 1, askId: '', sensitive: false, lookAgainOn: '', rhythm: 'none', steer: '', ...over });
const digested = (threads: unknown[]) => fakeMessage({ notes: [], items: [], threads }, { model: 'claude-sonnet-5-5' });

async function person(loop = true) {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true });
    if (loop) await prisma.buddyState.update({ where: { userId: user.id }, data: { loop: true } });
    const chat = asAgent((await createTestToken(user, undefined, 'ChatGPT')).token);
    return { user, chat };
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
async function thread(userId: string, title: string, keywords: string[], extra: { stage?: string; sensitive?: boolean } = {}) {
    const { thread: t } = await withPersonLock(userId, (tx) => openOrFindThread(tx, userId, { title, keywords }, { saidAt: new Date(Date.now() - 3600_000), forDay: today() as never }));
    if (extra.stage || extra.sensitive) await prisma.buddyThread.update({ where: { id: t.id }, data: { ...(extra.stage ? { stage: extra.stage as never } : {}), ...(extra.sensitive ? { sensitive: true } : {}) } });
    return prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } });
}

describe('the buddy brief (§4.6)', () => {
    it('loop on: today, who, the threads in motion with ids and their newest update, saved lately from any app, the questions with their thread; nothing private', async () => {
        const { user, chat } = await person();
        await prisma.buddyState.update({ where: { userId: user.id }, data: { who: 'A backend engineer who studies at night.' } });
        const walk = await thread(user.id, 'Walking after work', ['walk', 'walking'], { stage: 'active' });
        await thread(user.id, 'Mum’s surgery', ['surgery'], { stage: 'active', sensitive: true });
        await prisma.buddyAsk.create({ data: { userId: user.id, threadId: walk.id, text: 'Did you get your walk in?', seenRevision: walk.revision, fromAt: new Date(Date.now() - 60_000), untilAt: new Date(Date.now() + 3600_000) } });
        await chat.post('/api/buddy/remember', { text: 'Prefers backend work', kind: 'preference', inferred: false });
        await chat.post('/api/buddy/remember', { text: 'Worried about the move', kind: 'state', inferred: false });
        const v = (await chat.get('/api/brief?view=buddy')).body.data;
        expect(v.now.day).toBe(today());
        expect(v.who).toBe('A backend engineer who studies at night.');
        expect(v.inMotion.map((x: { text: string }) => x.text)).toEqual(['Walking after work']);
        expect(v.inMotion[0]._id).toBe(walk.id);
        expect(v.savedLately.map((s: { text: string; app: string }) => [s.text, s.app])).toEqual([['Prefers backend work', 'ChatGPT']]);
        expect(v.asks).toEqual([expect.objectContaining({ threadId: walk.id, text: 'Did you get your walk in?' })]);
        // Stage 15: a third line, their notes are read before explaining them.
        expect(v.howTo).toHaveLength(3);
        expect(JSON.stringify(v)).not.toMatch(/surgery|move/i);
        expect(JSON.stringify(v).length).toBeLessThan(1600);
    });

    it('loop off: the memories that move, seen in the last 30 days, with ids', async () => {
        const { user, chat } = await person(false);
        const m = (await chat.post('/api/buddy/remember', { text: 'Walks after work most days', kind: 'pattern', inferred: false })).body.data.notes[0].memory;
        await chat.post('/api/buddy/remember', { text: 'Old habit of chess', kind: 'pattern', saidOn: new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10), inferred: false });
        await chat.post('/api/buddy/update', { on: m._id, update: 'done', text: 'Got my walk in' });
        const v = (await api(user).get('/api/brief?view=buddy')).body.data;
        expect(v.inMotion).toEqual([expect.objectContaining({ _id: m._id, type: 'memory', text: 'Walks after work most days', last: expect.objectContaining({ kind: 'done' }) })]);
    });

    it('stays small on a seeded year: capped lists, quick', async () => {
        const { user } = await person();
        const day = (i: number) => new Date(Date.now() - i * 86_400_000);
        await prisma.memory.createMany({ data: Array.from({ length: 400 }, (_, i) => ({ userId: user.id, text: `A habit number ${i}`, kind: 'pattern' as const, source: 'agent' as const, firstSeenDay: day(i % 365), lastSeenDay: day(i % 365), monthsSeen: [] })) });
        await prisma.observation.createMany({ data: Array.from({ length: 1500 }, (_, i) => ({ userId: user.id, text: `Note ${i}`, kind: 'fact' as const, source: 'agent' as const, day: day(i % 365), createdAt: day(i % 365) })) });
        for (let i = 0; i < 40; i++) await thread(user.id, `Thread ${i} about thing${i}`, [`thing${i}`], { stage: 'active' });
        const t0 = Date.now();
        const v = (await api(user).get('/api/brief?view=buddy')).body.data;
        const ms = Date.now() - t0;
        expect(v.inMotion.length).toBeLessThanOrEqual(6);
        expect(v.savedLately.length).toBeLessThanOrEqual(3);
        expect(v.asks.length).toBeLessThanOrEqual(2);
        expect(ms).toBeLessThan(1500);
    });
});

describe('update_memory on a thread (§4.3) and whose word it is (§4.4)', () => {
    it('a said update is an event by code: no model call; it answers and withdraws the open question (JW1, second half)', async () => {
        const { user, chat } = await person();
        const walk = await thread(user.id, 'Walking after work', ['walk'], { stage: 'active' });
        await prisma.buddyAsk.create({ data: { userId: user.id, threadId: walk.id, text: 'Did you get your walk in?', seenRevision: walk.revision, fromAt: new Date(Date.now() - 60_000), untilAt: new Date(Date.now() + 3600_000) } });
        expect((await openAsks(user.id, 'web')).map((a) => a.text)).toEqual(['Did you get your walk in?']);
        const r = (await chat.post('/api/buddy/update', { on: walk.id, update: 'done', text: 'Got my steps in today' })).body.data;
        expect(r).toMatchObject({ target: 'thread', outcome: 'seen', thread: { _id: walk.id } });
        expect(fake.calls).toHaveLength(0);
        const ev = await prisma.buddyThreadEvent.findFirstOrThrow({ where: { threadId: walk.id, kind: 'done' } });
        expect(ev).toMatchObject({ basis: 'said', direct: false, via: 'agent', duplicate: false });
        expect((await prisma.buddyAsk.findFirstOrThrow({ where: { threadId: walk.id } })).state).toBe('answered');
        expect(await openAsks(user.id, 'web')).toEqual([]);
        // The note behind it is in the record, dated and sourced.
        expect(await prisma.observation.findFirstOrThrow({ where: { id: ev.observationId! } })).toMatchObject({ updateKind: 'done', basis: 'said', agentName: 'ChatGPT' });
    });

    it('an inference never moves a stage, answers nothing and withdraws nothing', async () => {
        const { user, chat } = await person();
        const rag = await thread(user.id, 'Learning about RAG', ['rag'], { stage: 'active' });
        await prisma.buddyAsk.create({ data: { userId: user.id, threadId: rag.id, text: 'How is the RAG prototype going?', seenRevision: rag.revision, fromAt: new Date(Date.now() - 60_000), untilAt: new Date(Date.now() + 3600_000) } });
        const r = (await chat.post('/api/buddy/update', { on: rag.id, update: 'finished', text: 'Seems done with RAG', inferred: true })).body.data;
        expect(r).toMatchObject({ outcome: 'noted', thread: { stage: 'active' } });
        const after = await prisma.buddyThread.findUniqueOrThrow({ where: { id: rag.id } });
        expect(after).toMatchObject({ stage: 'active', revision: rag.revision, lastSaidAt: rag.lastSaidAt });
        expect((await openAsks(user.id, 'web')).map((a) => a.text)).toEqual(['How is the RAG prototype going?']);
        // Said by the person, it ends it.
        expect((await chat.post('/api/buddy/update', { on: rag.id, update: 'finished', text: 'Learned enough about RAG for now' })).body.data).toMatchObject({ outcome: 'closed', thread: { stage: 'done' } });
    });

    it('a said word weighs as their own: the newest by the time said wins; a day-only one never overrules a timed one', () => {
        const at = (h: number) => new Date(`2026-06-10T0${h}:00:00Z`);
        expect(dayState([{ kind: 'done', saidAt: at(2), direct: true }, { kind: 'skipped', saidAt: at(5), direct: false, basis: 'said' }])).toBe('skipped');
        expect(dayState([{ kind: 'done', saidAt: at(5), direct: true }, { kind: 'skipped', saidAt: at(2), direct: false, basis: 'said' }])).toBe('done');
        expect(dayState([{ kind: 'done', saidAt: at(2), direct: true }, { kind: 'skipped', saidAt: at(6), direct: false, basis: 'said', dayOnly: true }])).toBe('done');
        expect(dayState([{ kind: 'done', saidAt: at(2), direct: false, basis: 'said', dayOnly: true }, { kind: 'skipped', saidAt: at(6), direct: false, basis: 'said', dayOnly: true }])).toBe('unclear');
        expect(dayState([{ kind: 'done', saidAt: at(2), direct: true }, { kind: 'skipped', saidAt: at(6), direct: false, basis: 'inferred' }])).toBe('done');
        // Older events with no basis: exactly as before (a passed-on one never overrules their own).
        expect(dayState([{ kind: 'done', saidAt: at(2), direct: true }, { kind: 'skipped', saidAt: at(6), direct: false }])).toBe('done');
    });

    it('done, then skipped, then done again, said from a web chat: a correction each time, never a duplicate', async () => {
        const { user, chat } = await person();
        const walk = await thread(user.id, 'Walking after work', ['walk'], { stage: 'active' });
        for (const [update, text] of [['done', 'Walked today'], ['skipped', 'Actually I skipped it'], ['done', 'No wait, I did walk in the end']]) await chat.post('/api/buddy/update', { on: walk.id, update, text });
        const events = await prisma.buddyThreadEvent.findMany({ where: { threadId: walk.id }, orderBy: { saidAt: 'asc' } });
        expect(events.map((e) => [e.kind, e.duplicate])).toEqual([
            ['done', false],
            ['skipped', false],
            ['done', false],
        ]);
    });
});

describe('the journeys, scripted (stage 2)', () => {
    it('JW1: a new habit from the web opens one thread (read with the save beside it, no memories or tasks in the call)', async () => {
        const { user, chat } = await person();
        await chat.post('/api/buddy/remember', { text: 'Started walking after work', kind: 'pattern', inferred: false });
        await chat.post('/api/buddy/remember', { text: 'Aiming for 10,000 steps a day', kind: 'aim', inferred: false });
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(2);
        // Not read until the saves settle; then read as one unit, in one call.
        expect(await drainBuddyQueue(new Date())).toMatchObject({ digested: 0 });
        fake.push(digested([op({ op: 'open', title: 'Walking after work, 10,000 steps', keywords: ['walk', 'steps'], kind: 'said', text: 'Started walking after work', message: 1 })]));
        expect(await drainBuddyQueue(new Date(Date.now() + SAVE_SETTLE_MS + 1000))).toMatchObject({ digested: 1 });
        expect(fake.calls).toHaveLength(1);
        const input = JSON.stringify(fake.calls[0]!.messages);
        expect(input).toContain('Started walking after work');
        expect(input).toContain('Aiming for 10,000 steps a day');
        expect(input).toContain('<known>\\nnothing yet');
        expect(input).toContain('<open_tasks>\\nnone');
        const threads = await prisma.buddyThread.findMany({ where: { userId: user.id } });
        expect(threads.map((t) => t.title)).toEqual(['Walking after work, 10,000 steps']);
        const ev = await prisma.buddyThreadEvent.findFirstOrThrow({ where: { threadId: threads[0]!.id } });
        expect(ev.basis).toBe('said');
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0);
    });

    it('JW3: a correction from the web changes the routine wherever memory is read (the night reads only the new version)', async () => {
        const { user, chat } = await person(false);
        const old = (await chat.post('/api/buddy/remember', { text: 'Walks after work', kind: 'pattern', inferred: false })).body.data.notes[0].memory;
        await chat.post('/api/buddy/update', { on: old._id, update: 'changed', text: 'Walks in the mornings now' });
        const active = await prisma.memory.findMany({ where: { userId: user.id, status: 'active' } });
        expect(active.map((m) => m.text)).toEqual(['Walks in the mornings now']);
        const brief = (await api(user).get('/api/brief?view=buddy')).body.data;
        expect(brief.inMotion.map((x: { text: string }) => x.text)).toEqual(['Walks in the mornings now']);
        expect(brief.savedLately.map((x: { text: string }) => x.text)).toContain('Walks in the mornings now');
    });

    it('JW4: the same update through a hook and a tool counts once, in either order', async () => {
        for (const order of ['hook first', 'tool first']) {
            const { user, chat } = await person();
            const walk = await thread(user.id, 'Walking after work', ['walk'], { stage: 'active' });
            const own = () =>
                withPersonLock(user.id, (tx) => addThreadEvent(tx, user.id, walk, { kind: 'done', text: 'walked after work today', saidAt: new Date(), forDay: today() as never, direct: true, via: 'hook', originKey: `hook:${order}` }));
            const said = () => chat.post('/api/buddy/update', { on: walk.id, update: 'done', text: 'Got my walk in today' });
            if (order === 'hook first') {
                await own();
                await said();
            } else {
                await said();
                await own();
            }
            const events = await prisma.buddyThreadEvent.findMany({ where: { threadId: walk.id, kind: 'done' } });
            expect(events.filter((e) => !e.duplicate), order).toHaveLength(1);
            expect(events.find((e) => !e.duplicate)!.direct, order).toBe(true);
        }
    });
});
