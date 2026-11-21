// MCP_MEMORY_PLAN §12.5: what the buddy does later with what a connected assistant filed. One round of the live
// test (its exact recorded calls, from the remote door's trace) is replayed into a fresh invented person through the
// door's own code path (POST /mcp on a connector's token, the web set), with the AI off as it was; then the days go
// by on a moved clock: the zero-credit view the next morning, the AI back that evening (the catch-up, the queue), and
// the buddy's real nights and due steps on the days after. Graded by code on the labels T1-T8 (set in the plan
// before any run); every line and question is kept in full for the owner to read.
//
// Its own database (recollect_test_connafter on the local dev server, emptied at the start of each run): no worker of
// the dev server ever sees these people, and nothing of the owner's is read. The models cost money: --yes, and the
// run stops at --budget (default $0.40).
//   (PowerShell, from backend/) node node_modules/ts-node/dist/bin.js --transpile-only scripts/sim/connector-after.ts
//       --round claude|chatgpt-unselected|chatgpt-selected --label before|after [--run 1] [--budget 0.4] --yes
//       [--windows <file> --planted <file> --chats <file> --trace <file>]   (the live rerun's files)
/* eslint-disable @typescript-eslint/no-explicit-any */
import { installClock, setClock, simNow } from './clock';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};
const ROUND = opt('round') ?? '';
const LABEL = opt('label') ?? 'before';
const RUN = Number(opt('run') ?? 1);
const BUDGET = Number(opt('budget') ?? 0.4);
const HERE = path.join(__dirname, 'connector');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const TRACE = opt('trace') ?? path.join(ROOT, 'backend', '.devdb', 'connector', 'trace.jsonl');
const WINDOWS = opt('windows') ?? path.join(HERE, 'windows-fresh.local.json');
const PLANTED = opt('planted') ?? path.join(HERE, 'planted-fresh.local.json');
const CHATS = opt('chats') ?? path.join(HERE, 'chats-fresh.json');
const OUT = path.join(ROOT, 'backend', '.devdb', 'connector-after', LABEL, `${ROUND}-${RUN}`);
const TZ = 'Asia/Kolkata';
const OFFSET = '+05:30';

if (!args.includes('--yes')) throw new Error('the buddy runs on the real models (money): add --yes');
const windows = JSON.parse(fs.readFileSync(WINDOWS, 'utf8')) as Record<string, { person: string; chats: Record<string, [string, string]> }>;
const round = windows[ROUND];
if (!round) throw new Error(`no round "${ROUND}" in ${WINDOWS}`);
const spec = JSON.parse(fs.readFileSync(CHATS, 'utf8')) as { planted: Array<{ key: string; type: 'thread' | 'memory'; title?: string; keywords?: string[]; stage?: string; ask?: string; kind?: string; text?: string }> };
const livePlanted = (JSON.parse(fs.readFileSync(PLANTED, 'utf8')) as Record<string, { ids: Record<string, string> }>)[ROUND]?.ids ?? {};
const spans = Object.values(round.chats).map(([from, to]) => [new Date(from).getTime(), new Date(to).getTime() + 30_000] as const);
const calls = fs
    .readFileSync(TRACE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { at: string; app: string; tool: string; args: Record<string, unknown>; answer?: string })
    .filter((c) => spans.some(([a, b]) => new Date(c.at).getTime() >= a && new Date(c.at).getTime() <= b))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
if (!calls.length) throw new Error('no recorded calls in the round\'s windows');

