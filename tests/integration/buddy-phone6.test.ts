// Stage 6 of ECOSYSTEM_V2_PLAN, the server's part (§4.13, §4.14), on scripted models: the lock check reads the
// night's questions (a question it passed may show on the lock screen); the phone's day for app 0.6.0 and later
// carries each word's end time, the open questions with their quick answers (never a sensitive or off-screens
// thread's, never with titles hidden) and a lock-checked question as the lock line; an older app gets exactly
// what it got; the plain twins (no words from the buddy) have their own key and picture; the phone app's own
// token may answer a question.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { nightIfDue } from '../../src/services/buddy/worker';
import { appAtLeast, getAmbient, wallpaperSvg } from '../../src/services/ambient/ambient.service';
import { openOrFindThread, withPersonLock } from '../../src/services/buddy/threads';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

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

/** His clock (Kolkata) on Mon 16 Nov 2026. */
const at = (hhmm: string, day = '16') => new Date(`2026-11-${day}T${hhmm}:00+05:30`);
const DAY = new Date('2026-11-16T00:00:00Z');

async function person() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, loop: true });
    return user;
}
async function thread(userId: string, title: string, over: Record<string, unknown> = {}) {
    const t = (await withPersonLock(userId, (tx) => openOrFindThread(tx, userId, { title, keywords: title.toLowerCase().split(' ') }, { saidAt: new Date('2026-11-14T05:00:00Z'), forDay: '2026-11-14' }))).thread;
    return prisma.buddyThread.update({ where: { id: t.id }, data: { stage: 'active', rhythm: 'daily', ...over } });
}
const nightSays = (asks: unknown[]) =>
    fakeMessage({
        memory: [],
        who: '',
        heading: '',
        now: 'A steady week.',
        lines: [{ slot: 'morning', text: 'One review before work', form: 'push', lockOk: true, sourceId: '', about: [] }],
        insight: '',
        note: '',
        followUp: '',
        suggestions: [],
        notebook: 'Watching: the runs.',
        weekly: { use: false, strong: '', slipping: '', fix: '', deadline: '', focus: [] },
        insightAbout: [],
        noteAbout: [],
        asks,
        threadOps: [],
    });
const lockSays = (asks: Array<{ i: number; reveals: boolean }> | undefined) =>
    fakeMessage({ lines: ['morning', 'afternoon', 'evening'].map((slot) => ({ slot, reveals: false })), note: false, insight: false, ...(asks ? { asks } : {}) }, { model: 'claude-sonnet-5-5' });

