// DOC_PAGES_PLAN §3.1 (11-27): docs inside docs ("pages"), to any depth. Everything that walks the tree lives here:
// raw recursive SQL over Doc.parentId, guarded at 64 levels. A page is reachable from its parent always (the tree is
// the truth, not the text: D2, D3).
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import type { DbClient } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { accessibleDocWhere } from './docPermissions';

export const MAX_DEPTH = 64;
/** Gaps between siblings' positions; a new page goes 1024 after the last. */
export const POSITION_STEP = 1024;

export interface TreeRow {
    id: string;
    parentId: string | null;
    title: string;
    userId: string;
    trashedAt: Date | null;
    depth: number;
}

/** The ancestors of a doc, root first (no access filter). */
export async function ancestorsOf(docId: string, db: DbClient = prisma): Promise<TreeRow[]> {
    const rows = await db.$queryRaw<TreeRow[]>(Prisma.sql`
        WITH RECURSIVE up AS (
            SELECT d."id", d."parentId", d."title", d."userId", d."trashedAt", 0 AS depth FROM "Doc" d WHERE d."id" = ${docId}
            UNION ALL
            SELECT p."id", p."parentId", p."title", p."userId", p."trashedAt", up.depth + 1
            FROM "Doc" p JOIN up ON p."id" = up."parentId" WHERE up.depth < ${MAX_DEPTH}
        ) SELECT * FROM up WHERE depth > 0 ORDER BY depth DESC`);
    return rows.map((r) => ({ ...r, depth: Number(r.depth) }));
}

