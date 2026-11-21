// Stage 4 of ECOSYSTEM_V2_PLAN (more ears, hardened) on scripted models: message numbers and the session
// mark (§4.11 rule 2), a hook that holds while the AI is paused (§4.15), a session's pieces read together
// (or at once while a question is open), saved notes through the understanding step (an agent's note
// passed on, "Tell" his own), counts per source, old news that builds history only, the first night back
// told the days it could not listen, the gate for anyone, the questions in an agent's brief.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { HOOK_WAIT_MS, drainBuddyQueue, nextCaptureDue, nightIfDue } from '../../src/services/buddy/worker';
import { DIGEST_LOOP_SCHEMA } from '../../src/services/buddy/understand';
import { GATE_SCHEMA_LOOP, GATE_SYSTEM_LOOP } from '../../src/services/buddy/digest';
import { addThreadEvent, openOrFindThread, withPersonLock } from '../../src/services/buddy/threads';
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
beforeEach(async () => {
    fake.reset();
    await prisma.buddyChunk.deleteMany({});
    await prisma.aiKeyState.deleteMany({});
});

async function person(loop = true) {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, loop });
    const hook = asAgent((await createTestToken(user, ['read', 'sessions:write'])).token, 'Claude Code hook');
    return { user, hook };
}
const op = (over: Record<string, unknown>) => ({ op: 'open', threadId: '', title: '', keywords: [], kind: 'said', text: '', day: '', message: 1, askId: '', sensitive: false, lookAgainOn: '', rhythm: 'none', ...over });
const msg = (n: number, text: string, at: string, extra: Record<string, unknown> = {}) => ({ n, at, text, ...extra });
// Said now: a fixed day turned into "said yesterday" once the calendar moved on (11-19).
const NOW = new Date().toISOString();
/** A night that says nothing (the loop's fields included). */
const quietNight = () =>
    fakeMessage({ memory: [], who: '', heading: '', now: '', lines: [], insight: '', note: '', followUp: '', suggestions: [], notebook: '', weekly: { use: false, strong: '', slipping: '', fix: '', deadline: '', focus: [] }, insightAbout: [], noteAbout: [], asks: [], threadOps: [] });

