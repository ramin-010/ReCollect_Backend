// The copy of the old `thread` memories into threads (ECOSYSTEM_V2_PLAN stage 3, §10.1), by hand. Switching an
// account's loop on runs it once by itself; this is for a dry run, a second run, or the undo. The memories
// are never changed (so the loop switch can always go back); the undo deletes only the threads made from
// them, with their history. Counts only: no memory's words are printed.
//
//   npx ts-node --transpile-only scripts/copy-threads.ts --email qa@recollect.local [--dry-run | --undo]
import 'dotenv/config';
import { prisma } from '../src/db/prisma';
import { copyThreadMemories, undoThreadCopy } from '../src/services/buddy/threads';

const flag = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
};

(async () => {
    const email = flag('--email');
    if (!email) throw new Error('Name the account: --email <address>');
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    if (process.argv.includes('--undo')) {
        console.log(`undo: ${(await undoThreadCopy(user.id)).deleted} thread(s) made from memories deleted`);
    } else if (process.argv.includes('--dry-run')) {
        const memories = await prisma.memory.count({ where: { userId: user.id, kind: 'thread', status: { in: ['active', 'faded'] } } });
        const copied = await prisma.buddyThread.count({ where: { userId: user.id, memoryId: { not: null } } });
        console.log(`dry run: ${memories} open thread memories, ${copied} already copied`);
    } else {
        console.log(`copied: ${(await copyThreadMemories(user.id)).copied} thread(s)`);
    }
    await prisma.$disconnect();
})().catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect();
    process.exit(1);
});
