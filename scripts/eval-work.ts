// ECOSYSTEM_V2_PLAN stage 12 with the real models, graded by code.
//   A: the summariser's check: Claude Code's work summary (Sonnet 5.5) given what other chats and apps already logged:
//      10 pieces, each on a fresh invented person in a database of its own (recollect_test_work; no account touched).
//      Passes at 8 of 10.
//   B: the question: Ask AI (the manager) on a seeded three-chat relay (Claude Code fixes, ChatGPT reviews, a parent
//      chat in Claude decides; a repeat folded, a decision changed, an older summary arriving last), asked "What did we
//      get done, and what's still open?" in three wordings, on the QA account on dev (its catalogue calls the running
//      API back: npm run up, with RECOLLECT_MCP_EMBEDDED on the new build); the seeded lines are deleted after.
//
//   node node_modules/ts-node/dist/bin.js --transpile-only scripts/eval-work.ts <outDir> A     (about 15 cents)
//   node node_modules/ts-node/dist/bin.js --transpile-only scripts/eval-work.ts <outDir> B     (about 25 cents)
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

type Check = { name: string; pass: boolean; detail: string };
const outDir = process.argv[2] ?? '';
const part = process.argv[3] ?? 'A';
if (!outDir) throw new Error('usage: eval-work.ts <outDir> A|B');
fs.mkdirSync(outDir, { recursive: true });

const ISO = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 20, h, m)).toISOString();

// ─── A: the summariser's check ─────────────────────────────────────────────

type Seed = { app: string; text: string; kind: 'did' | 'decided' | 'stuck'; project?: string; on?: number };
type Piece = Array<{ text: string; reply?: string }>;
interface Case {
    id: string;
    about: string;
    seed: Seed[];
    piece: Piece;
    /** The rows the session ends with, judged by code. */
    judge: (rows: Array<{ kind: string; text: string; followsId: string | null }>, seeded: string[]) => { pass: boolean; detail: string };
}

const has = (rows: Array<{ text: string }>, re: RegExp) => rows.some((r) => re.test(r.text));

