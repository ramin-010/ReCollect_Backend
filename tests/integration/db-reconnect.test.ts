// A database that goes away and comes back (hosting P1-12): Neon sleeping, a restart, the network.
// A pool built from poolConfig reaches the test database through a TCP proxy this file stops and
// starts; the same pool and Prisma client carry on without a restart, the errors Prisma gives on
// the way are the ones isConnectionError knows, and retryOnConnectionError carries a pass across.
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { poolConfig } from '../../src/db/prisma';
import { isConnectionError, retryOnConnectionError } from '../../src/db/retry';
import { getTestDatabaseUrl } from '../helpers/testDb';

interface Proxy {
    readonly port: number;
    up(): Promise<void>;
    down(): Promise<void>;
}

/** Forwards 127.0.0.1:<port> to the test database. down() drops every connection and refuses new ones. */
async function tcpProxy(target: { host: string; port: number }, blackHole = false): Promise<Proxy> {
    const sockets = new Set<net.Socket>();
    let server: net.Server | null = null;
    let port = 0;
    const track = (s: net.Socket) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    };
    const up = () =>
        new Promise<void>((resolve, reject) => {
            const srv = net.createServer((client) => {
                track(client);
                client.on('error', () => client.destroy());
                if (blackHole) return; // accepts, never answers: a connection attempt that hangs
                const upstream = net.connect(target.port, target.host);
                track(upstream);
                upstream.on('error', () => client.destroy());
                client.on('close', () => upstream.destroy());
                upstream.on('close', () => client.destroy());
                client.pipe(upstream).pipe(client);
            });
            srv.once('error', reject);
            srv.listen(port, '127.0.0.1', () => {
                port = (srv.address() as net.AddressInfo).port;
                server = srv;
                resolve();
            });
        });
    const down = () =>
        new Promise<void>((resolve) => {
            for (const s of sockets) s.destroy();
            sockets.clear();
            const srv = server;
            server = null;
            if (!srv) return resolve();
            srv.close(() => resolve());
        });
    await up();
    return {
        get port() {
            return port;
        },
        up,
        down,
    };
}

const testUrl = new URL(getTestDatabaseUrl());
const target = { host: testUrl.hostname.replace(/^\[(.*)\]$/, '$1'), port: Number(testUrl.port || 5432) };
const viaProxy = (proxy: Proxy) => {
    const url = new URL(testUrl.href);
    url.hostname = '127.0.0.1';
    url.port = String(proxy.port);
    return url.href;
};

let proxy: Proxy;
let pool: Pool;
let db: PrismaClient;
const idleErrors: string[] = [];

beforeAll(async () => {
    proxy = await tcpProxy(target);
    pool = new Pool(poolConfig({ DATABASE_URL: viaProxy(proxy), PG_POOL_MAX: '2' }));
    // As src/db/prisma.ts does: a connection dropped while idle must not end the process.
    pool.on('error', (err: Error & { code?: string }) => idleErrors.push(err.code ?? err.message));
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
});

afterEach(async () => {
    await proxy.up().catch(() => {}); // each test starts with the database reachable
});

afterAll(async () => {
    await db.$disconnect();
    await pool.end().catch(() => {});
    await proxy.down();
});

const one = async () => (await db.$queryRaw<{ n: number }[]>`SELECT 1::int AS n`)[0]?.n;

describe('the database goes away and comes back', () => {
    it('the same pool and client answer again once it is back, with no restart', async () => {
        expect(await one()).toBe(1);

        await proxy.down();
        const err = await one().then(() => null, (e: unknown) => e);
        expect(err).not.toBeNull();
        expect(isConnectionError(err)).toBe(true);

        await proxy.up();
        expect(await one()).toBe(1);
        expect(await one()).toBe(1);
    });

    it('a query cut off mid-way fails with a connection error, and the next one works', async () => {
        expect(await one()).toBe(1);
        const slow = db.$queryRaw`SELECT pg_sleep(3)`.then(() => null, (e: unknown) => e);
        await new Promise((r) => setTimeout(r, 300));
        await proxy.down();
        const err = await slow;
        expect(err).not.toBeNull();
        expect(isConnectionError(err)).toBe(true);

        await proxy.up();
        expect(await one()).toBe(1);
    });

    it('retryOnConnectionError carries a pass across a short outage (the database is back after the wait)', async () => {
        await proxy.down();
        let waits = 0;
        const n = await retryOnConnectionError(one, {
            sleep: async () => {
                waits += 1;
                await proxy.up();
            },
        });
        expect(n).toBe(1);
        expect(waits).toBe(1);
    });

    it('a second failure goes back to the caller (the job backs off)', async () => {
        await proxy.down();
        const err = await retryOnConnectionError(one, { sleep: async () => {} }).then(() => null, (e: unknown) => e);
        expect(isConnectionError(err)).toBe(true);
    });

    it('a connection attempt that hangs gives up at connectionTimeoutMillis with a connection error', async () => {
        const hole = await tcpProxy(target, true);
        const url = new URL(testUrl.href);
        url.hostname = '127.0.0.1';
        url.port = String(hole.port);
        const hung = new Pool({ ...poolConfig({ DATABASE_URL: url.href }), connectionTimeoutMillis: 500 });
        hung.on('error', () => {});
        const started = Date.now();
        const err = await hung.query('SELECT 1').then(() => null, (e: unknown) => e);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(isConnectionError(err)).toBe(true);
        await hung.end().catch(() => {});
        await hole.down();
    });
});
