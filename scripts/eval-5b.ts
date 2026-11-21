// Stage 5b of ECOSYSTEM_V2_PLAN, the models' part on labelled sets (labels written before any run):
//   tasks    evals/task-or-thread.json: the digest splits a to-do (a task with its day) from an event (a thread) by the wording
//   lock     evals/lock.json: the lock check as built against the check before it (OLD), on the same lines
//   screens  evals/screen-words.json: what they say about their screens becomes the right rule, or none
// Each message alone through the real request and model; graded by code; misses listed.
//
//   node node_modules/ts-node/dist/bin.js --transpile-only scripts/eval-5b.ts <tasks|lock|screens> [out.json]   (PowerShell)
//   about 15 cents (tasks), 10 (lock, both checks), 8 (screens)
import fs from 'node:fs';
import path from 'node:path';
import { getAiClient } from '../src/services/claude/client';
import { costOfCall } from '../src/services/claude/pricing';
import { parseJson, responseText } from '../src/services/recall/output';
import { digestLoopRequest, digestLoopText, numberedChat } from '../src/services/buddy/digest';
import { zDigestLoop, type DigestLoopOutput } from '../src/services/buddy/understand';
import { LOCK_SYSTEM, lockRequest, zLock, type Line } from '../src/services/buddy/think';

const TZ = 'Asia/Kolkata';
const read = <T>(name: string): T => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evals', name), 'utf8')) as T;
const client = getAiClient();
let cost = 0;

/** The lock check's words before stage 5b (11-16 to 11-19), for the before-and-after on the same lines. */
const OLD_LOCK_SYSTEM = `A line will show on a person's phone lock screen, where anyone nearby can read it. You get the person's private facts and the lines. For each line answer reveals: true when a stranger reading only the line would learn one of those private facts, or anything about health, money, family, other people, guilt, fear, conflicts at work or leaving a job, or what they work on at their job (its projects, code, clients). A line may be shaped by a private fact as long as it does not name it. When unsure, answer true.`;

async function digestOf(text: string, ctx: { today: string; weekday: string; threads?: string; tasks?: Array<{ id: string; title: string; day: string | null }>; at?: string }): Promise<DigestLoopOutput> {
    const at = ctx.at ?? new Date(`${ctx.today}T05:30:00Z`).toISOString(); // 11:00 in Kolkata
    const body = digestLoopText({
        chat: numberedChat([{ at, text }], [0], { today: ctx.today as never, tz: TZ }),
        known: [],
        threads: ctx.threads ?? 'none yet',
        events: 'none',
        asks: 'none',
        saved: [],
        tasks: ctx.tasks ?? [],
        weekday: ctx.weekday,
        today: ctx.today,
        source: 'their chat with the buddy',
    });
    const message = await client.createMessage(digestLoopRequest(body) as never);
    cost += costOfCall(message.usage as never, message.model).costUsd;
    const parsed = zDigestLoop.safeParse(parseJson(responseText(message)));
    if (!parsed.success) throw new Error(`the digest answered in the wrong shape for: ${text}`);
    return parsed.data;
}

type TaskCase = { n: number; text: string; expect: string; day?: string[]; deadline?: boolean; time?: string; taskBy?: string; taskId?: string };

