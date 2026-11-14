// Home's "From your agent": list the agent's edits, mark them seen (Keep), and Undo one.
//
// Undo by kind:
//   doc_append / doc_replace_section / doc_canvas_update   the agent's exact change is taken back,
//                                     live (later typing stays; a board's records as they were)
//   doc_create                        the doc is archived (its topic goes too unless already revised)
//   goal_create / milestone_add / focus_add / pocket_add   the row is deleted
//   goal_update / milestone_update / focus_update   the fields go back to their values before the edit
//   milestone_remove / focus_remove   the row comes back with its id (a milestone only if its goal is still there)
//   revision_schedule                 the scheduled revisions go (409 once one was done)
//   subject_create                    the subject goes (409 once it holds topics or notes)
// A row someone already deleted counts as undone. Each edit can be undone once.
import type { AgentEdit, GoalStatus } from '@prisma/client';
import { prisma } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { GOAL_ACTIVE_LIMIT } from '../learningDb/goals.service';
import { toDbDay } from '../learningDb/common';
import { isValidDay, type DayString } from '../learning/time';
import { isDocChange, serializeAgentEdit, type AgentEditJson } from './agentEditLog';
import { undoDocChange, undoDocCreate } from './agentDocs.service';

export const EDITS_LIMIT_DEFAULT = 20;
export const EDITS_LIMIT_MAX = 100;

