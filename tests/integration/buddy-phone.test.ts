// The phone app's buddy (BUDDY_MEMORY_PLAN B4, app 0.3.0) on a fake Claude: the lock check covers the
// note (a notification shows on the lock screen too) and fails closed; the widget JSON carries the
// note, the lines said so far (newest first, only hours begun, the code's plain lines left out), his
// thumbs and the day in numbers; the phone's own token may thumb and tell, and read nothing more; the
// brief's note id is the one the hooks get, so a session doesn't show it twice.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { LOCK_SCHEMA, NIGHT_SCHEMA } from '../../src/services/buddy/think';
import { nightIfDue } from '../../src/services/buddy/worker';
import { buddyDayOf, phoneBuddy } from '../../src/services/buddy/voice';
import { loadLearningContext } from '../../src/services/learningDb/common';
import { dayNumbers, getAmbient, wallpaperSvg } from '../../src/services/ambient/ambient.service';
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
afterEach(() => vi.useRealTimers());

const night = (note: string, over: Record<string, unknown> = {}) => ({
    memory: [],
    who: '',
    heading: '',
    now: 'A week of building.',
    lines: [
        { slot: 'morning', text: 'Start with the reviews, then build', form: 'push', lockOk: true, sourceId: '' },
        { slot: 'afternoon', text: 'One topic before lunch, then the build', form: 'push', lockOk: true, sourceId: '' },
        { slot: 'evening', text: 'Stop before midnight tonight', form: 'push', lockOk: true, sourceId: '' },
    ],
    note,
    followUp: '',
    suggestions: [],
    notebook: 'Said: start with the reviews.',
    weekly: { use: false, strong: '', slipping: '', fix: '', deadline: '', focus: [] },
    ...over,
});
// Lines unlike any said before (a repeat would become the code's plain line).
const SETS: Record<string, [string, string, string]> = {
    Tuesday: ['Graphs before the office opens', 'A short walk after lunch helps', 'Lights out by eleven tonight'],
    Wednesday: ['Heaps today, one problem only', 'Reply to the recruiter mail', 'Write the contest notes up'],
};
const fresh = (tag: string) => ({
    lines: (['morning', 'afternoon', 'evening'] as const).map((slot, i) => ({ slot, text: SETS[tag]![i], form: 'push', lockOk: true, sourceId: '' })),
});
const lock = (note: boolean, reveals: Record<string, boolean> = {}) =>
    fakeMessage({ lines: ['morning', 'afternoon', 'evening'].map((slot) => ({ slot, reveals: reveals[slot] ?? false })), note }, { model: 'claude-haiku-5-5' });
// 05:00 in Kolkata on Mon 16 Nov 2026, and 13:00 the same day.
const AT = new Date(Date.UTC(2026, 10, 15, 23, 30));
const NOON = new Date(Date.UTC(2026, 10, 16, 7, 30));

async function setup() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true });
    const phone = asAgent((await createTestToken(user, ['ambient'], 'Phone app')).token);
    return { user, phone };
}