const local = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const hhmm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const stamp = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const D0 = local(new Date(calls[0]!.at));
const dayPlus = (n: number) => {
    const d = new Date(`${D0}T12:00:00${OFFSET}`);
    return local(new Date(d.getTime() + n * 86_400_000));
};
const at = (n: number, hm: string) => new Date(`${dayPlus(n)}T${hm}:00${OFFSET}`);
installClock(new Date(new Date(calls[0]!.at).getTime() - 10 * 60_000));
// The API's request log is noise here.
const stdoutWrite = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = (chunk: any, ...rest: any[]) => (/^\u001b?\[0m(GET|POST|PUT|PATCH|DELETE) |CLOUD READY/.test(String(chunk)) ? true : stdoutWrite(chunk, ...rest));

// ─── Boot: its own database, the API in this process ───────────────────────────────────────────────────────

let C: any = {};
async function boot(): Promise<void> {
    require('dotenv/config');
    process.env.TEST_DB_NAME = 'recollect_test_connafter';
    process.env.BUDDY_WORKER = 'off';
    process.env.EMAIL_DELIVERY = 'off';
    process.env.REMINDER_EMAIL = 'off';
    process.env.RECOLLECT_MCP_EMBEDDED = path.join(ROOT, 'mcp', 'dist-next', 'embedded.js').replace(/\\/g, '/');
    process.env.MCP_TRACE_FILE = path.join(OUT, 'replay-trace.jsonl');
    // The AI off, as in the live test (the test backend allowed no account): saved details wait for it.
    process.env.AI_ALLOWED_EMAILS = 'nobody@connector-after.invalid';
    const overrides = Object.keys(process.env).filter((k) => /^(BUDDY_[A-Z]+_MODEL|RECALL_MODEL|ASSISTANT_MODEL|CHECK_MODEL)$/.test(k));
    if (overrides.length) throw new Error(`model overrides set (${overrides.join(', ')}): this check runs production's models only`);
    const { ensureTestDatabase, getTestDatabaseUrl, migrateTestDatabase, truncateAllTables } = await import('../../tests/helpers/testDb');
    const url = getTestDatabaseUrl();
    await ensureTestDatabase(url);
    migrateTestDatabase(url);
    await truncateAllTables(url);
    process.env.DATABASE_URL = url;
    C.prisma = (await import('../../src/db/prisma')).prisma;
    C.app = (await import('../../src/app')).default;
    C.users = await import('../../src/services/users/users.service');
    C.tokens = await import('../../src/services/apiTokens/apiTokens.service');
    C.memory = await import('../../src/services/buddy/memory.service');
    C.threads = await import('../../src/services/buddy/threads');
    C.asks = await import('../../src/services/buddy/asks');
    C.worker = await import('../../src/services/buddy/worker');
    await new Promise<void>((resolve) => {
        C.server = C.app.listen(0, () => resolve());
    });
    C.base = `http://localhost:${C.server.address().port}`;
}

// ─── The person, as the live test planted them ─────────────────────────────────────────────────────────────

let userId = '';
let email = '';
let token = '';
const idMap = new Map<string, string>();

async function setupPerson(): Promise<void> {
    const p = C.prisma;
    email = `connafter-${ROUND}-${LABEL}-${RUN}@recollect.local`;
    const u = await C.users.createUser({ email, name: 'Noor', password: 'connafter-not-a-login-1' });
    userId = u.id;
    await p.buddyState.upsert({ where: { userId }, create: { userId, enabled: true, loop: true }, update: { enabled: true, loop: true } });
    const today = local(new Date());
    for (const item of spec.planted) {
        let id: string;
        if (item.type === 'memory') id = (await C.memory.createMemoryByUser(userId, { text: item.text!, kind: item.kind as never }))._id;
        else {
            const { thread } = await C.threads.withPersonLock(userId, (tx: any) => C.threads.openOrFindThread(tx, userId, { title: item.title!, keywords: item.keywords ?? [] }, { saidAt: new Date(Date.now() - 3 * 86_400_000), forDay: today }));
            await p.buddyThread.update({ where: { id: thread.id }, data: { stage: item.stage ?? 'active' } });
            if (item.ask) await p.buddyAsk.create({ data: { userId, threadId: thread.id, text: item.ask, seenRevision: thread.revision, fromAt: new Date(Date.now() - 60_000), untilAt: new Date(Date.now() + 7 * 86_400_000) } });
            id = thread.id;
        }
        if (livePlanted[item.key]) idMap.set(livePlanted[item.key]!, id);
    }
    // The connector's token: what an OAuth sign-in gives (the app's name, its client), so the notes say "via connector".
    const app = calls[0]!.app;
    const clientId = app === 'ChatGPT' ? 'https://chatgpt.com/oauth/client.json' : 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    await p.oAuthClient.upsert({ where: { id: clientId }, create: { id: clientId, name: app, redirectUris: [], kind: 'cimd' }, update: {} });
    token = (await C.tokens.createApiToken(userId, { name: app, scopes: ['read', 'docs:write', 'learning:write', 'sessions:write', 'tasks:write'] })).token;
    await p.apiToken.updateMany({ where: { userId, name: app }, data: { oauthClientId: clientId } });
}

let rpc = 0;
async function door(tool: string, input: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${C.base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name: tool, arguments: input } }),
    });
    const raw = await res.text();
    try {
        const j = JSON.parse(raw);
        if (j.error) return `ERROR ${j.error.message}`;
        return (j.result?.content ?? []).map((c: any) => c.text ?? `[${c.type}]`).join('\n');
    } catch {
        return `HTTP ${res.status}: ${raw.slice(0, 300)}`;
    }
}

