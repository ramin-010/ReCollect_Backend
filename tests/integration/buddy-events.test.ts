// Stage 5 of ECOSYSTEM_V2_PLAN, pulses on events (§4.3, §4.13), on scripted models: with the loop on, a
// thread that changed in a way that matters today (an answer, a plan he changed in his own words, a new word
// on a thread today's words rest on) brings a pulse 3 minutes after the last such event (a burst makes one),
// 30 minutes after the step before it, at most 6 a day (4 before 11-22); past them nothing new is written and the
// skipped pulse is counted for the usage view; the fixed pulses (09:00, 12:00, 15:00, 18:00, 21:00) are their own.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { pulseDue, pulseIfDue } from '../../src/services/buddy/pulse';
import { nextBuddyMomentFor } from '../../src/services/buddy/worker';
import { answerAsk } from '../../src/services/buddy/asks';
import { buddyUsage } from '../../src/services/buddy/spend';
import { addThreadEvent, openOrFindThread, withPersonLock, type EventKind } from '../../src/services/buddy/threads';
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

/** Mon 16 Nov 2026, his clock (Kolkata). */
const at = (hhmm: string) => new Date(`2026-11-16T${hhmm}:00+05:30`);
const DAY = new Date('2026-11-16T00:00:00Z');
const line = (slot: string, text: string, about: Array<{ threadId: string; rev: number }> = []) => ({ slot, text, form: 'plain', lockOk: true, sourceId: null, about });

/** A loop person with an active thread, today's night (its evening line rests on the thread) and the night's question about it. */
async function day() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, loop: true });
    const opened = (await withPersonLock(user.id, (tx) => openOrFindThread(tx, user.id, { title: 'Guitar most evenings', keywords: ['guitar', 'practice'] }, { saidAt: new Date('2026-11-15T14:00:00Z'), forDay: '2026-11-15' }))).thread;
    const t = await prisma.buddyThread.update({ where: { id: opened.id }, data: { stage: 'active', rhythm: 'daily' } });
    const night = await prisma.buddyDay.create({
        data: { userId: user.id, day: DAY, kind: 'night', lines: [line('morning', 'One thing at a time today'), line('evening', 'Guitar tonight is the plan', [{ threadId: t.id, rev: t.revision }])], model: 'claude-opus-5-5', createdAt: at('04:30') },
    });
    const ask = await prisma.buddyAsk.create({
        data: { userId: user.id, threadId: t.id, buddyDayId: night.id, text: 'Guitar tonight?', answers: [{ label: 'Did it', meaning: 'done' }, { label: 'Not today', meaning: 'skipped' }], seenRevision: t.revision, fromAt: at('04:30'), untilAt: at('23:30'), firstShownAt: at('08:00'), shownOn: ['web'] },
    });
    await prisma.buddyState.update({ where: { userId: user.id }, data: { lastNightDay: DAY } });
    return { user, t, night, ask };
}

/** A new word about a thread, as the digest would place it. */
async function word(userId: string, threadId: string, n: string, when: Date, over: { kind?: EventKind; direct?: boolean; via?: string } = {}) {
    return withPersonLock(userId, async (tx) =>
        addThreadEvent(tx, userId, await tx.buddyThread.findUniqueOrThrow({ where: { id: threadId } }), { kind: over.kind ?? 'said', text: n, saidAt: when, forDay: '2026-11-16', direct: over.direct ?? true, via: over.via ?? 'hook', originKey: `test:${threadId}:${n}` }, when),
    );
}

/** The pulse's answer: its lines (each may rest on threads, by id). */
const pulseSays = (lines: Array<{ slot: string; text: string; about?: string[] }>) =>
    fakeMessage({ lines: lines.map((l) => ({ form: 'push', lockOk: true, sourceId: '', about: [], ...l })), note: '', insight: '', insightAbout: [], noteAbout: [], asks: [] }, { model: 'claude-sonnet-5-5' });

