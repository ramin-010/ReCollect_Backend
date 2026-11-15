// Goals with deadlines and their milestones (LOOP_V2_SPEC §4). Owner only: another user's goal,
// milestone or subject id is a 404 `Not found`. At most 3 ACTIVE goals: creating or re-activating a
// 4th is a 409 GOAL_LIMIT (checked with the user row locked, so two quick creates cannot pass it).
//
// Writes run in a transaction with `select: { id: true }`; the goal with its relations is loaded
// after the commit on the root client (MIGRATION_CONVENTIONS rule 11).
import type { GoalStatus, Prisma } from '@prisma/client';
import { prisma, type DbClient, type TxClient } from '../../db/prisma';
import { dayOf, goalForecast, type DayString, type GoalForecast } from '../learning';
import { badRequest, conflict, notFound } from '../learning/http';
import {
    serializeGoal,
    serializeMilestone,
    serializeTodayGoal,
    type GoalJson,
    type GoalWithRelations,
    type MilestoneJson,
} from '../../db/serializers/learning';
import { fromDbDay, loadLearningContext, lockLearningContext, toDbDay, type LearningContext } from './common';

export const GOAL_ACTIVE_LIMIT = 3;

const subjectRefSelect = { id: true, name: true, color: true } as const;

/** Read on the root client only (2 relations). */
export const goalInclude = {
    milestones: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
    subjects: { select: { subject: { select: subjectRefSelect } }, orderBy: [{ createdAt: 'asc' }, { subjectId: 'asc' }] },
} satisfies Prisma.GoalInclude;

/** The forecast of a loaded goal for the user's today. */
export function forecastOf(goal: Pick<GoalWithRelations, 'createdAt' | 'deadline' | 'status' | 'milestones'>, ctx: Pick<LearningContext, 'today' | 'tz'>): GoalForecast {
    return goalForecast({
        milestones: goal.milestones,
        createdDay: dayOf(goal.createdAt, ctx.tz),
        deadline: fromDbDay(goal.deadline),
        today: ctx.today,
        goalDone: goal.status === 'done',
    });
}

export function goalJson(goal: GoalWithRelations, ctx: Pick<LearningContext, 'today' | 'tz'>): GoalJson {
    return serializeGoal(goal, forecastOf(goal, ctx));
}