describe('message numbers and the session mark', () => {
    it('takes only what is new, whatever is sent again; the last message read comes along as context; every answer says capture 2', async () => {
        const { user, hook } = await person();
        const send = (messages: unknown[], seq = 1) => hook.post('/api/buddy/words', { sessionKey: 'cc_n1', seq, v: 2, canHold: true, messages });
        const a = await send([msg(1, 'I want to run three mornings a week', NOW)]);
        expect(a.status).toBe(202);
        expect(a.body.data).toMatchObject({ queued: 1, read: 1, capture: 2 });
        // The answer was lost: the hook sends message 1 again with message 2.
        const b = await send([msg(1, 'I want to run three mornings a week', NOW), msg(2, 'and stretch after each run', NOW)], 2);
        expect(b.body.data).toMatchObject({ queued: 1, read: 2 });
        const second = await prisma.buddyChunk.findFirstOrThrow({ where: { userId: user.id, seq: 2 } });
        expect((second.messages as Array<{ n: number; context?: boolean }>).map((m) => [m.n, !!m.context])).toEqual([
            [1, true],
            [2, false],
        ]);
        // The same again: nothing new.
        expect((await send([msg(1, 'x', NOW, { context: true }), msg(2, 'and stretch after each run', NOW)], 3)).body.data).toMatchObject({ queued: 0, read: 2, duplicate: true });
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(2);
        // Today's pieces still work, and learn the protocol from the answer.
        expect((await hook.post('/api/buddy/words', { sessionKey: 'cc_old', seq: 1, messages: [{ at: NOW, text: 'an old hook still works' }] })).body.data).toMatchObject({ queued: 1, capture: 2 });
        // Numbers are required in the second protocol.
        expect((await hook.post('/api/buddy/words', { sessionKey: 'cc_n2', seq: 1, v: 2, messages: [{ at: NOW, text: 'no number' }] })).status).toBe(400);
        // Counts per source, with when it was last heard.
        const day = await prisma.buddyCaptureDay.findFirstOrThrow({ where: { userId: user.id } });
        expect(day.bySource).toMatchObject({ hook: { seen: 3, pieces: 3, dropped: 0 } });
        expect(typeof (day.bySource as { hook: { last: string } }).hook.last).toBe('string');
    });

    it('a hook that can hold is told 503 AI_PAUSED while the AI is paused (nothing taken); an older hook gets today’s answer; a buddy he paused marks the words taken', async () => {
        const { user, hook } = await person();
        await prisma.aiKeyState.create({ data: { keyId: 'house', state: 'no_credit' } });
        const held = await hook.post('/api/buddy/words', { sessionKey: 'cc_h', seq: 1, v: 2, canHold: true, messages: [msg(1, 'Skipped the run again', NOW)] });
        expect(held.status).toBe(503);
        expect(held.body.code).toBe('AI_PAUSED');
        expect(await prisma.buddySessionMark.count({ where: { userId: user.id } })).toBe(0);
        expect((await hook.post('/api/buddy/words', { sessionKey: 'cc_h', seq: 1, messages: [{ at: NOW, text: 'Skipped the run again' }] })).status).toBe(202);
        await prisma.aiKeyState.deleteMany({});
        await api(user).patch('/api/buddy/settings', { paused: true });
        expect((await hook.post('/api/buddy/words', { sessionKey: 'cc_p', seq: 1, v: 2, canHold: true, messages: [msg(1, 'private thoughts', NOW), msg(2, 'more of them', NOW)] })).body.data).toMatchObject({ queued: 0, paused: true, read: 2 });
    });
});

describe('a session’s pieces read together', () => {
    it('wait to be read together (or 2,000 characters), at once while a question is open; the next wake is when they fall due', async () => {
        const { user, hook } = await person();
        const t0 = new Date();
        for (const [n, text] of [
            [1, 'Ran this morning, 5 km'],
            [2, 'Thinking of adding a fourth day'],
        ] as const)
            await hook.post('/api/buddy/words', { sessionKey: 'cc_m', seq: n, v: 2, canHold: true, messages: [msg(n, text, t0.toISOString())] });
        expect(await drainBuddyQueue(new Date(t0.getTime() + 60_000))).toMatchObject({ digested: 0, waiting: 2 });
        const next = await nextCaptureDue(new Date(t0.getTime() + 60_000));
        expect(next!.getTime()).toBeLessThanOrEqual(t0.getTime() + HOOK_WAIT_MS + 5_000);
        // Ten minutes on: one gate call over both, one digest; both pieces gone in its transaction.
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'update' }, { i: 2, label: 'personal' }] }, { model: 'claude-haiku-5-5' }));
        fake.push(fakeMessage({ notes: [], items: [], threads: [op({ title: 'Run three mornings a week', keywords: ['run'], kind: 'progress', text: 'Ran 5 km' })] }, { model: 'claude-sonnet-5-5' }));
        expect(await drainBuddyQueue(new Date(t0.getTime() + HOOK_WAIT_MS + 1000))).toMatchObject({ digested: 1, failed: 0 });
        expect(fake.calls.map((c) => c.output_config?.format?.schema)).toEqual([GATE_SCHEMA_LOOP, DIGEST_LOOP_SCHEMA]);
        const gateText = JSON.stringify(fake.calls[0]!.messages);
        expect(gateText).toContain('[1] Ran this morning, 5 km');
        expect(gateText).toContain('[2] Thinking of adding a fourth day');
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0);

        // A question is open: a short answer is read at once.
        const thread = await prisma.buddyThread.findFirstOrThrow({ where: { userId: user.id } });
        await prisma.buddyAsk.create({ data: { userId: user.id, threadId: thread.id, text: 'A run tonight?', fromAt: new Date(t0.getTime() - 3600_000), untilAt: new Date(t0.getTime() + 6 * 3600_000), seenRevision: thread.revision } });
        await hook.post('/api/buddy/words', { sessionKey: 'cc_m', seq: 3, v: 2, canHold: true, messages: [msg(3, 'did it', new Date(t0.getTime() + 120_000).toISOString())] });
        fake.reset();
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'update' }] }, { model: 'claude-haiku-5-5' }));
        fake.push(fakeMessage({ notes: [], items: [], threads: [] }, { model: 'claude-sonnet-5-5' }));
        expect(await drainBuddyQueue(new Date(t0.getTime() + 130_000))).toMatchObject({ digested: 1 });
        expect(JSON.stringify(fake.calls[0]!.messages)).toContain('A run tonight?'); // the gate sees the open question
    });
});

