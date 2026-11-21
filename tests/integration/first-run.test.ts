// Stage 11 of ECOSYSTEM_V2_PLAN (§9.6 item 2): the first run. A new account sees Home's short checklist, read from what it
// really did (its time zone confirmed, a word to the buddy, its own Claude connected, an import), hidden when done or
// dismissed and after 30 days; the buddy's first chat opens with its first words, kept as the chat's first message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests, type AiClient, type BetaMessage } from '../../src/services/claude/client';
import { createApiToken } from '../../src/services/apiTokens/apiTokens.service';
import { authCookie, createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';

const reply = (text: string): BetaMessage =>
    ({ id: 'msg_first', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 500, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) as unknown as BetaMessage;

let seen: Array<{ role: string; content: unknown }> = [];
beforeEach(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    seen = [];
    setAiClientForTests({
        createMessage: (params: { messages: Array<{ role: string; content: unknown }> }) => {
            seen = params.messages;
            return Promise.resolve(reply('Nice. What are you working on this week?'));
        },
    } as unknown as AiClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    setAiClientForTests(null);
    process.env.CLAUDE_API_KEY = '';
    vi.restoreAllMocks();
});

const steps = (body: { data: { steps: Array<{ id: string; done: boolean }> } }) => Object.fromEntries(body.data.steps.map((s) => [s.id, s.done]));

describe('the first run (stage 11)', () => {
    it('a new account sees the checklist; each step is read from what it did; the time zone is confirmed by hand', async () => {
        const me = await createTestUser({ name: 'Asha Rao', timezone: 'Europe/Berlin' });
        const first = await api(me).get('/api/first-run');
        expect(first.body.data).toMatchObject({ show: true, zone: 'Europe/Berlin', ai: true });
        expect(steps(first.body)).toEqual({ zone: false, buddy: false, connect: false, import: false });
        expect(first.body.data.opening).toMatch(/^Hi Asha! I’m your buddy\./);
        expect(first.body.data.opening.split('\n').filter((l: string) => l.startsWith('- '))).toHaveLength(3);

        expect(steps((await api(me).patch('/api/first-run', { zoneOk: true })).body)).toMatchObject({ zone: true });
        // The phone app's token is not "your own Claude"; Claude Code's is.
        await createApiToken(me.id, { name: 'Phone app', scopes: ['read', 'ambient'] } as never);
        expect(steps((await api(me).get('/api/first-run')).body).connect).toBe(false);
        await createApiToken(me.id, { name: 'Claude Code', scopes: ['read', 'docs:write'] } as never);
        expect(steps((await api(me).get('/api/first-run')).body).connect).toBe(true);
    });

    it('the first chat opens with the buddy’s words, kept as its first message and given to the model', async () => {
        const me = await createTestUser({ name: 'Ravi' });
        const opening = (await api(me).get('/api/first-run')).body.data.opening as string;
        const res = await request(app).post('/api/assistant/messages').set('Cookie', authCookie(me)).send({ text: 'Right now I’m learning Go', first: true }).buffer(true);
        expect(res.status).toBe(200);
        const thread = await prisma.assistantThread.findFirstOrThrow({ where: { userId: me.id }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
        expect(thread.messages.map((m) => [m.role, m.text])).toEqual([
            ['assistant', opening],
            ['user', 'Right now I’m learning Go'],
            ['assistant', 'Nice. What are you working on this week?'],
        ]);
        expect(seen[0]).toMatchObject({ role: 'assistant', content: opening });
        // Once they have talked to it: no opening, and the buddy step is done.
        const after = (await api(me).get('/api/first-run')).body;
        expect(after.data.opening).toBeNull();
        expect(steps(after).buddy).toBe(true);
        // A later "first" is just a chat (the words are never added twice).
        await request(app).post('/api/assistant/messages').set('Cookie', authCookie(me)).send({ text: 'Hello again', first: true }).buffer(true);
        expect(await prisma.assistantMessage.count({ where: { thread: { userId: me.id }, text: opening } })).toBe(1);
    });

    it('hidden when dismissed, and for an account older than 30 days; without AI only the steps that need none', async () => {
        const me = await createTestUser();
        expect((await api(me).patch('/api/first-run', { dismissed: true })).body.data.show).toBe(false);
        const old = await createTestUser();
        await prisma.user.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 31 * 86_400_000) } });
        expect((await api(old).get('/api/first-run')).body.data.show).toBe(false);
        process.env.CLAUDE_API_KEY = '';
        const saved = process.env.AI_ALLOWED_EMAILS;
        process.env.AI_ALLOWED_EMAILS = 'someone-else@test.local';
        try {
            const none = await createTestUser();
            const r = (await api(none).get('/api/first-run')).body.data;
            expect(r).toMatchObject({ ai: false, opening: null });
            expect(r.steps.map((s: { id: string }) => s.id)).toEqual(['zone', 'connect']);
        } finally {
            if (saved === undefined) delete process.env.AI_ALLOWED_EMAILS;
            else process.env.AI_ALLOWED_EMAILS = saved;
        }
    });
});
