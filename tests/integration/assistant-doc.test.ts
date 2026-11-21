// Ask AI inside a doc (DOCS_EDITOR_V2_PLAN phase 5) with a fake Claude: the doc and his focus go to the
// model instead of the brief; its block tools write into the doc as "Ask AI" (Undo takes it back); the
// thread belongs to the doc and stays off /ask; metered as doc_ask; a viewer can't ask in the doc.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import * as Y from 'yjs';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests, type AiClient, type BetaMessage } from '../../src/services/claude/client';
import { readBlocks } from '../../src/services/docs/blocks/serverEditor';
import { authCookie, createTestUser } from '../helpers/auth';

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
        usage: { input_tokens: 800, output_tokens: 120, cache_read_input_tokens: 15_000, cache_creation_input_tokens: 2_000 },
    } as unknown as BetaMessage;
}
const toolUse = (name: string, input: Record<string, unknown>) => reply([{ type: 'tool_use', id: `toolu_${n + 1}`, name, input }], 'tool_use');
const answer = (text: string) => reply([{ type: 'text', text }], 'end_turn');

function scripted(steps: Array<() => BetaMessage>) {
    const requests: Array<Record<string, unknown>> = [];
    setAiClientForTests({
        createMessage: async (params: unknown) => {
            // A copy: the engine adds to its messages after each call.
            requests.push(JSON.parse(JSON.stringify(params)) as Record<string, unknown>);
            return steps[Math.min(requests.length - 1, steps.length - 1)]!();
        },
    } as unknown as AiClient);
    return requests;
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

async function stored(docId: string) {
    const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId } });
    const ydoc = new Y.Doc();
    if (row.yjsState) Y.applyUpdate(ydoc, row.yjsState);
    return readBlocks(ydoc);
}

/** A doc on the new editor: a heading and one paragraph. */
async function noteFor(cookie: string[]) {
    const content = {
        type: 'doc',
        content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Token bucket' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Each request takes a token.' }] },
        ],
    };
    const res = await request(app).post('/api/docs').set('Cookie', cookie).send({ title: 'Rate limits', content });
    expect(res.status).toBe(201);
    const docId = res.body.data._id as string;
    const [heading, paragraph] = await stored(docId);
    return { docId, headingId: heading!.id, paragraphId: paragraph!.id };
}