/** The docs among these ids the user can open (owner or collaborator), not in the trash. */
async function openable(userId: string, ids: string[], db: DbClient): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await db.doc.findMany({ where: { id: { in: ids }, trashedAt: null, ...accessibleDocWhere(userId) }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
}

/** The trail above a doc: the unbroken run of ancestors the user can open, nearest the doc last (root first). */
export async function trailFor(docId: string, userId: string, db: DbClient = prisma): Promise<Array<{ id: string; title: string }>> {
    const up = await ancestorsOf(docId, db);
    if (!up.length) return [];
    const can = await openable(userId, up.map((r) => r.id), db);
    const trail: Array<{ id: string; title: string }> = [];
    // From the doc upward: stop at the first ancestor they can't open.
    for (let i = up.length - 1; i >= 0; i--) {
        const r = up[i]!;
        if (!can.has(r.id)) break;
        trail.unshift({ id: r.id, title: r.title });
    }
    return trail;
}

/** The pages directly inside a doc the user can open, in order, each with how many pages of its own. */
export async function pagesOf(docId: string, userId: string, db: DbClient = prisma): Promise<Array<{ id: string; title: string; position: number; pages: number }>> {
    const rows = await db.doc.findMany({
        where: { parentId: docId, trashedAt: null, ...accessibleDocWhere(userId) },
        select: { id: true, title: true, position: true, _count: { select: { pages: { where: { trashedAt: null } } } } },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({ id: r.id, title: r.title, position: r.position, pages: r._count.pages }));
}

/** A new page's position: after its parent's last page. */
export async function nextPosition(parentId: string, db: DbClient = prisma): Promise<number> {
    const last = await db.doc.aggregate({ where: { parentId }, _max: { position: true } });
    return (last._max.position ?? 0) + POSITION_STEP;
}

/** The parent a new page may go inside: the user's own, not in the trash (D7). */
export async function assertParentForNewPage(userId: string, parentId: string, db: DbClient = prisma): Promise<{ id: string; title: string }> {
    const parent = await db.doc.findUnique({ where: { id: parentId }, select: { id: true, title: true, userId: true, trashedAt: true } });
    if (!parent) throw new ErrorResponse(404, 'The doc to put this page inside was not found');
    if (parent.userId !== userId) throw new ErrorResponse(403, 'Only the owner of a doc can add pages inside it');
    if (parent.trashedAt) throw new ErrorResponse(409, 'That doc is in the trash: restore it first, or put the page elsewhere');
    const depth = (await ancestorsOf(parentId, db)).length + 1;
    if (depth >= MAX_DEPTH) throw new ErrorResponse(409, 'That doc is nested too deep to hold another page');
    return { id: parent.id, title: parent.title };
}

/** Nodes in tree order: depth-first, siblings by position then id (pure). */
export function orderTree<T extends { id: string; parentId: string | null; position: number }>(nodes: readonly T[], rootId: string | null = null): T[] {
    const kids = new Map<string | null, T[]>();
    for (const n of nodes) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
    for (const list of kids.values()) list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const out: T[] = [];
    const seen = new Set<string>();
    const walk = (parent: string | null, depth: number) => {
        if (depth > MAX_DEPTH) return;
        for (const n of kids.get(parent) ?? []) {
            if (seen.has(n.id)) continue;
            seen.add(n.id);
            out.push(n);
            walk(n.id, depth + 1);
        }
    };
    walk(rootId, 0);
    return out;
}

// ─── Stage 2: the tree's rules (§3.1) ─────────────────────────────────

export interface DescendantRow {
    id: string;
    parentId: string | null;
    title: string;
    position: number;
    userId: string;
    trashedAt: Date | null;
    trashedWithId: string | null;
    /** 1 = a page directly inside the doc. */
    depth: number;
}

/** Everything inside a doc, in tree order (depth-first, siblings by position). 'live' (the default) leaves out the
 *  trash, and so whatever sits inside a page in the trash. */
export async function descendantsOf(docId: string, db: DbClient = prisma, opts: { trashed?: 'live' | 'all' } = {}): Promise<DescendantRow[]> {
    const rows = await db.$queryRaw<DescendantRow[]>(Prisma.sql`
        WITH RECURSIVE down AS (
            SELECT d."id", d."parentId", d."title", d."position", d."userId", d."trashedAt", d."trashedWithId", 0 AS depth FROM "Doc" d WHERE d."id" = ${docId}
            UNION ALL
            SELECT c."id", c."parentId", c."title", c."position", c."userId", c."trashedAt", c."trashedWithId", down.depth + 1
            FROM "Doc" c JOIN down ON c."parentId" = down."id" WHERE down.depth < ${MAX_DEPTH}
        ) SELECT * FROM down WHERE depth > 0`);
    const all = rows.map((r) => ({ ...r, position: Number(r.position), depth: Number(r.depth) }));
    return orderTree(opts.trashed === 'all' ? all : all.filter((r) => !r.trashedAt), docId);
}

export interface TreeNode {
    id: string;
    parentId: string | null;
    title: string;
    position: number;
    /** 0 = the root. */
    depth: number;
}

/**
 * GET /api/docs/:id/tree: the tree a doc is in, as this user sees it. The root is the top-most doc above it they can
 * open (or the doc itself); the nodes are the root, then every live page inside it reached through pages they can
 * open, depth-first. The root's parentId is null in the answer (what is above it is not theirs to see).
 */
export async function treeOf(docId: string, userId: string, db: DbClient = prisma): Promise<{ rootId: string; nodes: TreeNode[] }> {
    const doc = await db.doc.findFirst({ where: { id: docId, ...accessibleDocWhere(userId) }, select: { id: true } });
    if (!doc) throw new ErrorResponse(404, 'Doc not found');
    const trail = await trailFor(docId, userId, db);
    const rootId = trail[0]?.id ?? docId;
    const root = await db.doc.findUniqueOrThrow({ where: { id: rootId }, select: { id: true, title: true, position: true } });
    const reached = await pagesInside(rootId, userId, db);
    return {
        rootId,
        nodes: [
            { id: root.id, parentId: null, title: root.title, position: root.position, depth: 0 },
            ...reached.map((r) => ({ id: r.id, parentId: r.parentId, title: r.title, position: r.position, depth: r.depth })),
        ],
    };
}

/** The live pages inside a doc that this user reaches through pages they can open, in tree order. */
export async function pagesInside(docId: string, userId: string, db: DbClient = prisma): Promise<DescendantRow[]> {
    const inside = await descendantsOf(docId, db);
    const can = await openable(userId, inside.map((r) => r.id), db);
    return orderTree(inside.filter((r) => can.has(r.id)), docId);
}

/** Puts a doc back where it was (a failed request's move, taken back; updatedAt stays). */
export async function placeAt(docId: string, place: { parentId: string | null; position: number }, db: DbClient = prisma): Promise<void> {
    await db.$executeRaw`UPDATE "Doc" SET "parentId" = ${place.parentId}, "position" = ${place.position} WHERE "id" = ${docId}`;
}

/** For search hits: the titles above each doc that the user can open, root first (the unbroken run nearest the doc). */
export async function pathsFor(docIds: readonly string[], userId: string, db: DbClient = prisma): Promise<Map<string, Array<{ id: string; title: string }>>> {
    const out = new Map<string, Array<{ id: string; title: string }>>();
    if (!docIds.length) return out;
    const rows = await db.$queryRaw<Array<{ start: string; id: string; depth: number; title: string }>>(Prisma.sql`
        WITH RECURSIVE up AS (
            SELECT d."id" AS start, d."parentId" AS id, 1 AS depth FROM "Doc" d WHERE d."id" = ANY(${[...docIds]}::text[]) AND d."parentId" IS NOT NULL
            UNION ALL
            SELECT up.start, p."parentId", up.depth + 1 FROM up JOIN "Doc" p ON p."id" = up.id WHERE p."parentId" IS NOT NULL AND up.depth < ${MAX_DEPTH}
        ) SELECT up.start, up.id, up.depth, d."title" FROM up JOIN "Doc" d ON d."id" = up.id`);
    const can = await openable(userId, [...new Set(rows.map((r) => r.id))], db);
    const byStart = new Map<string, Array<{ id: string; title: string; depth: number }>>();
    for (const r of rows) byStart.set(r.start, [...(byStart.get(r.start) ?? []), { id: r.id, title: r.title, depth: Number(r.depth) }]);
    for (const [start, list] of byStart) {
        list.sort((a, b) => a.depth - b.depth); // nearest first
        const path: Array<{ id: string; title: string }> = [];
        for (const a of list) {
            if (!can.has(a.id)) break;
            path.unshift({ id: a.id, title: a.title });
        }
        out.set(start, path);
    }
    return out;
}

export interface LessonRef {
    topicId: string;
    /** The lesson's doc: the doc itself, or the doc above it that is the lesson. */
    docId: string;
    title: string;
    subjectId: string;
    subjectName: string;
}

/** D5: the lesson a doc is revised with: the nearest doc at or above it that is a topic of this user, or null. */
export async function lessonOf(docId: string, userId: string, db: DbClient = prisma): Promise<LessonRef | null> {
    const up = await ancestorsOf(docId, db);
    const chain = [docId, ...up.map((r) => r.id).reverse()]; // nearest first
    const topics = await db.topic.findMany({ where: { userId, docId: { in: chain } }, select: { id: true, docId: true, title: true, subjectId: true } });
    const nearest = chain.map((id) => topics.find((t) => t.docId === id)).find((t) => !!t);
    if (!nearest || !nearest.docId) return null;
    const subject = await db.subject.findUnique({ where: { id: nearest.subjectId }, select: { name: true } });
    const docTitle = nearest.docId === docId ? (await db.doc.findUnique({ where: { id: docId }, select: { title: true } }))?.title : up.find((r) => r.id === nearest.docId)?.title;
    return { topicId: nearest.id, docId: nearest.docId, title: docTitle?.trim() || nearest.title, subjectId: nearest.subjectId, subjectName: subject?.name ?? '' };
}

/** D5: the docs inside this one that are lessons of this user; the trash too (a page restored comes back where it was). */
export async function lessonsBelow(docId: string, userId: string, db: DbClient = prisma): Promise<Array<{ docId: string; title: string; trashed: boolean }>> {
    const inside = await descendantsOf(docId, db, { trashed: 'all' });
    if (!inside.length) return [];
    const topics = await db.topic.findMany({ where: { userId, docId: { in: inside.map((r) => r.id) } }, select: { docId: true } });
    const ids = new Set(topics.map((t) => t.docId));
    return inside.filter((r) => ids.has(r.id)).map((r) => ({ docId: r.id, title: r.title.trim() || 'Untitled', trashed: !!r.trashedAt }));
}

const titleList = (rows: ReadonlyArray<{ title: string; trashed: boolean }>): string =>
    rows.slice(0, 3).map((r) => `"${r.title}"${r.trashed ? ' (in the trash)' : ''}`).join(', ') + (rows.length > 3 ? ` and ${rows.length - 3} more` : '');

/** D5, before a doc is filed under a subject: 409 when a page above it, or one inside it, is a lesson already. */
export async function assertCanBeLesson(docId: string, userId: string, db: DbClient = prisma): Promise<void> {
    const above = await lessonOf(docId, userId, db);
    if (above && above.docId !== docId) {
        throw new ErrorResponse(409, `This page is inside the lesson "${above.title}" and is revised with it. Only a page outside a lesson can be filed under a subject.`);
    }
    const below = await lessonsBelow(docId, userId, db);
    if (below.length) throw new ErrorResponse(409, `Pages inside this doc are lessons already (${titleList(below)}): a doc that holds lessons can't be one itself.`);
}

/** Below this gap between two neighbours, the parent's pages are renumbered 1024 apart. */
const MIN_GAP = 0.001;

/** Every page of a parent 1024 apart, in the given order, in one UPDATE (updatedAt stays). */
async function renumber(parentId: string, orderedIds: readonly string[], db: DbClient): Promise<void> {
    if (!orderedIds.length) return;
    await db.$executeRaw`
        UPDATE "Doc" AS d SET "position" = t.ord * ${POSITION_STEP}
        FROM unnest(${[...orderedIds]}::text[]) WITH ORDINALITY AS t(id, ord)
        WHERE d."id" = t.id AND d."parentId" = ${parentId}`;
}

/**
 * A place among a parent's pages: first ('start') or right after one of them (its midpoint with the next one).
 * `moving` (the doc being placed) is left out of the siblings. 400 when `after` is not one of the parent's pages.
 */
export async function positionAfter(parentId: string, after: string, db: DbClient = prisma, moving?: string): Promise<number> {
    const load = () =>
        db.doc.findMany({ where: { parentId, ...(moving ? { id: { not: moving } } : {}) }, select: { id: true, position: true }, orderBy: [{ position: 'asc' }, { id: 'asc' }] });
    let sibs = await load();
    if (after === 'start') return sibs.length ? sibs[0]!.position - POSITION_STEP : POSITION_STEP;
    let i = sibs.findIndex((s) => s.id === after);
    if (i < 0) throw new ErrorResponse(400, '`after` must be one of the pages inside the doc it goes into (or "start")');
    if (i === sibs.length - 1) return sibs[i]!.position + POSITION_STEP;
    if (sibs[i + 1]!.position - sibs[i]!.position < MIN_GAP) {
        await renumber(parentId, sibs.map((s) => s.id), db);
        sibs = await load();
        i = sibs.findIndex((s) => s.id === after);
    }
    return (sibs[i]!.position + sibs[i + 1]!.position) / 2;
}

/** One owner's tree changes one at a time (D7: a tree has one owner), so two moves at once can't make a loop. */
export async function lockTrees(db: DbClient, userId: string): Promise<void> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`doc-tree:${userId}`}))`;
}

export interface MoveTarget {
    /** The doc it goes inside; null = the top level. */
    parentId: string | null;
    /** A page of that parent to go after, or 'start'; left out = after its last page. */
    after?: string | undefined;
}

export interface MoveResult {
    title: string;
    before: { parentId: string | null; position: number };
    after: { parentId: string | null; position: number };
    /** The title of the doc it went inside (null = the top level). */
    parentTitle: string | null;
    /** Notes written on it or its pages whose lesson is no longer above them: their page is forgotten (D4). */
    notesCleared: number;
}

/**
 * PATCH /api/docs/:id { parentId, after } and the agent's move_doc. Checks, in order, each with its own message:
 * the doc is the user's own and not in the trash; the target is theirs and not in the trash; not inside itself;
 * the lesson rule (D5); at most 64 levels; `after` is one of the target's pages. Then one UPDATE (updatedAt stays).
 */
export async function moveDoc(userId: string, docId: string, to: MoveTarget): Promise<MoveResult> {
    return prisma.$transaction(async (tx) => {
        await lockTrees(tx, userId);
        const doc = await tx.doc.findFirst({ where: { id: docId, ...accessibleDocWhere(userId) }, select: { id: true, title: true, userId: true, parentId: true, position: true, trashedAt: true } });
        if (!doc) throw new ErrorResponse(404, 'Doc not found');
        if (doc.userId !== userId) throw new ErrorResponse(403, 'Only the owner can move a doc');
        if (doc.trashedAt) throw new ErrorResponse(409, 'This doc is in the trash: restore it first');
        let target: { id: string; title: string } | null = null;
        if (to.parentId) {
            const t = await tx.doc.findFirst({ where: { id: to.parentId, ...accessibleDocWhere(userId) }, select: { id: true, title: true, userId: true, trashedAt: true } });
            if (!t) throw new ErrorResponse(404, 'The doc to move it into was not found');
            if (t.userId !== userId) throw new ErrorResponse(403, 'A doc can only go inside a doc of your own');
            if (t.trashedAt) throw new ErrorResponse(409, 'That doc is in the trash: restore it first, or move this one elsewhere');
            target = { id: t.id, title: t.title };
        }
        const inside = await descendantsOf(docId, tx, { trashed: 'all' });
        if (target && (target.id === docId || inside.some((r) => r.id === target!.id))) {
            throw new ErrorResponse(409, "A doc can't go inside itself or inside one of its own pages");
        }
        if (target) {
            const targetLesson = await lessonOf(target.id, userId, tx);
            if (targetLesson) {
                const own = await tx.topic.findUnique({ where: { userId_docId: { userId, docId } }, select: { id: true } });
                const below = own ? [] : await lessonsBelow(docId, userId, tx);
                if (own || below.length) {
                    const name = own ? doc.title.trim() || 'Untitled' : below[0]!.title;
                    throw new ErrorResponse(409, `"${name}" is a lesson with its own reviews: it can't sit inside the lesson "${targetLesson.title}". Move it elsewhere, or take it off its subject first.`);
                }
            }
            const targetLevel = (await ancestorsOf(target.id, tx)).length + 1;
            const height = inside.reduce((m, r) => Math.max(m, r.depth), 0);
            if (targetLevel + 1 + height > MAX_DEPTH) throw new ErrorResponse(409, 'That would nest its pages too deep');
        }
        if (to.after !== undefined && !target) throw new ErrorResponse(400, '`after` places a page among the pages of the doc it goes into: give parentId too');
        const position = target ? (to.after !== undefined ? await positionAfter(target.id, to.after, tx, docId) : await nextPosition(target.id, tx)) : 0;
        await tx.$executeRaw`UPDATE "Doc" SET "parentId" = ${target?.id ?? null}, "position" = ${position} WHERE "id" = ${docId}`;
        const notesCleared = await forgetStrayNotePages(docId, inside, target?.id ?? null, tx);
        return {
            title: doc.title,
            before: { parentId: doc.parentId, position: doc.position },
            after: { parentId: target?.id ?? null, position },
            parentTitle: target?.title ?? null,
            notesCleared,
        };
    });
}