describe('the gate for anyone (the loop on)', () => {
    it('is written for any person, sees the thread titles and the open questions, marks a context message, keeps an update', async () => {
        const { user, hook } = await person();
        await withPersonLock(user.id, (tx) => openOrFindThread(tx, user.id, { title: 'Learn to swim', keywords: ['swim', 'pool'] }, { saidAt: new Date(), forDay: '2026-11-18' }));
        await prisma.buddyState.update({ where: { userId: user.id }, data: { workLog: false } });
        await hook.post('/api/buddy/words', { sessionKey: 'cc_g', seq: 1, v: 2, canHold: true, messages: [msg(1, 'went to the pool, two lengths', NOW)] });
        await hook.post('/api/buddy/words', { sessionKey: 'cc_g', seq: 2, v: 2, canHold: true, messages: [msg(1, 'went to the pool, two lengths', NOW, { context: true }), msg(2, 'now fix the failing test in the parser', NOW)] });
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'update' }, { i: 2, label: 'none' }] }, { model: 'claude-haiku-5-5' }));
        fake.push(fakeMessage({ notes: [], items: [], threads: [] }, { model: 'claude-sonnet-5-5' }));
        await drainBuddyQueue(new Date(Date.now() + HOOK_WAIT_MS + 1000));
        const gate = fake.calls[0]!;
        expect(gate.output_config?.format?.schema).toEqual(GATE_SCHEMA_LOOP);
        expect(JSON.stringify(gate.system)).toContain(JSON.stringify(GATE_SYSTEM_LOOP).slice(1, 60));
        expect(GATE_SYSTEM_LOOP).not.toMatch(/\bhe\b|\bhis\b|\bhim\b/);
        expect(JSON.stringify(gate.messages)).toContain('Learn to swim');
        const digest = JSON.stringify(fake.calls[1]!.messages);
        expect(digest).toContain('[1] KEEP: went to the pool');
        expect(digest).toContain('[2] context: now fix the failing test');
    });
});

