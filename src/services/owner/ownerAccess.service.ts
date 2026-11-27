// TRUST_PLAN T4 (11-27): the owner-access log. What the app showed the owner of a person (the People page lists them:
// at most one row an hour per person) and what the owner did to their account (a top-up, a daily limit, access ended
// or restored). The person reads their own rows on Settings › Your data. The app never edits or deletes a row; the
// night job prunes rows after a year; deleting the account deletes them (cascade). What the log can't show (the owner
// reaching the database or the server directly) is said on the page, as the privacy page says it.
import type { OwnerAccessKind, Prisma } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';

const HOUR_MS = 3_600_000;
const YEAR_MS = 365 * 24 * HOUR_MS;
/** What the People page shows of a person: the log names it, so the person reads exactly what was shown. */
export const PEOPLE_PAGE_SHOWS = ['your name', 'email', 'when you joined and were last active', 'the AI you used and its cost', 'the apps you connected', 'what you sent the owner'];

export interface OwnerAccessJson {
    kind: OwnerAccessKind;
    at: string;
    details: Prisma.JsonValue | null;
}

/** The People page listed these people: one `viewed` row each, unless one was written in the last hour. */
export async function logViews(personIds: readonly string[], now: Date = new Date(), db: DbClient = prisma): Promise<number> {
    const ids = [...new Set(personIds)];
    if (ids.length === 0) return 0;
    const recent = await db.ownerAccess.findMany({
        where: { userId: { in: ids }, kind: 'viewed', at: { gt: new Date(now.getTime() - HOUR_MS) } },
        select: { userId: true },
    });
    const seen = new Set(recent.map((r) => r.userId));
    const fresh = ids.filter((id) => !seen.has(id));
    if (fresh.length === 0) return 0;
    const made = await db.ownerAccess.createMany({ data: fresh.map((userId) => ({ userId, kind: 'viewed' as const, details: { shown: PEOPLE_PAGE_SHOWS }, at: now })) });
    return made.count;
}

/** The owner acted on a person's account. */
export async function logAction(userId: string, kind: Exclude<OwnerAccessKind, 'viewed'>, details: Prisma.InputJsonValue | null = null, now: Date = new Date(), db: DbClient = prisma): Promise<void> {
    await db.ownerAccess.create({ data: { userId, kind, ...(details === null ? {} : { details }), at: now } });
}

/** A person's own rows, newest first. */
export async function ownerAccessOf(userId: string, limit = 50, db: DbClient = prisma): Promise<OwnerAccessJson[]> {
    // Rows of the same millisecond keep the order they were written in (cuid ids grow).
    const rows = await db.ownerAccess.findMany({ where: { userId }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: Math.min(Math.max(limit, 1), 500), select: { kind: true, at: true, details: true } });
    return rows.map((r) => ({ kind: r.kind, at: r.at.toISOString(), details: r.details ?? null }));
}

/** The night job: rows older than a year go. */
export async function pruneOwnerAccess(now: Date = new Date(), db: DbClient = prisma): Promise<number> {
    const gone = await db.ownerAccess.deleteMany({ where: { at: { lt: new Date(now.getTime() - YEAR_MS) } } });
    return gone.count;
}
