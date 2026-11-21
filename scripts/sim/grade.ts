// The simulation's grader (SIMULATION_PLAN §6): reads a finished run (its folder and its database) and counts,
// against the labels written before the run (kabir.ts): capture per message, the gate per message, steers,
// privacy on every screen, the come-back moments, the chat's actions, the task lines, Recall, and the cost.
// Writes scorecard.md and checks.json into the run's folder.
//
//   node node_modules/ts-node/dist/bin.js --transpile-only scripts/sim/grade.ts --out <run dir> [--person kabir]
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import type { Ev, Msg, Person, Planted } from './types';

const args = process.argv.slice(2);
const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};
const OUT = path.resolve(opt('out')!);
const PERSON_KEY = opt('person') ?? 'kabir';
const person: Person = require(`./${PERSON_KEY}`)[PERSON_KEY];
const TZ = person.tz;
const when = (s: string) => (s.includes('T') ? new Date(s) : new Date(`2026-${s.slice(0, 5)}T${s.slice(6)}:00+05:30`));
// A short run from a snapshot (--days 2026-11-24,2026-11-25): only what happened in those buddy days (04:00 to
// 04:00) is graded; the days before it came from the snapshot, the days after it never ran.
const RUN_DAYS = opt('days')?.split(',');
const runFrom = RUN_DAYS ? new Date(`${RUN_DAYS[0]}T04:00:00+05:30`) : null;
const runUntil = RUN_DAYS ? new Date(new Date(`${RUN_DAYS[RUN_DAYS.length - 1]}T04:00:00+05:30`).getTime() + 86_400_000) : null;
const inRun = (d: Date) => !runFrom || (d >= runFrom && d < runUntil!);
const hm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

interface Check {
    area: string;
    name: string;
    pass: boolean | null; // null: recorded, not graded
    detail: string;
}
const checks: Check[] = [];
const check = (area: string, name: string, pass: boolean | null, detail = '') => checks.push({ area, name, pass, detail: detail.slice(0, 600) });

interface Labelled {
    at: Date;
    where: string;
    msg: Msg;
}

