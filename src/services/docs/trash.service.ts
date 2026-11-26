// The trash (MANAGER_AND_DOCS_PLAN §3.2): a deleted doc waits TRASH_DAYS before it is gone for good.
// Moving a doc to the trash and restoring it are its owner's (someone it is shared with leaves it
// instead); for agents both are logged and undoable. Emptying the trash is permanent: in the app it
// asks first, and for agents and the manager it is an action that needs the user's tap
// (../actions/actions.service.ts). A trashed doc is out of the library's lists and out of search;
// its page still opens, saying it is in the trash. Raw SQL for trashedAt, so updatedAt stays: a
// restored doc sorts where it was.
//
// DOC_PAGES_PLAN D8 (11-27): a doc goes to the trash with the pages inside it (each marked trashedWithId = that doc),
// and restoring it brings back the same set; a page already in the trash on its own stays there. A page restored alone
// while the doc above it is still in the trash comes back at the top level. The trash lists the docs trashed
// themselves, each with how many pages went with it.
import cron from 'node-cron';
import { prisma, type DbClient } from '../../db/prisma';
import { descendantsOf, lockTrees } from './docTree.service';
import ErrorResponse from '../../utils/errorResponse';
import { deleteOrLeaveDoc, findAccessibleDoc } from './docs.service';
import { isDocOwner } from './docPermissions';
import { pruneThreads } from '../assistant/threads.service';
import { pruneAgentHistory } from '../agent/prune.service';
import { pruneOAuth } from '../oauth/oauth.service';
import { purgeSubjectDeletions, UNDO_DAYS } from '../learningDb/subjectDeletion.service';

export const TRASH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrashStateJson {
    _id: string;
    title: string;
    trashedAt: Date | null;
}

async function ownedDoc(userId: string, docId: string) {
    const doc = await findAccessibleDoc(docId, userId);
    if (!doc) throw new ErrorResponse(404, 'Doc not found');
    if (!isDocOwner(doc, userId)) throw new ErrorResponse(403, 'Only the owner can move a doc to the trash or out of it (a shared doc can be left instead)');
    return doc;
}

async function stateOf(docId: string, db: DbClient = prisma): Promise<TrashStateJson> {
    const row = await db.doc.findUniqueOrThrow({ where: { id: docId }, select: { id: true, title: true, trashedAt: true } });
    return { _id: row.id, title: row.title, trashedAt: row.trashedAt };
}

/**
 * POST /api/docs/:id/trash (and the agent's trash_doc). A doc already in the trash stays as it is. The live pages
 * inside it go with it (`pages`: how many).
 */
export async function trashDoc(userId: string, docId: string, now: Date = new Date()): Promise<TrashStateJson & { changed: boolean; pages: number }> {
    await ownedDoc(userId, docId);
    return prisma.$transaction(async (tx) => {
        await lockTrees(tx, userId);
        const changed = await tx.$executeRaw`UPDATE "Doc" SET "trashedAt" = ${now}, "trashedWithId" = NULL WHERE "id" = ${docId} AND "trashedAt" IS NULL`;
        let pages = 0;
        if (changed > 0) {
            const inside = (await descendantsOf(docId, tx)).map((r) => r.id);
            if (inside.length) pages = await tx.$executeRaw`UPDATE "Doc" SET "trashedAt" = ${now}, "trashedWithId" = ${docId} WHERE "id" = ANY(${inside}::text[]) AND "trashedAt" IS NULL`;
        }
        return { ...(await stateOf(docId, tx)), changed: changed > 0, pages };
    });
}

/**
 * POST /api/docs/:id/restore (and the agent's restore_doc). A doc trashed itself brings back every page that went
 * with it; a page that went with another brings back the ones inside it that went with the same doc. `detached`: the
 * doc above it is still in the trash (or gone), so it is back at the top level.
 */
export async function restoreDoc(userId: string, docId: string): Promise<TrashStateJson & { changed: boolean; pages: number; detached: boolean }> {
    await ownedDoc(userId, docId);
    return prisma.$transaction(async (tx) => {
        await lockTrees(tx, userId);
        const row = await tx.doc.findUniqueOrThrow({ where: { id: docId }, select: { trashedAt: true, trashedWithId: true, parentId: true } });
        if (!row.trashedAt) return { ...(await stateOf(docId, tx)), changed: false, pages: 0, detached: false };
        const setRoot = row.trashedWithId ?? docId;
        const set = row.trashedWithId
            ? (await descendantsOf(docId, tx, { trashed: 'all' })).filter((r) => r.trashedWithId === setRoot).map((r) => r.id)
            : (await tx.doc.findMany({ where: { trashedWithId: docId }, select: { id: true } })).map((r) => r.id);
        await tx.$executeRaw`UPDATE "Doc" SET "trashedAt" = NULL, "trashedWithId" = NULL WHERE "id" = ${docId}`;
        const pages = set.length ? await tx.$executeRaw`UPDATE "Doc" SET "trashedAt" = NULL, "trashedWithId" = NULL WHERE "id" = ANY(${set}::text[])` : 0;
        let detached = false;
        if (row.parentId) {
            const parent = await tx.doc.findUnique({ where: { id: row.parentId }, select: { trashedAt: true } });
            if (!parent || parent.trashedAt) {
                await tx.$executeRaw`UPDATE "Doc" SET "parentId" = NULL, "position" = 0 WHERE "id" = ${docId}`;
                detached = true;
            }
        }
        return { ...(await stateOf(docId, tx)), changed: true, pages, detached };
    });
}

