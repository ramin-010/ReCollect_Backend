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
import { Pool } from 'pg';

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
    const connectionString = process.env.DATABASE_URL;
    const pool = new Pool({
        connectionString,
        max: Number(process.env.PG_POOL_MAX) || 10, // limit connections, as in Revise
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
