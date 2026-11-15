// POST /api/todos/ai/generate (the @ai task line, LOOP_COMPLETE_SPEC 4.1): Claude on Haiku with a
// checked structured answer, metered as task_parse under the cap; any failure keeps the line as a plain
// task. A fake Claude API (tests never call the real one).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { TASK_AI_DEFAULT_MODEL } from '../../src/services/tasks/taskAi.service';
import { authCookie, createTestUser } from '../helpers/auth';
import { FakeClaude, fakeMessage } from '../helpers/claude';

const fake = new FakeClaude();
beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    setAiClientForTests(fake);
});
afterAll(() => {
    setAiClientForTests(null);
    process.env.CLAUDE_API_KEY = '';
});
beforeEach(() => fake.reset());
afterEach(() => vi.useRealTimers());

const line = (user: { id: string }, body: Record<string, unknown>) => request(app).post('/api/todos/ai/generate').set('Cookie', authCookie(user as never)).send(body);
const answer = (over: Record<string, unknown> = {}) =>
    fakeMessage({ title: 'Call the plumber about the kitchen leak', description: '<p>Ask for a time on Friday.</p>', priority: 'normal', dueDate: '2026-10-23', tags: ['home'], assignees: [], ...over }, { model: TASK_AI_DEFAULT_MODEL });

describe('POST /api/todos/ai/generate', () => {
    it('401 without a cookie; 400 without a line (no call)', async () => {
        expect((await request(app).post('/api/todos/ai/generate').send({ prompt: 'x' })).status).toBe(401);
        const user = await createTestUser();
        const res = await line(user, { prompt: '  ' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'A prompt is required.' });
        expect(fake.calls).toHaveLength(0);
    });

    it("Claude on Haiku writes the fields; today is the user's day (IST); the call is metered as task_parse", async () => {
        const user = await createTestUser();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-21T20:00:00.000Z')); // 22 Oct 01:30 in India, still 21 Oct in UTC
        fake.push(answer());
        const res = await line(user, { prompt: 'call the plumber tomorrow' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            success: true,
            provider: 'claude',
            data: { title: 'Call the plumber about the kitchen leak', description: '<p>Ask for a time on Friday.</p>', priority: 'normal', dueDate: '2026-10-23', tags: ['home'], assignees: [] },
        });
        const call = fake.calls[0]!;
        expect(call.model).toBe(TASK_AI_DEFAULT_MODEL);
        expect(JSON.stringify(call.messages)).toContain('TODAY: 2026-10-22');
        expect(call.output_config?.format).toMatchObject({ type: 'json_schema' });
        expect(await prisma.aiUsage.count({ where: { userId: user.id, feature: 'task_parse' } })).toBe(1);
    });

    it('assignees only from the workspace members (and the pre-selected ones)', async () => {
        const user = await createTestUser();
        fake.push(answer({ assignees: ['Member@Example.test', 'stranger@example.test'] }));
        const res = await line(user, { prompt: 'review the PR with @member', workspaceMembers: [{ name: 'Member', email: 'member@example.test' }] });
        expect(res.body.data.assignees).toEqual(['Member@Example.test']);
    });

    it('an answer that does not fit, an API error, no key, or the cap: the line stays a plain task', async () => {
        const user = await createTestUser();
        fake.push(answer({ priority: 'critical' }));
        expect((await line(user, { prompt: 'fix the login bug' })).body).toEqual({ success: true, provider: 'plain', data: { title: 'fix the login bug', description: '', priority: 'normal', dueDate: null, tags: [], assignees: [] } });
        fake.push(new Error('overloaded'));
        expect((await line(user, { prompt: 'fix the login bug' })).body.provider).toBe('plain');

        process.env.CLAUDE_API_KEY = '';
        expect((await line(user, { prompt: 'no key' })).body.provider).toBe('plain');
        process.env.CLAUDE_API_KEY = 'test-key-not-real';

        await prisma.aiSettings.create({ data: { userId: user.id, monthlyCapUsd: '0' } });
        const calls = fake.calls.length;
        expect((await line(user, { prompt: 'at the cap' })).body.provider).toBe('plain');
        expect(fake.calls).toHaveLength(calls);
    });
});

describe('POST /api/docs/ai/generate', () => {
    it('is gone (410): Ask AI to write left with the old AI chain', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/docs/ai/generate').set('Cookie', authCookie(user as never)).send({ prompt: 'x' });
        expect(res.status).toBe(410);
    });
});
