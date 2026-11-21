// Stage 3 of ECOSYSTEM_V2_PLAN: the core journey (J1) on scripted models, so it proves what code keeps
// (§4.16), not what a model judges. Maya (invented) mentions guitar in passing in her chat with the
// buddy; nothing is asked and no task appears. Days later she says she played. The next night the
// buddy asks once; she answers; the question and the line about it are gone from Home, the chat's
// context and the phone's day, and the next night knows. Two people never mix; a piece read twice
// writes nothing twice; a question about a quiet (noticed) thread is refused.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { queueOwnWords } from '../../src/services/buddy/capture.service';
import { drainBuddyQueue, nightIfDue } from '../../src/services/buddy/worker';
import { pulseIfDue } from '../../src/services/buddy/pulse';
import { answerAsk, openAsks } from '../../src/services/buddy/asks';
import { currentLine } from '../../src/services/buddy/voice';
import { threadsForNight } from '../../src/services/buddy/nightLoop';
import { DIGEST_LOOP_SCHEMA, applyThreadOps } from '../../src/services/buddy/understand';
import { dayState, eventsOn, withPersonLock } from '../../src/services/buddy/threads';
import { hearChat } from '../../src/services/buddy/chatEar';
import { GATE_SCHEMA_LOOP } from '../../src/services/buddy/digest';
import { LOCK_SCHEMA } from '../../src/services/buddy/think';
import { getAmbient } from '../../src/services/ambient/ambient.service';
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
beforeEach(async () => {
    fake.reset();
    await prisma.buddyChunk.deleteMany({});
});

// Kolkata time (UTC+5:30): Fri 20 Nov 20:00, Sat 21 Nov 05:00, Sun 22 Nov 21:00, Mon 23 Nov 05:00 and 19:00.
const D1 = new Date('2026-11-20T14:30:00Z');
const NIGHT2 = new Date('2026-11-20T23:30:00Z');
const D3 = new Date('2026-11-22T15:30:00Z');
const NIGHT4 = new Date('2026-11-22T23:30:00Z');
const EVE4 = new Date('2026-11-23T13:30:00Z');

const op = (over: Record<string, unknown>) => ({ op: 'open', threadId: '', title: '', keywords: [], kind: 'said', text: '', day: '', message: 1, askId: '', sensitive: false, lookAgainOn: '', rhythm: 'none', ...over });
const digest = (threads: unknown[]) => fakeMessage({ notes: [], items: [], threads }, { model: 'claude-sonnet-5-5' });
const night = (lines: Array<{ slot: string; text: string; about?: string[] }>, asks: unknown[] = []) =>
    fakeMessage({
        memory: [],
        who: '',
        heading: '',
        now: 'A busy week on the ward.',
        lines: lines.map((l) => ({ slot: l.slot, text: l.text, form: 'observation', lockOk: true, sourceId: '', about: l.about ?? [] })),
        insight: '',
        note: '',
        followUp: '',
        suggestions: [],
        notebook: 'Watching: guitar.',
        weekly: { use: false, strong: '', slipping: '', fix: '', deadline: '', focus: [] },
        insightAbout: [],
        noteAbout: [],
        asks,
        threadOps: [],
    });

async function person() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, loop: true });
    return user;
}

const say = (userId: string, seq: number, text: string, at: Date) => queueOwnWords(userId, { key: 'ask:chat-1', seq, via: 'ask_ai', messages: [{ at: at.toISOString(), text }] }, at);

