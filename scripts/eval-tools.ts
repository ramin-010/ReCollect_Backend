// TOOL_ACCESS_PLAN §7.2: does a real model pick the right Kaaga tool from the web door? evals/tools.json holds ~120
// one-message cases. The model gets the door's own instructions (as the system text) and its listed tools; tool calls
// are answered here, with no engine and no database writes:
//   find_tools               the real search and cards (the real server, in memory);
//   use_tool / use_read_tool the real name and input checks, then a canned answer from the case world;
//   a listed tool            the real input checks, then a canned answer.
// A case passes when the model reaches one of `expect` with valid inputs (and, with `ids`, names one of them). A wrong
// pick is a call to a changing tool outside expect ∪ allowed. Up to 4 tool steps a case.
//
// The real model costs money, so it needs --yes and prints its estimate first; --fake runs a scripted stand-in (no
// spend: it checks the runner itself). Spend goes on the QA account's meter (feature "assistant").
//
//   npx ts-node --transpile-only scripts/eval-tools.ts --fake
//   npx ts-node --transpile-only scripts/eval-tools.ts --yes [--model claude-sonnet-5-5] [--list wide|daily]
//        [--kinds listed,none] [--only L01,F02] [--dist ../mcp/dist] [--max-usd 1.5] [--tag baseline]
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { prisma } from '../src/db/prisma';
import { getAiClient } from '../src/services/claude/client';
import { HOUSE_KEY } from '../src/services/claude/access';
import { costOfCall } from '../src/services/claude/pricing';
import { recordAiUsage } from '../src/services/claude/usage.service';

interface Case {
    id: string;
    kind: 'listed' | 'found' | 'none';
    user: string;
    expect: string[];
    allowed: string[];
    ids?: string[];
}
interface Fixture {
    world: string;
    cases: Case[];
}
interface Call {
    /** The tool the model meant: the runner's target for use_tool / use_read_tool. */
    name: string;
    via: 'direct' | 'use_tool' | 'use_read_tool' | 'find';
    args: Record<string, unknown>;
    /** The inputs met the tool's schema and the door let it run. */
    valid: boolean;
    level: number;
    answer: string;
}

const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
};
const has = (name: string) => process.argv.includes(name);

/** TOOL_ACCESS_PLAN §7.3: the everyday-set candidate "Daily" (19); "Wide" is WEB_TOOLS. */
export const DAILY = ['get_brief', 'remember', 'update_memory', 'recall_memory', 'forget', 'add_task', 'list_tasks', 'update_task', 'set_reminder', 'add_pocket_note', 'get_today', 'list_due', 'search_docs', 'read_doc', 'create_doc', 'append_to_doc', 'checkpoint', 'log_work', 'get_work_log'];
// Real hosts allow many steps; a found tool takes get_brief, a search, find_tools, then the call (stage 5: 4 cut runs short).
const MAX_STEPS = 6;
const REACHED = '__EVAL_REACHED__';
// TOOL_ACCESS_PLAN §12.3: a write's answer names its edit for undo_edit, as the real tools now do.
const UNDO = 'Undo: undo_edit {"editId":"edit_new"} takes this back if they ask; they can also undo it on Home → From your agent.';

// ─── The case world: canned answers of the read tools (from evals/tools.json's world) ─────────────────

const BRIEF = [
    'Fri 27 Nov 2026, 10:00 (Asia/Kolkata) · session key s_eval0001',
    'Goal "Backend offer by May" (goal_offer) · due 2027-05-15 · milestones 0/2 · on track',
    'Today: 2 reviews planned (Sliding window rev_sw, Caching rev_cache) · focus: "Graphs: BFS" (focus_1)',
    'Next: System Design → Load balancing (top_lb) · DSA → Graphs (top_graphs)',
    'Your buddy follows: "walks after dinner" (mem_walk)',
    'Work (ERP, key erp): today "Fixed invoice rounding" (wl_1, did)',
].join('\n');

