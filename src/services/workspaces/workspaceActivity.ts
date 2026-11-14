// Workspace activity log: every ActivityLog write and read goes through here.
// Same actions, actors, targets and metadata strings as the Mongo controllers wrote.
import type { ActivityAction } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { activityInclude, type ActivityWithRelations } from '../../db/serializers/workspace';

/** GET /api/workspaces/:id/activity returned the last 30 entries. */
export const WORKSPACE_ACTIVITY_LIMIT = 30;

export interface ActivityInput {
    workspaceId: string;
    actorId: string;
    action: ActivityAction;
    targetTaskId?: string | null;
    targetUserId?: string | null;
    metadata?: string | null;
}

export function logActivity(input: ActivityInput, db: DbClient = prisma) {
    return db.activityLog.create({
        data: {
            workspaceId: input.workspaceId,
            actorId: input.actorId,
            action: input.action,
            targetTaskId: input.targetTaskId ?? null,
            targetUserId: input.targetUserId ?? null,
            metadata: input.metadata ?? null,
        },
    });
}

/** Several entries, written one after another so createdAt keeps their order. */
export async function logActivities(inputs: readonly ActivityInput[], db: DbClient = prisma): Promise<void> {
    for (const input of inputs) {
        await logActivity(input, db);
    }
}

/** Newest first (ties broken by id so the order is stable). */
export function listWorkspaceActivity(
    workspaceId: string,
    db: DbClient = prisma,
    limit = WORKSPACE_ACTIVITY_LIMIT
): Promise<ActivityWithRelations[]> {
    return db.activityLog.findMany({
        where: { workspaceId },
        include: activityInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
    });
}

/** GET /api/workspace-todos/:id/activity: every entry about one task, newest first. */
export function listTaskActivity(todoId: string, db: DbClient = prisma): Promise<ActivityWithRelations[]> {
    return db.activityLog.findMany({
        where: { targetTaskId: todoId },
        include: activityInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
}
