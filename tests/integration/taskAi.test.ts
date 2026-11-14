// POST /api/todos/ai/generate (the @ai task input). The AI provider is mocked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/ai/aiOrchestrator', () => ({
    generateAIContent: vi.fn(),
}));

import app from '../../src/app';
import { generateAIContent } from '../../src/services/ai/aiOrchestrator';
import { authCookie, createTestUser } from '../helpers/auth';

const ai = vi.mocked(generateAIContent);

function aiReturns(data: unknown) {
    ai.mockResolvedValueOnce({ raw: typeof data === 'string' ? data : JSON.stringify(data), provider: 'test-provider' } as any);
}

afterEach(() => {
    vi.useRealTimers();
    ai.mockReset();
});

describe('POST /api/todos/ai/generate', () => {
    it('401 without a cookie', async () => {
        expect((await request(app).post('/api/todos/ai/generate').send({ prompt: 'x' })).status).toBe(401);
    });

    it('400 without a prompt', async () => {
        const user = await createTestUser();
        const res = await request(app).post('/api/todos/ai/generate').set('Cookie', authCookie(user)).send({ prompt: '  ' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ message: 'A prompt is required.' });
        expect(ai).not.toHaveBeenCalled();
    });

    it("tells the AI the user's date (IST), not the UTC date — at 01:30 IST they differ", async () => {
        const user = await createTestUser();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-21T20:00:00.000Z')); // 22 Oct 01:30 in India, still 21 Oct in UTC
        aiReturns({ title: 'Call the plumber tomorrow', priority: 'normal', dueDate: '2026-10-23', tags: ['home'] });

        const res = await request(app).post('/api/todos/ai/generate').set('Cookie', authCookie(user)).send({ prompt: 'call the plumber tomorrow' });

        expect(res.status).toBe(200);
        const prompt = ai.mock.calls[0]![0];
        expect(prompt).toContain("TODAY'S DATE: 2026-10-22");
        expect(prompt).not.toContain('2026-10-21');
        // The response keeps its old shape: the date-only string and the tags are passed through.
        expect(res.body).toEqual({
            success: true,
            provider: 'test-provider',
            data: { title: 'Call the plumber tomorrow', priority: 'normal', dueDate: '2026-10-23', tags: ['home'], assignees: [] },
        });
    });

    it('normalizes the AI output as before: title fallback, priority, arrays, assignees limited to workspace members', async () => {
        const user = await createTestUser();
        aiReturns('```json\n{"priority":"critical","tags":"x","assignees":["Member@Example.test","stranger@example.test"]}\n```');

        const res = await request(app)
            .post('/api/todos/ai/generate')
            .set('Cookie', authCookie(user))
            .send({ prompt: 'fix the login bug for @member', workspaceMembers: [{ name: 'Member', email: 'member@example.test' }] });

        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({
            title: 'fix the login bug for @member',
            priority: 'normal',
            tags: [],
            assignees: ['Member@Example.test'],
        });
        const prompt = ai.mock.calls[0]![0];
        expect(prompt).toContain('WORKSPACE_MEMBERS:\n- Member (member@example.test)');
    });

    it('502 for invalid JSON from the AI, 429 when rate limited, 503 when every provider failed', async () => {
        const user = await createTestUser();
        const send = () => request(app).post('/api/todos/ai/generate').set('Cookie', authCookie(user)).send({ prompt: 'anything' });

        aiReturns('not json at all');
        const bad = await send();
        expect(bad.status).toBe(502);
        expect(bad.body).toEqual({ message: 'AI returned invalid JSON. Try again.' });

        ai.mockRejectedValueOnce(Object.assign(new Error('rate limit reached'), { status: 429 }));
        expect((await send()).status).toBe(429);

        ai.mockRejectedValueOnce(new Error('All AI providers failed'));
        const down = await send();
        expect(down.status).toBe(503);
        expect(down.body).toEqual({ message: 'All AI providers are currently unavailable. Please try again later.' });
    });
});