const READS: Record<string, string> = {
    get_brief: BRIEF,
    get_today: 'Today: reviews Sliding window (rev_sw, doc docsliding) and Caching (rev_cache, doc doccache) · focus "Graphs: BFS" (focus_1) · next topics: Load balancing (top_lb), Graphs (top_graphs) · goal "Backend offer by May" (goal_offer) on track, milestones "Finish System Design" (ms_sd, due 2026-12-15), "20 mock interviews" (ms_mock, due 2027-01-31). Tasks due today: "Call the bank" (task_bank).',
    list_due: 'Due today: 1. DSA · Sliding window · review 2 · doc docsliding · id rev_sw. 2. System Design · Caching · review 1 · doc doccache · id rev_cache. 21 more overdue waiting for room (23 overdue in all).',
    get_week: 'Week 23-29 Nov: 1 target: "Finish the caching lesson" (wt_cache, open). Last week: 6 h study, 4 topics.',
    list_tasks: '"Call the bank" (task_bank) · due today · normal. "Renew passport" (task_pass) · no day.',
    list_reminders: '"Call mum" at 19:00 today (rem_mum).',
    list_goals: 'Goal "Backend offer by May" (goal_offer) · due 2027-05-15 · on track. Milestones: "Finish System Design" (ms_sd, due 2026-12-15), "20 mock interviews" (ms_mock, due 2027-01-31).',
    get_standing: 'Goal "Backend offer by May": System Design 3/8 topics at 1.5/wk, needs 1.2/wk · on track. Hours: 6 h/wk. Quiz scores: DSA 78%, System Design 64%.',
    list_subjects: '"System Design" (sub_sd) · 2 topics · "DSA" (sub_dsa) · 2 topics.',
    get_path: 'System Design (sub_sd): ✓ Caching (top_cache, doc doccache) · ○ Load balancing (top_lb). DSA (sub_dsa): ▶ Sliding window (top_sw, doc docsliding) · ○ Graphs (top_graphs).',
    get_learning_overview: 'System Design: 1 due, 0 mastered, 0 not scheduled. DSA: 1 due, 0 mastered. Docs in no subject: "Old scratch" (docold), "Kafka basics" (dockafka), "ERP notes" (docerp): not scheduled.',
    search_docs: '"Kafka basics" (dockafka) · no subject · "Sliding window" (docsliding) · DSA · "System design: caching" (doccache) · System Design · "ERP notes" (docerp) · "Old scratch" (docold).',
    read_doc: 'Doc doccache · "System design: caching" · System Design · you can edit it.\n## Summary\nCache-aside: read the cache; on a miss read the database.\n## Eviction\nLRU drops the least recently used entry.\n- [ ] compare Redis vs Memcached',
    get_outline: 'blk_1 · heading · Summary\nblk_2 · paragraph · Cache-aside: read the cache…\nblk_3 · heading · Eviction\nblk_4 · paragraph · LRU drops…\nblk_5 · checkListItem · compare Redis vs Memcached',
    recall_memory: '"walks after dinner" (pattern) · id mem_walk · said 2026-11-20 in ChatGPT.',
    get_work_log: 'ERP (erp): Thu 26 Nov: "Fixed invoice rounding" (wl_1, did). Decided: "Use Postgres for the ERP" (dec_pg).',
    list_notes: 'On "System design: caching": "Video: Redis eviction" (note_redis). On "Sliding window": "My cheat sheet" (note_cheat, 1 file: cheatsheet.md).',
    get_settings: 'Daily budget 30 min · busy: none · morning email on at 07:30 · profile: none.',
    list_suggestions: 'Nothing waits for their tap.',
    get_sharing: 'Not published · shared with nobody.',
    list_sessions: 'Thu 26 Nov · 2 h 13 min: study 2 h 13 min\n- "How the web works" · 2 h 13 min study · Claude · id ses_web\nWed 25 Nov · 45 min: practice 45 min\n- "Two pointers" · 45 min practice · by hand · id ses_tp',
    get_quiz_results: 'Sliding window: last quiz 2026-11-24 · 3 strong, 1 weak · missed "when to shrink the window".',
    list_decisions: '"Use Postgres for the ERP" (dec_pg) · open · look again 2027-02-26.',
    recent_agent_edits: "1 edit by this app, newest first; undo_edit takes back one of this app's own by its id:\n- edit_dhcp · 2026-11-27 09:40 · Added 3 blocks at the end in \"Kafka basics\" · doc dockafka · not reviewed yet",
    list_pocket_notes: '"idea: a habit tracker" (pn_idea) · "link: a talk on Kafka internals" (pn_link).',
    read_note_file: 'cheatsheet.md: "Shrink from the left while the window is invalid."',
    preview_diagram: 'The board: 3 boxes, no problems.',
};
const canned = (name: string, level: number): string => READS[name] ?? (level === 1 ? 'Nothing more to show.' : `Done (${name}). ${UNDO}`);

