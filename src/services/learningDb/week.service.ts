// The week (LOOP_COMPLETE_SPEC 1.6): Monday to Sunday in the user's zone, up to 5 targets. Every
// number is worked out when read: a target is done when it is ticked, or when what it points at is
// done (a topic, a milestone, a task) or its count is reached (practice sessions, session minutes or
// topics finished, in that week, in its subject or project). Nothing punishes an empty week.
//
//   getWeek          GET   /api/week?start=           read
//   addWeekTarget    POST  /api/week/targets          learning:write (agent: week_target_create)
//   updateWeekTarget PATCH /api/week/targets/:id      learning:write (agent: week_target_update)
// The Sunday review's proposals are Suggestion rows (suggestions.service.ts, proposeWeek).
import type { CreatedBy, Prisma, SessionArea, SessionKind, TopicStatus, TodoStatus, WeekMeasure, WeekTargetStatus } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { addDays, startOfDay, type DayString } from '../learning';
import { badRequest, conflict, notFound } from '../learning/http';
import { fromDbDay, loadLearningContext, toDbDay, type LearningContext } from './common';
import { inLens, progressLens, type ProgressLens } from './lens';

export const WEEK_TARGETS_MAX = 5;
export const WEEK_TARGET_TEXT_MAX = 140;
export const WEEK_MEASURES = ['practice', 'minutes', 'topics'] as const satisfies readonly WeekMeasure[];
export const WEEK_TARGET_STATUSES = ['open', 'done', 'dropped'] as const satisfies readonly WeekTargetStatus[];

/** The Monday of the week a local day is in. */
export function weekStartOf(day: DayString): DayString {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    return addDays(day, -((dow + 6) % 7));
}

export const isSunday = (day: DayString): boolean => new Date(`${day}T00:00:00Z`).getUTCDay() === 0;

/** The week the Sunday review plans: on Sunday the next one, on other days the running one. */
export const reviewWeekOf = (today: DayString): DayString => (isSunday(today) ? addDays(today, 1) : weekStartOf(today));

export interface WeekTargetJson {
    _id: string;
    weekStart: DayString;
    text: string;
    status: WeekTargetStatus;
    /** Ticked, or what it points at is done, or its count is reached. */
    done: boolean;
    /** A count's progress (measure + amount), else null. */
    progress: { done: number; total: number } | null;
    topic: { _id: string; title: string; status: TopicStatus } | null;
    milestone: { _id: string; title: string; done: boolean } | null;
    task: { _id: string; title: string; status: TodoStatus } | null;
    measure: WeekMeasure | null;
    amount: number | null;
    subject: { _id: string; name: string } | null;
    project: { _id: string; key: string; name: string } | null;
    sortOrder: number;
    createdBy: CreatedBy;
    agentName: string | null;
}

const TARGET_INCLUDE = {
    topic: { select: { id: true, title: true, status: true, doc: { select: { title: true } } } },
    milestone: { select: { id: true, title: true, done: true } },
    todo: { select: { id: true, title: true, status: true } },
    subject: { select: { id: true, name: true } },
    project: { select: { id: true, key: true, name: true } },
} as const;
type TargetRow = Prisma.WeekTargetGetPayload<{ include: typeof TARGET_INCLUDE }>;

/**
 * What a week's counts need: its sessions (both areas: a target on a work folder counts that folder's time), the
 * topics finished in it, and the person's progress lens (a target on no folder counts what counts as progress).
 */
export interface WeekActivity {
    sessions: Array<{ kind: SessionKind; minutes: number | null; subjectId: string | null; projectId: string | null; area: SessionArea }>;
    topicsDone: Array<{ subjectId: string }>;
    lens: ProgressLens;
}

export async function loadWeekActivity(userId: string, weekStart: DayString, tz: string): Promise<WeekActivity> {
    const weekEnd = addDays(weekStart, 6);
    const [sessions, topicsDone, lens] = await Promise.all([
        prisma.workSession.findMany({
            where: { userId, day: { gte: toDbDay(weekStart), lte: toDbDay(weekEnd) } },
            select: { kind: true, minutes: true, subjectId: true, projectId: true, area: true },
        }),
        prisma.topic.findMany({
            where: { userId, status: 'done', doneAt: { gte: startOfDay(weekStart, tz), lt: startOfDay(addDays(weekEnd, 1), tz) } },
            select: { subjectId: true },
        }),
        progressLens(userId),
    ]);
    return { sessions, topicsDone, lens };
}

