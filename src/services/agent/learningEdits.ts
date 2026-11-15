// Agent provenance for the existing learning routes: thin middlewares that do nothing for the app
// (cookie sessions) and, for an access token, log the write as an AgentEdit after a 2xx (with what
// Undo needs) and mark created goals, milestones and focus lines createdBy = 'agent'.
//
// Mounted per route in src/routers/learning.routes.ts, after authentication and idempotency (a
// replayed response never logs twice), before the handler.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AgentEditKind, GoalStatus, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { isTokenRequest } from '../../middlwares/auth';
import { conflict, LearningHttpError } from '../learning/http';
import { fromDbDay, fromDbDayOrNull } from '../learningDb/common';
import { pathPlaces } from '../learningDb/path.service';
import { weekTargetBefore } from '../learningDb/week.service';
import { taskBefore } from '../tasks/tasks.service';
import { decisionBefore } from '../learningDb/decisions.service';
import { agentActor, plural, quoted, recordAgentEdit, type AgentActor } from './agentEditLog';

/** The `data` of a `{ success: true, data }` response (route-specific shape). */
type Data = any; // eslint-disable-line @typescript-eslint/no-explicit-any

interface EditContext<B> {
    req: Request;
    actor: AgentActor;
    before: B;
    data: Data;
}

interface EditLine {
    summary: string;
    entityId?: string | null;
    docId?: string | null;
    undoData?: Prisma.InputJsonValue;
}

function agentEdit<B = undefined>(
    kind: AgentEditKind,
    spec: {
        /** Before the handler: what Undo will need, or a refusal (throw). */
        before?: (req: Request, actor: AgentActor) => Promise<B>;
        /** After a 2xx: provenance writes, then the log line (null = nothing to log). */
        after: (ctx: EditContext<B>) => Promise<EditLine | null> | EditLine | null;
    }
): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!isTokenRequest(req)) return next();
        const actor = agentActor(req);
        const ready = spec.before ? spec.before(req, actor) : Promise.resolve(undefined as B);
        ready.then((before) => {
            const send = res.json.bind(res);
            res.json = ((body: Data) => {
                if (res.statusCode < 200 || res.statusCode >= 300 || body?.success !== true) return send(body);
                Promise.resolve()
                    .then(() => spec.after({ req, actor, before, data: body.data }))
                    .then((line) => (line ? recordAgentEdit(actor, { kind, ...line }) : undefined))
                    .catch((err: unknown) => console.error(`[agent] could not log a ${kind} edit:`, err))
                    .finally(() => send(body));
                return res;
            }) as Response['json'];
            next();
        }, next);
    };
}

const byAgent = (actor: AgentActor) => ({ createdBy: 'agent' as const, agentName: actor.agentName });
const routeId = (req: Request): string => String(req.params['id'] ?? '');

// ─── Subjects, topics, revisions ───────────────────────────────────────

/** POST /api/subjects */
export const logSubjectCreate = agentEdit('subject_create', {
    after: ({ data }) => ({ summary: `Created subject ${quoted(String(data.name))}`, entityId: data._id }),
});

/** POST /api/topics {docId, subjectId, startRevisions?}: the doc is filed (and normally scheduled). */
export const logTopicCreate = agentEdit('revision_schedule', {
    after: ({ data }) => {
        const chain: Array<{ _id: string }> = data.chain ?? [];
        const title = quoted(String(data.topic?.title ?? ''));
        return {
            summary: chain.length > 0 ? `Scheduled ${title} for revision` : `Filed ${title} under a subject`,
            entityId: data.topic?._id ?? null,
            docId: data.topic?.docId ?? null,
            undoData: { createdTopic: true, topicId: data.topic?._id ?? null, revisionIds: chain.map((r) => r._id) },
        };
    },
});