describe("the phone app's buddy", () => {
    it('the note is lock-checked even with nothing private; it passes, it names a private thing, the check fails', async () => {
        const { user } = await setup();
        // Nothing private: the note and, since stage 3 (ECOSYSTEM_V2_PLAN §4.8), every line go to the check.
        fake.push(fakeMessage(night('Good days lately. Keep the morning reviews first.')), lock(false));
        await nightIfDue(user.id, AT);
        expect(fake.calls.map((c) => c.output_config?.format?.schema)).toEqual([NIGHT_SCHEMA, LOCK_SCHEMA]);
        expect(JSON.stringify(fake.calls[1]!.messages)).toContain('<lines>\\nmorning: ');
        expect(JSON.stringify(fake.calls[1]!.messages)).toContain('Keep the morning reviews first');
        const first = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
        expect(first.noteLockOk).toBe(true);

        // A private memory: the lines and the note in one check; the note names it.
        await prisma.memory.create({ data: { userId: user.id, text: 'Money is tight this month', kind: 'state', sensitivity: 'private', lasting: false, source: 'agent', firstSeenDay: new Date('2026-11-16T00:00:00Z'), lastSeenDay: new Date('2026-11-16T00:00:00Z') } });
        fake.reset();
        fake.push(fakeMessage(night('Money is tight, so the paid course can wait.', fresh('Tuesday'))), lock(true, { afternoon: true }));
        await nightIfDue(user.id, new Date(AT.getTime() + 86_400_000));
        expect(fake.calls).toHaveLength(2);
        const second = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
        expect(second.noteLockOk).toBe(false);
        expect((second.lines as Array<{ slot: string; lockOk: boolean }>).map((l) => [l.slot, l.lockOk])).toEqual([['morning', true], ['afternoon', false], ['evening', true]]);

        // The check down: nothing on the lock screen, the note's words stay out of notifications.
        fake.reset();
        fake.push(fakeMessage(night('A quiet Wednesday. Read one page.', fresh('Wednesday'))), new Error('check down'));
        await nightIfDue(user.id, new Date(AT.getTime() + 2 * 86_400_000));
        const third = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
        expect(third.noteLockOk).toBe(false);
        expect((third.lines as Array<{ lockOk: boolean }>).every((l) => !l.lockOk)).toBe(true);
    });

    it("silence and the home screen's thought: a silent hour shows no line (the lock picture is the dial); the thought is lock-checked, then in the widget JSON and the home picture, never with titles hidden or when it reveals", async () => {
        const { user } = await setup();
        const thought = 'Your sharpest hours are before noon, so keep the hard topic there';
        fake.push(
            fakeMessage(night('A good start to the week.', { lines: [{ slot: 'morning', text: 'Start with the reviews, then build', form: 'push', lockOk: true, sourceId: '' }, { slot: 'afternoon', text: '', form: 'plain', lockOk: true, sourceId: '' }], insight: thought })),
            fakeMessage({ lines: ['morning', 'afternoon', 'evening'].map((slot) => ({ slot, reveals: false })), note: false, insight: false }, { model: 'claude-sonnet-5-5' })
        );
        await nightIfDue(user.id, AT);
        expect(JSON.stringify(fake.calls[1]!.messages)).toContain(`<home>\\n${thought}`);
        const step = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id } });
        expect(step).toMatchObject({ insight: thought, insightLockOk: true });
        expect((step.lines as Array<{ slot: string }>).map((l) => l.slot)).toEqual(['morning']);

        const morning = await getAmbient(user.id, AT);
        expect(morning.line?.text).toBe('Start with the reviews, then build');
        const noon = await getAmbient(user.id, NOON);
        expect(noon.line).toBeNull();
        expect(noon.insight).toBe(thought);
        expect(wallpaperSvg(noon, 1080, 2340, 'dark', 'home')).toContain('>Your sharpest hours');
        expect(wallpaperSvg(noon, 1080, 2340, 'dark', 'lock')).not.toContain('sharpest');
        expect((await getAmbient(user.id, NOON, { titles: false })).insight).toBeUndefined();
        // Without the check's yes: not on the phone, and the pictures change (their key).
        await prisma.buddyDay.update({ where: { id: step.id }, data: { insightLockOk: false } });
        const without = await getAmbient(user.id, NOON);
        expect(without.insight).toBeUndefined();
        expect(without.key).not.toBe(noon.key);

        // A thought that reveals stays off the home screen.
        fake.reset();
        fake.push(fakeMessage(night('Tuesday.', { ...fresh('Tuesday'), insight: 'Money is tight, so the paid course can wait' })), fakeMessage({ lines: ['morning', 'afternoon', 'evening'].map((slot) => ({ slot, reveals: false })), note: false, insight: true }, { model: 'claude-sonnet-5-5' }));
        const tuesday = new Date(AT.getTime() + 86_400_000);
        const r = (await nightIfDue(user.id, tuesday))!;
        expect(r.dropped).toContainEqual({ what: 'lock insight', why: 'names a private thing' });
        expect((await getAmbient(user.id, new Date(tuesday.getTime() + 8 * 3600_000))).insight).toBeUndefined();
    });

    it('the widget JSON: the note, the lines said so far, thumbs from the phone, the day in numbers; tell; nothing more for its token', async () => {
        const { user, phone } = await setup();
        fake.push(fakeMessage(night('Good days lately. Keep the morning reviews first.')), lock(false));
        await nightIfDue(user.id, AT);
        const step = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id } });

        // At 05:00 only the morning has begun; at 13:00 the afternoon line leads.
        const morning = (await phoneBuddy(user.id, AT))!;
        expect(morning.lines.map((l) => [l.slot, l.when, l.current])).toEqual([['morning', 'This morning', true]]);
        expect(morning.note).toMatchObject({ id: `${step.id}:note`, dayId: step.id, lockOk: true, text: 'Good days lately. Keep the morning reviews first.' });
        const noon = (await phoneBuddy(user.id, NOON))!;
        expect(noon.lines.map((l) => [l.slot, l.current])).toEqual([['afternoon', true], ['morning', false]]);

        // The next day: yesterday's three, newest first, after today's; a plain line (fallback) is left out.
        const lines = (step.lines as Array<Record<string, string | boolean | null>>).map((l) => (l['slot'] === 'evening' ? { ...l, fallback: true } : l));
        await prisma.buddyDay.update({ where: { id: step.id }, data: { lines } });
        fake.push(fakeMessage(night('Tuesday: the graph topic is due.', { lines: [{ slot: 'morning', text: 'Graphs first today', form: 'push', lockOk: true, sourceId: '' }] })), lock(false));
        const tuesday = new Date(AT.getTime() + 86_400_000);
        await nightIfDue(user.id, tuesday);
        const next = (await phoneBuddy(user.id, new Date(tuesday.getTime() + 8 * 3600_000)))!;
        // Tuesday's afternoon is silent (no line written) and Monday's evening an old step's plain line: left out.
        expect(next.lines.map((l) => l.when)).toEqual(['This morning', 'Yesterday afternoon', 'Yesterday morning']);
        expect(next.lines.every((l) => !l.current)).toBe(true);

        // Over HTTP with the phone's own token: the JSON carries it all; a thumb and a tell go in. The server reads
        // its own clock: Tuesday afternoon here (only Date is faked), so the test holds on any real day.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(tuesday.getTime() + 8 * 3600_000));
        const widget = (await phone.get('/api/ambient/widget')).body.data;
        expect(widget).toMatchObject({ numbers: expect.any(String), buddy: { note: { lockOk: true }, lines: expect.any(Array), thumbs: [] } });
        const today = widget.buddy.note.dayId as string;
        expect((await phone.post('/api/buddy/feedback', { buddyDayId: today, target: 'note', verdict: 'more' })).status).toBe(201);
        expect((await phone.post('/api/buddy/tell', { text: 'The mock interview went fine' })).status).toBe(201);
        expect((await phone.get('/api/ambient/widget')).body.data.buddy.thumbs).toEqual([{ dayId: today, target: 'note', verdict: 'more' }]);
        expect(await prisma.observation.count({ where: { userId: user.id, source: 'tell', sensitivity: 'private' } })).toBe(1);
        for (const url of ['/api/buddy/today', '/api/buddy/note', '/api/buddy/memories', '/api/brief']) expect((await phone.get(url)).status).toBe(403);

        // Off: no buddy part.
        await api(user).patch('/api/buddy/settings', { enabled: false });
        expect((await phone.get('/api/ambient/widget')).body.data.buddy).toBeNull();
        vi.useRealTimers();
    });

    it('the day in numbers, as the pictures say it', () => {
        const item = (done: boolean) => ({ kind: 'review' as const, title: 'A review', meta: '', done });
        const counts = { reviews: { done: 0, total: 3 }, focus: { done: 0, total: 0 }, tasks: { done: 0, total: 0 }, minutesLeft: 21 };
        // Stage 16: no estimated time (the owner, 11-20).
        expect(dayNumbers({ items: [item(false), item(false), item(true)], counts })).toBe('2 left today');
        expect(dayNumbers({ items: [item(true)], counts: { ...counts, minutesLeft: 0 } })).toBe('Done for today');
        expect(dayNumbers({ items: [], counts })).toBe('A free day');
    });

    it("the brief's note id is the hooks' note id", async () => {
        const { user } = await setup();
        fake.push(fakeMessage(night('Keep the morning reviews first.')), lock(false));
        expect((await api(user).post('/api/buddy/think')).status).toBe(200);
        const chat = asAgent((await createTestToken(user)).token, 'chat');
        const brief = (await chat.get('/api/brief')).body.data.buddy;
        const hookNote = (await chat.get('/api/buddy/note')).body.data;
        expect(brief).toMatchObject({ note: 'Keep the morning reviews first.', noteId: hookNote.id, noteDay: hookNote.day });
    });
    it('B8: a line or note saved with a label in front ("From your notes:") reads without it everywhere', async () => {
        const { user } = await setup();
        // Dated by the service's own clock, so the step is the current one whenever this runs.
        const now = new Date();
        const ctx = await loadLearningContext(user.id, now);
        const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: ctx.tz, hour: '2-digit', hour12: false }).format(now)) % 24;
        await prisma.buddyDay.create({
            data: {
                userId: user.id,
                day: new Date(`${buddyDayOf(ctx.today, hour)}T00:00:00Z`),
                kind: 'night',
                lines: [
                    { slot: 'morning', text: 'From your notes: LC 981, could you still write it cold?', form: 'question', lockOk: true, sourceId: null },
                    { slot: 'afternoon', text: 'Reminder - one topic before lunch', form: 'push', lockOk: true, sourceId: null },
                    { slot: 'evening', text: 'Stop before midnight', form: 'push', lockOk: true, sourceId: null },
                ],
                note: 'Heads-up: two good days in a row.',
                noteLockOk: true,
                followUp: 'Tip: how did the mock go?',
                model: 'test',
                costUsd: 0,
            },
        });
        // The phone app's screen: the lines said so far (newest first; the morning's is the oldest).
        const b = (await phoneBuddy(user.id, now))!;
        expect(b.lines[b.lines.length - 1]?.text).toBe('LC 981, could you still write it cold?');
        for (const l of b.lines) expect(l.text).not.toMatch(/^(From your notes|Reminder)/);
        expect(b.note?.text).toBe('Two good days in a row.');
        // Home's card reads the same way.
        const today = (await api(user).get('/api/buddy/today')).body.data;
        expect(today.day.lines.map((l: { text: string }) => l.text)).toEqual(['LC 981, could you still write it cold?', 'One topic before lunch', 'Stop before midnight']);
        expect([today.day.note, today.day.followUp]).toEqual(['Two good days in a row.', 'How did the mock go?']);
        if (today.line) expect(today.line.text).not.toMatch(/^(From your notes|Reminder)/);
    });
});
