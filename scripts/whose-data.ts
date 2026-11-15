// What is on an account, and where each piece came from (LOOP_COMPLETE_SPEC S1.2): the seed sample,
// test runs and QA scripts, your own agents, or the app by hand. A dry run by default.
//
//   npx ts-node --transpile-only scripts/whose-data.ts                    dry run for dev@recollect.local
//     --email <address>       another account
//     --windows <file.json>   [{ "from": ISO, "to": ISO, "what": "…" }]: times when test runs or QA scripts
//                             wrote with a real token or in the browser (they look like real use otherwise)
//     --apply --remove seed,test[,agent,app]   delete those groups (only after Ramin said so)
//     --keep <id,id…>         never delete these items, whatever their group
//
// Groups:
//   seed   made by `npm run db:seed`: matched title by title against a seed run on a throwaway user
//          (in a transaction that is rolled back, so nothing of it is kept)
//   test   written by a test token (one named for a test or a QA script), or inside a --windows range
//   agent  written by your own agents (your own tokens), outside those ranges
//   app    made in the app by a person: you, or a QA script that drove the browser outside the ranges
// A subject is deleted only when none of its topics stay. Agent edits about deleted rows go with them.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { prisma, disconnectPrisma } from '../src/db/prisma';
import { seedLearning } from '../prisma/seed-learning';

type Group = 'seed' | 'test' | 'agent' | 'app';
type Kind = 'subject' | 'topic' | 'doc' | 'goal' | 'focus' | 'todo' | 'capture' | 'quickNote' | 'timeBlock' | 'slot' | 'session' | 'weakSpot' | 'recallSet' | 'coachNote' | 'project' | 'token';

