// Stage 5b, part B of ECOSYSTEM_V2_PLAN on scripted models (the owner's answer, 11-18 evening): the screens that
// learn. What a person says about when the buddy may ask ("ask me later in the evening", "not on weekends") and what
// stays off the lock screen becomes a rule that code holds on every surface; "not this: too private" on a line takes
// its threads off the screens (or, on a line about none, keeps lines like it off the lock screen); each rule is on
// /you and Remove ends it. Only their own words or their tap make a rule. The lock check's judgement is measured
// by the real-model set (evals/lock.json).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { queueOwnWords } from '../../src/services/buddy/capture.service';
import { drainBuddyQueue } from '../../src/services/buddy/worker';
import { answerAsk, openAsks, stillTrue, writeAsks } from '../../src/services/buddy/asks';
import { openOrFindThread, withPersonLock } from '../../src/services/buddy/threads';
import { applyScreenOps } from '../../src/services/buddy/screens';
import { LOCK_SCHEMA_TIMED, lockCheck } from '../../src/services/buddy/think';
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

const TZ = 'Asia/Kolkata';
// Kolkata time: Fri 20 Nov 08:30 (02:00Z); Sat 21 Nov 05:00 (Fri 23:30Z); Mon 23 Nov 05:00 (Sun 23:30Z).
const FRI = new Date('2026-11-20T03:00:00Z');
const SAT_NIGHT = new Date('2026-11-20T23:30:00Z');
const MON_NIGHT = new Date('2026-11-22T23:30:00Z');

const screen = (o: Record<string, unknown>) => ({ kind: 'asks_from', threadId: '', time: '', days: '', words: '', askId: '', message: 1, ...o });
const digest = (o: { screens?: unknown[]; threads?: unknown[] }) => fakeMessage({ notes: [], items: [], tasksDone: [], threads: [], screens: [], ...o }, { model: 'claude-sonnet-5-5' });

async function person(loop = true) {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
    await api(user).patch('/api/buddy/settings', { enabled: true, loop });
    return user;
}
async function thread(userId: string, title: string) {
    const t = (await withPersonLock(userId, (tx) => openOrFindThread(tx, userId, { title, keywords: title.toLowerCase().split(' ') }, { saidAt: new Date('2026-11-18T05:00:00Z'), forDay: '2026-11-18' as never }))).thread;
    return prisma.buddyThread.update({ where: { id: t.id }, data: { stage: 'active' } });
}
const say = (userId: string, seq: number, text: string, at: Date) => queueOwnWords(userId, { key: 'ask:chat-screens', seq, via: 'ask_ai', messages: [{ at: at.toISOString(), text }] }, at);
const propose = (threadId: string, from: Date, text = 'A run tonight?') => [{ threadId, text, answers: [], from, until: new Date(from.getTime() + 4 * 3600_000) }];