const mapIds = (v: unknown): unknown =>
    typeof v === 'string' ? (idMap.get(v) ?? v) : Array.isArray(v) ? v.map(mapIds) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapIds(x)])) : v;
/** The id an answer names first for what it saved or changed to (so a later call naming the live one finds the replayed one). */
const firstId = (text: string) => /(?:Saved:|Changed: now|Already known|Counted as)[^\n]*?\bid ([a-z0-9]{20,})/.exec(text)?.[1] ?? null;

// ─── What is kept for the report ────────────────────────────────────────────────────────────────────────────

let report: any = { round: ROUND, label: LABEL, run: RUN, D0, replay: [], views: [], steps: [], grade: {}, costUsd: 0, notes: [] as string[] };

/** Everything the buddy said or asked, from the steps kept. */
function wordsOf(): Array<{ when: string; what: string; text: string }> {
    const out: Array<{ when: string; what: string; text: string }> = [];
    for (const s of report.steps) {
        for (const r of s.runs) {
            for (const l of r.lines) out.push({ when: s.name, what: `line ${l.from}-${l.until}`, text: l.text });
            if (r.insight) out.push({ when: s.name, what: 'home thought', text: r.insight });
            if (r.note) out.push({ when: s.name, what: 'note', text: r.note });
            if (r.followUp) out.push({ when: s.name, what: 'follow-up for the next chat', text: r.followUp });
        }
        for (const q of s.questions) out.push({ when: s.name, what: `question ${q.from} to ${q.until}`, text: q.text });
    }
    return out;
}

async function spent(): Promise<number> {
    const r = await C.prisma.aiUsage.aggregate({ where: { userId }, _sum: { costUsd: true } });
    return Number(r._sum.costUsd ?? 0);
}

async function record(): Promise<any> {
    const p = C.prisma;
    const [memories, threads, waiting, todos, reminders, buddyReminders] = await Promise.all([
        p.memory.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        p.buddyThread.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, include: { events: { orderBy: { saidAt: 'asc' }, select: { kind: true, text: true, duplicate: true, basis: true, forDay: true } } } }),
        p.observation.count({ where: { userId, waitingSince: { not: null } } }),
        p.todo.findMany({ where: { userId }, select: { title: true } }),
        p.reminder.findMany({ where: { userId }, select: { message: true } }),
        p.buddyReminder.findMany({ where: { userId }, select: { text: true, at: true } }),
    ]);
    return {
        memories: memories.map((m: any) => ({ text: m.text, kind: m.kind, status: m.status, private: m.sensitivity === 'private', byUser: m.byUser, check: !!m.checkSince, closeReason: m.closeReason })),
        threads: threads.map((t: any) => ({ title: t.title, stage: t.stage, events: t.events.map((e: any) => `${e.kind}${e.duplicate ? ' (dup)' : ''}: ${e.text}`) })),
        waiting,
        todos: todos.map((t: any) => t.title),
        reminders: [...reminders.map((r: any) => r.message), ...buddyReminders.map((r: any) => `${stamp(r.at)} ${r.text}`)],
    };
}

async function openQuestions(): Promise<any[]> {
    const rows = await C.prisma.buddyAsk.findMany({ where: { userId, state: { in: ['open', 'replied'] }, untilAt: { gt: new Date() } }, orderBy: { fromAt: 'asc' }, include: { thread: { select: { title: true } } } });
    return rows.map((a: any) => ({ text: a.text, from: stamp(a.fromAt), until: stamp(a.untilAt), thread: a.thread?.title ?? null, state: a.state }));
}

async function view(name: string, lookups: string[] = []): Promise<void> {
    const v: any = { name, at: stamp(new Date()), brief: await door('get_brief', {}), lookups: {} as Record<string, string>, questions: await openQuestions(), record: await record() };
    for (const q of lookups) v.lookups[q] = await door('recall_memory', { query: q });
    report.views.push(v);
}