/** POST /api/revisions/start {topicId | captureId} */
export const logRevisionStart = agentEdit<{ existing: string[]; title: string; docId: string | null }>('revision_schedule', {
    before: async (req, actor) => {
        const topicId = typeof req.body?.topicId === 'string' ? req.body.topicId : null;
        const captureId = typeof req.body?.captureId === 'string' ? req.body.captureId : null;
        if (!topicId && !captureId) return { existing: [], title: 'an item', docId: null };
        const existing = await prisma.revision.findMany({
            where: topicId ? { topicId, userId: actor.userId } : { captureId: captureId!, userId: actor.userId },
            select: { id: true },
        });
        if (topicId) {
            const topic = await prisma.topic.findFirst({ where: { id: topicId, userId: actor.userId }, select: { title: true, docId: true, doc: { select: { title: true } } } });
            return { existing: existing.map((r) => r.id), title: topic?.doc?.title ?? topic?.title ?? 'a topic', docId: topic?.docId ?? null };
        }
        const capture = await prisma.capture.findFirst({ where: { id: captureId!, userId: actor.userId }, select: { title: true, content: true } });
        return { existing: existing.map((r) => r.id), title: capture?.title || capture?.content?.slice(0, 50) || 'a note', docId: null };
    },
    after: ({ req, before, data }) => {
        const chain: Array<{ _id: string }> = data.chain ?? [];
        const created = chain.map((r) => r._id).filter((id) => !before.existing.includes(id));
        const topicId = typeof req.body?.topicId === 'string' ? req.body.topicId : null;
        return {
            summary: `Scheduled ${quoted(before.title)} for revision`,
            entityId: topicId ?? (typeof req.body?.captureId === 'string' ? req.body.captureId : null),
            docId: before.docId,
            undoData: { createdTopic: false, topicId, revisionIds: created },
        };
    },
});

// ─── Goals and milestones ──────────────────────────────────────────────

/** POST /api/goals: the goal and its milestones are marked as the agent's. */
export const logGoalCreate = agentEdit('goal_create', {
    after: async ({ actor, data }) => {
        await prisma.goal.updateMany({ where: { id: data._id, userId: actor.userId }, data: byAgent(actor) });
        await prisma.goalMilestone.updateMany({ where: { goalId: data._id, goal: { userId: actor.userId } }, data: byAgent(actor) });
        const milestones = Array.isArray(data.milestones) ? data.milestones.length : 0;
        return {
            summary: `Created goal ${quoted(String(data.title))} (due ${data.deadline}${milestones ? `, ${plural(milestones, 'milestone')}` : ''})`,
            entityId: data._id,
        };
    },
});

interface GoalBefore {
    title: string;
    why: string | null;
    deadline: string;
    status: GoalStatus;
    subjectIds: string[];
}

const GOAL_FIELDS = ['title', 'why', 'deadline', 'status', 'subjectIds'] as const;

/** PATCH /api/goals/:id: Undo puts the previous fields back. */
export const logGoalUpdate = agentEdit<GoalBefore | null>('goal_update', {
    before: async (req, actor) => {
        const goal = await prisma.goal.findFirst({
            where: { id: routeId(req), userId: actor.userId },
            select: { title: true, why: true, deadline: true, status: true, subjects: { select: { subjectId: true } } },
        });
        return goal
            ? { title: goal.title, why: goal.why, deadline: fromDbDay(goal.deadline), status: goal.status, subjectIds: goal.subjects.map((s) => s.subjectId) }
            : null;
    },
    after: ({ req, before, data }) => {
        if (!before) return null;
        const changed = GOAL_FIELDS.filter((f) => req.body && f in req.body);
        return {
            summary: `Updated goal ${quoted(String(data.title))}${changed.length ? ` (${changed.join(', ')})` : ''}`,
            entityId: data._id,
            undoData: { before: before as unknown as Prisma.InputJsonValue },
        };
    },
});

