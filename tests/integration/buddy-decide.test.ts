// Stage 5 of ECOSYSTEM_V2_PLAN (deciding well), the code parts on scripted models: the ways a thread
// becomes quiet (two questions passed unanswered: 7 days; a thumbs-down: 14 days) and stays quiet on every
// surface; his controls on /you's "On my mind" (the history, ask me less, don't ask, keep off my screens,
// drop it, add one, forget it); an agent's brief names what is on his mind, never a sensitive thread.
import { describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { answerAsk, closeOldAsks, openAsks, stillTrue } from '../../src/services/buddy/asks';
import { openOrFindThread, withPersonLock } from '../../src/services/buddy/threads';
import { createTestUser } from '../helpers/auth';
import { asAgent, createTestToken } from '../helpers/agent';
import { api } from '../helpers/learning';

async function person() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, loop: true });
    return user;
}
async function thread(userId: string, title: string, over: Record<string, unknown> = {}) {
    const t = (await withPersonLock(userId, (tx) => openOrFindThread(tx, userId, { title, keywords: title.toLowerCase().split(' ') }, { saidAt: new Date(Date.now() - 3600_000), forDay: '2026-11-18' }))).thread;
    return prisma.buddyThread.update({ where: { id: t.id }, data: { stage: 'active', ...over } });
}
const ask = (userId: string, threadId: string, rev: number, fromAt: Date, shown = true) =>
    prisma.buddyAsk.create({ data: { userId, threadId, text: 'A run tonight?', answers: [{ label: 'Did it', meaning: 'done' }], seenRevision: rev, fromAt, untilAt: new Date(fromAt.getTime() + 3 * 3600_000), ...(shown ? { firstShownAt: fromAt, shownOn: ['web'] } : {}) } });

describe('quiet threads', () => {
    it('two questions passed unanswered make a thread quiet for 7 days; one that never showed does not count', async () => {
        const user = await person();
        const t = await thread(user.id, 'Run three mornings a week');
        const day = (n: number) => new Date(Date.UTC(2026, 10, 20 + n, 13, 0));
        await ask(user.id, t.id, t.revision, day(0));
        await ask(user.id, t.id, t.revision, day(1), false);
        expect(await closeOldAsks(user.id, day(2))).toEqual({ passed: 1, quieted: 0 });
        await ask(user.id, t.id, t.revision, day(2));
        expect(await closeOldAsks(user.id, day(3))).toEqual({ passed: 1, quieted: 1 });
        const quiet = await prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } });
        expect(quiet.quietUntil!.getTime()).toBe(day(3).getTime() + 7 * 86_400_000);
        // Quiet: no words about it on any surface, not even a question written before.
        expect(await stillTrue(user.id, [{ about: [{ threadId: t.id, rev: quiet.revision }], until: day(5) }], 'web', day(4))).toEqual([false]);
    });

    it('a thumbs-down on a question: withdrawn, and its thread quiet for 14 days', async () => {
        const user = await person();
        const t = await thread(user.id, 'Read before bed');
        const now = new Date();
        const a = await ask(user.id, t.id, t.revision, new Date(now.getTime() - 60_000));
        expect(await answerAsk(user.id, a.id, { thumb: 'less' }, now)).toEqual({ state: 'withdrawn' });
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } })).quietUntil!.getTime()).toBe(now.getTime() + 14 * 86_400_000);
        expect(await openAsks(user.id, 'web', now)).toEqual([]);
    });
});