/** GET /api/agent/edits?since=&unseen=&limit=: newest first. */
export async function listAgentEdits(
    userId: string,
    options: { since?: Date | undefined; unseen?: boolean | undefined; limit?: number | undefined } = {}
): Promise<AgentEditJson[]> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? EDITS_LIMIT_DEFAULT), 1), EDITS_LIMIT_MAX);
    const rows = await prisma.agentEdit.findMany({
        where: {
            userId,
            ...(options.since ? { createdAt: { gt: options.since } } : {}),
            ...(options.unseen ? { seenAt: null } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
    });
    return rows.map(serializeAgentEdit);
}

/** POST /api/agent/edits/seen {ids}: Home's "Keep". Ids of other users are ignored. */
export async function markAgentEditsSeen(userId: string, ids: readonly string[], now: Date = new Date()): Promise<{ updated: number }> {
    const { count } = await prisma.agentEdit.updateMany({ where: { userId, id: { in: [...ids] }, seenAt: null }, data: { seenAt: now } });
    return { updated: count };
}

/** POST /api/agent/edits/:id/undo. 404 for someone else's edit, 409 when already undone or no longer possible. */
export async function undoAgentEdit(userId: string, editId: string, now: Date = new Date()): Promise<AgentEditJson> {
    const edit = await prisma.agentEdit.findFirst({ where: { id: editId, userId } });
    if (!edit) throw new ErrorResponse(404, 'Agent edit not found');
    if (edit.undoneAt) throw new ErrorResponse(409, 'This edit was already undone');

    // Claim it first: two Undo clicks must not revert twice.
    const seenAt = edit.seenAt ?? now;
    const { count } = await prisma.agentEdit.updateMany({ where: { id: edit.id, undoneAt: null }, data: { undoneAt: now, seenAt } });
    if (count === 0) throw new ErrorResponse(409, 'This edit was already undone');
    try {
        await performUndo(userId, edit, now);
    } catch (err) {
        await prisma.agentEdit.updateMany({ where: { id: edit.id }, data: { undoneAt: null, seenAt: edit.seenAt } }).catch(() => {});
        throw err;
    }
    return serializeAgentEdit({ ...edit, undoneAt: now, seenAt });
}

type UndoData = Record<string, unknown>;

const stringOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const dayOrNull = (v: unknown): DayString | null => (typeof v === 'string' && isValidDay(v) ? (v as DayString) : null);

async function performUndo(userId: string, edit: AgentEdit, now: Date): Promise<void> {
    if (isDocChange(edit.kind)) return undoDocChange(userId, edit);
    if (edit.kind === 'doc_create') return undoDocCreate(userId, edit, now);

    const data = (edit.undoData ?? {}) as UndoData;
    const id = edit.entityId ?? '';
    switch (edit.kind) {
        case 'goal_create':
            await prisma.goal.deleteMany({ where: { id, userId } });
            return;
        case 'goal_update':
            return restoreGoal(userId, id, (data['before'] ?? {}) as UndoData, now);
        case 'milestone_add':
            await prisma.goalMilestone.deleteMany({ where: { id, goal: { userId } } });
            return;
        case 'milestone_update':
            return restoreMilestone(userId, id, (data['before'] ?? {}) as UndoData);
        case 'milestone_remove':
            return recreateMilestone(userId, (data['row'] ?? {}) as UndoData);
        case 'focus_add':
            await prisma.focusItem.deleteMany({ where: { id, userId } });
            return;
        case 'focus_update': {
            const before = (data['before'] ?? {}) as UndoData;
            await prisma.focusItem.updateMany({
                where: { id, userId },
                data: {
                    ...(typeof before['text'] === 'string' ? { text: before['text'] } : {}),
                    ...(typeof before['done'] === 'boolean' ? { done: before['done'] } : {}),
                },
            });
            return;
        }
        case 'focus_remove':
            return recreateFocus(userId, (data['row'] ?? {}) as UndoData);
        case 'path_plan': {
            const created = Array.isArray(data['created']) ? data['created'].filter((s): s is string => typeof s === 'string') : [];
            const kept = await prisma.topic.count({ where: { id: { in: created }, userId, OR: [{ status: { not: 'planned' } }, { docId: { not: null } }] } });
            if (kept > 0) throw new ErrorResponse(409, "Can't undo: a planned topic was started since");
            await prisma.topic.deleteMany({ where: { id: { in: created }, userId, status: 'planned', docId: null } });
            return;
        }
        case 'topic_update':
            return restoreTopic(userId, id, (data['before'] ?? {}) as UndoData);
        case 'pocket_add':
            await prisma.quickNote.deleteMany({ where: { id, userId } });
            return;
        case 'revision_schedule':
            return unscheduleRevisions(userId, data);
        case 'subject_create':
            return deleteEmptySubject(userId, id);
        default:
            throw new ErrorResponse(409, 'This edit cannot be undone');
    }
}

async function restoreGoal(userId: string, goalId: string, before: UndoData, now: Date): Promise<void> {
    await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        const goal = await tx.goal.findFirst({ where: { id: goalId, userId }, select: { id: true, status: true } });
        if (!goal) return; // deleted since: nothing to put back
        const status = ['active', 'done', 'archived'].includes(String(before['status'])) ? (before['status'] as GoalStatus) : undefined;
        if (status === 'active' && goal.status !== 'active') {
            const active = await tx.goal.count({ where: { userId, status: 'active' } });
            if (active >= GOAL_ACTIVE_LIMIT) throw new ErrorResponse(409, `Can't undo: ${GOAL_ACTIVE_LIMIT} goals are active already`);
        }
        const deadline = dayOrNull(before['deadline']);
        await tx.goal.update({
            where: { id: goalId },
            data: {
                ...(typeof before['title'] === 'string' ? { title: before['title'] } : {}),
                ...('why' in before ? { why: stringOrNull(before['why']) } : {}),
                ...(deadline ? { deadline: toDbDay(deadline) } : {}),
                ...(status ? { status } : {}),
                updatedAt: now,
            },
            select: { id: true },
        });
        if (Array.isArray(before['subjectIds'])) {
            const wanted = before['subjectIds'].filter((s): s is string => typeof s === 'string');
            const owned = await tx.subject.findMany({ where: { userId, id: { in: wanted } }, select: { id: true } });
            await tx.goalSubject.deleteMany({ where: { goalId } });
            if (owned.length > 0) await tx.goalSubject.createMany({ data: owned.map((s) => ({ goalId, subjectId: s.id })) });
        }
    });
}

async function restoreMilestone(userId: string, milestoneId: string, before: UndoData): Promise<void> {
    const dueDay = dayOrNull(before['dueDay']);
    const doneAt = typeof before['doneAt'] === 'string' ? new Date(before['doneAt']) : null;
    await prisma.goalMilestone.updateMany({
        where: { id: milestoneId, goal: { userId } },
        data: {
            ...(typeof before['title'] === 'string' ? { title: before['title'] } : {}),
            ...('dueDay' in before ? { dueDay: dueDay ? toDbDay(dueDay) : null } : {}),
            ...(typeof before['done'] === 'boolean' ? { done: before['done'], doneAt: before['done'] ? doneAt : null } : {}),
            ...(typeof before['sortOrder'] === 'number' ? { sortOrder: before['sortOrder'] } : {}),
        },
    });
}

const creator = (v: unknown): 'user' | 'agent' => (v === 'agent' ? 'agent' : 'user');

const TOPIC_STATUSES = ['planned', 'in_progress', 'done', 'skipped'] as const;

