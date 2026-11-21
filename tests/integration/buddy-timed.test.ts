// Stage 7 of ECOSYSTEM_V2_PLAN (V1; his point 4: "up to the buddy whether it shows 2, 3 or 4 at most, and if it
// doesn't want to show anything, that's its choice"), on scripted models: with the loop on the night writes 0 to 4
// lines, each in its own hours; code holds the hours, the overlaps and the four, and refuses nothing for having
// been said another day (his point 5); the lock check reads them by number; every screen shows the line whose
// hours hold the moment, with its own end time, and nothing between lines; his thumb names the line by its start;
// a pulse keeps the lines whose hours are over and answers every line from now on.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { nightIfDue } from '../../src/services/buddy/worker';
import { pulseIfDue } from '../../src/services/buddy/pulse';
import { currentLine, phoneBuddy } from '../../src/services/buddy/voice';
import { getAmbient } from '../../src/services/ambient/ambient.service';
import { LOCK_SCHEMA_TIMED, type Dropped, type Line } from '../../src/services/buddy/think';
import { dayMinute, slotOfMinute } from '../../src/services/buddy/lineTimes';
import { openOrFindThread, withPersonLock } from '../../src/services/buddy/threads';
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

/** His clock (Kolkata) on Mon 16 Nov 2026. */
const at = (hhmm: string, day = '16') => new Date(`2026-11-${day}T${hhmm}:00+05:30`);
const DAY = new Date('2026-11-16T00:00:00Z');

async function person() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true, loop: true });
    return user;
}
async function thread(userId: string, title: string) {
    const t = (await withPersonLock(userId, (tx) => openOrFindThread(tx, userId, { title, keywords: title.toLowerCase().split(' ') }, { saidAt: new Date('2026-11-14T05:00:00Z'), forDay: '2026-11-14' }))).thread;
    return prisma.buddyThread.update({ where: { id: t.id }, data: { stage: 'active', rhythm: 'daily' } });
}
/** A timed line as the model writes it. */
const tl = (from: string, until: string, text: string, about: string[] = []) => ({ from, until, text, form: 'push', lockOk: true, sourceId: '', about });
/** A timed line as a step keeps it. */
const kept = (from: string, until: string, text: string, lockOk = true): Line => ({ slot: slotOfMinute(dayMinute(from)), from, until, text, form: 'push', lockOk, sourceId: null });
const nightSays = (lines: unknown[]) =>
    fakeMessage({
        memory: [],
        who: '',
        heading: '',
        now: 'A steady week.',
        lines,
        insight: '',
        note: '',
        followUp: '',
        suggestions: [],
        notebook: 'Watching: the evenings.',
        weekly: { use: false, strong: '', slipping: '', fix: '', deadline: '', focus: [] },
        insightAbout: [],
        noteAbout: [],
        asks: [],
        reminders: [],
        threadOps: [],
    });
const pulseSays = (lines: unknown[]) => fakeMessage({ lines, note: '', insight: '', insightAbout: [], noteAbout: [], asks: [], reminders: [] }, { model: 'claude-sonnet-5-5' });
/** The lock check's answer by number: true where a line names a private thing. */
const lockByNumber = (reveals: boolean[]) => fakeMessage({ lines: reveals.map((r, i) => ({ i, reveals: r })), note: false, insight: false }, { model: 'claude-sonnet-5-5' });