describe('his controls on a thread (/you, "On my mind")', () => {
    it('the history; ask me less; don’t ask; keep off my screens; drop it and pick it up; add one; forget it; never another person’s', async () => {
        const user = await person();
        const other = await createTestUser();
        const t = await thread(user.id, 'Learn to swim');
        const you = api(user);
        const detail = (await you.get(`/api/buddy/threads/${t.id}`)).body.data;
        expect(detail).toMatchObject({ title: 'Learn to swim', stage: 'active', noAsk: false, onScreens: true, history: [] });
        const less = (await you.patch(`/api/buddy/threads/${t.id}`, { askLess: true })).body.data;
        expect(new Date(less.quietUntil).getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
        expect(less.history.map((h: { kind: string; text: string }) => h.text)).toEqual(['On /you: ask me less']);
        expect((await you.patch(`/api/buddy/threads/${t.id}`, { noAsk: true })).body.data.noAsk).toBe(true);
        expect((await you.patch(`/api/buddy/threads/${t.id}`, { onScreens: false })).body.data.onScreens).toBe(false);
        const dropped = (await you.patch(`/api/buddy/threads/${t.id}`, { stage: 'dropped' })).body.data;
        expect(dropped.stage).toBe('dropped');
        expect((await you.patch(`/api/buddy/threads/${t.id}`, { stage: 'active' })).body.data).toMatchObject({ stage: 'active', noAsk: true, onScreens: false }); // his steers stay
        const added = await you.post('/api/buddy/threads', { title: 'Call grandma every Sunday' });
        expect(added.status).toBe(201);
        expect(added.body.data).toMatchObject({ title: 'Call grandma every Sunday', stage: 'committed' });
        expect((await api(other).get(`/api/buddy/threads/${t.id}`)).status).toBe(404);
        expect((await api(other).patch(`/api/buddy/threads/${t.id}`, { noAsk: false })).status).toBe(404);
        // Agents may search them (read), never change them.
        const agent = asAgent((await createTestToken(user)).token);
        expect((await agent.patch(`/api/buddy/threads/${t.id}`, { noAsk: false })).status).toBe(403);
        expect((await you.delete(`/api/buddy/threads/${t.id}`)).body.data).toEqual({ deleted: true });
        expect(await prisma.buddyThreadEvent.count({ where: { threadId: t.id } })).toBe(0);
    });
});

describe('what is on his mind, in an agent’s brief', () => {
    it('up to 5 titles, committed and active first; never a sensitive, quiet or screen-shy one', async () => {
        const user = await person();
        await thread(user.id, 'Run three mornings a week', { stage: 'committed' });
        await thread(user.id, 'Learn Spanish ten minutes a day');
        await thread(user.id, 'Hospital checks for my father', { sensitive: true });
        await thread(user.id, 'Stop snacking at night', { noAsk: true });
        await thread(user.id, 'Save for a trip to Japan', { onScreens: false });
        const brief = (await asAgent((await createTestToken(user, ['read'])).token).get('/api/brief')).body.data;
        expect(brief.onMind.map((t: { title: string }) => t.title)).toEqual(['Run three mornings a week', 'Learn Spanish ten minutes a day']);
    });
});

describe('steers said in a chat', () => {
    it('“stop asking about my diet”: no word about it on any surface, also after it closes and opens again; “ask again” lifts it; an agent’s note never steers', async () => {
        const { applyThreadOps } = await import('../../src/services/buddy/understand');
        const user = await person();
        const t = await thread(user.id, 'Eat less sugar');
        const now = new Date();
        const op = (over: Record<string, unknown>) => ({ op: 'event', threadId: t.id, title: '', keywords: [], kind: 'steer', text: '', day: '', message: 1, askId: '', sensitive: false, lookAgainOn: '', rhythm: 'none', steer: '', ...over });
        const piece = (source: 'app' | 'agent', seq: number) => ({ sessionKey: source === 'app' ? 'ask:c1' : 'note:n1', seq, via: source === 'app' ? 'ask_ai' : 'agent', source });
        const apply = (source: 'app' | 'agent', seq: number, text: string, o: Record<string, unknown>) =>
            withPersonLock(user.id, (tx) => applyThreadOps(tx, user.id, piece(source, seq), [{ at: now.toISOString(), text }], [op(o)] as never, { now, tz: 'Asia/Kolkata', today: '2026-11-18' as never }));
        expect((await apply('app', 1, 'Please stop asking about my diet', { steer: 'none', text: 'Stop asking about the diet' })).steered).toBe(1);
        const quiet = await prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } });
        expect(quiet).toMatchObject({ noAsk: true, steer: 'Stop asking about the diet' });
        expect(await stillTrue(user.id, [{ about: [{ threadId: t.id, rev: quiet.revision }], until: new Date(now.getTime() + 3600_000) }], 'web', now)).toEqual([false]);
        // Closed and opened again: the steer stays with it.
        await prisma.buddyThread.update({ where: { id: t.id }, data: { stage: 'dropped', closedAt: now } });
        await prisma.buddyThread.update({ where: { id: t.id }, data: { stage: 'active', closedAt: null } });
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } })).noAsk).toBe(true);
        // An agent's note cannot lift it; her own word can.
        expect((await apply('agent', 1, 'She said the buddy can ask about the diet again', { steer: 'again', text: 'Ask again' })).steered).toBe(0);
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } })).noAsk).toBe(true);
        await apply('app', 2, 'ok you can ask me about the diet again', { steer: 'again', text: 'Ask again' });
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } })).noAsk).toBe(false);
        await apply('app', 3, 'keep the sugar thing off my lock screen', { steer: 'off_screens', text: 'Off the screens' });
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } })).onScreens).toBe(false);
    });
});