async function tasks() {
    const set = read<{ today: string; weekday: string; groups: Array<{ name: string; openTasks: Array<{ id: string; title: string; day: string }>; cases: TaskCase[] }> }>('task-or-thread.json');
    const results: Array<{ n: number; text: string; expect: string; pass: boolean; why: string; got: string }> = [];
    let taskFromEvent = 0;
    let threadFromTodo = 0;
    for (const g of set.groups) {
        for (const c of g.cases) {
            const out = await digestOf(c.text, { today: set.today, weekday: set.weekday, tasks: g.openTasks });
            const taskItems = out.items.filter((i) => i.kind === 'task');
            const opens = out.threads.filter((t) => t.op === 'open');
            const events = opens.filter((t) => t.event);
            const got = `tasks: ${taskItems.map((i) => `${i.text} ${i.dueDay}${i.deadline ? ' by' : ''}${i.time ? ` ${i.time}` : ''}`).join(' | ') || '-'}; threads: ${opens.map((t) => `${t.title}${t.event ? ` (event ${t.lookAgainOn}${t.time ? ` ${t.time}` : ''})` : t.lookAgainOn ? ` (${t.lookAgainOn})` : ''}`).join(' | ') || '-'}; done: ${out.tasksDone.map((d) => d.taskId).join(',') || '-'}`;
            let why = '';
            const dayOk = (d: string) => !c.day || c.day.includes(d);
            if (c.expect === 'task') {
                const t = taskItems[0];
                if (taskItems.length !== 1) why = `${taskItems.length} tasks`;
                else if (!dayOk(t!.dueDay)) why = `day ${t!.dueDay}`;
                else if (c.deadline !== undefined && t!.deadline !== c.deadline) why = `deadline ${t!.deadline}`;
                else if (c.time && t!.time !== c.time) why = `time ${t!.time || 'none'}`;
                else if (opens.length) why = 'a thread for a to-do';
                if (opens.length) threadFromTodo++;
            } else if (c.expect === 'event') {
                const e = events[0];
                if (taskItems.length) why = 'a task for an event';
                else if (events.length !== 1) why = `${events.length} event threads`;
                else if (!dayOk(e!.lookAgainOn)) why = `day ${e!.lookAgainOn}`;
                else if (c.time && e!.time !== c.time) why = `time ${e!.time || 'none'}`;
                if (taskItems.length) taskFromEvent++;
            } else if (c.expect === 'both') {
                const e = events[0];
                const t = taskItems[0];
                if (events.length !== 1 || taskItems.length !== 1) why = `${events.length} events, ${taskItems.length} tasks`;
                else if (!dayOk(e!.lookAgainOn)) why = `event day ${e!.lookAgainOn}`;
                else if (t!.dueDay > c.taskBy!) why = `task after the event (${t!.dueDay})`;
            } else if (c.expect === 'plan') {
                if (taskItems.length) why = 'a task for a plan';
                else if (opens.length !== 1 || opens[0]!.event) why = opens.length ? 'an event, not a plan' : 'no thread';
            } else if (c.expect === 'nothing') {
                if (taskItems.length || opens.length) why = 'made something';
            } else if (c.expect === 'no_task') {
                if (taskItems.length) why = 'a task';
            } else if (c.expect === 'done') {
                if (!out.tasksDone.some((d) => d.taskId === c.taskId)) why = 'not ticked';
                else if (out.tasksDone.length > 1) why = 'ticked others too';
            } else if (c.expect === 'not_done') {
                if (out.tasksDone.length) why = `ticked ${out.tasksDone.map((d) => d.taskId).join(',')}`;
            }
            results.push({ n: c.n, text: c.text, expect: c.expect, pass: !why, why, got });
            console.log(`${c.n} ${why ? 'MISS' : 'ok  '} ${c.expect}: ${c.text}${why ? ` (${why})` : ''}\n      ${got}`);
        }
    }
    const right = results.filter((r) => r.pass).length;
    return { right, of: results.length, taskFromEvent, threadFromTodo, pass: right >= 27 && taskFromEvent === 0 && threadFromTodo === 0, results };
}

type LockLine = { text: string; expect: 'show' | 'hide' | 'either' };

async function lockSet(system: string) {
    const set = read<{ private: string[]; groups: Array<{ name: string; rules: string[]; lines: LockLine[] }> }>('lock.json');
    const results: Array<LockLine & { group: string; shows: boolean | null }> = [];
    for (const g of set.groups) {
        for (let i = 0; i < g.lines.length; i += 4) {
            const batch = g.lines.slice(i, i + 4);
            const lines: Line[] = batch.map((l, j) => ({ slot: 'evening', from: `${String(9 + j * 3).padStart(2, '0')}:00`, until: `${String(11 + j * 3).padStart(2, '0')}:00`, text: l.text, form: 'observation', lockOk: true, sourceId: null }) as Line);
            const request = lockRequest(lines, set.private, null, null, [], g.rules) as unknown as { system: Array<{ text: string }> };
            request.system[0]!.text = request.system[0]!.text.replace(LOCK_SYSTEM, system);
            const message = await client.createMessage(request as never);
            cost += costOfCall(message.usage as never, message.model).costUsd;
            const verdict = zLock.safeParse(parseJson(responseText(message)));
            batch.forEach((l, j) => {
                const v = verdict.success ? verdict.data.lines.find((x) => x.i === j) : undefined;
                results.push({ ...l, group: g.name, shows: v ? !v.reveals : null });
            });
        }
    }
    const show = results.filter((r) => r.expect === 'show');
    const hide = results.filter((r) => r.expect === 'hide');
    const showRight = show.filter((r) => r.shows === true).length;
    const leaks = hide.filter((r) => r.shows === true);
    return {
        showPassed: { right: showRight, of: show.length },
        hidePassed: { leaks: leaks.length, of: hide.length },
        pass: leaks.length === 0 && showRight >= Math.ceil(show.length * 0.85),
        blockedOrdinary: show.filter((r) => r.shows !== true).map((r) => r.text),
        leaked: leaks.map((r) => r.text),
        either: results.filter((r) => r.expect === 'either').map((r) => `${r.shows ? 'shows' : 'kept off'}: ${r.text}`),
    };
}

