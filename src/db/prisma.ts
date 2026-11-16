// The one PrismaClient for the backend (same setup as revise/src/lib/db.ts: PrismaPg adapter + pg Pool).
//
// Passwords are never selected by default: the client has a global `omit` for User.password.
// Where the hash is really needed (login, password checks), opt in per query:
//
//   prisma.user.findUnique({ where: { email }, omit: { password: false } })
//
// Doc.searchText (a doc's words for search, as long as the doc) is omitted the same way; only
// src/services/docs/docSearch.service.ts reads it, in raw SQL.
//
// For transactions use prisma.$transaction(async (tx) => …) and pass `tx` down to services
// (they take an optional `db: DbClient = prisma` argument).
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolConfig } from 'pg';

/** Connections the pool may open when PG_POOL_MAX is unset (as in Revise). */
export const POOL_MAX_DEFAULT = 10;

/**
 * The pg pool's settings (hosting P1-12: a database on another machine that sleeps when idle, as
 * Neon does after 5 minutes). PG_POOL_MAX connections; a connection attempt gives up after 10 s
 * instead of waiting forever; a connection idle for 60 s is closed, so the pool never holds sockets
 * across the database's sleep; TCP keep-alive notices a peer that went away. The same settings
 * serve the local database. TLS comes from DATABASE_URL itself (`sslmode=verify-full`).
 */
export function poolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
    const max = Number(env.PG_POOL_MAX);
    return {
        connectionString: env.DATABASE_URL,
        max: Number.isInteger(max) && max > 0 ? max : POOL_MAX_DEFAULT,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 60_000,
        keepAlive: true,
    };
}

function createPrismaClient(pool: Pool) {
    return new PrismaClient({
        adapter: new PrismaPg(pool),
        omit: { user: { password: true }, doc: { searchText: true } },
    });
}

export type AppPrismaClient = ReturnType<typeof createPrismaClient>;
/** The client handed to an interactive transaction callback. */
export type TxClient = Parameters<Parameters<AppPrismaClient['$transaction']>[0]>[0];
/** Anything a service can run queries on: the root client or a transaction client. */
export type DbClient = AppPrismaClient | TxClient;

const globalForPrisma = globalThis as unknown as {
    __recollectPrisma?: AppPrismaClient;
    __recollectPgPool?: Pool;
};

function getOrCreate(): AppPrismaClient {
    if (globalForPrisma.__recollectPrisma) return globalForPrisma.__recollectPrisma;

    // Nothing connects until the first query, so importing this file never needs a database
    // (unit tests rely on that). src/index.ts refuses to start without DATABASE_URL.
    const pool = new Pool(poolConfig());
    // A connection that drops while idle (the database restarted or went to sleep) leaves the pool
    // and the next query opens a new one; without a listener its 'error' would end the process.
    // (Prisma's adapter adds a listener of its own once connected; this one is there from the start.)
    pool.on('error', (err: Error & { code?: string }) => {
        console.warn(`[db] an idle connection closed: ${err.code ?? err.message}`);
    });
    const client = createPrismaClient(pool);
    globalForPrisma.__recollectPgPool = pool;
    globalForPrisma.__recollectPrisma = client;
    return client;
}

export const prisma: AppPrismaClient = getOrCreate();

/** Close the client and its pool (tests, graceful shutdown). The next import creates a fresh one. */
export async function disconnectPrisma(): Promise<void> {
    const client = globalForPrisma.__recollectPrisma;
    const pool = globalForPrisma.__recollectPgPool;
    delete globalForPrisma.__recollectPrisma;
    delete globalForPrisma.__recollectPgPool;
    await client?.$disconnect();
    await pool?.end().catch(() => {});
}

export default prisma;