/** POST /api/goals/:id/milestones */
export const logMilestoneAdd = agentEdit('milestone_add', {
    after: async ({ actor, data }) => {
        await prisma.goalMilestone.updateMany({ where: { id: data.milestone._id, goal: { userId: actor.userId } }, data: byAgent(actor) });
        return {
            summary: `Added milestone ${quoted(String(data.milestone.title))} to ${quoted(String(data.goal?.title ?? ''))}`,
            entityId: data.milestone._id,
        };
    },
});

interface MilestoneBefore {
    title: string;
    dueDay: string | null;
    done: boolean;
    doneAt: string | null;
    sortOrder: number;
}

/** PATCH /api/goal-milestones/:id (e.g. {done: true}): Undo puts the previous fields back. */
export const logMilestoneUpdate = agentEdit<MilestoneBefore | null>('milestone_update', {
    before: async (req, actor) => {
        const m = await prisma.goalMilestone.findFirst({
            where: { id: routeId(req), goal: { userId: actor.userId } },
            select: { title: true, dueDay: true, done: true, doneAt: true, sortOrder: true },
        });
        return m ? { title: m.title, dueDay: fromDbDayOrNull(m.dueDay), done: m.done, doneAt: m.doneAt?.toISOString() ?? null, sortOrder: m.sortOrder } : null;
    },
    after: ({ req, before, data }) => {
        if (!before) return null;
        const title = quoted(String(data.milestone?.title ?? before.title));
        const done = req.body?.done;
        const summary =
            done === true && !before.done ? `Completed milestone ${title}` : done === false && before.done ? `Reopened milestone ${title}` : `Updated milestone ${title}`;
        return { summary, entityId: data.milestone?._id ?? routeId(req), undoData: { before: before as unknown as Prisma.InputJsonValue } };
    },
});

/** The whole milestone, so Undo can put it back with its id. */
interface MilestoneRow extends MilestoneBefore {
    id: string;
    goalId: string;
    goalTitle: string;
    createdBy: 'user' | 'agent';
    agentName: string | null;
}

/** DELETE /api/goal-milestones/:id by an agent: Undo puts the milestone back (if its goal is still there). */
export const logMilestoneRemove = agentEdit<MilestoneRow | null>('milestone_remove', {
    before: async (req, actor) => {
        const m = await prisma.goalMilestone.findFirst({
            where: { id: routeId(req), goal: { userId: actor.userId } },
            select: { id: true, goalId: true, title: true, dueDay: true, done: true, doneAt: true, sortOrder: true, createdBy: true, agentName: true, goal: { select: { title: true } } },
        });
        if (!m) return null;
        return {
            id: m.id,
            goalId: m.goalId,
            goalTitle: m.goal.title,
            title: m.title,
            dueDay: fromDbDayOrNull(m.dueDay),
            done: m.done,
            doneAt: m.doneAt?.toISOString() ?? null,
            sortOrder: m.sortOrder,
            createdBy: m.createdBy,
            agentName: m.agentName,
        };
    },
    after: ({ before }) =>
        before
            ? { summary: `Removed milestone ${quoted(before.title)} from ${quoted(before.goalTitle)}`, entityId: before.id, undoData: { row: before as unknown as Prisma.InputJsonValue } }
            : null,
});

// ─── Paths (BUDDY_PLAN B1) ─────────────────────────────────────────────

/** POST /api/subjects/:id/path: Undo removes the planned topics (while still planned and docless). */
export const logPathPlan = agentEdit('path_plan', {
    after: async ({ data }) => {
        const created: string[] = Array.isArray(data?.created) ? data.created : [];
        if (created.length === 0) return null;
        const subject = String(data?.path?.subject?.name ?? '');
        const titles = (data?.path?.topics ?? []).filter((t: { _id: string }) => created.includes(t._id)).map((t: { title: string }) => quoted(t.title));
        const what = created.length === 1 ? `topic ${titles[0] ?? ''}` : `${plural(created.length, 'topic')}`;
        return { summary: `Planned ${what} in ${quoted(subject)}`, entityId: String(data?.path?.subject?._id ?? ''), undoData: { created } };
    },
});

