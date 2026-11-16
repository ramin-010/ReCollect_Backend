// Doc search: write the words (Doc.searchText) of every doc that has none, as the server does at
// its start. With --all, every doc's words are written again first (after the way words are read
// from a doc changed: src/services/docs/docSearch.service.ts docPlainText). Safe to run any time,
// with the server up or not; it never changes a doc's content or updatedAt.
//
// The database is DATABASE_URL as this process was started with it, never backend/.env (review A7;
// scripts/lib/target.ts); the dev database only with --allow-dev:
//   the server:  DOTENV_CONFIG_PATH=<the API's env file> node -r dotenv/config dist-scripts/scripts/search-reindex.js [--all]
//   the PC:      DATABASE_URL=<target> node dist-scripts/scripts/search-reindex.js [--all]   (or npx ts-node --transpile-only scripts/search-reindex.ts)
import { describeTarget, resolveTarget } from './lib/target'; // first: it reads DATABASE_URL before any app module can load a .env file

async function main(): Promise<void> {
    const target = resolveTarget({ purpose: 'maintenance', allowDev: process.argv.includes('--allow-dev') });
    console.log(`[search-reindex] ${describeTarget(target)}`);
    const { prisma, disconnectPrisma } = await import('../src/db/prisma');
    try {
        const { refreshSearchText } = await import('../src/services/docs/docSearch.service');
        if (process.argv.includes('--all')) {
            const cleared = await prisma.$executeRaw`UPDATE "Doc" SET "searchText" = NULL WHERE "searchText" IS NOT NULL`;
            console.log(`cleared the words of ${cleared} doc(s)`);
        }
        const written = await refreshSearchText({}, Number.POSITIVE_INFINITY);
        const left = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "Doc" WHERE "searchText" IS NULL`;
        console.log(`wrote the words of ${written} doc(s); ${Number(left[0]?.n ?? 0)} left (changed while this ran: the next search writes them)`);
    } finally {
        await disconnectPrisma();
    }
}

main().catch((err) => {
    console.error('[search-reindex] failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
