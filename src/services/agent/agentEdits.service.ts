// Home's "From your agent": list the agent's edits, mark them seen (Keep), and Undo one.
//
// Undo by kind:
//   doc_append / doc_replace_section / doc_canvas_update   the agent's exact change is taken back,
//                                     live (later typing stays; a board's records as they were)
//   doc_create                        the doc is archived (its topic goes too unless already revised;
//                                     a planned topic it was attached to is put back as it was)
//   doc_update                        the topic change goes back, then the title (if not renamed since)
//   goal_create / milestone_add / focus_add / pocket_add / week_target_create   the row is deleted
//   pocket_add with undoData.note    a chat's note edit (STUDY_FLOW_PLAN §4.3): an added note goes, a change goes
//                                     back, a removed (or merged) note comes back with its id and reviews
//   doc_blocks with undoData.card    the revision card's blocks go back, and its pointer with them
//   goal_update / milestone_update / focus_update   the fields go back to their values before the edit
//   milestone_remove / focus_remove   the row comes back with its id (a milestone only if its goal is still there)
//   revision_schedule                 the scheduled revisions go (409 once one was done)
//   subject_create                    the subject goes (409 once it holds topics or notes)
// A row someone already deleted counts as undone. Each edit can be undone once.
import type { AgentEdit, AgentEditKind, GoalStatus } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { undoPocketDelete, undoPocketUpdate } from './agentPocket.service';
import { undoSubjectDelete, undoSubjectUpdate } from './agentSubjects.service';
import { undoNoteFileAdd, undoNoteFileRemove } from './agentNoteFiles.service';
import ErrorResponse from '../../utils/errorResponse';
import { GOAL_ACTIVE_LIMIT } from '../learningDb/goals.service';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { rescheduleRevisionForUser, uncompleteRevisionForUser } from '../learningDb/revisions.service';
import { updateProject } from '../learningDb/sessions.service';
import { updateLearningSettings } from '../learningDb/settings.service';
import { restoreDoc, trashDoc } from '../docs/trash.service';
import { restoreReminder, unsetReminder } from '../tasks/taskReminders.service';
import { isValidDay, type DayString } from '../learning/time';
import { serializeAgentEdit, type AgentEditJson } from './agentEditLog';
import { undoDocChange, undoDocCreate, undoDocUpdate } from './agentDocs.service';
import { undoMemoryClose } from '../buddy/memory.service';
import { undoNoteEdit } from './agentNotes.service';
import { undoCardPointer } from './docCard';

export const EDITS_LIMIT_DEFAULT = 20;
export const EDITS_LIMIT_MAX = 100;

/**
 * GET /api/agent/doc-activity (the library's "From agents" view): each doc an agent wrote or
 * changed and that change still stands (not undone; the edit log keeps 90 days), with its latest
 * time and how many such changes. "You" (the app acting for him) doesn't count. Newest first.
 */
export async function docsFromAgents(userId: string): Promise<Array<{ docId: string; lastAt: Date; edits: number }>> {
    const rows = await prisma.agentEdit.groupBy({
        by: ['docId'],
        where: { userId, docId: { not: null }, undoneAt: null, NOT: { agentName: 'You' } },
        _max: { createdAt: true },
        _count: { _all: true },
    });
    return rows
        .filter((r): r is typeof r & { docId: string } => !!r.docId && !!r._max.createdAt)
        .map((r) => ({ docId: r.docId, lastAt: r._max.createdAt!, edits: r._count._all }))
        .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
}

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

interface UndoContext {
    userId: string;
    edit: AgentEdit;
    /** edit.undoData, or {}. */
    data: UndoData;
    /** edit.entityId, or ''. */
    id: string;
    now: Date;
}

/**
 * One Undo per kind of agent write. Keyed by every AgentEditKind, so a new kind without an Undo
 * is a type error (SYNC_SPINE_SPEC 0.4; tests/unit/agent/agentWrites.test.ts checks the routes).
 */
