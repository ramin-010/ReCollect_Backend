// Deleting a subject with everything in it, undoable for a week (the owner, 11-22: "when I delete a subject all its
// docs and content and files or tasks or anything connected should get deleted, with a 1 week undo").
//
// What goes: the subject; its topics (paths) and their revisions and recall sets; its captures (quick notes) and
// theirs; its streak and daily history; its links to goals (the goals stay); its weak spots; the tasks linked to its
// docs (with their labels' links and reminders). Its docs (the topics' docs the person owns) go to the trash at the
// same moment. What only loses its link: work sessions (time already spent stays in the record), week targets and
// decisions, and captures elsewhere that pointed at one of its topics; an undo links them again.
//
// The rows that went are kept as a snapshot (SubjectDeletion.payload) for UNDO_DAYS; an undo writes them back with
// the same ids, takes the docs out of the trash and links the rest again. After UNDO_DAYS the snapshot and those docs
// are deleted for good (the hourly housekeeping).
//
//   GET    /api/subjects/:id/deletion       what a delete would take (counts), for the confirm
//   DELETE /api/subjects/:id                delete it (returns the deletion's id, for Undo)
//   GET    /api/subject-deletions           the deleted subjects still undoable
//   POST   /api/subject-deletions/:id/undo  bring it back
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { deleteOrLeaveDoc } from '../docs/docs.service';
import { notFound } from '../learning/http';

export const UNDO_DAYS = 7;
const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;

/** The tables a deletion snapshots, in the order an undo writes them back (parents first). */
const MODELS = ['subject', 'topic', 'capture', 'revision', 'recallSet', 'subjectStreak', 'dailyHistory', 'goalSubject', 'weakSpot', 'todo', 'todoTag', 'todoAssignee', 'reminder'] as const;
type ModelKey = (typeof MODELS)[number];
const MODEL_NAMES: Record<ModelKey, string> = {
    subject: 'Subject',
    topic: 'Topic',
    capture: 'Capture',
    revision: 'Revision',
    recallSet: 'RecallSet',
    subjectStreak: 'SubjectStreak',
    dailyHistory: 'DailyHistory',
    goalSubject: 'GoalSubject',
    weakSpot: 'WeakSpot',
    todo: 'Todo',
    todoTag: 'TodoTag',
    todoAssignee: 'TodoAssignee',
    reminder: 'Reminder',
};

interface Relink {
    id: string;
    subjectId?: string | null;
    topicId?: string | null;
    todoId?: string | null;
}

interface Payload {
    rows: Partial<Record<ModelKey, Row[]>>;
    relink: { workSession: Relink[]; weekTarget: Relink[]; decision: Relink[]; capture: Relink[] };
}

export interface SubjectDeletionJson {
    _id: string;
    subjectId: string;
    name: string;
    deletedAt: string;
    undoUntil: string;
    counts: DeletionCounts;
    /** Its docs waiting in the trash: they come back with the subject (the Trash lists them under it, not on their own). */
    docIds: string[];
}

export interface DeletionCounts {
    docs: number;
    topics: number;
    notes: number;
    revisions: number;
    tasks: number;
    sessions: number;
}

type Tx = Prisma.TransactionClient;
// The delegates by name (each table's findMany / createMany / deleteMany), typed loosely: the snapshot is generic.
type Delegate = {
    findMany: (args: unknown) => Promise<Row[]>;
    createMany: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
};
const delegate = (db: Tx | typeof prisma, key: ModelKey): Delegate => (db as unknown as Record<ModelKey, Delegate>)[key];