describe('pulses on events', () => {
    it('his answer brings a pulse 3 minutes later (not before), marked as on an event: it rewrites the hours to come and reads what changed', async () => {
        const { user, ask } = await day();
        expect(await answerAsk(user.id, ask.id, { choice: 0 }, at('09:00'))).toEqual({ state: 'answered' });
        expect(await pulseDue(user.id, at('09:01'))).toMatchObject({ due: false, reason: 'a pulse on an event waits', at: at('09:03') });
        expect(await nextBuddyMomentFor(user.id, at('09:01'))).toEqual(at('09:03'));

        fake.push(pulseSays([{ slot: 'evening', text: 'Played already, so tonight is yours' }]));
        const r = await pulseIfDue(user.id, at('09:03'));
        expect(r).toMatchObject({ ran: true });
        expect(r.reason).toMatch(/^on an event: morning and afternoon and evening/);
        const sent = JSON.stringify(fake.calls[0]!.messages);
        expect(sent).toContain('<changed>');
        expect(sent).toContain('Did it (to: Guitar tonight?)');
        const row = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id, kind: 'pulse' } });
        expect(row.onEvent).toBe(true);
        expect((row.lines as Array<{ slot: string; text: string }>).find((l) => l.slot === 'evening')?.text).toBe('Played already, so tonight is yours');
        // Nothing new since: no pulse, and no fixed one either (the 09:00 one runs only on something new).
        expect(await pulseDue(user.id, at('10:00'))).toEqual({ due: false, reason: 'nothing new' });
    });

    it('a burst makes one pulse; the next waits 30 minutes after it; 6 a day at most, then each one skipped is counted once and nothing new is written; the fixed pulses still run', async () => {
        const { user, t } = await day();
        const again = [{ slot: 'evening', text: 'Guitar tonight is still the plan', about: [t.id] }];
        // A burst at 09:00-09:02: one pulse at 09:05.
        await word(user.id, t.id, 'Bought new strings', at('09:00'));
        await word(user.id, t.id, 'Tuned it after breakfast', at('09:01'));
        await word(user.id, t.id, 'Learned a new chord shape', at('09:02'));
        expect(await pulseDue(user.id, at('09:04'))).toMatchObject({ due: false, at: at('09:05') });
        fake.push(pulseSays(again));
        expect((await pulseIfDue(user.id, at('09:05'))).ran).toBe(true);
        expect(fake.calls).toHaveLength(2); // the pulse and its lock check
        // A word at 09:10 waits for 30 minutes after that pulse.
        await word(user.id, t.id, 'Played the riff twice', at('09:10'));
        expect(await pulseDue(user.id, at('09:20'))).toMatchObject({ due: false, at: at('09:35') });
        fake.push(pulseSays(again));
        expect((await pulseIfDue(user.id, at('09:35'))).ran).toBe(true);
        await word(user.id, t.id, 'Practised scales slowly', at('10:30'));
        fake.push(pulseSays(again));
        expect((await pulseIfDue(user.id, at('10:33'))).ran).toBe(true);
        await word(user.id, t.id, 'Recorded a short clip', at('11:30'));
        fake.push(pulseSays(again));
        expect((await pulseIfDue(user.id, at('11:33'))).ran).toBe(true);
        await word(user.id, t.id, 'Fixed the buzz on the low string', at('12:05'));
        fake.push(pulseSays(again));
        expect((await pulseIfDue(user.id, at('12:08'))).ran).toBe(true);
        await word(user.id, t.id, 'Learned the bridge', at('12:40'));
        fake.push(pulseSays(again));
        expect((await pulseIfDue(user.id, at('12:43'))).ran).toBe(true);
        expect(await prisma.buddyDay.count({ where: { userId: user.id, onEvent: true } })).toBe(6);

        // The seventh: skipped and counted once; nothing new written.
        fake.reset();
        await word(user.id, t.id, 'Showed the clip to a friend', at('13:30'));
        expect(await nextBuddyMomentFor(user.id, at('13:31'))).toEqual(at('13:33'));
        expect(await pulseIfDue(user.id, at('13:33'))).toEqual({ ran: false, reason: 'the pulses on events are used up today' });
        expect(await pulseIfDue(user.id, at('13:40'))).toEqual({ ran: false, reason: 'nothing new' });
        await word(user.id, t.id, 'Booked a lesson for Saturday', at('14:00'));
        expect(await pulseIfDue(user.id, at('14:03'))).toEqual({ ran: false, reason: 'the pulses on events are used up today' });
        expect(fake.calls).toHaveLength(0);
        expect(await prisma.buddyDay.count({ where: { userId: user.id } })).toBe(7);
        const usage = await buddyUsage(user.id, at('14:10'));
        // (the calls themselves are counted on the real clock's day)
        expect(usage.days.find((d) => d.day === '2026-11-16')).toMatchObject({ eventPulses: 6, pulsesSkipped: 2 });

        // A fixed pulse is not one of them: a note at 14:30 brings the afternoon's.
        await prisma.observation.create({ data: { userId: user.id, text: 'Feeling good about the guitar', kind: 'state', source: 'tell', day: DAY, createdAt: at('14:30') } });
        fake.push(pulseSays(again));
        const fixed = await pulseIfDue(user.id, at('14:31'));
        expect(fixed).toMatchObject({ ran: true, reason: expect.stringMatching(/^afternoon and evening/) });
        expect((await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } })).onEvent).toBe(false);
    });

    it('what does not bring one: a word about a thread nothing today rests on, an agent’s change of plan; what does: his own change of plan', async () => {
        const { user } = await day();
        const other = (await withPersonLock(user.id, (tx) => openOrFindThread(tx, user.id, { title: 'Run three mornings a week', keywords: ['run', 'running'] }, { saidAt: new Date('2026-11-14T03:00:00Z'), forDay: '2026-11-14' }))).thread;
        await prisma.buddyThread.update({ where: { id: other.id }, data: { stage: 'active' } });
        await word(user.id, other.id, 'Ran 5 km this morning', at('09:00'), { kind: 'progress' });
        await word(user.id, other.id, 'Moving the runs to evenings', at('09:05'), { kind: 'changed', direct: false, via: 'agent' });
        expect(await pulseDue(user.id, at('09:30'))).toEqual({ due: false, reason: 'nothing new' });
        await word(user.id, other.id, 'Runs on Tuesday and Friday evenings now', at('09:40'), { kind: 'changed' });
        expect(await pulseDue(user.id, at('09:41'))).toMatchObject({ due: false, at: at('09:43') });
    });

    it('old news brings none: an old chat brought in from an export, or words that arrive days after they were said (the week’s simulation, 11-18)', async () => {
        const { user, t } = await day();
        const add = (text: string, saidAt: Date, now: Date, over: { via: string; imported?: boolean }) =>
            withPersonLock(user.id, async (tx) =>
                addThreadEvent(tx, user.id, await tx.buddyThread.findUniqueOrThrow({ where: { id: t.id } }), { kind: 'said', text, saidAt, forDay: '2026-11-13', direct: true, originKey: `test:${text}`, ...over }, now)
            );
        // A September chat from an export, about the very thread today's evening line rests on.
        await add('Had a chest pain after a run, should I see a doctor?', new Date('2026-09-10T18:00:00Z'), at('09:00'), { via: 'import', imported: true });
        // Words held on his PC that arrive three days after he said them.
        await add('Played for ten minutes', new Date('2026-11-13T15:00:00Z'), at('09:01'), { via: 'hook' });
        expect(await pulseDue(user.id, at('09:30'))).toEqual({ due: false, reason: 'nothing new' });
    });

    it('the loop off: no pulse on an event, before noon or after', async () => {
        const { user, ask } = await day();
        await api(user).patch('/api/buddy/settings', { loop: false });
        await answerAsk(user.id, ask.id, { choice: 1 }, at('09:00'));
        expect(await pulseDue(user.id, at('08:30'))).toEqual({ due: false, reason: 'not yet 09:00' });
        expect(await pulseDue(user.id, at('09:30'))).toEqual({ due: false, reason: 'nothing new' });
        expect(await pulseDue(user.id, at('12:30'))).toEqual({ due: false, reason: 'nothing new' });
    });
});
