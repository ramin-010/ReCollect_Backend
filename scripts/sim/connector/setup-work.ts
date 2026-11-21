// ECOSYSTEM_V2_PLAN stage 12's live hour: one invented person per round in the connector simulation's database (never
// the dev database, never production), their buddy on and their work log on, and the relay's Claude Code lines seeded as
// rows (as Claude Code's summary would have written them this morning). Adds to the database; drops nothing. Prints
// counts only; ids go to planted-work.local.json.
//   npx ts-node --transpile-only scripts/sim/connector/setup-work.ts [--suffix b]   (a second person per round for the A/B)
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const DB = 'recollect_connector_sim';
const suffixArg = process.argv.indexOf('--suffix');
const SUFFIX = suffixArg >= 0 ? process.argv[suffixArg + 1]! : '';
const OUT = `planted-work${SUFFIX ? `-${SUFFIX}` : ''}.local.json`;
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'chats-work.json'), 'utf8')) as {
    persons: Array<{ round: string; name: string; email: string; timezone: string }>;
    seed: Array<{ round: string; key: string; app: string; kind: 'did' | 'decided' | 'stuck'; project: string; text: string }>;
};

async function main(): Promise<void> {
    const live = new URL(process.env['DATABASE_URL']!);
    if (!/localhost|127\.0\.0\.1/.test(live.hostname)) throw new Error('the simulation database is on the local dev server only');
    live.pathname = `/${DB}`;
    process.env['DATABASE_URL'] = live.toString();

    const { prisma } = await import('../../../src/db/prisma');
    const { createUser } = await import('../../../src/services/users/users.service');
    const { logWork } = await import('../../../src/services/buddy/work');
    const out: Record<string, { userId: string; email: string; ids: Record<string, string> }> = {};
    for (const p of spec.persons) {
        const email = SUFFIX ? p.email.replace('@', `.${SUFFIX}@`) : p.email;
        if (await prisma.user.findFirst({ where: { email } })) throw new Error(`${p.round}: the person exists already`);
        const user = (await createUser({ email, name: p.name, password: 'connectorsim123' })) as unknown as { id: string };
        await prisma.user.update({ where: { id: user.id }, data: { timezone: p.timezone } as never }).catch(() => undefined);
        await prisma.buddyState.upsert({ where: { userId: user.id }, create: { userId: user.id, enabled: true, loop: true, workLog: true }, update: { enabled: true, loop: true, workLog: true } });
        const ids: Record<string, string> = {};
        // This morning, 09:00-10:00 local: what Claude Code logged before the chats.
        const morning = new Date(Date.now() - 3 * 3600_000);
        for (const [i, s] of spec.seed.filter((x) => x.round === p.round).entries()) {
            const key = `cc_seed_${s.key}`;
            await logWork(user.id, { key, project: s.project, app: s.app, lines: [{ kind: s.kind, text: s.text }] }, new Date(morning.getTime() + i * 60_000));
            ids[s.key] = (await prisma.workLine.findFirstOrThrow({ where: { userId: user.id, sessionKey: key } })).id;
        }
        out[p.round] = { userId: user.id, email, ids };
    }
    fs.writeFileSync(path.join(__dirname, OUT), JSON.stringify(out, null, 2));
    console.log(`simulation database ${DB}: ${spec.persons.length} people, the work log on, ${spec.seed.length} seeded lines (ids in ${OUT})`);
    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