interface TopicBefore {
    subjectId: string;
    title: string;
    status: string;
    nextStep: string | null;
    startedAt: string | null;
    doneAt: string | null;
    places: Record<string, number | null>;
}

/** PATCH /api/topics/:id/path: Undo puts the topic's fields and the path's order back. */
export const logTopicUpdate = agentEdit<TopicBefore | null>('topic_update', {
    before: async (req, actor) => {
        const t = await prisma.topic.findFirst({
            where: { id: routeId(req), userId: actor.userId },
            select: { subjectId: true, title: true, status: true, nextStep: true, startedAt: true, doneAt: true },
        });
        if (!t) return null;
        return {
            subjectId: t.subjectId,
            title: t.title,
            status: t.status,
            nextStep: t.nextStep,
            startedAt: t.startedAt?.toISOString() ?? null,
            doneAt: t.doneAt?.toISOString() ?? null,
            places: await pathPlaces(actor.userId, t.subjectId),
        };
    },
    after: ({ req, before, data }) => {
        if (!before) return null;
        const title = quoted(String(data?.topic?.title ?? before.title));
        const status = req.body?.status;
        const moved = req.body?.after !== undefined;
        const summary =
            status === 'done' ? `Finished topic ${title}` : status === 'in_progress' ? `Started topic ${title}` : status === 'skipped' ? `Skipped topic ${title}` : moved ? `Moved topic ${title}` : `Updated topic ${title}`;
        return { summary, entityId: routeId(req), undoData: { before: before as unknown as Prisma.InputJsonValue } };
    },
});

// ─── Today: focus lines, pocket notes ──────────────────────────────────

/** POST /api/focus */
export const logFocusAdd = agentEdit('focus_add', {
    after: async ({ actor, data }) => {
        await prisma.focusItem.updateMany({ where: { id: data._id, userId: actor.userId }, data: byAgent(actor) });
        return { summary: `Added focus ${quoted(String(data.text))}`, entityId: data._id };
    },
});

interface FocusRow {
    id: string;
    day: string;
    text: string;
    done: boolean;
    sortOrder: number;
    createdBy: 'user' | 'agent';
    agentName: string | null;
}

async function focusRow(req: Request, actor: AgentActor): Promise<FocusRow | null> {
    const f = await prisma.focusItem.findFirst({
        where: { id: routeId(req), userId: actor.userId },
        select: { id: true, day: true, text: true, done: true, sortOrder: true, createdBy: true, agentName: true },
    });
    return f ? { ...f, day: fromDbDayOrNull(f.day) ?? '' } : null;
}

/** PATCH /api/focus/:id by an agent ({text?, done?}): Undo puts the old text and state back. */
export const logFocusUpdate = agentEdit<FocusRow | null>('focus_update', {
    before: focusRow,
    after: ({ req, before, data }) => {
        if (!before) return null;
        const text = quoted(String(data?.text ?? before.text));
        const done = req.body?.done;
        const summary =
            done === true && !before.done
                ? `Ticked focus ${text}`
                : done === false && before.done
                  ? `Unticked focus ${text}`
                  : `Changed focus ${quoted(before.text)} to ${text}`;
        return { summary, entityId: before.id, undoData: { before: { text: before.text, done: before.done } } };
    },
});

/** DELETE /api/focus/:id by an agent: Undo puts the line back, with its id, on its day. */
export const logFocusRemove = agentEdit<FocusRow | null>('focus_remove', {
    before: focusRow,
    after: ({ before }) => (before ? { summary: `Removed focus ${quoted(before.text)}`, entityId: before.id, undoData: { row: before as unknown as Prisma.InputJsonValue } } : null),
});

/**
 * PUT /api/quick-notes/:id by an agent: create only (agents never read pocket notes, so they must
 * not overwrite one: an existing id is a 409). `isPinned: true` in the body pins the new note.
 */
