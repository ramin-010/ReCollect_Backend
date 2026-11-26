// The manager's engine and its stream (MANAGER_AND_DOCS_PLAN §3.4) with a fake Claude: a tool round
// then an answer through POST /api/assistant/messages (events, the doc made as "Ask Kaaga", the thread,
// the metering); a level-3 tool only asks; the loop stops at its round limit and at the cap.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests, type AiClient, type BetaMessage } from '../../src/services/claude/client';
import { MAX_CHANGES, MAX_ROUNDS, runAssistant } from '../../src/services/assistant/engine';
import { toolsWithState } from '../../src/services/assistant/threads.service';
import { authCookie, createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';

let n = 0;
function reply(content: Array<Record<string, unknown>>, stopReason: 'tool_use' | 'end_turn'): BetaMessage {
    n += 1;
    return {
        id: `msg_${n}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5-5',
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 15_000, cache_creation_input_tokens: 0 },
    } as unknown as BetaMessage;
}
const toolUse = (name: string, input: Record<string, unknown>) => reply([{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'tool_use', id: `toolu_${n + 1}`, name, input }], 'tool_use');
const answer = (text: string) => reply([{ type: 'text', text }], 'end_turn');

/** A fake Claude answering from a script (the last entry repeats); it records each request. */
function scripted(steps: Array<() => BetaMessage>) {
    const requests: Array<Record<string, unknown>> = [];
    const client = {
        createMessage: async (params: unknown) => {
            requests.push(params as Record<string, unknown>);
            return steps[Math.min(requests.length - 1, steps.length - 1)]!();
        },
    } as unknown as AiClient;
    setAiClientForTests(client);
    return requests;
}

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

describe('the manager', () => {
    it('streams a tool round and the answer; the doc is made as "Ask Kaaga"; the thread and the cost are kept', async () => {
        const user = await createTestUser();
        const requests = scripted([() => toolUse('create_doc', { title: 'Heaps', markdown: 'k smallest: a max-heap of size k.' }), () => answer('Made the note "Heaps".')]);
        const res = await request(app)
            .post('/api/assistant/messages')
            .set('Cookie', authCookie(user))
            .send({ text: 'Make a note on heaps' })
            .buffer(true)
            .parse((r, cb) => {
                let body = '';
                r.on('data', (c: Buffer) => (body += c.toString()));
                r.on('end', () => cb(null, body));
            });
        expect(res.status).toBe(200);
        const got = events(res.body as string);
        expect(got.map((e) => e.event)).toEqual(['thread', 'tool', 'done']);
        expect(got[1]!.data).toMatchObject({ name: 'create_doc', level: 2, ok: true, editId: expect.any(String) });
        expect(got[2]!.data).toMatchObject({ stopped: 'done', rounds: 2, message: { role: 'assistant', text: 'Made the note "Heaps".', costUsd: expect.any(Number) } });

        expect(await prisma.doc.count({ where: { userId: user.id, title: 'Heaps' } })).toBe(1);
        expect((await prisma.agentEdit.findFirstOrThrow({ where: { userId: user.id } })).agentName).toBe('Ask Kaaga');
        expect(await prisma.aiUsage.count({ where: { userId: user.id, feature: 'assistant' } })).toBe(2);
        // The cached start: the tool list (cache mark on the last tool) and the rules, then the brief.
        const first = requests[0]! as { model: string; tools: Array<Record<string, unknown>>; system: Array<{ text: string; cache_control?: unknown }> };
        expect(first.model).toBe('claude-sonnet-5-5');
        expect(first.tools[first.tools.length - 1]!['cache_control']).toEqual({ type: 'ephemeral' });
        expect(first.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
        expect(first.system[1]!.text).toContain('Where they stand now');
        // The second round carries the tool's answer back.
        expect(JSON.stringify(requests[1])).toContain('tool_result');

        const thread = (await api(user).get(`/api/assistant/threads/${got[0]!.data._id}`)).body.data;
        expect(thread.title).toBe('Make a note on heaps');
        expect(thread.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
        // The row's words and its Undo: undone from the page, the thread says so.
        expect(got[1]!.data).toMatchObject({ detail: 'Heaps', undone: false });
        expect((await api(user).post(`/api/agent/edits/${got[1]!.data.editId}/undo`)).status).toBe(200);
        const again = (await api(user).get(`/api/assistant/threads/${got[0]!.data._id}`)).body.data;
        expect(again.messages[1].tools[0]).toMatchObject({ name: 'create_doc', undone: true });
    });

    it('the fake model (ASSISTANT_FAKE) answers only the accounts it names, through the real tools', async () => {
        const user = await createTestUser();
        const other = await createTestUser();
        const server = app.listen(0);
        await new Promise((r) => server.once('listening', r));
        const baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
        try {
            process.env.ASSISTANT_FAKE = user.email.toUpperCase();
            const turn = await runAssistant({ userId: user.id, baseUrl, history: [], text: 'Make a note on tries' });
            expect(turn.tools[0]).toMatchObject({ name: 'create_doc', level: 2, ok: true, detail: 'Tries' });
            expect(turn.text).toContain('Made the note **Tries**');
            expect(await prisma.doc.count({ where: { userId: user.id, title: 'Tries' } })).toBe(1);
            // Anyone else gets the real client (here the scripted one).
            const requests = scripted([() => answer('real')]);
            expect((await runAssistant({ userId: other.id, baseUrl, history: [], text: 'Make a note on tries' })).text).toBe('real');
            expect(requests).toHaveLength(1);
        } finally {
            delete process.env.ASSISTANT_FAKE;
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('a level-3 tool only asks; the loop stops at its round limit and at the cap', async () => {
        const user = await createTestUser();
        const doc = await prisma.doc.create({ data: { userId: user.id, title: 'Old draft' } });
        await api(user).post(`/api/docs/${doc.id}/trash`);
        const server = app.listen(0);
        await new Promise((r) => server.once('listening', r));
        const baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
        try {
            scripted([() => toolUse('empty_trash', { reason: 'he asked' }), () => answer('Asked: it waits for your tap on Home.')]);
            const asked = await runAssistant({ userId: user.id, baseUrl, history: [], text: 'Empty my trash' });
            expect(asked.tools[0]).toMatchObject({ name: 'empty_trash', level: 3, ok: true, editId: null });
            expect(await prisma.doc.count({ where: { id: doc.id } })).toBe(1);
            const card = await prisma.suggestion.findFirstOrThrow({ where: { userId: user.id, kind: 'action', proposedBy: 'ask_ai', status: 'pending' } });
            expect(asked.tools[0]!.suggestionId).toBe(card.id);
            const [view] = await toolsWithState(user.id, asked.tools);
            expect(view!.action).toEqual({ status: 'pending', text: expect.stringContaining('Empty the trash') });

            scripted([() => toolUse('list_subjects', {})]);
            const looped = await runAssistant({ userId: user.id, baseUrl, history: [], text: 'Loop' });
            expect([looped.stopped, looped.rounds, looped.tools.length]).toEqual(['rounds', MAX_ROUNDS, MAX_ROUNDS]);

            // At most MAX_CHANGES changes in one message, whatever the model asks for.
            const many = Array.from({ length: MAX_CHANGES + 2 }, (_, i) => ({ type: 'tool_use', id: `toolu_many_${i}`, name: 'add_task', input: { title: `Task ${i + 1}` } }));
            scripted([() => reply(many, 'tool_use'), () => answer('Done ten; two left.')]);
            const bulk = await runAssistant({ userId: user.id, baseUrl, history: [], text: 'Add twelve tasks' });
            expect(bulk.tools.filter((t) => t.ok)).toHaveLength(MAX_CHANGES);
            expect(bulk.tools.filter((t) => !t.ok).map((t) => t.result)).toEqual([expect.stringContaining('Not done'), expect.stringContaining('Not done')]);
            expect(await prisma.todo.count({ where: { userId: user.id, title: { startsWith: 'Task ' } } })).toBe(MAX_CHANGES);

            await api(user).patch('/api/ai/settings', { capUsd: 0 });
            const requests = scripted([() => answer('never')]);
            const capped = await runAssistant({ userId: user.id, baseUrl, history: [], text: 'Anything' });
            expect([capped.stopped, requests.length]).toEqual(['cap', 0]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});

describe('the chat knows what the buddy knows (stage 5, M1 and M2)', () => {
    it('with the loop on: what is on their mind, the memories that match the message, the rules for personal talk; with it off: nothing new', async () => {
        const { openOrFindThread, withPersonLock } = await import('../../src/services/buddy/threads');
        const user = await createTestUser();
        await api(user).patch('/api/buddy/settings', { enabled: true, loop: true });
        await withPersonLock(user.id, (tx) => openOrFindThread(tx, user.id, { title: 'Run three mornings a week', keywords: ['run', 'running'] }, { saidAt: new Date(), forDay: '2026-11-18' }));
        await prisma.memory.create({ data: { userId: user.id, text: 'Knee hurts after long runs', kind: 'state', sensitivity: 'private', lasting: false, source: 'agent', firstSeenDay: new Date('2026-11-18T00:00:00Z'), lastSeenDay: new Date('2026-11-18T00:00:00Z') } });
        const requests = scripted([() => answer('Short and easy today.')]);
        await runAssistant({ userId: user.id, text: 'Should I still go for my run tomorrow?', history: [], baseUrl: 'http://localhost' } as never);
        const system = JSON.stringify((requests[0] as { system: unknown }).system);
        expect(system).toContain('What is on their mind');
        expect(system).toContain('Run three mornings a week');
        expect(system).toContain('Knee hurts after long runs (private)');
        expect(system).toContain('a few sentences, one suggestion at most');

        await api(user).patch('/api/buddy/settings', { loop: false });
        const again = scripted([() => answer('ok')]);
        await runAssistant({ userId: user.id, text: 'Should I still go for my run tomorrow?', history: [], baseUrl: 'http://localhost' } as never);
        expect(JSON.stringify((again[0] as { system: unknown }).system)).not.toContain('What is on their mind');
    });
});
