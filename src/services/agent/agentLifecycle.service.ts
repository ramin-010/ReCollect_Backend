// TOOL_ACCESS_PLAN §12.4 (11-27): what an AI can add, it can change and take back. Each of these is an agent edit
// with an Undo (Home → From your agent); nothing here deletes for good. A topic that holds anything only asks (the
// delete_topic action: their tap).
//
//   POST  /api/agent/tasks/:id/delete                 tasks:write     task_delete (Undo: back with its id, reminders, tags)
//   POST  /api/agent/decisions/:id/delete             learning:write  decision_delete (Undo: back with its id)
//   POST  /api/agent/topics/:id/remove { reason? }    learning:write  topic_delete when planned and empty, else asks
//   POST  /api/agent/docs/:id/stop-revision           learning:write  revision_stop (its coming reviews go; done stay)
//   POST  /api/agent/revisions/:id/uncomplete         learning:write  revision_uncomplete (Undo: done again)
//   PATCH /api/agent/sessions/:id { minutes?, day?, title?, kind? }   sessions:write  session_update
//   POST  /api/agent/sessions/:id/delete              sessions:write  session_delete (Undo: back with its id)
import type { Prisma, SessionKind } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { LearningHttpError } from '../learning/http';
import { fromDbDay, toDbDay } from '../learningDb/common';
import { completeRevisionForUser, uncompleteRevisionForUser } from '../learningDb/revisions.service';
import { deleteSession, updateSession } from '../learningDb/sessions.service';
import { isValidDay, type DayString } from '../learning/time';
import { requestAction } from '../actions/actions.service';
import { plural, quoted, recordAgentEdit, type AgentActor } from './agentEditLog';

type Json = Record<string, unknown>;

/** A row as JSON for undoData: dates as ISO strings, the rest as it is. */
function snapshot(row: Record<string, unknown>, leave: readonly string[] = []): Json {
    const out: Json = {};
    for (const [k, v] of Object.entries(row)) {
        if (leave.includes(k) || v === undefined) continue;
        out[k] = v instanceof Date ? v.toISOString() : v;
    }
    return out;
}

/** The snapshot's date fields back as dates; a nullable JSON column that was null is left out (Prisma takes no plain null there). */
function revive<T extends Json>(row: T, dates: readonly string[], nullableJson: readonly string[] = []): T {
    const out: Json = { ...row };
    for (const k of dates) if (typeof out[k] === 'string') out[k] = new Date(out[k] as string);
    for (const k of nullableJson) if (out[k] === null) delete out[k];
    return out as T;
}

const gone = (what: string, how: string) => new LearningHttpError(404, 'NOT_FOUND', `No ${what} with that id. ${how}`);

const minutesWords = (m: number | null | undefined): string => {
    if (m === null || m === undefined) return 'no minutes';
    const h = Math.floor(m / 60);
    return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
};

// ─── Tasks ────────────────────────────────────────────────────────────

const TODO_DATES = ['dueDate', 'reminderDate', 'completedAt', 'assignedAt', 'createdAt', 'updatedAt'] as const;
const REMINDER_DATES = ['reminderDate', 'phoneAt', 'createdAt', 'updatedAt'] as const;

/** A personal task an agent deleted: Undo brings it back with its id, its reminders and its tags. */
export async function deleteTaskForAgent(actor: AgentActor, id: string) {
    const row = await prisma.todo.findFirst({ where: { id, userId: actor.userId, workspaceId: null }, include: { reminders: true, tags: { select: { tagId: true } }, weekTargets: { select: { id: true } } } });
    if (!row) throw gone('task', 'list_tasks shows their tasks with ids.');
    const { reminders, tags, weekTargets, ...todo } = row;
    const undoData = {
        row: snapshot(todo),
        reminders: reminders.map((r) => snapshot(r)),
        tagIds: tags.map((t) => t.tagId),
        weekTargetIds: weekTargets.map((w) => w.id),
    } as Prisma.InputJsonValue;
    const editId = await prisma.$transaction(async (tx) => {
        await tx.todo.deleteMany({ where: { id, userId: actor.userId, workspaceId: null } });
        return recordAgentEdit(actor, { kind: 'task_delete', summary: `Deleted the task ${quoted(row.title, 60)}`, entityId: id, undoData }, tx);
    });
    return { id, title: row.title, deleted: true as const, reminders: reminders.filter((r) => r.status === 'pending').length, editId };
}