describe('saved notes through the understanding step', () => {
    it('an agent’s note is tied to a thread as passed on; "Tell" as his own words; neither is written twice as a note', async () => {
        const { user } = await person();
        const agent = asAgent((await createTestToken(user)).token, 'study-chat');
        const thread = (await withPersonLock(user.id, (tx) => openOrFindThread(tx, user.id, { title: 'Run three mornings a week', keywords: ['run', 'running'] }, { saidAt: new Date(Date.now() - 86_400_000), forDay: '2026-11-17' }))).thread;
        await agent.post('/api/buddy/remember', { text: 'Ran this morning before work', kind: 'win' });
        const piece = await prisma.buddyChunk.findFirstOrThrow({ where: { userId: user.id } });
        expect(piece).toMatchObject({ source: 'agent', via: 'agent' });
        expect(piece.noteId).toBeTruthy();
        fake.push(fakeMessage({ notes: [{ text: 'Ran this morning', kind: 'win', private: false, seenMemoryId: '' }], items: [], threads: [op({ op: 'event', threadId: thread.id, kind: 'progress', text: 'Ran this morning' })] }, { model: 'claude-sonnet-5-5' }));
        expect(await drainBuddyQueue()).toMatchObject({ digested: 1 });
        expect(fake.calls.map((c) => c.output_config?.format?.schema)).toEqual([DIGEST_LOOP_SCHEMA]); // no gate
        expect(await prisma.buddyThreadEvent.findFirstOrThrow({ where: { threadId: thread.id } })).toMatchObject({ kind: 'progress', direct: false, via: 'agent' });
        expect(await prisma.observation.count({ where: { userId: user.id } })).toBe(1); // the note itself, once
        expect(JSON.stringify(fake.calls[0]!.messages)).toContain('notes an AI agent saved about them');

        await api(user).post('/api/buddy/tell', { text: 'Skipped the run today, my knee hurts' });
        fake.push(fakeMessage({ notes: [], items: [], threads: [op({ op: 'event', threadId: thread.id, kind: 'skipped', text: 'Skipped, knee hurts' })] }, { model: 'claude-sonnet-5-5' }));
        await drainBuddyQueue();
        expect(await prisma.buddyThreadEvent.findFirstOrThrow({ where: { threadId: thread.id, kind: 'skipped' } })).toMatchObject({ direct: true, via: 'tell' });
        const day = await prisma.buddyCaptureDay.findFirstOrThrow({ where: { userId: user.id } });
        expect(day.bySource).toMatchObject({ agent: { seen: 1, pieces: 1 }, tell: { seen: 1, pieces: 1 } });
    });

    it('a note waiting to be linked is not raw chat: it waits past 48 hours while the AI is paused', async () => {
        const { user } = await person();
        const agent = asAgent((await createTestToken(user)).token);
        await agent.post('/api/buddy/remember', { text: 'Prefers to study after 9 pm', kind: 'preference' });
        await prisma.aiKeyState.create({ data: { keyId: 'house', state: 'no_credit' } });
        expect(await drainBuddyQueue(new Date(Date.now() + 3 * 86_400_000))).toMatchObject({ dropped: 0 });
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(1);
    });
});

describe('old news and the first night back', () => {
    it('words said more than 48 hours before they arrive build history only: no stage moves, the revision does', async () => {
        const { user } = await person();
        const now = new Date('2026-11-20T10:00:00Z');
        const thread = (await withPersonLock(user.id, (tx) => openOrFindThread(tx, user.id, { title: 'Learn to swim', keywords: ['swim'] }, { saidAt: new Date('2026-11-15T10:00:00Z'), forDay: '2026-11-15' }, now))).thread;
        await withPersonLock(user.id, (tx) => addThreadEvent(tx, user.id, thread, { kind: 'said', text: 'Wants to learn to swim', saidAt: new Date('2026-11-15T10:00:00Z'), forDay: '2026-11-15', direct: true, via: 'hook', originKey: 'o:1' }, now));
        const fresh = await prisma.buddyThread.findUniqueOrThrow({ where: { id: thread.id } });
        await withPersonLock(user.id, (tx) => addThreadEvent(tx, user.id, fresh, { kind: 'progress', text: 'Swam two lengths', saidAt: new Date('2026-11-17T10:00:00Z'), forDay: '2026-11-17', direct: true, via: 'hook', originKey: 'o:2' }, now));
        const after = await prisma.buddyThread.findUniqueOrThrow({ where: { id: thread.id } });
        expect(after.stage).toBe('noticed');
        expect(after.revision).toBe(fresh.revision + 1);
    });

    it('the first night after the AI was paused is told the days it could not listen, once the key is back', async () => {
        const { user } = await person();
        const { markKeyOk } = await import('../../src/services/claude/access');
        await prisma.aiKeyState.create({ data: { keyId: 'house', state: 'no_credit', since: new Date('2026-11-18T05:00:00Z') } });
        expect(await markKeyOk('house', new Date('2026-11-20T08:00:00Z'))).toBe(true);
        expect(await prisma.aiKeyState.findUniqueOrThrow({ where: { keyId: 'house' } })).toMatchObject({ state: 'ok', pausedFrom: new Date('2026-11-18T05:00:00Z'), pausedTo: new Date('2026-11-20T08:00:00Z') });
        fake.push(quietNight());
        await nightIfDue(user.id, new Date('2026-11-20T23:30:00Z'));
        const text = JSON.stringify(fake.calls[0]!.messages);
        expect(text).toContain('<could_not_listen>From 2026-11-18 to 2026-11-20');
        fake.reset();
        fake.push(quietNight());
        await nightIfDue(user.id, new Date('2026-11-22T23:30:00Z'));
        expect(JSON.stringify(fake.calls[0]!.messages)).not.toContain('could_not_listen');
    });
});