/** JSON keeps dates as text and drops the null-ness of Json columns: put both back from the schema. */
function reviveRows(key: ModelKey, rows: Row[]): Row[] {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === MODEL_NAMES[key]);
    if (!model) return rows;
    const dates = model.fields.filter((f) => f.kind === 'scalar' && f.type === 'DateTime').map((f) => f.name);
    const jsons = model.fields.filter((f) => f.kind === 'scalar' && f.type === 'Json').map((f) => f.name);
    return rows.map((row) => {
        const out: Row = { ...row };
        for (const f of dates) if (typeof out[f] === 'string') out[f] = new Date(out[f] as string);
        for (const f of jsons) if (out[f] === null) out[f] = Prisma.JsonNull;
        return out;
    });
}

function linkedDocIds(todo: { references: unknown }, docIds: ReadonlySet<string>): boolean {
    const refs = Array.isArray(todo.references) ? (todo.references as Array<{ type?: string; refId?: string }>) : [];
    return refs.some((r) => r?.type === 'doc' && typeof r.refId === 'string' && docIds.has(r.refId));
}

/** Everything a delete of this subject would take or unlink (read in steps: one query at a time in a transaction). */
async function collect(db: Tx | typeof prisma, userId: string, subjectId: string) {
    const subject = await db.subject.findFirst({ where: { id: subjectId, userId } });
    if (!subject) throw notFound();
    const topics = await db.topic.findMany({ where: { subjectId } });
    const topicIds = topics.map((t) => t.id);
    const captures = await db.capture.findMany({ where: { subjectId } });
    const captureIds = captures.map((c) => c.id);
    const revisions = await db.revision.findMany({ where: { OR: [{ topicId: { in: topicIds } }, { captureId: { in: captureIds } }] } });
    const revisionIds = revisions.map((r) => r.id);
    const recallSets = await db.recallSet.findMany({ where: { revisionId: { in: revisionIds } } });
    const subjectStreaks = await db.subjectStreak.findMany({ where: { subjectId } });
    const dailyHistory = await db.dailyHistory.findMany({ where: { subjectId } });
    const goalSubjects = await db.goalSubject.findMany({ where: { subjectId } });
    const weakSpots = await db.weakSpot.findMany({ where: { OR: [{ subjectId }, { topicId: { in: topicIds } }] } });
    // Its docs: the topics' docs this person owns and has not trashed already (a shared doc is someone else's).
    const docIds = new Set(
        (await db.doc.findMany({ where: { id: { in: topics.map((t) => t.docId).filter((d): d is string => !!d) }, userId, trashedAt: null }, select: { id: true } })).map((d) => d.id),
    );
    const todos = (await db.todo.findMany({ where: { userId, workspaceId: null } })).filter((t) => linkedDocIds(t, docIds));
    const todoIds = todos.map((t) => t.id);
    const todoTags = await db.todoTag.findMany({ where: { todoId: { in: todoIds } } });
    const todoAssignees = await db.todoAssignee.findMany({ where: { todoId: { in: todoIds } } });
    const reminders = await db.reminder.findMany({ where: { todoId: { in: todoIds } } });
    const sessions = await db.workSession.findMany({ where: { userId, OR: [{ subjectId }, { topicId: { in: topicIds } }] }, select: { id: true, subjectId: true, topicId: true } });
    const weekTargets = await db.weekTarget.findMany({ where: { userId, OR: [{ subjectId }, { topicId: { in: topicIds } }, { todoId: { in: todoIds } }] }, select: { id: true, subjectId: true, topicId: true, todoId: true } });
    const decisions = await db.decision.findMany({ where: { userId, subjectId }, select: { id: true, subjectId: true } });
    const pointing = await db.capture.findMany({ where: { topicId: { in: topicIds }, NOT: { subjectId } }, select: { id: true, topicId: true } });
    const payload: Payload = {
        rows: {
            subject: [subject as unknown as Row],
            topic: topics as unknown as Row[],
            capture: captures as unknown as Row[],
            revision: revisions as unknown as Row[],
            recallSet: recallSets as unknown as Row[],
            subjectStreak: subjectStreaks as unknown as Row[],
            dailyHistory: dailyHistory as unknown as Row[],
            goalSubject: goalSubjects as unknown as Row[],
            weakSpot: weakSpots as unknown as Row[],
            todo: todos as unknown as Row[],
            todoTag: todoTags as unknown as Row[],
            todoAssignee: todoAssignees as unknown as Row[],
            reminder: reminders as unknown as Row[],
        },
        relink: { workSession: sessions, weekTarget: weekTargets, decision: decisions, capture: pointing },
    };
    const counts: DeletionCounts = {
        docs: docIds.size,
        topics: topics.length,
        notes: captures.length,
        revisions: revisions.length,
        tasks: todos.length,
        sessions: sessions.length,
    };
    return { subject, payload, docIds: [...docIds], counts };
}