export async function undoTaskDelete(userId: string, id: string, data: Json): Promise<void> {
    if (await prisma.todo.findUnique({ where: { id }, select: { id: true } })) return; // back already
    const row = revive((data['row'] ?? {}) as Json, TODO_DATES, ['recurrence']);
    await prisma.$transaction(async (tx) => {
        await tx.todo.create({ data: { ...(row as Prisma.TodoUncheckedCreateInput), id, userId, workspaceId: null, spaceId: null } });
        for (const r of (Array.isArray(data['reminders']) ? data['reminders'] : []) as Json[]) {
            await tx.reminder.create({ data: { ...(revive(r, REMINDER_DATES) as Prisma.ReminderUncheckedCreateInput), userId, todoId: id } });
        }
        const tagIds = (Array.isArray(data['tagIds']) ? data['tagIds'] : []).filter((t): t is string => typeof t === 'string');
        const tags = await tx.tag.findMany({ where: { id: { in: tagIds } }, select: { id: true } });
        if (tags.length) await tx.todoTag.createMany({ data: tags.map((t) => ({ todoId: id, tagId: t.id })), skipDuplicates: true });
        const targets = (Array.isArray(data['weekTargetIds']) ? data['weekTargetIds'] : []).filter((t): t is string => typeof t === 'string');
        if (targets.length) await tx.weekTarget.updateMany({ where: { id: { in: targets }, userId, todoId: null }, data: { todoId: id } });
    });
}

// ─── Decisions ────────────────────────────────────────────────────────

const DECISION_DATES = ['lookAgainDay', 'reviewedAt', 'createdAt', 'updatedAt'] as const;

/** A decision an agent removed: Undo brings it back with its id (and its memories' link to it). */
export async function deleteDecisionForAgent(actor: AgentActor, id: string) {
    const row = await prisma.decision.findFirst({ where: { id, userId: actor.userId }, include: { memories: { select: { id: true } } } });
    if (!row) throw gone('decision', 'list_decisions shows their decisions with ids.');
    const { memories, ...decision } = row;
    const undoData = { row: snapshot(decision), memoryIds: memories.map((m) => m.id) } as Prisma.InputJsonValue;
    const editId = await prisma.$transaction(async (tx) => {
        await tx.decision.deleteMany({ where: { id, userId: actor.userId } });
        return recordAgentEdit(actor, { kind: 'decision_delete', summary: `Removed the decision ${quoted(row.title, 60)}`, entityId: id, undoData }, tx);
    });
    return { id, title: row.title, deleted: true as const, editId };
}

export async function undoDecisionDelete(userId: string, id: string, data: Json): Promise<void> {
    if (await prisma.decision.findUnique({ where: { id }, select: { id: true } })) return;
    const row = revive((data['row'] ?? {}) as Json, DECISION_DATES);
    await prisma.$transaction(async (tx) => {
        const subjectId = typeof row['subjectId'] === 'string' && (await tx.subject.findFirst({ where: { id: row['subjectId'], userId }, select: { id: true } })) ? row['subjectId'] : null;
        const projectId = typeof row['projectId'] === 'string' && (await tx.project.findFirst({ where: { id: row['projectId'], userId }, select: { id: true } })) ? row['projectId'] : null;
        await tx.decision.create({ data: { ...(row as Prisma.DecisionUncheckedCreateInput), id, userId, subjectId, projectId } });
        const memoryIds = (Array.isArray(data['memoryIds']) ? data['memoryIds'] : []).filter((m): m is string => typeof m === 'string');
        if (memoryIds.length) await tx.memory.updateMany({ where: { id: { in: memoryIds }, userId, decisionId: null }, data: { decisionId: id } });
    });
}

// ─── Topics on a path ─────────────────────────────────────────────────

const TOPIC_DATES = ['startedAt', 'doneAt', 'createdAt', 'updatedAt'] as const;

async function topicFacts(userId: string, id: string) {
    const t = await prisma.topic.findFirst({
        where: { id, userId },
        include: { doc: { select: { title: true } }, _count: { select: { revisions: true, captures: true, sessions: true, weakSpots: true, weekTargets: true } } },
    });
    if (!t) throw gone('topic', 'get_path shows a subject’s topics with ids.');
    return t;
}

/** What a topic holds, in words ("3 reviews, 2 notes"); empty when nothing. */
function holdings(c: { revisions: number; captures: number; sessions: number; weakSpots: number }, hasDoc: boolean): string[] {
    return [hasDoc ? 'a lesson doc' : null, c.revisions ? plural(c.revisions, 'review') : null, c.captures ? plural(c.captures, 'note') : null, c.sessions ? plural(c.sessions, 'session') : null, c.weakSpots ? plural(c.weakSpots, 'weak spot') : null].filter(
        (s): s is string => !!s
    );
}

