// ECOSYSTEM_V2_PLAN stage 18, a live day: their own fresh words that change today (a plan for tonight, how today is
// going) start one small pulse within minutes, within the pulse budget; an import, an agent's note or old words never
// do; a direct save passed on as their word does when its words name today; the night reads each note's day, so
// yesterday's state is never today's. Scripted models only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { queueOwnWords } from '../../src/services/buddy/capture.service';
import { drainBuddyQueue } from '../../src/services/buddy/worker';
import { pulseDue } from '../../src/services/buddy/pulse';
import { rememberNotes } from '../../src/services/buddy/memory.service';
import { loadNightInput, nightTask } from '../../src/services/buddy/think';
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
/** Their clock (Kolkata) on Fri 20 Nov 2026. */
const at = (hhmm: string, day = '20') => new Date(`2026-11-${day}T${hhmm}:00+05:30`);
const DAY = new Date('2026-11-20T00:00:00Z');
const digest = (o: Record<string, unknown>) => fakeMessage({ notes: [], items: [], tasksDone: [], threads: [], screens: [], today: false, ...o }, { model: 'claude-sonnet-5-5' });

async function person(loop = true) {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { timezone: TZ } });
    await api(user).patch('/api/buddy/settings', { enabled: true, loop });
    // This morning's night ran (a pulse needs one).
    await prisma.buddyDay.create({ data: { userId: user.id, day: DAY, kind: 'night', lines: [{ slot: 'evening', from: '19:00', until: '21:00', text: 'An hour of study tonight?', form: 'push', lockOk: true, sourceId: null }], model: 'claude-opus-5-5', createdAt: at('05:00') } });
    return user;
}
const say = (userId: string, seq: number, text: string, when: Date) => queueOwnWords(userId, { key: 'ask:live', seq, via: 'ask_ai', messages: [{ at: when.toISOString(), text }] }, when);
/** The noon pulse already ran (so the fixed one is not what falls due before 18:00). */
const noonRan = (userId: string) => prisma.buddyDay.create({ data: { userId, day: DAY, kind: 'pulse', lines: [], model: 'claude-sonnet-5-5', createdAt: at('12:05') } });
const todayAt = async (userId: string) => (await prisma.buddyCaptureDay.findUnique({ where: { userId_day: { userId, day: DAY } } }))?.todayAt ?? null;

describe('a live day (stage 18)', () => {
    it('their own words that change today stamp it, and a pulse on it falls due 3 minutes after (no events needed)', async () => {
        const user = await person();
        await noonRan(user.id);
        await say(user.id, 1, 'Wiped today, zero energy, skipping study tonight.', at('17:30'));
        fake.push(digest({ notes: [{ text: 'Worn out today; skipping study tonight', kind: 'state', private: false, seenMemoryId: '' }], today: true }));
        await drainBuddyQueue(at('17:31'));
        expect(await todayAt(user.id)).toEqual(at('17:31'));
        expect(await pulseDue(user.id, at('17:32'))).toMatchObject({ due: false, reason: 'a pulse on an event waits', at: at('17:34') });
        expect(await pulseDue(user.id, at('17:35'))).toMatchObject({ due: true, onEvent: true });
    });

    it('never from words not about today, an import, an agent’s note, or old words; never with the loop off', async () => {
        const user = await person();
        await say(user.id, 1, 'I like cooking on Sundays.', at('17:30'));
        fake.push(digest({ today: false }));
        await drainBuddyQueue(at('17:31'));
        expect(await todayAt(user.id)).toBeNull();
        // Old words (said two days ago, arriving now): the digest may say today, code holds it.
        await say(user.id, 2, 'Tonight I finish the course module.', at('20:00', '18'));
        fake.push(digest({ today: true }));
        await drainBuddyQueue(at('17:40'));
        expect(await todayAt(user.id)).toBeNull();
        // The loop off: a stamp starts no pulse.
        const off = await person(false);
        await prisma.buddyCaptureDay.create({ data: { userId: off.id, day: DAY, todayAt: at('11:00') } });
        expect((await pulseDue(off.id, at('11:10'))).due).toBe(false);
    });

    it('a direct save passed on as their word stamps it when its words name today; an inference never', async () => {
        const user = await person();
        const writer = { userId: user.id, source: 'agent' as const, agentName: 'ChatGPT', sessionKey: null, project: null };
        await rememberNotes(writer, [{ text: 'Plans to study system design for an hour this evening', kind: 'state', inferred: true }], at('15:00'));
        expect(await todayAt(user.id)).toBeNull();
        await rememberNotes(writer, [{ text: 'Likes long walks', kind: 'preference', inferred: false }], at('15:05'));
        expect(await todayAt(user.id)).toBeNull();
        await rememberNotes(writer, [{ text: 'Plans to study system design for an hour this evening', kind: 'state', inferred: false }], at('15:10'));
        expect(await todayAt(user.id)).toEqual(at('15:10'));
    });

    it('the budget holds: 30 minutes after the step before, and 4 pulses on events a day', async () => {
        const user = await person();
        await prisma.buddyDay.create({ data: { userId: user.id, day: DAY, kind: 'pulse', onEvent: true, lines: [], model: 'claude-sonnet-5-5', createdAt: at('16:50') } });
        await prisma.buddyCaptureDay.create({ data: { userId: user.id, day: DAY, todayAt: at('17:00') } });
        expect(await pulseDue(user.id, at('17:05'))).toMatchObject({ due: false, at: at('17:20') });
        for (const t of ['17:21', '17:52', '18:23']) await prisma.buddyDay.create({ data: { userId: user.id, day: DAY, kind: 'pulse', onEvent: true, lines: [], model: 'claude-sonnet-5-5', createdAt: at(t) } });
        await prisma.buddyCaptureDay.update({ where: { userId_day: { userId: user.id, day: DAY } }, data: { todayAt: at('18:30') } });
        expect(await pulseDue(user.id, at('19:00'))).toMatchObject({ due: false, reason: 'the pulses on events are used up today' });
    });

    it('the night reads the day each note was said, so yesterday stays yesterday', async () => {
        const user = await person();
        await prisma.observation.create({ data: { userId: user.id, kind: 'state', text: 'Worn out, skipping study tonight', source: 'tell', day: new Date('2026-11-19T00:00:00Z'), saidAt: at('17:30', '19'), sensitivity: 'open' } });
        const input = await loadNightInput(user.id, at('05:00', '21'));
        const task = nightTask({ ...input, loop: true });
        expect(task).toMatch(/· said Thu 19 Nov · Worn out, skipping study tonight/);
    });
});
