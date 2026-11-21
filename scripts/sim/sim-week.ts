// The week's simulation (SIMULATION_PLAN v2.1 §3-§7): an invented person's week through every surface and the
// real models, run in one day on a moved clock, in a database of its own. The clock is installed before any app
// code is loaded; a virtual worker runs the production job table (src/services/scheduler/jobs.ts) at the
// moments it asks for; the person's words arrive through the real routes of an API served in this process.
// Each buddy day (04:00 to 04:00) writes a transcript, the model calls, the timeline of what each surface showed,
// its cost and a database snapshot (a later run can start from it).
//
//   node node_modules/ts-node/dist/bin.js --transpile-only scripts/sim/sim-week.ts --out <dir> [--fake] [--person kabir]
//        [--until 11-25] [--from <snapshot.dump> --from-at <iso>] [--budget 15]
//   (PowerShell, from backend/; --fake answers every model call with a minimal valid answer: free, for the harness)
/* eslint-disable @typescript-eslint/no-explicit-any */
import { installClock, realNow, setClock, simNow } from './clock';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { Ev, Msg, Person } from './types';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};
const FAKE = flag('fake');
const OUT = path.resolve(opt('out') ?? `../scratchpad-sim/week-${FAKE ? 'fake' : 'real'}`);
const BUDGET = Number(opt('budget') ?? 15);
const PERSON_KEY = opt('person') ?? 'kabir';
const DB_NAME = opt('db') ?? `recollect_test_sim${PERSON_KEY}`;

