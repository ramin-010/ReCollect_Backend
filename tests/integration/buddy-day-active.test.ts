// A buddy more active during the day (11-22, the owner): what they do in the app wakes it (reviews, focus lines,
// sessions, topics), the fixed pulses at 09:00, 12:00, 15:00, 18:00 and 21:00 (each only with something new), a
// "nothing yet" nudge near the time they usually start, up to 6 lines a day; and LeetCode's accepted problems logged
// as practice. On scripted models and a scripted LeetCode: no real call is made.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { ACTIVITY_SETTLE_MS, activitySince, pulseDue, pulseIfDue, usualStart } from '../../src/services/buddy/pulse';
import { LINES_MAX } from '../../src/services/buddy/lineTimes';
import { setLeetcodeSourceForTests, syncLeetcode, runLeetcodePass, type LeetcodeSubmission } from '../../src/services/learningDb/leetcode.service';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
import { api, createSubjectRow } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

const fake = new FakeClaude();
beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    setAiClientForTests(fake);
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = '';
    setAiClientForTests(null);
    setLeetcodeSourceForTests(null);
});
beforeEach(() => fake.reset());

/** Their clock (Kolkata) on Mon 16 Nov 2026. */
const at = (hhmm: string, day = '16') => new Date(`2026-11-${day}T${hhmm}:00+05:30`);
const DAY = new Date('2026-11-16T00:00:00Z');

async function person(loop = true) {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, loop });
    await prisma.buddyDay.create({ data: { userId: user.id, day: DAY, kind: 'night', lines: [], model: 'claude-opus-5-5', createdAt: at('04:30') } });
    return user;
}
async function focusDone(userId: string, text: string, when: Date) {
    await prisma.focusItem.create({ data: { userId, day: DAY, text, done: true, doneAt: when } });
}
const pulseSays = (lines: unknown[]) => fakeMessage({ lines, note: '', insight: '' }, { model: 'claude-sonnet-5-5' });

describe('what they do in the app wakes the buddy', () => {
    it('reads reviews, focus lines and sessions since a moment, as words', async () => {
        const user = await person();
        await focusDone(user.id, 'Two DP problems', at('10:05'));
        await prisma.workSession.create({ data: { userId: user.id, kind: 'study', day: DAY, startedAt: at('10:20'), minutes: 40, title: 'Graphs', createdAt: at('10:20') } });
        const act = await activitySince(user.id, at('10:00'), at('12:00'));
        expect(act.count).toBe(2);
        expect(act.last?.toISOString()).toBe(at('10:20').toISOString());
        expect(act.words).toBe('focus line ticked: "Two DP problems"; logged 40 min of study: Graphs');
        expect((await activitySince(user.id, at('10:30'), at('12:00'))).count).toBe(0);
    });

    it('a fixed pulse at 09:00, 12:00, 15:00, 18:00 or 21:00 runs on activity alone, once in its hours', async () => {
        const user = await person(false);
        expect(await pulseDue(user.id, at('08:30'))).toMatchObject({ due: false, reason: 'not yet 09:00' });
        expect(await pulseDue(user.id, at('09:10'))).toMatchObject({ due: false, reason: 'nothing new' });
        await focusDone(user.id, 'Clear the reviews', at('14:40'));
        const due = await pulseDue(user.id, at('15:05'));
        expect(due).toMatchObject({ due: true, onEvent: false, activity: 'focus line ticked: "Clear the reviews"', slots: ['afternoon', 'evening'] });
        fake.push(pulseSays([{ slot: 'evening', text: 'Reviews cleared before three. Tonight is free for the graph problems.', form: 'observation', lockOk: true, sourceId: '' }]));
        expect(await pulseIfDue(user.id, at('15:05'))).toMatchObject({ ran: true });
        // The pulse saw what they did.
        expect(JSON.stringify(fake.calls[0]!.messages)).toContain('what they did in the app since you last thought: focus line ticked: \\"Clear the reviews\\"');
        expect(await pulseDue(user.id, at('16:00'))).toMatchObject({ due: false, reason: 'already pulsed' });
    });

    it('with the loop on and no pulse since 09:00, the fixed one takes it at once', async () => {
        const user = await person(true);
        await focusDone(user.id, 'Mock interview prep', at('10:30'));
        expect(await pulseDue(user.id, at('10:35'))).toMatchObject({ due: true, onEvent: false, activity: 'focus line ticked: "Mock interview prep"' });
    });

    it('an event pulse on activity waits for the settle after the 09:00 one has run', async () => {
        const user = await person(true);
        await prisma.buddyDay.create({ data: { userId: user.id, day: DAY, kind: 'pulse', lines: [], model: 'claude-sonnet-5-5', createdAt: at('09:30') } });
        await focusDone(user.id, 'Mock interview prep', at('10:30'));
        const waiting = await pulseDue(user.id, at('10:35'));
        expect(waiting).toMatchObject({ due: false, reason: 'a pulse on an event waits' });
        expect(waiting.due === false ? waiting.at?.toISOString() : null).toBe(new Date(at('10:30').getTime() + ACTIVITY_SETTLE_MS).toISOString());
        expect(await pulseDue(user.id, at('10:51'))).toMatchObject({ due: true, onEvent: true, activity: 'focus line ticked: "Mock interview prep"' });
    });
});

