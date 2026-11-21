// ECOSYSTEM_V2_PLAN stage 15's live hour, graded from the simulation database and the remote door's trace: for each
// chat of chats-trial.json and each app it ran in (windows-trial.local.json: { "<round>": { "person": "<email part>",
// "chats": { "<app>:<chatId>": ["<from ISO>", "<to ISO>"] }, "offers": { "<app>:<chatId>": "named" | "vague" },
// "secondOffer": ["<app>:<chatId>"] } }; what a reply offered is marked by hand from the transcript):
// - work (two results, the spot check): the work lines written inside the window: how many, their kinds, a line on the
//   seeded open line;
// - docs: the offer (named, vague, none), the notes written in the window (append_to_doc in the trace: "Added a note" or
//   "Already in that section") and where each note sits in the doc at the end (the section it landed under);
// - the same fact told to both apps: the remember calls in the windows (the night's verdict is connector-after.ts's).
// Prints the table and the set totals against the plan's pass marks; writes trial-report.local.md.
//   npx ts-node --transpile-only scripts/sim/connector/grade-trial.ts [--windows windows-trial.local.json] [--planted planted-trial.local.json]
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import 'dotenv/config';

const DB = 'recollect_connector_sim';
const arg = (name: string, dflt: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : dflt);
interface Chat {
    id: string;
    group: 'two' | 'spot' | 'keep' | 'notworth' | 'word' | 'bothapps' | 'samefact';
    app: string;
    lines: number;
    kind?: string;
    kinds?: string[];
    closes?: string;
    offer?: boolean;
    reply?: 'yes' | 'no';
    note?: string | null;
    already?: boolean;
}
const spec = JSON.parse(fs.readFileSync(path.join(__dirname, 'chats-trial.json'), 'utf8')) as { chats: Chat[] };
const windows = JSON.parse(fs.readFileSync(path.join(__dirname, arg('--windows', 'windows-trial.local.json')), 'utf8')) as Record<string, { person: string; chats: Record<string, [string, string]>; offers?: Record<string, 'named' | 'vague'>; secondOffer?: string[] }>;
const planted = JSON.parse(fs.readFileSync(path.join(__dirname, arg('--planted', 'planted-trial.local.json')), 'utf8')) as Record<string, { userId: string; docId: string; ids: Record<string, string> }>;
const TRACE = path.join(__dirname, '..', '..', '..', '.devdb', 'connector', 'trace.jsonl');
const trace = (fs.existsSync(TRACE) ? fs.readFileSync(TRACE, 'utf8').split('\n').filter(Boolean) : []).map((l) => JSON.parse(l) as { at: string; tool: string; args: Record<string, unknown>; answer?: string });

const inWindow = (at: string, [from, to]: [string, string]) => at >= from && at <= new Date(new Date(to).getTime() + 5_000).toISOString();
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