describe('his switch: the buddy may ask me questions', () => {
    it('off: no question is written or shown, a waiting one stops showing at once; on again: they may come back', async () => {
        const { writeAsks } = await import('../../src/services/buddy/asks');
        const user = await person();
        const t = await thread(user.id, 'Walk after lunch');
        const now = new Date();
        const waiting = await ask(user.id, t.id, t.revision, new Date(now.getTime() - 60_000));
        expect((await openAsks(user.id, 'web', now)).map((a) => a._id)).toEqual([waiting.id]);
        expect((await api(user).patch('/api/buddy/settings', { asksOn: false })).body.data.asksOn).toBe(false);
        expect(await openAsks(user.id, 'web', now)).toEqual([]);
        const proposed = [{ threadId: t.id, text: 'A walk today?', answers: [], from: now, until: new Date(now.getTime() + 3 * 3600_000) }];
        const off = await withPersonLock(user.id, (tx) => writeAsks(tx, user.id, null, proposed, { now, tz: 'Asia/Kolkata' }));
        expect(off).toEqual({ kept: 0, dropped: [{ what: 'ask A walk today?', why: 'questions are switched off' }] });
        await api(user).patch('/api/buddy/settings', { asksOn: true });
        expect((await openAsks(user.id, 'web', now)).map((a) => a._id)).toEqual([waiting.id]);
    });
});