describe('Ask AI inside a doc', () => {
    it('reads the doc and his focus, writes after it as "Ask AI"; the thread stays with the doc; Undo takes it back', async () => {
        const user = await createTestUser();
        const cookie = authCookie(user);
        const { docId, headingId, paragraphId } = await noteFor(cookie);
        const requests = scripted([
            () => toolUse('insert_blocks', { docId, markdown: '- Bursts up to the bucket size', where: { after: paragraphId } }),
            () => answer('Added a point on bursts.'),
        ]);

        const res = await ask(cookie, { text: 'Add a point about bursts', docId, focus: { blockIds: [paragraphId] } });
        expect(res.status).toBe(200);
        const got = events(res.body as string);
        expect(got.map((e) => e.event)).toEqual(['thread', 'tool', 'done']);
        expect(got[0]!.data).toMatchObject({ docId });
        expect(got[1]!.data).toMatchObject({ name: 'insert_blocks', level: 2, ok: true, editId: expect.any(String) });
        expect(got[2]!.data).toMatchObject({ stopped: 'done', message: { text: 'Added a point on bursts.' } });

        // The model had the doc (ids, his focus) instead of the brief, at medium effort.
        const first = requests[0]! as { system: Array<{ text: string; cache_control?: unknown }>; output_config: { effort: string } };
        expect(first.output_config.effort).toBe('medium');
        expect(first.system).toHaveLength(2);
        expect(first.system[1]!.cache_control).toEqual({ type: 'ephemeral' });
        expect(first.system[1]!.text).toContain(`docId ${docId}`);
        expect(first.system[1]!.text).toContain(`[${headingId}] ## Token bucket`);
        expect(first.system[1]!.text).toContain(`» [${paragraphId}] Each request takes a token.`);
        expect(first.system[1]!.text).toContain(`Their focus: their cursor is in block [${paragraphId}].`);
        expect(first.system[1]!.text).not.toContain('Where they stand now');

        // Written into the doc as Ask AI, right after his line.
        expect((await stored(docId)).map((b) => b.type)).toEqual(['heading', 'paragraph', 'bulletListItem']);
        const editId = got[1]!.data.editId as string;
        expect(await prisma.agentEdit.findUniqueOrThrow({ where: { id: editId } })).toMatchObject({ agentName: 'Ask AI', docId, kind: 'doc_blocks' });

        // The thread is the doc's: not listed on /ask; the spend is doc_ask.
        const thread = await prisma.assistantThread.findUniqueOrThrow({ where: { id: got[0]!.data._id } });
        expect(thread.docId).toBe(docId);
        const listed = await request(app).get('/api/assistant/threads').set('Cookie', cookie);
        expect(listed.body.data.map((t: { _id: string }) => t._id)).not.toContain(thread.id);
        expect(await prisma.aiUsage.count({ where: { userId: user.id, feature: 'doc_ask' } })).toBe(2);
        expect(await prisma.aiUsage.count({ where: { userId: user.id, feature: 'assistant' } })).toBe(0);

        // A follow-up on the same thread: the doc as it is now (with the new block), the history in text.
        const again = scripted([() => answer('It reads well.')]);
        const res2 = await ask(cookie, { threadId: thread.id, text: 'Does it read well?', docId, focus: { blockIds: [paragraphId] } });
        expect(events(res2.body as string).map((e) => e.event)).toEqual(['thread', 'done']);
        const follow = again[0]! as { system: Array<{ text: string }>; messages: Array<{ role: string; content: unknown }> };
        expect(follow.system[1]!.text).toContain('- Bursts up to the bucket size');
        expect(follow.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

        // Undo takes exactly the AI's block back.
        const undo = await request(app).post(`/api/agent/edits/${editId}/undo`).set('Cookie', cookie);
        expect(undo.status).toBe(200);
        expect((await stored(docId)).map((b) => b.type)).toEqual(['heading', 'paragraph']);
    });

    it('refuses a viewer, a doc in the trash and a thread from elsewhere, before anything streams', async () => {
        const owner = await createTestUser();
        const viewer = await createTestUser();
        const cookie = authCookie(owner);
        const { docId, paragraphId } = await noteFor(cookie);
        const added = await request(app).post(`/api/docs/${docId}/people`).set('Cookie', cookie).send({ email: viewer.email, role: 'viewer' });
        expect(added.status).toBe(201);
        const requests = scripted([() => answer('should not be called')]);

        const asViewer = await request(app).post('/api/assistant/messages').set('Cookie', authCookie(viewer)).send({ text: 'Shorter', docId, focus: { blockIds: [paragraphId] } });
        expect(asViewer.status).toBe(403);
        const stranger = await createTestUser();
        const asStranger = await request(app).post('/api/assistant/messages').set('Cookie', authCookie(stranger)).send({ text: 'Shorter', docId });
        expect(asStranger.status).toBe(404);

        // A conversation from /ask can't continue inside a doc (and a doc's can't continue on /ask).
        const plain = await prisma.assistantThread.create({ data: { userId: owner.id, title: 'From /ask' } });
        const mixed = await request(app).post('/api/assistant/messages').set('Cookie', cookie).send({ threadId: plain.id, text: 'Shorter', docId });
        expect(mixed.status).toBe(400);
        const docThread = await prisma.assistantThread.create({ data: { userId: owner.id, title: 'In the doc', docId } });
        const mixed2 = await request(app).post('/api/assistant/messages').set('Cookie', cookie).send({ threadId: docThread.id, text: 'What is due?' });
        expect(mixed2.status).toBe(400);

        const trashed = await request(app).post(`/api/docs/${docId}/trash`).set('Cookie', cookie);
        expect(trashed.status).toBe(200);
        const inTrash = await request(app).post('/api/assistant/messages').set('Cookie', cookie).send({ text: 'Shorter', docId });
        expect(inTrash.status).toBe(409);

        expect(requests).toHaveLength(0);
        expect(await prisma.assistantMessage.count({ where: { thread: { userId: owner.id } } })).toBe(0);
    });

    it('the doc thread goes with the doc', async () => {
        const owner = await createTestUser();
        const cookie = authCookie(owner);
        const { docId } = await noteFor(cookie);
        const thread = await prisma.assistantThread.create({ data: { userId: owner.id, title: 'In the doc', docId } });
        await prisma.doc.delete({ where: { id: docId } });
        expect(await prisma.assistantThread.findUnique({ where: { id: thread.id } })).toBeNull();
    });
});