/** GET /api/subjects/:id/deletion: what a delete would take, for the confirm. */
export async function deletionPreview(userId: string, subjectId: string): Promise<{ name: string; counts: DeletionCounts; undoDays: number }> {
    const { subject, counts } = await collect(prisma, userId, subjectId);
    return { name: subject.name, counts, undoDays: UNDO_DAYS };
}

function serialize(row: { id: string; subjectId: string; name: string; createdAt: Date; expiresAt: Date; payload: unknown; docIds?: string[] }): SubjectDeletionJson {
    const p = row.payload as Payload;
    const r = p.rows ?? {};
    return {
        _id: row.id,
        subjectId: row.subjectId,
        name: row.name,
        deletedAt: row.createdAt.toISOString(),
        undoUntil: row.expiresAt.toISOString(),
        docIds: row.docIds ?? [],
        counts: {
            docs: 0,
            topics: r.topic?.length ?? 0,
            notes: r.capture?.length ?? 0,
            revisions: r.revision?.length ?? 0,
            tasks: r.todo?.length ?? 0,
            sessions: p.relink?.workSession?.length ?? 0,
        },
    };
}

/** DELETE /api/subjects/:id: the subject and everything in it, undoable for UNDO_DAYS. */
export async function deleteSubjectWithUndo(userId: string, subjectId: string, now: Date = new Date()): Promise<SubjectDeletionJson> {
    const saved = await prisma.$transaction(
        async (tx) => {
            const { subject, payload, docIds } = await collect(tx, userId, subjectId);
            const row = await tx.subjectDeletion.create({
                data: {
                    userId,
                    subjectId,
                    name: subject.name,
                    payload: payload as unknown as Prisma.InputJsonValue,
                    docIds,
                    createdAt: now,
                    expiresAt: new Date(now.getTime() + UNDO_DAYS * DAY_MS),
                },
            });
            if (docIds.length) await tx.doc.updateMany({ where: { id: { in: docIds } }, data: { trashedAt: now } });
            const todoIds = (payload.rows.todo ?? []).map((t) => t.id as string);
            if (todoIds.length) await tx.todo.deleteMany({ where: { id: { in: todoIds } } }); // labels' links and reminders cascade
            const captureIds = (payload.rows.capture ?? []).map((c) => c.id as string);
            if (captureIds.length) await tx.capture.deleteMany({ where: { id: { in: captureIds } } }); // their revisions cascade
            await tx.subject.delete({ where: { id: subjectId } }); // topics, revisions, streak, history, goal links, weak spots cascade
            return { ...row, docCount: docIds.length };
        },
        { timeout: 30_000 },
    );
    const json = serialize(saved);
    json.counts.docs = saved.docCount;
    return json;
}