/** The night's or a pulse's words, and the questions written, since `since`. */
async function stepsSince(since: Date, name: string): Promise<void> {
    const p = C.prisma;
    const days = await p.buddyDay.findMany({ where: { userId, createdAt: { gt: since } }, orderBy: { createdAt: 'asc' } });
    const asks = await p.buddyAsk.findMany({ where: { userId, createdAt: { gt: since } }, orderBy: { fromAt: 'asc' }, include: { thread: { select: { title: true } } } });
    const step: any = { name, at: stamp(new Date()), runs: [], questions: [], held: await heldSince(since) };
    for (const d of days) {
        const lines = ((d.lines as any[]) ?? []).filter((l) => l.text).map((l) => ({ text: l.text, from: l.from ?? l.slot, until: l.until ?? '', lockOk: l.lockOk }));
        step.runs.push({ kind: d.kind, onEvent: d.onEvent, model: d.model, costUsd: Number(d.costUsd), lines, insight: d.insight, note: d.note, followUp: d.followUp, ops: d.ops, dropped: d.dropped });
    }
    for (const a of asks) step.questions.push({ text: a.text, from: stamp(a.fromAt), until: stamp(a.untilAt), fromHour: Number(hhmm(a.fromAt).slice(0, 2)), fromDay: local(a.fromAt), thread: a.thread?.title ?? null, kind: a.kind });
    step.costUsd = await spent();
    report.steps.push(step);
}

/** What the buddy's reading kept since `since`: new threads and their events, new memories (the AI's own understanding). */
async function heldSince(since: Date): Promise<string[]> {
    const p = C.prisma;
    const where = { userId, createdAt: { gt: since } };
    const [threads, events, memories] = await Promise.all([
        p.buddyThread.findMany({ where, select: { title: true, stage: true } }),
        p.buddyThreadEvent.findMany({ where, orderBy: { createdAt: 'asc' }, include: { thread: { select: { title: true } } } }),
        p.memory.findMany({ where, select: { text: true, kind: true } }),
    ]);
    return [
        ...threads.map((t: any) => `new thread (${t.stage}): ${t.title}`),
        ...events.map((e: any) => `thread "${e.thread.title}" ← ${e.kind}${e.duplicate ? ' (duplicate)' : ''}: ${e.text}`),
        ...memories.map((m: any) => `new memory (${m.kind}): ${m.text}`),
    ];
}

async function guard(where: string): Promise<boolean> {
    const s = await spent();
    if (s > BUDGET) {
        report.notes.push(`stopped at ${where}: $${s.toFixed(4)} is over this run's budget of $${BUDGET}`);
        return false;
    }
    return true;
}

// ─── The days ───────────────────────────────────────────────────────────────────────────────────────────────

async function replay(): Promise<void> {
    for (const c of calls) {
        const t = new Date(c.at).getTime();
        if (t > simNow()) setClock(t);
        const input = mapIds(c.args) as Record<string, unknown>;
        const answer = await door(c.tool, input);
        const live = c.answer ?? '';
        const a = firstId(live);
        const b = firstId(answer);
        if (a && b && a !== b && !idMap.has(a)) idMap.set(a, b);
        report.replay.push({ at: stamp(new Date(c.at)), tool: c.tool, args: input, answer, live: live.split('\n')[0] });
    }
}

async function drainAll(): Promise<void> {
    for (let i = 0; i < 8; i++) {
        setClock(simNow() + 3 * 60_000);
        await C.worker.drainBuddyQueue(new Date());
        if (!(await C.prisma.buddyChunk.count({ where: { userId } }))) break;
    }
}