/** A topic's fields and its subject's order as they were before an agent changed them. */
async function restoreTopic(userId: string, topicId: string, before: UndoData): Promise<void> {
    const status = TOPIC_STATUSES.find((s) => s === before['status']);
    const date = (v: unknown) => (typeof v === 'string' ? new Date(v) : null);
    await prisma.$transaction(async (tx) => {
        await tx.topic.updateMany({
            where: { id: topicId, userId },
            data: {
                ...(typeof before['title'] === 'string' ? { title: before['title'] } : {}),
                ...(status ? { status } : {}),
                ...('nextStep' in before ? { nextStep: stringOrNull(before['nextStep']) } : {}),
                ...('startedAt' in before ? { startedAt: date(before['startedAt']) } : {}),
                ...('doneAt' in before ? { doneAt: date(before['doneAt']) } : {}),
            },
        });
        const places = (before['places'] ?? {}) as Record<string, unknown>;
        for (const [id, place] of Object.entries(places)) {
            await tx.topic.updateMany({ where: { id, userId }, data: { sortOrder: typeof place === 'number' ? place : null } });
        }
    });
}

/** Puts a removed milestone back with its id; nothing when it is back already or its goal is gone. */
async function recreateMilestone(userId: string, row: UndoData): Promise<void> {
    const id = stringOrNull(row['id']);
    const goalId = stringOrNull(row['goalId']);
    if (!id || !goalId || typeof row['title'] !== 'string') throw new ErrorResponse(409, 'This edit cannot be undone');
    const goal = await prisma.goal.findFirst({ where: { id: goalId, userId }, select: { id: true } });
    if (!goal) throw new ErrorResponse(409, "Can't undo: the goal is gone");
    if (await prisma.goalMilestone.findUnique({ where: { id }, select: { id: true } })) return;
    const dueDay = dayOrNull(row['dueDay']);
    const done = row['done'] === true;
    await prisma.goalMilestone.create({
        data: {
            id,
            goalId,
            title: row['title'],
            dueDay: dueDay ? toDbDay(dueDay) : null,
            done,
            doneAt: done && typeof row['doneAt'] === 'string' ? new Date(row['doneAt']) : null,
            sortOrder: typeof row['sortOrder'] === 'number' ? row['sortOrder'] : 0,
            createdBy: creator(row['createdBy']),
            agentName: stringOrNull(row['agentName']),
        },
    });
}

/** Puts a removed focus line back with its id, on its day; nothing when it is back already. */
async function recreateFocus(userId: string, row: UndoData): Promise<void> {
    const id = stringOrNull(row['id']);
    const day = dayOrNull(row['day']);
    if (!id || !day || typeof row['text'] !== 'string') throw new ErrorResponse(409, 'This edit cannot be undone');
    if (await prisma.focusItem.findUnique({ where: { id }, select: { id: true } })) return;
    await prisma.focusItem.create({
        data: {
            id,
            userId,
            day: toDbDay(day),
            text: row['text'],
            done: row['done'] === true,
            sortOrder: typeof row['sortOrder'] === 'number' ? row['sortOrder'] : 0,
            createdBy: creator(row['createdBy']),
            agentName: stringOrNull(row['agentName']),
        },
    });
}

async function unscheduleRevisions(userId: string, data: UndoData): Promise<void> {
    const revisionIds = Array.isArray(data['revisionIds']) ? data['revisionIds'].filter((s): s is string => typeof s === 'string') : [];
    const topicId = stringOrNull(data['topicId']);
    const createdTopic = data['createdTopic'] === true && topicId !== null;
    const done = await prisma.revision.count({
        where: createdTopic ? { topicId: topicId!, userId, status: 'done' } : { id: { in: revisionIds }, userId, status: 'done' },
    });
    if (done > 0) throw new ErrorResponse(409, "Can't undo: it was already revised");
    if (createdTopic) {
        await prisma.topic.deleteMany({ where: { id: topicId!, userId } }); // its revisions go with it
    } else if (revisionIds.length > 0) {
        await prisma.revision.deleteMany({ where: { id: { in: revisionIds }, userId, status: 'pending' } });
    }
}

async function deleteEmptySubject(userId: string, subjectId: string): Promise<void> {
    const subject = await prisma.subject.findFirst({
        where: { id: subjectId, userId },
        select: { id: true, _count: { select: { topics: true, captures: true } } },
    });
    if (!subject) return;
    if (subject._count.topics + subject._count.captures > 0) throw new ErrorResponse(409, "Can't undo: the subject holds topics or notes now");
    await prisma.subject.deleteMany({ where: { id: subjectId, userId } });
}
