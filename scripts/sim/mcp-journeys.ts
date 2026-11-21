// MCP_MEMORY_PLAN stages 2 and 3 on the real models (they cost money: about 40 cents in all): JW1, JW3 and the
// catch-up's RAG story, each on a throwaway simulation account in the dev database (deleted at the end, with all its
// rows). Prints a verdict per run and the spend from AiUsage; never words of the owner's (there are none here).
//   npx ts-node --transpile-only scripts/sim/mcp-journeys.ts --yes [--runs 3]
import { prisma } from '../../src/db/prisma';
import { createUser } from '../../src/services/users/users.service';
import { rememberNotes } from '../../src/services/buddy/memory.service';
import { updateRecord } from '../../src/services/buddy/record.service';
import { catchUpIfDue } from '../../src/services/buddy/catchup';
import { drainBuddyQueue, nightIfDue, SAVE_SETTLE_MS } from '../../src/services/buddy/worker';

const DAY = 86_400_000;
const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 3;

async function account(tag: string) {
    const user = (await createUser({ email: `sim-${tag}-${Date.now().toString(36)}@recollect.local`, name: 'Sim Person', password: `sim-${Date.now()}` })) as unknown as { id: string };
    await prisma.buddyState.upsert({ where: { userId: user.id }, create: { userId: user.id, enabled: true, loop: true }, update: { enabled: true, loop: true } });
    return user.id;
}
const writer = (userId: string) => ({ userId, source: 'agent' as const, agentName: 'ChatGPT', via: 'connector' });
const actor = (userId: string) => ({ actor: { userId, agentName: 'ChatGPT', tokenId: null }, source: 'agent' as const, via: 'connector' });
const drain = async (times = 3) => {
    for (let i = 0; i < times; i++) await drainBuddyQueue(new Date(Date.now() + SAVE_SETTLE_MS + 1000 + i));
};
const spend = async (userId: string) => Number((await prisma.aiUsage.aggregate({ where: { userId }, _sum: { costUsd: true } }))._sum.costUsd ?? 0);

/** JW1: a new habit from the web opens one thread; progress with `on` answers its question. */
async function jw1(): Promise<{ ok: boolean; why: string; cost: number; userId: string }> {
    const userId = await account('jw1');
    await rememberNotes(writer(userId), [{ text: 'Started walking after work, aiming for 10,000 steps a day', kind: 'pattern', inferred: false }]);
    await drain();
    const threads = await prisma.buddyThread.findMany({ where: { userId } });
    if (threads.length !== 1) return { ok: false, why: `${threads.length} threads`, cost: await spend(userId), userId };
    const t = threads[0]!;
    await prisma.buddyAsk.create({ data: { userId, threadId: t.id, text: 'Did you get your walk in today?', seenRevision: t.revision, fromAt: new Date(Date.now() - 60_000), untilAt: new Date(Date.now() + 3600_000) } });
    await updateRecord(actor(userId), { on: t.id, update: 'done', text: 'Got my steps in today' });
    const ask = await prisma.buddyAsk.findFirstOrThrow({ where: { userId } });
    return { ok: ask.state === 'answered', why: `thread "${t.title}" (${t.stage}); question ${ask.state}`, cost: await spend(userId), userId };
}

/** JW3: a correction from the web changes the routine; the next night's words use the new one. */
async function jw3(): Promise<{ ok: boolean; why: string; cost: number; userId: string }> {
    const userId = await account('jw3');
    const r = await rememberNotes(writer(userId), [{ text: 'Walks after work every day', kind: 'pattern', inferred: false }], new Date(Date.now() - 3 * DAY));
    await drain();
    const id = r.notes[0]!.status === 'saved' ? r.notes[0]!.memory._id : '';
    await updateRecord(actor(userId), { on: id, update: 'changed', text: 'Walks in the mornings now, before work' });
    await drain();
    const night = await nightIfDue(userId, new Date(), { fresh: true });
    const words = JSON.stringify(night ?? {});
    const old = /after work/i.test(words) && !/(used to|no longer|instead of|moved|switched|changed)/i.test(words);
    return { ok: !!night && !old, why: night ? (old ? 'the night still speaks of "after work"' : 'the night uses the new routine') : 'no night', cost: await spend(userId), userId };
}

/** The RAG story (stage 3): an interest, a prototype, "learned enough for now", saved while the AI was off; then caught up. */
async function rag(): Promise<{ ok: boolean; why: string; cost: number; userId: string }> {
    const userId = await account('rag');
    const key = process.env['CLAUDE_API_KEY'];
    process.env['CLAUDE_API_KEY'] = '';
    const r = await rememberNotes(writer(userId), [{ text: 'Getting into RAG, want to build a small prototype', kind: 'aim', inferred: false }], new Date(Date.now() - 150 * DAY));
    const id = r.notes[0]!.status === 'saved' ? r.notes[0]!.memory._id : '';
    await updateRecord(actor(userId), { on: id, update: 'progress', text: 'Built a small RAG prototype over my notes' }, new Date(Date.now() - 120 * DAY));
    await updateRecord(actor(userId), { on: id, update: 'finished', text: 'Learned enough about RAG for now' }, new Date(Date.now() - 100 * DAY));
    process.env['CLAUDE_API_KEY'] = key;
    const ran = await catchUpIfDue(userId);
    await drain();
    await nightIfDue(userId, new Date(), { fresh: true });
    const threads = await prisma.buddyThread.findMany({ where: { userId } });
    const asks = await prisma.buddyAsk.count({ where: { userId } });
    const open = threads.filter((t) => ['noticed', 'active', 'committed'].includes(t.stage) && /rag/i.test(t.title));
    return { ok: ran === 'long' && asks === 0 && open.length === 0, why: `catch-up ${ran}; threads ${threads.map((t) => `"${t.title}" ${t.stage}`).join(', ') || 'none'}; questions ${asks}`, cost: await spend(userId), userId };
}

async function main(): Promise<void> {
    if (!process.argv.includes('--yes')) throw new Error('real models cost money: run with --yes');
    let total = 0;
    const made: string[] = [];
    try {
        for (const [name, fn, n] of [['JW1', jw1, runs], ['JW3', jw3, runs], ['RAG', rag, 1]] as const) {
            let passed = 0;
            for (let i = 0; i < n; i++) {
                const r = await fn();
                made.push(r.userId);
                total += r.cost;
                if (r.ok) passed++;
                console.log(`${name} run ${i + 1}: ${r.ok ? 'pass' : 'FAIL'} · ${r.why} · $${r.cost.toFixed(3)}`);
            }
            console.log(`${name}: ${passed}/${n}`);
        }
    } finally {
        for (const id of made) await prisma.user.delete({ where: { id } }).catch(() => {});
        console.log(`spent $${total.toFixed(3)}; ${made.length} simulation accounts deleted`);
        await prisma.$disconnect();
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
