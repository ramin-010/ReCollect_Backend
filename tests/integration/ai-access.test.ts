// Stage 2 of ECOSYSTEM_V2_PLAN (§4.15, §10): every AI call names its account; a key that runs out of
// credit or is rejected is paused for the accounts on it, and only for them; the buddy's queue goes
// person by person, so nobody waits behind someone who must wait; a probe (or "Try again") brings a
// paused key back. All on scripted models: no real call is made.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../../src/db/prisma';
import { callClaude, probeDueKeys, setAiClientForTests } from '../../src/services/claude/client';
import { HOUSE_KEY, aiAccessFor, classifyAiError, setAiKeyForTests } from '../../src/services/claude/access';
import { drainBuddyQueue } from '../../src/services/buddy/worker';
import { buddyMaySpend } from '../../src/services/buddy/spend';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';

const house = new FakeClaude();
const other = new FakeClaude();
beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    setAiClientForTests(house);
    setAiClientForTests(other, 'b');
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = '';
    setAiClientForTests(null);
    setAiKeyForTests(null);
});
beforeEach(async () => {
    house.reset();
    other.reset();
    await prisma.buddyChunk.deleteMany({});
    await prisma.aiKeyState.deleteMany({});
});
afterEach(() => setAiKeyForTests(null));

const apiError = (status: number, type: string, message = type) => Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, message, new Headers());
const noCredit = () => apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.');
/** The gate's answer: nothing in the piece is about the person (the piece is read and deleted). */
const nothingKept = () => fakeMessage({ labels: [] }, { model: 'claude-haiku-5-5' });

async function buddyUser(enabled = true) {
    const user = await createTestUser();
    if (enabled) await api(user).patch('/api/buddy/settings', { enabled: true });
    return user;
}

/** One queued piece of a chat, `minutesAgo` old. */
async function piece(userId: string, seq: number, minutesAgo: number) {
    await prisma.buddyChunk.create({
        data: { userId, sessionKey: `cc_${userId}`, seq, messages: [{ at: new Date().toISOString(), text: 'I want to get back to reading most evenings' }], createdAt: new Date(Date.now() - minutesAgo * 60_000) },
    });
}

describe('reading a failure', () => {
    it('no credit and a rejected key pause; busy and the rest do not', () => {
        expect(classifyAiError(apiError(402, 'billing_error'))).toBe('no_credit');
        expect(classifyAiError(noCredit())).toBe('no_credit');
        expect(classifyAiError(apiError(401, 'authentication_error'))).toBe('bad_key');
        expect(classifyAiError(apiError(403, 'permission_error'))).toBe('bad_key');
        expect(classifyAiError(apiError(429, 'rate_limit_error'))).toBe('busy');
        expect(classifyAiError(apiError(529, 'overloaded_error'))).toBe('busy');
        expect(classifyAiError(new Anthropic.APIConnectionError({ message: 'down' }))).toBe('busy');
        expect(classifyAiError(apiError(400, 'invalid_request_error'))).toBe('other');
        expect(classifyAiError(new Error('boom'))).toBe('other');
    });
});

describe('a paused key', () => {
    it('one billing error pauses the key; no further call is made on it', async () => {
        const user = await buddyUser();
        house.push(apiError(402, 'billing_error'));
        await expect(callClaude(user.id, { model: 'claude-haiku-5-5', max_tokens: 5, messages: [] } as never, 'test')).rejects.toMatchObject({ statusCode: 503, code: 'AI_PAUSED' });
        expect(house.calls).toHaveLength(1);
        await expect(callClaude(user.id, { model: 'claude-haiku-5-5', max_tokens: 5, messages: [] } as never, 'test')).rejects.toMatchObject({ code: 'AI_PAUSED' });
        expect(house.calls).toHaveLength(1);
        expect(await aiAccessFor(user.id)).toMatchObject({ source: 'house', state: 'no_credit', keyId: HOUSE_KEY });
        expect(await buddyMaySpend(user.id)).toBe('ai_paused');
    });

    it('pauses only the accounts on that key: another key keeps working in the same pass (J8, first half)', async () => {
        const a = await buddyUser();
        const b = await buddyUser();
        setAiKeyForTests((userId) => (userId === b.id ? 'b' : null));
        await piece(a.id, 1, 10);
        await piece(b.id, 1, 5);
        house.push(noCredit());
        other.push(nothingKept());

        const r = await drainBuddyQueue();
        expect(r).toMatchObject({ digested: 1, dropped: 0 });
        expect(house.calls).toHaveLength(1);
        expect(other.calls.length).toBeGreaterThan(0);
        // A's piece waits with its tries untouched; B's was read.
        const left = await prisma.buddyChunk.findMany();
        expect(left.map((c) => [c.userId, c.attempts])).toEqual([[a.id, 0]]);
        expect((await aiAccessFor(a.id)).state).toBe('no_credit');
        expect((await aiAccessFor(b.id)).state).toBe('ok');
    });

    it('a person who must wait no longer holds the queue: the one behind is read', async () => {
        const waiting = await buddyUser(false); // the buddy off: its pieces wait
        const b = await buddyUser();
        for (let i = 1; i <= 12; i++) await piece(waiting.id, i, 60 - i);
        await piece(b.id, 1, 1);
        house.push(nothingKept());

        const r = await drainBuddyQueue();
        expect(r.digested).toBe(1);
        expect(r.waiting).toBe(12);
        expect(await prisma.buddyChunk.count({ where: { userId: b.id } })).toBe(0);
    });

    it('a probe that works resumes the key; "Try again" does it at once', async () => {
        const user = await buddyUser();
        house.push(apiError(402, 'billing_error'));
        await expect(callClaude(user.id, { model: 'claude-haiku-5-5', max_tokens: 5, messages: [] } as never, 'test')).rejects.toMatchObject({ code: 'AI_PAUSED' });

        // Not due yet: nothing is asked.
        expect(await probeDueKeys(new Date())).toEqual([]);
        // Six hours on, still no credit: paused again, the next probe later.
        house.push(apiError(402, 'billing_error'));
        expect(await probeDueKeys(new Date(Date.now() + 6 * 3600_000 + 1000))).toEqual([]);
        expect((await aiAccessFor(user.id)).state).toBe('no_credit');

        // The page: paused, then "Try again" with credit back.
        const seen = await api(user).get('/api/ai/access');
        expect(seen.status).toBe(200);
        expect(seen.body.data).toMatchObject({ source: 'house', state: 'no_credit' });
        await prisma.aiKeyState.updateMany({ data: { updatedAt: new Date(Date.now() - 120_000) } });
        house.push(fakeMessage('ok', { model: 'claude-haiku-5-5' }));
        const retried = await api(user).post('/api/ai/access/retry', {});
        expect(retried.status).toBe(200);
        expect(retried.body.data).toMatchObject({ state: 'ok' });
        expect(await buddyMaySpend(user.id)).toBe('ok');
    });

    it('the AI routes answer one calm state while paused', async () => {
        const user = await buddyUser();
        await prisma.aiKeyState.create({ data: { keyId: HOUSE_KEY, state: 'bad_key', probeAt: new Date(Date.now() + 3600_000) } });
        const ask = await api(user).post('/api/assistant/messages', { text: 'hello' });
        expect([ask.status, ask.body.code]).toEqual([503, 'AI_PAUSED']);
        const think = await api(user).post('/api/buddy/think', {});
        expect([think.status, think.body.code]).toEqual([503, 'AI_PAUSED']);
        // The spend meter still answers.
        expect((await api(user).get('/api/ai/usage')).status).toBe(200);
        expect(house.calls).toHaveLength(0);
    });
});
