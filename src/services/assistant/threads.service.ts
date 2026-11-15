// The manager's conversations (MANAGER_AND_DOCS_PLAN §3.4): threads of his messages and the
// manager's answers, with the tools each answer used (short forms). His own: listed newest first,
// read, deleted; kept 90 days after their last message (the hourly job prunes them). The engine
// (part 2) writes the messages; the app reads them here.
import type { AssistantMessage, AssistantThread, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { notFound } from '../learning/http';

export const THREAD_DAYS = 90;
const TITLE_MAX = 120;
const THREADS_LISTED = 50;

export interface ToolUseJson {
    name: string;
    level: 1 | 2 | 3;
    /** The call's input, short. */
    input: string;
    /** Its answer's first line(s), short. */
    result: string;
    ok: boolean;
    /** The edit log entry a write made (Undo), when one did. */
    editId?: string | null;
    /** The title, query or text it was called with (the row's words). */
    detail?: string | null;
    /** The card a level-3 call left waiting for his tap (Do it / Dismiss). */
    suggestionId?: string | null;
}

/** A tool as the page shows it: whether its edit was undone, and its card's state now. */
export interface ToolUseView extends ToolUseJson {
    undone?: boolean;
    action?: { status: 'pending' | 'accepted' | 'dismissed' | 'candidate'; text: string } | null;
}

export interface AssistantMessageJson {
    _id: string;
    role: 'user' | 'assistant';
    text: string;
    tools: ToolUseView[];
    costUsd: number | null;
    createdAt: Date;
}

export interface AssistantThreadJson {
    _id: string;
    title: string;
    /** Asked from inside this doc (DOCS_EDITOR_V2_PLAN phase 5); null for /ask's own. */
    docId: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const threadJson = (t: AssistantThread): AssistantThreadJson => ({ _id: t.id, title: t.title, docId: t.docId ?? null, createdAt: t.createdAt, updatedAt: t.updatedAt });

const messageJson = (m: AssistantMessage): AssistantMessageJson => ({
    _id: m.id,
    role: m.role,
    text: m.text,
    tools: Array.isArray(m.tools) ? (m.tools as unknown as ToolUseJson[]) : [],
    costUsd: m.costUsd === null ? null : Number(m.costUsd),
    createdAt: m.createdAt,
});

/** Each tool's state now: whether its edit was undone, its waiting card's status and words. */
export async function toolsWithState(userId: string, tools: ToolUseJson[]): Promise<ToolUseView[]> {
    const editIds = [...new Set(tools.map((t) => t.editId).filter((id): id is string => !!id))];
    const cardIds = [...new Set(tools.map((t) => t.suggestionId).filter((id): id is string => !!id))];
    if (editIds.length === 0 && cardIds.length === 0) return tools;
    const [edits, cards] = await Promise.all([
        editIds.length ? prisma.agentEdit.findMany({ where: { userId, id: { in: editIds } }, select: { id: true, undoneAt: true } }) : [],
        cardIds.length ? prisma.suggestion.findMany({ where: { userId, id: { in: cardIds } }, select: { id: true, status: true, text: true } }) : [],
    ]);
    const undone = new Set(edits.filter((e) => e.undoneAt).map((e) => e.id));
    const card = new Map(cards.map((c) => [c.id, { status: c.status, text: c.text }]));
    return tools.map((t) => ({
        ...t,
        ...(t.editId ? { undone: undone.has(t.editId) } : {}),
        ...(t.suggestionId ? { action: card.get(t.suggestionId) ?? null } : {}),
    }));
}

async function withToolState(userId: string, messages: AssistantMessageJson[]): Promise<AssistantMessageJson[]> {
    const all = await toolsWithState(userId, messages.flatMap((m) => m.tools));
    let i = 0;
    return messages.map((m) => ({ ...m, tools: m.tools.map(() => all[i++]!) }));
}

/** A thread's title: the first line of his first message, cut to fit. */
export function threadTitle(text: string): string {
    const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'New conversation';
    return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** GET /api/assistant/threads: newest first (asks made inside a doc stay with the doc). */
export async function listThreads(userId: string): Promise<AssistantThreadJson[]> {
    const rows = await prisma.assistantThread.findMany({ where: { userId, docId: null }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: THREADS_LISTED });
    return rows.map(threadJson);
}

/** GET /api/assistant/threads/:id: the thread and its messages, oldest first. */
export async function getThread(userId: string, threadId: string): Promise<AssistantThreadJson & { messages: AssistantMessageJson[] }> {
    const thread = await prisma.assistantThread.findFirst({ where: { id: threadId, userId } });
    if (!thread) throw notFound();
    const messages = await prisma.assistantMessage.findMany({ where: { threadId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return { ...threadJson(thread), messages: await withToolState(userId, messages.map(messageJson)) };
}

/** DELETE /api/assistant/threads/:id */
export async function deleteThread(userId: string, threadId: string): Promise<{ deleted: true }> {
    const { count } = await prisma.assistantThread.deleteMany({ where: { id: threadId, userId } });
    if (count === 0) throw notFound();
    return { deleted: true };
}

/** A new thread, titled by his first message (on a doc when asked from inside one). */
export async function createThread(userId: string, firstText: string, docId: string | null = null): Promise<AssistantThreadJson> {
    return threadJson(await prisma.assistantThread.create({ data: { userId, title: threadTitle(firstText), ...(docId ? { docId } : {}) } }));
}

/** One message on a thread (the thread's updatedAt moves with it). */
export async function addMessage(
    userId: string,
    threadId: string,
    message: { role: 'user' | 'assistant'; text: string; tools?: ToolUseJson[]; usage?: Prisma.InputJsonValue; costUsd?: number | null }
): Promise<AssistantMessageJson> {
    const thread = await prisma.assistantThread.findFirst({ where: { id: threadId, userId }, select: { id: true } });
    if (!thread) throw notFound();
    const row = await prisma.assistantMessage.create({
        data: {
            threadId,
            role: message.role,
            text: message.text,
            tools: (message.tools ?? []) as unknown as Prisma.InputJsonValue,
            ...(message.usage !== undefined ? { usage: message.usage } : {}),
            ...(message.costUsd !== undefined && message.costUsd !== null ? { costUsd: message.costUsd.toFixed(6) } : {}),
        },
    });
    await prisma.assistantThread.update({ where: { id: threadId }, data: { updatedAt: new Date() }, select: { id: true } });
    const [json] = await withToolState(userId, [messageJson(row)]);
    return json!;
}

/** Threads with no message for THREAD_DAYS, deleted (the hourly job). */
export async function pruneThreads(now: Date = new Date()): Promise<number> {
    const { count } = await prisma.assistantThread.deleteMany({ where: { updatedAt: { lt: new Date(now.getTime() - THREAD_DAYS * 86_400_000) } } });
    return count;
}
