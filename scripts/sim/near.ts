// What the buddy kept near given moments of a simulated run (its database): thread events and notes within
// 150 s of each time, with the message they rest on, to tell apart two messages said close together.
//
//   node node_modules/ts-node/dist/bin.js --transpile-only scripts/sim/near.ts <db> <iso time> [<iso time> ...]
/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
    require('dotenv/config');
    const [db, ...times] = process.argv.slice(2);
    process.env.TEST_DB_NAME = db;
    const { getTestDatabaseUrl } = await import('../../tests/helpers/testDb');
    process.env.DATABASE_URL = getTestDatabaseUrl();
    const { prisma } = await import('../../src/db/prisma');
    for (const t of times) {
        const at = new Date(t);
        const from = new Date(at.getTime() - 150_000);
        const to = new Date(at.getTime() + 150_000);
        const evs = await prisma.buddyThreadEvent.findMany({ where: { saidAt: { gte: from, lte: to } }, include: { thread: { select: { title: true } } }, orderBy: { saidAt: 'asc' } });
        const obs = await prisma.observation.findMany({ where: { OR: [{ saidAt: { gte: from, lte: to } }, { saidAt: null, createdAt: { gte: from, lte: to } }] } });
        console.log(`== ${t}`);
        for (const e of evs as any[]) console.log(`  event ${e.kind} on "${e.thread.title}" via ${e.via} (${e.originKey ?? '-'}), said ${e.saidAt.toISOString()}: ${e.text}`);
        for (const o of obs as any[]) console.log(`  note ${o.kind} via ${o.via ?? o.source}: ${o.text}`);
    }
    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