export const logPocketAdd = agentEdit<{ pin: boolean }>('pocket_add', {
    before: async (req) => {
        const existing = await prisma.quickNote.findUnique({ where: { id: routeId(req) }, select: { id: true } });
        if (existing) throw conflict('An agent can only add new pocket notes: this id is taken', 'NOTE_EXISTS');
        return { pin: req.body?.isPinned === true };
    },
    after: async ({ actor, before, data }) => {
        if (before.pin) {
            await prisma.quickNote.updateMany({ where: { id: data._id, userId: actor.userId }, data: { isPinned: true } });
            data.isPinned = true;
        }
        const firstLine = String(data.content ?? '').split('\n').find((l) => l.trim()) ?? '';
        return { summary: `Added a pocket note${before.pin ? ' (pinned)' : ''}: ${quoted(firstLine, 80)}`, entityId: data._id };
    },
});

// ─── The week (LOOP_COMPLETE_SPEC 1.6) ─────────────────────────────────

/** POST /api/week/targets by an agent: marked as the agent's; Undo removes it. */
export const logWeekTargetCreate = agentEdit('week_target_create', {
    after: async ({ actor, data }) => {
        await prisma.weekTarget.updateMany({ where: { id: data._id, userId: actor.userId }, data: byAgent(actor) });
        return { summary: `Added the week target ${quoted(String(data.text))}`, entityId: data._id };
    },
});

/** PATCH /api/week/targets/:id by an agent: Undo puts the old text, state and place back. */
export const logWeekTargetUpdate = agentEdit<Awaited<ReturnType<typeof weekTargetBefore>>>('week_target_update', {
    before: (req, actor) => weekTargetBefore(actor.userId, routeId(req)),
    after: ({ req, before, data }) => {
        if (!before) return null;
        const text = quoted(String(data?.text ?? before.text));
        const status = req.body?.status;
        const summary =
            status === 'done' && before.status !== 'done'
                ? `Ticked the week target ${text}`
                : status === 'dropped' && before.status !== 'dropped'
                  ? `Dropped the week target ${text}`
                  : status === 'open' && before.status !== 'open'
                    ? `Reopened the week target ${text}`
                    : `Changed the week target ${quoted(before.text)}${req.body?.text !== undefined ? ` to ${text}` : ''}`;
        return { summary, entityId: before.id, undoData: { before: { text: before.text, status: before.status, sortOrder: before.sortOrder, doneAt: before.doneAt?.toISOString() ?? null } } };
    },
});

// ─── Personal tasks (LOOP_COMPLETE_SPEC 4.1) ───────────────────────────

/** POST /api/tasks by an agent: Undo deletes the task. */
export const logTaskCreate = agentEdit('task_create', {
    after: ({ data }) => ({ summary: `Added the task ${quoted(String(data.title))}`, entityId: data._id }),
});

/** PATCH /api/tasks/:id by an agent: Undo puts the old title, due, priority and status back. */
export const logTaskUpdate = agentEdit<Awaited<ReturnType<typeof taskBefore>>>('task_update', {
    before: (req, actor) => taskBefore(actor.userId, routeId(req)),
    after: ({ req, before, data }) => {
        if (!before) return null;
        const title = quoted(String(data?.title ?? before.title));
        const summary =
            req.body?.status === 'complete' && before.status !== 'complete'
                ? `Ticked the task ${title}`
                : req.body?.status && req.body.status !== before.status
                  ? `Moved the task ${title} to ${String(req.body.status).replace('_', ' ')}`
                  : `Changed the task ${quoted(before.title)}${req.body?.title !== undefined ? ` to ${title}` : ''}`;
        return {
            summary,
            entityId: before.id,
            undoData: { before: { title: before.title, status: before.status, priority: before.priority, dueDate: before.dueDate?.toISOString() ?? null, completedAt: before.completedAt?.toISOString() ?? null } },
        };
    },
});

// ─── The decision journal (LOOP_COMPLETE_SPEC 4.2) ─────────────────────

