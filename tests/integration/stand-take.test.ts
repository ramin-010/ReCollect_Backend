// The buddy's take on Where you stand (WHERE_YOU_STAND_PLAN §9): asked on the page, one a day per window, kept that
// day only; the buddy's gate decides; a take with a number the record doesn't hold is written again once. On a
// scripted model: no real call is made.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { today as todayIn, addDays } from '../../src/services/learning';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
import { api, createSubjectRow, d } from '../helpers/learning';
import { asAgent, createTestToken } from '../helpers/agent';

const claude = new FakeClaude();
beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    setAiClientForTests(claude);
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = '';
    setAiClientForTests(null);
});
beforeEach(() => claude.reset());

async function buddyUser() {
    const user = await createTestUser();
    await api(user).patch('/api/buddy/settings', { enabled: true });
    const chat = asAgent((await createTestToken(user)).token);
    await chat.put('/api/sessions/by-key/s_t1', { kind: 'build', title: 'The API', minutes: 40 });
    return { user, chat };
}

const take = (text: string) => fakeMessage({ text }, { model: 'claude-sonnet-5-5' });

describe('the buddy’s take on Where you stand', () => {
    it('writes a take on asking, keeps it for the day (no second call), and counts it as the buddy’s spend', async () => {
        const { user } = await buddyUser();
        const before = (await api(user).get('/api/mirror/stand/takes')).body.data;
        expect(before).toEqual({ takes: {}, ask: 'ok', name: null });

        claude.push(take('40 min of build today, and that is the whole record so far. A real start: keep the evening slot.'));
        const res = await api(user).post('/api/mirror/stand/takes', { window: 'week' });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ window: 'week', text: '40 min of build today, and that is the whole record so far. A real start: keep the evening slot.' });
        expect(claude.calls).toHaveLength(1);
        // The buddy speaking: its character first, then the job; the record in the message.
        const system = claude.calls[0]!.system as Array<{ text: string }>;
        expect(system[0]!.text).toContain('buddy');
        expect(system[0]!.text).toContain('Where you stand');
        expect(JSON.stringify(claude.calls[0]!.messages)).toContain('40 min');
        const usage = await prisma.aiUsage.findMany({ where: { userId: user.id } });
        expect(usage.map((u) => u.feature)).toEqual(['buddy_pulse']);

        // Asked again the same day: today's take, no new call.
        const again = await api(user).post('/api/mirror/stand/takes', { window: 'week' });
        expect(again.body.data.text).toBe(res.body.data.text);
        expect(claude.calls).toHaveLength(1);
        const after = (await api(user).get('/api/mirror/stand/takes')).body.data;
        expect(Object.keys(after.takes)).toEqual(['week']);
        expect(after.takes.week.text).toBe(res.body.data.text);
    });

    it('writes a take again once when it used a number the record doesn’t hold; a second miss stores nothing', async () => {
        const { user } = await buddyUser();
        claude.push(take('Almost 47 minutes of build today, a good first push.'), take('40 min of build today: a good first push for the record.'));
        const res = await api(user).post('/api/mirror/stand/takes', { window: 'month' });
        expect(res.status).toBe(200);
        expect(res.body.data.text).toBe('40 min of build today: a good first push for the record.');
        expect(claude.calls).toHaveLength(2);
        expect(JSON.stringify(claude.calls[1]!.messages)).toContain("numbers the record doesn't hold (47)");

        claude.push(take('You logged 99 minutes, nice.'), take('You logged 98 minutes, nice.'));
        const miss = await api(user).post('/api/mirror/stand/takes', { window: 'year' });
        expect(miss.status).toBe(502);
        expect(await prisma.standTake.count({ where: { userId: user.id, window: 'year' } })).toBe(0);
    });

    it('lasts its day: an earlier day’s take doesn’t show and is deleted at the next ask', async () => {
        const { user } = await buddyUser();
        const today = todayIn('Asia/Kolkata');
        await prisma.standTake.create({ data: { userId: user.id, day: d(addDays(today, -1)), window: 'week', text: 'Yesterday’s take.', model: 'claude-sonnet-5-5' } });
        expect((await api(user).get('/api/mirror/stand/takes')).body.data.takes).toEqual({});
        claude.push(take('40 min of build today, the first day of the record.'));
        await api(user).post('/api/mirror/stand/takes', { window: 'week' });
        const rows = await prisma.standTake.findMany({ where: { userId: user.id } });
        expect(rows.map((r) => r.text)).toEqual(['40 min of build today, the first day of the record.']);
    });

    it('follows the buddy’s gate, takes only a window, and is the app’s only', async () => {
        const user = await createTestUser();
        await prisma.buddyState.upsert({ where: { userId: user.id }, create: { userId: user.id, enabled: false }, update: { enabled: false } });
        expect((await api(user).get('/api/mirror/stand/takes')).body.data.ask).toBe('off');
        const off = await api(user).post('/api/mirror/stand/takes', { window: 'week' });
        expect(off.status).toBe(409);
        expect(off.body.code).toBe('BUDDY_OFF');
        expect(claude.calls).toHaveLength(0);

        const { user: on, chat } = await buddyUser();
        expect((await api(on).post('/api/mirror/stand/takes', { window: 'decade' })).status).toBe(400);
        expect((await chat.get('/api/mirror/stand/takes')).status).toBe(403);
        expect((await chat.post('/api/mirror/stand/takes', { window: 'week' })).status).toBe(403);
    });
});

describe('GET /api/mirror/stand moments', () => {
    it('lists what was finished, with its subject', async () => {
        const { user } = await buddyUser();
        const subject = await createSubjectRow(user.id, 'System Design');
        const topics = (await api(user).post(`/api/subjects/${subject.id}/path`, { titles: ['Caching'] })).body.data.path.topics as Array<{ _id: string }>;
        await api(user).patch(`/api/topics/${topics[0]!._id}/path`, { status: 'done' });
        const s = (await api(user).get('/api/mirror/stand')).body.data;
        expect(s.moments).toEqual([{ day: todayIn('Asia/Kolkata'), kind: 'topic', title: 'Caching', of: 'System Design' }]);
    });
});