const CASES: Case[] = [
    {
        id: 'same-fix-other-words',
        about: "ChatGPT already logged the fix in other words: the summary writes no line for it",
        seed: [{ app: 'ChatGPT', kind: 'did', text: 'Fixed the upload timeouts by raising the proxy timeout', project: 'api' }],
        piece: [{ text: 'big uploads keep timing out, bump the nginx proxy timeout to 120s', reply: 'Raised proxy_read_timeout to 120 s in nginx.conf and reloaded; a 2 GB upload now finishes.' }, { text: 'great, that worked' }],
        judge: (rows) => ({ pass: !has(rows, /timeout|proxy|upload/i), detail: rows.map((r) => r.text).join(' | ') || 'no lines' }),
    },
    {
        id: 'decision-carried-back',
        about: 'A decision made in ChatGPT and carried back: the summary writes the doing, not the decision again',
        seed: [{ app: 'ChatGPT', kind: 'decided', text: 'Decided to move uploads to S3: the app server disk fills up', project: 'api' }],
        piece: [{ text: 'we decided in the other chat to move uploads to S3. do it: presigned PUT from the client', reply: 'Added a presigned PUT endpoint and switched the client to upload straight to S3; old local uploads still served.' }],
        judge: (rows) => ({ pass: !rows.some((r) => r.kind === 'decided') && has(rows, /presign|s3/i), detail: rows.map((r) => `${r.kind}: ${r.text}`).join(' | ') }),
    },
    {
        id: 'closes-open',
        about: 'A piece that fixes an open problem another app logged: a line on that id',
        seed: [{ app: 'ChatGPT', kind: 'stuck', text: 'Review found the rollback script skips the cache', project: 'api' }],
        piece: [{ text: 'the review said rollback.sh skips the cache. make it clear the cache first', reply: 'rollback.sh now runs cache:clear before restoring the release; tested on staging.' }],
        judge: (rows, seeded) => ({ pass: rows.some((r) => r.followsId === seeded[0]), detail: rows.map((r) => `${r.kind}: ${r.text} (on ${r.followsId ?? '-'})`).join(' | ') }),
    },
    {
        id: 'changes-decision',
        about: 'A piece that changes a decision another app logged: a decided line on that id',
        seed: [{ app: 'Claude', kind: 'decided', text: 'Decided to keep the old export until the client signs off', project: 'erp' }],
        piece: [{ text: 'client signed off this morning. so we drop the old export now and ship the new one only', reply: 'Removed the old export route and its tests; the new export is the only one.' }],
        judge: (rows, seeded) => ({ pass: rows.some((r) => r.followsId === seeded[0]), detail: rows.map((r) => `${r.kind}: ${r.text} (on ${r.followsId ?? '-'})`).join(' | ') }),
    },
    {
        id: 'review-confirms',
        about: "A review pasted back that only confirms the fix already logged: no new line",
        seed: [{ app: 'Claude Code', kind: 'did', text: 'Added rate limiting to the login endpoint (10 tries per 15 minutes)', project: 'api' }],
        piece: [{ text: 'chatgpt reviewed the rate limit change: "looks correct, the window and the key are right". ok good', reply: 'Good, nothing to change then.' }],
        judge: (rows) => ({ pass: rows.length === 0 || !has(rows, /rate|limit|login/i), detail: rows.map((r) => r.text).join(' | ') || 'no lines' }),
    },
    {
        id: 'new-finding',
        about: 'A new problem unrelated to the picture: written as its own line, no on',
        seed: [{ app: 'ChatGPT', kind: 'did', text: 'Fixed the upload timeouts by raising the proxy timeout', project: 'api' }],
        piece: [{ text: 'webhook signatures fail for the EU account, look into it', reply: 'The EU account signs with the old secret; rotating needs the dashboard, which I cannot reach. Left it open.' }],
        judge: (rows) => ({ pass: has(rows, /webhook|signature|EU/i) && rows.every((r) => r.followsId === null), detail: rows.map((r) => `${r.kind}: ${r.text}`).join(' | ') }),
    },
    {
        id: 'plain-1',
        about: 'A plain piece with nothing in the picture: lines as before',
        seed: [],
        piece: [{ text: 'add an index on payments.created_at, the report is slow', reply: 'Added the index in a migration; the monthly report went from 9 s to 400 ms.' }],
        judge: (rows) => ({ pass: rows.some((r) => r.kind === 'did' && /index/i.test(r.text)), detail: rows.map((r) => `${r.kind}: ${r.text}`).join(' | ') }),
    },
    {
        id: 'plain-2',
        about: 'A plain piece beside unrelated lines from other apps: its own lines, no on',
        seed: [{ app: 'ChatGPT', kind: 'did', text: 'Drafted the blog post on caching', project: 'writing' }],
        piece: [{ text: 'write the migration that adds the refunds table', reply: 'Wrote the migration for the refunds table with its foreign keys; it runs clean on a copy of prod.' }],
        judge: (rows) => ({ pass: has(rows, /refund/i) && !has(rows, /blog/i) && rows.every((r) => r.followsId === null), detail: rows.map((r) => `${r.kind}: ${r.text}`).join(' | ') }),
    },
    {
        id: 'plain-3',
        about: 'Only questions about a topic: no lines',
        seed: [],
        piece: [{ text: 'how does postgres pick between a hash join and a merge join?', reply: 'It compares estimated costs: hash joins win for unsorted inputs…' }],
        judge: (rows) => ({ pass: rows.length === 0, detail: rows.map((r) => r.text).join(' | ') || 'no lines' }),
    },
    {
        id: 'more-detail',
        about: 'The same fix as the picture with more detail: no new line',
        seed: [{ app: 'Claude', kind: 'did', text: 'Fixed the flaky checkout test', project: 'shop' }],
        piece: [{ text: 'the checkout test was flaky because it did not wait for the cart api. fix it', reply: 'The test now waits for the cart API response before asserting; 50 runs green. Same fix the other chat described.' }],
        judge: (rows) => ({ pass: !has(rows, /checkout|flaky|cart/i), detail: rows.map((r) => r.text).join(' | ') || 'no lines' }),
    },
];

