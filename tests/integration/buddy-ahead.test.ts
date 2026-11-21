// ECOSYSTEM_V2_PLAN stage 17: Buddy brings it up while there is still time. The night (and the pulses) see what they
// left off this week and their dated to-dos ahead, with ids; a line, the thought or the note may rest on one (a ref); a
// ref that closes takes the words off at once with no pulse (the task ticked, the problem solved, a study session
// started since the line's hours began, a Later on it); never two days running about the same left-off item; refs are
// kept only for ids the step was shown. Code only (a scripted model); the judgement is measured by J14 and J15.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { nightIfDue } from '../../src/services/buddy/worker';
import { currentInsight, currentLine } from '../../src/services/buddy/voice';
import { buddySignals, usualStart } from '../../src/services/buddy/signals';
import { aheadBlocks } from '../../src/services/buddy/aheadBlocks';
import type { Dropped, Line } from '../../src/services/buddy/think';
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

/** Their clock (Kolkata) in November 2026 (Wed 18). */
const at = (hhmm: string, day = '18') => new Date(`2026-11-${day}T${hhmm}:00+05:30`);
const dbDay = (d: string) => new Date(`${d}T00:00:00Z`);

async function person() {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { timezone: 'Asia/Kolkata' } });
    await api(user).patch('/api/buddy/settings', { enabled: true, loop: true });
    // Six evenings of study at about 20:45 (their usual start), and Tuesday's 3Sum left unsolved.
    for (const [i, d] of ['11', '12', '13', '16', '17'].entries()) {
        await prisma.workSession.create({ data: { userId: user.id, key: `s_ev${i}`, kind: 'study', day: dbDay(`2026-11-${d}`), startedAt: at(`20:${40 + i}`, d), endedAt: at('21:30', d), minutes: 45, title: 'Evening study', source: 'agent' } });
    }
    const sum = await prisma.workSession.create({
        data: { userId: user.id, key: 's_3sum:1', kind: 'practice', day: dbDay('2026-11-17'), startedAt: at('21:00', '17'), endedAt: at('21:40', '17'), minutes: 40, title: '3Sum', problem: '3Sum', nextStep: 'has the two-pointer idea; duplicates still break it', source: 'agent', updatedAt: at('21:40', '17') },
    });
    const gift = await prisma.todo.create({ data: { userId: user.id, title: 'Get a gift for my sister', dueDate: at('18:00', '22'), status: 'pending' } });
    return { user, sum, gift };
}

const nightSays = (over: Record<string, unknown>) =>
    fakeMessage({
        memory: [],
        who: '',
        heading: '',
        now: 'A steady week.',
        lines: [],
        insight: '',
        note: '',
        followUp: '',
        suggestions: [],
        notebook: 'Watching: 3Sum.',
        weekly: { use: false, strong: '', slipping: '', fix: '', deadline: '', focus: [] },
        insightAbout: [],
        noteAbout: [],
        asks: [],
        reminders: [],
        threadOps: [],
        ...over,
    });
const lockOk = (n: number) => fakeMessage({ lines: Array.from({ length: n }, (_, i) => ({ i, reveals: false })), note: false, insight: false }, { model: 'claude-sonnet-5-5' });
const tl = (from: string, until: string, text: string, about: string[] = []) => ({ from, until, text, form: 'push', lockOk: true, sourceId: '', about });