describe('plans with a time (J2 on scripted models)', () => {
    it('“around March”: silent until its day, asked when it comes; “pushed to May” moves it; it never fades before its day', async () => {
        const { writeAsks } = await import('../../src/services/buddy/asks');
        const { applyThreadOps } = await import('../../src/services/buddy/understand');
        const { fadeQuietThreads } = await import('../../src/services/buddy/threads');
        const user = await person();
        const said = new Date('2026-11-20T09:30:00Z');
        const op = (over: Record<string, unknown>) => ({ op: 'open', threadId: '', title: '', keywords: [], kind: 'said', text: '', day: '', message: 1, askId: '', sensitive: false, lookAgainOn: '', rhythm: 'none', steer: '', ...over });
        const apply = (seq: number, text: string, at: Date, today: string, ops: unknown[]) =>
            withPersonLock(user.id, (tx) => applyThreadOps(tx, user.id, { sessionKey: 'ask:j2', seq, via: 'ask_ai', source: 'app' }, [{ at: at.toISOString(), text }], ops as never, { now: at, tz: 'Asia/Kolkata', today: today as never }));
        await apply(1, 'I want to start the system design course around March', said, '2026-11-20', [op({ title: 'Start the system design course', keywords: ['system', 'design', 'course'], text: 'Wants to start the system design course around March', lookAgainOn: '2027-03-01' })]);
        const t = await prisma.buddyThread.findFirstOrThrow({ where: { userId: user.id } });
        expect(t).toMatchObject({ stage: 'noticed' });
        const proposal = (from: Date) => [{ threadId: t.id, text: 'Still starting the course this month?', answers: [], from, until: new Date(from.getTime() + 4 * 3600_000) }];
        const askAt = async (iso: string) => {
            const now = new Date(iso);
            return withPersonLock(user.id, (tx) => writeAsks(tx, user.id, null, proposal(now), { now, tz: 'Asia/Kolkata' }));
        };
        expect((await askAt('2026-12-15T12:00:00Z')).dropped.map((d) => d.why)).toEqual(['mentioned once: silent until it comes up again']);
        // 100 quiet days: a thread with a day never fades before it.
        expect(await fadeQuietThreads(user.id, new Date('2027-02-28T12:00:00Z'))).toBe(0);
        expect((await askAt('2027-03-01T12:00:00Z')).kept).toBe(1);
        // "Pushed to May": a change of plan with its new day; active now, yet no question before May.
        const later = new Date('2027-03-02T10:00:00Z');
        await apply(2, 'Pushed the course to May, March is too busy', later, '2027-03-02', [op({ op: 'event', threadId: t.id, kind: 'changed', text: 'Pushed the course to May', lookAgainOn: '2027-05-01' })]);
        expect(await prisma.buddyThread.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ stage: 'active', lookAgainOn: new Date('2027-05-01T00:00:00Z') });
        expect((await askAt('2027-03-10T12:00:00Z')).dropped.map((d) => d.why)).toEqual(['its day has not come']);
        expect((await askAt('2027-05-01T12:00:00Z')).kept).toBe(1);
    });
});

describe('offers', () => {
    it('“want me to keep an eye on this?”: once per thread; his yes makes it committed; a no is kept and never asked again', async () => {
        const { writeAsks } = await import('../../src/services/buddy/asks');
        const user = await person();
        const now = new Date();
        const offer = (threadId: string, at: Date) => [{ threadId, kind: 'offer' as const, text: 'Want me to keep an eye on this?', answers: [{ label: 'Yes', meaning: 'yes' as const }, { label: 'No', meaning: 'no' as const }], from: at, until: new Date(at.getTime() + 3 * 3600_000) }];
        const write = (threadId: string, at: Date) => withPersonLock(user.id, (tx) => writeAsks(tx, user.id, null, offer(threadId, at), { now: at, tz: 'Asia/Kolkata' }));
        const run = await thread(user.id, 'Run three mornings a week');
        expect((await write(run.id, now)).kept).toBe(1);
        const a = await prisma.buddyAsk.findFirstOrThrow({ where: { userId: user.id, threadId: run.id } });
        expect(a.kind).toBe('offer');
        await answerAsk(user.id, a.id, { choice: 0 }, new Date(now.getTime() + 60_000));
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: run.id } })).stage).toBe('committed');
        expect((await write(run.id, new Date(now.getTime() + 2 * 86_400_000))).dropped.map((d) => d.why)).toEqual(['it is followed already']);

        const spanish = await thread(user.id, 'Learn Spanish ten minutes a day');
        await write(spanish.id, now);
        const b = await prisma.buddyAsk.findFirstOrThrow({ where: { userId: user.id, threadId: spanish.id } });
        await answerAsk(user.id, b.id, { choice: 1 }, new Date(now.getTime() + 60_000));
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: spanish.id } })).stage).toBe('active');
        expect((await write(spanish.id, new Date(now.getTime() + 3 * 86_400_000))).dropped.map((d) => d.why)).toEqual(['offered once already']);
    });
});

