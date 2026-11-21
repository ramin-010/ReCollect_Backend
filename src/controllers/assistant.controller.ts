// The manager's conversations in the app (MANAGER_AND_DOCS_PLAN 3.4): cookie only (the manager is
// his, inside the app; not on the token list). A message streams the manager's turn back.
import { hearChat, openingAsk } from '../services/buddy/chatEar';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { runAssistant, type AssistantEvent } from '../services/assistant/engine';
import { docAskContext, docRules } from '../services/assistant/docContext';
import { addMessage, createThread, deleteThread, getThread, listThreads, toolsWithState } from '../services/assistant/threads.service';
import ErrorResponse from '../utils/errorResponse';
import { internalUrl } from '../services/oauth/oauth.service';
import { handler, ok, param, parse } from './learning/common';

/** GET /api/assistant/threads -> [{ _id, title, createdAt, updatedAt }] */
export const listThreadsHandler = handler(async (req, res) => {
    ok(res, await listThreads(requireUser(req).id));
});

/** GET /api/assistant/threads/:id -> { _id, title, messages: [...] } */
export const getThreadHandler = handler(async (req, res) => {
    ok(res, await getThread(requireUser(req).id, param(req, 'id')));
});

/** DELETE /api/assistant/threads/:id -> { deleted: true } */
export const deleteThreadHandler = handler(async (req, res) => {
    ok(res, await deleteThread(requireUser(req).id, param(req, 'id')));
});

const messageSchema = z.object({
    threadId: z.string().trim().min(1).max(40).optional(),
    text: z.string().trim().min(1, 'Say something').max(4000),
    /** Stage 3: the buddy's question this new chat opened with (Home → Reply). */
    askId: z.string().trim().min(1).max(40).optional(),
    /** Stage 11 (§9.6 item 2): the person's first chat, which opened with the buddy's first words. */
    first: z.literal(true).optional(),
    /** Asked from inside this doc (DOCS_EDITOR_V2_PLAN phase 5): owners and editors only. */
    docId: z.string().trim().min(1).max(40).optional(),
    /** What he points at in the doc: the selected blocks or the cursor's, and the selected words. */
    focus: z
        .object({
            blockIds: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
            text: z.string().max(10_000).optional(),
        })
        .optional(),
});

/**
 * The turns running now, by user and thread, so his Stop can reach them. One process holds them
 * (the backend runs as a single instance: live docs and the jobs need that too).
 */
const running = new Map<string, AbortController>();
const runKey = (userId: string, threadId: string) => `${userId}:${threadId}`;

/** POST /api/assistant/threads/:id/stop -> { stopped }: ends that thread's running turn (its stream then sends `done` with stopped: "stopped"). */
export const stopTurnHandler = handler(async (req, res) => {
    const turn = running.get(runKey(requireUser(req).id, param(req, 'id')));
    turn?.abort();
    ok(res, { stopped: Boolean(turn) });
});

/** Hosting P1-13: the stream's keep-alive comment comes this often. */
export const STREAM_KEEPALIVE_MS = 25_000;

/**
 * An earlier turn as the model reads it again: its words, and for one of its own turns what it did (each tool,
 * with its result's first words). Without them the model could not tell what it had done: in the week's
 * simulation (11-18) it said "I hadn't actually set it" of an alarm it had set, and set a second one.
 */
export function withToolsDone(m: { role: 'user' | 'assistant'; text: string; tools?: ReadonlyArray<{ name: string; input: string; result: string; ok: boolean }> }): string {
    if (m.role !== 'assistant' || !m.tools?.length) return m.text;
    const done = m.tools.map((t) => `${t.name}${t.ok ? '' : ' (failed)'} ${t.input.slice(0, 160)} → ${t.result.split('\n')[0]!.slice(0, 160)}`);
    return `${m.text}\n\n[What you did in that turn: ${done.join(' · ')}]`;
}

/**
 * POST /api/assistant/messages { threadId?, text, docId?, focus? }: his message, then the manager's
 * turn as a stream (text/event-stream): `thread` { _id, title, docId }, `delta` { text, round } as
 * the model's words arrive (a new round starts its words again), a `tool` per tool call as it
 * finishes ({ name, level, input, result, ok, editId }), then `done` { message, stopped, rounds },
 * or `error` { message } when something broke after the stream began. With a docId the doc (as it
 * is now) and his focus go to the model instead of the brief; a doc's thread stays on that doc.
 * POST /threads/:id/stop ends the turn (stopped: "stopped"); leaving the page does not.
 */