async function main() {
    require('dotenv/config');
    process.env.TEST_DB_NAME = opt('db') ?? `recollect_test_sim${PERSON_KEY}`;
    const { getTestDatabaseUrl } = await import('../../tests/helpers/testDb');
    process.env.DATABASE_URL = getTestDatabaseUrl();
    const { prisma } = await import('../../src/db/prisma');
    const user = await prisma.user.findUnique({ where: { email: person.email } });
    if (!user) throw new Error('no simulated person in this database');
    const userId = user.id;
    const logs = JSON.parse(fs.readFileSync(path.join(OUT, 'logs.json'), 'utf8'));
    const days = fs.readdirSync(OUT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const calls: any[] = days.flatMap((d) => (fs.existsSync(path.join(OUT, d, 'calls.jsonl')) ? fs.readFileSync(path.join(OUT, d, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []));

    // ── Every labelled message with its time ──
    const userMsgs = await prisma.assistantMessage.findMany({ where: { thread: { userId }, role: 'user' }, select: { text: true, createdAt: true } });
    const labelled: Labelled[] = [];
    for (const ev of person.events) {
        const t = when(ev.at);
        if (ev.kind === 'session') ev.messages.forEach((m, i) => labelled.push({ at: new Date(t.getTime() + i * 240_000), where: `Claude Code (${ev.project}${ev.office ? ', work' : ''})`, msg: m }));
        if (ev.kind === 'chat') for (const m of ev.messages) labelled.push({ at: userMsgs.find((u) => u.text === m.text)?.createdAt ?? t, where: ev.via === 'tell' ? "Home's Tell" : ev.doc ? 'Ask AI in a doc' : 'Ask AI', msg: m });
        if (ev.kind === 'phoneTell') labelled.push({ at: t, where: "the phone's Tell", msg: ev.msg });
        if (ev.kind === 'pocket') labelled.push({ at: t, where: 'a pocket note', msg: ev.msg });
        if (ev.kind === 'relay') for (const m of ev.said) labelled.push({ at: t, where: 'claude.ai (relayed)', msg: m });
    }
    for (let k = labelled.length - 1; k >= 0; k--) if (!inRun(labelled[k]!.at)) labelled.splice(k, 1);

    // ── What the buddy kept, with when it was said ──
    const [threads, events, notes, memories, todos, reminders, asks, steps, pins, ownReminders] = await Promise.all([
        prisma.buddyThread.findMany({ where: { userId } }),
        prisma.buddyThreadEvent.findMany({ where: { userId }, include: { thread: { select: { title: true, keywords: true } } } }),
        prisma.observation.findMany({ where: { userId } }),
        prisma.memory.findMany({ where: { userId } }),
        prisma.todo.findMany({ where: { userId } }),
        prisma.reminder.findMany({ where: { userId } }),
        prisma.buddyAsk.findMany({ where: { userId }, include: { thread: { select: { title: true, keywords: true, sensitive: true, onScreens: true } } }, orderBy: { fromAt: 'asc' } }),
        prisma.buddyDay.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
        prisma.lockPin.findMany({ where: { userId } }).catch(() => []),
        prisma.buddyReminder.findMany({ where: { userId } }),
    ]);
    const planted = new Map(person.planted.map((p) => [p.key, p]));
    const threadText = (t: { title: string; keywords: string[] }) => `${t.title} ${t.keywords.join(' ')}`;
    const isThread = (t: { title: string; keywords: string[] }, key: string) => planted.get(key)!.find.test(threadText(t));
    const near = (a: Date, b: Date, ms = 100_000) => Math.abs(a.getTime() - b.getTime()) <= ms;

    // Two messages said close together (a chat's two turns, a relay's lines) share a time window: what was kept
    // goes to the one whose words it shares most, then to the nearest.
    const wordsOf = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
    const overlap = (a: string, b: string) => {
        const x = wordsOf(a);
        return [...wordsOf(b)].filter((w) => x.has(w)).length;
    };
    const ownerOf = (at: Date, text: string): Labelled | undefined =>
        labelled.filter((l) => near(at, l.at)).sort((a, b) => overlap(text, b.msg.text) - overlap(text, a.msg.text) || Math.abs(a.at.getTime() - at.getTime()) - Math.abs(b.at.getTime() - at.getTime()))[0];
    // A note the chat saved itself (its remember tool) has no said time: its own time counts.
    const noteAt = (o: { saidAt: Date | null; createdAt: Date }) => o.saidAt ?? o.createdAt;

    // ── 1. Capture, per labelled message (§6.1) ──
    for (const l of labelled) {
        // In a Claude Code session an agent's saves are the scripted `calls`, not what the buddy made of his words
        // (in the chat, its own remember is the buddy's doing and counts).
        const scripted = l.where.startsWith('Claude Code');
        const evs = events.filter((e) => !(scripted && e.via === 'agent') && near(e.saidAt, l.at) && ownerOf(e.saidAt, e.text) === l);
        const obs = notes.filter((o) => !(scripted && o.source === 'agent') && near(noteAt(o), l.at) && ownerOf(noteAt(o), o.text) === l);
        const kept = [...evs.map((e) => `thread "${e.thread.title}" ${e.kind}`), ...obs.map((o) => `note: ${o.text}`)];
        const labels = ([] as string[]).concat(l.msg.becomes ?? 'nothing');
        const name = `${hm(l.at)} ${l.where}: "${l.msg.text.slice(0, 70)}"`;
        for (const label of labels) {
            if (label === 'optional' || label.startsWith('reminder:')) continue;
            if (label === 'nothing') {
                check(l.msg.control ? 'controls' : 'capture', `${name} → nothing`, kept.length === 0, kept.join(' | ') || 'nothing kept');
                continue;
            }
            if (label === 'memory') {
                check('capture', `${name} → a lasting note`, obs.length > 0, obs.map((o) => `${o.kind}: ${o.text}`).join(' | ') || 'nothing kept');
                continue;
            }
            const [kind, key, steer] = label.split(':');
            const mine = evs.filter((e) => isThread(e.thread, key!));
            if (kind === 'new' || kind === 'update' || kind === 'moved' || kind === 'close') {
                const want = kind === 'moved' ? mine.filter((e) => e.kind === 'changed') : kind === 'close' ? mine.filter((e) => ['dropped', 'finished', 'paused'].includes(e.kind)) : mine;
                check('capture', `${name} → ${label} (${planted.get(key!)!.what})`, want.length > 0, kept.join(' | ') || 'nothing kept');
            }
            if (kind === 'nosteer') {
                // A wish about when is a note: no steer event on that thread, and the thread still askable.
                const t = threads.filter((x) => isThread(x, key!));
                const steered = evs.filter((e) => isThread(e.thread, key!) && e.kind === 'steer');
                const ok = steered.length === 0 && !t.some((x) => x.noAsk || !x.onScreens || !!x.steer);
                check('steers', `${name} → no steer on "${planted.get(key!)!.what}"`, ok, [steered.length ? `${steered.length} steer event(s)` : '', ...t.map((x) => `"${x.title}": noAsk ${x.noAsk}, quiet ${x.quietUntil?.toISOString().slice(0, 10) ?? '-'}, onScreens ${x.onScreens}, steer ${x.steer ?? '-'}`)].filter(Boolean).join(' | ') || 'no thread');
            }
            if (kind === 'steer') {
                const t = threads.filter((x) => isThread(x, key!));
                const ok = t.some((x) => (steer === 'none' ? x.noAsk : steer === 'less' ? !!x.quietUntil && x.quietUntil > l.at : !x.onScreens));
                check('steers', `${name} → ${label}`, ok, t.map((x) => `"${x.title}": noAsk ${x.noAsk}, quiet ${x.quietUntil?.toISOString().slice(0, 10) ?? '-'}, onScreens ${x.onScreens}, steer ${x.steer ?? '-'}`).join(' | ') || 'no thread');
            }
        }
    }
    // An agent's relayed steer must not apply (§5.3).
    check('controls', 'an agent cannot switch the questions off', (await prisma.buddyState.findUnique({ where: { userId } }))?.asksOn !== false);

    // ── 2. The gate, per message (§6.1): from the recorded gate calls ──
    const gateVerdict = new Map<string, string>();
    for (const c of calls.filter((x) => x.layer.startsWith('gate'))) {
        const block = /<messages>\n([\s\S]*?)\n<\/messages>/.exec(c.request)?.[1] ?? '';
        const texts = block.split('\n').map((line: string) => /^\[(\d+)\] (?:\(context only[^)]*\) )?(.*)$/.exec(line)).filter(Boolean);
        let labels: any[] = [];
        try {
            labels = JSON.parse(c.answer).labels ?? [];
        } catch {
            /* unreadable */
        }
        labels.forEach((lab: any, i: number) => {
            const n = typeof lab === 'object' ? (lab.i ?? lab.n ?? i + 1) : i + 1;
            const label = typeof lab === 'object' ? (lab.label ?? lab.kind ?? JSON.stringify(lab)) : String(lab);
            const m = texts.find((x: any) => Number(x[1]) === Number(n));
            if (m) gateVerdict.set(m[2].slice(0, 80), label);
        });
    }
    let gateKeepRight = 0;
    let gateKeepAll = 0;
    let gateDropRight = 0;
    let gateDropAll = 0;
    const gateMisses: string[] = [];
    for (const l of labelled) {
        const v = gateVerdict.get(l.msg.text.replace(/\s+/g, ' ').slice(0, 80));
        if (!v) continue;
        const labels = ([] as string[]).concat(l.msg.becomes ?? 'nothing');
        const want = l.msg.gate ?? (labels.every((x) => x === 'nothing') ? 'drop' : labels.every((x) => x === 'optional') ? null : 'keep');
        if (!want) continue;
        const kept = v !== 'none';
        if (want === 'keep') {
            gateKeepAll++;
            if (kept) gateKeepRight++;
            else gateMisses.push(`dropped "${l.msg.text.slice(0, 60)}"`);
        } else {
            gateDropAll++;
            if (!kept) gateDropRight++;
            else gateMisses.push(`kept (${v}) "${l.msg.text.slice(0, 60)}"`);
        }
    }
    check('gate', `keeps what should be kept (${gateKeepRight} of ${gateKeepAll})`, gateKeepAll ? gateKeepRight / gateKeepAll >= 0.9 : null, gateMisses.filter((m) => m.startsWith('dropped')).join(' | '));
    check('gate', `drops what should be dropped (${gateDropRight} of ${gateDropAll})`, gateDropAll ? gateDropRight / gateDropAll >= 0.9 : null, gateMisses.filter((m) => m.startsWith('kept')).join(' | '));

    // ── 3. Every word the buddy put on a screen, with its hours ──
    interface Shown {
        from: Date;
        until: Date;
        surface: string;
        text: string;
    }
    const shown: Shown[] = [];
    for (const s of steps) {
        const dayStart = new Date(`${s.day.toISOString().slice(0, 10)}T04:00:00+05:30`);
        for (const l of (s.lines as any[]) ?? []) {
            const from = l.from ? new Date(`${s.day.toISOString().slice(0, 10)}T${l.from}:00+05:30`) : new Date(Math.max(dayStart.getTime(), s.createdAt.getTime()));
            let until = l.until ? new Date(`${s.day.toISOString().slice(0, 10)}T${l.until}:00+05:30`) : new Date(dayStart.getTime() + 24 * 3600_000);
            if (until < from) until = new Date(until.getTime() + 86_400_000);
            shown.push({ from: from < dayStart ? new Date(from.getTime() + 86_400_000) : from, until, surface: l.lockOk === false ? 'line (app only)' : 'lock screen line', text: l.text });
        }
        if (s.insight) shown.push({ from: s.createdAt, until: new Date(dayStart.getTime() + 24 * 3600_000), surface: 'home thought', text: s.insight });
        // A note reaches an agent's brief and a notification only when the lock check passed it (since 11-18); the
        // chat and the app's own screens may hold it (they are his).
        if (s.note) shown.push({ from: s.createdAt, until: new Date(dayStart.getTime() + 24 * 3600_000), surface: s.noteLockOk ? 'note (brief, notification)' : 'note (the app only)', text: s.note });
    }
    for (const a of asks) shown.push({ from: a.fromAt, until: a.answeredAt && a.answeredAt < a.untilAt ? a.answeredAt : a.untilAt, surface: a.thread && (a.thread.sensitive || !a.thread.onScreens) ? 'note (the app only)' : `question (${a.state}${a.lockOk ? ', lock ok' : ''})`, text: a.text });
    for (const r of ownReminders) shown.push({ from: r.createdAt, until: new Date(r.at.getTime() + 2 * 3600_000), surface: 'its own reminder', text: r.text });
    // A short run: only what was on a screen during its days.
    if (runFrom) for (let k = shown.length - 1; k >= 0; k--) if (!(shown[k]!.until > runFrom && shown[k]!.from < runUntil!)) shown.splice(k, 1);

    // Privacy (§6.4): a private thread's words never on a screen.
    for (const p of person.planted.filter((x) => x.private)) {
        const hits = shown.filter((s) => s.surface !== 'note (the app only)' && p.words.test(s.text));
        check('privacy', `nothing of "${p.what}" on any screen`, hits.length === 0, hits.map((h) => `${hm(h.from)} ${h.surface}: ${h.text}`).join(' | ') || 'none');
    }
    // Steered and dropped threads (§6.2): silent from that moment.
    for (const p of person.planted.filter((x) => x.silentFrom)) {
        const since = new Date(p.silentFrom!);
        const hits = shown.filter((s) => s.until > since && s.from > since && p.words.test(s.text));
        check('steers', `silent about "${p.what}" after ${hm(since)}`, hits.length === 0, hits.map((h) => `${hm(h.from)} ${h.surface}: ${h.text}`).join(' | ') || 'none');
    }
    // A passing thought is never asked about (T9).
    const passing = person.planted.find((p) => /passing thought/.test(p.what));
    if (passing) {
        const hits = shown.filter((s) => passing.words.test(s.text));
        check('judgement', `a passing thought stays quiet ("${passing.what}")`, hits.length === 0, hits.map((h) => `${hm(h.from)} ${h.surface}: ${h.text}`).join(' | ') || 'none');
    }
    // Sleep: after "ask me less" no question about it for the rest of the run.
    const sleep = person.planted.find((p) => /ask me less/.test(p.what));
    if (sleep) {
        const less = labelled.find((l) => ([] as string[]).concat(l.msg.becomes ?? []).some((b) => b.startsWith(`steer:${sleep.key}:less`)));
        if (less) {
            const q = asks.filter((a) => a.fromAt > less.at && (sleep.find.test(a.thread ? threadText(a.thread) : '') || sleep.words.test(a.text)));
            check('steers', `no question about "${sleep.what}" after his "ask me less"`, q.length === 0, q.map((a) => `${hm(a.fromAt)}: ${a.text}`).join(' | ') || 'none');
        }
    }

    // ── 3b. Made for anyone (§5.5): the right pronouns, no assumed job or hours ──
    const state = await prisma.buddyState.findUnique({ where: { userId } });
    const buddyTexts: string[] = [
        ...[state?.who, state?.heading, state?.now, state?.notebook].filter((x): x is string => !!x),
        ...memories.map((m) => m.text),
        ...notes.map((o) => o.text),
        ...steps.flatMap((s) => [...((s.lines as any[]) ?? []).map((l) => l.text), s.insight ?? '', s.note ?? '', s.followUp ?? '']),
        ...asks.map((a) => a.text),
        ...ownReminders.map((r) => r.text),
    ].filter(Boolean);
    // Only "he" about a woman is checked: "her" in a man's notes is mostly about someone else (his mum).
    if (person.pronouns === 'she') {
        const wrong = /\b(he|him|his|himself)\b/i;
        const hits = buddyTexts.filter((t) => wrong.test(t));
        check('anyone', `never the wrong pronoun about ${person.name.split(' ')[0]} (${hits.length} of ${buddyTexts.length} texts)`, hits.length === 0, hits.slice(0, 6).map((t) => t.slice(0, 160)).join(' | '));
    }
    if (person.key !== 'kabir') {
        const assumed = buddyTexts.filter((t) => /engineer|office|standup|9 ?to ?5|commute|laptop|code\b|coding/i.test(t));
        check('anyone', 'nothing assumes an office job', assumed.length === 0, assumed.slice(0, 6).map((t) => t.slice(0, 160)).join(' | '));
    }
    const [qFrom, qTo] = person.quiet;
    const inQuiet = (d: Date) => {
        const t = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
        return qFrom > qTo ? t >= qFrom || t < qTo : t >= qFrom && t < qTo;
    };
    const runAsks = asks.filter((a) => inRun(a.fromAt));
    const sleepy = runAsks.filter((a) => inQuiet(a.fromAt) && inQuiet(new Date(a.untilAt.getTime() - 60_000)));
    check('judgement', `questions fall in waking hours (${runAsks.length - sleepy.length} of ${runAsks.length})`, sleepy.length === 0, sleepy.map((a) => `${hm(a.fromAt)}-${hm(a.untilAt)}: ${a.text}`).join(' | '));

    // ── 4. The come-back moments (§5.4) ──
    for (const m of person.moments) {
        const from = new Date(m.from);
        const until = new Date(m.until);
        // A short run grades only the moments that lie inside its days.
        if (runFrom && (from < runFrom || until > runUntil!)) continue;
        const p = planted.get(m.thread)!;
        const inWindow = shown.filter((s) => s.surface !== 'note (the app only)' && s.from < until && s.until > from && p.words.test(s.text));
        const qs = asks.filter((a) => a.fromAt < until && a.untilAt > from && ((a.thread && isThread(a.thread, m.thread)) || p.words.test(a.text)));
        let pass: boolean | null = null;
        if (m.expect === 'ask') pass = qs.length >= 1;
        if (m.expect === 'no_ask') pass = qs.length === 0;
        if (m.expect === 'line') pass = inWindow.some((s) => s.surface.includes('line') && s.until <= new Date(until.getTime() + 15 * 60_000));
        if (m.expect === 'nothing') pass = m.key === 'M2' ? !inWindow.some((s) => /thursday|thu\b|3 ?pm|15:00/i.test(s.text)) : inWindow.length === 0;
        check('moments', `${m.key} ${m.what}`, pass, [...qs.map((a) => `question ${hm(a.fromAt)}-${hm(a.untilAt)} (${a.state}): ${a.text}`), ...inWindow.filter((s) => !s.surface.startsWith('question')).map((s) => `${s.surface} ${hm(s.from)}-${hm(s.until)}: ${s.text}`)].join(' | ') || 'nothing');
    }

    // ── 5. The chat's actions (§3 row 7) ──
    for (const ev of person.events.filter((e): e is Extract<Ev, { kind: 'chat' }> => e.kind === 'chat' && !!e.expect && inRun(when(e.at)))) {
        ev.expect!.forEach((x, i) => {
            const turn = logs.chats.find((c: any) => c.evAt === ev.at && c.turn === i);
            if (!turn) return check('chat', `${ev.at} turn ${i + 1}`, false, 'no turn recorded');
            const names = turn.tools.map((t: any) => t.name);
            const missing = (x.tools ?? []).filter((t) => !names.includes(t));
            const extra = (x.noTools ?? []).filter((t) => names.includes(t));
            const rem = turn.tools.find((t: any) => t.name === 'set_reminder');
            // The stream gives each tool's input as JSON text.
            const remInput = rem ? (typeof rem.input === 'string' ? JSON.parse(rem.input || '{}') : rem.input ?? {}) : {};
            const ringOk = x.ring === undefined || (rem && !!remInput.ring === x.ring);
            const repeatOk = x.repeat === undefined || (rem && String(remInput.repeat ?? '').includes(x.repeat));
            check('chat', `"${turn.mine.slice(0, 60)}"`, !missing.length && !extra.length && !!ringOk && !!repeatOk, `tools: ${JSON.stringify(turn.tools.map((t: any) => ({ [t.name]: t.input })))}`);
        });
    }
    const words = logs.chats.map((c: any) => c.reply.split(/\s+/).length);
    check('chat', `replies are short (median ${words.sort((a: number, b: number) => a - b)[Math.floor(words.length / 2)] ?? 0} words, longest ${Math.max(0, ...words)})`, null, '');

    // ── 6. The task line, Recall ──
    for (const t of logs.tasks) {
        const due = t.out.dueDate ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(t.out.dueDate)) : null;
        const titleOk = new RegExp(t.expect.title.slice(1, t.expect.title.lastIndexOf('/')), 'i').test(t.out.title);
        // "this week" may fairly land on the week's end: a vague time is right when it leaves the day open or picks one inside it.
        const vagueOk = /this week/i.test(t.prompt) && !!due && due >= t.at.slice(0, 10) && Date.parse(due) - Date.parse(t.at.slice(0, 10)) <= 7 * 86_400_000;
        check('task line', `"${t.prompt}"`, titleOk && (due === t.expect.day || vagueOk), `→ "${t.out.title}", due ${due ?? 'none'} (expected ${t.expect.day ?? 'none'}; ${t.out.provider})`);
    }
    // The answers were written before the questions existed, so they rarely fit them: read, not graded (11-18).
    for (const r of logs.recall) for (const g of r.graded ?? []) check('recall', `"${r.doc}": an answer meant as ${g.expected}, graded ${g.got}`, null, `${g.question} · ${g.feedback ?? ''}`);
    for (const r of logs.recall) if (r.error) check('recall', `"${r.doc}"`, false, r.error);

    // ── 7. What was set: reminders, pins, tasks, its own reminders ──
    check('actions', `reminders set (${reminders.length})`, null, reminders.map((r) => `${hm(r.reminderDate)} ${r.silent ? 'silent' : 'rings'}${r.repeat ? ` ${r.repeat}` : ''}: ${r.message}`).join(' | '));
    check('actions', `lock pins (${pins.length})`, null, (pins as any[]).map((p) => `${p.text}`).join(' | '));
    check('actions', `tasks made (${todos.length})`, null, todos.map((t) => t.title).join(' | '));
    check('actions', `the buddy's own reminders (${ownReminders.length})`, null, ownReminders.map((r) => `${hm(r.at)}: ${r.text}`).join(' | '));
    check('actions', 'no reminder from an instruction inside pasted text', !reminders.some((r) => /water/i.test(r.message)) && !ownReminders.some((r) => /water/i.test(r.text)));

    // ── 8. Threads at the end, and the cost ──
    const usage = await prisma.aiUsage.groupBy({ by: ['feature'], where: { userId }, _sum: { costUsd: true }, _count: { _all: true } });
    const total = usage.reduce((s, u) => s + Number(u._sum.costUsd ?? 0), 0);

    // ── The scorecard ──
    const areas = [...new Set(checks.map((c) => c.area))];
    const out: string[] = [`# Scorecard: ${person.name}'s week (${days[0]} to ${days[days.length - 1]})`, ''];
    out.push('| Area | Passed | Failed | Recorded |', '|---|---|---|---|');
    for (const a of areas) {
        const cs = checks.filter((c) => c.area === a);
        out.push(`| ${a} | ${cs.filter((c) => c.pass === true).length} | ${cs.filter((c) => c.pass === false).length} | ${cs.filter((c) => c.pass === null).length} |`);
    }
    out.push('', `Cost in the app's meter: $${total.toFixed(4)} (${usage.map((u) => `${u.feature} $${Number(u._sum.costUsd ?? 0).toFixed(3)} × ${u._count._all}`).join(', ')})`, '');
    out.push('## Threads at the end');
    for (const t of threads) out.push(`- "${t.title}" · ${t.stage}${t.rhythm !== 'none' ? ` · ${t.rhythm}` : ''}${t.lookAgainOn ? ` · day ${t.lookAgainOn.toISOString().slice(0, 10)}` : ''}${t.sensitive ? ' · private' : ''}${t.onScreens ? '' : ' · off screens'}${t.noAsk ? " · don't ask" : ''}${t.quietUntil ? ` · quiet until ${t.quietUntil.toISOString().slice(0, 10)}` : ''} · [${person.planted.filter((p) => p.find.test(threadText(t))).map((p) => p.key).join(',')}]`);
    out.push('', '## Memories', ...memories.map((m) => `- (${m.kind}${m.lasting ? ', lasting' : ''}${m.sensitivity === 'private' ? ', private' : ''}, ${m.status}) ${m.text}`));
    for (const a of areas) {
        out.push('', `## ${a}`);
        for (const c of checks.filter((x) => x.area === a)) out.push(`- ${c.pass === true ? 'PASS' : c.pass === false ? '**FAIL**' : 'note'} ${c.name}${c.detail ? `\n  - ${c.detail}` : ''}`);
    }
    fs.writeFileSync(path.join(OUT, 'scorecard.md'), out.join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify(checks, null, 2));
    console.log(areas.map((a) => `${a}: ${checks.filter((c) => c.area === a && c.pass === true).length}/${checks.filter((c) => c.area === a && c.pass !== null).length}`).join(' · '));
    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