describe('the questions in an agent’s brief', () => {
    it('the brief carries the open questions and the protocol; a work folder’s brief never does', async () => {
        const { user } = await person();
        const reader = asAgent((await createTestToken(user, ['read'])).token);
        const thread = (await withPersonLock(user.id, (tx) => openOrFindThread(tx, user.id, { title: 'Read before bed', keywords: ['read', 'book'] }, { saidAt: new Date(), forDay: '2026-11-18' }))).thread;
        await prisma.buddyAsk.create({ data: { userId: user.id, threadId: thread.id, text: 'A chapter tonight?', answers: [{ label: 'Did it', meaning: 'done' }], fromAt: new Date(Date.now() - 60_000), untilAt: new Date(Date.now() + 3600_000), seenRevision: thread.revision } });
        const brief = (await reader.get('/api/brief')).body.data;
        expect(brief.capture).toBe(2);
        expect(brief.asks).toEqual([expect.objectContaining({ text: 'A chapter tonight?', answers: ['Did it'] })]);
        expect((await prisma.buddyAsk.findFirstOrThrow({ where: { userId: user.id } })).shownOn).toContain('brief');
        const work = (await reader.get('/api/brief?work=true&project=acme')).body.data;
        expect(work.asks ?? []).toEqual([]);
    });
});