describe('not two days running', () => {
    it('the day after he answered a question about a thread, no question of any kind about it (an offer neither); the day after that, one may come', async () => {
        const { writeAsks } = await import('../../src/services/buddy/asks');
        const user = await person();
        const t = await thread(user.id, 'Guitar most evenings');
        const at = (iso: string) => new Date(iso);
        const write = (iso: string, kind: 'ask' | 'offer') =>
            withPersonLock(user.id, (tx) => writeAsks(tx, user.id, null, [{ threadId: t.id, kind, text: kind === 'ask' ? 'Guitar tonight?' : 'Want me to keep an eye on it?', answers: [{ label: 'Did it', meaning: 'done' }], from: at(iso), until: new Date(at(iso).getTime() + 4 * 3600_000) }], { now: at(iso), tz: 'Asia/Kolkata' }));
        expect((await write('2026-11-23T12:30:00Z', 'ask')).kept).toBe(1);
        const first = await prisma.buddyAsk.findFirstOrThrow({ where: { userId: user.id } });
        await answerAsk(user.id, first.id, { choice: 0 }, at('2026-11-23T14:00:00Z'));
        expect((await write('2026-11-24T12:30:00Z', 'offer')).dropped.map((d) => d.why)).toEqual(['answered about it yesterday']);
        expect((await write('2026-11-24T12:31:00Z', 'ask')).dropped.map((d) => d.why)).toEqual(['answered about it yesterday']);
        expect((await write('2026-11-25T12:30:00Z', 'ask')).kept).toBe(1);
    });
});

describe('the export (stage 5 API)', () => {
    it('holds what it keeps an eye on, each thread with its history, and its questions with his answers', async () => {
        const user = await person();
        const t = await thread(user.id, 'Swim twice a week');
        const now = new Date();
        const a = await ask(user.id, t.id, t.revision, new Date(now.getTime() - 60_000));
        await answerAsk(user.id, a.id, { choice: 0 }, now);
        const data = (await api(user).get('/api/buddy/export')).body.data;
        expect(data.threads).toHaveLength(1);
        expect(data.threads[0]).toMatchObject({ _id: t.id, title: 'Swim twice a week', stage: 'active', onScreens: true, noAsk: false });
        expect(data.threads[0].history.map((h: { kind: string; via: string }) => `${h.kind} ${h.via}`)).toEqual(['done answer']);
        expect(data.asks).toEqual([expect.objectContaining({ _id: a.id, threadId: t.id, state: 'answered', answer: 'Did it' })]);
    });
});

