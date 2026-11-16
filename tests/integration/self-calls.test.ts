// The server calls itself on the address it listens on (hosting P1-9): /mcp's tools and Ask AI use
// internalUrl(), never RECOLLECT_SELF_URL (the public address, for metadata, the issuer and links);
// and Ask AI's stream says something at least every 25 seconds (hosting P1-13).
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/services/assistant/engine', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../src/services/assistant/engine')>();
    return { ...real, runAssistant: vi.fn(real.runAssistant) };
});

import app from '../../src/app';
import { internalUrl } from '../../src/services/oauth/oauth.service';
import { runAssistant } from '../../src/services/assistant/engine';
import { STREAM_KEEPALIVE_MS } from '../../src/controllers/assistant.controller';
import { setAiClientForTests } from '../../src/services/claude/client';
import { createTestUser } from '../helpers/auth';
import { createTestToken } from '../helpers/agent';
import { api } from '../helpers/learning';
import { FakeClaude } from '../helpers/claude';

afterEach(() => {
    delete process.env.RECOLLECT_SELF_URL;
    delete process.env.HOST;
    vi.useRealTimers();
});

describe('internalUrl (P1-9)', () => {
    it("the request's port; 127.0.0.1 with HOST set (production), localhost without it (dev answers there)", () => {
        expect(internalUrl(8123, {})).toBe('http://localhost:8123');
        expect(internalUrl(8123, { HOST: '127.0.0.1' })).toBe('http://127.0.0.1:8123');
        expect(internalUrl(8123, { HOST: '::1' })).toBe('http://[::1]:8123');
        expect(internalUrl(undefined, { PORT: '8002' })).toBe('http://localhost:8002');
    });

    it('with RECOLLECT_SELF_URL set to a name that does not exist, a tool call over /mcp still works', async () => {
        process.env.RECOLLECT_SELF_URL = 'https://recollect-unreachable.invalid';
        const user = await createTestUser();
        const { token } = await createTestToken(user);
        const res = await request(app)
            .post('/mcp')
            .set('Authorization', `Bearer ${token}`)
            .set('Accept', 'application/json, text/event-stream')
            .send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_tasks', arguments: {} } });
        expect(res.status).toBe(200);
        const text = res.text;
        const body = text.trim().startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6));
        expect(body.id).toBe(7);
        expect(body.result?.isError).not.toBe(true);
        expect(JSON.stringify(body.result)).not.toContain('recollect-unreachable');
        // The metadata still names the public address.
        expect((await request(app).get('/.well-known/oauth-protected-resource')).body.resource).toBe('https://recollect-unreachable.invalid/mcp');
    });
});

describe("Ask AI's stream keep-alive (P1-13)", () => {
    it('a 120-second silent turn gets a comment every 25 seconds: never quiet long enough for a 100-second proxy limit', async () => {
        const fake = new FakeClaude();
        process.env.CLAUDE_API_KEY = 'test-key-not-real';
        setAiClientForTests(fake);
        try {
            const user = await createTestUser();
            vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
            let release: () => void = () => {};
            const gate = new Promise<void>((r) => (release = r));
            vi.mocked(runAssistant).mockImplementationOnce(async () => {
                await gate; // the model says nothing for 120 s
                return { text: 'Done.', tools: [], usage: { input_tokens: 0, output_tokens: 0 }, costUsd: 0, stopped: null, rounds: 1 } as never;
            });
            const pending = api(user).post('/api/assistant/messages', { text: 'think for a while' });
            const response = pending.then((r) => r);
            await vi.waitFor(() => expect(vi.mocked(runAssistant)).toHaveBeenCalled(), { timeout: 10_000, interval: 20 });
            await vi.advanceTimersByTimeAsync(120_000);
            release();
            const res = await response;
            expect(res.status).toBe(200);
            const comments = res.text.split('\n').filter((l) => l === ': keep-alive');
            expect(STREAM_KEEPALIVE_MS).toBe(25_000);
            expect(comments).toHaveLength(4); // at 25, 50, 75 and 100 s
            expect(res.text).toContain('event: done');
        } finally {
            process.env.CLAUDE_API_KEY = '';
            setAiClientForTests(null);
        }
    });
});