/** GET /api/today `goals`: active goals, nearest deadline first. */
export function todayGoalsJson(goals: readonly GoalWithRelations[], ctx: Pick<LearningContext, 'today' | 'tz'>) {
    return goals
        .filter((g) => g.status === 'active')
        .sort((a, b) => a.deadline.getTime() - b.deadline.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
        // createdDay: Home's goal meter draws where a steady pace would be today.
        .map((g) => ({ ...serializeTodayGoal(g, forecastOf(g, ctx)), createdDay: dayOf(g.createdAt, ctx.tz) }));
}

async function loadGoalJson(goalId: string, ctx: Pick<LearningContext, 'today' | 'tz'>): Promise<GoalJson> {
    const goal = await prisma.goal.findUniqueOrThrow({ where: { id: goalId }, include: goalInclude });
    return goalJson(goal, ctx);
}

async function ownedGoal(db: DbClient, userId: string, goalId: string) {
    const goal = await db.goal.findFirst({ where: { id: goalId, userId }, select: { id: true, status: true } });
    if (!goal) throw notFound();
    return goal;
}

/** Every id must be one of the user's subjects (404 otherwise). */
async function assertOwnedSubjects(db: DbClient, userId: string, subjectIds: readonly string[]): Promise<string[]> {
    const unique = [...new Set(subjectIds)];
    if (unique.length === 0) return unique;
    const found = await db.subject.count({ where: { userId, id: { in: unique } } });
    if (found !== unique.length) throw notFound();
    return unique;
}

function assertDeadline(deadline: DayString, today: DayString): void {
    if (deadline < today) throw badRequest('The deadline must be today or later', 'INVALID_DAY');
}

async function assertActiveRoom(tx: TxClient, userId: string): Promise<void> {
    const active = await tx.goal.count({ where: { userId, status: 'active' } });
    if (active >= GOAL_ACTIVE_LIMIT) throw conflict(`Up to ${GOAL_ACTIVE_LIMIT} active goals`, 'GOAL_LIMIT');
}

const whyOrNull = (why: string | null | undefined): string | null => (why === null || why === undefined ? null : why.trim() || null);

// ─── Goals ─────────────────────────────────────────────────────────────

/** GET /api/goals: active first (nearest deadline first), then done, then archived. */
export async function listGoals(userId: string, now: Date = new Date()): Promise<GoalJson[]> {
    const ctx = await loadLearningContext(userId, now);
    const rank: Record<GoalStatus, number> = { active: 0, done: 1, archived: 2 };
    const goals = await prisma.goal.findMany({ where: { userId }, include: goalInclude });
    return goals
        .sort((a, b) => rank[a.status] - rank[b.status] || a.deadline.getTime() - b.deadline.getTime() || a.createdAt.getTime() - b.createdAt.getTime())
        .map((g) => goalJson(g, ctx));
}

export interface CreateGoalInput {
    title: string;
    why?: string | null | undefined;
    deadline: DayString;
    subjectIds?: string[] | undefined;
    milestones?: Array<{ title: string; dueDay?: DayString | null | undefined }> | undefined;
}

/** POST /api/goals (201). A 4th active goal → 409 GOAL_LIMIT. */
export async function createGoal(userId: string, input: CreateGoalInput, now: Date = new Date()): Promise<GoalJson> {
    const subjectIds = await assertOwnedSubjects(prisma, userId, input.subjectIds ?? []);
    const { goalId, ctx } = await prisma.$transaction(async (tx) => {
        const ctx = await lockLearningContext(tx, userId, now);
        assertDeadline(input.deadline, ctx.today);
        await assertActiveRoom(tx, userId);
        const goal = await tx.goal.create({
            data: { userId, title: input.title.trim(), why: whyOrNull(input.why), deadline: toDbDay(input.deadline) },
            select: { id: true },
        });
        if (subjectIds.length > 0) await tx.goalSubject.createMany({ data: subjectIds.map((subjectId) => ({ goalId: goal.id, subjectId })) });
        const milestones = input.milestones ?? [];
        if (milestones.length > 0) {
            await tx.goalMilestone.createMany({
                data: milestones.map((m, i) => ({ goalId: goal.id, title: m.title.trim(), dueDay: m.dueDay ? toDbDay(m.dueDay) : null, sortOrder: i })),
            });
        }
        return { goalId: goal.id, ctx };
    });
    return loadGoalJson(goalId, ctx);
}

export interface UpdateGoalInput {
    title?: string | undefined;
    why?: string | null | undefined;
    deadline?: DayString | undefined;
    status?: GoalStatus | undefined;
    /** Replaces the linked subjects. */
    subjectIds?: string[] | undefined;
}

/** PATCH /api/goals/:id. Re-activating with 3 active goals → 409 GOAL_LIMIT. */
export async function updateGoal(userId: string, goalId: string, input: UpdateGoalInput, now: Date = new Date()): Promise<GoalJson> {
    await ownedGoal(prisma, userId, goalId);
    const subjectIds = input.subjectIds === undefined ? undefined : await assertOwnedSubjects(prisma, userId, input.subjectIds);
    const ctx = await prisma.$transaction(async (tx) => {
        const ctx = await lockLearningContext(tx, userId, now);
        const goal = await ownedGoal(tx, userId, goalId);
        if (input.deadline !== undefined) assertDeadline(input.deadline, ctx.today);
        if (input.status === 'active' && goal.status !== 'active') await assertActiveRoom(tx, userId);
        const data: Prisma.GoalUpdateInput = {};
        if (input.title !== undefined) data.title = input.title.trim();
        if (input.why !== undefined) data.why = whyOrNull(input.why);
        if (input.deadline !== undefined) data.deadline = toDbDay(input.deadline);
        if (input.status !== undefined) data.status = input.status;
        if (Object.keys(data).length > 0 || subjectIds !== undefined) {
            data.updatedAt = now;
            await tx.goal.update({ where: { id: goalId }, data, select: { id: true } });
        }
        if (subjectIds !== undefined) {
            await tx.goalSubject.deleteMany({ where: { goalId, subjectId: { notIn: subjectIds } } });
            if (subjectIds.length > 0) {
                await tx.goalSubject.createMany({ data: subjectIds.map((subjectId) => ({ goalId, subjectId })), skipDuplicates: true });
            }
        }
        return ctx;
    });
    return loadGoalJson(goalId, ctx);
}

/** DELETE /api/goals/:id (its milestones and subject links go with it). */
export async function deleteGoal(userId: string, goalId: string): Promise<{ deleted: true }> {
    const { count } = await prisma.goal.deleteMany({ where: { id: goalId, userId } });
    if (count === 0) throw notFound();
    return { deleted: true };
}

// ─── Milestones ────────────────────────────────────────────────────────

/** POST /api/goals/:id/milestones {title, dueDay?} (201) → { milestone, goal }. */
export async function createMilestone(
    userId: string,
    goalId: string,
    input: { title: string; dueDay?: DayString | null | undefined },
    now: Date = new Date()
): Promise<{ milestone: MilestoneJson; goal: GoalJson }> {
    const ctx = await loadLearningContext(userId, now);
    const milestone = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Goal" WHERE "id" = ${goalId} FOR UPDATE`;
        await ownedGoal(tx, userId, goalId);
        const last = await tx.goalMilestone.findFirst({ where: { goalId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
        return tx.goalMilestone.create({
            data: { goalId, title: input.title.trim(), dueDay: input.dueDay ? toDbDay(input.dueDay) : null, sortOrder: last ? last.sortOrder + 1 : 0 },
        });
    });
    return { milestone: serializeMilestone(milestone), goal: await loadGoalJson(goalId, ctx) };
}

async function ownedMilestone(userId: string, milestoneId: string) {
    const m = await prisma.goalMilestone.findFirst({ where: { id: milestoneId, goal: { userId } }, select: { id: true, goalId: true, done: true } });
    if (!m) throw notFound();
    return m;
}

/** PATCH /api/goal-milestones/:id {title?, dueDay?, done?, sortOrder?} → { milestone, goal }. done sets / clears doneAt. */
export async function updateMilestone(
    userId: string,
    milestoneId: string,
    input: { title?: string | undefined; dueDay?: DayString | null | undefined; done?: boolean | undefined; sortOrder?: number | undefined },
    now: Date = new Date()
): Promise<{ milestone: MilestoneJson; goal: GoalJson }> {
    const owned = await ownedMilestone(userId, milestoneId);
    const ctx = await loadLearningContext(userId, now);
    const data: Prisma.GoalMilestoneUpdateInput = {};
    if (input.title !== undefined) data.title = input.title.trim();
    if (input.dueDay !== undefined) data.dueDay = input.dueDay ? toDbDay(input.dueDay) : null;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.done !== undefined && input.done !== owned.done) {
        data.done = input.done;
        data.doneAt = input.done ? now : null;
    }
    const milestone = Object.keys(data).length > 0
        ? await prisma.goalMilestone.update({ where: { id: milestoneId }, data })
        : await prisma.goalMilestone.findUniqueOrThrow({ where: { id: milestoneId } });
    return { milestone: serializeMilestone(milestone), goal: await loadGoalJson(owned.goalId, ctx) };
}

/** DELETE /api/goal-milestones/:id → { deleted: true, goal }. */
export async function deleteMilestone(userId: string, milestoneId: string, now: Date = new Date()): Promise<{ deleted: true; goal: GoalJson }> {
    const owned = await ownedMilestone(userId, milestoneId);
    await prisma.goalMilestone.deleteMany({ where: { id: milestoneId, goal: { userId } } });
    const ctx = await loadLearningContext(userId, now);
    return { deleted: true, goal: await loadGoalJson(owned.goalId, ctx) };
}