async function partA() {
    process.env.TEST_DB_NAME = 'recollect_test_work';
    const { ensureTestDatabase, getTestDatabaseUrl, migrateTestDatabase } = await import('../tests/helpers/testDb');
    const url = getTestDatabaseUrl();
    await ensureTestDatabase(url);
    migrateTestDatabase(url);
    process.env.DATABASE_URL = url;
    process.env.BUDDY_WORKER = 'off';
    const { prisma } = await import('../src/db/prisma');
    const users = await import('../src/services/users/users.service');
    const work = await import('../src/services/buddy/work');
    const lines: string[] = ['# Stage 12, the summariser’s check (A)', ''];
    const checks: Check[] = [];
    let cost = 0;
    for (const [i, c] of CASES.entries()) {
        const email = `work-${c.id}-${Date.now()}@work.test`;
        process.env.AI_ALLOWED_EMAILS = [process.env.AI_ALLOWED_EMAILS, email].filter(Boolean).join(',');
        const user = await users.createUser({ email, name: 'Asha Rao', password: 'not-a-real-login-1' });
        await prisma.user.update({ where: { id: user.id }, data: { timezone: 'Asia/Kolkata' } }).catch(() => {});
        await prisma.buddyState.create({ data: { userId: user.id, enabled: true, workLog: true } });
        const seeded: string[] = [];
        for (const [k, s] of c.seed.entries()) {
            const r = await work.logLine(user.id, { app: s.app }, { text: s.text, kind: s.kind, project: s.project, ...(s.on !== undefined ? { on: seeded[s.on] } : {}) }, new Date(ISO(4, k)));
            if (r.status !== 'saved') throw new Error(`seed not saved: ${JSON.stringify(r)}`);
            seeded.push(r.line._id);
        }
        const messages = c.piece.map((m, k) => ({ at: ISO(6, k * 3), ...m }));
        const r = await work.summariseWork({ userId: user.id, sessionKey: `cc_${c.id}`, project: c.seed[0]?.project ?? 'api', office: false, source: 'hook', via: null }, messages, new Date(ISO(7)));
        cost += r.costUsd;
        const rows = await prisma.workLine.findMany({ where: { userId: user.id, sessionKey: `cc_${c.id}` }, orderBy: { position: 'asc' }, select: { kind: true, text: true, followsId: true } });
        const v = c.judge(rows, seeded);
        checks.push({ name: c.id, pass: v.pass, detail: v.detail });
        lines.push(`## ${i + 1}. ${c.id}: ${v.pass ? 'PASS' : 'FAIL'}`, `- ${c.about}`, `- seeded: ${c.seed.map((s) => `${s.app} ${s.kind}: ${s.text}`).join(' | ') || 'nothing'}`, `- wrote: ${v.detail}`, '');
        console.log(`${c.id}: ${v.pass ? 'PASS' : 'FAIL'} · ${v.detail}`);
    }
    const passed = checks.filter((x) => x.pass).length;
    lines.splice(1, 0, `${passed} of ${checks.length} (passes at 8) · $${cost.toFixed(4)}`, '');
    fs.writeFileSync(path.join(outDir, 'work-A.md'), lines.join('\n'));
    fs.writeFileSync(path.join(outDir, 'work-A.json'), JSON.stringify({ passed, total: checks.length, costUsd: cost, checks }, null, 2));
    console.log(`A: ${passed}/${checks.length} · $${cost.toFixed(4)}`);
    await prisma.$disconnect();
}

// ─── B: the question, on a seeded relay ────────────────────────────────────

const QUESTIONS = ["What did we get done, and what's still open?", 'Give me a standup for today: what got done, what we decided, and what is still open.', 'Where did we land on uploads, and is anything from the review still open?'];