/**
 * A topic off its path. A planned topic holding nothing goes at once (Undo puts it back in its place); one with a doc,
 * reviews, notes, sessions or weak spots only asks: the delete_topic card, their tap.
 */
export async function removeTopicForAgent(actor: AgentActor, id: string, input: { reason?: string | null | undefined }) {
    const t = await topicFacts(actor.userId, id);
    const title = t.doc?.title || t.title;
    const holds = holdings(t._count, !!t.docId);
    if (holds.length) {
        const card = await requestAction(actor.userId, actor.agentName, { action: 'delete_topic', input: { topicId: id }, reason: input.reason ?? null });
        return { id, title, removed: false as const, asked: true as const, suggestionId: card.id, text: card.text, holds };
    }
    const { doc: _doc, _count: _c, ...row } = t;
    const editId = await prisma.$transaction(async (tx) => {
        await tx.topic.deleteMany({ where: { id, userId: actor.userId } });
        return recordAgentEdit(actor, { kind: 'topic_delete', summary: `Took ${quoted(title, 60)} off its path`, entityId: id, undoData: { row: snapshot(row) } as Prisma.InputJsonValue }, tx);
    });
    return { id, title, removed: true as const, asked: false as const, editId };
}

export async function undoTopicDelete(userId: string, id: string, data: Json): Promise<void> {
    if (await prisma.topic.findUnique({ where: { id }, select: { id: true } })) return;
    const row = revive((data['row'] ?? {}) as Json, TOPIC_DATES, ['legacyCanvas']);
    const subject = typeof row['subjectId'] === 'string' ? await prisma.subject.findFirst({ where: { id: row['subjectId'], userId }, select: { id: true } }) : null;
    if (!subject) throw new LearningHttpError(409, 'CANNOT_UNDO', "Can't undo: its subject is gone");
    await prisma.topic.create({ data: { ...(row as Prisma.TopicUncheckedCreateInput), id, userId, docId: null } });
}

/** The delete_topic action's card words and its run (actions.service.ts). */
export async function describeTopicRemoval(userId: string, id: string): Promise<string> {
    const t = await topicFacts(userId, id);
    const holds = holdings(t._count, !!t.docId);
    const lost = [t._count.revisions ? plural(t._count.revisions, 'review') : null, t._count.weakSpots ? plural(t._count.weakSpots, 'weak spot') : null].filter(Boolean);
    return `Take "${t.doc?.title || t.title}" off its path${holds.length ? ` (${holds.join(', ')})` : ''}${lost.length ? `: its ${lost.join(' and ')} go for good` : ''}${t.docId ? '; the doc stays' : ''}`;
}

export async function runTopicRemoval(userId: string, id: string): Promise<string> {
    const t = await topicFacts(userId, id);
    await prisma.topic.deleteMany({ where: { id, userId } });
    return `Took "${t.doc?.title || t.title}" off its path`;
}

// ─── Reviews ──────────────────────────────────────────────────────────

/** A doc off spaced revision: its coming reviews go (done ones stay as its history); Undo puts them back. */
export async function stopRevisionForAgent(actor: AgentActor, docId: string) {
    const topic = await prisma.topic.findFirst({ where: { docId, userId: actor.userId }, select: { id: true, title: true, doc: { select: { title: true } } } });
    if (!topic) throw new LearningHttpError(404, 'NOT_ON_REVISION', 'That doc is not on revision (list_due or get_path shows the ones that are).');
    const pending = await prisma.revision.findMany({ where: { topicId: topic.id, userId: actor.userId, status: 'pending' }, orderBy: { cycleNumber: 'asc' } });
    if (!pending.length) throw new LearningHttpError(409, 'NOTHING_COMING', 'No reviews are coming for that doc: nothing to stop.');
    const title = topic.doc?.title || topic.title;
    const done = await prisma.revision.count({ where: { topicId: topic.id, userId: actor.userId, status: 'done' } });
    const rows = pending.map((r) => ({ id: r.id, cycleNumber: r.cycleNumber, intervalDays: r.intervalDays, scheduledFor: fromDbDay(r.scheduledFor), createdAt: r.createdAt.toISOString() }));
    const editId = await prisma.$transaction(async (tx) => {
        await tx.revision.deleteMany({ where: { id: { in: pending.map((r) => r.id) }, userId: actor.userId, status: 'pending' } });
        return recordAgentEdit(actor, { kind: 'revision_stop', summary: `Stopped revising ${quoted(title, 60)} (${plural(pending.length, 'coming review')} removed)`, entityId: topic.id, docId, undoData: { topicId: topic.id, rows } }, tx);
    });
    return { docId, title, removed: pending.length, kept: done, editId };
}