describe('the "nothing yet" nudge', () => {
    it('near the time they usually start, with nothing done today, once', async () => {
        const user = await person(true);
        // Six evenings of reviews done at about 19:00 in the last weeks: they usually start at 19:00.
        const subject = await createSubjectRow(user.id, 'DSA');
        const topic = await prisma.topic.create({ data: { userId: user.id, subjectId: subject.id, title: 'Heaps' } });
        for (const [i, day] of ['02', '04', '06', '09', '11', '13'].entries()) {
            await prisma.revision.create({ data: { userId: user.id, topicId: topic.id, cycleNumber: i + 1, intervalDays: 1, scheduledFor: new Date(`2026-11-${day}T00:00:00Z`), completedAt: at('19:05', day), status: 'done' } });
        }
        expect(await usualStart(user.id, '2026-11-16' as never, 'Asia/Kolkata')).toBe(15 * 60); // 19:00 is minute 900 of a day from 04:00
        // The fixed 18:00 pulse already ran with nothing new... the nudge is its own.
        await prisma.buddyDay.create({ data: { userId: user.id, day: DAY, kind: 'pulse', lines: [], model: 'claude-sonnet-5-5', createdAt: at('18:00') } });
        expect(await pulseDue(user.id, at('18:20'))).toMatchObject({ due: false });
        const due = await pulseDue(user.id, at('18:40'));
        expect(due).toMatchObject({ due: true, onEvent: true, nudge: { usual: '19:00' } });
        fake.push(pulseSays([{ from: '18:45', until: '20:00', text: 'Nothing yet today: two quick reviews and you are on the board.', form: 'push', lockOk: true, sourceId: '' }]));
        expect(await pulseIfDue(user.id, at('18:40'))).toMatchObject({ ran: true });
        expect(JSON.stringify(fake.calls[0]!.messages)).toContain('close to when they usually start (about 19:00) and nothing is done today yet');
        // Once: a step since the nudge's time.
        expect(await pulseDue(user.id, at('19:10'))).toMatchObject({ due: false });
    });

    it('not when something is done today, nor in a busy week', async () => {
        const user = await person(true);
        const subject = await createSubjectRow(user.id, 'DSA');
        const topic = await prisma.topic.create({ data: { userId: user.id, subjectId: subject.id, title: 'Heaps' } });
        for (const [i, day] of ['02', '04', '06', '09', '11', '13'].entries()) {
            await prisma.revision.create({ data: { userId: user.id, topicId: topic.id, cycleNumber: i + 1, intervalDays: 1, scheduledFor: new Date(`2026-11-${day}T00:00:00Z`), completedAt: at('19:05', day), status: 'done' } });
        }
        await prisma.buddyDay.create({ data: { userId: user.id, day: DAY, kind: 'pulse', lines: [], model: 'claude-sonnet-5-5', createdAt: at('18:00') } });
        await prisma.user.update({ where: { id: user.id }, data: { busyUntil: DAY } });
        expect(await pulseDue(user.id, at('18:40'))).toMatchObject({ due: false });
        await prisma.user.update({ where: { id: user.id }, data: { busyUntil: null } });
        await focusDone(user.id, 'Morning reviews', at('08:00'));
        // Done this morning: the 18:00 pulse saw nothing new after it... and no nudge.
        await prisma.buddyDay.create({ data: { userId: user.id, day: DAY, kind: 'pulse', lines: [], model: 'claude-sonnet-5-5', createdAt: at('18:05') } });
        expect(await pulseDue(user.id, at('18:40'))).toMatchObject({ due: false });
    });
});

