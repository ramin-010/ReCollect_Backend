// TOOL_ACCESS_PLAN §4.7 (11-27): a chat renames or describes a subject, or deletes one.
//   PATCH /api/agent/subjects/:id { name?, description? }   learning:write; Undo puts the old values back
//   POST  /api/agent/subjects/:id/delete { reason? }        learning:write
// A subject that holds nothing (no topics, notes or docs) is deleted at once through the app's own subject deletion,
// and Undo is that deletion's undo. One that holds something only asks: a "Do it" card on Home (the delete_subject
// action), and only their tap deletes it (with the app's week of undo). The subject may be named by id or by name.
import { prisma } from '../../db/prisma';
import { LearningHttpError } from '../learning/http';
import { deleteSubjectWithUndo, deletionPreview, undoSubjectDeletion } from '../learningDb/subjectDeletion.service';
import { requestAction } from '../actions/actions.service';
import { quoted, recordAgentEdit, type AgentActor } from './agentEditLog';

/** A subject of theirs by id, else by name (any case). */
export async function subjectOf(userId: string, idOrName: string): Promise<{ id: string; name: string; description: string | null }> {
    const key = idOrName.trim();
    const select = { id: true, name: true, description: true } as const;
    const row = (await prisma.subject.findFirst({ where: { id: key, userId }, select })) ?? (await prisma.subject.findFirst({ where: { userId, name: { equals: key, mode: 'insensitive' } }, select }));
    if (row) return row;
    const all = await prisma.subject.findMany({ where: { userId }, select: { name: true }, orderBy: { name: 'asc' }, take: 30 });
    throw new LearningHttpError(404, 'NOT_FOUND', `No subject ${quoted(key, 80)}.${all.length ? ` Their subjects: ${all.map((s) => s.name).join(', ')}.` : ' They have no subjects yet.'}`);
}

/** PATCH /api/agent/subjects/:id → the subject, with editId. */
export async function updateSubjectForAgent(actor: AgentActor, idOrName: string, input: { name?: string | undefined; description?: string | null | undefined }) {
    const s = await subjectOf(actor.userId, idOrName);
    const name = input.name?.trim();
    if (input.name !== undefined && !name) throw new LearningHttpError(400, 'EMPTY', 'A subject needs a name.');
    if (name && name.toLowerCase() !== s.name.toLowerCase()) {
        const clash = await prisma.subject.findFirst({ where: { userId: actor.userId, id: { not: s.id }, name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
        if (clash) throw new LearningHttpError(409, 'SUBJECT_EXISTS', `They already have a subject named ${quoted(name, 80)}.`);
    }
    const description = input.description === undefined ? undefined : input.description?.trim() ? input.description.trim().slice(0, 500) : null;
    const changes = [name !== undefined && name !== s.name ? `renamed it ${quoted(name, 60)}` : null, description !== undefined && description !== s.description ? (description ? 'set its description' : 'cleared its description') : null].filter(Boolean);
    if (!changes.length) return { id: s.id, name: s.name, description: s.description, editId: null };
    const editId = await prisma.$transaction(async (tx) => {
        await tx.subject.update({ where: { id: s.id }, data: { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}) }, select: { id: true } });
        return recordAgentEdit(actor, { kind: 'subject_update', summary: `Subject ${quoted(s.name, 60)}: ${changes.join(', ')}`, entityId: s.id, undoData: { before: { name: s.name, description: s.description } } }, tx);
    });
    return { id: s.id, name: name ?? s.name, description: description === undefined ? s.description : description, editId };
}

/** POST /api/agent/subjects/:id/delete → deleted at once (empty), or a card that waits for their tap. */
export async function deleteSubjectForAgent(actor: AgentActor, idOrName: string, input: { reason?: string | undefined }) {
    const s = await subjectOf(actor.userId, idOrName);
    const { counts, undoDays } = await deletionPreview(actor.userId, s.id);
    const holds = counts.topics + counts.notes + counts.docs;
    if (holds > 0) {
        const card = await requestAction(actor.userId, actor.agentName, { action: 'delete_subject', input: { subjectId: s.id }, reason: input.reason ?? null });
        return { id: s.id, name: s.name, deleted: false as const, asked: true as const, suggestionId: card.id, text: card.text, counts };
    }
    const deletion = await deleteSubjectWithUndo(actor.userId, s.id);
    const editId = await recordAgentEdit(actor, { kind: 'subject_delete', summary: `Deleted the empty subject ${quoted(s.name, 60)}`, entityId: s.id, undoData: { deletionId: deletion._id } });
    return { id: s.id, name: s.name, deleted: true as const, asked: false as const, editId, undoDays };
}

// ─── Undo (agentEdits.service.ts) ────────────────────────────────────

type Json = Record<string, unknown>;

export async function undoSubjectUpdate(userId: string, id: string, before: Json): Promise<void> {
    await prisma.subject.updateMany({
        where: { id, userId },
        data: { ...(typeof before['name'] === 'string' ? { name: before['name'] } : {}), description: typeof before['description'] === 'string' ? before['description'] : null },
    });
}

export async function undoSubjectDelete(userId: string, data: Json): Promise<void> {
    const deletionId = typeof data['deletionId'] === 'string' ? data['deletionId'] : null;
    if (!deletionId) throw new LearningHttpError(409, 'CANNOT_UNDO', 'This edit cannot be undone');
    await undoSubjectDeletion(userId, deletionId);
}