async function night(n: number): Promise<void> {
    setClock(at(n, '04:30'));
    const since = new Date(simNow() - 1);
    await drainAll();
    try {
        await C.worker.nightIfDue(userId, new Date());
    } catch (err) {
        report.notes.push(`the night of D${n} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await stepsSince(since, `D${n} night`);
}

async function dueSteps(n: number, hm: string): Promise<void> {
    setClock(at(n, hm));
    const since = new Date(simNow() - 1);
    await C.worker.runDueNights(new Date());
    await stepsSince(since, `D${n} ${hm}`);
}

// ─── The labels (MCP_MEMORY_PLAN §12.5, set before any run) ────────────────────────────────────────────────

/**
 * The labels of one sentence set (set before its run): the same eight checks, each on that set's own things. T1 a
 * correction, T2 a change of routine, T3 an end, T4 the followed thread's timing, T5 one day's slip, T6 a new interest,
 * T7 the quiet day, T8 work words.
 */
interface Labels {
    lookups: string[];
    correction: { name: string; lookup: string; stale: RegExp; current: RegExp };
    change: { name: string; now: RegExp; old: (t: string) => boolean };
    end: { name: string; re: RegExp; ok: RegExp; brief: RegExp };
    timing: { name: string; re: RegExp; old: RegExp; wrongFromNextWeek: (q: { fromHour: number; text: string }) => boolean; lineWrong: RegExp };
    slip: { name: string; habit: (m: { kind: string; text: string }) => boolean; re: RegExp; ask: RegExp };
    interest: { name: string; re: RegExp };
    work: RegExp;
}
const LABELS: Record<string, Labels> = {
    // The fresh test of 11-19 (MCP_MEMORY_PLAN §12.5).
    'chats-fresh.json': {
        lookups: ['allergies', 'charity ride', 'reading'],
        correction: { name: 'T1 the allergy is cashews', lookup: 'allergies', stale: /peanut/i, current: /cashew/i },
        change: { name: 'T2 audiobooks, not reading before bed', now: /audiobook/i, old: (t) => /(read|novel|pages)/i.test(t) && /bed/i.test(t) && !/(stopp|audiobook|no longer|instead|used to|swap|switch|any ?more)/i.test(t) },
        end: { name: 'T3 quiet about the dropped ride', re: /(ride|cycl|charity|50 ?km)/i, ok: /(pull|drop|stopp|ended|gave up|no longer|knee|out of)/i, brief: /(charity|cycle ride)/i },
        timing: { name: 'T4 yoga asked at the right time', re: /yoga/i, old: /(thursday|40 ?min|before logging|the other day)/i, wrongFromNextWeek: (q) => q.fromHour < 16 || /morning/i.test(q.text), lineWrong: /morning/i },
        slip: { name: 'T5 the coffee slip stays one day', habit: (m) => m.kind === 'pattern' && /coffee/i.test(m.text) && /(two|2)/i.test(m.text), re: /coffee/i, ask: /(coffee|caffeine|cut(ting)? down)/i },
        interest: { name: 'T6 birdwatching is not a task', re: /(bird|binocular|\blake\b)/i },
        work: /\b(kafka|payments?|settlement|rotterdam|reconciler|lead|sprint|rate.?limit\w*|redis|consumer lag|partitions?|gateway|billing)\b/i,
    },
    // The live rerun after the fixes (§12.6 step 3): its own things, the same eight checks.
    'chats-rerun.json': {
        lookups: ['seats', 'sugar', 'meal prep'],
        correction: { name: 'T1 aisle seats, not window', lookup: 'seats', stale: /window/i, current: /aisle/i },
        change: { name: 'T2 meal prep on Saturdays, not Sundays', now: /saturday/i, old: (t) => /(meal|prep|lunches)/i.test(t) && /sunday/i.test(t) && !/(saturday|moved|instead|no longer|used to|switch)/i.test(t) },
        end: { name: 'T3 quiet about the dropped no-sugar challenge', re: /(sugar|30-day|challenge)/i, ok: /(gave up|given up|dropp|stopp|ended|sustainable|no longer|over)/i, brief: /(no-sugar|sugar challenge)/i },
        timing: { name: 'T4 piano asked at the right time', re: /piano/i, old: /(thursday|20 ?min|lunch)/i, wrongFromNextWeek: (q) => q.fromHour >= 12 || /(evening|tonight|after dinner)/i.test(q.text), lineWrong: /(evening|tonight|after dinner)/i },
        slip: { name: 'T5 the takeout slip stays one day', habit: (m) => m.kind === 'pattern' && /(takeout|take-out)/i.test(m.text), re: /(takeout|take-out)/i, ask: /(takeout|take-out|japan|saving|fund)/i },
        interest: { name: 'T6 chess puzzles are not a task', re: /(chess|puzzle)/i },
        work: /\b(postgres\w*|explain|analyze|halvorsen|replica|on-?call|paged|runbook|terraform|s3|cloudfront|bucket|oac|react|kestrel|dispatch|tablets?|depots?|freight|logistics)\b/i,
    },
};
const L = LABELS[path.basename(CHATS)];
if (!L) throw new Error(`no labels for ${path.basename(CHATS)}: add them before any run`);

function grade(): void {
    const g: Record<string, { pass: boolean; why: string }> = {};
    const words = wordsOf();
    const last = report.views[report.views.length - 1];
    const d1 = report.views.find((v: any) => v.name === 'D1 09:00');
    const active = (v: any) => v.record.memories.filter((m: any) => m.status === 'active');
    const buddy = words.map((w) => `${w.what}: ${w.text}`);
    const say = (re: RegExp, not?: RegExp) => words.filter((w) => re.test(w.text) && !(not && not.test(w.text)));
    const inMotion = (v: any) => (/In motion[\s\S]*?(?=\n(?:Saved lately|Their buddy|Pass on|If they|Read this)|$)/.exec(v.brief)?.[0] ?? '');

    // T1 remembers the correction; the old version never named as current (the D1 look-up included).
    {
        const c = L.correction;
        const stale = [d1, last].flatMap((v: any) => active(v).filter((m: any) => c.stale.test(m.text) && !c.current.test(m.text)).map((m: any) => `${v.name} active: ${m.text}`));
        const knows = active(last).some((m: any) => c.current.test(m.text));
        const lookup = d1?.lookups?.[c.lookup] ?? '';
        const spoken = say(c.stale, c.current).map((w) => `${w.when} ${w.what}: ${w.text}`);
        g[c.name] = { pass: !stale.length && knows && c.current.test(lookup) && !spoken.length, why: [...stale, ...(knows ? [] : ['the correction unknown']), ...(c.current.test(lookup) ? [] : [`the D1 look-up "${c.lookup}" does not find it`]), ...spoken].join('; ') || 'the correction known, the old version never current' };
    }
    // T2 remembers the change of routine; the old routine never spoken of as current.
    {
        const c = L.change;
        const knows = active(last).some((m: any) => c.now.test(m.text)) || last.record.threads.some((t: any) => (c.now.test(t.title) || t.events.some((e: string) => /^changed/.test(e) && c.now.test(e))) && !['done', 'dropped'].includes(t.stage));
        const spoken = words.filter((w) => c.old(w.text)).map((w) => `${w.when} ${w.what}: ${w.text}`);
        const briefs = report.views.filter((v: any) => c.old(inMotion(v))).map((v: any) => `${v.name} brief lists the old routine`);
        g[c.name] = { pass: knows && !spoken.length && !briefs.length, why: [...(knows ? [] : ['the new routine unknown']), ...spoken, ...briefs].join('; ') || 'the new routine known; the old one never spoken of as current' };
    }
    // T3 stays quiet about what ended: no line or question about it; not in the brief.
    {
        const c = L.end;
        const spoken = say(c.re, c.ok).map((w) => `${w.when} ${w.what}: ${w.text}`);
        const briefs = report.views.filter((v: any) => c.brief.test(inMotion(v))).map((v: any) => `${v.name} brief lists it`);
        g[c.name] = { pass: !spoken.length && !briefs.length, why: [...spoken, ...briefs].join('; ') || 'never spoken of; not in the brief' };
    }
    // T4 asks well: no question about D0's session after D0; from next week only in the new routine's hours.
    {
        const c = L.timing;
        const steps = report.steps.flatMap((s: any) => s.questions.map((q: any) => ({ ...q, step: s.name })));
        const asked = steps.filter((q: any) => c.re.test(q.text));
        const old = asked.filter((q: any) => c.old.test(q.text));
        const nextWeek = dayPlus(4);
        const wrong = asked.filter((q: any) => q.fromDay >= nextWeek && c.wrongFromNextWeek(q));
        const lines = words.filter((w) => c.re.test(w.text) && w.what.startsWith('line') && c.lineWrong.test(w.text) && w.when >= 'D4');
        g[c.name] = { pass: !old.length && !wrong.length && !lines.length, why: [...old.map((q: any) => `about D0: ${q.text}`), ...wrong.map((q: any) => `the old hours from next week (${q.from}): ${q.text}`), ...lines.map((w) => `${w.when} ${w.what}: ${w.text}`)].join('; ') || `${asked.length} question(s) on it, none about D0, none in the old hours from next week` };
    }
    // T5 once is once: the slip never worded as a habit; at most one question on it in all.
    {
        const c = L.slip;
        const habit = active(last).filter((m: any) => c.habit(m)).map((m: any) => `kept as a habit: ${m.text}`);
        const spoken = say(c.re).filter((w) => /(habit|every day|usually|always|routine|most days)/i.test(w.text)).map((w) => `${w.when} ${w.what}: ${w.text}`);
        const qs = report.steps.flatMap((s: any) => s.questions).filter((q: any) => c.ask.test(q.text));
        g[c.name] = { pass: !habit.length && !spoken.length && qs.length <= 1, why: [...habit, ...spoken, ...(qs.length > 1 ? [`${qs.length} questions on it`] : [])].join('; ') || `never a habit; ${qs.length} question(s) on it` };
    }
    // T6 an interest is not a task: no task, no reminder, at most one light mention.
    {
        const c = L.interest;
        const things = [...last.record.todos, ...last.record.reminders].filter((t: string) => c.re.test(t));
        const mentions = say(c.re);
        g[c.name] = { pass: !things.length && mentions.length <= 1, why: [...things.map((t: string) => `made: ${t}`), ...(mentions.length > 1 ? [`${mentions.length} mentions: ${mentions.map((w) => `${w.when} ${w.what}: ${w.text}`).join(' / ')}`] : [])].join('; ') || `no task or reminder; ${mentions.length} mention(s)` };
    }
    // T7 the quiet day: D4 repeats no question of D2; no lines at all is a pass.
    {
        const norm = (t: string) => new Set(t.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
        const near = (a: string, b: string) => {
            const x = norm(a);
            const y = norm(b);
            const shared = [...x].filter((w) => y.has(w)).length;
            return shared / Math.max(1, Math.min(x.size, y.size)) >= 0.6;
        };
        const d2 = report.steps.filter((s: any) => s.name.startsWith('D2')).flatMap((s: any) => [...s.questions.map((q: any) => q.text), ...s.runs.flatMap((r: any) => r.lines.map((l: any) => l.text))]);
        const d4 = report.steps.filter((s: any) => s.name.startsWith('D4')).flatMap((s: any) => [...s.questions.map((q: any) => q.text), ...s.runs.flatMap((r: any) => r.lines.map((l: any) => l.text))]);
        const repeats = d4.filter((t: string) => d2.some((u: string) => near(t, u)));
        g['T7 the quiet day repeats nothing'] = { pass: !repeats.length, why: repeats.map((t: string) => `repeated: ${t}`).join('; ') || `D4: ${d4.length} line(s) or question(s), none a repeat of D2` };
    }
    // T8 work stays out: none of the work chats' words in any word of the buddy, its memories or threads.
    {
        const work = L.work;
        const hits = [...buddy.filter((t) => work.test(t)), ...last.record.memories.filter((m: any) => work.test(m.text)).map((m: any) => `memory: ${m.text}`), ...last.record.threads.filter((t: any) => work.test(t.title)).map((t: any) => `thread: ${t.title}`)];
        g['T8 work stays out'] = { pass: !hits.length, why: hits.join('; ') || 'no work word anywhere' };
    }
    report.grade = g;
}

// ─── The report ─────────────────────────────────────────────────────────────────────────────────────────────

const quote = (t: string) => `> ${String(t ?? '').replace(/\n/g, '\n> ')}`;
function markdown(): string {
    const out: string[] = [];
    out.push(`# ${ROUND} · ${LABEL} · run ${RUN}`);
    out.push(`D0 ${D0} (the live calls' day); the AI off until D1 18:00; nights on D2, D4 and D8; D8's due steps at 12:00 and 19:00. Cost $${report.costUsd.toFixed(4)}.`);
    if (report.notes.length) out.push(`\n**Notes:** ${report.notes.join(' · ')}`);
    out.push('\n## Grade');
    for (const [k, v] of Object.entries(report.grade) as Array<[string, any]>) out.push(`- ${v.pass ? 'PASS' : 'FAIL'} ${k}: ${v.why}`);
    out.push('\n## The replay (the round\'s recorded calls, through POST /mcp)');
    for (const r of report.replay) out.push(`- ${r.at} **${r.tool}** ${JSON.stringify(r.args)}\n  - now: ${r.answer.split('\n')[0]}\n  - live: ${r.live}`);
    for (const v of report.views) {
        out.push(`\n## ${v.name} (${v.at})`);
        out.push('**The brief (get_brief):**');
        out.push(quote(v.brief));
        for (const [q, a] of Object.entries(v.lookups)) out.push(`**recall_memory "${q}":**\n${quote(String(a))}`);
        out.push(`**Open questions:** ${v.questions.length ? v.questions.map((q: any) => `"${q.text}" (${q.from} to ${q.until}${q.thread ? `, on "${q.thread}"` : ''})`).join('; ') : 'none'}`);
        out.push(`**The record:** ${v.record.waiting} note(s) waiting for the AI`);
        for (const m of v.record.memories) out.push(`- memory ${m.status}${m.check ? ' (to check)' : ''} · ${m.kind}${m.private ? ' · private' : ''}${m.byUser ? ' · their own' : ''}: ${m.text}${m.closeReason ? ` [${m.closeReason}]` : ''}`);
        for (const t of v.record.threads) out.push(`- thread ${t.stage}: ${t.title}${t.events.length ? ` (${t.events.join(' | ')})` : ''}`);
        if (v.record.todos.length || v.record.reminders.length) out.push(`- tasks: ${v.record.todos.join('; ') || 'none'} · reminders: ${v.record.reminders.join('; ') || 'none'}`);
    }
    out.push('\n## What the buddy said and asked');
    for (const s of report.steps) {
        out.push(`\n### ${s.name} (${s.at})`);
        for (const h of s.held ?? []) out.push(`- read and kept: ${h}`);
        if (!s.runs.length && !s.questions.length) out.push('- no night or pulse ran; no question written');
        for (const r of s.runs) {
            out.push(`- ${r.kind}${r.onEvent ? ' (on an event)' : ''} · ${r.model} · $${r.costUsd.toFixed(4)}`);
            for (const l of r.lines) out.push(`  - line ${l.from}-${l.until}${l.lockOk ? '' : ' (not for the lock screen)'}: ${l.text}`);
            if (r.insight) out.push(`  - home thought: ${r.insight}`);
            if (r.note) out.push(`  - note: ${r.note}`);
            if (r.followUp) out.push(`  - follow-up for the next chat: ${r.followUp}`);
            if (Array.isArray(r.ops) && r.ops.length) out.push(`  - memory ops: ${JSON.stringify(r.ops).slice(0, 700)}`);
            if (!r.lines.length && !r.insight && !r.note) out.push('  - (silent)');
        }
        for (const q of s.questions) out.push(`- QUESTION ${q.from} to ${q.until}${q.thread ? ` on "${q.thread}"` : ''}: ${q.text}`);
    }
    return out.join('\n');
}

async function main(): Promise<void> {
    // --regrade: the labels again on a kept run (no database, no model).
    if (args.includes('--regrade')) {
        report = JSON.parse(fs.readFileSync(path.join(OUT, 'report.json'), 'utf8'));
        grade();
        fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
        fs.writeFileSync(path.join(OUT, 'report.md'), markdown());
        for (const [k, v] of Object.entries(report.grade) as Array<[string, any]>) console.log(`  ${v.pass ? 'PASS' : 'FAIL'} ${k}: ${v.why.slice(0, 300)}`);
        return;
    }
    fs.mkdirSync(OUT, { recursive: true });
    if (fs.existsSync(path.join(OUT, 'replay-trace.jsonl'))) fs.unlinkSync(path.join(OUT, 'replay-trace.jsonl'));
    await boot();
    await setupPerson();
    console.log(`${ROUND} ${LABEL} #${RUN}: ${calls.length} recorded calls from ${calls[0]!.at} (${calls[0]!.app}); D0 ${D0}`);
    await replay();
    // D1 09:00, still no credits: what the assistant would see, and what a look-up finds.
    setClock(at(1, '09:00'));
    await view('D1 09:00', L.lookups);
    // --dry: the replay and the zero-credit view only (no model is called).
    let ok = !args.includes('--dry');
    if (ok) {
        // D1 18:00: the AI is back (the account allowed again): the catch-up and the queue.
        setClock(at(1, '18:00'));
        process.env.AI_ALLOWED_EMAILS = email;
        const since = new Date(simNow() - 1);
        await drainAll();
        await stepsSince(since, 'D1 18:00 (the AI back)');
        ok = await guard('D1');
    }
    if (ok) {
        await night(2);
        setClock(at(2, '09:00'));
        await view('D2 09:00');
        ok = await guard('D2');
    }
    if (ok) {
        await night(4);
        setClock(at(4, '09:00'));
        await view('D4 09:00');
        ok = await guard('D4');
    }
    if (ok) {
        await night(8);
        setClock(at(8, '09:00'));
        await view('D8 09:00');
        await dueSteps(8, '12:00');
        if (await guard('D8 12:00')) await dueSteps(8, '19:00');
        setClock(at(8, '19:30'));
        await view('D8 19:30');
    }
    report.costUsd = await spent();
    grade();
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(OUT, 'report.md'), markdown());
    const passed = Object.values(report.grade).filter((x: any) => x.pass).length;
    console.log(`${ROUND} ${LABEL} #${RUN}: ${passed}/${Object.keys(report.grade).length} labels pass; $${report.costUsd.toFixed(4)}; ${path.join(OUT, 'report.md')}`);
    for (const [k, v] of Object.entries(report.grade) as Array<[string, any]>) console.log(`  ${v.pass ? 'PASS' : 'FAIL'} ${k}: ${v.why.slice(0, 220)}`);
    C.server.close();
    await C.prisma.$disconnect();
}

main()
    .then(() => process.exit(0))
    .catch(async (err) => {
        console.error(err instanceof Error ? err.stack : err);
        try {
            report.costUsd = userId ? await spent() : 0;
            fs.writeFileSync(path.join(OUT, 'report-failed.json'), JSON.stringify(report, null, 2));
        } catch {
            /* the report is best effort */
        }
        process.exit(1);
    });