/** POST /api/decisions by an agent: marked as the agent's; Undo deletes it. */
export const logDecisionCreate = agentEdit('decision_create', {
    after: async ({ actor, data }) => {
        await prisma.decision.updateMany({ where: { id: data._id, userId: actor.userId }, data: byAgent(actor) });
        return { summary: `Logged the decision ${quoted(String(data.title))} (look again ${data.lookAgainDay})`, entityId: data._id };
    },
});

/** PATCH /api/decisions/:id by an agent: Undo puts every field back. */
export const logDecisionUpdate = agentEdit<Awaited<ReturnType<typeof decisionBefore>>>('decision_update', {
    before: (req, actor) => decisionBefore(actor.userId, routeId(req)),
    after: ({ before, data }) =>
        before
            ? {
                  summary: `Changed the decision ${quoted(String(data?.title ?? before.title))}`,
                  entityId: before.id,
                  undoData: {
                      before: {
                          title: before.title,
                          why: before.why,
                          expect: before.expect,
                          lookAgainDay: fromDbDay(before.lookAgainDay),
                          status: before.status,
                          verdict: before.verdict,
                          verdictNote: before.verdictNote,
                          reviewedAt: before.reviewedAt?.toISOString() ?? null,
                      },
                  },
              }
            : null,
});

// ─── The manager's tools (MANAGER_AND_DOCS_PLAN §3.3): revisions, settings, projects ──────

/** The item a revision belongs to, in words. */
async function revisionItem(userId: string, revisionId: string) {
    const rev = await prisma.revision.findFirst({
        where: { id: revisionId, userId },
        select: { id: true, status: true, scheduledFor: true, cycleNumber: true, topic: { select: { title: true } }, capture: { select: { title: true, content: true } } },
    });
    if (!rev) return null;
    const title = rev.topic?.title ?? (rev.capture?.title || rev.capture?.content?.slice(0, 50) || 'a note');
    return { id: rev.id, status: rev.status, day: fromDbDay(rev.scheduledFor), cycle: rev.cycleNumber, title };
}

/** POST /api/revisions/:id/complete by an agent: Undo marks it not done again. */
export const logRevisionComplete = agentEdit<Awaited<ReturnType<typeof revisionItem>>>('revision_complete', {
    before: (req, actor) => revisionItem(actor.userId, routeId(req)),
    after: ({ before }) => (before && before.status !== 'done' ? { summary: `Marked the review of ${quoted(before.title)} done (review ${before.cycle})`, entityId: before.id } : null),
});

/** POST /api/revisions/:id/reschedule {day} by an agent: Undo moves it back to its day. */
export const logRevisionReschedule = agentEdit<Awaited<ReturnType<typeof revisionItem>>>('revision_reschedule', {
    before: (req, actor) => revisionItem(actor.userId, routeId(req)),
    after: ({ req, before }) => {
        const to = String(req.body?.day ?? '');
        if (!before || before.day === to) return null;
        return { summary: `Moved the review of ${quoted(before.title)} from ${before.day} to ${to}`, entityId: before.id, undoData: { from: before.day, to } };
    },
});

/** What an agent may change in the learning settings (not the time zone or the old routine). */
export const AGENT_SETTINGS = ['dailyBudgetMin', 'busyUntil', 'nudgeEmailEnabled', 'nudgeTime', 'agentProfile'] as const;
type AgentSetting = (typeof AGENT_SETTINGS)[number];

