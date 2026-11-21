// Stage 19's device pass, read-only on dev: the QA account's day now and at a moved time (what the widget's card, Coming
// up and the lock's rows hold), to see a Later off the lists until its time and a lock row after it.
//   npx ts-node --transpile-only scripts/sim/later-check.ts <ISO time>
import 'dotenv/config';
import { prisma } from '../../src/db/prisma';
import { aheadFor } from '../../src/services/ahead/ahead.service';

async function main(): Promise<void> {
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'qa@recollect.local' }, select: { id: true } });
    for (const at of [new Date(), new Date(process.argv[2]!)]) {
        const a = await aheadFor(user.id, at, { todayMax: 6, aheadMax: 6 });
        console.log(at.toISOString(), '\n  today:', a.today.map((r) => `${r.at} ${r.text}`).join(' | ') || '-', '\n  coming up:', a.comingUp.map((r) => `${r.at} ${r.text}`).join(' | ') || '-');
    }
    await prisma.$disconnect();
}
main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