/** A count's progress in its week (pure). */
export function countProgress(
    target: { measure: WeekMeasure | null; amount: number | null; subjectId: string | null; projectId: string | null },
    activity: WeekActivity
): { done: number; total: number } | null {
    if (!target.measure || !target.amount) return null;
    // A target on a folder counts that folder's time; any other counts only what counts as progress (PERSONAL_OFFICE_PLAN).
    const inScope = (s: { subjectId: string | null; projectId: string | null; area: SessionArea }) =>
        (!target.subjectId || s.subjectId === target.subjectId) && (target.projectId ? s.projectId === target.projectId : inLens(activity.lens, s.area));
    let done = 0;
    if (target.measure === 'practice') done = activity.sessions.filter((s) => s.kind === 'practice' && inScope(s)).length;
    else if (target.measure === 'minutes') done = activity.sessions.filter(inScope).reduce((sum, s) => sum + (s.minutes ?? 0), 0);
    else done = activity.topicsDone.filter((t) => !target.subjectId || t.subjectId === target.subjectId).length;
    return { done: Math.min(done, target.amount), total: target.amount };
}

export function serializeTarget(r: TargetRow, activity: WeekActivity): WeekTargetJson {
    const progress = countProgress(r, activity);
    const done =
        r.status === 'done' ||
        (r.status === 'open' &&
            ((r.topic?.status ?? null) === 'done' || r.milestone?.done === true || r.todo?.status === 'complete' || (!!progress && progress.done >= progress.total)));
    return {
        _id: r.id,
        weekStart: fromDbDay(r.weekStart),
        text: r.text,
        status: r.status,
        done,
        progress,
        topic: r.topic ? { _id: r.topic.id, title: r.topic.doc?.title || r.topic.title, status: r.topic.status } : null,
        milestone: r.milestone ? { _id: r.milestone.id, title: r.milestone.title, done: r.milestone.done } : null,
        task: r.todo ? { _id: r.todo.id, title: r.todo.title, status: r.todo.status } : null,
        measure: r.measure,
        amount: r.amount,
        subject: r.subject ? { _id: r.subject.id, name: r.subject.name } : null,
        project: r.project ? { _id: r.project.id, key: r.project.key, name: r.project.name } : null,
        sortOrder: r.sortOrder,
        createdBy: r.createdBy,
        agentName: r.agentName,
    };
}

