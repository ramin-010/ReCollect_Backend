// ECOSYSTEM_V2_PLAN stage 15's live hour: one invented person per round in the connector simulation's database (never
// the dev database, never production): the buddy, the loop and the work log on, their study note "Sliding window" (their
// own doc, sections Fixed-size window / Variable-size window / Complexity), and for the work rounds the open line t3
// closes (as Claude Code would have logged it yesterday). Adds to the database; drops nothing. Prints counts only; ids go
// to planted-trial.local.json.
//   npx ts-node --transpile-only scripts/sim/connector/setup-trial.ts [--suffix b]   (a second set of people: rounds again)
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const DB = 'recollect_connector_sim';
const suffixArg = process.argv.indexOf('--suffix');
const SUFFIX = suffixArg >= 0 ? process.argv[suffixArg + 1]! : '';
const OUT = `planted-trial${SUFFIX ? `-${SUFFIX}` : ''}.local.json`;
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'chats-trial.json'), 'utf8')) as {
    persons: Array<{ round: string; name: string; email: string; timezone: string }>;
    doc: { title: string; markdown: string };
    seed: Array<{ round: string; key: string; app: string; kind: 'did' | 'decided' | 'stuck'; project: string; text: string }>;
};

async function main(): Promise<void> {
    const live = new URL(process.env['DATABASE_URL']!);
    if (!/localhost|127\.0\.0\.1/.test(live.hostname)) throw new Error('the simulation database is on the local dev server only');
    live.pathname = `/${DB}`;
    process.env['DATABASE_URL'] = live.toString();

    const { prisma } = await import('../../../src/db/prisma');
    const { createUser } = await import('../../../src/services/users/users.service');
    const { createDocFromMarkdown } = await import('../../../src/services/agent/agentDocs.service');
    const { logWork } = await import('../../../src/services/buddy/work');
    const out: Record<string, { userId: string; email: string; docId: string; ids: Record<string, string> }> = {};
    for (const p of spec.persons) {
        const email = SUFFIX ? p.email.replace('@', `.${SUFFIX}@`) : p.email;
        if (await prisma.user.findFirst({ where: { email } })) throw new Error(`${p.round}: the person exists already (use --suffix)`);
        const user = (await createUser({ email, name: p.name, password: 'connectorsim123' })) as unknown as { id: string };
        await prisma.user.update({ where: { id: user.id }, data: { timezone: p.timezone } as never }).catch(() => undefined);
        await prisma.buddyState.upsert({ where: { userId: user.id }, create: { userId: user.id, enabled: true, loop: true, workLog: true }, update: { enabled: true, loop: true, workLog: true } });
        // Their own study note (not an agent's), as they wrote it.
        const doc = await createDocFromMarkdown(user.id, { title: spec.doc.title, markdown: spec.doc.markdown });
        const ids: Record<string, string> = {};
        // Yesterday evening: what Claude Code logged and left open.
        const yesterday = new Date(Date.now() - 20 * 3600_000);
        for (const [i, s] of spec.seed.filter((x) => x.round === p.round).entries()) {
            const key = `cc_seed_${s.key}`;
            await logWork(user.id, { key, project: s.project, app: s.app, lines: [{ kind: s.kind, text: s.text }] }, new Date(yesterday.getTime() + i * 60_000));
            ids[s.key] = (await prisma.workLine.findFirstOrThrow({ where: { userId: user.id, sessionKey: key } })).id;
        }
        out[p.round] = { userId: user.id, email, docId: (doc as { id: string }).id, ids };
    }
    fs.writeFileSync(path.join(__dirname, OUT), JSON.stringify(out, null, 2));
    console.log(`simulation database ${DB}: ${spec.persons.length} people, their note "${spec.doc.title}", ${spec.seed.length} seeded lines (ids in ${OUT})`);
    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