describe('J11 and J9 (second part) on scripted models: dated plans', () => {
    const write = async (userId: string, threadId: string, iso: string, text = 'Dashboard delivered?') => {
        const { writeAsks } = await import('../../src/services/buddy/asks');
        const from = new Date(iso);
        return withPersonLock(userId, (tx) => writeAsks(tx, userId, null, [{ threadId, kind: 'ask', text, answers: [{ label: 'Delivered', meaning: 'done' }, { label: 'Not yet', meaning: 'skipped' }], from, until: new Date(from.getTime() + 4 * 3600_000) }], { now: from, tz: 'Asia/Kolkata' }));
    };

    it('J11: a client deadline is not asked before its day, is asked on it, and "done" closes it, so it is never asked again; a habit’s "done" leaves it open', async () => {
        const user = await person();
        const deadline = await thread(user.id, 'Deliver the dashboard redesign to the client', { lookAgainOn: new Date('2026-11-27T00:00:00Z') });
        expect((await write(user.id, deadline.id, '2026-11-25T12:30:00Z')).dropped.map((d) => d.why)).toEqual(['its day has not come']);
        expect((await write(user.id, deadline.id, '2026-11-27T04:30:00Z')).kept).toBe(1);
        const a = await prisma.buddyAsk.findFirstOrThrow({ where: { userId: user.id, threadId: deadline.id } });
        await answerAsk(user.id, a.id, { choice: 0 }, new Date('2026-11-27T11:00:00Z'));
        const closed = await prisma.buddyThread.findUniqueOrThrow({ where: { id: deadline.id } });
        expect(closed.stage).toBe('done');
        expect(closed.closedAt).not.toBeNull();
        expect((await write(user.id, deadline.id, '2026-11-29T12:30:00Z')).dropped.map((d) => d.why)).toEqual(['the thread is closed or quiet']);

        const habit = await thread(user.id, 'Run three mornings a week', { rhythm: 'weekly', lookAgainOn: new Date('2026-11-27T00:00:00Z') });
        expect((await write(user.id, habit.id, '2026-11-27T01:30:00Z', 'A run this morning?')).kept).toBe(1);
        const h = await prisma.buddyAsk.findFirstOrThrow({ where: { userId: user.id, threadId: habit.id } });
        await answerAsk(user.id, h.id, { choice: 0 }, new Date('2026-11-27T03:00:00Z'));
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: habit.id } })).stage).toBe('active');
    });

    it('J9 (second part): a plan that fell due while the AI was paused is still due after it, in the night’s view and for a question; it never faded', async () => {
        const user = await person();
        const dentist = await thread(user.id, 'Book the dentist appointment', { stage: 'noticed', lookAgainOn: new Date('2026-11-23T00:00:00Z'), lastSaidAt: new Date('2026-11-10T05:00:00Z') });
        // The AI was paused from the 22nd to the 25th: no night ran; the first one after it.
        const { fadeQuietThreads } = await import('../../src/services/buddy/threads');
        await fadeQuietThreads(user.id, new Date('2026-11-25T23:00:00Z'));
        const { threadsForNight } = await import('../../src/services/buddy/nightLoop');
        const view = await threadsForNight(user.id, '2026-11-26', new Date('2026-11-25T23:00:00Z'));
        expect(view.block).toContain(`${dentist.id} · noticed · due (2026-11-23)`);
        expect((await write(user.id, dentist.id, '2026-11-26T04:30:00Z', 'Did the dentist booking happen?')).kept).toBe(1);
        expect((await prisma.buddyThread.findUniqueOrThrow({ where: { id: dentist.id } })).stage).toBe('noticed');
    });
});

describe('the switch comes off (§10.1): the copied thread memories close, with an undo', () => {
    it('closes only the thread memories a thread was made from, "moved to On my mind"; the undo opens each as it was', async () => {
        const { copyThreadMemories, closeCopiedMemories, undoCloseCopiedMemories } = await import('../../src/services/buddy/threads');
        const user = await createTestUser();
        const day = new Date('2026-11-10T00:00:00Z');
        const mem = (text: string, status: 'active' | 'faded') => prisma.memory.create({ data: { userId: user.id, text, kind: 'thread', status, source: 'hook', firstSeenDay: day, lastSeenDay: day } });
        const a = await mem('Getting back to guitar most evenings', 'active');
        const b = await mem('Thinking about a pottery class', 'faded');
        expect(await copyThreadMemories(user.id)).toEqual({ copied: 2 });
        const c = await mem('Learning to bake bread', 'active'); // made after the copy: no thread
        expect(await closeCopiedMemories(user.id, '2026-11-25', { dryRun: true })).toEqual({ closed: 2 });
        expect(await prisma.memory.count({ where: { userId: user.id, status: 'closed' } })).toBe(0);
        expect(await closeCopiedMemories(user.id, '2026-11-25')).toEqual({ closed: 2 });
        const closed = await prisma.memory.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        expect(closed.map((m) => [m.id, m.status, m.closeReason])).toEqual([
            [a.id, 'closed', 'moved to On my mind (was active)'],
            [b.id, 'closed', 'moved to On my mind (was faded)'],
            [c.id, 'active', null],
        ]);
        expect(await closeCopiedMemories(user.id, '2026-11-25')).toEqual({ closed: 0 }); // safe to run again
        expect(await undoCloseCopiedMemories(user.id)).toEqual({ reopened: 2 });
        const back = await prisma.memory.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        expect(back.map((m) => [m.status, m.closeReason, m.closedDay])).toEqual([
            ['active', null, null],
            ['faded', null, null],
            ['active', null, null],
        ]);
    });
});

