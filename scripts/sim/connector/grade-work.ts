// ECOSYSTEM_V2_PLAN stage 12's live hour, graded from the simulation database: for each chat of chats-work.json and each
// app it ran in, the work lines written inside its window (windows-work.local.json: { "<round>": { "person": "<email
// part>", "chats": { "<app>:<chatId>": ["<from ISO>", "<to ISO>"] } } }) against its label: how many new lines, their
// kind, a line on the open line or decision named; whether the reply asked about the outcome is marked by hand in the
// windows file ("asked": ["<app>:<chatId>"]). Prints the table; writes work-report.local.md.
//   npx ts-node --transpile-only scripts/sim/connector/grade-work.ts [--windows windows-work.local.json] [--planted planted-work.local.json]
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const DB = 'recollect_connector_sim';
const arg = (name: string, dflt: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : dflt);
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'chats-work.json'), 'utf8')) as {
    chats: Array<{ id: string; group: string; app: string; round?: string; lines: number; kind?: string; asks?: boolean; closes?: string; decides?: string }>;
};
const windows = JSON.parse(fs.readFileSync(path.join(__dirname, arg('--windows', 'windows-work.local.json')), 'utf8')) as Record<string, { person: string; asked?: string[]; chats: Record<string, [string, string]> }>;
const planted = JSON.parse(fs.readFileSync(path.join(__dirname, arg('--planted', 'planted-work.local.json')), 'utf8')) as Record<string, { userId: string; ids: Record<string, string> }>;

async function main(): Promise<void> {
    const live = new URL(process.env['DATABASE_URL']!);
    live.pathname = `/${DB}`;
    process.env['DATABASE_URL'] = live.toString();
    const { prisma } = await import('../../../src/db/prisma');
    const rows: string[] = ['| round | app:chat | group | want | wrote | pass |', '|---|---|---|---|---|---|'];
    let pass = 0;
    let total = 0;
    for (const [round, w] of Object.entries(windows)) {
        if (round.startsWith('_')) continue;
        const person = planted[round];
        if (!person) throw new Error(`no planted person for round ${round}`);
        // The lines each chat wrote, so a later chat's `closes` can name an earlier chat's line.
        const byChat = new Map<string, Array<{ id: string; kind: string; text: string; followsId: string | null; sameAsId: string | null; hidden: boolean; app: string | null }>>();
        for (const [key, [from, to]] of Object.entries(w.chats)) {
            const lines = await prisma.workLine.findMany({
                where: { userId: person.userId, createdAt: { gte: new Date(from), lte: new Date(new Date(to).getTime() + 60_000) }, sessionKey: { startsWith: 'w_' } },
                orderBy: { createdAt: 'asc' },
                select: { id: true, kind: true, text: true, followsId: true, sameAsId: true, hidden: true, app: true },
            });
            byChat.set(key, lines);
        }
        for (const [key, lines] of byChat) {
            const [app, chatId] = key.split(':') as [string, string];
            const c = spec.chats.find((x) => x.id === chatId);
            if (!c) continue;
            const kept = lines.filter((l) => !l.hidden && !l.sameAsId);
            const checks: string[] = [];
            let ok = kept.length === c.lines;
            if (!ok) checks.push(`${kept.length} lines`);
            if (ok && c.kind && kept.some((l) => l.kind !== c.kind)) {
                ok = false;
                checks.push(`kind ${kept.map((l) => l.kind).join('/')}`);
            }
            if (c.closes) {
                const target = (byChat.get(`${app}:${c.closes}`) ?? byChat.get(`chatgpt:${c.closes}`) ?? []).find((l) => l.kind === 'stuck')?.id;
                if (!target || !kept.some((l) => l.followsId === target)) {
                    ok = false;
                    checks.push('not on the open line');
                }
            }
            if (c.decides) {
                const target = person.ids[c.decides];
                if (!kept.some((l) => l.kind === 'decided' && l.followsId === target)) {
                    ok = false;
                    checks.push('not on the decision');
                }
            }
            if (c.asks && !(w.asked ?? []).includes(key)) {
                ok = false;
                checks.push('no outcome question');
            }
            total++;
            if (ok) pass++;
            rows.push(`| ${round} | ${key} | ${c.group} | ${c.lines}${c.kind ? ` ${c.kind}` : ''}${c.closes ? ` closes ${c.closes}` : ''}${c.decides ? ` on ${c.decides}` : ''}${c.asks ? ' + asks' : ''} | ${kept.map((l) => `${l.kind}: ${l.text}${l.followsId ? ' (on)' : ''} [${l.app}]`).join('<br>') || 'nothing'} | ${ok ? 'PASS' : `FAIL (${checks.join(', ')})`} |`);
        }
    }
    const head = `# Stage 12, the live hour: ${pass} of ${total}`;
    fs.writeFileSync(path.join(__dirname, 'work-report.local.md'), [head, '', ...rows].join('\n'));
    console.log([head, '', ...rows].join('\n'));
    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
