// Prisma error helpers. The Express error handler uses mapPrismaError() so ported modules answer
// with the same status codes and messages the Mongo version produced:
//   Mongo duplicate key (11000)      → Prisma P2002 → 400 "Duplicate field value entered: <fields>"
//   Mongo CastError (bad/unknown id) → Prisma P2025 → 404 "Resource not found"
//                                      Prisma P2003 → 404 "Related resource not found" (FK to a missing row)
//   Mongoose ValidationError         → PrismaClientValidationError / P2000 → 400
import { Prisma } from '@prisma/client';

export interface MappedError {
    statusCode: number;
    message: string;
}

function asStringArray(value: unknown): string[] | null {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string' && value) return [value];
    return null;
}

/** Fields of a unique-constraint violation (P2002), e.g. ['email'] or ['userId', 'docId']. */
export function uniqueViolationFields(err: unknown): string[] {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return [];
    const meta = (err.meta ?? {}) as Record<string, any>;
    const fromTarget = asStringArray(meta.target);
    if (fromTarget) return fromTarget;
    // With driver adapters (our setup) Prisma 7 reports the fields here instead of meta.target.
    const fromAdapter = asStringArray(meta.driverAdapterError?.cause?.constraint?.fields);
    if (fromAdapter) return fromAdapter;
    const match = /fields: \(([^)]*)\)/.exec(err.message);
    return match?.[1] ? match[1].split(',').map((f) => f.replace(/[`\s]/g, '')).filter(Boolean) : [];
}

/** True for a unique-constraint violation, optionally on a specific field. */
export function isUniqueViolation(err: unknown, field?: string): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
    return field ? uniqueViolationFields(err).includes(field) : true;
}

/** True when update/delete/findUniqueOrThrow did not find its row (P2025). */
export function isRecordNotFound(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

function lastLine(message: string): string {
    const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] ?? 'Invalid input';
}

/**
 * Map a Prisma error to the HTTP status + message the old Mongo error handler would have sent.
 * Returns null for anything that is not a Prisma error. Never returns Prisma's raw message for
 * unknown errors (it can contain source code frames).
 */
export function mapPrismaError(err: unknown): MappedError | null {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        switch (err.code) {
            case 'P2002':
                return { statusCode: 400, message: `Duplicate field value entered: ${uniqueViolationFields(err).join(',')}` };
            case 'P2025':
                return { statusCode: 404, message: 'Resource not found' };
            case 'P2003':
                return { statusCode: 404, message: 'Related resource not found' };
            case 'P2000': {
                const detail = (err.meta as any)?.driverAdapterError?.cause?.originalMessage;
                return { statusCode: 400, message: detail ? `Value too long: ${detail}` : 'Value too long for a field' };
            }
            default:
                return { statusCode: 500, message: `Database error (${err.code})` };
        }
    }
    if (err instanceof Prisma.PrismaClientValidationError) {
        // Same family as a Mongoose ValidationError/CastError: bad input reached the query.
        return { statusCode: 400, message: lastLine(err.message) };
    }
    if (
        err instanceof Prisma.PrismaClientUnknownRequestError ||
        err instanceof Prisma.PrismaClientInitializationError ||
        err instanceof Prisma.PrismaClientRustPanicError
    ) {
        return { statusCode: 500, message: 'Database error' };
    }
    return null;
}
