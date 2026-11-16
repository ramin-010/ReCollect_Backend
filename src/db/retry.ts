// Connection errors, and one retry for background work (hosting P1-12).
//
// A database on another machine that sleeps when idle (Neon) or restarts drops the pool's
// connections; the next query on a dropped one fails although the database answers a moment later.
// A background job runs its pass through retryOnConnectionError: one more try after a short wait,
// then the error goes back to the job, whose own backoff takes over (the scheduler, P1-11). Every
// job's pass is safe to run twice (each keeps the claim it already uses), so the retry is too.
//
// Prisma 7 with @prisma/adapter-pg reports a lost database in several shapes: Prisma's own codes
// (P1001 "can't reach", P1017 "closed", ...), the adapter's error with a `kind`, pg's plain errors
// ("Connection terminated unexpectedly"), Node's socket codes and Postgres's SQLSTATEs (class 08,
// 57P01-57P03 while the server shuts down or starts). isConnectionError knows them all, nested too.

/** Node's socket errors for a peer that is not there or went away. */
const SOCKET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']);
/** Prisma: can't reach (P1001), timed out reaching (P1002), operation timed out (P1008), closed (P1017), too many connections (P2037). */
const PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2037']);
/** The adapter's kinds for the same cases. */
const ADAPTER_KINDS = new Set(['DatabaseNotReachable', 'ConnectionClosed', 'SocketTimeout', 'TooManyConnections']);
/** Postgres SQLSTATE: connection exceptions (class 08), admin or crash shutdown, starting up. */
const SQLSTATE = /^(?:08[0-9A-Z]{3}|57P0[123])$/;
/** pg's own messages (no code) and Prisma's wording when it wraps them. */
const MESSAGES = /connection terminated|connection error|server has closed the connection|can't reach database server|timeout exceeded when trying to connect|terminating connection due to administrator command|the database system is (?:starting up|shutting down)/i;

/** True when `err` (or an error inside it) says the database could not be reached or dropped the connection. */
export function isConnectionError(err: unknown, depth = 0): boolean {
    if (!err || typeof err !== 'object' || depth > 5) return false;
    const e = err as { code?: unknown; originalCode?: unknown; kind?: unknown; message?: unknown; cause?: unknown; meta?: { driverAdapterError?: unknown } };
    if (typeof e.code === 'string' && (SOCKET_CODES.has(e.code) || PRISMA_CODES.has(e.code) || SQLSTATE.test(e.code))) return true;
    if (typeof e.originalCode === 'string' && SQLSTATE.test(e.originalCode)) return true;
    if (typeof e.kind === 'string' && ADAPTER_KINDS.has(e.kind)) return true;
    if (typeof e.message === 'string' && MESSAGES.test(e.message)) return true;
    return isConnectionError(e.cause, depth + 1) || isConnectionError(e.meta?.driverAdapterError, depth + 1);
}

/** The wait before the one retry: a sleeping database wakes in a few hundred milliseconds. */
export const RETRY_WAIT_MS = 1_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
    waitMs?: number;
    /** Tests pass their own clock. */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs `work`; after a connection error, waits a moment and runs it once more. Any other error, or
 * a second connection error, is thrown to the caller (a job's backoff takes it from there).
 */
export async function retryOnConnectionError<T>(work: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    try {
        return await work();
    } catch (err) {
        if (!isConnectionError(err)) throw err;
        await (options.sleep ?? wait)(options.waitMs ?? RETRY_WAIT_MS);
        return work();
    }
}