describe('the stage-4 journeys on scripted models', () => {
    it('J4: the same update from her chat and an agent’s note counts once; an older update that arrives late only joins the history', async () => {
        const { user, hook } = await person();
        const agent = asAgent((await createTestToken(user)).token, 'music-chat');
        const t0 = new Date();
        const thread = (await withPersonLock(user.id, (tx) => openOrFindThread(tx, user.id, { title: 'Guitar most evenings', keywords: ['guitar'] }, { saidAt: new Date(t0.getTime() - 3 * 86_400_000), forDay: '2026-11-15' }))).thread;
        await hook.post('/api/buddy/words', { sessionKey: 'cc_j4', seq: 1, v: 2, canHold: true, messages: [msg(1, 'played guitar for twenty minutes', t0.toISOString())] });
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'update' }] }, { model: 'claude-haiku-5-5' }));
        fake.push(fakeMessage({ notes: [], items: [], threads: [op({ op: 'event', threadId: thread.id, kind: 'progress', text: 'Played guitar for twenty minutes' })] }, { model: 'claude-sonnet-5-5' }));
        await drainBuddyQueue(new Date(t0.getTime() + HOOK_WAIT_MS + 1000));
        await agent.post('/api/buddy/remember', { text: 'Played guitar for twenty minutes today', kind: 'win' });
        fake.push(fakeMessage({ notes: [], items: [], threads: [op({ op: 'event', threadId: thread.id, kind: 'progress', text: 'Played guitar for twenty minutes' })] }, { model: 'claude-sonnet-5-5' }));
        await drainBuddyQueue(new Date(t0.getTime() + HOOK_WAIT_MS + 2000));
        const events = await prisma.buddyThreadEvent.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: 'asc' } });
        expect(events.map((e) => [e.direct, e.duplicate])).toEqual([
            [true, false],
            [false, true],
        ]);
        const before = await prisma.buddyThread.findUniqueOrThrow({ where: { id: thread.id } });
        // A message said two days earlier arrives now (held on her laptop): history only.
        await hook.post('/api/buddy/words', { sessionKey: 'cc_j4b', seq: 1, v: 2, canHold: true, messages: [msg(1, 'gave up on guitar for now', new Date(t0.getTime() - 2.5 * 86_400_000).toISOString())] });
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'update' }] }, { model: 'claude-haiku-5-5' }));
        fake.push(fakeMessage({ notes: [], items: [], threads: [op({ op: 'event', threadId: thread.id, kind: 'dropped', text: 'Gave up on guitar for now' })] }, { model: 'claude-sonnet-5-5' }));
        await drainBuddyQueue(new Date(t0.getTime() + 2 * HOOK_WAIT_MS));
        const after = await prisma.buddyThread.findUniqueOrThrow({ where: { id: thread.id } });
        expect(after.stage).toBe(before.stage);
        expect(after.revision).toBe(before.revision + 1);
    });

    it('J4 the other way round: an agent’s note read first, her own words in other words after: hers stand, the note becomes the duplicate', async () => {
        const { user, hook } = await person();
        const agent = asAgent((await createTestToken(user)).token, 'music-chat');
        const t0 = new Date();
        const thread = (await withPersonLock(user.id, (tx) => openOrFindThread(tx, user.id, { title: 'Guitar most evenings', keywords: ['guitar'] }, { saidAt: new Date(t0.getTime() - 3 * 86_400_000), forDay: '2026-11-15' }))).thread;
        await agent.post('/api/buddy/remember', { text: 'Played guitar for twenty minutes this evening', kind: 'win' });
        fake.push(fakeMessage({ notes: [], items: [], threads: [op({ op: 'event', threadId: thread.id, kind: 'progress', text: 'Played guitar for twenty minutes this evening' })] }, { model: 'claude-sonnet-5-5' }));
        await drainBuddyQueue(new Date(Date.now() + 1000));
        await hook.post('/api/buddy/words', { sessionKey: 'cc_j4r', seq: 1, v: 2, canHold: true, messages: [msg(1, 'played guitar for twenty minutes before dinner, fingertips hurt', new Date().toISOString())] });
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'update' }] }, { model: 'claude-haiku-5-5' }));
        fake.push(fakeMessage({ notes: [], items: [], threads: [op({ op: 'event', threadId: thread.id, kind: 'progress', text: 'Played guitar for twenty minutes before dinner' })] }, { model: 'claude-sonnet-5-5' }));
        await drainBuddyQueue(new Date(Date.now() + HOOK_WAIT_MS + 3000));
        const events = await prisma.buddyThreadEvent.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: 'asc' } });
        expect(events.map((e) => [e.direct, e.duplicate])).toEqual([
            [false, true],
            [true, false],
        ]);
    });

    it('J9 (first part): credits run out and return: held words arrive with their own times, are read in order, and the night is told it could not listen', async () => {
        const { user, hook } = await person();
        const t0 = new Date();
        await prisma.aiKeyState.create({ data: { keyId: 'house', state: 'no_credit', since: new Date(t0.getTime() - 2 * 86_400_000) } });
        const at = (h: number) => new Date(t0.getTime() - h * 3600_000).toISOString();
        const held = [msg(1, 'started the new course today', at(40)), msg(2, 'finished the first module', at(20))];
        expect((await hook.post('/api/buddy/words', { sessionKey: 'cc_j9', seq: 1, v: 2, canHold: true, messages: held })).status).toBe(503);
        const { markKeyOk } = await import('../../src/services/claude/access');
        await markKeyOk('house', t0);
        expect((await hook.post('/api/buddy/words', { sessionKey: 'cc_j9', seq: 1, v: 2, canHold: true, messages: held })).body.data).toMatchObject({ queued: 2, read: 2 });
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'personal' }, { i: 2, label: 'update' }] }, { model: 'claude-haiku-5-5' }));
        fake.push(fakeMessage({ notes: [], items: [], threads: [] }, { model: 'claude-sonnet-5-5' }));
        await drainBuddyQueue(new Date(t0.getTime() + HOOK_WAIT_MS + 1000));
        expect(JSON.stringify(fake.calls[0]!.messages)).toMatch(/\[1\] started the new course today.*\[2\] finished the first module/);
        // The reading is told the day each held word was said, so its "today" stays that day (J9 on the real models).
        expect(JSON.stringify(fake.calls[1]!.messages)).toMatch(/\[1\] KEEP \(said [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{4}-\d{2}-\d{2}\): started the new course today/);
        expect((await (await import('../../src/services/claude/access')).recentPause(user.id, t0))?.to).toEqual(t0);
    });

    it('J10: among 60 threads an update in other words still finds its own (every title in view); a word about a dropped one opens it again', async () => {
        const { user, hook } = await person();
        const t0 = new Date();
        const ids: string[] = [];
        await withPersonLock(user.id, async (tx) => {
            // Titles that share no words (a close match would be the same thread: §4.12).
            for (let i = 0; i < 60; i++) ids.push((await openOrFindThread(tx, user.id, { title: `Errand q${i}z${i}`, keywords: [`q${i}z${i}`] }, { saidAt: new Date(t0.getTime() - (i + 1) * 3600_000), forDay: '2026-11-17' })).thread.id);
            const pottery = (await openOrFindThread(tx, user.id, { title: 'Weekend pottery class', keywords: ['pottery', 'ceramics', 'clay'] }, { saidAt: new Date(t0.getTime() - 20 * 86_400_000), forDay: '2026-10-29' })).thread;
            await tx.buddyThread.update({ where: { id: pottery.id }, data: { stage: 'dropped', closedAt: new Date(t0.getTime() - 10 * 86_400_000) } });
            ids.push(pottery.id);
        });
        await hook.post('/api/buddy/words', { sessionKey: 'cc_j10', seq: 1, v: 2, canHold: true, messages: [msg(1, 'sent the logo files to the bakery client, they loved them', t0.toISOString()), msg(2, 'signed up for the clay workshop again', t0.toISOString())] });
        fake.push(fakeMessage({ labels: [{ i: 1, label: 'update' }, { i: 2, label: 'update' }] }, { model: 'claude-haiku-5-5' }));
        fake.push(
            fakeMessage(
                {
                    notes: [],
                    items: [],
                    threads: [
                        op({ op: 'event', threadId: ids[59], kind: 'progress', text: 'Sent the logo files, the client loved them', message: 1 }),
                        op({ op: 'open', title: 'Pottery class at the weekend', keywords: ['pottery', 'clay', 'ceramics'], kind: 'said', text: 'Signed up for the clay workshop again', message: 2 }),
                    ],
                },
                { model: 'claude-sonnet-5-5' }
            )
        );
        await drainBuddyQueue(new Date(t0.getTime() + HOOK_WAIT_MS + 1000));
        const digest = JSON.stringify(fake.calls[1]!.messages);
        expect(digest).toContain('Errand q59z59'); // the oldest title is in view too
        expect(new Set(ids).size).toBe(61);
        expect(await prisma.buddyThreadEvent.count({ where: { threadId: ids[59]! } })).toBe(1);
        expect(await prisma.buddyThread.findUniqueOrThrow({ where: { id: ids[60]! } })).toMatchObject({ stage: 'active', closedAt: null });
        expect(await prisma.buddyThread.count({ where: { userId: user.id } })).toBe(61);
    });
});
