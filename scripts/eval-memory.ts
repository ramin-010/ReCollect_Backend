// Evaluation only (2026-11-17): Recollect's own memory pipeline on a small shared set of
// conversations, with the real models, in a database of its own (recollect_test_memeval). It never
// touches the dev database or a real person's account; the person in the scenario is invented.
// The same scenario file is fed to the other memory tools under comparison.
//
//   npx tsx scripts/eval-memory.ts <scenario.json> <out.json>     (PowerShell; about 40 cents)
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

type Msg = { at: string; text: string };
type Conversation = { id: string; what: string; key: string; seq: number; messages: Msg[] };

const plain = (_k: string, v: unknown) => (typeof v === 'bigint' ? Number(v) : v);

async function main() {
    const [scenarioPath, outPath] = process.argv.slice(2);
    if (!scenarioPath || !outPath) throw new Error('usage: eval-memory.ts <scenario.json> <out.json>');
    const scn = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as { conversations: Conversation[]; askedAt: string };

    process.env.TEST_DB_NAME = 'recollect_test_memeval';
    const { ensureTestDatabase, getTestDatabaseUrl, migrateTestDatabase } = await import('../tests/helpers/testDb');
    const url = getTestDatabaseUrl();
    await ensureTestDatabase(url);
    migrateTestDatabase(url);
    const email = 'maya-eval@test.local';
    process.env.DATABASE_URL = url;
    process.env.AI_ALLOWED_EMAILS = email;
    process.env.BUDDY_WORKER = 'off';

    const { prisma } = await import('../src/db/prisma');
    const { createUser } = await import('../src/services/users/users.service');
    const { updateBuddySettings } = await import('../src/services/buddy/state.service');
    const { queueOwnWords } = await import('../src/services/buddy/capture.service');
    const { drainBuddyQueue, nightIfDue } = await import('../src/services/buddy/worker');
    const { threadsForNight } = await import('../src/services/buddy/nightLoop');
    const { listMemories } = await import('../src/services/buddy/memory.service');
    const { loadLearningContext } = await import('../src/services/learningDb/common');

    await prisma.user.deleteMany({ where: { email } });
    const user = await createUser({ email, name: 'Maya', password: 'not-a-real-login-1' });
    await updateBuddySettings(user.id, { enabled: true, loop: true });

    const dbStats = async () => {
        await new Promise((r) => setTimeout(r, 11_000)); // the server writes its counters with a delay
        const rows = await prisma.$queryRaw<Array<Record<string, bigint>>>`SELECT xact_commit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, blks_read, blks_hit FROM pg_stat_database WHERE datname = current_database()`;
        return JSON.parse(JSON.stringify(rows[0], plain)) as Record<string, number>;
    };
    const stats0 = await dbStats();

    let seen = 0;
    const newUsage = async () => {
        const rows = await prisma.aiUsage.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        const fresh = rows.slice(seen);
        seen = rows.length;
        return fresh.map((r) => ({ feature: String(r.feature), model: r.model, input: r.inputTokens, output: r.outputTokens, cacheRead: r.cacheReadTokens, cacheWrite: r.cacheWriteTokens, costUsd: Number(r.costUsd) }));
    };
    type StepRow = { id: string; what: string; ms: number; cpuMs: number; calls: number; costUsd: number; ai: unknown; result: unknown; error: string | null };
    const steps: StepRow[] = [];
    const step = async (id: string, what: string, fn: () => Promise<unknown>) => {
        const t0 = performance.now();
        const cpu0 = process.cpuUsage();
        let result: unknown = null;
        let error: string | null = null;
        try {
            result = await fn();
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
        }
        const ms = Math.round(performance.now() - t0);
        const cpu = process.cpuUsage(cpu0);
        const ai = await newUsage();
        const row: StepRow = { id, what, ms, cpuMs: Math.round((cpu.user + cpu.system) / 1000), calls: ai.length, costUsd: Number(ai.reduce((s, a) => s + a.costUsd, 0).toFixed(5)), ai, result, error };
        steps.push(row);
        console.log(`${id}: ${ms} ms, ${ai.length} model calls, $${row.costUsd}${error ? ` ERROR ${error}` : ''}`);
    };
    const say = (c: Conversation) => {
        const at = new Date(Date.parse(c.messages[c.messages.length - 1]!.at) + 60_000);
        return step(c.id, c.what, async () => {
            const queued = await queueOwnWords(user.id, { key: `ask:${c.key}`, seq: c.seq, via: 'ask_ai', messages: c.messages }, at);
            const drained = await drainBuddyQueue(at);
            return { queued, drained };
        });
    };
    const night = (id: string, iso: string) =>
        step(id, `the night step at ${iso}`, async () => {
            const day = await nightIfDue(user.id, new Date(iso));
            return day ? { lines: day.lines, insight: day.insight, note: day.note, dropped: day.dropped } : null;
        });
    const conv = (id: string) => scn.conversations.find((c) => c.id === id)!;

    await say(conv('S0'));
    await night('N-sep09', '2026-09-08T23:30:00Z');
    await say(conv('C1'));
    await night('N-nov21', '2026-11-20T23:30:00Z');
    await say(conv('C2'));
    await say(conv('C3'));
    await say(conv('C4a'));
    await night('N-nov24', '2026-11-23T23:30:00Z');
    await say(conv('C4b'));
    await night('N-nov25', '2026-11-24T23:30:00Z');

    // What the system holds at the end, and what it would put in front of its model.
    const askedAt = new Date(scn.askedAt);
    const ctx = await loadLearningContext(user.id, askedAt);
    const where = { userId: user.id };
    const [memories, notes, threads, events, asks, days, tasks, suggestions] = await Promise.all([
        prisma.memory.findMany({ where, orderBy: { createdAt: 'asc' } }),
        prisma.observation.findMany({ where, orderBy: { createdAt: 'asc' } }),
        prisma.buddyThread.findMany({ where, orderBy: { createdAt: 'asc' } }),
        prisma.buddyThreadEvent.findMany({ where, orderBy: { saidAt: 'asc' } }),
        prisma.buddyAsk.findMany({ where, orderBy: { createdAt: 'asc' } }),
        prisma.buddyDay.findMany({ where, orderBy: { day: 'asc' } }),
        prisma.todo.count({ where }),
        prisma.suggestion.findMany({ where }),
    ]);
    const known = memories
        .filter((m) => m.status === 'active')
        .map((m) => `${m.kind} · ${m.text}`)
        .join('\n');
    const threadBlock = (await threadsForNight(user.id, ctx.today, askedAt)).block;
    const context = `What the buddy knows about her:\n${known || 'nothing'}\n\nWhat is going on (threads, with their last updates):\n${threadBlock}`;
    const fullText: Record<string, string[]> = {};
    for (const q of ['guitar', 'guitar practice', 'wrist', 'health guitar', 'grip']) fullText[q] = (await listMemories(user.id, { q, limit: 5 })).map((m) => m.text);

    const sizes = await prisma.$queryRaw<Array<Record<string, unknown>>>`
        SELECT c.relname AS "table", pg_total_relation_size(c.oid) AS "bytesWithIndexes"
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname IN ('Memory', 'Observation', 'BuddyThread', 'BuddyThreadEvent', 'BuddyAsk', 'BuddyDay') ORDER BY 1`;
    const rowBytes: Record<string, { rows: number; avgBytes: number | null }> = {};
    for (const t of ['Memory', 'Observation', 'BuddyThread', 'BuddyThreadEvent', 'BuddyAsk', 'BuddyDay']) {
        const r = await prisma.$queryRawUnsafe<Array<{ avg: number | null; n: bigint }>>(`SELECT avg(pg_column_size(t.*))::float AS avg, count(*) AS n FROM "${t}" t WHERE t."userId" = $1`, user.id);
        rowBytes[t] = { rows: Number(r[0]?.n ?? 0), avgBytes: r[0]?.avg ? Math.round(r[0].avg) : null };
    }
    const stats1 = await dbStats();
    const dbDelta = Object.fromEntries(Object.keys(stats1).map((k) => [k, stats1[k]! - stats0[k]!]));
    const usage = process.resourceUsage();

    const out = {
        system: 'recollect',
        ranAt: new Date().toISOString(),
        steps,
        totals: {
            modelCalls: steps.reduce((s, x) => s + x.calls, 0),
            costUsd: Number(steps.reduce((s, x) => s + x.costUsd, 0).toFixed(4)),
            wallMs: steps.reduce((s, x) => s + x.ms, 0),
            cpuMs: steps.reduce((s, x) => s + x.cpuMs, 0),
        },
        process: { maxRssMb: Math.round(usage.maxRSS / 1024), rssMb: Math.round(process.memoryUsage().rss / 1048576) },
        db: { delta: dbDelta, sizes, rowBytes },
        state: { memories, notes, threads, events, asks, days, tasks, suggestions },
        context,
        fullText,
    };
    fs.writeFileSync(outPath, JSON.stringify(out, plain, 2));
    console.log(`written ${outPath}: ${out.totals.modelCalls} model calls, $${out.totals.costUsd}`);
    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
