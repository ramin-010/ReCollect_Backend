// Small readers for request body fields that may arrive as JSON values or as multipart strings
// (doc saves send FormData when they carry images). Mongoose used to cast these
// silently; Prisma rejects wrong types, so values are checked before they reach a query.
import ErrorResponse from './errorResponse';

/** JSON.parse a multipart string; objects pass through; anything else (or bad JSON) gives `fallback`. */
export function parseJsonField<T>(data: unknown, fallback: T): T {
    try {
        if (typeof data === 'object' && data !== null) return data as T;
        if (typeof data === 'string') return JSON.parse(data) as T;
        return fallback;
    } catch {
        return fallback;
    }
}

/** A list of ids sent as a JSON array or a JSON string; non-string entries are dropped. */
export function readStringList(data: unknown): string[] {
    const parsed = parseJsonField<unknown>(data, []);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}

function castError(value: unknown, path: string, kind: string): ErrorResponse {
    let shown: string;
    try {
        shown = JSON.stringify(value) ?? String(value);
    } catch {
        shown = String(value);
    }
    return new ErrorResponse(400, `Cast to ${kind} failed for value "${shown}" at path "${path}"`);
}

/** undefined stays undefined, null stays null, strings pass, numbers/booleans become strings (Mongoose cast). */
export function readOptionalString(value: unknown, path: string): string | null | undefined {
    if (value === undefined || value === null || typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    throw castError(value, path, 'string');
}

const TRUE_VALUES: readonly unknown[] = [true, 'true', 1, '1', 'yes'];
const FALSE_VALUES: readonly unknown[] = [false, 'false', 0, '0', 'no'];

/** Mongoose's Boolean cast ('true'/'false', 1/0, 'yes'/'no'); undefined stays undefined. */
export function readOptionalBoolean(value: unknown, path: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (TRUE_VALUES.includes(value)) return true;
    if (FALSE_VALUES.includes(value)) return false;
    throw castError(value, path, 'Boolean');
}
