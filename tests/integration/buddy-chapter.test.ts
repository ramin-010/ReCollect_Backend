// The month's chapter and the audit (BUDDY_MEMORY_PLAN B7) on a fake Claude: the chapter saved (a
// number it was not given makes the plain one), a duplicate pair merged, a contradiction closed, his
// own memory untouched, at most two questions, the portrait rebuilt; "Still true?" answered.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { CHAPTER_SCHEMA, YEAR_SCHEMA, runMonth, runYear, yearIfDue } from '../../src/services/buddy/chapter';
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

const day = (d: string) => new Date(`${d}T00:00:00Z`);
const AT = new Date(Date.UTC(2026, 11, 1, 0, 0)); // 1 Dec 2026, 05:30 in Kolkata

async function setup() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true });
    const mk = (text: string, extra: Record<string, unknown> = {}) =>
        prisma.memory.create({ data: { userId: user.id, text, kind: 'preference', lasting: true, source: 'buddy', firstSeenDay: day('2026-11-02'), lastSeenDay: day('2026-11-20'), ...extra } });
    return { user, a: await mk('Likes short replies'), b: await mk('Prefers replies that are short'), old: await mk('Studies before work'), mine: await mk('Never on Sundays', { byUser: true }) };
}

describe('the month', () => {
    it('writes the chapter, merges a duplicate pair, closes a contradiction, never his own; questions and the rebuilt portrait', async () => {
        const { user, a, b, old, mine } = await setup();
        fake.push(
            fakeMessage({
                chapter: 'November was the month he built his buddy, mostly at night, and kept his reviews going.',
                merge: [{ ids: [a.id, b.id], text: 'Likes short replies', kind: 'preference' }],
                close: [{ id: old.id, reason: 'He studies after work now' }, { id: mine.id, reason: 'try his own' }],
                questions: [{ id: a.id, question: 'Still true? Short replies' }, { id: mine.id, question: 'his own' }, { id: old.id, question: 'third' }],
                who: 'A backend engineer who builds at night.',
                heading: 'A backend offer by May.',
            })
        );
        const r = await runMonth(user.id, AT);
        expect(fake.calls[0]!.output_config?.format?.schema).toBe(CHAPTER_SCHEMA);
        expect(r).toMatchObject({ period: '2026-11', ops: 2 });
        const ch = await prisma.buddyChapter.findUniqueOrThrow({ where: { userId_period: { userId: user.id, period: '2026-11' } } });
        expect(ch.text).toContain('November was the month');
        const status = async (id: string) => (await prisma.memory.findUniqueOrThrow({ where: { id } })).status;
        expect([await status(a.id), await status(b.id), await status(old.id), await status(mine.id)]).toEqual(['closed', 'closed', 'closed', 'active']);
        expect(await prisma.memory.count({ where: { userId: user.id, status: 'active', text: 'Likes short replies' } })).toBe(1);
        // His own memory is never asked about; at most two questions.
        expect((ch.questions as Array<{ memoryId: string }>).map((q) => q.memoryId)).toEqual([a.id, old.id]);
        expect(await prisma.buddyState.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({ who: 'A backend engineer who builds at night.', heading: 'A backend offer by May.' });

        // /you shows the chapter; his "yes" makes the memory his, and the question goes.
        const you = (await api(user).get('/api/buddy/you')).body.data;
        expect(you.chapters[0]).toMatchObject({ period: '2026-11' });
        // Agents find a month by its name (recall_memory).
        const { asAgent, createTestToken } = await import('../helpers/agent');
        const chat = asAgent((await createTestToken(user)).token);
        expect((await chat.get('/api/buddy/chapters?q=november')).body.data).toEqual([{ period: '2026-11', text: expect.stringContaining('November was the month') }]);
        expect((await chat.get('/api/buddy/chapters?q=march')).body.data).toEqual([]);
        await api(user).post('/api/buddy/questions', { memoryId: a.id, answer: 'yes' });
        expect((await prisma.memory.findUniqueOrThrow({ where: { id: a.id } })).byUser).toBe(true);
        expect(((await prisma.buddyChapter.findUniqueOrThrow({ where: { id: ch.id } })).questions as unknown[]).length).toBe(1);
    });

    it("January: the year's chapter from its months, after December's; a number it was not given makes the plain one", async () => {
        const { user } = await setup();
        const facts = (month: string, minutes: number) => ({ month, minutes: { study: minutes }, activeDays: 10, sessions: 12, topProjects: [], reviewsDone: 20, tasksDone: 4, memoriesAdded: 3, memoriesClosed: 0, notes: 9 });
        for (const [period, m] of [['2026-11', 600], ['2026-12', 900]] as const) {
            await prisma.buddyChapter.create({ data: { userId: user.id, period, text: `${period}: he built his buddy and kept his reviews going.`, facts: facts(period, m), questions: [], model: 'test', costUsd: 0 } });
        }
        const JAN = new Date(Date.UTC(2027, 0, 2, 0, 0)); // 2 Jan 2027, 05:30 in Kolkata
        fake.push(fakeMessage({ chapter: 'The year he built his buddy and kept his reviews going, mostly at night.' }));
        expect(await yearIfDue(user.id, JAN)).toBe(true);
        expect(fake.calls[0]!.output_config?.format?.schema).toBe(YEAR_SCHEMA);
        expect(JSON.stringify(fake.calls[0]!.messages)).toContain('2026-12: he built his buddy');
        const year = await prisma.buddyChapter.findUniqueOrThrow({ where: { userId_period: { userId: user.id, period: '2026' } } });
        expect(year.text).toBe('The year he built his buddy and kept his reviews going, mostly at night.');
        expect(year.facts).toMatchObject({ year: '2026', months: 2, minutes: { study: 1500 }, activeDays: 20, reviewsDone: 40 });
        // Once: it is written now. And a number it was not given makes the plain year.
        expect(await yearIfDue(user.id, JAN)).toBe(false);
        fake.push(fakeMessage({ chapter: 'He logged 777 hours in 2026.' }));
        await runYear(user.id, JAN, '2026');
        expect((await prisma.buddyChapter.findUniqueOrThrow({ where: { userId_period: { userId: user.id, period: '2026' } } })).text).toBe('In 2026: 25 hours logged over 20 active days in 2 months, 40 reviews and 8 tasks done.');
    });

    it('a chapter with a number it was not given becomes the plain one', async () => {
        const { user } = await setup();
        fake.push(fakeMessage({ chapter: 'He logged 97 hours in November.', merge: [], close: [], questions: [], who: '', heading: '' }));
        await runMonth(user.id, AT);
        const ch = await prisma.buddyChapter.findUniqueOrThrow({ where: { userId_period: { userId: user.id, period: '2026-11' } } });
        expect(ch.text).toMatch(/^In 2026-11: \d+ hours logged over \d+ active days/);
    });
});
