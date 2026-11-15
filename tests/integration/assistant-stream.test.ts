// Ask AI's words as they stream, and his Stop (DOCS_EDITOR_V2_PLAN, the last doc items): `delta`
// events carry the model's words in order; POST /threads/:id/stop ends the running turn, which still
// answers `done` (stopped: "stopped") with what had arrived and keeps what was done; metered.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests, type AiClient, type BetaMessage, type StreamOptions } from '../../src/services/claude/client';
import { createThread } from '../../src/services/assistant/threads.service';
import { authCookie, createTestUser } from '../helpers/auth';

const message = (text: string): BetaMessage =>
    ({
        id: 'msg_stream',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content: text ? [{ type: 'text', text }] : [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 700, output_tokens: 40, cache_read_input_tokens: 12_000, cache_creation_input_tokens: 0 },
    }) as unknown as BetaMessage;

function streaming(stream: (options: StreamOptions) => Promise<BetaMessage>) {
    setAiClientForTests({
        createMessage: () => Promise.reject(new Error('the streamed call is used')),
        streamMessage: (_params: unknown, options: StreamOptions) => stream(options),
    } as unknown as AiClient);
}

beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
beforeEach(() => {
    process.env.CLAUDE_API_KEY = 'test-key-not-real';
});
afterEach(() => {
    setAiClientForTests(null);
    process.env.CLAUDE_API_KEY = '';
});

const events = (body: string) =>
    body
        .split('\n\n')
        .filter(Boolean)
        .map((chunk) => {
            const [eventLine, dataLine] = chunk.split('\n');
            return { event: eventLine!.replace('event: ', ''), data: JSON.parse(dataLine!.replace('data: ', '')) };
        });

const ask = (cookie: string[], body: Record<string, unknown>) =>
    request(app)
        .post('/api/assistant/messages')
        .set('Cookie', cookie)
        .send(body)
        .buffer(true)
        .parse((r, cb) => {
            let text = '';
            r.on('data', (c: Buffer) => (text += c.toString()));
            r.on('end', () => cb(null, text));
        });

describe('Ask AI streams its words, and stops when he says', () => {
    it('sends each piece of the answer as a delta, in order, then the whole answer', async () => {
        const me = await createTestUser();
        streaming(async ({ onText }) => {
            for (const piece of ['Three ', 'reviews ', 'today.']) onText?.(piece);
            return message('Three reviews today.');
        });
        const res = await ask(authCookie(me), { text: 'What is due today?' });
        const all = events(res.body as string);
        const deltas = all.filter((e) => e.event === 'delta');
        expect(deltas.map((e) => e.data.text).join('')).toBe('Three reviews today.');
        expect(new Set(deltas.map((e) => e.data.round))).toEqual(new Set([1]));
        const done = all.find((e) => e.event === 'done');
        expect(done?.data.stopped).toBe('done');
        expect(done?.data.message.text).toBe('Three reviews today.');
        // The deltas come between the thread and the end.
        expect(all.map((e) => e.event)[0]).toBe('thread');
        expect(all[all.length - 1]?.event).toBe('done');
    });

    it('Stop ends the running turn: done says "stopped", keeps what had arrived, and is metered', async () => {
        const me = await createTestUser();
        const thread = await createThread(me.id, 'A long one', null);
        let started!: () => void;
        const running = new Promise<void>((r) => (started = r));
        streaming(async ({ onText, signal }) => {
            onText?.('Writing the first part');
            started();
            // Waits for his Stop, as a long generation would.
            for (let i = 0; i < 500 && !signal?.aborted; i += 1) await new Promise((r) => setTimeout(r, 10));
            return message('Writing the first part');
        });
        // .then() sends it now (supertest sends on the first then), so it runs while we stop it.
        const pending = ask(authCookie(me), { threadId: thread._id, text: 'Write a long section on caching' }).then((r) => r);
        await running;
        const stop = await request(app).post(`/api/assistant/threads/${thread._id}/stop`).set('Cookie', authCookie(me));
        expect(stop.body.data).toEqual({ stopped: true });
        const all = events((await pending).body as string);
        const done = all.find((e) => e.event === 'done');
        expect(done?.data.stopped).toBe('stopped');
        expect(done?.data.message.text).toMatch(/^Writing the first part\n\nStopped\./);
        expect(await prisma.aiUsage.count({ where: { userId: me.id, feature: 'assistant' } })).toBe(1);
        // Stopping a thread with nothing running says so.
        const again = await request(app).post(`/api/assistant/threads/${thread._id}/stop`).set('Cookie', authCookie(me));
        expect(again.body.data).toEqual({ stopped: false });
        // Someone else can't stop his turn (nothing of theirs runs there).
        const other = await createTestUser();
        expect((await request(app).post(`/api/assistant/threads/${thread._id}/stop`).set('Cookie', authCookie(other))).body.data).toEqual({ stopped: false });
    });
});