describe('the loop: the core journey (J1)', () => {
    it('a passing intention, a later update, one question at the right hour, an answer that clears it everywhere', async () => {
        const maya = await person();

        // Day 1: in the middle of a longer message, a passing intention. Her own words skip the gate.
        await say(maya.id, 1, 'Long week at the ward. I also want to get back to guitar most evenings. Anyway, what is due tomorrow?', D1);
        fake.push(digest([op({ title: 'Get back to guitar most evenings', keywords: ['guitar', 'practice', 'music'], text: 'Wants to get back to guitar most evenings', rhythm: 'daily' })]));
        expect(await drainBuddyQueue(D1)).toMatchObject({ digested: 1, failed: 0 });
        expect(fake.calls.map((c) => c.output_config?.format?.schema)).toEqual([DIGEST_LOOP_SCHEMA]);
        const thread = await prisma.buddyThread.findFirstOrThrow({ where: { userId: maya.id } });
        expect(thread).toMatchObject({ stage: 'noticed', revision: 2, rhythm: 'daily' }); // opened, then its first word
        expect(await prisma.suggestion.count({ where: { userId: maya.id } })).toBe(0);

        // That night: a question about something mentioned once is refused (it stays silent until she comes back to it).
        fake.push(night([{ slot: 'evening', text: 'A quiet evening is allowed too' }], [{ threadId: thread.id, text: 'Guitar tonight?', answers: [], from: '18:00', until: '22:30' }]));
        const n2 = (await nightIfDue(maya.id, NIGHT2))!;
        expect(await prisma.buddyAsk.count({ where: { userId: maya.id } })).toBe(0);
        expect(n2.dropped.some((d) => /mentioned once/.test(d.why))).toBe(true);

        // Day 3: she played. The update joins the thread, which is active now.
        await say(maya.id, 2, 'Played guitar for fifteen minutes tonight, felt good', D3);
        fake.push(digest([op({ op: 'event', threadId: thread.id, kind: 'progress', text: 'Played guitar for fifteen minutes' })]));
        await drainBuddyQueue(D3);
        expect(await prisma.buddyThread.findUniqueOrThrow({ where: { id: thread.id } })).toMatchObject({ stage: 'active', revision: 3 });

        // The same piece sent again after it was read: nothing is written twice.
        await say(maya.id, 2, 'Played guitar for fifteen minutes tonight, felt good', D3);
        fake.push(digest([op({ op: 'event', threadId: thread.id, kind: 'progress', text: 'Played guitar for fifteen minutes' })]));
        await drainBuddyQueue(D3);
        expect(await prisma.buddyThreadEvent.count({ where: { threadId: thread.id } })).toBe(2);
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: thread.id } })).revision).toBe(3);

        // The next night: one question for the evening; a question it wrote as a line is moved to the
        // questions and refused there (one a day per thread); the evening line rests on the thread.
        fake.push(
            night(
                [
                    { slot: 'afternoon', text: 'Guitar later?', about: [thread.id] },
                    { slot: 'evening', text: 'The guitar is back, and it shows', about: [thread.id] },
                ],
                [{ threadId: thread.id, text: 'Got to the guitar tonight?', answers: [{ label: 'Did it', meaning: 'done' }, { label: 'Not today', meaning: 'skipped' }], from: '18:00', until: '22:30' }]
            )
        );
        const n4 = (await nightIfDue(maya.id, NIGHT4))!;
        expect(n4.lines.map((l) => l.slot)).not.toContain('afternoon');
        const asks = await prisma.buddyAsk.findMany({ where: { userId: maya.id } });
        expect(asks).toHaveLength(1);
        expect(asks[0]).toMatchObject({ state: 'open', seenRevision: 3 });
        expect(asks[0]!.buddyDayId).toBe(n4._id); // the step that wrote it

        // 19:00: Home shows the question; the evening line shows on the phone's day.
        expect((await openAsks(maya.id, 'web', EVE4)).map((a) => a.text)).toEqual(['Got to the guitar tonight?']);
        expect((await currentLine(maya.id, EVE4))?.text).toBe('The guitar is back, and it shows');
        const before = await getAmbient(maya.id, EVE4);
        expect(before.line?.text).toBe('The guitar is back, and it shows');

        // She taps "Did it". The question and every word about the thread written before it are gone.
        expect(await answerAsk(maya.id, asks[0]!.id, { choice: 0 }, new Date(EVE4.getTime() + 60_000))).toEqual({ state: 'answered' });
        const after = new Date(EVE4.getTime() + 2 * 60_000);
        expect(await openAsks(maya.id, 'web', after)).toEqual([]);
        expect(await currentLine(maya.id, after)).toBeNull();
        const ambient = await getAmbient(maya.id, after);
        expect(ambient.line).toBeNull();
        expect(ambient.key).not.toBe(before.key);
        // Safe to send twice.
        expect(await answerAsk(maya.id, asks[0]!.id, { choice: 0 }, after)).toEqual({ state: 'answered' });
        expect(await prisma.buddyThreadEvent.count({ where: { threadId: thread.id, kind: 'done' } })).toBe(1);

        // The next night knows what she answered.
        const next = await threadsForNight(maya.id, '2026-11-24', new Date('2026-11-23T23:30:00Z'));
        expect(next.block).toContain('Got to the guitar tonight?');
        expect(next.block).toMatch(/answered: Did it/);
    });

    it('the pulse reads the threads and ties its new line to the thread as it is now', async () => {
        const maya = await person();
        await say(maya.id, 1, 'I want to get back to guitar most evenings', D1);
        fake.push(digest([op({ title: 'Get back to guitar most evenings', keywords: ['guitar'], text: 'Wants to get back to guitar' })]));
        await drainBuddyQueue(D1);
        const thread = await prisma.buddyThread.findFirstOrThrow({ where: { userId: maya.id } });
        fake.push(night([{ slot: 'morning', text: 'One thing at a time today' }]));
        await nightIfDue(maya.id, NIGHT4);
        // 11:00: something new (a note and an event), so the 12:00 pulse runs.
        await say(maya.id, 2, 'Planning to play guitar again tonight', new Date('2026-11-23T05:30:00Z'));
        fake.push(fakeMessage({ notes: [{ text: 'Plans to play guitar tonight', kind: 'thread', private: false, seenMemoryId: '' }], items: [], threads: [op({ op: 'event', threadId: thread.id, kind: 'said', text: 'Plans to play tonight' })] }));
        await drainBuddyQueue(new Date('2026-11-23T05:30:00Z'));
        const rev = (await prisma.buddyThread.findUniqueOrThrow({ where: { id: thread.id } })).revision;
        fake.reset();
        fake.push(fakeMessage({ lines: [{ slot: 'evening', text: 'Tonight is for the guitar', form: 'push', lockOk: true, sourceId: '', about: [thread.id] }], note: '', insight: '', insightAbout: [], noteAbout: [], asks: [] }, { model: 'claude-sonnet-5-5' }));
        expect((await pulseIfDue(maya.id, new Date('2026-11-23T06:35:00Z'))).ran).toBe(true);
        expect(JSON.stringify(fake.calls[0]!.messages)).toContain(`${thread.id} · `);
        const pulse = await prisma.buddyDay.findFirstOrThrow({ where: { userId: maya.id, kind: 'pulse' } });
        const evening = (pulse.lines as Array<{ slot: string; about?: Array<{ threadId: string; rev: number }> }>).find((l) => l.slot === 'evening');
        expect(evening?.about).toEqual([{ threadId: thread.id, rev }]);
    });

    it('two people never mix: an event on another person’s thread is refused', async () => {
        const maya = await person();
        const arjun = await person();
        await say(maya.id, 1, 'I want to get back to guitar most evenings', D1);
        fake.push(digest([op({ title: 'Get back to guitar', keywords: ['guitar'], text: 'Wants to get back to guitar' })]));
        await drainBuddyQueue(D1);
        const hers = await prisma.buddyThread.findFirstOrThrow({ where: { userId: maya.id } });

        await queueOwnWords(arjun.id, { key: 'ask:chat-2', seq: 1, via: 'ask_ai', messages: [{ at: D3.toISOString(), text: 'Played for an hour today' }] }, D3);
        fake.push(digest([op({ op: 'event', threadId: hers.id, kind: 'progress', text: 'Played for an hour' })]));
        await drainBuddyQueue(D3);
        expect(await prisma.buddyThread.count({ where: { userId: arjun.id } })).toBe(0);
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: hers.id } })).revision).toBe(2);
        expect(await prisma.buddyThreadEvent.count({ where: { threadId: hers.id } })).toBe(1);
    });

    it('the loop off: the chat is not read and nothing of today changes', async () => {
        const user = await createTestUser();
        await api(user).patch('/api/buddy/settings', { enabled: true });
        const settings = await api(user).get('/api/buddy/settings');
        expect(settings.body.data.loop).toBe(false);
        expect((await api(user).get('/api/buddy/today')).body.data.asks).toEqual([]);
    });
});

