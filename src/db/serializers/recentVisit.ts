// RecentVisit shape, matching the Mongo API (`.lean()` documents, `timestamps: false`).
// { _id, user, itemId, itemType, title, route, visitedAt }; `user` is the bare user id (it was never
// populated) and there is no __v.
import type { RecentVisit } from '@prisma/client';

export interface RecentVisitJson {
    _id: string;
    user: string;
    itemId: string;
    itemType: RecentVisit['itemType'];
    title: string;
    route: string;
    visitedAt: Date;
}

export function serializeRecentVisit(row: RecentVisit): RecentVisitJson {
    return {
        _id: row.id,
        user: row.userId,
        itemId: row.itemId,
        itemType: row.itemType,
        title: row.title,
        route: row.route,
        visitedAt: row.visitedAt,
    };
}
