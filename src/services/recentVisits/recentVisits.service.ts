// Recently visited items (home page + sidebar). One row per (user, itemId); at most 20 per user.
import type { RecentVisit, RecentVisitItemType } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';

export const MAX_RECENT_VISITS = 20;

export const RECENT_VISIT_ITEM_TYPES: readonly RecentVisitItemType[] = ['doc', 'slide', 'workspace'];

export function isRecentVisitItemType(value: unknown): value is RecentVisitItemType {
    return typeof value === 'string' && (RECENT_VISIT_ITEM_TYPES as readonly string[]).includes(value);
}

export interface TrackVisitInput {
    itemId: string;
    itemType: RecentVisitItemType;
    title?: string | undefined;
    route: string;
}

/**
 * Record a visit: insert, or refresh visitedAt/title/type/route of the existing (user, itemId) row
 * (the old findOneAndUpdate upsert), then delete everything beyond the newest MAX_RECENT_VISITS.
 */
export async function trackVisit(userId: string, input: TrackVisitInput, now: Date = new Date(), db: DbClient = prisma): Promise<void> {
    const fields = {
        itemType: input.itemType,
        title: input.title || 'Untitled',
        route: input.route,
        visitedAt: now,
    };
    await db.recentVisit.upsert({
        where: { userId_itemId: { userId, itemId: input.itemId } },
        create: { userId, itemId: input.itemId, ...fields },
        update: fields,
    });

    const count = await db.recentVisit.count({ where: { userId } });
    if (count > MAX_RECENT_VISITS) {
        const oldest = await db.recentVisit.findMany({
            where: { userId },
            orderBy: [{ visitedAt: 'desc' }, { id: 'desc' }],
            skip: MAX_RECENT_VISITS,
            select: { id: true },
        });
        if (oldest.length > 0) {
            await db.recentVisit.deleteMany({ where: { id: { in: oldest.map((v) => v.id) } } });
        }
    }
}

/** The newest visits first, at most MAX_RECENT_VISITS. */
export function listRecentVisits(userId: string, db: DbClient = prisma): Promise<RecentVisit[]> {
    return db.recentVisit.findMany({
        where: { userId },
        orderBy: [{ visitedAt: 'desc' }, { id: 'desc' }],
        take: MAX_RECENT_VISITS,
    });
}

/** Remove the visit of one item (no error when there is none, as before). */
export async function removeVisit(userId: string, itemId: string, db: DbClient = prisma): Promise<void> {
    await db.recentVisit.deleteMany({ where: { userId, itemId } });
}