async function partB() {
    process.env.BUDDY_WORKER = 'off';
    const { prisma } = await import('../src/db/prisma');
    const work = await import('../src/services/buddy/work');
    const { runAssistant } = await import('../src/services/assistant/engine');
    const qa = await prisma.user.findUniqueOrThrow({ where: { email: 'qa@recollect.local' }, select: { id: true } });
    await prisma.buddyState.update({ where: { userId: qa.id }, data: { workLog: true } });
    const made: string[] = [];
    const lines: string[] = ['# Stage 12, the question on a seeded relay (B)', ''];
    const checks: Check[] = [];
    let cost = 0;
    const now = new Date();
    const at = (min: number) => new Date(now.getTime() - (240 - min) * 60_000);
    const line = async (app: string, input: Parameters<typeof work.logLine>[2], when: Date) => {
        const r = await work.logLine(qa.id, { app }, input, when);
        if (r.status !== 'saved') throw new Error(`seed not saved: ${JSON.stringify(r)}`);
        made.push(r.line._id);
        return r.line._id;
    };
    try {
        // Claude Code fixed it; ChatGPT reviewed (a finding, and the fix said again: folded); the parent chat decided, then changed it.
        await work.logWork(qa.id, { key: `cc_relay_${Date.now()}`, project: 'api', app: 'Claude Code', lines: [{ kind: 'did', text: 'Raised the nginx proxy timeout to 120 s so big uploads stop failing' }] }, at(0));
        const fix = (await prisma.workLine.findFirstOrThrow({ where: { userId: qa.id, text: { startsWith: 'Raised the nginx proxy timeout' } }, orderBy: { createdAt: 'desc' } })).id;
        made.push(fix);
        const finding = await line('ChatGPT', { text: 'Review found the rollback script skips the cache', kind: 'stuck', project: 'api' }, at(30));
        const repeat = await line('ChatGPT', { text: 'Fixed the upload timeouts by raising the proxy timeout', kind: 'did', project: 'api' }, at(31));
        await work.changeLine(qa.id, { app: 'ChatGPT' }, repeat, { sameAs: fix }, at(32));
        const keep = await line('Claude', { text: 'Decided to keep uploads on the app server for now', kind: 'decided', project: 'api' }, at(60));
        await line('Claude', { text: 'Decided to move uploads to S3: the server disk fills up', kind: 'decided', on: keep }, at(90));
        const cleared = `cc_relay2_${Date.now()}`;
        await work.logWork(qa.id, { key: cleared, project: 'api', app: 'Claude Code', lines: [{ kind: 'did', text: 'Made the rollback script clear the cache first', on: finding }] }, at(120));
        made.push(...(await prisma.workLine.findMany({ where: { userId: qa.id, sessionKey: cleared }, select: { id: true } })).map((r) => r.id));
        await line('Claude', { text: 'Webhook signatures fail for the EU account', kind: 'stuck', project: 'payments' }, at(150));
        // Claude Code's older summary arrives last: the decision before it changed.
        const late = `cc_relay3_${Date.now()}`;
        await work.logWork(qa.id, { key: late, project: 'api', app: 'Claude Code', lines: [{ kind: 'decided', text: 'Leaning to keep uploads on the app server', on: keep }] }, at(10));
        made.push(...(await prisma.workLine.findMany({ where: { userId: qa.id, sessionKey: late }, select: { id: true } })).map((r) => r.id));

        for (const [i, q] of QUESTIONS.entries()) {
            const turn = await runAssistant({ userId: qa.id, baseUrl: process.env['RECOLLECT_API'] ?? 'http://localhost:8002', history: [], text: q });
            cost += turn.costUsd;
            const a = turn.text;
            // The relay's fix (not the QA account's own older lines, which also hold "timeout").
            const bullets = a.split('\n').filter((l) => /proxy timeout|nginx|upload timeouts?/i.test(l));
            const openPart = /(still open|open\b|outstanding|unresolved)[\s\S]*/i.exec(a)?.[0] ?? '';
            // (The QA account's own lines hold "__pycache__": the rollback alone names the relay's finding.)
            const rollbackOpen = openPart.split('\n').some((l) => /rollback/i.test(l) && !/fixed|cleared|clear the cache|made the|resolved|done|closed|closes/i.test(l));
            const appServer = /app server/i.test(a);
            const g: Array<[string, boolean]> = [
                ['used get_work_log', turn.tools.some((t) => t.name === 'get_work_log')],
                i === 2 ? ['names the S3 decision', /S3/.test(a)] : ['the timeout fix once', bullets.length >= 1 && bullets.length <= 1],
                ['the rollback fix as done, not open', /rollback/i.test(a) && !rollbackOpen],
                ['the EU webhook as open', /webhook|EU account/i.test(a)],
                ['the decision is S3 (the old one only as changed)', /S3/.test(a) && (!appServer || /chang|instead|switch|moved|no longer|earlier|was to|replac|then|later/i.test(a))],
            ];
            const pass = g.every(([, ok]) => ok);
            checks.push({ name: `Q${i + 1}`, pass, detail: g.filter(([, ok]) => !ok).map(([n]) => n).join(', ') || 'all' });
            lines.push(`## Q${i + 1}: ${pass ? 'PASS' : 'FAIL'}`, `> ${q}`, '', `Tools: ${turn.tools.map((t) => t.name).join(', ')}`, '', a, '', ...g.map(([n, ok]) => `- ${ok ? 'PASS' : 'FAIL'} ${n}`), '');
            console.log(`Q${i + 1}: ${pass ? 'PASS' : 'FAIL'} · ${g.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join(' · ')}`);
        }
    } finally {
        const ids = [...new Set(made)];
        // Rows that point at the seeded ones first (none outside the seed), then the seed.
        await prisma.workLine.updateMany({ where: { id: { in: ids } }, data: { followsId: null, sameAsId: null } });
        await prisma.workLine.deleteMany({ where: { id: { in: ids } } });
        console.log(`cleaned ${ids.length} seeded lines`);
    }
    const passed = checks.filter((x) => x.pass).length;
    lines.splice(1, 0, `${passed} of ${checks.length} · $${cost.toFixed(4)}`, '');
    fs.writeFileSync(path.join(outDir, 'work-B.md'), lines.join('\n'));
    fs.writeFileSync(path.join(outDir, 'work-B.json'), JSON.stringify({ passed, total: checks.length, costUsd: cost, checks }, null, 2));
    console.log(`B: ${passed}/${checks.length} · $${cost.toFixed(4)}`);
    await prisma.$disconnect();
}