// The rest of stage 3's code guarantees (§10, stage 3 "Done when"), each on scripted models.
const TZ = 'Asia/Kolkata';
const piece = (seq: number, source: 'app' | 'agent' = 'app') => ({ sessionKey: source === 'app' ? 'ask:chat-9' : 'cc_agent', seq, via: source === 'app' ? 'ask_ai' : 'agent', source });
const msg = (text: string, at: Date) => [{ at: at.toISOString(), text }];
async function apply(userId: string, p: ReturnType<typeof piece>, text: string, at: Date, ops: unknown[], now: Date, today: string) {
    return withPersonLock(userId, (tx) => applyThreadOps(tx, userId, p, msg(text, at), ops as Parameters<typeof applyThreadOps>[4], { now, tz: TZ, today: today as never }));
}

describe('the loop: the rest of stage 3', () => {
    it('J3: a passing thought makes no thread, task, suggestion or question; one opened by mistake stays silent and fades after 45 quiet days', async () => {
        const lena = await person();
        await say(lena.id, 1, 'Someday I would love to try pottery. Anyway, can you move my review to Friday?', D1);
        fake.push(fakeMessage({ notes: [{ text: 'Would love to try pottery someday', kind: 'idea', private: false, seenMemoryId: '' }], items: [], threads: [] }));
        await drainBuddyQueue(D1);
        expect(await prisma.buddyThread.count({ where: { userId: lena.id } })).toBe(0);
        expect(await prisma.todo.count({ where: { userId: lena.id } })).toBe(0);
        expect(await prisma.suggestion.count({ where: { userId: lena.id } })).toBe(0);
        // A question about a thread that does not exist is dropped.
        fake.push(night([], [{ threadId: 'no-such-thread', text: 'Pottery this week?', answers: [], from: '18:00', until: '22:30' }]));
        await nightIfDue(lena.id, NIGHT2);
        expect(await prisma.buddyAsk.count({ where: { userId: lena.id } })).toBe(0);

        // The model opens a thread by mistake: it stays noticed, the night may not ask about it, and it fades.
        await say(lena.id, 2, 'Pottery would be fun one day', D3);
        fake.push(digest([op({ title: 'Try pottery', keywords: ['pottery', 'ceramics', 'clay'], text: 'Would like to try pottery one day' })]));
        await drainBuddyQueue(D3);
        const thread = await prisma.buddyThread.findFirstOrThrow({ where: { userId: lena.id } });
        expect(thread.stage).toBe('noticed');
        fake.push(night([], [{ threadId: thread.id, text: 'Booked a pottery class yet?', answers: [], from: '18:00', until: '22:30' }]));
        await nightIfDue(lena.id, NIGHT4);
        expect(await prisma.buddyAsk.count({ where: { userId: lena.id } })).toBe(0);
        // 44 quiet days: still there. 46: faded (closed by code), out of the night's view, still found by a new word.
        fake.push(night([]));
        await nightIfDue(lena.id, new Date(D3.getTime() + 44 * 86_400_000 + 9 * 3600_000));
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: thread.id } })).stage).toBe('noticed');
        const late = new Date(D3.getTime() + 46 * 86_400_000 + 9 * 3600_000);
        fake.push(night([]));
        await nightIfDue(lena.id, late);
        expect(await prisma.buddyThread.findUniqueOrThrow({ where: { id: thread.id } })).toMatchObject({ stage: 'dropped' });
        expect((await threadsForNight(lena.id, '2026-01-08', late)).block).not.toContain(thread.id);
    });

    it('a change of plan renames the thread; a late older word or a passed-on one never does', async () => {
        const omar = await person();
        const t0 = new Date('2026-11-20T03:00:00Z');
        const now = new Date('2026-11-23T15:00:00Z');
        await apply(omar.id, piece(1), 'I want to run three mornings a week', t0, [op({ title: 'Run three mornings a week', keywords: ['run', 'running', 'jog'], text: 'Wants to run three mornings a week' })], t0, '2026-11-20');
        const thread = await prisma.buddyThread.findFirstOrThrow({ where: { userId: omar.id } });
        const change = await apply(omar.id, piece(2), 'Mornings are not working. I will run on weekends instead.', now, [op({ op: 'event', threadId: thread.id, kind: 'changed', title: 'Run on weekends', keywords: ['weekend'], text: 'Runs on weekends instead of mornings' })], now, '2026-11-23');
        expect(change.renamed).toBe(1);
        const renamed = await prisma.buddyThread.findUniqueOrThrow({ where: { id: thread.id } });
        expect(renamed).toMatchObject({ title: 'Run on weekends', stage: 'active' });
        expect(renamed.keywords).toEqual(expect.arrayContaining(['weekend', 'run']));
        // An older word that arrives late joins the history and renames nothing; an agent's note neither.
        await apply(omar.id, piece(3), 'Thinking of evening runs', new Date('2026-11-22T13:00:00Z'), [op({ op: 'event', threadId: thread.id, kind: 'changed', title: 'Run in the evenings', text: 'Considering evening runs' })], now, '2026-11-23');
        await apply(omar.id, piece(1, 'agent'), 'He moved his runs to the gym', new Date('2026-11-23T16:00:00Z'), [op({ op: 'event', threadId: thread.id, kind: 'changed', title: 'Run at the gym', text: 'Runs at the gym now' })], new Date('2026-11-23T16:01:00Z'), '2026-11-23');
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: thread.id } })).title).toBe('Run on weekends');
        expect(await prisma.buddyThreadEvent.count({ where: { threadId: thread.id } })).toBe(4);
    });

    it('a question asked inside a doc goes through the gate; an instruction about the doc is dropped there', async () => {
        const maya = await person();
        const chat = await prisma.assistantThread.create({ data: { userId: maya.id, title: 'In a doc' } });
        const mine = { _id: 'm1', role: 'user' as const, text: 'Make this section shorter', tools: [], costUsd: null, createdAt: D1 };
        await hearChat(maya.id, chat.id, mine, { inDoc: true, before: null, reply: 'Done: the section is shorter.', index: 0 }, D1);
        expect(await prisma.buddyChunk.findFirstOrThrow({ where: { userId: maya.id } })).toMatchObject({ via: 'doc_ask' });
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'none' }] }, { model: 'claude-haiku-5-5' }));
        expect(await drainBuddyQueue(D1)).toMatchObject({ digested: 1, failed: 0 });
        expect(fake.calls.map((c) => c.output_config?.format?.schema)).toEqual([GATE_SCHEMA_LOOP]); // stage 4: the gate for anyone
        expect(await prisma.observation.count({ where: { userId: maya.id } })).toBe(0);
    });

    it('a third question in a day is refused, and a second about the same thread', async () => {
        const sam = await person();
        const ids: string[] = [];
        for (const [i, title] of ['Read before bed', 'Walk after lunch', 'Call home on Sundays'].entries()) {
            await apply(sam.id, piece(i + 1), `${title}: did it today`, D3, [op({ title, keywords: title.toLowerCase().split(' '), kind: 'progress', text: `${title}, did it today` })], D3, '2026-11-22');
            ids.push((await prisma.buddyThread.findFirstOrThrow({ where: { userId: sam.id, title } })).id);
        }
        const ask = (threadId: string, text: string) => ({ threadId, text, answers: [], from: '18:00', until: '22:30' });
        fake.push(night([], [ask(ids[0]!, 'Read tonight?'), ask(ids[0]!, 'A chapter tonight?'), ask(ids[1]!, 'A walk today?'), ask(ids[2]!, 'Calling home?')]));
        const n = (await nightIfDue(sam.id, NIGHT4))!;
        expect((await prisma.buddyAsk.findMany({ where: { userId: sam.id }, orderBy: { createdAt: 'asc' } })).map((a) => a.text)).toEqual(['Read tonight?', 'A walk today?']);
        expect(n.dropped.map((d) => d.why)).toEqual(expect.arrayContaining(['a question about it today already', 'two questions today already']));
    });

    it('a wrong tap corrected 40 seconds later ends as corrected; the same tap again changes nothing; an agent’s late note never overrules her button', async () => {
        const maya = await person();
        await apply(maya.id, piece(1), 'Played guitar tonight', D3, [op({ title: 'Guitar most evenings', keywords: ['guitar'], kind: 'progress', text: 'Played guitar' })], D3, '2026-11-22');
        const thread = await prisma.buddyThread.findFirstOrThrow({ where: { userId: maya.id } });
        fake.push(night([], [{ threadId: thread.id, text: 'Guitar tonight?', answers: [{ label: 'Did it', meaning: 'done' }, { label: 'Not today', meaning: 'skipped' }], from: '18:00', until: '22:30' }]));
        await nightIfDue(maya.id, NIGHT4);
        const ask = await prisma.buddyAsk.findFirstOrThrow({ where: { userId: maya.id } });
        const day = '2026-11-23';
        const state = async () => dayState(await eventsOn(thread.id, day));

        await answerAsk(maya.id, ask.id, { choice: 1 }, EVE4);
        expect(await state()).toBe('skipped');
        await answerAsk(maya.id, ask.id, { choice: 0 }, new Date(EVE4.getTime() + 40_000));
        expect(await state()).toBe('done');
        expect((await prisma.buddyAsk.findUniqueOrThrow({ where: { id: ask.id } })).answer).toBe('Did it');
        await answerAsk(maya.id, ask.id, { choice: 0 }, new Date(EVE4.getTime() + 41_000));
        expect(await prisma.buddyThreadEvent.count({ where: { threadId: thread.id, via: 'answer' } })).toBe(2);
        // Back and forth: each change is a correction, never a duplicate.
        await answerAsk(maya.id, ask.id, { choice: 1 }, new Date(EVE4.getTime() + 60_000));
        await answerAsk(maya.id, ask.id, { choice: 0 }, new Date(EVE4.getTime() + 70_000));
        expect(await state()).toBe('done');
        // An agent saves "skipped" for the same day, later: passed on, it never overrules her own word.
        await apply(maya.id, piece(1, 'agent'), 'She did not play today', new Date(EVE4.getTime() + 3600_000), [op({ op: 'event', threadId: thread.id, kind: 'skipped', day, text: 'Did not play' })], new Date(EVE4.getTime() + 3600_000), day);
        expect(await state()).toBe('done');
        expect(await prisma.buddyThreadEvent.count({ where: { threadId: thread.id, direct: false } })).toBe(1);
    });

    it('a piece whose writing fails is read again whole: nothing is written twice', async () => {
        const maya = await person();
        await say(maya.id, 1, 'I want to get back to guitar most evenings', D1);
        const answer = () => digest([op({ title: 'Get back to guitar', keywords: ['guitar'], text: 'Wants to get back to guitar' })]);
        // The model's answer arrives, then the writing fails inside the transaction: nothing of it stays.
        fake.push(answer());
        const real = prisma.$transaction.bind(prisma);
        let fail = true;
        (prisma as unknown as { $transaction: unknown }).$transaction = (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
            real(async (tx) => {
                const r = await fn(tx);
                if (fail) {
                    fail = false;
                    throw new Error('forced after the writes');
                }
                return r;
            }, opts as never);
        try {
            expect(await drainBuddyQueue(D1)).toMatchObject({ digested: 0, failed: 1 });
        } finally {
            (prisma as unknown as { $transaction: unknown }).$transaction = real;
        }
        expect(await prisma.buddyThread.count({ where: { userId: maya.id } })).toBe(0);
        expect(await prisma.buddyChunk.count({ where: { userId: maya.id } })).toBe(1);
        fake.push(answer());
        expect(await drainBuddyQueue(new Date(D1.getTime() + 16 * 60_000))).toMatchObject({ digested: 1 });
        expect(await prisma.buddyThread.count({ where: { userId: maya.id } })).toBe(1);
        expect(await prisma.buddyThreadEvent.count({ where: { userId: maya.id } })).toBe(1);
    });

    it('a person with no private memory still has every line checked; a failed check keeps them off', async () => {
        const arjun = await person();
        fake.push(night([{ slot: 'evening', text: 'An early night would help tomorrow' }]));
        const ok = (await nightIfDue(arjun.id, NIGHT2))!;
        expect(fake.calls.map((c) => c.output_config?.format?.schema)).toContain(LOCK_SCHEMA);
        expect(ok.lines.find((l) => l.slot === 'evening')?.lockOk).toBe(true);
        fake.reset();
        fake.push(night([{ slot: 'evening', text: 'Short day, short list' }]), new Error('check down'));
        const failed = (await nightIfDue(arjun.id, NIGHT4))!;
        expect(failed.lines.every((l) => !l.lockOk)).toBe(true);
    });
});