const UNDO: Record<AgentEditKind, (ctx: UndoContext) => Promise<void>> = {
    doc_create: ({ userId, edit, now }) => undoDocCreate(userId, edit, now),
    doc_append: ({ userId, edit }) => undoDocChange(userId, edit),
    doc_replace_section: ({ userId, edit }) => undoDocChange(userId, edit),
    doc_canvas_update: ({ userId, edit }) => undoDocChange(userId, edit),
    doc_blocks: async ({ userId, edit, data }) => {
        await undoDocChange(userId, edit);
        await undoCardPointer(edit.docId, data);
    },
    doc_update: ({ userId, edit }) => undoDocUpdate(userId, edit),
    goal_create: async ({ userId, id }) => {
        await prisma.goal.deleteMany({ where: { id, userId } });
    },
    goal_update: ({ userId, id, data, now }) => restoreGoal(userId, id, (data['before'] ?? {}) as UndoData, now),
    milestone_add: async ({ userId, id }) => {
        await prisma.goalMilestone.deleteMany({ where: { id, goal: { userId } } });
    },
    milestone_update: ({ userId, id, data }) => restoreMilestone(userId, id, (data['before'] ?? {}) as UndoData),
    milestone_remove: ({ userId, data }) => recreateMilestone(userId, (data['row'] ?? {}) as UndoData),
    focus_add: async ({ userId, id }) => {
        await prisma.focusItem.deleteMany({ where: { id, userId } });
    },
    focus_update: async ({ userId, id, data }) => {
        const before = (data['before'] ?? {}) as UndoData;
        await prisma.focusItem.updateMany({
            where: { id, userId },
            data: {
                ...(typeof before['text'] === 'string' ? { text: before['text'] } : {}),
                ...(typeof before['done'] === 'boolean' ? { done: before['done'] } : {}),
            },
        });
    },
    focus_remove: ({ userId, data }) => recreateFocus(userId, (data['row'] ?? {}) as UndoData),
    decision_create: async ({ userId, id }) => {
        await prisma.decision.deleteMany({ where: { id, userId } });
    },
    decision_update: async ({ userId, id, data }) => {
        const b = (data['before'] ?? {}) as UndoData;
        const day = dayOrNull(b['lookAgainDay']);
        await prisma.decision.updateMany({
            where: { id, userId },
            data: {
                ...(typeof b['title'] === 'string' ? { title: b['title'] } : {}),
                ...(typeof b['why'] === 'string' ? { why: b['why'] } : {}),
                expect: stringOrNull(b['expect']),
                ...(day ? { lookAgainDay: toDbDay(day) } : {}),
                ...(b['status'] === 'open' || b['status'] === 'reviewed' ? { status: b['status'] } : {}),
                verdict: b['verdict'] === 'right' || b['verdict'] === 'wrong' || b['verdict'] === 'mixed' ? b['verdict'] : null,
                verdictNote: stringOrNull(b['verdictNote']),
                reviewedAt: typeof b['reviewedAt'] === 'string' ? new Date(b['reviewedAt']) : null,
            },
        });
    },
    // ── The manager's tools (stage 4) ──
    doc_trash: async ({ userId, id }) => {
        await restoreDoc(userId, id);
    },
    doc_restore: async ({ userId, id }) => {
        await trashDoc(userId, id);
    },
    revision_complete: async ({ userId, id, now }) => {
        const rev = await prisma.revision.findFirst({ where: { id, userId }, select: { status: true } });
        if (rev?.status !== 'done') throw new ErrorResponse(409, "Can't undo: that review isn't marked done any more");
        await uncompleteRevisionForUser(userId, id, now);
    },
    revision_reschedule: async ({ userId, id, data, now }) => {
        const from = dayOrNull(data['from']);
        const to = dayOrNull(data['to']);
        const rev = await prisma.revision.findFirst({ where: { id, userId }, select: { status: true, scheduledFor: true } });
        if (!rev || !from || rev.status !== 'pending' || fromDbDay(rev.scheduledFor) !== to) throw new ErrorResponse(409, "Can't undo: that review has changed since");
        // Its old day may be past by now: today at the earliest.
        const { today } = await loadLearningContext(userId, now);
        await rescheduleRevisionForUser(userId, id, from < today ? today : from, now);
    },
    settings_update: async ({ userId, data, now }) => {
        const b = (data['before'] ?? {}) as UndoData;
        await updateLearningSettings(
            userId,
            {
                ...(typeof b['dailyBudgetMin'] === 'number' ? { dailyBudgetMin: b['dailyBudgetMin'] } : {}),
                ...('busyUntil' in b ? { busyUntil: dayOrNull(b['busyUntil']) } : {}),
                ...(typeof b['nudgeEmailEnabled'] === 'boolean' ? { nudgeEmailEnabled: b['nudgeEmailEnabled'] } : {}),
                ...(typeof b['nudgeTime'] === 'string' ? { nudgeTime: b['nudgeTime'] } : {}),
                ...('agentProfile' in b ? { agentProfile: stringOrNull(b['agentProfile']) } : {}),
            },
            now
        );
    },
    project_update: async ({ userId, id, data }) => {
        const b = (data['before'] ?? {}) as UndoData;
        await updateProject(userId, id, {
            ...(typeof b['name'] === 'string' ? { name: b['name'] } : {}),
            goalId: stringOrNull(b['goalId']),
            ...(typeof b['isArchived'] === 'boolean' ? { isArchived: b['isArchived'] } : {}),
            nextStep: stringOrNull(b['nextStep']),
            // PERSONAL_OFFICE_PLAN: a folder's kind back (its past sessions move back with it).
            ...(b['kind'] === 'personal' || b['kind'] === 'study' || b['kind'] === 'work' ? { kind: b['kind'] } : {}),
            // EASY_SETUP_PLAN: what was logged there (null: its kind's default); an older edit without it leaves it.
            ...('tracking' in b ? { tracking: b['tracking'] === 'full' || b['tracking'] === 'light' || b['tracking'] === 'off' ? b['tracking'] : null } : {}),
        });
    },
    reminder_set: async ({ userId, id, data }) => {
        const b = data['before'] as { at?: unknown; ring?: unknown; repeat?: unknown } | null | undefined;
        const before = b && typeof b.at === 'string' ? { at: b.at, ring: b.ring === true, repeat: typeof b.repeat === 'string' ? b.repeat : null } : null;
        await unsetReminder(userId, id, stringOrNull(data['createdTaskId']), before);
    },
    reminder_cancel: async ({ userId, id, now }) => {
        await restoreReminder(userId, id, now);
    },
    revisions_spread: async ({ userId, data }) => {
        // Each review back on its old day, unless it was done or moved since.
        const changes = (Array.isArray(data['changes']) ? data['changes'] : []) as Array<{ id?: unknown; from?: unknown; to?: unknown }>;
        let back = 0;
        for (const c of changes) {
            const from = dayOrNull(c.from);
            const to = dayOrNull(c.to);
            if (typeof c.id !== 'string' || !from || !to) continue;
            const { count } = await prisma.revision.updateMany({ where: { id: c.id, userId, status: 'pending', scheduledFor: toDbDay(to) }, data: { scheduledFor: toDbDay(from) } });
            back += count;
        }
        if (back === 0 && changes.length > 0) throw new ErrorResponse(409, "Can't undo: those reviews were done or moved since");
    },
    task_create: async ({ userId, id }) => {
        await prisma.todo.deleteMany({ where: { id, userId, workspaceId: null } });
    },
    task_update: async ({ userId, id, data, now }) => {
        const before = (data['before'] ?? {}) as UndoData;
        const status = before['status'];
        const priority = before['priority'];
        // Stage 5b: a task the buddy ticked from his words had its reminders still to come cancelled: back with it.
        const reminders = (Array.isArray(data['reminders']) ? data['reminders'] : []).filter((r): r is string => typeof r === 'string');
        if (reminders.length) await prisma.reminder.updateMany({ where: { id: { in: reminders }, userId, status: 'cancelled', reminderDate: { gt: now } }, data: { status: 'pending', emailSent: false, phoneAt: null } });
        await prisma.todo.updateMany({
            where: { id, userId, workspaceId: null },
            data: {
                ...(typeof before['title'] === 'string' ? { title: before['title'] } : {}),
                ...(typeof status === 'string' && ['pending', 'in_progress', 'review', 'blocked', 'complete'].includes(status) ? { status: status as 'pending' } : {}),
                ...(typeof priority === 'string' && ['low', 'normal', 'medium', 'high', 'urgent'].includes(priority) ? { priority: priority as 'normal' } : {}),
                dueDate: typeof before['dueDate'] === 'string' ? new Date(before['dueDate']) : null,
                completedAt: typeof before['completedAt'] === 'string' ? new Date(before['completedAt']) : null,
            },
        });
    },
    week_target_create: async ({ userId, id }) => {
        await prisma.weekTarget.deleteMany({ where: { id, userId } });
    },
    week_target_update: async ({ userId, id, data }) => {
        const before = (data['before'] ?? {}) as UndoData;
        const status = before['status'];
        await prisma.weekTarget.updateMany({
            where: { id, userId },
            data: {
                ...(typeof before['text'] === 'string' ? { text: before['text'] } : {}),
                ...(status === 'open' || status === 'done' || status === 'dropped' ? { status, doneAt: typeof before['doneAt'] === 'string' ? new Date(before['doneAt']) : null } : {}),
                ...(typeof before['sortOrder'] === 'number' ? { sortOrder: before['sortOrder'] } : {}),
            },
        });
    },
    path_plan: async ({ userId, data }) => {
        const created = Array.isArray(data['created']) ? data['created'].filter((s): s is string => typeof s === 'string') : [];
        const kept = await prisma.topic.count({ where: { id: { in: created }, userId, OR: [{ status: { not: 'planned' } }, { docId: { not: null } }] } });
        if (kept > 0) throw new ErrorResponse(409, "Can't undo: a planned topic was started since");
        await prisma.topic.deleteMany({ where: { id: { in: created }, userId, status: 'planned', docId: null } });
    },
    topic_update: ({ userId, id, data }) => restoreTopic(userId, id, (data['before'] ?? {}) as UndoData),
    pocket_add: async ({ userId, id, data }) => {
        const note = data['note'];
        if (note && typeof note === 'object') return undoNoteEdit(userId, id, note as UndoData);
        await prisma.quickNote.deleteMany({ where: { id, userId } });
    },
    revision_schedule: ({ userId, data }) => unscheduleRevisions(userId, data),
    subject_create: ({ userId, id }) => deleteEmptySubject(userId, id),
    // The buddy: an agent's forget is undone by making the memory active again (409 if he changed it).
    // A correction (MCP_MEMORY_PLAN §4.3) is a close with `replacedBy`: its Undo also takes the new version away.
    memory_close: ({ userId, id, data }) => undoMemoryClose(userId, id, (data['before'] ?? {}) as UndoData, data),
    // TOOL_ACCESS_PLAN §4.7: a pocket note's text and pin go back, a deleted one comes back with its id; a subject's
    // name and description go back, a deleted (empty) one comes back through the app's own undo.
    pocket_update: ({ userId, id, data }) => undoPocketUpdate(userId, id, (data['before'] ?? {}) as UndoData),
    pocket_delete: ({ userId, id, data }) => undoPocketDelete(userId, id, (data['before'] ?? {}) as UndoData),
    subject_update: ({ userId, id, data }) => undoSubjectUpdate(userId, id, (data['before'] ?? {}) as UndoData),
    subject_delete: ({ userId, data }) => undoSubjectDelete(userId, data),
    // TOOL_ACCESS_PLAN §11: a file on a note.
    note_file_add: ({ userId, id, data }) => undoNoteFileAdd(userId, id, data),
    note_file_remove: ({ userId, id, data }) => undoNoteFileRemove(userId, id, data),
};

async function performUndo(userId: string, edit: AgentEdit, now: Date): Promise<void> {
    const undo = UNDO[edit.kind];
    if (!undo) throw new ErrorResponse(409, 'This edit cannot be undone');
    return undo({ userId, edit, data: (edit.undoData ?? {}) as UndoData, id: edit.entityId ?? '', now });
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
