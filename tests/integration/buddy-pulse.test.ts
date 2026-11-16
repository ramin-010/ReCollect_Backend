// The pulses (BUDDY_MEMORY_PLAN B4): at 12:00 and 18:00 his time, only when something new arrived;
// the hours gone keep the night's lines; the hours to come may go silent; the note and the home
// screen's thought carry over; nothing new means no model call.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { PULSE_SCHEMA, pulseIfDue } from '../../src/services/buddy/pulse';
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

// Mon 16 Nov 2026 in Kolkata: 13:00 and 18:30.
const NOON = new Date(Date.UTC(2026, 10, 16, 7, 30));
const EVENING = new Date(Date.UTC(2026, 10, 16, 13, 0));
const line = (slot: string, text: string) => ({ slot, text, form: 'plain', lockOk: true, sourceId: null });

describe('the pulses', () => {
    it('nothing new: no call; something new at 13:00: the lines to come are rewritten, the morning kept, the note carried; once per pulse', async () => {
        const user = await createTestUser();
        await api(user).patch('/api/buddy/settings', { enabled: true });
        const night = await prisma.buddyDay.create({
            data: {
                userId: user.id,
                day: new Date('2026-11-16T00:00:00Z'),
                kind: 'night',
                lines: [line('morning', 'Start with the reviews'), line('afternoon', 'One mock problem after lunch'), line('evening', 'Stop before midnight')],
                note: 'A note from the night.',
                followUp: 'How did the mock go?',
                model: 'claude-opus-5-5',
                createdAt: new Date(Date.UTC(2026, 10, 15, 23, 0)),
            },
        });
        expect(await pulseIfDue(user.id, new Date(Date.UTC(2026, 10, 16, 5, 0)))).toMatchObject({ ran: false, reason: 'not yet noon' });
        expect(await pulseIfDue(user.id, NOON)).toMatchObject({ ran: false, reason: 'nothing new' });
        expect(fake.calls).toHaveLength(0);

        await prisma.observation.create({ data: { userId: user.id, text: 'The mock interview moved to tomorrow', kind: 'thread', source: 'tell', day: new Date('2026-11-16T00:00:00Z'), createdAt: new Date(Date.UTC(2026, 10, 16, 7, 0)) } });
        fake.push(fakeMessage({ lines: [{ slot: 'afternoon', text: 'The mock moved: use the hour for one sliding-window problem', form: 'push', lockOk: true, sourceId: '' }, { slot: 'evening', text: 'Stop before midnight', form: 'push', lockOk: true, sourceId: '' }], note: '' }, { model: 'claude-sonnet-5-5' }));
        const r = await pulseIfDue(user.id, NOON);
        expect(r).toMatchObject({ ran: true });
        expect(fake.calls[0]!.output_config?.format?.schema).toBe(PULSE_SCHEMA);
        const pulse = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id, kind: 'pulse' } });
        const lines = pulse.lines as Array<{ slot: string; text: string }>;
        expect(lines.map((l) => l.text)).toEqual(['Start with the reviews', 'The mock moved: use the hour for one sliding-window problem', 'Stop before midnight']);
        expect(pulse).toMatchObject({ note: 'A note from the night.', followUp: 'How did the mock go?' });
        expect(await pulseIfDue(user.id, new Date(NOON.getTime() + 3600_000))).toMatchObject({ ran: false, reason: 'already pulsed' });
        expect(night.id).toBeTruthy();
        // The evening pulse needs something new again.
        expect(await pulseIfDue(user.id, EVENING)).toMatchObject({ ran: false, reason: 'nothing new' });
    });

    it("a pulse may leave the hours to come silent and write a new thought for the home screen (lock-checked); without one the last carries over", async () => {
        const user = await createTestUser();
        await api(user).patch('/api/buddy/settings', { enabled: true });
        await prisma.buddyDay.create({
            data: {
                userId: user.id,
                day: new Date('2026-11-16T00:00:00Z'),
                kind: 'night',
                lines: [line('morning', 'Start with the reviews'), line('afternoon', 'One mock problem after lunch'), line('evening', 'Stop before midnight')],
                insight: 'Mornings are your best hours this week',
                insightLockOk: true,
                model: 'claude-opus-5-5',
                createdAt: new Date(Date.UTC(2026, 10, 15, 23, 0)),
            },
        });
        await prisma.observation.create({ data: { userId: user.id, text: 'Feeling spent after the long meeting', kind: 'state', source: 'tell', day: new Date('2026-11-16T00:00:00Z'), createdAt: new Date(Date.UTC(2026, 10, 16, 7, 0)) } });
        const thought = 'A slow afternoon is fine: one easy review is enough today';
        fake.push(
            fakeMessage({ lines: [{ slot: 'afternoon', text: '', form: 'plain', lockOk: true, sourceId: '' }, { slot: 'evening', text: '', form: 'plain', lockOk: true, sourceId: '' }], note: '', insight: thought }, { model: 'claude-sonnet-5-5' }),
            fakeMessage({ lines: [], note: false, insight: false }, { model: 'claude-sonnet-5-5' })
        );
        expect(await pulseIfDue(user.id, NOON)).toMatchObject({ ran: true, reason: 'afternoon and evening and a new thought' });
        expect(JSON.stringify(fake.calls[1]!.messages)).toContain(`<home>\\n${thought}`);
        const pulse = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id, kind: 'pulse' } });
        expect((pulse.lines as Array<{ slot: string }>).map((l) => l.slot)).toEqual(['morning']);
        expect(pulse).toMatchObject({ insight: thought, insightLockOk: true });

        // The evening pulse writes no thought: the afternoon's carries over with its verdict.
        await prisma.observation.create({ data: { userId: user.id, text: 'Took a long walk, feeling better', kind: 'state', source: 'tell', day: new Date('2026-11-16T00:00:00Z'), createdAt: new Date(Date.UTC(2026, 10, 16, 12, 40)) } });
        fake.push(fakeMessage({ lines: [{ slot: 'evening', text: 'Lights out by eleven', form: 'push', lockOk: true, sourceId: '' }], note: '', insight: '' }, { model: 'claude-sonnet-5-5' }));
        expect(await pulseIfDue(user.id, EVENING)).toMatchObject({ ran: true, reason: 'evening' });
        const last = await prisma.buddyDay.findFirstOrThrow({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
        expect(last).toMatchObject({ insight: thought, insightLockOk: true });
        expect((last.lines as Array<{ slot: string }>).map((l) => l.slot)).toEqual(['morning', 'evening']);
    });

    it('no night today: no pulse', async () => {
        const user = await createTestUser();
        await api(user).patch('/api/buddy/settings', { enabled: true });
        expect(await pulseIfDue(user.id, NOON)).toMatchObject({ ran: false, reason: 'no night today' });
    });
});