/** The targets of a week (dropped ones left out), in order, with what is done worked out. */
export async function weekTargets(userId: string, weekStart: DayString, tz: string, activity?: WeekActivity): Promise<WeekTargetJson[]> {
    const rows = await prisma.weekTarget.findMany({
        where: { userId, weekStart: toDbDay(weekStart), status: { not: 'dropped' } },
        include: TARGET_INCLUDE,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const act = activity ?? (await loadWeekActivity(userId, weekStart, tz));
    return rows.map((r) => serializeTarget(r, act));
}

export interface WeekSummary {
    weekStart: DayString;
    targets: { done: number; total: number };
    minutes: Record<SessionKind, number>;
    topicsDone: number;
    revisionsDone: number;
}

/** A week in one line's worth of numbers (the Sunday card: "3 of 4 done, 6 h studied"). */
export async function weekSummary(userId: string, weekStart: DayString, tz: string): Promise<WeekSummary> {
    const activity = await loadWeekActivity(userId, weekStart, tz);
    const targets = await weekTargets(userId, weekStart, tz, activity);
    const minutes: Record<SessionKind, number> = { study: 0, practice: 0, build: 0, review: 0 };
    for (const s of activity.sessions) minutes[s.kind] += s.minutes ?? 0;
    const revisionsDone = await prisma.revision.count({
        where: { userId, status: 'done', completedAt: { gte: startOfDay(weekStart, tz), lt: startOfDay(addDays(weekStart, 7), tz) } },
    });
    return { weekStart, targets: { done: targets.filter((t) => t.done).length, total: targets.length }, minutes, topicsDone: activity.topicsDone.length, revisionsDone };
}

// ─── Writes ────────────────────────────────────────────────────────────

export interface WeekTargetInput {
    text: string;
    weekStart?: string | undefined;
    topicId?: string | null | undefined;
    milestoneId?: string | null | undefined;
    todoId?: string | null | undefined;
    measure?: WeekMeasure | null | undefined;
    amount?: number | null | undefined;
    subjectId?: string | null | undefined;
    projectId?: string | null | undefined;
}

const cleanText = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, WEEK_TARGET_TEXT_MAX);

/** Everything a new target names, checked: owned, at most one link, a count with an amount. */
async function checkLinks(userId: string, input: Omit<WeekTargetInput, 'text' | 'weekStart'>): Promise<void> {
    const links = [input.topicId, input.milestoneId, input.todoId].filter(Boolean).length;
    if (links > 1) throw badRequest('A target points at one thing at most: a topic, a milestone or a task');
    if (links && input.measure) throw badRequest('A target either points at something or counts (measure + amount), not both');
    if (input.measure && !(Number.isInteger(input.amount) && input.amount! >= 1 && input.amount! <= 10_000)) throw badRequest('A count needs an amount: a whole number from 1');
    if (!input.measure && input.amount != null) throw badRequest('amount needs a measure: practice, minutes or topics');
    if (input.topicId && !(await prisma.topic.findFirst({ where: { id: input.topicId, userId, isArchived: false }, select: { id: true } }))) throw badRequest(`No topic with id ${input.topicId} (get_path shows them)`, 'UNKNOWN_TOPIC');
    if (input.milestoneId && !(await prisma.goalMilestone.findFirst({ where: { id: input.milestoneId, goal: { userId } }, select: { id: true } }))) throw badRequest(`No milestone with id ${input.milestoneId} (list_goals shows them)`, 'UNKNOWN_MILESTONE');
    if (input.todoId && !(await prisma.todo.findFirst({ where: { id: input.todoId, userId, workspaceId: null }, select: { id: true } }))) throw badRequest(`No task with id ${input.todoId}`, 'UNKNOWN_TASK');
    if (input.subjectId && !(await prisma.subject.findFirst({ where: { id: input.subjectId, userId }, select: { id: true } }))) throw badRequest(`No subject with id ${input.subjectId}`, 'UNKNOWN_SUBJECT');
    if (input.projectId && !(await prisma.project.findFirst({ where: { id: input.projectId, userId }, select: { id: true } }))) throw badRequest(`No project with id ${input.projectId}`, 'UNKNOWN_PROJECT');
}

/** The week a write is for: the Monday of `weekStart` (any day of it), else the running week. */
function weekOfInput(ctx: LearningContext, weekStart: string | undefined): DayString {
    if (!weekStart) return weekStartOf(ctx.today);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) throw badRequest('weekStart is a day, YYYY-MM-DD');
    const monday = weekStartOf(weekStart as DayString);
    if (monday < addDays(weekStartOf(ctx.today), -7)) throw badRequest('That week is over: targets go on this week or a later one');
    return monday;
}

/** POST /api/week/targets: one more target (at most 5 that are not dropped: 409 WEEK_FULL). */
export async function addWeekTarget(userId: string, input: WeekTargetInput, now: Date = new Date()): Promise<WeekTargetJson> {
    const ctx = await loadLearningContext(userId, now);
    const text = cleanText(input.text ?? '');
    if (!text) throw badRequest('text cannot be empty');
    const weekStart = weekOfInput(ctx, input.weekStart);
    await checkLinks(userId, input);
    const made = await prisma.$transaction(async (tx) => {
        // One writer per user at a time, so two adds can't both take the 5th place.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`week:${userId}`}))`;
        const count = await tx.weekTarget.count({ where: { userId, weekStart: toDbDay(weekStart), status: { not: 'dropped' } } });
        if (count >= WEEK_TARGETS_MAX) throw conflict(`A week holds ${WEEK_TARGETS_MAX} targets at most: drop or finish one first`, 'WEEK_FULL');
        return tx.weekTarget.create({
            data: {
                userId,
                weekStart: toDbDay(weekStart),
                text,
                sortOrder: count,
                topicId: input.topicId ?? null,
                milestoneId: input.milestoneId ?? null,
                todoId: input.todoId ?? null,
                measure: input.measure ?? null,
                amount: input.measure ? input.amount ?? null : null,
                subjectId: input.subjectId ?? null,
                projectId: input.projectId ?? null,
            },
            select: { id: true },
        });
    });
    return (await weekTargets(userId, weekStart, ctx.tz)).find((t) => t._id === made.id)!;
}