async function main(): Promise<void> {
    const live = new URL(process.env['DATABASE_URL']!);
    live.pathname = `/${DB}`;
    process.env['DATABASE_URL'] = live.toString();
    const { prisma } = await import('../../../src/db/prisma');
    const { blockText } = await import('../../../src/services/agent/agentBlocks.service');
    const { isFooter } = await import('../../../src/services/agent/docNotes');
    const { readBlocks } = await import('../../../src/services/docs/blocks/serverEditor');

    /** Each note in the doc now (a footer block) and the heading it sits under. */
    async function notesIn(docId: string): Promise<Array<{ under: string; text: string }>> {
        const row = await prisma.doc.findUniqueOrThrow({ where: { id: docId }, select: { yjsState: true } });
        const ydoc = new Y.Doc();
        if (row.yjsState) Y.applyUpdate(ydoc, row.yjsState);
        const top = readBlocks(ydoc);
        ydoc.destroy();
        const out: Array<{ under: string; text: string }> = [];
        let heading = '';
        for (let i = 0; i < top.length; i++) {
            const b = top[i]!;
            if (b.type === 'heading') heading = blockText(b).trim();
            else if (isFooter(blockText(b))) out.push({ under: heading, text: top.slice(Math.max(0, i - 3), i).map(blockText).join(' ').slice(0, 120) });
        }
        return out;
    }

    const rows: string[] = ['| round | app:chat | set | want | got | pass |', '|---|---|---|---|---|---|'];
    const sets = new Map<string, { pass: number; total: number; extra: string[] }>();
    const tally = (set: string, ok: boolean | null, extra?: string) => {
        const s = sets.get(set) ?? { pass: 0, total: 0, extra: [] };
        if (ok !== null) {
            s.total++;
            if (ok) s.pass++;
        }
        if (extra) s.extra.push(extra);
        sets.set(set, s);
    };
    for (const [round, w] of Object.entries(windows)) {
        if (round.startsWith('_')) continue;
        const person = planted[round];
        if (!person) throw new Error(`no planted person for round ${round}`);
        for (const [key, win] of Object.entries(w.chats)) {
            const [app, chatId] = key.split(':') as [string, string];
            const c = spec.chats.find((x) => x.id === chatId);
            if (!c) continue;
            const calls = trace.filter((t) => inWindow(t.at, win));
            const problems: string[] = [];
            let got = '';
            let ok: boolean | null = true;
            if (c.group === 'two' || c.group === 'spot') {
                const lines = (
                    await prisma.workLine.findMany({
                        where: { userId: person.userId, createdAt: { gte: new Date(win[0]), lte: new Date(new Date(win[1]).getTime() + 5_000) }, sessionKey: { startsWith: 'w_' } },
                        orderBy: { createdAt: 'asc' },
                        select: { kind: true, text: true, followsId: true, sameAsId: true, hidden: true },
                    })
                ).filter((l) => !l.hidden && !l.sameAsId);
                got = lines.map((l) => `${l.kind}: ${l.text}${l.followsId ? ' (on)' : ''}`).join('<br>') || 'nothing';
                if (lines.length !== c.lines) problems.push(`${lines.length} lines`);
                if (c.kind && lines.some((l) => l.kind !== c.kind)) problems.push(`kinds ${lines.map((l) => l.kind).join('/')}`);
                if (c.kinds && [...lines.map((l) => l.kind)].sort().join() !== [...c.kinds].sort().join()) problems.push(`kinds ${lines.map((l) => l.kind).join('/')}`);
                if (c.closes && !lines.some((l) => l.followsId === person.ids[c.closes!])) problems.push('the open line not closed');
            } else if (c.group === 'samefact') {
                const saved = calls.filter((t) => t.tool === 'remember' || t.tool === 'update_memory');
                got = saved.map((t) => `${t.tool}: ${JSON.stringify(t.args).slice(0, 140)}`).join('<br>') || 'nothing saved';
                ok = null; // the night decides (connector-after.ts)
            } else {
                const offer = w.offers?.[key] ?? null;
                const appends = calls.filter((t) => t.tool === 'append_to_doc');
                const added = appends.filter((t) => /Added a note/i.test(t.answer ?? ''));
                const already = appends.filter((t) => /Already in that section/i.test(t.answer ?? ''));
                const headings = added.map((t) => String(t.args['heading'] ?? '(no heading)'));
                got = `${offer ? `offer ${offer}` : 'no offer'}; ${added.length ? `added under ${headings.join(', ')}` : 'nothing added'}${already.length ? '; "already there"' : ''}`;
                if (c.group === 'keep') {
                    if (offer !== 'named') problems.push(offer ? 'offer did not name the doc and section' : 'no offer');
                    if (offer && !added.length) problems.push('a yes, nothing written');
                    if (added.some((t) => !same(String(t.args['heading']), c.note))) problems.push(`under ${headings.join(', ')}`);
                    tally('keep: under the right heading after a yes', offer ? added.length > 0 && added.every((t) => same(String(t.args['heading']), c.note)) : null);
                } else if (c.group === 'notworth') {
                    if (offer) problems.push('offered');
                    tally('notworth: nothing written without a yes', added.length === 0);
                    if (added.length) problems.push('written without a yes');
                } else if (c.group === 'word') {
                    if (c.id.startsWith('w1')) {
                        if (!added.length) problems.push('not written');
                        if (added.some((t) => !same(String(t.args['heading']), c.note))) problems.push(`under ${headings.join(', ')}`);
                    } else if (!offer) ok = null; // graded only when offered
                    else {
                        if (added.length) problems.push('written after a no');
                        if ((w.secondOffer ?? []).includes(key)) problems.push('offered again');
                    }
                } else if (c.group === 'bothapps') {
                    if (c.already) {
                        const notes = (await notesIn(person.docId)).filter((n) => same(n.under, c.note));
                        if (notes.length !== 1) problems.push(`${notes.length} notes under ${c.note}`);
                        if (added.length) problems.push('a second note written');
                    } else {
                        if (!offer) problems.push('no offer');
                        if (offer && !added.some((t) => same(String(t.args['heading']), c.note))) problems.push('not written under the section');
                    }
                }
            }
            if (ok !== null) ok = problems.length === 0;
            tally(c.group, ok);
            const want = c.group === 'two' || c.group === 'spot' ? `${c.lines}${c.kind ? ` ${c.kind}` : ''}${c.kinds ? ` ${c.kinds.join('+')}` : ''}${c.closes ? ` closes ${c.closes}` : ''}` : c.group === 'samefact' ? 'one memory after a night' : `${c.offer ? 'offer' : c.group === 'word' && c.id.startsWith('w1') ? 'their word' : 'no offer'}${c.note ? ` → ${c.note}` : ', nothing written'}`;
            rows.push(`| ${round} | ${key} | ${c.group} | ${want} | ${got} | ${ok === null ? 'n/a' : ok ? 'PASS' : `FAIL (${problems.join(', ')})`} |`);
        }
        // Where every note of the round's doc sits at the end.
        const notes = await notesIn(person.docId);
        rows.push(`| ${round} | (doc at the end) | | | ${notes.map((n) => `under "${n.under}": ${n.text}`).join('<br>') || 'no notes'} | |`);
    }
    const marks: Record<string, string> = {
        two: 'both written in 5 of 6 messages; the open line closed',
        spot: 'quiet 4 of 4; logged 3 of 4',
        keep: 'offered once, naming doc and section, in 2 of 3 (per app)',
        'keep: under the right heading after a yes': 'every offered case',
        notworth: 'no offer in 2 of 3 (per app)',
        'notworth: nothing written without a yes': '6 of 6',
        word: 'written with no further ask; after a no nothing written and no second offer',
        bothapps: 'one note in the section; the second answer says it is there',
    };
    const totals = [...sets.entries()].map(([set, s]) => `- **${set}:** ${s.pass} of ${s.total}${marks[set] ? ` (pass: ${marks[set]})` : ''}`);
    const head = '# Stage 15, the live hour';
    fs.writeFileSync(path.join(__dirname, 'trial-report.local.md'), [head, '', ...totals, '', ...rows].join('\n'));
    console.log([head, '', ...totals, '', ...rows].join('\n'));
    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