describe('what they say about when it may ask (5b B)', () => {
    it('“ask me later in the evening”: a question written for the morning shows from 19:00, on every surface; “ask me anytime again” ends it', async () => {
        const maya = await person();
        const run = await thread(maya.id, 'Run three mornings a week');
        await say(maya.id, 1, 'Can you ask me these things later in the evening? Mornings are chaos.', FRI);
        fake.push(digest({ screens: [screen({ kind: 'asks_from', time: '19:00', words: 'Ask me later in the evening' })] }));
        await drainBuddyQueue(FRI);
        const rules = (await api(maya).get('/api/buddy/you')).body.data.screenRules;
        expect(rules).toEqual([expect.objectContaining({ kind: 'asks_from', what: 'Questions not before 19:00', text: 'Ask me later in the evening', source: 'said' })]);

        // The night writes a question for 09:00 Saturday: code moves it to 19:00.
        const w = await withPersonLock(maya.id, (tx) => writeAsks(tx, maya.id, null, propose(run.id, new Date('2026-11-21T03:30:00Z')), { now: SAT_NIGHT, tz: TZ }));
        expect(w.kept).toBe(1);
        const ask = await prisma.buddyAsk.findFirstOrThrow({ where: { userId: maya.id } });
        expect(ask.fromAt.toISOString()).toBe('2026-11-21T13:30:00.000Z');
        for (const surface of ['web', 'notification'] as const) expect(await openAsks(maya.id, surface, new Date('2026-11-21T06:30:00Z'))).toEqual([]);
        expect((await openAsks(maya.id, 'web', new Date('2026-11-21T14:00:00Z'))).map((a) => a.text)).toEqual(['A run tonight?']);

        // "You can ask me anytime again": the rule ends.
        await say(maya.id, 2, 'ok you can ask me anytime again', new Date('2026-11-22T05:00:00Z'));
        fake.push(digest({ screens: [screen({ kind: 'asks_from', time: '', words: 'Ask me anytime again' })] }));
        await drainBuddyQueue(new Date('2026-11-22T05:00:00Z'));
        expect((await api(maya).get('/api/buddy/you')).body.data.screenRules).toEqual([]);
    });

    it('said in reply to a question that showed in the morning: it comes back at that time today', async () => {
        const maya = await person();
        const run = await thread(maya.id, 'Run three mornings a week');
        const shown = await prisma.buddyAsk.create({ data: { userId: maya.id, threadId: run.id, text: 'A run this morning?', answers: [], seenRevision: run.revision, fromAt: new Date('2026-11-20T02:30:00Z'), untilAt: new Date('2026-11-20T05:30:00Z'), firstShownAt: new Date('2026-11-20T02:45:00Z'), shownOn: ['web'] } });
        await say(maya.id, 1, 'ask me later in the evening', FRI);
        fake.push(digest({ screens: [screen({ kind: 'asks_from', threadId: run.id, time: '19:00', words: 'Ask me later in the evening', askId: shown.id })] }));
        await drainBuddyQueue(FRI);
        const back = await prisma.buddyAsk.findUniqueOrThrow({ where: { id: shown.id } });
        expect(back).toMatchObject({ state: 'open' });
        expect(back.fromAt.toISOString()).toBe('2026-11-20T13:30:00.000Z');
        expect(back.untilAt.getTime()).toBeGreaterThan(back.fromAt.getTime());
    });

    it('“don’t ask about Spanish on weekends”: Saturday’s question about it is refused, another thread’s kept, Monday’s kept', async () => {
        const meera = await person();
        const spanish = await thread(meera.id, 'Spanish ten minutes a day');
        const walk = await thread(meera.id, 'Walk after lunch');
        await say(meera.id, 1, 'please don’t remind me about Spanish on weekends', FRI);
        fake.push(digest({ screens: [screen({ kind: 'asks_days', threadId: spanish.id, days: 'weekdays', words: 'Not about Spanish on weekends' })] }));
        await drainBuddyQueue(FRI);
        const sat = await withPersonLock(meera.id, (tx) => writeAsks(tx, meera.id, null, [...propose(spanish.id, new Date('2026-11-21T12:30:00Z'), 'Spanish today?'), ...propose(walk.id, new Date('2026-11-21T08:00:00Z'), 'A walk after lunch?')], { now: SAT_NIGHT, tz: TZ }));
        expect(sat).toEqual({ kept: 1, dropped: [{ what: 'ask Spanish today?', why: 'not on the days they asked for' }] });
        const mon = await withPersonLock(meera.id, (tx) => writeAsks(tx, meera.id, null, propose(spanish.id, new Date('2026-11-23T12:30:00Z'), 'Spanish today?'), { now: MON_NIGHT, tz: TZ }));
        expect(mon.kept).toBe(1);
    });

    it('only their own words make a rule: words passed on by an agent make none', async () => {
        const meera = await person();
        const out = await withPersonLock(meera.id, (tx) => applyScreenOps(tx, meera.id, [screen({ kind: 'asks_from', time: '19:00', words: 'They want questions in the evening' }) as never], { now: FRI, tz: TZ, direct: false, context: new Set(), messages: 1 }));
        expect(out).toMatchObject({ made: 0, dropped: [{ why: 'only their own words make a rule' }] });
        expect(await prisma.buddyScreenRule.count({ where: { userId: meera.id } })).toBe(0);
    });
});

/** A step whose lines rest on threads, as the night stores it. */
async function step(userId: string, lines: Array<{ from: string; text: string; about: Array<{ threadId: string; rev: number }> }>) {
    return prisma.buddyDay.create({
        data: { userId, day: new Date('2026-11-20T00:00:00Z'), kind: 'night', model: 'claude-opus-5-5', lines: lines.map((l) => ({ slot: 'evening', from: l.from, until: '21:00', text: l.text, form: 'observation', lockOk: true, sourceId: null, about: l.about })) as unknown as Prisma.InputJsonValue, ops: [] },
    });
}