describe('six lines a day', () => {
    it('the limit is 6', () => {
        expect(LINES_MAX).toBe(6);
    });
});

describe('LeetCode', () => {
    const sub = (id: string, title: string, slug: string, when: Date): LeetcodeSubmission => ({ id, title, titleSlug: slug, timestamp: String(Math.floor(when.getTime() / 1000)) });
    const NOW = at('21:00');
    let subs: LeetcodeSubmission[] = [];
    beforeEach(() => {
        subs = [
            sub('101', 'Two Sum', 'two-sum', at('20:10')),
            sub('102', 'Two Sum', 'two-sum', at('20:30')), // the same problem again that day: one practice
            sub('103', 'Merge Intervals', 'merge-intervals', at('21:30', '14')),
            sub('104', 'LRU Cache', 'lru-cache', new Date('2026-09-01T12:00:00Z')), // older than 30 days: not on a first import
        ];
        setLeetcodeSourceForTests({ exists: async (name) => name !== 'nobody', recent: async () => subs });
    });

    it('a username is checked, then the last 30 days come in as practice, each problem once a day, under DSA', async () => {
        const user = await createTestUser();
        const dsa = await createSubjectRow(user.id, 'DSA');
        expect((await api(user).put('/api/leetcode', { username: 'nobody' })).status).toBe(400);
        const res = await api(user).put('/api/leetcode', { username: 'coder_1' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ username: 'coder_1', logged: 2, imported: 2 });
        const rows = await prisma.workSession.findMany({ where: { userId: user.id }, orderBy: { startedAt: 'asc' } });
        expect(rows.map((r) => [r.title, r.kind, r.problem, r.url, r.subjectId, r.minutes, r.outcome])).toEqual([
            ['LeetCode: Merge Intervals', 'practice', 'Merge Intervals', 'https://leetcode.com/problems/merge-intervals/', dsa.id, null, null],
            ['LeetCode: Two Sum', 'practice', 'Two Sum', 'https://leetcode.com/problems/two-sum/', dsa.id, null, null],
        ]);
        // Again: nothing twice.
        expect(await syncLeetcode(user.id, NOW)).toMatchObject({ logged: 0 });
        // A new problem later is logged by the pass (once 20 hours have passed).
        subs = [...subs, sub('105', 'Coin Change', 'coin-change', at('22:00'))];
        expect((await runLeetcodePass(NOW)).logged).toBe(0); // just synced
        expect((await runLeetcodePass(new Date(Date.now() + 21 * 3600_000))).logged).toBe(1);
        // Clearing stops it; the sessions stay.
        expect((await api(user).put('/api/leetcode', { username: null })).body.data).toMatchObject({ username: null, logged: 3 });
    });

    it('is the app’s only', async () => {
        const user = await createTestUser();
        const chat = asAgent((await createTestToken(user)).token);
        expect((await chat.get('/api/leetcode')).status).toBe(403);
    });
});