/**
 * D4 after a move: a note written on the moved doc or a page inside it keeps its lesson (topicId); where that lesson's
 * doc is no longer at or above the page, the note forgets the page (docId null). updatedAt stays.
 */
async function forgetStrayNotePages(docId: string, inside: readonly DescendantRow[], newParentId: string | null, db: DbClient): Promise<number> {
    const ids = [docId, ...inside.map((r) => r.id)];
    const notes = await db.capture.findMany({ where: { docId: { in: ids } }, select: { id: true, docId: true, topicId: true } });
    if (!notes.length) return 0;
    const topicIds = [...new Set(notes.map((n) => n.topicId).filter((t): t is string => !!t))];
    const topics = topicIds.length ? await db.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true, docId: true } }) : [];
    const lessonDoc = new Map(topics.map((t) => [t.id, t.docId]));
    const above = new Set(newParentId ? [newParentId, ...(await ancestorsOf(newParentId, db)).map((r) => r.id)] : []);
    const parent = new Map(inside.map((r) => [r.id, r.parentId]));
    const stray: string[] = [];
    for (const n of notes) {
        const lesson = n.topicId ? lessonDoc.get(n.topicId) : null;
        let kept = false;
        let at: string | null | undefined = n.docId;
        for (let guard = 0; at && guard <= MAX_DEPTH; guard++) {
            if (at === lesson) {
                kept = true;
                break;
            }
            at = at === docId ? null : parent.get(at);
        }
        if (!kept && lesson && above.has(lesson)) kept = true;
        if (!kept) stray.push(n.id);
    }
    if (stray.length) await db.$executeRaw`UPDATE "Capture" SET "docId" = NULL WHERE "id" = ANY(${stray}::text[])`;
    return stray.length;
}
