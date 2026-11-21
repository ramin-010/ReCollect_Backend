// When the loop's switch comes off (ECOSYSTEM_V2_PLAN §10.1, stage 5 accepted): the copied `thread` memories
// close, each "moved to On my mind", so the old path no longer holds what the threads now hold. A data change:
// run it after a dump checked by a full restore, with --dry-run first; --undo opens them again as they were.
// Counts only: no memory's words are printed.
//
//   npx ts-node --transpile-only scripts/close-copied-threads.ts --email <address> [--dry-run | --undo]
import 'dotenv/config';
import { prisma } from '../src/db/prisma';
import { loadLearningContext } from '../src/services/learningDb/common';
import { closeCopiedMemories, undoCloseCopiedMemories } from '../src/services/buddy/threads';

const flag = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
};

(async () => {
    const email = flag('--email');
    if (!email) throw new Error('Name the account: --email <address>');
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    if (process.argv.includes('--undo')) {
        console.log(`undo: ${(await undoCloseCopiedMemories(user.id)).reopened} thread memories open again`);
    } else {
        const { today } = await loadLearningContext(user.id, new Date());
        const dryRun = process.argv.includes('--dry-run');
        const { closed } = await closeCopiedMemories(user.id, today, { dryRun });
        console.log(dryRun ? `dry run: ${closed} copied thread memories would close` : `closed: ${closed} copied thread memories ("moved to On my mind")`);
    }
    await prisma.$disconnect();
})().catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
});