// ─── The MCP side (the built package, loaded as ES modules) ───────────────────────────────────────

const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
interface McpTool {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}
interface Door {
    tools: McpTool[];
    instructions: string;
    levels: Record<string, number>;
    examples: Record<string, Record<string, unknown>>;
    call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
    close(): Promise<void>;
}

async function openDoor(dist: string, listed: string[] | undefined): Promise<Door> {
    const load = (f: string) => importEsm(pathToFileURL(path.join(dist, f)).href) as Promise<Record<string, unknown>>;
    const server = await load('server.js');
    const api = await load('api.js');
    let cards: Record<string, unknown> = {};
    try {
        cards = await load('cards.js');
    } catch {
        // A build from before the cards (the baseline): no examples for the stand-in.
    }
    const sdk = path.join(__dirname, '..', '..', 'mcp', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm');
    const { Client } = (await importEsm(pathToFileURL(path.join(sdk, 'client', 'index.js')).href)) as { Client: new (...a: unknown[]) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { InMemoryTransport } = (await importEsm(pathToFileURL(path.join(sdk, 'inMemory.js')).href)) as { InMemoryTransport: { createLinkedPair(): [unknown, unknown] } };
    // Every API call answers one marker: a call that got that far had valid inputs (its canned answer stands in).
    const fetch = async () => new Response(JSON.stringify({ message: REACHED }), { status: 418, headers: { 'content-type': 'application/json' } });
    const KaagaApi = api['KaagaApi'] as new (o: Record<string, unknown>) => unknown;
    const kaagaApi = new KaagaApi({ baseUrl: 'http://kaaga.eval', token: `rcl_${'e'.repeat(43)}`, agentName: 'eval', fetch, retryDelayMs: 0, runningDelayMs: 0, log: () => {} });
    const create = server['createKaagaServer'] as (o: Record<string, unknown>) => { connect(t: unknown): Promise<void>; close(): Promise<void> };
    const mcp = create({ api: kaagaApi, agentName: 'eval', problem: null, set: 'web', ...(listed ? { listed } : {}) });
    const client = new Client({ name: 'eval-tools', version: '1.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(b), client.connect(a)]);
    const { tools } = (await client.listTools()) as { tools: McpTool[] };
    const CARDS = (cards['CARDS'] ?? {}) as Record<string, { example: Record<string, unknown> }>;
    const WEB_CARDS = (cards['WEB_CARDS'] ?? {}) as Record<string, { example: Record<string, unknown> }>;
    const examples = Object.fromEntries(Object.entries({ ...CARDS, ...WEB_CARDS }).map(([k, v]) => [k, v.example]));
    return {
        tools,
        instructions: client.getInstructions() ?? '',
        levels: server['TOOL_LEVELS'] as Record<string, number>,
        examples,
        async call(name, args) {
            const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
            return { text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError === true };
        },
        close: async () => {
            await client.close();
            await mcp.close();
        },
    };
}

/** What the door's own checks said about a call: valid inputs, or the error a model would read. */
function judged(answer: { text: string; isError: boolean }): { valid: boolean; shown: string | null } {
    if (!answer.isError) return { valid: true, shown: answer.text };
    if (answer.text.includes(REACHED)) return { valid: true, shown: null };
    return { valid: false, shown: answer.text };
}

/** One model tool call answered as the door would, with canned data past the checks. */
async function answerCall(door: Door, name: string, input: Record<string, unknown>, calls: Call[]): Promise<string> {
    const levelOf = (n: string) => door.levels[n] ?? 2;
    if (name === 'find_tools') {
        const r = await door.call(name, input);
        calls.push({ name, via: 'find', args: input, valid: !r.isError, level: 1, answer: r.text });
        return r.text;
    }
    const via = name === 'use_tool' || name === 'use_read_tool' ? name : 'direct';
    const target = via === 'direct' ? name : String(input['name'] ?? '');
    const targetArgs = via === 'direct' ? input : typeof input['args'] === 'string' ? safeJson(input['args']) : ((input['args'] as Record<string, unknown> | undefined) ?? {});
    const r = await door.call(name, input);
    const j = judged(r);
    const text = j.valid ? (j.shown && !READS[target] && levelOf(target) === 1 ? j.shown : canned(target, levelOf(target))) : j.shown!;
    calls.push({ name: target, via, args: targetArgs, valid: j.valid, level: levelOf(target), answer: text });
    return text;
}
const safeJson = (s: string): Record<string, unknown> => {
    try {
        const v = JSON.parse(s) as unknown;
        return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
        return {};
    }
};

// ─── Grading ──────────────────────────────────────────────────────────────────────────────────────

interface Graded {
    passed: boolean;
    reached: boolean;
    wrong: string[];
    problems: string[];
}
/** A subject, goal or project may be named by its name instead of its id (the tools take either). */
const ALIASES: Readonly<Record<string, readonly string[]>> = { sub_dsa: ['DSA'], sub_sd: ['System Design'], goal_offer: ['offer'], erp: ['ERP'] };
const names = (args: unknown, id: string) => {
    const text = JSON.stringify(args).toLowerCase();
    return [id, ...(ALIASES[id] ?? [])].some((x) => text.includes(x.toLowerCase()));
};

export function grade(c: Case, calls: readonly Call[]): Graded {
    const problems: string[] = [];
    const ok = (call: Call) => call.valid && c.expect.includes(call.name) && (!c.ids?.length || c.ids.some((id) => names(call.args, id)));
    const reached = c.expect.length === 0 ? true : calls.some(ok);
    if (!reached) problems.push(calls.some((x) => c.expect.includes(x.name)) ? `reached ${c.expect.join(' or ')} without valid inputs${c.ids?.length ? ' / the right id' : ''}` : `did not reach ${c.expect.join(' or ')}`);
    const allowed = new Set([...c.expect, ...c.allowed]);
    const wrong = [...new Set(calls.filter((x) => x.via !== 'find' && x.level >= 2 && !allowed.has(x.name)).map((x) => x.name))];
    if (wrong.length) problems.push(`wrong pick: ${wrong.join(', ')}`);
    return { passed: reached && wrong.length === 0, reached, wrong, problems };
}

// ─── The model ────────────────────────────────────────────────────────────────────────────────────

type Block = { type: string; [k: string]: unknown };
interface Turn {
    calls: Call[];
    text: string;
    costUsd: number;
    rounds: number;
}

async function runCase(door: Door, c: Case, model: string, userId: string | null, fake: boolean): Promise<Turn> {
    const calls: Call[] = [];
    const turn: Turn = { calls, text: '', costUsd: 0, rounds: 0 };
    if (fake) return fakeCase(door, c, turn);
    const tools = door.tools.map((t, i) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.inputSchema,
        ...(i === door.tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
    const system = [{ type: 'text', text: door.instructions, cache_control: { type: 'ephemeral' } }];
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [{ role: 'user', content: c.user }];
    const client = getAiClient(HOUSE_KEY);
    for (let step = 0; step <= MAX_STEPS; step++) {
        turn.rounds += 1;
        const res = await client.createMessage({ model, max_tokens: 2000, system, tools, messages, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } } as never);
        const cost = costOfCall(res.usage as never, res.model);
        turn.costUsd += cost.costUsd;
        if (userId) await recordAiUsage(userId, 'assistant', { model: res.model, usage: res.usage as never }, { source: 'house' });
        messages.push({ role: 'assistant', content: res.content });
        const blocks = res.content as unknown as Block[];
        turn.text = blocks.filter((b) => b.type === 'text').map((b) => String(b['text'])).join('\n') || turn.text;
        const uses = blocks.filter((b) => b.type === 'tool_use');
        if (res.stop_reason !== 'tool_use' || !uses.length || step === MAX_STEPS) break;
        const results: Block[] = [];
        for (const u of uses) {
            const text = await answerCall(door, String(u['name']), (u['input'] as Record<string, unknown>) ?? {}, calls);
            results.push({ type: 'tool_result', tool_use_id: u['id'], content: text });
        }
        messages.push({ role: 'user', content: results });
    }
    return turn;
}

/** The stand-in: the first expected tool, directly when listed, else find_tools then the runner, with its card's example. */
async function fakeCase(door: Door, c: Case, turn: Turn): Promise<Turn> {
    turn.rounds = 1;
    const want = c.expect[0];
    if (!want) {
        turn.text = 'Nothing to do.';
        return turn;
    }
    const listed = door.tools.some((t) => t.name === want);
    const args = door.examples[want] ?? {};
    if (listed) await answerCall(door, want, args, turn.calls);
    else {
        await answerCall(door, 'find_tools', { query: c.user.slice(0, 200) }, turn.calls);
        await answerCall(door, (door.levels[want] ?? 2) === 1 ? 'use_read_tool' : 'use_tool', { name: want, args }, turn.calls);
    }
    turn.text = 'Done.';
    return turn;
}

// ─── Main ─────────────────────────────────────────────────────────────────────────────────────────

/** --regrade <results.json>: the saved calls graded again with today's grader (no model, no spend). */
async function regrade(file: string): Promise<void> {
    const dist = path.resolve(arg('--dist') ?? path.join(__dirname, '..', '..', 'mcp', 'dist'));
    const levels = ((await importEsm(pathToFileURL(path.join(dist, 'server.js')).href)) as { TOOL_LEVELS: Record<string, number> }).TOOL_LEVELS;
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evals', 'tools.json'), 'utf8')) as Fixture;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { results: Array<{ id: string; calls: Call[]; kind: string }> };
    let passed = 0;
    let wrong = 0;
    const by: Record<string, [number, number]> = {};
    for (const r of saved.results) {
        const c = fixture.cases.find((x) => x.id === r.id);
        if (!c) continue;
        const g = grade(c, r.calls.map((x) => ({ ...x, level: x.level ?? levels[x.name] ?? 2 })));
        if (g.passed) passed += 1;
        if (g.wrong.length) wrong += 1;
        const k = (by[r.kind] ??= [0, 0]);
        k[1] += 1;
        if (g.passed) k[0] += 1;
    }
    console.log(JSON.stringify({ regraded: file, passed: `${passed}/${saved.results.length}`, byKind: by, wrongPicks: wrong }));
}

async function main(): Promise<void> {
    if (arg('--regrade')) {
        await regrade(arg('--regrade')!);
        return;
    }
    const fake = has('--fake');
    if (!fake && !has('--yes')) throw new Error('A real run costs money: pass --yes (or --fake for the stand-in).');
    const model = arg('--model') ?? 'claude-sonnet-5-5';
    const dist = path.resolve(arg('--dist') ?? path.join(__dirname, '..', '..', 'mcp', 'dist'));
    const listName = arg('--list') ?? 'wide';
    const kinds = (arg('--kinds') ?? 'listed,found,none').split(',');
    const only = arg('--only')?.split(',');
    const maxUsd = Number(arg('--max-usd') ?? '1.5');
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evals', 'tools.json'), 'utf8')) as Fixture;
    const cases = fixture.cases.filter((c) => kinds.includes(c.kind) && (!only || only.includes(c.id)));
    const door = await openDoor(dist, listName === 'daily' ? DAILY : undefined);
    // Tools the build doesn't have yet (the baseline: no runners, no new tools) can't be reached: such cases are left out.
    const exists = new Set(Object.keys(door.levels));
    const runnable = cases.filter((c) => c.expect.every((n) => exists.has(n)));
    const listChars = JSON.stringify(door.tools).length;
    console.log(`${runnable.length} cases (${cases.length - runnable.length} need tools this build lacks) · list ${listName}: ${door.tools.length} tools, ${listChars} characters · ${fake ? 'fake model' : model}`);
    const qa = fake ? null : await prisma.user.findFirst({ where: { email: 'qa@recollect.local' }, select: { id: true } });
    if (!fake && !qa) throw new Error('The QA account is missing (qa@recollect.local).');
    if (!fake) {
        // The estimate: the list and instructions are cached after the first call; about 2 rounds a case.
        const perCase = model.includes('haiku') ? 0.0015 : 0.012;
        console.log(`Estimate: about $${(perCase * runnable.length).toFixed(2)} (cap $${maxUsd.toFixed(2)})`);
    }
    const results: Array<Record<string, unknown>> = [];
    let spent = 0;
    for (const c of runnable) {
        const avg = results.length ? spent / results.length : 0;
        if (!fake && spent + Math.max(avg, 0.005) > maxUsd) {
            console.log(`Stopped before ${c.id}: the next case would pass the $${maxUsd.toFixed(2)} cap.`);
            break;
        }
        let turn: Turn;
        try {
            turn = await runCase(door, c, model, qa?.id ?? null, fake);
        } catch (err) {
            console.log(`ERR  ${c.id} ${err instanceof Error ? err.message : String(err)}`);
            results.push({ id: c.id, kind: c.kind, passed: false, problems: ['the call threw'], calls: [] });
            continue;
        }
        spent += turn.costUsd;
        const g = grade(c, turn.calls);
        const path_ = turn.calls.map((x) => `${x.via === 'direct' || x.via === 'find' ? '' : `${x.via}:`}${x.name}${x.valid ? '' : '✗'}`).join(' → ');
        console.log(`${g.passed ? 'pass' : 'FAIL'} ${c.id} ${(turn.costUsd * 100).toFixed(1).padStart(5)}¢  ${path_ || '(no tools)'}${g.problems.length ? `\n     ${g.problems.join('; ')}` : ''}`);
        results.push({ id: c.id, kind: c.kind, user: c.user, passed: g.passed, reached: g.reached, wrong: g.wrong, problems: g.problems, calls: turn.calls.map((x) => ({ name: x.name, via: x.via, valid: x.valid, level: x.level, args: x.args })), text: turn.text, rounds: turn.rounds, costUsd: turn.costUsd });
    }
    await door.close();
    const by = (k: string) => results.filter((r) => r['kind'] === k);
    const rate = (rs: Array<Record<string, unknown>>, f: (r: Record<string, unknown>) => boolean) => (rs.length ? `${rs.filter(f).length}/${rs.length}` : '-');
    const wrongPicks = results.filter((r) => ((r['wrong'] as string[] | undefined) ?? []).length > 0).length;
    const summary = {
        list: listName,
        model: fake ? 'fake' : model,
        dist,
        listTools: door.tools.length,
        listChars,
        passed: rate(results, (r) => r['passed'] === true),
        listed: rate(by('listed'), (r) => r['passed'] === true),
        found: rate(by('found'), (r) => r['passed'] === true),
        none: rate(by('none'), (r) => r['passed'] === true),
        reached: rate(results.filter((r) => r['kind'] !== 'none'), (r) => r['reached'] === true),
        wrongPicks: `${wrongPicks}/${results.length}`,
        spentUsd: Number(spent.toFixed(4)),
    };
    console.log(`\n${JSON.stringify(summary)}`);
    const dir = path.join(__dirname, '..', 'evals', 'results');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `tools-${arg('--tag') ?? listName}-${fake ? 'fake-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
    console.log(`Written: ${path.relative(process.cwd(), file)}`);
}

if (require.main === module) {
    main()
        .then(() => prisma.$disconnect())
        .catch(async (err) => {
            console.error(err);
            await prisma.$disconnect();
            process.exit(1);
        });
}