interface Item {
    kind: Kind;
    id: string;
    title: string;
    created: Date;
    group: Group;
    why: string;
    /** subject of a topic; doc of a topic */
    parent?: string | undefined;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const EMAIL = flag('--email') ?? 'dev@recollect.local';
const APPLY = args.includes('--apply');
const REMOVE = new Set((flag('--remove') ?? '').split(',').filter(Boolean) as Group[]);
const KEEP = new Set((flag('--keep') ?? '').split(',').filter(Boolean));
const WINDOWS: Array<{ from: Date; to: Date; what: string }> = flag('--windows')
    ? (JSON.parse(readFileSync(flag('--windows')!, 'utf8')) as Array<{ from: string; to: string; what: string }>).map((w) => ({ from: new Date(w.from), to: new Date(w.to), what: w.what }))
    : [];
/** A token made for a test or a QA script. */
const TEST_TOKEN = /test|qa\b|qa$|fixture|step\d|smoke|e2e|delete me/i;

const inWindow = (d: Date) => WINDOWS.find((w) => d >= w.from && d <= w.to);
const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ');

class Rollback extends Error {}

/** What the seed makes, per kind, by title: a seed run on a throwaway user, rolled back. */
async function seedTitles(): Promise<Record<string, Set<string>>> {
    const out: Record<string, Set<string>> = {};
    const put = (kind: string, titles: Array<string | null>) => (out[kind] = new Set(titles.filter((t): t is string => !!t)));
    try {
        await prisma.$transaction(
            async (tx) => {
                const tmp = await tx.user.create({ data: { email: `whose-data-${Date.now()}@recollect.local`, name: 'whose-data' }, select: { id: true } });
                await seedLearning(tx as unknown as typeof prisma, tmp.id);
                const where = { userId: tmp.id };
                put('subject', (await tx.subject.findMany({ where, select: { name: true } })).map((r) => r.name));
                put('topic', (await tx.topic.findMany({ where, select: { title: true } })).map((r) => r.title));
                put('doc', (await tx.doc.findMany({ where, select: { title: true } })).map((r) => r.title));
                put('goal', (await tx.goal.findMany({ where, select: { title: true } })).map((r) => r.title));
                put('focus', (await tx.focusItem.findMany({ where, select: { text: true } })).map((r) => r.text));
                put('todo', (await tx.todo.findMany({ where, select: { title: true } })).map((r) => r.title));
                put('capture', (await tx.capture.findMany({ where, select: { title: true, url: true, content: true } })).map((r) => r.title ?? r.url ?? r.content));
                put('quickNote', (await tx.quickNote.findMany({ where, select: { content: true } })).map((r) => r.content));
                put('timeBlock', (await tx.timeBlock.findMany({ where, select: { title: true } })).map((r) => r.title));
                throw new Rollback();
            },
            { timeout: 120_000, maxWait: 10_000 }
        );
    } catch (err) {
        if (!(err instanceof Rollback)) throw err;
    }
    return out;
}

async function main(): Promise<void> {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL }, select: { id: true } });
    const userId = user.id;
    const seed = await seedTitles();
    const items: Item[] = [];

    // Who wrote what, from the agent edit log: entity id → { token name, active?, when }.
    const tokens = await prisma.apiToken.findMany({ where: { userId }, select: { id: true, name: true, revokedAt: true, createdAt: true } });
    const testToken = new Set(tokens.filter((t) => TEST_TOKEN.test(t.name)).map((t) => t.id));
    const edits = await prisma.agentEdit.findMany({ where: { userId }, select: { id: true, kind: true, tokenId: true, agentName: true, entityId: true, docId: true, createdAt: true } });
    const madeBy = new Map<string, { test: boolean; name: string; at: Date }>();
    for (const e of edits) {
        if (!e.kind.endsWith('_create') && e.kind !== 'path_plan') continue;
        const id = e.kind === 'doc_create' ? e.docId : e.entityId;
        if (id) madeBy.set(id, { test: (e.tokenId !== null && testToken.has(e.tokenId)) || !!inWindow(e.createdAt), name: e.agentName, at: e.createdAt });
    }
    const testEdits = edits.filter((e) => (e.tokenId && testToken.has(e.tokenId)) || inWindow(e.createdAt));
    const touchedByTest = new Set(testEdits.flatMap((e) => [e.docId, e.entityId]).filter((x): x is string => !!x));
    /** Made in the app and edited by a test token within 15 minutes: made for that test. */
    const madeForTest = (id: string, created: Date) =>
        testEdits.find((e) => (e.docId === id || e.entityId === id) && e.createdAt.getTime() - created.getTime() < 15 * 60_000 && e.createdAt >= created);

    const classify = (kind: Kind, id: string, title: string, created: Date, seedKey?: string): Pick<Item, 'group' | 'why'> => {
        if (seedKey && seed[seedKey]?.has(title)) return { group: 'seed', why: 'made by npm run db:seed' };
        const by = madeBy.get(id);
        if (by?.test) return { group: 'test', why: `made by ${by.name} (a test${inWindow(by.at) ? `: ${inWindow(by.at)!.what}` : ' token'})` };
        const w = inWindow(created);
        if (w) return { group: 'test', why: `made during ${w.what}` };
        if (by) return { group: 'agent', why: `made by your agent "${by.name}"` };
        const forTest = madeForTest(id, created);
        if (forTest) return { group: 'test', why: `made for a test (${forTest.agentName} edited it right after)` };
        return { group: 'app', why: 'made in the app' };
    };
    const add = (kind: Kind, id: string, title: string, created: Date, seedKey?: string, parent?: string) => items.push({ kind, id, title, created, parent, ...classify(kind, id, title, created, seedKey) });

    for (const s of await prisma.subject.findMany({ where: { userId }, select: { id: true, name: true, createdAt: true } })) add('subject', s.id, s.name, s.createdAt, 'subject');
    for (const t of await prisma.topic.findMany({ where: { userId }, select: { id: true, title: true, createdAt: true, subjectId: true, docId: true } })) {
        // A topic goes with its note when the note came from a test run.
        const docBy = t.docId ? madeBy.get(t.docId) : undefined;
        if (docBy?.test) items.push({ kind: 'topic', id: t.id, title: t.title, created: t.createdAt, parent: t.subjectId, group: 'test', why: `its note was made by ${docBy.name} (a test run)` });
        else add('topic', t.id, t.title, t.createdAt, 'topic', t.subjectId);
    }
    for (const d of await prisma.doc.findMany({ where: { userId }, select: { id: true, title: true, createdAt: true } })) {
        if (/^MCP smoke test/.test(d.title)) items.push({ kind: 'doc', id: d.id, title: d.title, created: d.createdAt, group: 'test', why: 'the MCP smoke test' });
        else add('doc', d.id, d.title, d.createdAt, 'doc');
    }
    for (const g of await prisma.goal.findMany({ where: { userId }, select: { id: true, title: true, createdAt: true } })) add('goal', g.id, g.title, g.createdAt, 'goal');
    for (const f of await prisma.focusItem.findMany({ where: { userId }, select: { id: true, text: true, createdAt: true } })) add('focus', f.id, f.text, f.createdAt, 'focus');
    for (const t of await prisma.todo.findMany({ where: { userId }, select: { id: true, title: true, createdAt: true } })) add('todo', t.id, t.title, t.createdAt, 'todo');
    for (const c of await prisma.capture.findMany({ where: { userId }, select: { id: true, title: true, url: true, content: true, createdAt: true } })) add('capture', c.id, c.title ?? c.url ?? c.content ?? '(capture)', c.createdAt, 'capture');
    for (const q of await prisma.quickNote.findMany({ where: { userId }, select: { id: true, content: true, createdAt: true } })) add('quickNote', q.id, q.content, q.createdAt, 'quickNote');
    for (const b of await prisma.timeBlock.findMany({ where: { userId }, select: { id: true, title: true, createdAt: true } })) add('timeBlock', b.id, b.title, b.createdAt, 'timeBlock');
    // Schedule slots come from the seed's time blocks (Revise's old day plan): one line for all of them.
    const slots = await prisma.dailyScheduleSlot.findMany({ where: { userId }, select: { id: true, createdAt: true } });
    for (const s of slots) items.push({ kind: 'slot', id: s.id, title: 'day-plan slot', created: s.createdAt, group: inWindow(s.createdAt) ? 'test' : 'seed', why: 'the old day plan (seed time blocks)' });
    for (const s of await prisma.workSession.findMany({ where: { userId }, select: { id: true, title: true, createdAt: true, source: true, agentName: true } })) {
        const w = inWindow(s.createdAt);
        items.push({ kind: 'session', id: s.id, title: s.title, created: s.createdAt, group: w ? 'test' : s.source === 'user' ? 'app' : 'agent', why: w ? `during ${w.what}` : s.source === 'user' ? 'logged by hand' : `written by ${s.agentName ?? s.source}` });
    }
    const sessionGroup = new Map(items.filter((i) => i.kind === 'session').map((i) => [i.id, i.group]));
    for (const w of await prisma.weakSpot.findMany({ where: { userId }, select: { id: true, text: true, createdAt: true, sessionId: true, source: true } })) {
        const g = (w.sessionId && sessionGroup.get(w.sessionId)) || (inWindow(w.createdAt) ? 'test' : 'app');
        items.push({ kind: 'weakSpot', id: w.id, title: w.text, created: w.createdAt, group: g, why: w.sessionId ? 'from a session' : `from ${w.source}` });
    }
    for (const r of await prisma.recallSet.findMany({ where: { userId }, select: { id: true, createdAt: true, doc: { select: { title: true } } } })) {
        const w = inWindow(r.createdAt);
        items.push({ kind: 'recallSet', id: r.id, title: `Recall on "${r.doc?.title ?? '?'}"`, created: r.createdAt, group: w ? 'test' : 'app', why: w ? `during ${w.what}` : 'Recall in the app' });
    }
    for (const c of await prisma.coachNote.findMany({ where: { userId }, select: { id: true, createdAt: true } })) {
        const w = inWindow(c.createdAt);
        items.push({ kind: 'coachNote', id: c.id, title: 'weekly coach note', created: c.createdAt, group: w ? 'test' : 'app', why: w ? `during ${w.what}` : 'the weekly coach' });
    }
    for (const p of await prisma.project.findMany({ where: { userId }, select: { id: true, name: true, createdAt: true } })) {
        const w = inWindow(p.createdAt);
        items.push({ kind: 'project', id: p.id, title: p.name, created: p.createdAt, group: w ? 'test' : 'agent', why: w ? `during ${w.what}` : 'made by a session' });
    }
    for (const t of tokens) {
        if (testToken.has(t.id)) items.push({ kind: 'token', id: t.id, title: `${t.name}${t.revokedAt ? ' (revoked)' : ''}`, created: t.createdAt, group: 'test', why: 'a test token' });
    }

    // Seed docs and topics that a test changed stay "seed", with a note.
    for (const i of items) if (i.group === 'seed' && touchedByTest.has(i.id)) i.why += '; a test run changed it';

    // ── Print ──
    const order: Group[] = ['seed', 'test', 'agent', 'app'];
    const label: Record<Group, string> = {
        seed: 'SEED: the sample made by npm run db:seed',
        test: 'TEST: test runs and QA scripts',
        agent: 'AGENT: your own agents (your Claude Code chats)',
        app: 'APP: made in the app by a person (you, or a QA script outside the known times): check each',
    };
    for (const g of order) {
        const mine = items.filter((i) => i.group === g);
        console.log(`\n${label[g]}: ${mine.length} item(s)`);
        const kinds = [...new Set(mine.map((i) => i.kind))];
        for (const k of kinds) {
            const of = mine.filter((i) => i.kind === k);
            if (of.length > 8 && (g === 'seed' || k === 'slot' || k === 'token')) {
                console.log(`  ${k} ×${of.length}: ${of.slice(0, 6).map((i) => i.title.slice(0, 40)).join(' · ')}${of.length > 6 ? ' …' : ''}`);
                continue;
            }
            for (const i of of) console.log(`  ${k.padEnd(9)} ${ist(i.created)} IST  ${i.title.slice(0, 70).padEnd(70)}  ${i.why}  [${i.id}]`);
        }
    }

    if (!APPLY) {
        console.log('\nDry run: nothing changed. To delete groups: --apply --remove seed,test (and --keep <id,…> for exceptions).');
        return;
    }
    if (REMOVE.size === 0) throw new Error('--apply needs --remove <groups>');
    const gone = items.filter((i) => REMOVE.has(i.group) && !KEEP.has(i.id));
    const ids = (k: Kind) => gone.filter((i) => i.kind === k).map((i) => i.id);
    const goneIds = new Set(gone.map((i) => i.id));

    const removedEdits = await prisma.agentEdit.deleteMany({
        where: { userId, OR: [{ entityId: { in: [...goneIds] } }, { docId: { in: ids('doc') } }, { tokenId: { in: ids('token') } }] },
    });
    await prisma.weakSpot.deleteMany({ where: { userId, id: { in: ids('weakSpot') } } });
    await prisma.workSession.deleteMany({ where: { userId, id: { in: ids('session') } } });
    await prisma.recallSet.deleteMany({ where: { userId, id: { in: ids('recallSet') } } });
    await prisma.coachNote.deleteMany({ where: { userId, id: { in: ids('coachNote') } } });
    await prisma.topic.deleteMany({ where: { userId, id: { in: ids('topic') } } });
    await prisma.doc.deleteMany({ where: { userId, id: { in: ids('doc') } } });
    // A subject only when nothing of it stays.
    const subjects = ids('subject');
    const kept = await prisma.topic.groupBy({ by: ['subjectId'], where: { userId, subjectId: { in: subjects } }, _count: true });
    const keptSubjects = new Set(kept.map((k) => k.subjectId));
    const subjectsGone = subjects.filter((s) => !keptSubjects.has(s));
    await prisma.subject.deleteMany({ where: { userId, id: { in: subjectsGone } } });
    await prisma.goal.deleteMany({ where: { userId, id: { in: ids('goal') } } });
    await prisma.focusItem.deleteMany({ where: { userId, id: { in: ids('focus') } } });
    await prisma.todo.deleteMany({ where: { userId, id: { in: ids('todo') } } });
    await prisma.capture.deleteMany({ where: { userId, id: { in: ids('capture') } } });
    await prisma.quickNote.deleteMany({ where: { userId, id: { in: ids('quickNote') } } });
    await prisma.timeBlock.deleteMany({ where: { userId, id: { in: ids('timeBlock') } } });
    await prisma.dailyScheduleSlot.deleteMany({ where: { userId, id: { in: ids('slot') } } });
    await prisma.project.deleteMany({ where: { userId, id: { in: ids('project') } } });
    await prisma.apiToken.deleteMany({ where: { userId, id: { in: ids('token') } } });
    console.log(`\nDeleted ${gone.length} item(s) in ${[...REMOVE].join(', ')} (${subjects.length - subjectsGone.length} subject(s) kept because topics of theirs stay; ${removedEdits.count} agent edit(s) about them).`);
}

main()
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => disconnectPrisma());