describe('the buddy’s own reminders (stage 7, §4.7)', () => {
    it('only for an active or committed thread it read, later today, 2 a day, never quiet, private or off the screens; never a task; on the home picture; he takes one back', async () => {
        const { writeBuddyReminders, loopSchema } = await import('../../src/services/buddy/nightLoop');
        const { nightLoopSchema } = await import('../../src/services/buddy/think');
        const { todayReminders } = await import('../../src/services/ambient/ambient.service');
        // A weekday night may write its own reminders; a Sunday night writes the week's note instead (the API's grammar limit).
        expect(JSON.stringify(nightLoopSchema(false))).toContain('"reminders"');
        expect(JSON.stringify(nightLoopSchema(true))).not.toContain('"reminders"');
        expect(loopSchema).toBeTypeOf('function');
        const user = await person();
        const guitar = await thread(user.id, 'Guitar most evenings');
        const noticed = await thread(user.id, 'Pottery someday', { stage: 'noticed' });
        const knee = await thread(user.id, 'Knee physio', { sensitive: true });
        const run = await thread(user.id, 'Run three mornings', { stage: 'committed' });
        const read = await thread(user.id, 'Read before bed');
        const now = new Date('2026-11-23T08:30:00Z'); // 14:00 his time
        const revisions = new Map([guitar, noticed, knee, run, read].map((t) => [t.id, t.revision]));
        const ctx = { now, tz: 'Asia/Kolkata', today: '2026-11-23' as const, revisions };
        const dropped = await withPersonLock(user.id, (tx) =>
            writeBuddyReminders(tx, user.id, null, [
                { threadId: noticed.id, text: 'Look up pottery classes', at: '18:00' },
                { threadId: knee.id, text: 'Physio stretches', at: '18:00' },
                { threadId: guitar.id, text: 'Guitar after dinner', at: '09:00' },
                { threadId: guitar.id, text: 'Guitar after dinner', at: '20:30' },
                { threadId: run.id, text: 'Lay out the running shoes', at: '21:30' },
                { threadId: read.id, text: 'Read ten pages', at: '22:00' },
                { threadId: 'not-a-thread', text: 'x', at: '22:00' },
            ], ctx)
        );
        expect(dropped.map((d) => d.why)).toEqual(['only for an active or committed thread', 'kept off the screens', 'not later today', 'two reminders today already', 'not a thread it read']);
        expect((await prisma.buddyReminder.findMany({ where: { userId: user.id }, orderBy: { at: 'asc' } })).map((r) => r.text)).toEqual(['Guitar after dinner', 'Lay out the running shoes']);
        expect(await prisma.todo.count({ where: { userId: user.id } })).toBe(0);
        // On the home picture with his reminders, until 2 hours past its time.
        expect((await todayReminders(user.id, now, 'Asia/Kolkata')).map((r) => [r.at, r.text])).toEqual([
            ['8:30 pm', 'Guitar after dinner'],
            ['9:30 pm', 'Lay out the running shoes'],
        ]);
        expect((await todayReminders(user.id, now, 'Asia/Kolkata', false)).map((r) => r.text)).toEqual(['A reminder', 'A reminder']);
        // He takes one back.
        const list = (await api(user).get('/api/buddy/reminders')).body.data;
        expect(list.map((r: { thread: string }) => r.thread)).toEqual(['Guitar most evenings', 'Run three mornings']);
        expect((await api(user).delete(`/api/buddy/reminders/${list[0]._id}`)).body.data).toEqual({ cancelled: true });
        expect((await todayReminders(user.id, now, 'Asia/Kolkata')).map((r) => r.text)).toEqual(['Lay out the running shoes']);
    });
});