/** PATCH /api/learning/settings by an agent: only AGENT_SETTINGS; Undo puts the old values back. */
export const logSettingsUpdate = agentEdit<Partial<Record<AgentSetting, unknown>>>('settings_update', {
    before: async (req, actor) => {
        const keys = Object.keys(req.body ?? {});
        const refused = keys.filter((k) => !(AGENT_SETTINGS as readonly string[]).includes(k));
        if (refused.length > 0) throw new LearningHttpError(403, 'SETTING_NOT_ALLOWED', `Agents may change ${AGENT_SETTINGS.join(', ')}; not ${refused.join(', ')}`);
        const row = await prisma.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { dailyBudgetMin: true, busyUntil: true, nudgeEmailEnabled: true, nudgeTime: true, agentProfile: true } });
        const all: Record<AgentSetting, unknown> = { ...row, busyUntil: fromDbDayOrNull(row.busyUntil) };
        return Object.fromEntries(keys.map((k) => [k, all[k as AgentSetting]])) as Partial<Record<AgentSetting, unknown>>;
    },
    after: ({ req, before }) => {
        const changed = Object.keys(before).filter((k) => JSON.stringify(before[k as AgentSetting] ?? null) !== JSON.stringify(req.body?.[k] ?? null));
        if (changed.length === 0) return null;
        const words: Record<string, string> = { dailyBudgetMin: 'daily budget', busyUntil: 'busy until', nudgeEmailEnabled: 'morning email', nudgeTime: 'morning email time', agentProfile: 'profile' };
        return {
            summary: `Changed the settings: ${changed.map((k) => (k === 'agentProfile' ? 'profile' : `${words[k]} ${String(before[k as AgentSetting] ?? 'none')} → ${String(req.body?.[k] ?? 'none')}`)).join(', ')}`,
            undoData: { before } as Prisma.InputJsonValue,
        };
    },
});

/** PATCH /api/projects/:id by an agent: Undo puts the old fields back. */
export const logProjectUpdate = agentEdit<{ id: string; name: string; goalId: string | null; isArchived: boolean; nextStep: string | null } | null>('project_update', {
    before: (req, actor) => prisma.project.findFirst({ where: { id: routeId(req), userId: actor.userId }, select: { id: true, name: true, goalId: true, isArchived: true, nextStep: true } }),
    after: ({ req, before }) => {
        if (!before) return null;
        const parts = [
            req.body?.name !== undefined && req.body.name !== before.name ? `renamed it ${quoted(String(req.body.name))}` : null,
            req.body?.nextStep !== undefined && req.body.nextStep !== before.nextStep ? 'set its next step' : null,
            req.body?.goalId !== undefined && req.body.goalId !== before.goalId ? (req.body.goalId ? 'linked a goal' : 'unlinked its goal') : null,
            req.body?.isArchived !== undefined && req.body.isArchived !== before.isArchived ? (req.body.isArchived ? 'archived it' : 'took it out of the archive') : null,
        ].filter(Boolean);
        if (parts.length === 0) return null;
        return { summary: `Changed the project ${quoted(before.name)}: ${parts.join(', ')}`, entityId: before.id, undoData: { before: { name: before.name, goalId: before.goalId, isArchived: before.isArchived, nextStep: before.nextStep } } };
    },
});

// ─── The manager's last tools (stage 4 part 2) ─────────────────────────

/** POST /api/reminders: on a task, or with the task it made (Undo cancels it, and deletes that task). */
export const logReminderSet = agentEdit('reminder_set', {
    after: ({ data }) => ({
        summary: `Set a reminder for ${quoted(String(data.task))}${data.createdTask ? ' (a new task)' : ''}`,
        entityId: data._id,
        undoData: { createdTaskId: data.createdTask ? String(data.taskId) : null },
    }),
});

/** POST /api/reminders/:id/cancel (Undo sets it again while its time is ahead). */
export const logReminderCancel = agentEdit('reminder_cancel', {
    after: ({ data }) => ({ summary: `Cancelled the reminder for ${quoted(String(data.task))}`, entityId: data._id }),
});

/** POST /api/revisions/spread: logged only when it moved reviews (asking is its own card). */
export const logRevisionsSpread = agentEdit('revisions_spread', {
    after: ({ data }) => {
        const changes: Array<{ id: string; from: string; to: string }> = Array.isArray(data.changes) ? data.changes : [];
        if (data.asked || changes.length === 0) return null;
        return { summary: `Spread ${plural(Number(data.moved), 'overdue review')} over ${plural(Number(data.spreadDays), 'day')}`, undoData: { changes } };
    },
});