// The person's times are "MM-DD HH:mm" in their own zone (+05:30 for both people of this run).
const OFFSET = '+05:30';
const when = (s: string) => (s.includes('T') ? new Date(s) : new Date(`2026-${s.slice(0, 5)}T${s.slice(6)}:00${OFFSET}`));
const local = (d: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const hhmm = (d: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const dayOfLocal = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
/** The buddy's day: 04:00 to 04:00 his time. */
const buddyDay = (d: Date, tz: string) => dayOfLocal(new Date(d.getTime() - 4 * 3600_000), tz);

const person: Person = PERSON_KEY === 'kabir' ? require('./kabir').kabir : require(`./${PERSON_KEY}`)[PERSON_KEY];
const TZ = person.tz;
installClock(when(opt('from-at') ?? person.start));
// The API's request log (morgan, dev) is noise here: dropped from stdout.
const stdoutWrite = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = (chunk: any, ...rest: any[]) => (/^\[0m(GET|POST|PUT|PATCH|DELETE) /.test(String(chunk)) ? true : stdoutWrite(chunk, ...rest));

// ─── Model calls: recorded (real) or answered minimally (fake) ─────────────────────────────────────────────

interface CallRec {
    at: string;
    layer: string;
    model: string;
    ms: number;
    request: string;
    answer: string;
    usage: Record<string, number>;
    error?: string;
}
let calls: CallRec[] = [];

/** Which layer a request belongs to: by its schema's fields and its system text. */
function layerOf(p: any): string {
    if (p.tools?.length) return p.model?.includes('haiku') ? 'persona' : 'chat';
    const schema = p.output_config?.format?.schema;
    const keys = Object.keys(schema?.properties ?? {}).sort().join(',');
    const sys = (Array.isArray(p.system) ? p.system.map((s: any) => s.text).join(' ') : String(p.system ?? '')).slice(0, 400);
    if (keys === 'labels') return /work/i.test(sys) && /log/i.test(sys) ? 'gate(work)' : 'gate';
    if (/lock screen|lock-screen/i.test(sys) && /reveal/i.test(JSON.stringify(schema ?? {}))) return 'lock-check';
    if (keys.includes('lines') && /pulse|so far today|midday|evening/i.test(sys)) return 'pulse';
    if (keys.includes('lines')) return 'night';
    if (keys.includes('chapter')) return 'chapter';
    if (/work log/i.test(sys)) return 'work-log';
    if (keys.includes('questions') && /recall|question/i.test(sys)) return 'recall-questions';
    if (keys.includes('grade')) return 'recall-grade';
    if (keys.includes('markdown') && keys.includes('title')) return 'practice-note';
    if (keys.includes('strong') || keys.includes('slipping')) return 'coach';
    if (keys.includes('dueDate') || keys.includes('priority')) return 'task-line';
    if (keys.includes('notes') || keys.includes('events')) return 'digest';
    return `other(${keys.slice(0, 60)})`;
}
const textOf = (m: any) => (m?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
const requestText = (p: any) => {
    const sys = Array.isArray(p.system) ? p.system.map((s: any) => s.text).join('\n') : String(p.system ?? '');
    const msgs = (p.messages ?? []).map((m: any) => `[${m.role}] ${typeof m.content === 'string' ? m.content : (m.content ?? []).map((c: any) => c.text ?? (c.type === 'tool_result' ? `(tool result) ${JSON.stringify(c.content).slice(0, 600)}` : c.type === 'tool_use' ? `(tool ${c.name}) ${JSON.stringify(c.input)}` : `(${c.type})`)).join('\n')}`).join('\n');
    return `${sys.slice(0, 1200)}\n---\n${msgs}`;
};

function recorder(inner: any): any {
    const wrap = async (p: any, fn: () => Promise<any>) => {
        const t0 = realNow();
        try {
            const r = await fn();
            calls.push({ at: new Date(simNow()).toISOString(), layer: layerOf(p), model: r?.model ?? p.model, ms: realNow() - t0, request: requestText(p), answer: textOf(r) || JSON.stringify((r?.content ?? []).filter((c: any) => c.type === 'tool_use').map((c: any) => ({ tool: c.name, input: c.input }))), usage: r?.usage ?? {} });
            return r;
        } catch (err) {
            calls.push({ at: new Date(simNow()).toISOString(), layer: layerOf(p), model: p.model, ms: realNow() - t0, request: requestText(p), answer: '', usage: {}, error: err instanceof Error ? err.message : String(err) });
            throw err;
        }
    };
    return {
        createMessage: (p: any) => wrap(p, () => inner.createMessage(p)),
        ...(inner.streamMessage ? { streamMessage: (p: any, o: any) => wrap(p, () => inner.streamMessage(p, o)) } : {}),
        createBatch: (r: any) => inner.createBatch(r),
        retrieveBatch: (id: string) => inner.retrieveBatch(id),
        batchResults: (id: string) => inner.batchResults(id),
        cancelBatch: (id: string) => inner.cancelBatch(id),
    };
}

/** The smallest answer a JSON schema accepts (the free pass: the harness, not the models). */
function minimal(schema: any): any {
    if (!schema || typeof schema !== 'object') return null;
    if (schema.enum) return schema.enum[0];
    if (schema.anyOf) return minimal(schema.anyOf[0]);
    const type = Array.isArray(schema.type) ? (schema.type.includes('null') ? 'null' : schema.type[0]) : schema.type;
    if (type === 'null') return null;
    if (type === 'object') return Object.fromEntries((schema.required ?? []).map((k: string) => [k, minimal(schema.properties?.[k])]));
    if (type === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => minimal(schema.items));
    if (type === 'string') return 'x'.repeat(schema.minLength ?? 0);
    if (type === 'integer' || type === 'number') return schema.minimum ?? 0;
    if (type === 'boolean') return false;
    return null;
}
function fakeClient(): any {
    let n = 0;
    const message = (p: any) => {
        n++;
        const schema = p.output_config?.format?.schema;
        const text = schema ? JSON.stringify(minimal(schema)) : '(the scripted pass: no model was called)';
        return { id: `msg_sim_${n}`, type: 'message', role: 'assistant', model: p.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    };
    return recorder({ createMessage: async (p: any) => message(p), streamMessage: async (p: any) => message(p), createBatch: async () => ({}), retrieveBatch: async () => ({}), batchResults: async () => [], cancelBatch: async () => ({}) });
}

// ─── Boot: its own database, the API in this process, the identities ───────────────────────────────────────

let C: any = {};
async function boot(fresh: boolean) {
    require('dotenv/config');
    process.env.TEST_DB_NAME = DB_NAME;
    process.env.BUDDY_WORKER = 'off';
    process.env.EMAIL_DELIVERY = 'off';
    process.env.SCHEDULER_MODE = 'poll';
    process.env.AI_ALLOWED_EMAILS = [process.env.AI_ALLOWED_EMAILS, person.email].filter(Boolean).join(',');
    if (FAKE) process.env.ASSISTANT_FAKE = 'all';
    const { ensureTestDatabase, getTestDatabaseUrl, migrateTestDatabase } = await import('../../tests/helpers/testDb');
    const url = getTestDatabaseUrl();
    if (fresh || opt('from')) await adminQuery(url, `DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await ensureTestDatabase(url);
    if (opt('from')) {
        execFileSync(pgBin('pg_restore'), ['--no-owner', '-d', url, opt('from')!], { stdio: 'inherit' });
    } else migrateTestDatabase(url);
    process.env.DATABASE_URL = url;
    C.url = url;
    C.prisma = (await import('../../src/db/prisma')).prisma;
    C.app = (await import('../../src/app')).default;
    C.users = await import('../../src/services/users/users.service');
    C.state = await import('../../src/services/buddy/state.service');
    C.tokens = await import('../../src/services/apiTokens/apiTokens.service');
    C.jobs = await import('../../src/services/scheduler/jobs');
    C.client = await import('../../src/services/claude/client');
    C.pricing = await import('../../src/services/claude/pricing');
    C.recall = await import('../../src/services/recall/recall.service');
    C.practice = await import('../../src/services/practice/practice.service');
    C.taskAi = await import('../../src/services/tasks/taskAi.service');
    C.coach = await import('../../src/services/coach/coach.service');
    C.asks = await import('../../src/services/buddy/asks');
    C.voice = await import('../../src/services/buddy/voice');
    C.worker = await import('../../src/services/buddy/worker');
    C.jwt = (await import('jsonwebtoken')).default;
    // It must run what production runs (§2): no model override from the environment.
    const overrides = Object.keys(process.env).filter((k) => /^(BUDDY_[A-Z]+_MODEL|RECALL_MODEL|ASSISTANT_MODEL|CHECK_MODEL)$/.test(k));
    if (overrides.length) throw new Error(`model overrides set (${overrides.join(', ')}): the simulation runs production's models only`);
    const digest = await import('../../src/services/buddy/digest');
    const pulse = await import('../../src/services/buddy/pulse');
    const workMod = await import('../../src/services/buddy/work');
    console.log(`models: gate ${digest.GATE_MODEL}, digest ${digest.DIGEST_MODEL}, pulse ${pulse.PULSE_MODEL}, work ${workMod.WORK_MODEL}, default ${C.client.aiModel()}${FAKE ? ' (all scripted: --fake)' : ''}`);
    const real = FAKE ? null : C.client.getAiClient();
    C.client.setAiClientForTests(FAKE ? fakeClient() : recorder(real));
    C.real = real;
    await new Promise<void>((resolve) => {
        C.server = C.app.listen(0, () => resolve());
    });
    C.port = C.server.address().port;
    process.env.PORT = String(C.port);
    C.base = `http://localhost:${C.port}`;
}

function pgBin(name: string): string {
    const candidates = [`C:\\Program Files\\pgAdmin 4\\runtime\\${name}.exe`];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) throw new Error(`${name} not found`);
    return found;
}
async function adminQuery(url: string, sql: string) {
    const { Client } = await import('pg');
    const admin = new URL(url);
    admin.pathname = '/postgres';
    const c = new Client({ connectionString: admin.toString() });
    await c.connect();
    try {
        await c.query(sql);
    } finally {
        await c.end();
    }
}

interface Who {
    userId: string;
    cookie: string;
    cc: string; // Claude Code: the hooks and the agent
    phone: string; // the phone app
    connector: string; // claude.ai, through the connector
}
let W: Who;

async function setupPerson(): Promise<Who> {
    const u = await C.users.createUser({ email: person.email, name: person.name, password: 'not-a-real-login-1' });
    await C.state.updateBuddySettings(u.id, { enabled: true, loop: true, name: person.buddyName, tone: person.tone });
    const mk = async (name: string, scopes: string[]) => (await C.tokens.createApiToken(u.id, { name, scopes })).token;
    const who: Who = {
        userId: u.id,
        cookie: '',
        cc: await mk('Claude Code', ['read', 'sessions:write', 'docs:write', 'learning:write', 'tasks:write']),
        phone: await mk('Phone app', ['read', 'ambient']),
        connector: await mk('claude.ai', ['read', 'sessions:write', 'tasks:write']),
    };
    fs.writeFileSync(path.join(OUT, 'who.json'), JSON.stringify({ userId: who.userId, email: person.email }, null, 2));
    return who;
}
async function identities(): Promise<Who> {
    const u = await C.prisma.user.findUnique({ where: { email: person.email } });
    const mk = async (name: string, scopes: string[]) => (await C.tokens.createApiToken(u.id, { name: `${name} (${Date.now()})`, scopes })).token;
    return { userId: u.id, cookie: '', cc: await mk('Claude Code', ['read', 'sessions:write', 'docs:write', 'learning:write', 'tasks:write']), phone: await mk('Phone app', ['read', 'ambient']), connector: await mk('claude.ai', ['read', 'sessions:write', 'tasks:write']) };
}
const cookieNow = () => `token=${C.jwt.sign({ id: W.userId }, process.env.JWT_SECRET, { expiresIn: '3d' })}`;

async function http(method: string, p: string, as: 'cookie' | 'cc' | 'phone' | 'connector', body?: unknown): Promise<{ status: number; data: any; raw: string }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (as === 'cookie') headers['Cookie'] = cookieNow();
    else headers['Authorization'] = `Bearer ${W[as]}`;
    if (as === 'cc') headers['X-Agent-Name'] = 'Claude Code';
    if (as === 'connector') headers['X-Agent-Name'] = 'claude.ai';
    const res = await fetch(`${C.base}${p}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const raw = await res.text();
    let data: any = null;
    try {
        data = JSON.parse(raw);
    } catch {
        data = null;
    }
    return { status: res.status, data: data?.data ?? data, raw };
}

let catalogues = new Map<string, any>();
async function catalogue(as: 'cc' | 'connector'): Promise<any> {
    if (catalogues.has(as)) return catalogues.get(as);
    const file = path.resolve(__dirname, '..', '..', '..', 'mcp', 'dist', 'embedded.js');
    const mod: any = await (new Function('s', 'return import(s)') as (s: string) => Promise<unknown>)(pathToFileURL(file).href);
    const cat = await mod.openCatalogue({ baseUrl: C.base, token: W[as], agentName: as === 'cc' ? 'Claude Code' : 'claude.ai' });
    catalogues.set(as, cat);
    return cat;
}

// ─── The day's record ───────────────────────────────────────────────────────────────────────────────────────

let lines: string[] = [];
let timeline: string[] = [];
const log = (s: string) => {
    lines.push(s);
    if (flag('verbose')) console.log(s);
};
const say = (at: Date, who: string, text: string) => log(`\n**${hhmm(at, TZ)} · ${who}**\n> ${text.replace(/\n/g, '\n> ')}`);

let spentAtStart = 0;
async function spent(): Promise<number> {
    const rows = await C.prisma.aiUsage.aggregate({ where: { userId: W.userId }, _sum: { costUsd: true } });
    return Number(rows._sum.costUsd ?? 0) + personaUsd;
}

/** What the buddy kept since `since` (sim time): new threads, events, notes, memories, tasks, reminders, steers. */
let seenThreadState = new Map<string, string>();
async function heldSince(since: Date): Promise<string[]> {
    const p = C.prisma;
    const where = { userId: W.userId, createdAt: { gt: since } };
    const [events, notes, memories, todos, reminders, suggestions, threads] = await Promise.all([
        p.buddyThreadEvent.findMany({ where, orderBy: { createdAt: 'asc' }, include: { thread: { select: { title: true } } } }),
        p.observation.findMany({ where, orderBy: { createdAt: 'asc' } }),
        p.memory.findMany({ where, orderBy: { createdAt: 'asc' } }),
        p.todo.findMany({ where, select: { title: true, dueDate: true } }),
        p.reminder.findMany({ where, select: { message: true, reminderDate: true, silent: true, repeat: true } }),
        p.suggestion.findMany({ where, select: { kind: true, text: true, status: true } }),
        p.buddyThread.findMany({ where: { userId: W.userId } }),
    ]);
    const out: string[] = [];
    for (const e of events) out.push(`thread "${e.thread.title}" ← ${e.kind}${e.duplicate ? ' (duplicate)' : ''}${e.direct ? '' : ' (indirect)'} via ${e.via}: ${e.text}`);
    for (const n of notes) out.push(`note (${n.kind}${n.sensitivity === 'private' ? ', private' : ''}, ${n.source}${n.via ? `/${n.via}` : ''}): ${n.text}`);
    for (const m of memories) out.push(`memory (${m.kind}${m.lasting ? ', lasting' : ''}${m.sensitivity === 'private' ? ', private' : ''}): ${m.text}`);
    for (const t of todos) out.push(`TASK: ${t.title}${t.dueDate ? ` (due ${t.dueDate.toISOString().slice(0, 10)})` : ''}`);
    for (const r of reminders) out.push(`REMINDER ${r.silent ? 'silent' : 'rings'}${r.repeat ? ` ${r.repeat}` : ''} at ${local(r.reminderDate, TZ)}: ${r.message}`);
    for (const s of suggestions) out.push(`suggestion (${s.kind}, ${s.status}): ${s.text}`);
    for (const t of threads) {
        const sig = `${t.title}|${t.stage}|${t.rhythm}|${t.sensitive}|${t.onScreens}|${t.noAsk}|${t.steer}|${t.quietUntil?.toISOString() ?? ''}|${t.lookAgainOn?.toISOString().slice(0, 10) ?? ''}|${t.closedAt ? 'closed' : ''}`;
        if (seenThreadState.get(t.id) !== sig) {
            out.push(`thread now: "${t.title}" · ${t.stage}${t.rhythm !== 'none' ? ` · ${t.rhythm}` : ''}${t.lookAgainOn ? ` · day ${t.lookAgainOn.toISOString().slice(0, 10)}` : ''}${t.sensitive ? ' · private' : ''}${t.onScreens ? '' : ' · off screens'}${t.noAsk ? " · don't ask" : ''}${t.steer ? ` · steer ${t.steer}` : ''}${t.quietUntil ? ` · quiet until ${t.quietUntil.toISOString().slice(0, 10)}` : ''}${t.closedAt ? ' · closed' : ''}`);
            seenThreadState.set(t.id, sig);
        }
    }
    return out;
}

/** The night's or a pulse's words, written since `since`. */
async function stepsSince(since: Date): Promise<void> {
    const days = await C.prisma.buddyDay.findMany({ where: { userId: W.userId, createdAt: { gt: since } }, orderBy: { createdAt: 'asc' } });
    for (const d of days) {
        log(`\n#### ${hhmm(d.createdAt, TZ)} · the buddy's ${d.kind}${d.onEvent ? ' (on an event)' : ''} · ${d.model} · $${Number(d.costUsd).toFixed(4)}`);
        for (const l of (d.lines as any[]) ?? []) log(`- line ${l.from ? `${l.from}-${l.until}` : l.slot}${l.lockOk === false ? ' (not for the lock screen)' : ''}: ${l.text}`);
        if (d.insight) log(`- home thought${d.insightLockOk ? '' : ' (not for the lock screen)'}: ${d.insight}`);
        if (d.note) log(`- note: ${d.note}${d.followUp ? ` · follow-up: ${d.followUp}` : ''}`);
        for (const x of (d.dropped as any[]) ?? []) log(`- dropped by code: ${x.what ?? ''}: ${x.why ?? JSON.stringify(x)}`);
        const ops = (d.ops as any[]) ?? [];
        if (ops.length) log(`- memory ops: ${ops.map((o: any) => `${o.op ?? o.kind ?? '?'} ${o.text ?? o.id ?? ''}`.trim()).join(' | ').slice(0, 600)}`);
    }
    const asks = await C.prisma.buddyAsk.findMany({ where: { userId: W.userId, createdAt: { gt: since } }, orderBy: { fromAt: 'asc' }, include: { thread: { select: { title: true } } } });
    for (const a of asks) log(`- QUESTION (${a.kind}, ${hhmm(a.fromAt, TZ)}-${hhmm(a.untilAt, TZ)}${a.lockOk ? ', lock screen ok' : ''}) about "${a.thread?.title ?? '-'}": ${a.text} [${(a.answers as any[]).map((x) => `${x.label}=${x.meaning}`).join(', ')}]`);
    const rems = await C.prisma.buddyReminder.findMany({ where: { userId: W.userId, createdAt: { gt: since } } });
    for (const r of rems) log(`- ITS OWN REMINDER at ${local(r.at, TZ)}: ${r.text}`);
}

// ─── The virtual worker ─────────────────────────────────────────────────────────────────────────────────────

// Production's own quiet scheduler (src/services/scheduler/scheduler.ts) on a clock this script moves: its timers,
// the services' pokes (words queued, a thumb, an answer), its backoff and its sweep, exactly as in production. The
// jobs are production's table, each wrapped only to write what it did into the day's transcript.
const SKIP_JOBS = new Set(['recallPoll', 'recallNightly', 'aiProbe', 'nudge']);
let scheduler: any = null;
const timers = new Map<number, { at: number; fn: () => void }>();
let timerId = 0;
const vclock = {
    now: () => simNow(),
    setTimeout: (fn: () => void, ms: number) => {
        const id = ++timerId;
        timers.set(id, { at: simNow() + Math.max(0, ms), fn });
        return id;
    },
    clearTimeout: (h: unknown) => {
        timers.delete(h as number);
    },
};
const nextTimer = () => Math.min(Infinity, ...[...timers.values()].map((t) => t.at));

/** Fires every timer due by now (in order), and waits for the passes they start. */
async function fireDue(): Promise<void> {
    for (let guard = 0; guard < 200; guard++) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= simNow()).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        for (const [id, t] of due) {
            timers.delete(id);
            t.fn();
        }
        await scheduler.idle();
    }
}

/** Moves the clock to `t`, firing each timer at its own moment on the way. */
async function advanceTo(t: number): Promise<void> {
    for (let next = nextTimer(); next <= t; next = nextTimer()) {
        if (next > simNow()) setClock(next);
        await fireDue();
    }
    if (t > simNow()) setClock(t);
    await fireDue();
}

function wrapJob(job: any): any {
    return {
        ...job,
        run: async (now: Date) => {
            const before = new Date(simNow() - 1);
            const out = await job.run(now);
            if (job.name === 'capture') {
                const held = await heldSince(before);
                if (held.length) log(`\n_${hhmm(new Date(simNow()), TZ)} · the buddy read it:_\n${held.map((h) => `- ${h}`).join('\n')}`);
            }
            if (job.name === 'buddy') await stepsSince(before);
            return out;
        },
    };
}

async function startScheduler(): Promise<void> {
    const { Scheduler, setActiveScheduler } = await import('../../src/services/scheduler/scheduler');
    const jobs = C.jobs.quietJobs({ ...process.env, BUDDY_WORKER: 'on' }).filter((j: any) => !SKIP_JOBS.has(j.name)).map(wrapJob);
    scheduler = new Scheduler(jobs, { sweepMinutes: 180, housekeeping: async () => {}, clock: vclock, log: (line: string) => log(`- (${line})`) });
    setActiveScheduler(scheduler);
    await scheduler.start();
}
const runDueJobs = () => fireDue();

// ─── The surfaces ───────────────────────────────────────────────────────────────────────────────────────────

let lastPhone = '';
let phoneNow: any = null;
const quietNow = (d: Date) => {
    const t = hhmm(d, TZ);
    const [from, to] = person.quiet;
    return from > to ? t >= from || t < to : t >= from && t < to;
};
async function phoneRefresh(): Promise<void> {
    const at = new Date(simNow());
    const r = await http('GET', `/api/ambient/widget?app=0.6.0${quietNow(at) ? '&quiet=1' : ''}`, 'phone');
    if (r.status !== 200) {
        timeline.push(`${hhmm(at, TZ)} phone: HTTP ${r.status} ${r.raw.slice(0, 160)}`);
        return;
    }
    phoneNow = r.data;
    const d = r.data ?? {};
    const parts: string[] = [];
    if (d.line?.text) parts.push(`lock line "${d.line.text}"${d.line.until ? ` until ${hhmm(new Date(d.line.until), TZ)}` : ''}`);
    for (const q of d.questions ?? d.asks ?? []) parts.push(`question "${q.text}"${q.lockOk ? ' (on the lock screen)' : ''}`);
    if (d.insight?.text ?? d.insight) parts.push(`home thought "${d.insight?.text ?? d.insight}"`);
    for (const p of d.pins ?? []) parts.push(`pin "${p.text ?? p}"`);
    const sig = parts.join(' · ') || '(no words)';
    if (sig !== lastPhone) {
        timeline.push(`${hhmm(at, TZ)}${quietNow(at) ? ' (quiet hours)' : ''} phone: ${sig}`);
        lastPhone = sig;
    }
}

async function briefFor(project: string, key: string): Promise<void> {
    const at = new Date(simNow());
    const r = await http('GET', `/api/brief?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}`, 'cc');
    const d = r.data ?? {};
    const parts: string[] = [];
    for (const q of d.asks ?? d.questions ?? []) parts.push(`question "${q.text}"`);
    if (d.onMind?.length) parts.push(`on his mind: ${d.onMind.map((x: any) => x.title ?? x).join('; ')}`);
    if (d.buddy?.note ?? d.note) parts.push(`note "${d.buddy?.note ?? d.note}"`);
    timeline.push(`${hhmm(at, TZ)} agent's brief (${project}): ${parts.join(' · ') || '(nothing from the buddy)'}`);
}

async function homeVisit(): Promise<void> {
    const at = new Date(simNow());
    const asks = await C.asks.openAsks(W.userId, 'web', at);
    const line = await C.voice.currentLine(W.userId, at);
    const thought = await C.voice.currentInsight(W.userId, at);
    const rem = await http('GET', '/api/reminders/today', 'cookie');
    const items = (rem.data?.items ?? []).map((x: any) => `${x.time} ${x.text} (${x.ring ? 'rings' : 'silent'}, ${x.by})`);
    timeline.push(`${hhmm(at, TZ)} Home (web): ${[...asks.map((a: any) => `question "${a.text}"`), line ? `line "${line.text}"` : '', thought ? `thought "${thought.text}"` : '', items.length ? `reminders: ${items.join('; ')}` : ''].filter(Boolean).join(' · ') || '(nothing from the buddy)'}`);
}

async function pictures(tag: string): Promise<void> {
    const dir = path.join(OUT, 'pictures');
    fs.mkdirSync(dir, { recursive: true });
    for (const screen of ['lock', 'home']) {
        const res = await fetch(`${C.base}/api/ambient/wallpaper.png?screen=${screen}&app=0.6.0`, { headers: { Authorization: `Bearer ${W.phone}` } });
        if (res.ok) fs.writeFileSync(path.join(dir, `${tag}-${screen}.png`), Buffer.from(await res.arrayBuffer()));
    }
}

// ─── The person's side ──────────────────────────────────────────────────────────────────────────────────────

let personaUsd = 0;
/** The person's next line in a chat (the persona model, §4.5): only facts from the truth calendar so far. */
async function personaReply(history: Array<{ role: string; text: string }>, at: Date): Promise<string | null> {
    if (FAKE) return null;
    // Only what has happened by now: a fact is timed "YYYY-MM-DD HH:mm" (a date alone counts from its start).
    const nowKey = `${dayOfLocal(at, TZ)} ${hhmm(at, TZ)}`;
    const facts = Object.entries(person.truth)
        .filter(([d]) => d <= nowKey)
        .map(([d, t]) => `${d}: ${t}`)
        .join('\n');
    const req = {
        model: 'claude-haiku-5-5',
        max_tokens: 400,
        system: `You play ${person.name.split(' ')[0]} in a test of a chat app. ${person.profile}\nWhat has really happened (your only facts; it is now ${local(at, TZ)}):\n${facts}\nRules: reply to what the app's buddy just said, in your own short casual style (one or two sentences, lower case). Use only the facts above; never invent new events, people or numbers. If the buddy asked you something you can answer from the facts, answer it. If nothing needs a reply, or the conversation has reached a natural end, answer exactly [end].`,
        messages: [{ role: 'user', content: history.map((h) => `${h.role === 'user' ? 'You' : 'The buddy'}: ${h.text}`).join('\n\n') + '\n\nYour next message (or [end]):' }],
    };
    const res = await C.real.createMessage(req);
    personaUsd += Number(C.pricing.costOfCall(res.usage, res.model).costUsd ?? 0);
    calls.push({ at: at.toISOString(), layer: 'persona', model: res.model, ms: 0, request: requestText(req), answer: textOf(res), usage: res.usage });
    const t = textOf(res).trim();
    return !t || /^\[end\]/i.test(t) ? null : t.replace(/^you:\s*/i, '').slice(0, 400);
}

/** One chat (Ask AI, or Home's Tell, which opens the chat with his words): his turns, the buddy's answers, the tools. */
async function chat(ev: Extract<Ev, { kind: 'chat' }>): Promise<void> {
    const at = new Date(simNow());
    if (ev.via === 'tell') await homeVisit();
    let threadId: string | undefined;
    let docId: string | undefined;
    if (ev.doc) docId = (await C.prisma.doc.findFirst({ where: { userId: W.userId, title: ev.doc }, select: { id: true } }))?.id;
    const history: Array<{ role: string; text: string }> = [];
    const turns: Array<{ text: string; scripted: boolean }> = ev.messages.map((m) => ({ text: m.text, scripted: true }));
    let personaLeft = ev.persona ?? 0;
    for (let i = 0; i < turns.length; i++) {
        const mine = turns[i]!;
        say(new Date(simNow()), `${person.name.split(' ')[0]}, ${ev.via === 'tell' ? "Home's Tell (opens the chat)" : ev.doc ? `Ask AI in the doc "${ev.doc}"` : 'Ask AI'}${mine.scripted ? '' : ' (persona)'}`, mine.text);
        const t0 = realNow();
        const res = await fetch(`${C.base}/api/assistant/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieNow() }, body: JSON.stringify({ ...(threadId ? { threadId } : {}), text: mine.text, ...(docId && !threadId ? { docId } : {}) }) });
        const raw = await res.text();
        const evs = raw.split('\n\n').map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: /^data: (.*)$/m.exec(b)?.[1] })).filter((x) => x.event && x.data);
        const thread = evs.find((x) => x.event === 'thread');
        if (thread) threadId = JSON.parse(thread.data!)._id;
        const tools = evs.filter((x) => x.event === 'tool').map((x) => JSON.parse(x.data!));
        const done = evs.find((x) => x.event === 'done');
        const text = done ? JSON.parse(done.data!).message?.text ?? '' : `(no answer: HTTP ${res.status} ${raw.slice(0, 200)})`;
        for (const t of tools) log(`- tool ${t.name}${t.ok === false ? ' (failed)' : ''}: ${JSON.stringify(t.input).slice(0, 300)}`);
        say(new Date(simNow()), `${person.buddyName} (${((realNow() - t0) / 1000).toFixed(0)} s)`, text);
        chatLog.push({ at: new Date(simNow()).toISOString(), evAt: ev.at, turn: i, mine: mine.text, scripted: mine.scripted, reply: text, tools: tools.map((t: any) => ({ name: t.name, input: t.input, ok: t.ok })) });
        history.push({ role: 'user', text: mine.text }, { role: 'assistant', text });
        await advanceTo(simNow() + 90_000);
        if (i === turns.length - 1 && personaLeft > 0) {
            const next = await personaReply(history, new Date(simNow()));
            personaLeft--;
            if (next) turns.push({ text: next, scripted: false });
        }
    }
}
const chatLog: any[] = [];

async function session(ev: Extract<Ev, { kind: 'session' }>): Promise<void> {
    const start = new Date(simNow());
    if (!ev.office) await briefFor(ev.project, ev.key);
    log(`\n_Claude Code, ${ev.project}${ev.office ? ' (a work folder: brief off)' : ''}_`);
    let n = 0;
    for (const m of ev.messages) {
        n++;
        const at = new Date(start.getTime() + (n - 1) * 4 * 60_000);
        await advanceTo(at.getTime());
        say(at, `${person.name.split(' ')[0]}, Claude Code`, m.text);
        if (m.reply) log(`  ↳ agent: ${m.reply}`);
        const prev = ev.messages[n - 2];
        const body = {
            sessionKey: ev.key,
            seq: n,
            project: ev.project,
            ...(ev.office ? { office: true } : {}),
            v: 2,
            canHold: true,
            messages: [...(prev ? [{ at: new Date(at.getTime() - 4 * 60_000).toISOString(), text: prev.text, n: n - 1, context: true, ...(prev.reply ? { reply: prev.reply.slice(0, 300) } : {}) }] : []), { at: at.toISOString(), text: m.text, n, ...(m.reply ? { reply: m.reply.slice(0, 300) } : {}) }],
        };
        const r = await http('POST', '/api/buddy/words', 'cc', body);
        if (r.status >= 300) log(`  (words: HTTP ${r.status} ${r.raw.slice(0, 200)})`);
        for (const call of ev.calls?.filter((c) => c.after === n) ?? []) {
            const cat = await catalogue('cc');
            const out = await cat.call(call.tool, call.input);
            log(`  ↳ agent calls ${call.tool}: ${out.isError ? 'ERROR ' : ''}${String(out.text).slice(0, 200)}`);
        }
        await runDueJobs();
    }
    const end = new Date(start.getTime() + n * 4 * 60_000);
    await advanceTo(end.getTime());
    await http('PUT', `/api/sessions/by-key/${encodeURIComponent(ev.key)}`, 'cc', { kind: ev.project === 'dsa' ? 'practice' : 'build', project: ev.project, startedAt: start.toISOString(), endedAt: end.toISOString(), minutes: n * 4, source: 'hook' });
}

/** His phone in his hand: the questions it shows (from the last refresh), his answers, a thumb. */
async function phoneCheck(ev: Extract<Ev, { kind: 'phone' }>): Promise<void> {
    await phoneRefresh();
    const at = new Date(simNow());
    const qs: any[] = phoneNow?.questions ?? phoneNow?.asks ?? [];
    if (!qs.length && !ev.thumb) return;
    for (const q of qs) {
        const row = await C.prisma.buddyAsk.findUnique({ where: { id: q._id ?? q.id }, include: { thread: { select: { title: true } } } });
        const answers = (row?.answers as any[]) ?? q.answers ?? [];
        const a = ev.answer ? person.answer({ thread: row?.thread?.title ?? null, text: q.text, answers, at }) : null;
        if (!a) {
            log(`\n_${hhmm(at, TZ)} · his phone shows "${q.text}": he leaves it_`);
            continue;
        }
        const body = 'meaning' in a ? { choice: answers.findIndex((x: any) => x.meaning === a.meaning) } : { text: a.text };
        const r = await http('POST', `/api/buddy/asks/${q._id ?? q.id}/answer`, 'phone', body);
        log(`\n**${hhmm(at, TZ)} · ${person.name.split(' ')[0]} answers on his phone** "${q.text}" → ${'meaning' in a ? answers[(body as any).choice]?.label ?? a.meaning : `"${a.text}"`}${r.status >= 300 ? ` (HTTP ${r.status} ${r.raw.slice(0, 120)})` : ''}`);
        answersLog.push({ at: at.toISOString(), ask: q.text, thread: row?.thread?.title ?? null, answer: a });
    }
    if (ev.thumb) {
        const line = phoneNow?.line;
        if (!line?.text || line.askId || line.pinId) {
            log(`\n_${hhmm(at, TZ)} · he meant to give a thumb (${ev.thumb.verdict}) but no line shows_`);
        } else {
            const dayRow = await C.prisma.buddyDay.findFirst({ where: { userId: W.userId }, orderBy: { createdAt: 'desc' } });
            const r = await http('POST', '/api/buddy/feedback', 'phone', { buddyDayId: line.dayId ?? dayRow?.id, target: line.key ?? line.slot, verdict: ev.thumb.verdict });
            log(`\n**${hhmm(at, TZ)} · thumb ${ev.thumb.verdict === 'more' ? 'up' : 'down'}** on "${line.text}"${r.status >= 300 ? ` (HTTP ${r.status} ${r.raw.slice(0, 160)})` : ''}`);
            thumbsLog.push({ at: at.toISOString(), verdict: ev.thumb.verdict, line: line.text, key: line.key ?? line.slot });
        }
    }
    await runDueJobs();
}
const answersLog: any[] = [];
const thumbsLog: any[] = [];
const taskLog: any[] = [];
const recallLog: any[] = [];

async function runEvent(ev: Ev): Promise<void> {
    const at = new Date(simNow());
    switch (ev.kind) {
        case 'session':
            return session(ev);
        case 'chat':
            return chat(ev);
        case 'phone':
            return phoneCheck(ev);
        case 'home':
            return homeVisit();
        case 'phoneTell': {
            say(at, `${person.name.split(' ')[0]}, the phone app's Tell`, ev.msg.text);
            const r = await http('POST', '/api/buddy/tell', 'phone', { text: ev.msg.text });
            if (r.status >= 300) log(`  (HTTP ${r.status} ${r.raw.slice(0, 200)})`);
            return;
        }
        case 'settings': {
            await C.state.updateBuddySettings(W.userId, ev.patch);
            log(`\n**${hhmm(at, TZ)} · settings:** ${ev.why} (${JSON.stringify(ev.patch)})`);
            return;
        }
        case 'pocket': {
            say(at, `${person.name.split(' ')[0]}, a pocket note`, ev.msg.text);
            const r = await http('PUT', `/api/quick-notes/${require('node:crypto').randomUUID()}`, 'cookie', { content: ev.msg.text, category: 'PRIMARY' });
            if (r.status >= 300) log(`  (HTTP ${r.status} ${r.raw.slice(0, 200)})`);
            return;
        }
        case 'remember': {
            const cat = await catalogue('cc');
            const out = await cat.call('remember', { text: ev.msg.text });
            log(`\n_${hhmm(at, TZ)} · an agent saves "${ev.msg.text}": ${String(out.text).slice(0, 160)}_`);
            return;
        }
        case 'relay': {
            log(`\n_${hhmm(at, TZ)} · claude.ai (through the connector), about: "${ev.about ?? ''}"; it passes on what he said:_`);
            const key = `ai_${Date.now().toString(36)}`;
            const b = await http('GET', `/api/brief?about=${encodeURIComponent(ev.about ?? '')}&key=${key}`, 'connector');
            for (const m of ev.said) log(`> ${m.text}`);
            const r = await http('PUT', `/api/sessions/by-key/${key}`, 'connector', { kind: 'study', titleIfNew: 'A chat in claude.ai', source: 'agent', startedAt: at.toISOString(), minutes: 12, said: ev.said.map((m) => m.text) });
            if (b.status >= 300 || r.status >= 300) log(`  (brief HTTP ${b.status}; checkpoint HTTP ${r.status} ${r.raw.slice(0, 200)})`);
            return;
        }
        case 'import': {
            const mod = require(`./${PERSON_KEY}`);
            const data = ev.file === 'claude'
                ? mod.claudeExport.map((c: any, i: number) => ({
                      uuid: `conv-${i}`,
                      name: c.title,
                      created_at: c.at,
                      updated_at: c.at,
                      chat_messages: c.mine.flatMap((text: string, j: number) => [
                          { uuid: `m${i}-${j}`, sender: 'human', text, content: [{ type: 'text', text }], created_at: new Date(Date.parse(c.at) + j * 120_000).toISOString() },
                          { uuid: `a${i}-${j}`, sender: 'assistant', text: '(the assistant answered)', content: [{ type: 'text', text: '(the assistant answered)' }], created_at: new Date(Date.parse(c.at) + j * 120_000 + 30_000).toISOString() },
                      ]),
                  }))
                : mod.chatgptExport.map((c: any, i: number) => {
                const t = Date.parse(c.at) / 1000;
                const mapping: Record<string, any> = { root: { id: 'root', message: null, parent: null, children: ['m0'] } };
                c.mine.forEach((text: string, j: number) => {
                    mapping[`m${j}`] = { id: `m${j}`, parent: j ? `a${j - 1}` : 'root', children: [`a${j}`], message: { id: `m${j}`, author: { role: 'user' }, create_time: t + j * 120, content: { content_type: 'text', parts: [text] } } };
                    mapping[`a${j}`] = { id: `a${j}`, parent: `m${j}`, children: c.mine[j + 1] ? [`m${j + 1}`] : [], message: { id: `a${j}`, author: { role: 'assistant' }, create_time: t + j * 120 + 30, content: { content_type: 'text', parts: ['(the assistant answered)'] } } };
                });
                return { id: `conv${i}`, title: c.title, create_time: t, update_time: t + 600, mapping };
            });
            const est = await http('POST', '/api/buddy/import', 'cookie', { export: data, fileName: 'conversations.json' });
            log(`\n**${hhmm(at, TZ)} · an export of other chats comes in (${ev.file}):** ${JSON.stringify(est.data).slice(0, 400)}`);
            const id = est.data?._id ?? est.data?.id;
            if (id) {
                const ok = await http('POST', `/api/buddy/imports/${id}/approve`, 'cookie', { limitUsd: ev.limitUsd });
                log(`- approved up to $${ev.limitUsd}: ${JSON.stringify(ok.data).slice(0, 300)}`);
            }
            return;
        }
        case 'recall': {
            const doc = await C.prisma.doc.findFirst({ where: { userId: W.userId, title: ev.doc } });
            const rev = doc ? await C.prisma.revision.findFirst({ where: { userId: W.userId, topic: { docId: doc.id }, completedAt: null }, orderBy: { scheduledFor: 'asc' } }) : null;
            if (!rev) {
                log(`\n_${hhmm(at, TZ)} · Recall on "${ev.doc}": no open revision found_`);
                recallLog.push({ at: at.toISOString(), doc: ev.doc, error: 'no revision' });
                return;
            }
            const set = await C.recall.startRecall(W.userId, rev.id, at);
            log(`\n**${hhmm(at, TZ)} · Recall on "${ev.doc}"**: ${set.questions?.length ?? 0} questions`);
            const graded: any[] = [];
            for (const [i, q] of (set.questions ?? []).entries()) {
                const ans = ev.answers[i];
                log(`- Q: ${q.prompt}${ans ? `\n  his answer (${ans.grade}): ${ans.text}` : ''}`);
                if (!ans) continue;
                const out = await C.recall.answerRecall(W.userId, set._id ?? set.id, { questionId: q.id, answer: ans.text }, new Date(simNow()));
                log(`  graded: ${out.grade ?? JSON.stringify(out).slice(0, 160)}${out.feedback ? ` · ${out.feedback}` : ''}`);
                graded.push({ question: q.prompt, sourceQuote: q.sourceQuote, expected: ans.grade, got: out.grade, feedback: out.feedback });
            }
            const fin = await C.recall.finishRecall(W.userId, set._id ?? set.id, new Date(simNow())).catch((e: Error) => ({ error: e.message }));
            recallLog.push({ at: at.toISOString(), doc: ev.doc, questions: set.questions, graded, finish: fin });
            return;
        }
        case 'taskLine': {
            const out = await C.taskAi.generateTaskLine(W.userId, { prompt: ev.prompt }, at);
            taskLog.push({ at: at.toISOString(), prompt: ev.prompt, out, expect: { day: ev.expect.day, title: String(ev.expect.title) } });
            log(`\n_${hhmm(at, TZ)} · the @ai task line "${ev.prompt}" → "${out.title}", due ${out.dueDate ?? 'none'} (${out.provider})_`);
            return;
        }
        case 'practice': {
            const out = await C.practice.createPracticeNote(W.userId, { problem: ev.problem, solution: ev.solution, language: 'python', struggles: ev.struggles }, at).catch((e: Error) => ({ error: e.message }));
            log(`\n**${hhmm(at, TZ)} · a practice note:** ${(out as any).title ?? ''} ${(out as any).error ?? ''}`);
            fs.writeFileSync(path.join(OUT, 'practice-note.json'), JSON.stringify(out, null, 2));
            return;
        }
        case 'coach': {
            const out = await C.coach.generateCoachNote(W.userId, { fresh: true }, at).catch((e: Error) => ({ error: e.message }));
            log(`\n**${hhmm(at, TZ)} · the week's coach note:** ${JSON.stringify((out as any).note ?? out).slice(0, 1500)}`);
            return;
        }
    }
}

// ─── The run ────────────────────────────────────────────────────────────────────────────────────────────────

async function writeDay(day: string): Promise<void> {
    const dir = path.join(OUT, day);
    fs.mkdirSync(dir, { recursive: true });
    const cost = await spent();
    const byLayer: Record<string, number> = {};
    for (const c of calls) byLayer[c.layer] = (byLayer[c.layer] ?? 0) + 1;
    fs.writeFileSync(path.join(dir, 'transcript.md'), `# ${person.name.split(' ')[0]}'s ${day} (the buddy's day: 04:00 to 04:00)\n\n## What happened\n${lines.join('\n')}\n\n## What each surface showed (the phone every 15 minutes, Home, the agent's briefs)\n${timeline.map((t) => `- ${t}`).join('\n')}\n\n## Cost\nSpent so far $${cost.toFixed(4)} (this day $${(cost - spentAtStart).toFixed(4)}); model calls today: ${JSON.stringify(byLayer)}\n`);
    fs.writeFileSync(path.join(dir, 'calls.jsonl'), calls.map((c) => JSON.stringify(c)).join('\n'));
    fs.writeFileSync(path.join(dir, 'cost.json'), JSON.stringify({ day, totalUsd: cost, dayUsd: cost - spentAtStart, calls: byLayer }, null, 2));
    execFileSync(pgBin('pg_dump'), ['-Fc', '-f', path.join(dir, 'snapshot.dump'), C.url], { stdio: 'ignore' });
    console.log(`${day}: $${(cost - spentAtStart).toFixed(4)} (total $${cost.toFixed(4)}), ${calls.length} model calls, ${lines.length} transcript lines`);
    lines = [];
    timeline = [];
    calls = [];
    spentAtStart = cost;
}

// ─── Probes on a copy (§6.3): the same four questions at the end of a day, and the agent's brief ──────────────

const PROBES = ['what should i focus on tomorrow?', 'what do you know about me?', 'how is my week going so far?', 'am i forgetting anything?'];

async function probe(): Promise<void> {
    const at = new Date(simNow());
    const out: any = { at: at.toISOString(), day: opt('probe'), answers: [], brief: null };
    const brief = await http('GET', '/api/brief?project=dsa&key=probe_brief', 'cc');
    out.brief = brief.data;
    for (const q of PROBES) {
        const res = await fetch(`${C.base}/api/assistant/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieNow() }, body: JSON.stringify({ text: q }) });
        const raw = await res.text();
        const evs = raw.split('\n\n').map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: /^data: (.*)$/m.exec(b)?.[1] })).filter((x) => x.event && x.data);
        const done = evs.find((x) => x.event === 'done');
        const tools = evs.filter((x) => x.event === 'tool').map((x) => JSON.parse(x.data!));
        out.answers.push({ q, a: done ? JSON.parse(done.data!).message?.text ?? '' : `(no answer: HTTP ${res.status})`, tools: tools.map((t: any) => t.name) });
        setClock(simNow() + 60_000);
    }
    out.costUsd = await spent();
    fs.mkdirSync(path.join(OUT, 'probes'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'probes', `${opt('probe')}.json`), JSON.stringify(out, null, 2));
    console.log(`probe ${opt('probe')}: $${out.costUsd.toFixed(4)} in this copy's meter`);
}

// ─── Replays on a copy (§8): one night again, as it was or with one thing changed ─────────────────────────────

async function replay(): Promise<void> {
    const variant = opt('variant') ?? 'plain';
    const at = new Date(simNow());
    const p = C.prisma;
    if (variant === 'nothumb') await p.buddyFeedback.deleteMany({ where: { userId: W.userId } });
    if (variant === 'candid' || variant === 'bro' || variant === 'gentle') await C.state.updateBuddySettings(W.userId, { tone: variant });
    if (variant === 'short-history') {
        // Only the last two days of his words: what the week's history adds (E3).
        const cutoff = new Date(at.getTime() - 48 * 3600_000);
        await p.buddyThreadEvent.deleteMany({ where: { userId: W.userId, createdAt: { lt: cutoff } } });
        await p.observation.deleteMany({ where: { userId: W.userId, createdAt: { lt: cutoff } } });
        await p.memory.deleteMany({ where: { userId: W.userId, createdAt: { lt: cutoff }, observations: { none: {} } } });
        await p.buddyDay.updateMany({ where: { userId: W.userId, createdAt: { lt: cutoff } }, data: { lines: [], insight: null, note: null } });
        await p.buddyState.update({ where: { userId: W.userId }, data: { notebook: null, who: null, now: null } });
    }
    // The night's rows are stamped with `at` (taken before the changes above, which take real seconds): read from it.
    const before = new Date(at.getTime() - 1);
    let error: string | null = null;
    try {
        await C.worker.nightIfDue(W.userId, at, { fresh: true });
    } catch (err) {
        error = (err as Error).message;
    }
    const days = await p.buddyDay.findMany({ where: { userId: W.userId, createdAt: { gt: before } } });
    const asks = await p.buddyAsk.findMany({ where: { userId: W.userId, createdAt: { gt: before } }, include: { thread: { select: { title: true } } } });
    const rems = await p.buddyReminder.findMany({ where: { userId: W.userId, createdAt: { gt: before } } });
    const out = {
        night: opt('replay'),
        variant,
        run: opt('run'),
        error,
        tone: (await p.buddyState.findUnique({ where: { userId: W.userId } }))?.tone,
        thumbs: await p.buddyFeedback.count({ where: { userId: W.userId } }),
        steps: days.map((d: any) => ({ lines: d.lines, insight: d.insight, note: d.note, dropped: d.dropped, model: d.model, costUsd: Number(d.costUsd) })),
        asks: asks.map((a: any) => ({ text: a.text, thread: a.thread?.title, from: a.fromAt, until: a.untilAt, kind: a.kind })),
        reminders: rems.map((r: any) => ({ text: r.text, at: r.at })),
        calls: calls.map((c) => ({ layer: c.layer, model: c.model, error: c.error, answer: c.answer.slice(0, 4000) })),
    };
    fs.mkdirSync(path.join(OUT, 'replays'), { recursive: true });
    fs.writeFileSync(path.join(OUT, 'replays', `${opt('replay')}-${variant}-${opt('run') ?? 1}.json`), JSON.stringify(out, null, 2));
    console.log(`replay ${opt('replay')} ${variant} #${opt('run') ?? 1}: ${error ?? 'ok'}, ${out.steps[0]?.lines?.length ?? 0} lines, ${asks.length} questions`);
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    // Only put a snapshot back (--from <dump> --db <name>), for grading a run again after its database moved on.
    if (flag('restore-only')) {
        await boot(false);
        await C.prisma.$disconnect();
        console.log(`restored ${opt('from')} into ${DB_NAME}`);
        process.exit(0);
    }
    if (flag('replay-mode')) {
        await boot(false);
        W = await identities();
        const before = await spent();
        await replay();
        console.log(`replay spend $${((await spent()) - before).toFixed(4)}`);
        C.server.close();
        await C.prisma.$disconnect();
        process.exit(0);
    }
    if (flag('probe')) {
        await boot(false);
        W = await identities();
        const before = await spent();
        await probe();
        console.log(`probe spend $${((await spent()) - before).toFixed(4)}`);
        C.server.close();
        await C.prisma.$disconnect();
        process.exit(0);
    }
    const fresh = !opt('from');
    await boot(fresh);
    if (fresh) {
        W = await setupPerson();
        W.cookie = cookieNow();
        const cat = await catalogue('cc');
        for (const s of person.seed) {
            const out = await cat.call(s.tool, s.input);
            log(`- seed ${s.tool}: ${out.isError ? 'ERROR ' : ''}${String(out.text).slice(0, 140)}`);
        }
        log(`- set up at ${local(new Date(simNow()), TZ)}: ${person.name}, buddy "${person.buddyName}" (${person.tone}, the loop on)`);
    } else {
        W = await identities();
    }
    await startScheduler();
    spentAtStart = await spent();
    const until = opt('until') ? when(`${opt('until')} 23:59`) : when(person.end);
    const events = person.events.map((e) => ({ ...e, t: when(e.at).getTime() })).sort((a, b) => a.t - b.t).filter((e) => e.t >= simNow());
    let day = buddyDay(new Date(simNow()), TZ);
    const boundaryAfter = (d: string) => {
        const next = new Date(new Date(`${d}T12:00:00${OFFSET}`).getTime() + 86_400_000);
        return new Date(`${dayOfLocal(next, TZ)}T04:00:00${OFFSET}`).getTime();
    };
    let nextRefresh = Math.ceil(simNow() / (15 * 60_000)) * 15 * 60_000;
    const pictureTimes = new Set(['20:00']);
    let i = 0;
    while (simNow() < until.getTime()) {
        const nextEvent = events[i]?.t ?? Infinity;
        const bound = boundaryAfter(day);
        const t = Math.min(nextEvent, nextTimer(), nextRefresh, until.getTime(), bound);
        // A new buddy day (04:00): the day that ended is written before anything of the new one runs.
        if (t === bound) {
            if (bound - 1 > simNow()) setClock(bound - 1);
            await writeDay(day);
            day = buddyDay(new Date(bound), TZ);
            setClock(bound);
            continue;
        }
        await advanceTo(t);
        if ((await spent()) > BUDGET) {
            log(`\n**STOPPED: the budget of $${BUDGET} is reached.**`);
            break;
        }
        if (simNow() >= nextRefresh) {
            await phoneRefresh();
            if (pictureTimes.has(hhmm(new Date(nextRefresh), TZ))) await pictures(`${dayOfLocal(new Date(nextRefresh), TZ)}-${hhmm(new Date(nextRefresh), TZ).replace(':', '')}`);
            nextRefresh += 15 * 60_000;
        }
        while (events[i] && events[i]!.t <= simNow()) {
            const ev = events[i++]!;
            try {
                await runEvent(ev);
            } catch (err) {
                log(`\n**(the event at ${ev.at} failed: ${(err as Error).message.slice(0, 400)})**`);
                console.error(err);
            }
        }
        if (t >= until.getTime()) break;
    }
    await writeDay(day);
    fs.writeFileSync(path.join(OUT, 'logs.json'), JSON.stringify({ chats: chatLog, answers: answersLog, thumbs: thumbsLog, tasks: taskLog, recall: recallLog }, null, 2));
    for (const cat of catalogues.values()) await cat.close?.();
    C.server.close();
    await C.prisma.$disconnect();
    console.log(`done: $${(await Promise.resolve(spentAtStart)).toFixed(4)} in all; ${OUT}`);
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