export async function undoRevisionStop(userId: string, data: Json): Promise<void> {
    const topicId = typeof data['topicId'] === 'string' ? data['topicId'] : null;
    if (!topicId || !(await prisma.topic.findFirst({ where: { id: topicId, userId }, select: { id: true } }))) throw new LearningHttpError(409, 'CANNOT_UNDO', "Can't undo: the topic is gone");
    const rows = (Array.isArray(data['rows']) ? data['rows'] : []) as Array<{ id?: unknown; cycleNumber?: unknown; intervalDays?: unknown; scheduledFor?: unknown; createdAt?: unknown }>;
    const taken = new Set((await prisma.revision.findMany({ where: { topicId }, select: { cycleNumber: true } })).map((r) => r.cycleNumber));
    const back = rows.filter((r) => typeof r.id === 'string' && typeof r.cycleNumber === 'number' && !taken.has(r.cycleNumber) && typeof r.scheduledFor === 'string' && isValidDay(r.scheduledFor));
    if (rows.length && !back.length) throw new LearningHttpError(409, 'CANNOT_UNDO', "Can't undo: it was put on revision again since");
    await prisma.revision.createMany({
        data: back.map((r) => ({
            id: r.id as string,
            userId,
            topicId,
            cycleNumber: r.cycleNumber as number,
            intervalDays: typeof r.intervalDays === 'number' ? r.intervalDays : 1,
            scheduledFor: toDbDay(r.scheduledFor as DayString),
            ...(typeof r.createdAt === 'string' ? { createdAt: new Date(r.createdAt) } : {}),
        })),
        skipDuplicates: true,
    });
}

/** "I ticked that by mistake": a review back to not done (the app's own uncomplete); Undo marks it done again. */
export async function uncompleteRevisionForAgent(actor: AgentActor, revisionId: string, now: Date = new Date()) {
    const rev = await prisma.revision.findFirst({ where: { id: revisionId, userId: actor.userId }, select: { id: true, status: true, topic: { select: { title: true, docId: true, doc: { select: { title: true } } } }, capture: { select: { title: true } } } });
    if (!rev) throw gone('review', 'list_due shows reviews with ids; get_doc or get_path show a lesson’s reviews.');
    if (rev.status !== 'done') throw new LearningHttpError(409, 'NOT_DONE', 'That review is not marked done.');
    const title = rev.topic?.doc?.title || rev.topic?.title || rev.capture?.title || 'a review';
    const result = await uncompleteRevisionForUser(actor.userId, revisionId, now);
    const editId = await recordAgentEdit(actor, { kind: 'revision_uncomplete', summary: `Marked the review of ${quoted(title, 60)} not done`, entityId: revisionId, docId: rev.topic?.docId ?? null });
    return { revisionId, title, scheduledFor: result.item.scheduledFor, editId };
}

export async function undoRevisionUncomplete(userId: string, id: string, now: Date): Promise<void> {
    const rev = await prisma.revision.findFirst({ where: { id, userId }, select: { status: true } });
    if (rev?.status !== 'pending') throw new LearningHttpError(409, 'CANNOT_UNDO', "Can't undo: that review is not waiting any more");
    await completeRevisionForUser(userId, id, now);
}

// ─── Time entries ─────────────────────────────────────────────────────

const SESSION_DATES = ['day', 'startedAt', 'endedAt', 'createdAt', 'updatedAt'] as const;
const sessionTitle = (t: string) => quoted(t || 'a session', 60);

/** A time entry corrected on their word: minutes, its day, title or kind. Undo puts the old values back. */
export async function updateSessionForAgent(actor: AgentActor, id: string, input: { minutes?: number | undefined; day?: string | undefined; title?: string | undefined; kind?: SessionKind | undefined }) {
    const row = await prisma.workSession.findFirst({ where: { id, userId: actor.userId }, select: { id: true, title: true, minutes: true, kind: true, day: true } });
    if (!row) throw gone('session', 'list_sessions shows their sessions with ids.');
    if (input.day !== undefined && !isValidDay(input.day)) throw new LearningHttpError(400, 'BAD_DAY', 'day is "YYYY-MM-DD"');
    const was = { title: row.title, minutes: row.minutes, kind: row.kind, day: fromDbDay(row.day) };
    const changes = [
        input.minutes !== undefined && input.minutes !== row.minutes ? `${minutesWords(input.minutes)} (was ${minutesWords(row.minutes)})` : null,
        input.day !== undefined && input.day !== was.day ? `on ${input.day} (was ${was.day})` : null,
        input.title !== undefined && input.title.trim() !== row.title ? `titled ${quoted(input.title, 60)}` : null,
        input.kind !== undefined && input.kind !== row.kind ? `${input.kind} (was ${row.kind})` : null,
    ].filter((s): s is string => !!s);
    const session = await updateSession(actor.userId, id, input);
    const editId = changes.length ? await recordAgentEdit(actor, { kind: 'session_update', summary: `Corrected the session ${sessionTitle(row.title)}: ${changes.join(', ')}`, entityId: id, undoData: { before: was } }) : null;
    return { session, changed: changes, editId };
}

