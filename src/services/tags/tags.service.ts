// Tags: global task labels (no owner, unique name), as the Mongo 'Tags' collection.
//
// Mongoose did implicitly: `trim` on name, `unique` on name (duplicate inserts failed with 11000).
// Here: names are trimmed in code, and new names are inserted with createMany({ skipDuplicates })
// (INSERT … ON CONFLICT DO NOTHING), which also never aborts a surrounding transaction.
import type { Tag } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { startsWithInsensitive } from '../../db/filters';

export const TAG_SEARCH_LIMIT = 5;

export interface TagJson {
    _id: string;
    name: string;
}

/** `{ _id, name }`: what `.select('name')` and populate('tags', 'name') returned. */
export function serializeTag(tag: Pick<Tag, 'id' | 'name'>): TagJson {
    return { _id: tag.id, name: tag.name };
}

/**
 * GET /tagQuery/search: tags whose name starts with `query` (case-insensitive, wildcards escaped),
 * at most 5. Mongo returned natural (insertion) order; createdAt + id is the closest equivalent.
 */
export function searchTagsByPrefix(query: string, db: DbClient = prisma, limit = TAG_SEARCH_LIMIT) {
    return db.tag.findMany({
        where: { name: startsWithInsensitive(query) },
        select: { id: true, name: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
    });
}

/** Trim, drop empty and non-string values, de-duplicate (first occurrence wins). */
export function normalizeTagNames(names: readonly unknown[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
        if (typeof raw !== 'string' && typeof raw !== 'number') continue;
        const name = String(raw).trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}

/**
 * Tag ids for these names, creating the tags that do not exist yet (the old
 * `find({ name: { $in } })` + `insertMany(new names)`). Returns the ids in the order of `names`.
 * Safe inside a transaction and under concurrent creation of the same name.
 */
export async function resolveTagIds(names: readonly unknown[], db: DbClient = prisma): Promise<string[]> {
    const normalized = normalizeTagNames(names);
    if (normalized.length === 0) return [];

    await db.tag.createMany({ data: normalized.map((name) => ({ name })), skipDuplicates: true });
    const rows = await db.tag.findMany({ where: { name: { in: normalized } }, select: { id: true, name: true } });

    const idByName = new Map(rows.map((row) => [row.name, row.id]));
    return normalized.map((name) => idByName.get(name)).filter((id): id is string => typeof id === 'string');
}
