// Plants a chats file's planted things on an existing test person of the simulation database (memories; threads with
// their question), printing ids by key.   npx ts-node --transpile-only scripts/sim/connector/plant-existing.ts <email> [chats-rerun.json]
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

async function main(): Promise<void> {
    const live = new URL(process.env['DATABASE_URL']!);
    live.pathname = '/recollect_connector_sim';
    process.env['DATABASE_URL'] = live.toString();
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, process.argv[3] ?? 'chats-rerun.json'), 'utf8')) as { planted: Array<{ key: string; type: string; title?: string; keywords?: string[]; stage?: string; ask?: string; kind?: string; text?: string }> };
    const { prisma } = await import('../../../src/db/prisma');
    const { createMemoryByUser } = await import('../../../src/services/buddy/memory.service');
    const { openOrFindThread, withPersonLock } = await import('../../../src/services/buddy/threads');
    const user = await prisma.user.findFirstOrThrow({ where: { email: process.argv[2] }, select: { id: true } });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const ids: Record<string, string> = {};
    for (const p of spec.planted) {
        if (p.type === 'memory') {
            ids[p.key] = (await createMemoryByUser(user.id, { text: p.text!, kind: p.kind as never }))._id;
            continue;
        }
        const { thread } = await withPersonLock(user.id, (tx) => openOrFindThread(tx, user.id, { title: p.title!, keywords: p.keywords ?? [] }, { saidAt: new Date(Date.now() - 3 * 86_400_000), forDay: today as never }));
        await prisma.buddyThread.update({ where: { id: thread.id }, data: { stage: (p.stage ?? 'active') as never } });
        ids[p.key] = thread.id;
        if (p.ask) await prisma.buddyAsk.create({ data: { userId: user.id, threadId: thread.id, text: p.ask, seenRevision: thread.revision, fromAt: new Date(Date.now() - 60_000), untilAt: new Date(Date.now() + 7 * 86_400_000) } });
    }
    console.log(JSON.stringify(ids));
    await prisma.$disconnect();
}
main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