/** GET /api/subject-deletions: deleted subjects that can still be brought back, newest first. */
export async function listSubjectDeletions(userId: string, now: Date = new Date()): Promise<SubjectDeletionJson[]> {
    const rows = await prisma.subjectDeletion.findMany({ where: { userId, expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => ({ ...serialize(r), counts: { ...serialize(r).counts, docs: r.docIds.length } }));
}

/** POST /api/subject-deletions/:id/undo: everything back with its ids; docs out of the trash; links again. */
export async function undoSubjectDeletion(userId: string, deletionId: string, now: Date = new Date()): Promise<{ subjectId: string; name: string }> {
    return prisma.$transaction(
        async (tx) => {
            const row = await tx.subjectDeletion.findFirst({ where: { id: deletionId, userId, expiresAt: { gt: now } } });
            if (!row) throw notFound();
            const payload = row.payload as unknown as Payload;
            // Docs first: a topic points at its doc only while that doc still exists.
            if (row.docIds.length) await tx.doc.updateMany({ where: { id: { in: row.docIds }, userId }, data: { trashedAt: null } });
            const docs = new Set((await tx.doc.findMany({ where: { id: { in: (payload.rows.topic ?? []).map((t) => t.docId as string).filter(Boolean) } }, select: { id: true } })).map((d) => d.id));
            const goals = new Set((await tx.goal.findMany({ where: { userId, id: { in: (payload.rows.goalSubject ?? []).map((g) => g.goalId as string) } }, select: { id: true } })).map((g) => g.id));
            const people = new Set((await tx.user.findMany({ where: { id: { in: (payload.rows.todoAssignee ?? []).map((a) => a.userId as string) } }, select: { id: true } })).map((u) => u.id));
            const tags = new Set((await tx.tag.findMany({ where: { id: { in: (payload.rows.todoTag ?? []).map((t) => t.tagId as string) } }, select: { id: true } })).map((t) => t.id));
            for (const key of MODELS) {
                let rows = reviveRows(key, payload.rows[key] ?? []);
                if (key === 'topic') rows = rows.map((t) => (t.docId && !docs.has(t.docId as string) ? { ...t, docId: null } : t));
                if (key === 'goalSubject') rows = rows.filter((g) => goals.has(g.goalId as string));
                if (key === 'todoTag') rows = rows.filter((t) => tags.has(t.tagId as string));
                if (key === 'todoAssignee') rows = rows.filter((a) => people.has(a.userId as string));
                if (rows.length) await delegate(tx, key).createMany({ data: rows });
            }
            const topicIds = new Set((payload.rows.topic ?? []).map((t) => t.id as string));
            for (const s of payload.relink.workSession ?? []) await tx.workSession.updateMany({ where: { id: s.id, userId }, data: { subjectId: s.subjectId ?? null, topicId: s.topicId ?? null } });
            for (const w of payload.relink.weekTarget ?? []) await tx.weekTarget.updateMany({ where: { id: w.id, userId }, data: { subjectId: w.subjectId ?? null, topicId: w.topicId ?? null, todoId: w.todoId ?? null } });
            for (const d of payload.relink.decision ?? []) await tx.decision.updateMany({ where: { id: d.id, userId }, data: { subjectId: d.subjectId ?? null } });
            for (const c of payload.relink.capture ?? []) if (c.topicId && topicIds.has(c.topicId)) await tx.capture.updateMany({ where: { id: c.id, topicId: null }, data: { topicId: c.topicId } });
            await tx.subjectDeletion.delete({ where: { id: row.id } });
            return { subjectId: row.subjectId, name: row.name };
        },
        { timeout: 30_000 },
    );
}

/** The hourly housekeeping: deletions past their week are final (their docs deleted for good, the snapshot gone). */
export async function purgeSubjectDeletions(now: Date = new Date()): Promise<number> {
    const rows = await prisma.subjectDeletion.findMany({ where: { expiresAt: { lte: now } }, select: { id: true, userId: true, docIds: true } });
    for (const row of rows) {
        const stillTrashed = await prisma.doc.findMany({ where: { id: { in: row.docIds }, userId: row.userId, trashedAt: { not: null } }, select: { id: true } });
        for (const doc of stillTrashed) {
            try {
                await deleteOrLeaveDoc(doc.id, row.userId);
            } catch (err) {
                console.error(`[subjects] could not delete doc ${doc.id}:`, err);
            }
        }
        await prisma.subjectDeletion.delete({ where: { id: row.id } });
    }
    return rows.length;
}