type ScreenCase = { n: number; text: string; expect: string; from?: [string, string]; days?: string; threadId?: string; words?: string; ends?: string };

async function screens() {
    const set = read<{ today: string; weekday: string; threads: Array<{ id: string; stage: string; title: string }>; cases: ScreenCase[] }>('screen-words.json');
    const threads = set.threads.map((t) => `${t.id} · ${t.stage} · ${t.title}`).join('\n');
    const results: Array<{ n: number; text: string; expect: string; pass: boolean; why: string; got: string }> = [];
    for (const c of set.cases) {
        const out = await digestOf(c.text, { today: set.today, weekday: set.weekday, threads });
        const s = out.screens;
        const steers = out.threads.filter((t) => t.kind === 'steer');
        const got = `screens: ${s.map((x) => `${x.kind}${x.threadId ? `@${x.threadId}` : ''} ${x.time || ''}${x.days ? ` ${x.days}` : ''} "${x.words}"`).join(' | ') || '-'}; steers: ${steers.map((x) => `${x.threadId}:${x.steer}`).join(' | ') || '-'}`;
        let why = '';
        const one = s[0];
        if (c.expect === 'none') {
            if (s.length) why = 'made a rule';
        } else if (c.expect === 'off_screens') {
            const steer = steers.some((x) => x.threadId === c.threadId && x.steer === 'off_screens');
            const topic = s.some((x) => x.kind === 'topic' && /sister/i.test(x.words));
            if (!steer && !topic) why = 'neither a steer nor a rule';
        } else if (c.expect === 'end') {
            if (!s.some((x) => (x.kind === 'asks_from' && !x.time) || (x.kind === 'asks_days' && !x.days))) why = 'no rule ended';
        } else if (s.length !== 1 || !one) why = `${s.length} rules`;
        else if (one.kind !== c.expect) why = `kind ${one.kind}`;
        else if (c.threadId !== undefined && one.threadId !== c.threadId) why = `thread ${one.threadId || 'everything'}`;
        else if (c.from && !(one.time >= c.from[0] && one.time <= c.from[1])) why = `time ${one.time || 'none'}`;
        else if (c.days && one.days !== c.days) why = `days ${one.days || 'none'}`;
        else if (c.words && !new RegExp(c.words, 'i').test(one.words)) why = `words "${one.words}"`;
        results.push({ n: c.n, text: c.text, expect: c.expect, pass: !why, why, got });
        console.log(`${c.n} ${why ? 'MISS' : 'ok  '} ${c.expect}: ${c.text}${why ? ` (${why})` : ''}\n      ${got}`);
    }
    const right = results.filter((r) => r.pass).length;
    return { right, of: results.length, pass: right >= 14, results };
}

/** Stage 18: evals/today-words.json, the digest's `today` flag (words that change what is fit to say today). */
async function today() {
    const set = read<{ today: string; weekday: string; cases: Array<{ n: number; text: string; today: boolean; kind: string }> }>('today-words.json');
    const results: Array<{ n: number; text: string; kind: string; expect: boolean; got: boolean; pass: boolean }> = [];
    for (const c of set.cases) {
        const out = await digestOf(c.text, { today: set.today, weekday: set.weekday, at: new Date(`${set.today}T12:10:00Z`).toISOString() });
        results.push({ n: c.n, text: c.text, kind: c.kind, expect: c.today, got: out.today, pass: out.today === c.today });
        console.log(`${c.n} ${out.today === c.today ? 'ok  ' : 'MISS'} ${c.kind} (${c.today ? 'today' : 'not today'}): ${c.text}`);
    }
    const right = results.filter((r) => r.pass).length;
    const controlsMarked = results.filter((r) => r.kind === 'control' && r.got).length;
    return { right, of: results.length, controlsMarked, pass: right >= 21 && controlsMarked <= 2, results };
}

async function main() {
    const [which, out] = process.argv.slice(2);
    let report: unknown;
    if (which === 'today') report = await today();
    else if (which === 'tasks') report = await tasks();
    else if (which === 'screens') report = await screens();
    else if (which === 'lock') report = { asBuilt: await lockSet(LOCK_SYSTEM), before: await lockSet(OLD_LOCK_SYSTEM) };
    else throw new Error('usage: eval-5b.ts <tasks|lock|screens|today> [out.json]');
    const summary = { ranAt: new Date().toISOString(), set: which, costUsd: Number(cost.toFixed(4)), report };
    console.log(JSON.stringify(which === 'lock' ? summary : { ...summary, report: { ...(report as object), results: undefined } }, null, 2));
    if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2));
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
