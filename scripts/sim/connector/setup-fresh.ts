// The live tests with fresh examples (11-19 afternoon; the rerun after MCP_MEMORY_PLAN §12): one invented person per
// round in the connector simulation's database (never the dev database, never production), each planted the same
// from the chats file, so the rounds don't feed each other. Adds to the existing database; drops nothing. Prints
// counts only; ids go to planted-<name>.local.json (chats-fresh.json → planted-fresh.local.json).
//   npx ts-node --transpile-only scripts/sim/connector/setup-fresh.ts [--chats chats-rerun.json]
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const DB = 'recollect_connector_sim';
const chatsArg = process.argv.indexOf('--chats');
const CHATS = chatsArg >= 0 ? process.argv[chatsArg + 1]! : 'chats-fresh.json';
const OUT = `planted-${path.basename(CHATS, '.json').replace(/^chats-/, '')}.local.json`;
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, CHATS), 'utf8')) as {
    persons: Array<{ round: string; name: string; email: string; timezone: string }>;
    planted: Array<{ key: string; type: 'thread' | 'memory'; title?: string; keywords?: string[]; stage?: string; ask?: string; kind?: string; text?: string }>;
};

async function main(): Promise<void> {
    const live = new URL(process.env['DATABASE_URL']!);
    if (!/localhost|127\.0\.0\.1/.test(live.hostname)) throw new Error('the simulation database is on the local dev server only');
    live.pathname = `/${DB}`;
    process.env['DATABASE_URL'] = live.toString();

    const { prisma } = await import('../../../src/db/prisma');
    const { createUser } = await import('../../../src/services/users/users.service');
    const { createMemoryByUser } = await import('../../../src/services/buddy/memory.service');
    const { openOrFindThread, withPersonLock } = await import('../../../src/services/buddy/threads');
    const out: Record<string, { userId: string; email: string; ids: Record<string, string> }> = {};
    for (const person of spec.persons) {
        if (await prisma.user.findFirst({ where: { email: person.email } })) throw new Error(`${person.round}: the person exists already`);
        const user = (await createUser({ email: person.email, name: person.name, password: 'connectorsim123' })) as unknown as { id: string };
        const userId = user.id;
        await prisma.user.update({ where: { id: userId }, data: { timezone: person.timezone } as never }).catch(() => undefined);
        await prisma.buddyState.upsert({ where: { userId }, create: { userId, enabled: true, loop: true }, update: { enabled: true, loop: true } });
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: person.timezone }).format(new Date());
        const ids: Record<string, string> = {};
        for (const p of spec.planted) {
            if (p.type === 'memory') {
                ids[p.key] = (await createMemoryByUser(userId, { text: p.text!, kind: p.kind as never }))._id;
                continue;
            }
            const { thread } = await withPersonLock(userId, (tx) => openOrFindThread(tx, userId, { title: p.title!, keywords: p.keywords ?? [] }, { saidAt: new Date(Date.now() - 3 * 86_400_000), forDay: today as never }));
            await prisma.buddyThread.update({ where: { id: thread.id }, data: { stage: (p.stage ?? 'active') as never } });
            ids[p.key] = thread.id;
            if (p.ask) await prisma.buddyAsk.create({ data: { userId, threadId: thread.id, text: p.ask, seenRevision: thread.revision, fromAt: new Date(Date.now() - 60_000), untilAt: new Date(Date.now() + 7 * 86_400_000) } });
        }
        out[person.round] = { userId, email: person.email, ids };
    }
    fs.writeFileSync(path.join(__dirname, OUT), JSON.stringify(out, null, 2));
    console.log(`simulation database ${DB}: ${spec.persons.length} people, ${spec.planted.length} planted things each (ids in ${OUT})`);
    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
