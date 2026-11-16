// The pg pool's settings (hosting P1-12) and how pg itself reads TLS from DATABASE_URL.
// No database: pg parses the connection string when a client is made, and connects only on query.
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { POOL_MAX_DEFAULT, poolConfig } from '../../../src/db/prisma';

const NEON = 'postgresql://app:secret@ep-quiet-sky-123456-pooler.ap-southeast-1.aws.neon.tech/workspace';

describe('poolConfig', () => {
    it('defaults: 10 connections, 10 s to connect, idle ones closed after 60 s, TCP keep-alive', () => {
        expect(poolConfig({})).toEqual({
            connectionString: undefined,
            max: POOL_MAX_DEFAULT,
            connectionTimeoutMillis: 10_000,
            idleTimeoutMillis: 60_000,
            keepAlive: true,
        });
        expect(POOL_MAX_DEFAULT).toBe(10);
    });

    it('PG_POOL_MAX sets the size; anything but a positive whole number keeps the default', () => {
        expect(poolConfig({ PG_POOL_MAX: '4' }).max).toBe(4);
        for (const bad of ['', '0', '-2', '2.5', 'ten']) expect(poolConfig({ PG_POOL_MAX: bad }).max).toBe(POOL_MAX_DEFAULT);
    });

    it('passes DATABASE_URL through untouched', () => {
        expect(poolConfig({ DATABASE_URL: `${NEON}?sslmode=verify-full` }).connectionString).toBe(`${NEON}?sslmode=verify-full`);
    });
});

describe("pg's reading of sslmode (the pinned pg 8)", () => {
    const sslOf = (url: string) => (new pg.Client(poolConfig({ DATABASE_URL: url })) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;

    it('sslmode=verify-full turns TLS on with Node\'s defaults: the certificate and the host name are both checked', () => {
        const ssl = sslOf(`${NEON}?sslmode=verify-full`);
        expect(ssl).toEqual({});
        expect(ssl).not.toHaveProperty('rejectUnauthorized');
        expect(ssl).not.toHaveProperty('checkServerIdentity');
    });

    it('no-verify skips the check and disable turns TLS off (both refused for a remote database: productionCheck)', () => {
        expect(sslOf(`${NEON}?sslmode=no-verify`)).toEqual({ rejectUnauthorized: false });
        expect(sslOf(`${NEON}?sslmode=disable`)).toBe(false);
    });
});