export interface WeekTargetPatch {
    text?: string | undefined;
    status?: WeekTargetStatus | undefined;
    sortOrder?: number | undefined;
}

/** PATCH /api/week/targets/:id: change the text, tick it (done), untick it (open), drop it, move it. */
export async function updateWeekTarget(userId: string, id: string, patch: WeekTargetPatch, now: Date = new Date()): Promise<WeekTargetJson> {
    const row = await prisma.weekTarget.findFirst({ where: { id, userId }, select: { id: true, weekStart: true, status: true } });
    if (!row) throw notFound();
    const ctx = await loadLearningContext(userId, now);
    const text = patch.text !== undefined ? cleanText(patch.text) : undefined;
    if (text !== undefined && !text) throw badRequest('text cannot be empty');
    if (patch.status === 'open' && row.status === 'dropped') {
        const count = await prisma.weekTarget.count({ where: { userId, weekStart: row.weekStart, status: { not: 'dropped' } } });
        if (count >= WEEK_TARGETS_MAX) throw conflict(`A week holds ${WEEK_TARGETS_MAX} targets at most`, 'WEEK_FULL');
    }
    await prisma.weekTarget.update({
        where: { id },
        data: {
            ...(text !== undefined ? { text } : {}),
            ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
            ...(patch.status !== undefined ? { status: patch.status, doneAt: patch.status === 'done' ? now : null } : {}),
        },
        select: { id: true },
    });
    const weekStart = fromDbDay(row.weekStart);
    const all = await prisma.weekTarget.findUniqueOrThrow({ where: { id }, include: TARGET_INCLUDE });
    return serializeTarget(all, await loadWeekActivity(userId, weekStart, ctx.tz));
}

/** What an agent's update changed, for its Undo. */
export async function weekTargetBefore(userId: string, id: string): Promise<{ id: string; text: string; status: WeekTargetStatus; sortOrder: number; doneAt: Date | null } | null> {
    return prisma.weekTarget.findFirst({ where: { id, userId }, select: { id: true, text: true, status: true, sortOrder: true, doneAt: true } });
}

// ─── The week, read ────────────────────────────────────────────────────

export interface WeekJson {
    weekStart: DayString;
    weekEnd: DayString;
    targets: WeekTargetJson[];
    /** The week before the one the review plans (on Sunday: this one). */
    lastWeek: WeekSummary;
    review: { due: boolean; weekStart: DayString };
}

/**
 * The review is due from Sunday for the week that starts the next day, and on any later day while
 * the running week has no targets, until that week's batch of proposals is decided or skipped.
 */
export async function reviewDue(userId: string, today: DayString): Promise<{ due: boolean; weekStart: DayString }> {
    const weekStart = reviewWeekOf(today);
    const targets = await prisma.weekTarget.count({ where: { userId, weekStart: toDbDay(weekStart), status: { not: 'dropped' } } });
    if (targets > 0) return { due: false, weekStart };
    const batch = await prisma.suggestion.groupBy({ by: ['status'], where: { userId, batch: `week:${weekStart}` }, _count: true });
    const decided = batch.length > 0 && !batch.some((b) => b.status === 'pending');
    return { due: !decided, weekStart };
}

/** GET /api/week: a week (the running one by default) with its targets, last week and the review. */
export async function getWeek(userId: string, options: { start?: string | undefined } = {}, now: Date = new Date()): Promise<WeekJson> {
    const ctx = await loadLearningContext(userId, now);
    if (options.start && !/^\d{4}-\d{2}-\d{2}$/.test(options.start)) throw badRequest('start is a day, YYYY-MM-DD');
    const weekStart = options.start ? weekStartOf(options.start as DayString) : weekStartOf(ctx.today);
    const review = await reviewDue(userId, ctx.today);
    const [targets, lastWeek] = await Promise.all([weekTargets(userId, weekStart, ctx.tz), weekSummary(userId, addDays(review.weekStart, -7), ctx.tz)]);
    return { weekStart, weekEnd: addDays(weekStart, 6), targets, lastWeek, review };
}