describe('stage 7: timed lines', () => {
    it('the night with the loop on: 0 to 4 lines in their own hours, held by code, checked by number; each screen shows the line its hours hold; his thumb names it by its start', async () => {
        const user = await person();
        const t = await thread(user.id, 'Guitar most evenings');
        // Said the day before, word for word: with the loop on nothing is refused for that (relevance wins).
        await prisma.buddyDay.create({ data: { userId: user.id, day: new Date('2026-11-15T00:00:00Z'), kind: 'night', lines: [{ slot: 'evening', text: 'Guitar after dinner', form: 'push', lockOk: true, sourceId: null }], model: 'claude-opus-5-5', createdAt: at('04:30', '15') } });
        fake.push(
            nightSays([
                tl('06:30', '08:00', 'One honest hour before work'),
                tl('07:30', '09:00', 'Overlaps the first'),
                tl('13:00', '14:00', 'A walk after lunch, no screens'),
                tl('18:30', '20:00', 'Guitar after dinner', [t.id]),
                tl('22:30', '00:30', 'Lights out soon, it was a long day'),
                tl('01:00', '02:00', 'A fifth line'),
            ])
        );
        // The lunch line names a private thing (by number: the second of the four kept).
        fake.push(lockByNumber([false, true, false, false]));
        await nightIfDue(user.id, at('05:00'));

        const night = fake.calls[0]!;
        expect(JSON.stringify(night.system)).toContain('0 to 4 lines for their lock screen today, each shown in its own hours');
        const items = (night.output_config!.format!.schema as { properties: { lines: { items: { properties: Record<string, unknown> } } } }).properties.lines.items;
        expect(Object.keys(items.properties)).toEqual(['from', 'until', 'text', 'form', 'lockOk', 'sourceId', 'about']);
        expect(fake.calls[1]!.output_config?.format?.schema).toBe(LOCK_SCHEMA_TIMED);
        expect(JSON.stringify(fake.calls[1]!.messages)).toContain('<lines>\\n0: One honest hour before work\\n1: A walk after lunch, no screens\\n2: Guitar after dinner\\n3: Lights out soon, it was a long day\\n</lines>');

        const row = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id, day: DAY } });
        const lines = row.lines as unknown as Line[];
        expect(lines.map((l) => [l.from, l.until, l.slot, l.lockOk])).toEqual([
            ['06:30', '08:00', 'morning', true],
            ['13:00', '14:00', 'afternoon', false],
            ['18:30', '20:00', 'evening', true],
            ['22:30', '00:30', 'evening', true],
        ]);
        expect(lines[2]!.about).toEqual([{ threadId: t.id, rev: t.revision }]);
        const why = (row.dropped as unknown as Dropped[]).map((d) => d.why);
        expect(why).toEqual(expect.arrayContaining(['overlaps another line', 'more than four lines today', 'names a private thing']));
        expect(why).not.toContain('said lately');

        // Each in its hours, with its own end time; between lines nothing (the dial); across midnight on his day.
        expect(await currentLine(user.id, at('07:00'))).toMatchObject({ text: 'One honest hour before work', key: '06:30', until: at('08:00').toISOString() });
        expect(await currentLine(user.id, at('10:00'))).toBeNull();
        expect(await currentLine(user.id, at('00:15', '17'))).toMatchObject({ key: '22:30', until: at('00:30', '17').toISOString() });
        // The phone's day (app 0.6.0): the lock-safe line, its key and end; the private one never.
        expect((await getAmbient(user.id, at('19:00'), { app: '0.6.0' })).line).toMatchObject({ text: 'Guitar after dinner', key: '18:30', until: at('20:00').toISOString() });
        expect((await getAmbient(user.id, at('13:30'), { app: '0.6.0' })).line).toBeNull();
        // An older app: the line as it always got it.
        expect((await getAmbient(user.id, at('19:00'))).line).toEqual({ dayId: row.id, slot: 'evening', text: 'Guitar after dinner' });
        // The phone's own screen: the lines said so far today, newest first, each named by its start.
        const said = (await phoneBuddy(user.id, at('19:00')))!.lines.filter((l) => l.day === '2026-11-16');
        expect(said.map((l) => [l.key, l.when, l.current])).toEqual([
            ['18:30', 'This evening', true],
            ['13:00', 'This afternoon', false],
            ['06:30', 'This morning', false],
        ]);

        // His thumbs: a timed line by its start; an older app's by the part of the day; no other words.
        expect((await api(user).post('/api/buddy/feedback', { buddyDayId: row.id, target: '18:30', verdict: 'less' })).status).toBe(201);
        expect((await api(user).post('/api/buddy/feedback', { buddyDayId: row.id, target: 'morning', verdict: 'more' })).status).toBe(201);
        expect((await api(user).post('/api/buddy/feedback', { buddyDayId: row.id, target: '25:00', verdict: 'less' })).status).toBe(400);
        // The next night reads each line by its hours, with his thumb on it.
        fake.reset();
        fake.push(nightSays([]));
        await nightIfDue(user.id, at('05:00', '17'));
        const next = JSON.stringify(fake.calls[0]!.messages);
        expect(next).toContain('2026-11-16 18:30-20:00: Guitar after dinner (they said: not this)');
        expect(next).toContain('2026-11-16 06:30-08:00: One honest hour before work (they liked this: more like it)');
        expect(next).toContain('2026-11-15 evening: Guitar after dinner');
    });

    it('a pulse with the loop on: the lines whose hours are over stay; it answers every line from now on (keep, change, end, add); four at most in the day', async () => {
        const user = await person();
        const t = await thread(user.id, 'Guitar most evenings');
        await prisma.buddyDay.create({
            data: {
                userId: user.id,
                day: DAY,
                kind: 'night',
                lines: [kept('06:30', '08:00', 'One honest hour before work'), kept('13:00', '14:00', 'A walk after lunch, no screens', false), kept('18:30', '20:00', 'Guitar after dinner'), kept('22:30', '00:30', 'Lights out soon, it was a long day')] as unknown as object[],
                model: 'claude-opus-5-5',
                createdAt: at('04:30'),
            },
        });
        // Something new since the night: the fixed pulse after noon runs.
        await prisma.observation.create({ data: { userId: user.id, text: 'Has a call at four', kind: 'state', source: 'tell', day: DAY, createdAt: at('14:00') } });
        fake.push(pulseSays([tl('13:00', '13:30', 'Already over'), tl('15:00', '15:45', 'Stretch before the call'), tl('18:30', '20:00', 'Guitar after dinner', [t.id]), tl('21:00', '22:00', 'One too many')]));
        fake.push(lockByNumber([false, false]));
        expect(await pulseIfDue(user.id, at('14:30'))).toMatchObject({ ran: true, reason: 'lines from 14:30' });

        expect(JSON.stringify(fake.calls[0]!.system)).toContain('lines: every line from now on');
        expect(JSON.stringify(fake.calls[0]!.messages)).toContain(
            '<your_lines>\\n06:30-08:00 (over): One honest hour before work\\n13:00-14:00 (over): A walk after lunch, no screens\\n18:30-20:00: Guitar after dinner\\n22:30-00:30: Lights out soon, it was a long day\\n</your_lines>'
        );
        // The lock check reads only the lines it wrote.
        expect(JSON.stringify(fake.calls[1]!.messages)).toContain('<lines>\\n0: Stretch before the call\\n1: Guitar after dinner\\n</lines>');

        const pulse = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id, kind: 'pulse' } });
        const lines = pulse.lines as unknown as Line[];
        expect(lines.map((l) => [l.from, l.text, l.lockOk])).toEqual([
            ['06:30', 'One honest hour before work', true],
            ['13:00', 'A walk after lunch, no screens', false],
            ['15:00', 'Stretch before the call', true],
            ['18:30', 'Guitar after dinner', true],
        ]);
        expect(lines[3]!.about).toEqual([{ threadId: t.id, rev: t.revision }]);
        expect((pulse.dropped as unknown as Dropped[]).map((d) => `${d.what}: ${d.why}`)).toEqual(['line 13:00: its hours are over', 'line 21:00: more than four lines today']);
        // The night's 22:30 line was left out: it ended. The new one shows in its hours.
        expect(await currentLine(user.id, at('23:00'))).toBeNull();
        expect(await currentLine(user.id, at('15:10'))).toMatchObject({ text: 'Stretch before the call', until: at('15:45').toISOString() });
    });
});