describe('what their thumbs teach it (5b B)', () => {
    it('“not this: too private” on a line about a thread: that thread off the screens (its next line too), shown on /you; Remove there puts it back', async () => {
        const lena = await person();
        const sister = await thread(lena.id, 'Sister going through a divorce');
        const day = await step(lena.id, [{ from: '18:00', text: 'Call your sister tonight?', about: [{ threadId: sister.id, rev: sister.revision }] }]);
        const r = await api(lena).post('/api/buddy/feedback', { buddyDayId: day.id, target: '18:00', verdict: 'less', reason: 'private', words: 'not on my lock screen please' });
        expect(r.status).toBe(201);
        expect(r.body.data).toEqual({ saved: true, offScreens: 'threads' });
        const off = await prisma.buddyThread.findUniqueOrThrow({ where: { id: sister.id } });
        expect(off).toMatchObject({ onScreens: false });
        expect(off.steer).toMatch(/^Too private \(your thumb on: Call your sister tonight\?\)/);
        expect((await prisma.buddyFeedback.findFirstOrThrow({ where: { userId: lena.id } }))).toMatchObject({ reason: 'private', words: 'not on my lock screen please' });
        // Any next word about it stays off the lock screen, the home picture and notifications; the web still shows it.
        const later = [{ about: [{ threadId: sister.id, rev: off.revision }], until: new Date(Date.now() + 3600_000) }];
        expect(await stillTrue(lena.id, later, 'lock')).toEqual([false]);
        expect(await stillTrue(lena.id, later, 'notification')).toEqual([false]);
        expect(await stillTrue(lena.id, later, 'web')).toEqual([true]);
        // On /you › On my mind it reads "off the screens", and putting it back is his.
        expect((await api(lena).patch(`/api/buddy/threads/${sister.id}`, { onScreens: true })).body.data.onScreens).toBe(true);
    });

    it('on a line about no thread: lines like it are kept off the lock screen (the lock check is given the rule); Remove ends it', async () => {
        const lena = await person();
        const day = await step(lena.id, [{ from: '08:00', text: 'Payday tomorrow. The rent can wait one more night.', about: [] }]);
        expect((await api(lena).post('/api/buddy/feedback', { buddyDayId: day.id, target: '08:00', verdict: 'less', reason: 'private' })).body.data).toEqual({ saved: true, offScreens: 'topic' });
        const rules = (await api(lena).get('/api/buddy/you')).body.data.screenRules;
        expect(rules).toEqual([expect.objectContaining({ kind: 'topic', source: 'thumb', what: 'Off the lock screen: lines like “Payday tomorrow. The rent can wait one more night.”' })]);
        // The lock check reads it.
        fake.push(fakeMessage({ lines: [{ i: 0, reveals: false }], note: false, insight: false, asks: [] }, { model: 'claude-sonnet-5-5' }));
        await lockCheck(lena.id, [{ slot: 'morning', from: '08:00', until: '10:00', text: 'Bills day: the rent goes out', form: 'observation', lockOk: true, sourceId: null }], [], { note: null }, []);
        const req = fake.calls[fake.calls.length - 1] as unknown as { output_config: { format: { schema: unknown } }; messages: Array<{ content: Array<{ text: string }> }> };
        expect(req.output_config.format.schema).toBe(LOCK_SCHEMA_TIMED);
        expect(req.messages[0]!.content[0]!.text).toContain('<their_rules>\nkeep off their lock screen: Lines like: Payday tomorrow.');
        // Remove on /you.
        expect((await api(lena).delete(`/api/buddy/screens/${rules[0]._id}`)).body.data).toEqual({ ended: true });
        expect((await api(lena).get('/api/buddy/you')).body.data.screenRules).toEqual([]);
        // Never another person's.
        const other = await person();
        expect((await api(other).delete(`/api/buddy/screens/${rules[0]._id}`)).status).toBe(404);
    });

    it('“not this: too private” on a question: withdrawn, quiet, and its thread off the screens; the reason sent a moment after the thumb still counts', async () => {
        const sam = await person();
        const t = await thread(sam.id, 'Hospital visits with dad');
        const a = await prisma.buddyAsk.create({ data: { userId: sam.id, threadId: t.id, text: 'How was the hospital visit?', answers: [], seenRevision: t.revision, fromAt: new Date(Date.now() - 60_000), untilAt: new Date(Date.now() + 3600_000), firstShownAt: new Date(), shownOn: ['web'] } });
        expect(await answerAsk(sam.id, a.id, { thumb: 'less' })).toEqual({ state: 'withdrawn' });
        expect(await answerAsk(sam.id, a.id, { thumb: 'less', reason: 'private' })).toEqual({ state: 'withdrawn' });
        expect(await prisma.buddyAsk.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ thumb: 'less', thumbReason: 'private' });
        expect(await prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ onScreens: false });
    });

    it('the loop off: the reason is kept, nothing else changes', async () => {
        const kabir = await person(false);
        const day = await step(kabir.id, [{ from: '18:00', text: 'Payday tomorrow', about: [] }]);
        expect((await api(kabir).post('/api/buddy/feedback', { buddyDayId: day.id, target: '18:00', verdict: 'less', reason: 'private' })).body.data).toEqual({ saved: true });
        expect(await prisma.buddyFeedback.findFirstOrThrow({ where: { userId: kabir.id } })).toMatchObject({ reason: 'private' });
        expect(await prisma.buddyScreenRule.count({ where: { userId: kabir.id } })).toBe(0);
    });
});
