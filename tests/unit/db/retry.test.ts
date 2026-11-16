// Connection errors and the one retry for background work (hosting P1-12). The error objects are
// built by hand in the shapes Prisma 7 + @prisma/adapter-pg + pg produce; the real shapes are also
// checked against a cut connection in tests/integration/db-reconnect.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { isConnectionError, retryOnConnectionError, RETRY_WAIT_MS } from '../../../src/db/retry';

const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError(`Prisma ${code}`, { code, clientVersion: '7.8.0', ...(meta ? { meta } : {}) });
const socket = (code: string) => Object.assign(new Error(`connect ${code} 127.0.0.1:5432`), { code, syscall: 'connect', errno: -4078 });
const postgres = (code: string, message: string) => Object.assign(new Error(message), { code, severity: 'FATAL' });

describe('isConnectionError', () => {
    it("Prisma's codes for a database it can't reach, that timed out, closed, or has no free connection", () => {
        for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2037']) expect(isConnectionError(known(code))).toBe(true);
    });

    it("the adapter's error inside Prisma's (meta.driverAdapterError) and its kinds", () => {
        expect(isConnectionError(known('P2036', { driverAdapterError: { name: 'DriverAdapterError', cause: { kind: 'ConnectionClosed' } } }))).toBe(true);
        expect(isConnectionError({ name: 'DriverAdapterError', cause: { kind: 'DatabaseNotReachable', host: 'h', port: 5432 } })).toBe(true);
        expect(isConnectionError({ name: 'DriverAdapterError', cause: { kind: 'postgres', code: '57P01', originalCode: '57P01' } })).toBe(true);
    });

    it("Node's socket errors and pg's own messages", () => {
        for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']) expect(isConnectionError(socket(code))).toBe(true);
        expect(isConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
        expect(isConnectionError(new Error('timeout exceeded when trying to connect'))).toBe(true);
        expect(isConnectionError(new Error('Client has encountered a connection error and is not queryable'))).toBe(true);
    });

    it("Postgres saying it is shutting down or starting (Neon suspending a compute), and class 08", () => {
        expect(isConnectionError(postgres('57P01', 'terminating connection due to administrator command'))).toBe(true);
        expect(isConnectionError(postgres('57P03', 'the database system is starting up'))).toBe(true);
        expect(isConnectionError(postgres('08006', 'connection failure'))).toBe(true);
    });

    it('finds one nested as a cause', () => {
        expect(isConnectionError(Object.assign(new Error('job failed'), { cause: socket('ECONNRESET') }))).toBe(true);
    });

    it("a query's own errors are not connection errors", () => {
        expect(isConnectionError(known('P2002'))).toBe(false);
        expect(isConnectionError(known('P2025'))).toBe(false);
        expect(isConnectionError(postgres('23505', 'duplicate key value violates unique constraint'))).toBe(false);
        expect(isConnectionError(new Error('boom'))).toBe(false);
        for (const nothing of [null, undefined, 'ECONNRESET', 42]) expect(isConnectionError(nothing)).toBe(false);
    });
});

describe('retryOnConnectionError', () => {
    const sleep = () => vi.fn(async (_ms: number) => {});

    it('a first success: no wait, no second run', async () => {
        const s = sleep();
        const work = vi.fn(async () => 'done');
        await expect(retryOnConnectionError(work, { sleep: s })).resolves.toBe('done');
        expect(work).toHaveBeenCalledTimes(1);
        expect(s).not.toHaveBeenCalled();
    });

    it('after a connection error: waits a second, runs once more and returns that', async () => {
        const s = sleep();
        const work = vi.fn().mockRejectedValueOnce(known('P1017')).mockResolvedValueOnce('done');
        await expect(retryOnConnectionError(work, { sleep: s })).resolves.toBe('done');
        expect(work).toHaveBeenCalledTimes(2);
        expect(s).toHaveBeenCalledWith(RETRY_WAIT_MS);
        expect(RETRY_WAIT_MS).toBe(1_000);
    });

    it("a second connection error goes to the caller (the job's backoff)", async () => {
        const work = vi.fn().mockRejectedValue(socket('ECONNREFUSED'));
        await expect(retryOnConnectionError(work, { sleep: sleep() })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
        expect(work).toHaveBeenCalledTimes(2);
    });

    it('any other error at once, without a retry', async () => {
        const s = sleep();
        const work = vi.fn().mockRejectedValue(known('P2002'));
        await expect(retryOnConnectionError(work, { sleep: s })).rejects.toMatchObject({ code: 'P2002' });
        expect(work).toHaveBeenCalledTimes(1);
        expect(s).not.toHaveBeenCalled();
    });
});
