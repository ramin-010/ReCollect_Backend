// The night step (BUDDY_MEMORY_PLAN B3) on a fake Claude: ops checked then applied (his own memories
// untouchable), notes folded, the portrait and notebook kept, the lines guarded (a number it wasn't
// given, a repeat, too long → silence), the home screen's thought, the lock check failing closed, the picked items shown,
// the note reaching the brief and the hooks; once a day after 04:00; working memories fade by rule.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { NIGHT_SCHEMA, LOCK_SCHEMA, fadeMemories, guardInsight, guardLines, tooClose } from '../../src/services/buddy/think';
import { nightIfDue } from '../../src/services/buddy/worker';
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

const empty = { id: '', ids: [], kind: '', lasting: false, text: '', private: false, tags: [], from: [], reason: '' };
const night = (over: Record<string, unknown> = {}) => ({
    memory: [],
    who: '',
    heading: '',
    now: 'A week of building the buddy late at night.',
    lines: [
        { slot: 'morning', text: 'Start with the reviews, then build', form: 'push', lockOk: true, sourceId: '' },
        { slot: 'afternoon', text: 'You said the mock interview scares you a bit: pick a day?', form: 'question', lockOk: true, sourceId: '' },
        { slot: 'evening', text: 'Stop before midnight tonight', form: 'push', lockOk: true, sourceId: '' },
    ],
    note: 'You built the whole stage in one night. Sleep before the next one.',
    followUp: 'How did the mock interview plan go?',
    suggestions: [],
    notebook: 'Watching: late nights. Said: start with the reviews.',
    weekly: { use: false, strong: '', slipping: '', fix: '', deadline: '', focus: [] },
    ...over,
});
// 05:00 in Kolkata on Mon 16 Nov 2026.
const AT = new Date(Date.UTC(2026, 10, 15, 23, 30));

async function setup() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true });
    const chat = asAgent((await createTestToken(user)).token, 'chat');
    return { user, chat };
}