describe('stage 6, the server: questions on the phone', () => {
    it('the lock check reads the night’s questions: one it passed may show on the lock screen; one that reveals, or with no verdict, may not', async () => {
        for (const [verdict, expected] of [[[{ i: 0, reveals: false }], true], [[{ i: 0, reveals: true }], false], [undefined, false]] as const) {
            const user = await person();
            const t = await thread(user.id, 'Run three mornings a week');
            fake.reset();
            fake.push(nightSays([{ threadId: t.id, kind: 'ask', text: 'A run this evening?', answers: [{ label: 'Did it', meaning: 'done' }, { label: 'Not today', meaning: 'skipped' }], from: '18:00', until: '22:30' }]));
            fake.push(lockSays(verdict ? [...verdict] : undefined));
            await nightIfDue(user.id, at('05:00'));
            const sent = JSON.stringify(fake.calls[1]!.messages);
            expect(sent).toContain('<asks>\\n0: A run this evening?');
            const ask = await prisma.buddyAsk.findFirstOrThrow({ where: { userId: user.id } });
            expect(ask.lockOk).toBe(expected);
        }
    });

    it('the phone’s day for app 0.6.0: the open questions with their answers and end times, a lock-checked one as the lock line; never a sensitive or off-screens thread’s; an older app and hidden titles get none', async () => {
        const user = await person();
        const run = await thread(user.id, 'Run three mornings a week');
        const read = await thread(user.id, 'Read before bed');
        const health = await thread(user.id, 'Knee physio exercises', { sensitive: true });
        const night = await prisma.buddyDay.create({
            data: { userId: user.id, day: DAY, kind: 'night', lines: [{ slot: 'evening', text: 'Lights out by eleven tonight', form: 'push', lockOk: true, sourceId: null }], insight: 'Evenings are your calm hours', insightLockOk: true, model: 'claude-opus-5-5', createdAt: at('04:30') },
        });
        const ask = (threadId: string, text: string, lockOk: boolean, rev: number) =>
            prisma.buddyAsk.create({ data: { userId: user.id, threadId, buddyDayId: night.id, text, answers: [{ label: 'Did it', meaning: 'done' }, { label: 'Not today', meaning: 'skipped' }], seenRevision: rev, fromAt: at('18:00'), untilAt: at('22:30'), lockOk } });
        const a1 = await ask(run.id, 'A run this evening?', true, run.revision);
        const a2 = await ask(read.id, 'Reading tonight?', false, read.revision);
        await ask(health.id, 'Knee exercises done?', true, health.revision);

        const now = at('19:00');
        const phone = await getAmbient(user.id, now, { app: '0.6.0' });
        expect(phone.asks?.map((q) => [q.text, q.lockOk])).toEqual([
            ['A run this evening?', true],
            ['Reading tonight?', false],
        ]);
        expect(phone.asks?.[0]).toMatchObject({ _id: a1.id, answers: [{ label: 'Did it', meaning: 'done' }, { label: 'Not today', meaning: 'skipped' }], until: at('22:30').toISOString() });
        expect(phone.line).toMatchObject({ text: 'A run this evening?', askId: a1.id, until: at('22:30').toISOString() });
        expect(phone.insightUntil).toBe(at('04:00', '17').toISOString());
        expect(phone.plainKey).toBeTruthy();
        expect(phone.plainKey).not.toBe(phone.key);
        void a2;

        // In the phone's quiet hours: no question, and a fresh one is not marked as shown.
        const fresh = await ask(read.id, 'Reading at nine?', true, read.revision);
        expect((await getAmbient(user.id, now, { app: '0.6.0', quiet: true })).asks).toBeUndefined();
        expect((await prisma.buddyAsk.findUniqueOrThrow({ where: { id: fresh.id } })).firstShownAt).toBeNull();
        await prisma.buddyAsk.delete({ where: { id: fresh.id } });
        // An older app: no question, the line as before (no end time).
        const old = await getAmbient(user.id, now);
        expect(old.asks).toBeUndefined();
        expect(old.line).toEqual({ dayId: night.id, slot: 'evening', text: 'Lights out by eleven tonight' });
        expect(old.plainKey).toBeUndefined();
        // Hidden titles: none at all.
        expect((await getAmbient(user.id, now, { app: '0.6.0', titles: false })).asks).toBeUndefined();
        // Outside its hours the line is the night's again, with its end time (the evening's: 04:00).
        const later = await getAmbient(user.id, at('23:00'), { app: '0.6.0' });
        expect(later.asks).toEqual([]);
        expect(later.line).toMatchObject({ text: 'Lights out by eleven tonight', until: at('04:00', '17').toISOString() });
        expect(appAtLeast('0.6.0-qa', '0.6.0')).toBe(true);
        expect(appAtLeast('0.5.2', '0.6.0')).toBe(false);
        expect(appAtLeast(null, '0.6.0')).toBe(false);
    });

    it('the plain twins: the lock picture without the buddy’s words, its own ETag; the phone app’s token may answer, and the answer leaves the phone’s day', async () => {
        const user = await person();
        const run = await thread(user.id, 'Run three mornings a week');
        const night = await prisma.buddyDay.create({ data: { userId: user.id, day: DAY, kind: 'night', lines: [], model: 'claude-opus-5-5', createdAt: at('04:30') } });
        const now = new Date();
        const q = await prisma.buddyAsk.create({
            data: { userId: user.id, threadId: run.id, buddyDayId: night.id, text: 'A run this evening?', answers: [{ label: 'Did it', meaning: 'done' }], seenRevision: run.revision, fromAt: new Date(now.getTime() - 60_000), untilAt: new Date(now.getTime() + 3600_000), lockOk: true },
        });
        const a = await getAmbient(user.id, now, { app: '0.6.0' });
        expect(a.line?.askId).toBe(q.id);
        expect(wallpaperSvg(a, 1080, 2340, 'dark', 'lock')).toContain('evening?');
        expect(wallpaperSvg({ ...a, line: null }, 1080, 2340, 'dark', 'lock')).not.toContain('evening?');

        const phone = asAgent((await createTestToken(user, ['ambient'], 'Phone app')).token);
        const full = await phone.get('/api/ambient/wallpaper.png?w=540&h=1170&screen=lock&app=0.6.0');
        const plain = await phone.get('/api/ambient/wallpaper.png?w=540&h=1170&screen=lock&app=0.6.0&plain=1');
        expect(full.status).toBe(200);
        expect(plain.status).toBe(200);
        expect(plain.headers['etag']).not.toBe(full.headers['etag']);
        expect((await phone.get('/api/ambient/widget?app=0.6.0')).body.data.asks.map((x: { _id: string }) => x._id)).toEqual([q.id]);
        expect((await phone.post(`/api/buddy/asks/${q.id}/answer`, { choice: 0 })).body.data).toEqual({ state: 'answered' });
        const after = (await phone.get('/api/ambient/widget?app=0.6.0')).body.data;
        expect(after.asks).toEqual([]);
        expect(after.line).toBeNull();
        // The phone's token still reads nothing more of the buddy.
        expect((await phone.get('/api/buddy/you')).status).toBe(403);
    });
});