describe('what is ahead, for the night (stage 17)', () => {
    it('the night sees <left_off> and <coming_up> with ids, and when they usually start; a line rests on what it names', async () => {
        const { user, sum, gift } = await person();
        const usual = (await buddySignals(user.id, at('05:00'))).usual;
        expect(usual.weekdayEvening).toMatch(/^20:4\d$/);
        expect(usualStart([1260, 1250])).toBeNull();
        const blocks = await aheadBlocks(user.id, at('05:00'), 'Asia/Kolkata');
        expect(blocks.text).toContain(`<left_off>\npu_${sum.id} · practice · "3Sum" · left Tue 17 Nov · where they stopped: has the two-pointer idea; duplicates still break it\n</left_off>`);
        expect(blocks.text).toContain(`tk_${gift.id} · "Get a gift for my sister" · due Sun 22 Nov`);
        expect([...blocks.refs].sort()).toEqual([`pu_${sum.id}`, `tk_${gift.id}`].sort());

        fake.push(
            nightSays({
                lines: [tl('20:30', '22:00', '3Sum: you had the two-pointer idea, only the duplicates left. Finish it tonight?', [`pu_${sum.id}`, 'pu_not_shown'])],
                insight: 'Sunday is your sister’s birthday: the gift is easier to sort out today than on Saturday.',
                insightAbout: [`tk_${gift.id}`],
            })
        );
        fake.push(lockOk(1));
        await nightIfDue(user.id, at('05:00'));
        const night = fake.calls[0]!;
        const said = JSON.stringify(night.messages);
        expect(said).toContain('<left_off>');
        expect(said).toContain('<coming_up>');
        expect(JSON.stringify(night.system)).toContain('left_off (when given)');
        const row = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id, day: dbDay('2026-11-18') } });
        const lines = row.lines as unknown as Line[];
        // Refs only for what the step was shown; the number in "3Sum" passed the guard (it was given).
        expect(lines.map((l) => [l.from, l.refs])).toEqual([['20:30', [`pu_${sum.id}`]]]);
        expect(row.insightAbout).toEqual([{ ref: `tk_${gift.id}` }]);

        // True when shown: the line shows in its hours while 3Sum is still left off.
        expect(await currentLine(user.id, at('20:35'))).toMatchObject({ text: expect.stringMatching(/^3Sum/) });
        expect(await currentInsight(user.id, at('09:00'))).toMatchObject({ text: expect.stringMatching(/gift/) });
        // A study session started since the line's hours began: they are on something; the nudge goes, no pulse.
        await prisma.workSession.create({ data: { userId: user.id, key: 's_now', kind: 'study', day: dbDay('2026-11-18'), startedAt: at('20:40'), minutes: 5, title: 'Heaps', source: 'agent', updatedAt: at('20:40') } });
        expect(await currentLine(user.id, at('20:50'))).toBeNull();
        // The gift ticked: the thought goes; un-ticked, it is back.
        await prisma.todo.update({ where: { id: gift.id }, data: { status: 'complete', completedAt: at('10:00') } });
        expect(await currentInsight(user.id, at('10:05'))).toBeNull();
        await prisma.todo.update({ where: { id: gift.id }, data: { status: 'pending', completedAt: null } });
        expect(await currentInsight(user.id, at('10:10'))).not.toBeNull();
        // A Later on it hides the words until its time (stage 19's row).
        await prisma.buddyReminder.create({ data: { userId: user.id, text: 'Get a gift for my sister', at: at('19:30'), refKind: 'tk', refId: gift.id, origin: 'later' } });
        expect(await currentInsight(user.id, at('10:15'))).toBeNull();
    });

    it('the problem solved takes the line off; never two days running about the same left-off item', async () => {
        const { user, sum } = await person();
        // Yesterday's night already raised 3Sum.
        await prisma.buddyDay.create({ data: { userId: user.id, day: dbDay('2026-11-18'), kind: 'night', lines: [{ slot: 'evening', from: '20:30', until: '22:00', text: '3Sum tonight?', form: 'push', lockOk: true, sourceId: null, refs: [`pu_${sum.id}`] }], model: 'claude-opus-5-5', createdAt: at('05:00') } });
        fake.push(nightSays({ lines: [tl('20:30', '22:00', '3Sum: only the duplicates left. Finish it tonight?', [`pu_${sum.id}`]), tl('07:00', '08:00', 'One review before work')] }));
        fake.push(lockOk(2));
        await nightIfDue(user.id, at('05:00', '19'));
        const row = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id, day: dbDay('2026-11-19') } });
        expect((row.lines as unknown as Line[]).map((l) => l.text)).toEqual(['One review before work']);
        expect((row.dropped as unknown as Dropped[]).map((d) => d.why)).toContain('two days running about a left-off item');

        // A line resting on it, the problem then solved in a later session: the words go at once.
        await prisma.buddyDay.update({ where: { id: row.id }, data: { lines: [{ slot: 'evening', from: '20:30', until: '22:00', text: '3Sum: finish it tonight?', form: 'push', lockOk: true, sourceId: null, refs: [`pu_${sum.id}`] }] } });
        expect(await currentLine(user.id, at('20:31', '19'))).not.toBeNull();
        await prisma.workSession.update({ where: { id: sum.id }, data: { outcome: 'alone' } });
        expect(await currentLine(user.id, at('20:32', '19'))).toBeNull();
    });
});