export const sendMessageHandler: RequestHandler = async (req, res, next) => {
    let streaming = false;
    let key: string | null = null;
    let keepAlive: NodeJS.Timeout | null = null;
    // He may leave mid-turn: the turn still finishes and is kept; only the writes stop.
    const send = (event: string, data: unknown) => {
        if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
        const user = requireUser(req);
        const { threadId, text, docId, focus, askId, first } = parse(messageSchema, req.body);
        // The doc he is in, read now (a refusal answers before the stream starts).
        const inDoc = docId ? await docAskContext(user.id, docId, { blockIds: focus?.blockIds ?? [], text: focus?.text }) : null;
        // Stage 11: the first chat keeps the buddy's opening words as its first message, so the model and the buddy's ear
        // both know what the person is answering (only while they have never talked to it: read before the chat is made).
        const firstWords = first && !threadId && !docId ? (await (await import('../services/users/firstRun.service')).firstRunFor(user.id)).opening : null;
        const thread = threadId ? await getThread(user.id, threadId) : { ...(await createThread(user.id, text, docId ?? null)), messages: [] };
        if ((thread.docId ?? null) !== (docId ?? null)) throw new ErrorResponse(400, thread.docId ? 'This conversation belongs to a doc: ask from inside it' : 'This conversation is not about a doc');
        if (firstWords) thread.messages.push(await addMessage(user.id, thread._id, { role: 'assistant', text: firstWords }));
        const history = thread.messages.map((m) => ({ role: m.role, text: withToolsDone(m) }));
        const mine = await addMessage(user.id, thread._id, { role: 'user', text });
        // Stage 3: a reply in the chat that opened with one of the buddy's questions closes it for the day.
        const opening = askId && !threadId ? await openingAsk(user.id, thread._id, askId) : null;
        res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
        res.flushHeaders();
        streaming = true;
        // A comment line every 25 s, so a quiet stretch (a slow tool, a long thought) never looks idle
        // to a proxy that closes silent requests (Cloudflare: 100 s; hosting P1-13).
        keepAlive = setInterval(() => {
            if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
        }, STREAM_KEEPALIVE_MS);
        send('thread', { _id: thread._id, title: thread.title, docId: thread.docId });
        // The catalogue calls this same server back, at the port the request came in on.
        const baseUrl = internalUrl(req.socket.localPort); // this server, as it listens (hosting P1-9)
        // The words as they arrive, each tool as it finishes (with its card's words when it left one
        // waiting): all in the order they happened.
        let sent = Promise.resolve();
        const onEvent = (e: AssistantEvent) => {
            if (e.type === 'delta') sent = sent.then(() => send('delta', { text: e.text, round: e.round }));
            else if (e.type === 'tool') sent = sent.then(async () => send('tool', (await toolsWithState(user.id, [e.tool]))[0]));
        };
        const doc = inDoc ? { docId: inDoc.docId, text: `${docRules(inDoc.docId)}\n\n${inDoc.text}` } : undefined;
        const stop = new AbortController();
        key = runKey(user.id, thread._id);
        running.get(key)?.abort();
        running.set(key, stop);
        const turn = await runAssistant({ userId: user.id, baseUrl, history, text, onEvent, signal: stop.signal, ...(doc ? { doc } : {}) });
        await sent;
        const message = await addMessage(user.id, thread._id, { role: 'assistant', text: turn.text, tools: turn.tools, usage: turn.usage, costUsd: turn.costUsd });
        send('done', { message, stopped: turn.stopped, rounds: turn.rounds });
        // Stage 3: the buddy reads what he said here (the chat is one of its ears), with what it said just before.
        await hearChat(user.id, thread._id, mine, { inDoc: !!docId, before: opening?.text ?? [...thread.messages].reverse().find((m) => m.role === "assistant")?.text ?? null, reply: turn.text, index: history.length }).catch((err: unknown) => console.error('[buddy] the chat could not be queued:', err instanceof Error ? err.message : err));
        res.end();
    } catch (err) {
        if (!streaming) return next(err);
        send('error', { message: err instanceof Error ? err.message : 'Something went wrong' });
        res.end();
    } finally {
        if (keepAlive) clearInterval(keepAlive);
        if (key) running.delete(key);
    }
};
