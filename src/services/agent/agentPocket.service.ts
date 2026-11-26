// TOOL_ACCESS_PLAN §4.7 (11-27): chats read, change and delete the person's pocket notes (Home's quick private notes),
// only while they allow it (Settings › Agents, User.pocketForAgents, off by default). Until then agents may add a
// pocket note and nothing more: these answer 403 POCKET_PRIVATE and change nothing. Every change is an agent edit with
// an Undo (pocket_update puts the text and pin back; pocket_delete brings the note back with its id). Their files stay
// in storage while the edit can be undone.
//
//   GET   /api/agent/pocket [?id=] [&limit=]          read
//   PATCH /api/agent/pocket/:id { text?, pinned? }    learning:write
//   POST  /api/agent/pocket/:id/delete               learning:write
import type { Prisma, QuickNote } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { LearningHttpError, notFound } from '../learning/http';
import { quoted, recordAgentEdit, type AgentActor } from './agentEditLog';

export const POCKET_PRIVATE = 'Their pocket notes are private. They can allow it in Settings › Agents.';
/** A note's text in a list; `id` reads one in full. */
const PREVIEW = 300;
export const POCKET_TEXT_MAX = 100_000;

async function assertOpen(userId: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { pocketForAgents: true } });
    if (!user?.pocketForAgents) throw new LearningHttpError(403, 'POCKET_PRIVATE', POCKET_PRIVATE);
}

const filesOf = (attachments: unknown): Array<{ fileName: string }> => (Array.isArray(attachments) ? (attachments as Array<{ fileName?: unknown }>).map((a) => ({ fileName: String(a.fileName ?? 'file') })) : []);

function pocketJson(n: QuickNote, full: boolean) {
    const text = full || n.content.length <= PREVIEW ? n.content : `${n.content.slice(0, PREVIEW)}…`;
    return { id: n.id, text, cut: !full && n.content.length > PREVIEW, pinned: n.isPinned, day: n.createdAt.toISOString().slice(0, 10), files: filesOf(n.attachments).map((f) => f.fileName) };
}

/** GET /api/agent/pocket: pinned first, then newest; one note in full with id. */
export async function listPocketForAgent(userId: string, input: { id?: string | undefined; limit?: number | undefined }) {
    await assertOpen(userId);
    if (input.id) {
        const one = await prisma.quickNote.findFirst({ where: { id: input.id, userId } });
        if (!one) throw notFound();
        return { notes: [pocketJson(one, true)], total: 1 };
    }
    const take = Math.min(Math.max(input.limit ?? 30, 1), 100);
    const [rows, total] = await Promise.all([prisma.quickNote.findMany({ where: { userId }, orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }], take }), prisma.quickNote.count({ where: { userId } })]);
    return { notes: rows.map((n) => pocketJson(n, false)), total };
}

/** PATCH /api/agent/pocket/:id { text?, pinned? } → the note, with editId. */
export async function updatePocketForAgent(actor: AgentActor, id: string, input: { text?: string | undefined; pinned?: boolean | undefined }) {
    await assertOpen(actor.userId);
    const row = await prisma.quickNote.findFirst({ where: { id, userId: actor.userId } });
    if (!row) throw notFound();
    const data: Prisma.QuickNoteUpdateInput = {};
    if (input.text !== undefined) {
        const text = input.text.trim();
        if (!text && filesOf(row.attachments).length === 0) throw new LearningHttpError(400, 'EMPTY', 'A pocket note cannot be empty: delete it instead (delete_pocket_note).');
        data.content = text.slice(0, POCKET_TEXT_MAX);
    }
    if (input.pinned !== undefined) data.isPinned = input.pinned;
    if (!Object.keys(data).length) throw new LearningHttpError(400, 'NOTHING_TO_CHANGE', 'Nothing to change: send text, pinned, or both.');
    const what = [input.text !== undefined && input.text.trim() !== row.content ? 'changed' : null, input.pinned !== undefined && input.pinned !== row.isPinned ? (input.pinned ? 'pinned' : 'unpinned') : null].filter(Boolean);
    const editId = await prisma.$transaction(async (tx) => {
        await tx.quickNote.update({ where: { id }, data, select: { id: true } });
        if (!what.length) return null;
        return recordAgentEdit(actor, { kind: 'pocket_update', summary: `${what.join(' and ').replace(/^./, (c) => c.toUpperCase())} the pocket note ${quoted(row.content, 60)}`, entityId: id, undoData: { before: { content: row.content, isPinned: row.isPinned } } }, tx);
    });
    const after = await prisma.quickNote.findUniqueOrThrow({ where: { id } });
    return { ...pocketJson(after, true), editId };
}

/** POST /api/agent/pocket/:id/delete → { id, deleted: true, editId } (Undo brings it back). */
export async function deletePocketForAgent(actor: AgentActor, id: string) {
    await assertOpen(actor.userId);
    const row = await prisma.quickNote.findFirst({ where: { id, userId: actor.userId } });
    if (!row) throw notFound();
    const before = { content: row.content, isPinned: row.isPinned, category: row.category, attachments: row.attachments, createdAt: row.createdAt.toISOString() } as Prisma.InputJsonValue;
    const editId = await prisma.$transaction(async (tx) => {
        await tx.quickNote.deleteMany({ where: { id, userId: actor.userId } });
        return recordAgentEdit(actor, { kind: 'pocket_delete', summary: `Deleted the pocket note ${quoted(row.content, 60)}`, entityId: id, undoData: { before } }, tx);
    });
    return { id, deleted: true as const, editId };
}

// ─── Undo (agentEdits.service.ts) ────────────────────────────────────

type Json = Record<string, unknown>;

export async function undoPocketUpdate(userId: string, id: string, before: Json): Promise<void> {
    await prisma.quickNote.updateMany({
        where: { id, userId },
        data: { ...(typeof before['content'] === 'string' ? { content: before['content'] } : {}), ...(typeof before['isPinned'] === 'boolean' ? { isPinned: before['isPinned'] } : {}) },
    });
}

export async function undoPocketDelete(userId: string, id: string, before: Json): Promise<void> {
    if (await prisma.quickNote.findUnique({ where: { id }, select: { id: true } })) return; // back already
    await prisma.quickNote.create({
        data: {
            id,
            userId,
            content: typeof before['content'] === 'string' ? before['content'] : '',
            isPinned: before['isPinned'] === true,
            ...(before['category'] === 'PRIMARY' || before['category'] === 'TEMPORARY' ? { category: before['category'] } : {}),
            attachments: (before['attachments'] ?? []) as Prisma.InputJsonValue,
            ...(typeof before['createdAt'] === 'string' ? { createdAt: new Date(before['createdAt']) } : {}),
        },
    });
}
