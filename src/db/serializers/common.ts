// Shape helpers: Prisma rows → the JSON the frontend already expects from the Mongo API.
//
// Deliberately SHALLOW. Never transform ids recursively: Json columns (TipTap documents, subtasks,
// references, notification metadata…) can legitimately contain `id` keys that must stay untouched.

/** Rename a row's `id` to `_id` (top level only). */
export function withMongoId<T extends { id: string }>(row: T): Omit<T, 'id'> & { _id: string } {
    const { id, ...rest } = row;
    return { _id: id, ...rest };
}

/** withMongoId for a list. */
export function withMongoIds<T extends { id: string }>(rows: readonly T[]): Array<Omit<T, 'id'> & { _id: string }> {
    return rows.map((row) => withMongoId(row));
}
