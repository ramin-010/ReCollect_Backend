// Small query helpers shared by all services.

/**
 * Escape LIKE/ILIKE wildcards so user input is matched literally.
 * Prisma's `contains` / `startsWith` / `endsWith` do NOT escape `%` and `_` (checked on Prisma 7.8:
 * `contains: 'a_b'` also matched 'axb'). Postgres' default LIKE escape character is the backslash.
 */
export function escapeLike(input: string): string {
    return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Case-insensitive "contains" filter (ILIKE '%input%') with the input escaped. Replaces `new RegExp(q, 'i')`. */
export function containsInsensitive(input: string): { contains: string; mode: 'insensitive' } {
    return { contains: escapeLike(input), mode: 'insensitive' };
}

/** Case-insensitive prefix filter (ILIKE 'input%') with the input escaped. Replaces `new RegExp('^' + q, 'i')`. */
export function startsWithInsensitive(input: string): { startsWith: string; mode: 'insensitive' } {
    return { startsWith: escapeLike(input), mode: 'insensitive' };
}