// ─── S: the question on the live hour's own records (the simulation database; its test backend must run: hour.ps1) ───

async function partS() {
    const live = new URL(process.env['DATABASE_URL']!);
    live.pathname = '/recollect_connector_sim';
    process.env['DATABASE_URL'] = live.toString();
    process.env.BUDDY_WORKER = 'off';
    const email = process.argv[4] ?? 'kiran.r.connector-sim@recollect.local';
    process.env.AI_ALLOWED_EMAILS = [process.env.AI_ALLOWED_EMAILS, email].filter(Boolean).join(',');
    const { prisma } = await import('../src/db/prisma');
    const work = await import('../src/services/buddy/work');
    const { runAssistant } = await import('../src/services/assistant/engine');
    const person = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    const q = "What got done and what's still open?";
    const lines: string[] = [`# The question on the live hour's records (${email.split('@')[0]})`, ''];
    let cost = 0;
    const ask = async (when: string) => {
        const turn = await runAssistant({ userId: person.id, baseUrl: 'http://localhost:8012', history: [], text: q });
        cost += turn.costUsd;
        lines.push(`## ${when}`, `Tools: ${turn.tools.map((t) => t.name).join(', ')}`, '', turn.text, '');
        console.log(`--- ${when}\n${turn.text}\n`);
    };
    await ask('Right after the chats (no night yet: the log as the writers left it, with "likely done" marks)');
    if (!process.argv.includes('--no-night')) {
        const s = await work.settleWork(person.id);
        cost += s.costUsd;
        lines.push(`The night's settling: ${s.linked} linked, ${s.folded} folded ($${s.costUsd.toFixed(4)})`, '');
        console.log(`settled: ${JSON.stringify(s)}`);
        await ask('After the night settled the log');
    }
    lines.splice(1, 0, `$${cost.toFixed(4)}`, '');
    fs.writeFileSync(path.join(outDir, `work-S-${email.split('.')[1]}.md`), lines.join('\n'));
    console.log(`S: $${cost.toFixed(4)}`);
    await prisma.$disconnect();
}

(part === 'S' ? partS() : part === 'B' ? partB() : partA()).catch((e) => {
    console.error(e);
    process.exit(1);
});