describe('the night step', () => {
    it('applies checked ops, folds notes, keeps the portrait and notebook, shows the picked item; the note reaches the brief and the hooks', async () => {
        const { user, chat } = await setup();
        const mine = (await api(user).post('/api/buddy/memories', { text: 'Never schedule Sunday mornings', kind: 'preference' })).body.data;
        const theirs = (await chat.post('/api/buddy/remember', { text: 'Likes long answers', kind: 'preference' })).body.data.notes[0].memory;
        const note = await prisma.observation.create({ data: { userId: user.id, text: 'Scared of the mock interview', kind: 'state', sensitivity: 'private', source: 'hook', day: new Date('2026-11-16T00:00:00Z') } });
        const item = await prisma.suggestion.create({ data: { userId: user.id, kind: 'task', text: 'Send the form', payload: { title: 'Send the form' }, proposedBy: 'buddy', status: 'candidate' } });
        fake.push(
            fakeMessage(
                night({
                    memory: [
                        { ...empty, op: 'add', kind: 'state', text: 'Nervous about his first mock interview', private: true, from: [note.id] },
                        { ...empty, op: 'close', id: mine._id, reason: 'try to close his own' },
                        { ...empty, op: 'update', id: theirs._id, text: 'Likes short answers, bottom line first' },
                        { ...empty, op: 'seen', id: 'not-a-memory' },
                    ],
                    who: 'A backend engineer who builds at night.',
                    heading: 'A backend offer by May.',
                    suggestions: [item.id, 'unknown-id'],
                })
            ),
            fakeMessage({ lines: [{ slot: 'morning', reveals: false }, { slot: 'afternoon', reveals: true }, { slot: 'evening', reveals: false }] }, { model: 'claude-haiku-5-5' })
        );
        const r = (await nightIfDue(user.id, AT))!;
        expect(fake.calls.map((c) => c.output_config?.format?.schema)).toEqual([NIGHT_SCHEMA, LOCK_SCHEMA]);
        expect(r.ops).toBe(2);
        expect(r.dropped.map((d) => d.why).sort()).toEqual(['close: their own memory', 'names a private thing', 'seen: no such memory']);
        expect((await prisma.memory.findUniqueOrThrow({ where: { id: mine._id } })).status).toBe('active');
        expect((await prisma.memory.findUniqueOrThrow({ where: { id: theirs._id } })).text).toBe('Likes short answers, bottom line first');
        const added = await prisma.memory.findFirstOrThrow({ where: { userId: user.id, source: 'buddy' } });
        expect(added).toMatchObject({ kind: 'state', sensitivity: 'private', lasting: false });
        expect(await prisma.observation.findUniqueOrThrow({ where: { id: note.id } })).toMatchObject({ memoryId: added.id, foldedAt: expect.any(Date) });
        expect((await prisma.suggestion.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('pending');
        // The afternoon line names the worry: kept for Home, off the lock screen.
        expect(r.lines.map((l) => [l.slot, l.lockOk])).toEqual([['morning', true], ['afternoon', false], ['evening', true]]);
        const state = await prisma.buddyState.findUniqueOrThrow({ where: { userId: user.id } });
        expect(state).toMatchObject({ who: 'A backend engineer who builds at night.', heading: 'A backend offer by May.', notebook: 'Watching: late nights. Said: start with the reviews.' });

        // Once a day: a second pass the same day does nothing.
        expect(await nightIfDue(user.id, new Date(AT.getTime() + 3600_000))).toBeNull();
        expect((await api(user).get('/api/buddy/you')).body.data.counts.pending).toBe(0);
    });

    it('his button thinks now (any hour); the note and follow-up reach the brief and the hooks', async () => {
        const { user, chat } = await setup();
        fake.push(fakeMessage(night({ who: 'A backend engineer who builds at night.' })));
        const res = await api(user).post('/api/buddy/think');
        expect(res.status).toBe(200);
        expect((await api(user).get('/api/buddy/today')).body.data.day).toMatchObject({ note: 'You built the whole stage in one night. Sleep before the next one.' });
        const brief = (await chat.get('/api/brief')).body.data.buddy;
        expect(brief).toMatchObject({ who: 'A backend engineer who builds at night.', note: 'You built the whole stage in one night. Sleep before the next one.', followUp: 'How did the mock interview plan go?' });
        const hookNote = (await chat.get('/api/buddy/note')).body.data;
        expect(hookNote).toMatchObject({ kind: 'note', text: 'You built the whole stage in one night. Sleep before the next one.' });
        expect((await chat.get(`/api/buddy/note?after=${encodeURIComponent(hookNote.id)}`)).body.data).toMatchObject({ kind: 'followUp' });
        await api(user).patch('/api/buddy/settings', { paused: true });
        expect((await api(user).post('/api/buddy/think')).status).toBe(409);
    });

    it('a thread quiet for over five weeks reaches the night once more, to ask about it before it fades', async () => {
        const { user } = await setup();
        const thread = (text: string, last: string) =>
            prisma.memory.create({ data: { userId: user.id, text, kind: 'thread', lasting: false, source: 'buddy', firstSeenDay: new Date('2026-09-01T00:00:00Z'), lastSeenDay: new Date(`${last}T00:00:00Z`) } });
        const quiet = await thread('Planning a talk at the Pune meetup', '2026-10-07'); // 40 days before 16 Nov
        const fresh = await thread('Moving the blog to Astro', '2026-10-27'); // 20 days
        fake.push(fakeMessage(night()));
        await nightIfDue(user.id, AT);
        const asked = JSON.stringify(fake.calls[0]!.messages);
        expect(asked).toContain('<quiet_threads>');
        expect(asked).toContain(`${quiet.id} · quiet since 2026-10-07`);
        expect(asked).not.toContain(`${fresh.id} · quiet since`);
        expect((await prisma.memory.findUniqueOrThrow({ where: { id: quiet.id } })).status).toBe('active'); // it fades at 45 days, not yet
    });

    it('not before 04:00, not when off; a failed lock check keeps every line off the lock screen; a broken answer leaves the plain line', async () => {
        const { user } = await setup();
        expect(await nightIfDue(user.id, new Date(Date.UTC(2026, 10, 15, 21, 0)))).toBeNull(); // 02:30 his time
        await prisma.memory.create({ data: { userId: user.id, text: 'Money is tight this month', kind: 'state', sensitivity: 'private', lasting: false, source: 'agent', firstSeenDay: new Date('2026-11-16T00:00:00Z'), lastSeenDay: new Date('2026-11-16T00:00:00Z') } });
        fake.push(fakeMessage(night()), new Error('check down'));
        const r = (await nightIfDue(user.id, AT))!;
        expect(r.lines.every((l) => !l.lockOk)).toBe(true);

        // A broken answer: the step fails, nothing is written, it may try again on the next pass.
        fake.push(fakeMessage('not json at all'));
        await expect(nightIfDue(user.id, new Date(Date.UTC(2026, 10, 16, 23, 30)))).rejects.toThrow();
        expect(await prisma.buddyDay.count({ where: { userId: user.id } })).toBe(1);
        await api(user).patch('/api/buddy/settings', { enabled: false });
        expect(await nightIfDue(user.id, new Date(Date.UTC(2026, 10, 17, 23, 30)))).toBeNull();
    });

    it('the guards: a number it was not given, a line said lately, too long → silence (never a forced line); a silent slot stays silent', () => {
        const lines = [
            { slot: 'morning' as const, text: 'You did 7 hours yesterday', form: 'observation' as const, lockOk: true, sourceId: '' },
            { slot: 'afternoon' as const, text: 'Start with the reviews, then build', form: 'push' as const, lockOk: true, sourceId: '' },
            { slot: 'evening' as const, text: 'x'.repeat(95), form: 'plain' as const, lockOk: true, sourceId: '' },
        ];
        const g = guardLines(lines, { sources: '{"minutes":120}', recent: ['Start with your reviews, then build'] });
        expect(g.lines).toEqual([]);
        expect(g.dropped.map((d) => d.why)).toEqual(['a number it was not given', 'said lately', 'too long']);
        // Silence by choice ("" or a slot left out) is not a failure: nothing dropped, nothing put in its place.
        const quiet = guardLines([{ slot: 'morning', text: 'Graphs first today', form: 'push', lockOk: true, sourceId: '' }, { slot: 'evening', text: '  ', form: 'plain', lockOk: true, sourceId: '' }], { sources: '', recent: [] });
        expect(quiet.lines.map((l) => [l.slot, l.text])).toEqual([['morning', 'Graphs first today']]);
        expect(quiet.dropped).toEqual([]);
        // The home screen's thought: its own length, never a line's words, nothing it said lately.
        const dropped: Array<{ what: string; why: string }> = [];
        const ctx = { sources: '', recent: ['Quiet days: one easy review gets you moving'], lines: quiet.lines };
        expect(guardInsight('Your sharpest hours are before noon, so keep the hard topic there', ctx, dropped)).toBe('Your sharpest hours are before noon, so keep the hard topic there');
        expect(guardInsight('  ', ctx, dropped)).toBeNull();
        expect(guardInsight('y'.repeat(101), ctx, dropped)).toBeNull();
        expect(guardInsight('Graphs first today!', ctx, dropped)).toBeNull();
        expect(guardInsight('Quiet days: one easy review gets you moving', ctx, dropped)).toBeNull();
        expect(guardInsight('Keep it to 3 problems', ctx, dropped)).toBeNull();
        expect(dropped.map((d) => d.why)).toEqual(['too long', 'a line says it', 'said lately', 'a number it was not given']);
        expect(tooClose('Pick a day for the mock interview', 'Pick a day for your mock interview?')).toBe(true);
        expect(tooClose('Pick a day for the mock interview', 'Sleep before midnight')).toBe(false);
    });

    it('fading: quiet states after 14 days, threads after 45, never lasting, pinned or his own', async () => {
        const user = await createTestUser();
        const day = (d: string) => new Date(`${d}T00:00:00Z`);
        const mk = (text: string, kind: 'state' | 'thread' | 'fact', last: string, extra: Record<string, unknown> = {}) =>
            prisma.memory.create({ data: { userId: user.id, text, kind, lasting: kind === 'fact', source: 'agent', firstSeenDay: day(last), lastSeenDay: day(last), ...extra } });
        const old = await mk('Tired this week', 'state', '2026-10-20');
        const fresh = await mk('Excited about the buddy', 'state', '2026-11-10');
        const thread = await mk('Promised to fix LinkedIn', 'thread', '2026-09-01');
        const pinned = await mk('Worried about money', 'state', '2026-09-01', { pinned: true });
        const fact = await mk('Lives in India', 'fact', '2025-01-01');
        expect(await fadeMemories(user.id, '2026-11-16' as never)).toBe(2);
        const status = async (id: string) => (await prisma.memory.findUniqueOrThrow({ where: { id } })).status;
        expect([await status(old.id), await status(fresh.id), await status(thread.id), await status(pinned.id), await status(fact.id)]).toEqual(['faded', 'active', 'faded', 'active', 'active']);
    });
});