export async function undoSessionUpdate(userId: string, id: string, data: Json): Promise<void> {
    const b = (data['before'] ?? {}) as Json;
    if (!(await prisma.workSession.findFirst({ where: { id, userId }, select: { id: true } }))) return;
    const kinds: readonly string[] = ['study', 'practice', 'build', 'review'];
    await updateSession(userId, id, {
        ...(typeof b['title'] === 'string' ? { title: b['title'] } : {}),
        ...('minutes' in b ? { minutes: typeof b['minutes'] === 'number' ? b['minutes'] : null } : {}),
        ...(typeof b['kind'] === 'string' && kinds.includes(b['kind']) ? { kind: b['kind'] as SessionKind } : {}),
        ...(typeof b['day'] === 'string' && isValidDay(b['day']) ? { day: b['day'] } : {}),
    });
}

/** A time entry removed on their word: Undo brings it back with its id (and its weak spots' link to it). */
export async function deleteSessionForAgent(actor: AgentActor, id: string) {
    const row = await prisma.workSession.findFirst({ where: { id, userId: actor.userId }, include: { weakSpots: { select: { id: true } } } });
    if (!row) throw gone('session', 'list_sessions shows their sessions with ids.');
    const { weakSpots, ...session } = row;
    await deleteSession(actor.userId, id);
    const editId = await recordAgentEdit(actor, {
        kind: 'session_delete',
        summary: `Removed the session ${sessionTitle(row.title)} (${minutesWords(row.minutes)}, ${fromDbDay(row.day)})`,
        entityId: id,
        undoData: { row: snapshot({ ...session, day: fromDbDay(row.day) }), weakSpotIds: weakSpots.map((w) => w.id) } as Prisma.InputJsonValue,
    });
    return { id, title: row.title, deleted: true as const, editId };
}

export async function undoSessionDelete(userId: string, id: string, data: Json): Promise<void> {
    if (await prisma.workSession.findUnique({ where: { id }, select: { id: true } })) return;
    const raw = (data['row'] ?? {}) as Json;
    const row = revive(raw, SESSION_DATES.filter((d) => d !== 'day'), ['details']);
    delete row['day'];
    const day = typeof raw['day'] === 'string' && isValidDay(raw['day']) ? toDbDay(raw['day'] as DayString) : null;
    if (!day) throw new LearningHttpError(409, 'CANNOT_UNDO', 'This edit cannot be undone');
    const key = typeof row['key'] === 'string' ? row['key'] : null;
    if (key && (await prisma.workSession.findUnique({ where: { userId_key: { userId, key } }, select: { id: true } }))) throw new LearningHttpError(409, 'CANNOT_UNDO', "Can't undo: a newer entry has its key");
    const okIds = async (model: 'subject' | 'topic' | 'project', v: unknown) => {
        if (typeof v !== 'string') return null;
        const found = model === 'subject' ? await prisma.subject.findFirst({ where: { id: v, userId }, select: { id: true } }) : model === 'topic' ? await prisma.topic.findFirst({ where: { id: v, userId }, select: { id: true } }) : await prisma.project.findFirst({ where: { id: v, userId }, select: { id: true } });
        return found ? v : null;
    };
    await prisma.workSession.create({
        data: {
            ...(row as Prisma.WorkSessionUncheckedCreateInput),
            id,
            userId,
            day,
            subjectId: await okIds('subject', row['subjectId']),
            topicId: await okIds('topic', row['topicId']),
            projectId: await okIds('project', row['projectId']),
        } as Prisma.WorkSessionUncheckedCreateInput,
    });
    const weak = (Array.isArray(data['weakSpotIds']) ? data['weakSpotIds'] : []).filter((w): w is string => typeof w === 'string');
    if (weak.length) await prisma.weakSpot.updateMany({ where: { id: { in: weak }, userId, sessionId: null }, data: { sessionId: id } });
}
