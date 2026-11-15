// Doc search: write the words (Doc.searchText) of every doc that has none, as the server does at
// its start. With --all, every doc's words are written again first (after the way words are read
// from a doc changed: src/services/docs/docSearch.service.ts docPlainText). Safe to run any time,
// with the server up or not; it never changes a doc's content or updatedAt.
//
//   npx ts-node --transpile-only scripts/search-reindex.ts [--all]
import { prisma } from '../src/db/prisma';
import { refreshSearchText } from '../src/services/docs/docSearch.service';

async function main(): Promise<void> {
    if (process.argv.includes('--all')) {
        const cleared = await prisma.$executeRaw`UPDATE "Doc" SET "searchText" = NULL WHERE "searchText" IS NOT NULL`;
        console.log(`cleared the words of ${cleared} doc(s)`);
    }
    const written = await refreshSearchText({}, Number.POSITIVE_INFINITY);
    const left = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "Doc" WHERE "searchText" IS NULL`;
    console.log(`wrote the words of ${written} doc(s); ${Number(left[0]?.n ?? 0)} left (changed while this ran: the next search writes them)`);
}

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
