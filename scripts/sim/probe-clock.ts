// A check of the harness's foundations (no model call): does a moved clock reach Prisma's own timestamps, and
// can the database be copied while the process keeps running?
import { installClock, setClock } from './clock';

installClock(new Date('2026-11-25T04:30:00Z'));

async function main() {
    process.env.TEST_DB_NAME = 'recollect_test_simprobe';
    const { ensureTestDatabase, getTestDatabaseUrl, migrateTestDatabase } = await import('../../tests/helpers/testDb');
    const url = getTestDatabaseUrl();
    await ensureTestDatabase(url);
    migrateTestDatabase(url);
    process.env.DATABASE_URL = url;
    process.env.BUDDY_WORKER = 'off';
    const { prisma } = await import('../../src/db/prisma');
    const users = await import('../../src/services/users/users.service');
    const capture = await import('../../src/services/buddy/capture.service');
    const u = await users.createUser({ email: `probe-${Date.now()}@sim.test`, name: 'Probe', password: 'not-a-real-login-1' });
    const row = await prisma.user.findUnique({ where: { id: u.id }, select: { createdAt: true, updatedAt: true } });
    console.log('user createdAt', row?.createdAt.toISOString(), 'updatedAt', row?.updatedAt.toISOString());
    await capture.queueOwnWords(u.id, { key: 'ask:probe', seq: 1, via: 'ask_ai', messages: [{ at: new Date().toISOString(), text: 'hello' }] }, new Date());
    const chunk = await prisma.buddyChunk.findFirst({ where: { userId: u.id }, select: { createdAt: true } });
    console.log('chunk createdAt', chunk?.createdAt.toISOString());
    const fb = await prisma.buddyFeedback.create({ data: { userId: u.id, target: 'morning', value: 'down', day: new Date('2026-11-25T00:00:00Z') } as never }).catch((e: Error) => ({ error: e.message.slice(0, 200) }));
    console.log('feedback', JSON.stringify(fb).slice(0, 200));
    const db = await prisma.$queryRawUnsafe<Array<{ now: Date }>>('SELECT now() AS now');
    console.log('db now()', db[0]?.now.toISOString());
    // Copy the database while the process lives: disconnect, copy, go on.
    setClock(new Date('2026-11-26T04:30:00Z'));
    await prisma.$disconnect();
    const { Client } = await import('pg');
    const admin = new URL(url);
    admin.pathname = '/postgres';
    const c = new Client({ connectionString: admin.toString() });
    await c.connect();
    const t0 = Date.now();
    await c.query('DROP DATABASE IF EXISTS recollect_test_simprobe_copy');
    await c.query('CREATE DATABASE recollect_test_simprobe_copy TEMPLATE recollect_test_simprobe');
    console.log('copied in', Date.now() - t0, 'ms (sim clock ticks with real time)');
    await c.query('DROP DATABASE IF EXISTS recollect_test_simprobe_copy');
    await c.end();
    const again = await prisma.user.count();
    console.log('after the copy, users', again);
    await prisma.$disconnect();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
