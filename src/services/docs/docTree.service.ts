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
