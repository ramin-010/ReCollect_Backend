// MCP_MEMORY_PLAN stage 5 preparation: the connector simulation's own small database on the dev Postgres (never the
// dev database, never production): created, migrated, and seeded with the invented person of chats.json and what is
// planted (a habit the buddy follows with its open question, an interest, a routine, a preference). Prints counts and
// the planted ids only; the person signs in through the connector's OAuth page in the owner's live hour.
//   npx ts-node --transpile-only scripts/sim/connector/setup-db.ts [--reset]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import 'dotenv/config';

const DB = 'recollect_connector_sim';
const chats = JSON.parse(fs.readFileSync(path.join(__dirname, 'chats.json'), 'utf8')) as {
    person: { name: string; email: string; timezone: string };
    planted: Array<{ key: string; type: 'thread' | 'memory'; title?: string; keywords?: string[]; stage?: string; ask?: string; kind?: string; text?: string }>;
};

async function main(): Promise<void> {
    const live = new URL(process.env['DATABASE_URL']!);
    if (!/localhost|127\.0\.0\.1/.test(live.hostname)) throw new Error('the simulation database is made on the local dev server only');
    const admin = new URL(live.toString());
    admin.pathname = '/postgres';
    const a = new Client({ connectionString: admin.toString() });
    await a.connect();
    const exists = (await a.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB])).rowCount;
    if (exists && process.argv.includes('--reset')) await a.query(`DROP DATABASE "${DB}" WITH (FORCE)`);
    if (!exists || process.argv.includes('--reset')) await a.query(`CREATE DATABASE "${DB}"`);
    await a.end();
    const url = new URL(live.toString());
    url.pathname = `/${DB}`;
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
    process.env['DATABASE_URL'] = url.toString();

    // The app's own code on the simulation database (loaded after the URL is set).
    const { prisma } = await import('../../../src/db/prisma');
    const { createUser } = await import('../../../src/services/users/users.service');
    const { createMemoryByUser } = await import('../../../src/services/buddy/memory.service');
    const { openOrFindThread, withPersonLock } = await import('../../../src/services/buddy/threads');
    let user = await prisma.user.findFirst({ where: { email: chats.person.email } });
    if (!user) user = (await createUser({ email: chats.person.email, name: chats.person.name, password: 'connectorsim123' })) as never;
    const userId = (user as { id: string }).id;
    await prisma.buddyState.upsert({ where: { userId }, create: { userId, enabled: true, loop: true }, update: { enabled: true, loop: true } });
    const ids: Record<string, string> = {};
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: chats.person.timezone }).format(new Date());
    for (const p of chats.planted) {
        if (p.type === 'memory') {
            ids[p.key] = (await createMemoryByUser(userId, { text: p.text!, kind: p.kind as never }))._id;
            continue;
        }
        const { thread } = await withPersonLock(userId, (tx) => openOrFindThread(tx, userId, { title: p.title!, keywords: p.keywords ?? [] }, { saidAt: new Date(Date.now() - 86_400_000), forDay: today as never }));
        await prisma.buddyThread.update({ where: { id: thread.id }, data: { stage: (p.stage ?? 'active') as never } });
        ids[p.key] = thread.id;
        if (p.ask) await prisma.buddyAsk.create({ data: { userId, threadId: thread.id, text: p.ask, seenRevision: thread.revision, fromAt: new Date(Date.now() - 60_000), untilAt: new Date(Date.now() + 7 * 86_400_000) } });
    }
    fs.writeFileSync(path.join(__dirname, 'planted.local.json'), JSON.stringify({ userId, ids }, null, 2));
    console.log(`simulation database ${DB}: the person and ${Object.keys(ids).length} planted things ready (ids in planted.local.json)`);
    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