/**
 * The user's docs in the trash (owned), newest first, each with how many pages went with it; not the pages that went
 * with another doc, nor those a deleted subject holds for its week's undo.
 */
export async function trashedDocs(userId: string): Promise<Array<{ id: string; title: string; trashedAt: Date; pages: number }>> {
    const held = (await prisma.subjectDeletion.findMany({ where: { userId }, select: { docIds: true } })).flatMap((d) => d.docIds);
    const rows = await prisma.doc.findMany({ where: { userId, trashedAt: { not: null }, trashedWithId: null, id: { notIn: held } }, select: { id: true, title: true, trashedAt: true }, orderBy: { trashedAt: 'desc' } });
    const counts = rows.length
        ? await prisma.doc.groupBy({ by: ['trashedWithId'], where: { trashedWithId: { in: rows.map((r) => r.id) } }, _count: { _all: true } })
        : [];
    const pagesOf = new Map(counts.map((c) => [c.trashedWithId, c._count._all]));
    return rows.map((r) => ({ id: r.id, title: r.title, trashedAt: r.trashedAt!, pages: pagesOf.get(r.id) ?? 0 }));
}

/** POST /api/docs/trash/empty: every doc the user has in the trash, deleted for good (images too). */
export async function emptyTrash(userId: string): Promise<{ deleted: number }> {
    let deleted = 0;
    for (const doc of await trashedDocs(userId)) {
        if ((await deleteOrLeaveDoc(doc.id, userId)) === 'deleted') deleted += 1;
    }
    return { deleted };
}

/** Docs in the trash for longer than TRASH_DAYS, deleted for good (the hourly job). */
export async function purgeTrash(now: Date = new Date()): Promise<number> {
    // The docs trashed themselves first: each takes the pages that went with it (a set shares one trashedAt).
    const rows = await prisma.doc.findMany({
        where: { trashedAt: { lt: new Date(now.getTime() - TRASH_DAYS * DAY_MS) } },
        select: { id: true, userId: true },
        orderBy: [{ trashedWithId: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    });
    let deleted = 0;
    for (const row of rows) {
        try {
            if (!(await prisma.doc.findUnique({ where: { id: row.id }, select: { id: true } }))) continue; // went with its set
            if ((await deleteOrLeaveDoc(row.id, row.userId)) === 'deleted') deleted += 1;
        } catch (err) {
            console.error(`[trash] could not delete doc ${row.id}:`, err);
        }
    }
    return deleted;
}

/** The hourly cron's work (poll mode), and part of the quiet scheduler's sweep (hosting P1-11). */
export async function trashHousekeeping(): Promise<void> {
    const deleted = await purgeTrash();
    if (deleted > 0) console.log(`[trash] deleted ${deleted} doc(s) after ${TRASH_DAYS} days in the trash`);
    // Deleted subjects past their week's undo: final, their docs deleted for good.
    const subjects = await purgeSubjectDeletions();
    if (subjects > 0) console.log(`[subjects] ${subjects} deleted subject(s) made final after ${UNDO_DAYS} days`);
    // The manager's conversations go after 90 days without a message (the same hourly job).
    const threads = await pruneThreads();
    if (threads > 0) console.log(`[assistant] deleted ${threads} old conversation(s)`);
    // Old agent edit logs and the snapshots only they needed (D5).
    const pruned = await pruneAgentHistory();
    if (pruned.edits + pruned.snapshots > 0) console.log(`[agent] pruned ${pruned.edits} old edit(s), ${pruned.snapshots} snapshot(s)`);
    // Sign-in codes and refresh tokens that can't be used any more.
    await pruneOAuth();
}

export function startTrashCron() {
    const task = cron.schedule('23 * * * *', async () => {
        try {
            await trashHousekeeping();
        } catch (err) {
            console.error('[trash] purge failed:', err);
        }
    });
    return task;
}
