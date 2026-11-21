// Stage 10 of ECOSYSTEM_V2_PLAN on scripted models: a person's own Claude key. Checked on each model the app calls
// before it is stored; kept encrypted; their calls go on it (never a fallback to the server's key); a paused own key
// pauses only its person; the server's allowlist and a server without a key do not stop them; removed at once. The key
// is never in an answer, a log line or the stored row.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests, callClaude } from '../../src/services/claude/client';
import { HOUSE_KEY, aiAccessFor, keyFor, noteAiFailure } from '../../src/services/claude/access';
import { CHECK_MODELS, openKey } from '../../src/services/claude/ownKeys';
import { aiAllowedFor } from '../../src/config/aiAccess';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import crypto from 'node:crypto';

const fake = new FakeClaude();
const SECRET = 'a-test-secret-for-own-keys-not-real';
const KEY = `sk-ant-api03-${'Q7x'.repeat(30)}Zk9w`;
const env = { ...process.env };
beforeAll(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    process.env.AI_KEYS_SECRET = SECRET;
    setAiClientForTests(fake);
});
afterAll(() => {
    process.env.CLAUDE_API_KEY = env.CLAUDE_API_KEY ?? '';
    process.env.AI_KEYS_SECRET = env.AI_KEYS_SECRET ?? '';
    process.env.AI_ALLOWED_EMAILS = env.AI_ALLOWED_EMAILS ?? '';
    setAiClientForTests(null);
});
beforeEach(() => fake.reset());
afterEach(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
    process.env.AI_ALLOWED_EMAILS = env.AI_ALLOWED_EMAILS ?? '';
});

const ok3 = () => fake.push(...CHECK_MODELS.map((m) => fakeMessage('pong', { model: m })));
const apiError = (status: number, type: string) => Object.assign(new Error(`${status} ${type}`), { status, error: { type: 'error', error: { type } } });

/** Every console line written while `fn` runs. */
async function logged(fn: () => Promise<void>): Promise<string> {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'info'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' '))));
    try {
        await fn();
    } finally {
        spies.forEach((s) => s.mockRestore());
    }
    return lines.join('\n');
}

describe('their own Claude key (stage 10)', () => {
    it('checked on each model, kept encrypted, used for their calls; the key never in an answer, a log line or the row; removed at once', async () => {
        const user = await createTestUser();
        const you = api(user);
        let answers = '';
        const logs = await logged(async () => {
            ok3();
            const put = await you.put('/api/ai/key', { key: KEY });
            expect(put.status).toBe(200);
            expect(put.body.data).toMatchObject({ last4: 'Zk9w', state: 'ok' });
            answers += JSON.stringify(put.body);
            expect(fake.calls.map((c) => c.model)).toEqual([...CHECK_MODELS]);
            const view = await you.get('/api/ai/key');
            answers += JSON.stringify(view.body);
            expect(view.body.data).toMatchObject({ last4: 'Zk9w', state: 'ok' });
            const access = await you.get('/api/ai/access');
            answers += JSON.stringify(access.body);
            expect(access.body.data).toMatchObject({ source: 'own_key', state: 'ok' });
        });
        // The row holds it sealed: not the key, and opened only with the secret.
        const row = await prisma.aiKey.findFirstOrThrow({ where: { userId: user.id, removedAt: null } });
        expect(JSON.stringify(row)).not.toContain(KEY.slice(7, 40));
        expect(openKey(row, crypto.createHash('sha256').update(SECRET, 'utf8').digest())).toBe(KEY);
        expect(() => openKey(row, crypto.createHash('sha256').update('another secret', 'utf8').digest())).toThrow();

        // Their calls go on their key, never the server's.
        const theirs = new FakeClaude();
        setAiClientForTests(theirs, `own:${row.id}`);
        theirs.push(fakeMessage({ ok: true }, { model: 'claude-sonnet-5-5' }));
        await callClaude(user.id, { model: 'claude-sonnet-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } as never, 'a test');
        expect(theirs.calls).toHaveLength(1);
        expect(fake.calls).toHaveLength(CHECK_MODELS.length);
        setAiClientForTests(null, `own:${row.id}`);

        const removeLogs = await logged(async () => {
            const del = await you.delete('/api/ai/key');
            answers += JSON.stringify(del.body);
            expect(del.body.data).toEqual({ removed: 1 });
        });
        expect(await keyFor(user.id)).toEqual({ source: 'house', keyId: HOUSE_KEY });
        expect((await you.get('/api/ai/key')).body.data).toBeNull();
        for (const text of [answers, logs, removeLogs]) expect(text).not.toContain(KEY.slice(7, 40));
    });

    it('a refused key is never stored, and says why: rejected, no credit, or a model it cannot use', async () => {
        const user = await createTestUser();
        const you = api(user);
        expect((await you.put('/api/ai/key', { key: 'not-a-claude-key-at-all' })).body).toMatchObject({ code: 'KEY_REFUSED' });
        fake.push(apiError(401, 'authentication_error'));
        expect((await you.put('/api/ai/key', { key: KEY })).body.message).toBe('Claude didn’t accept that key.');
        fake.push(apiError(402, 'billing_error'));
        expect((await you.put('/api/ai/key', { key: KEY })).body.message).toMatch(/no credit left/);
        fake.push(fakeMessage('pong'), fakeMessage('pong'), apiError(404, 'not_found_error'));
        const r = await you.put('/api/ai/key', { key: KEY });
        expect(r.status).toBe(400);
        expect(r.body.message).toBe('That key can’t use claude-opus-5-5, which the app needs.');
        expect(JSON.stringify(r.body)).not.toContain(KEY.slice(7, 40));
        expect(await prisma.aiKey.count({ where: { userId: user.id } })).toBe(0);
    });

    it('a paused own key pauses only its person; the allowlist and a server without a key do not stop them', async () => {
        const mine = await createTestUser();
        const other = await createTestUser();
        ok3();
        await api(mine).put('/api/ai/key', { key: KEY });
        const keyId = (await keyFor(mine.id)).keyId!;
        await noteAiFailure(keyId, apiError(402, 'billing_error'));
        expect(await aiAccessFor(mine.id)).toMatchObject({ source: 'own_key', state: 'no_credit' });
        expect(await aiAccessFor(other.id)).toMatchObject({ source: 'house', state: 'ok' });
        // The server's list names someone else: their own key still counts; the other account is refused.
        process.env.AI_ALLOWED_EMAILS = 'someone-else@example.test';
        expect(await aiAllowedFor(mine.id)).toBe(true);
        expect(await aiAllowedFor(other.id)).toBe(false);
        // No server key: their own key still opens the AI routes; the other gets "not set up".
        process.env.CLAUDE_API_KEY = '';
        expect((await api(mine).get('/api/ai/usage')).status).toBe(200);
        expect((await api(other).get('/api/ai/usage')).body).toMatchObject({ code: 'AI_NOT_CONFIGURED' });
        // Removed: the key's pause goes with it (never probed again).
        await api(mine).delete('/api/ai/key');
        expect(await prisma.aiKeyState.count({ where: { keyId } })).toBe(0);
    });
});
