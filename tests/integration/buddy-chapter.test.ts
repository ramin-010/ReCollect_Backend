// The month's chapter and the audit (BUDDY_MEMORY_PLAN B7) on a fake Claude: the chapter saved (a
// number it was not given makes the plain one), a duplicate pair merged, a contradiction closed, his
// own memory untouched, at most two questions, the portrait rebuilt; "Still true?" answered.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { CHAPTER_SCHEMA, runMonth } from '../../src/services/buddy/chapter';
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
        await api(user).post('/api/buddy/questions', { memoryId: a.id, answer: 'yes' });
        expect((await prisma.memory.findUniqueOrThrow({ where: { id: a.id } })).byUser).toBe(true);
        expect(((await prisma.buddyChapter.findUniqueOrThrow({ where: { id: ch.id } })).questions as unknown[]).length).toBe(1);
    });

    it('a chapter with a number it was not given becomes the plain one', async () => {
        const { user } = await setup();
        fake.push(fakeMessage({ chapter: 'He logged 97 hours in November.', merge: [], close: [], questions: [], who: '', heading: '' }));
        await runMonth(user.id, AT);
        const ch = await prisma.buddyChapter.findUniqueOrThrow({ where: { userId_period: { userId: user.id, period: '2026-11' } } });
        expect(ch.text).toMatch(/^In 2026-11: \d+ hours logged over \d+ active days/);
    });
});
