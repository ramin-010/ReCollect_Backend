// The loop's journeys with the real models (ECOSYSTEM_V2_PLAN §4.10, stages 3, 4 and 5): an invented person
// through several days on a clock the script moves, through the real intake, digest, night and the
// show-time check, in a database of its own (recollect_test_journeys; no real account is touched).
// Each run writes a readable transcript (what the person said, what the buddy held, what each surface
// showed) and a JSON with every check. A journey passes when every check of a run passes, 3 runs of 3.
//
//   node node_modules/ts-node/dist/bin.js --transpile-only scripts/eval-journeys.ts <outDir> [J1|J2|J3|J4|J5|J6|J7|J9|J9b|J10|J11|J12|J13]... [--runs 3]
//   (PowerShell; about 20 cents a J1 run, 6 cents a J3 run; J2 about 30, J5 20, J7 15. J5 and J13 are judgement
//   journeys: they pass at 4 runs of 5. J4, J9 and J10 are stage 4's: two sources, held words, 60 threads. Stage 5b
//   (the owner's answers): J9b and J11 rewritten (a to-do is a task, an event a thread), J12 the screens, J13 the
//   follow-up; about 15, 30, 25 and 35 cents a run. Stage 17: J14 picking up where they left off, J15 a heads-up
//   with time to act; judgement checks are named "(judgement)" and pass at 2 runs of 3, the code's at 3 of 3. 11-21: J17,
//   J17b and J17c, a Later back at the time shown, once across both screens; a cent or two a run, J17c about 8)
import fs from 'node:fs';
import path from 'node:path';

type Check = { name: string; pass: boolean; detail: string };
type Ctx = Awaited<ReturnType<typeof boot>>;

const TZ = 'Asia/Kolkata';

async function boot() {
    process.env.TEST_DB_NAME = 'recollect_test_journeys';
    const { ensureTestDatabase, getTestDatabaseUrl, migrateTestDatabase } = await import('../tests/helpers/testDb');
    const url = getTestDatabaseUrl();
    await ensureTestDatabase(url);
    migrateTestDatabase(url);
    process.env.DATABASE_URL = url;
    process.env.BUDDY_WORKER = 'off';
    const { prisma } = await import('../src/db/prisma');
    const users = await import('../src/services/users/users.service');
    const state = await import('../src/services/buddy/state.service');
    const capture = await import('../src/services/buddy/capture.service');
    const worker = await import('../src/services/buddy/worker');
    const asks = await import('../src/services/buddy/asks');
    const voice = await import('../src/services/buddy/voice');
    const nightLoop = await import('../src/services/buddy/nightLoop');
    const ambient = await import('../src/services/ambient/ambient.service');
    return { prisma, users, state, capture, worker, asks, voice, nightLoop, ambient };
}

/** One run of a journey: its transcript lines and its checks. */
class Run {
    lines: string[] = [];
    checks: Check[] = [];
    seq = 0;
    costUsd = 0;
    constructor(
        readonly c: Ctx,
        readonly userId: string,
        readonly name: string
    ) {}

    local(at: Date) {
        return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
    }
    check(name: string, pass: boolean, detail = '') {
        this.checks.push({ name, pass, detail });
        this.lines.push(`- ${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    }
    async say(text: string, at: Date) {
        this.seq++;
        this.lines.push('', `### ${this.local(at)}: ${this.name} says`, `> ${text}`);
        await this.c.capture.queueOwnWords(this.userId, { key: 'ask:journey', seq: this.seq, via: 'ask_ai', messages: [{ at: at.toISOString(), text }] }, at);
        const r = await this.c.worker.drainBuddyQueue(new Date(at.getTime() + 30_000));
        await this.spent();
        await this.held(`after the digest (${r.digested} read, ${r.failed} failed)`);
    }
    /** Words from a Claude Code session (the hooks' second protocol); pieces wait 10 minutes to be read together. */
    async hook(key: string, seq: number, messages: Array<{ n: number; at: string; text: string }>, now: Date) {
        const late = messages[0] && Date.parse(messages[0].at) < now.getTime() - 3600_000 ? ` (said ${this.local(new Date(messages[0].at))}, arriving now)` : '';
        this.lines.push('', `### ${this.local(now)}: ${this.name} in Claude Code${late}`, ...messages.map((m) => `> ${m.text}`));
        let told: unknown;
        try {
            told = await this.c.capture.queueWords(this.userId, { sessionKey: key, seq, v: 2, canHold: true, messages }, now);
        } catch (err) {
            told = { refused: (err as { status?: number }).status ?? (err instanceof Error ? err.message : String(err)) };
        }
        this.lines.push(`- the hook was told: ${JSON.stringify(told)}`);
        const r = await this.c.worker.drainBuddyQueue(new Date(now.getTime() + 10 * 60_000 + 1000));
        await this.spent();
        await this.held(`after the digest (${r.digested} read, ${r.failed} failed)`);
        return told;
    }
    /** A note an AI agent saves about the person (its remember tool). */
    async agentNote(text: string, kind: 'win' | 'fact', now: Date) {
        this.lines.push('', `### ${this.local(now)}: an agent saves a note`, `> ${text}`);
        const { rememberNotes } = await import('../src/services/buddy/memory.service');
        await rememberNotes({ userId: this.userId, source: 'agent', agentName: 'music-chat', sessionKey: null, project: null }, [{ text, kind }], now);
        const r = await this.c.worker.drainBuddyQueue(new Date(now.getTime() + 30_000));
        await this.spent();
        await this.held(`after the digest (${r.digested} read, ${r.failed} failed)`);
    }
    async night(at: Date) {
        this.lines.push('', `### ${this.local(at)}: the night`);
        const day = await this.c.worker.nightIfDue(this.userId, at);
        await this.spent();
        if (!day) {
            this.lines.push('(no night ran)');
            return null;
        }
        for (const l of day.lines) this.lines.push(`- line, ${l.from ? `${l.from}-${l.until}` : l.slot}${l.lockOk ? ' (lock screen)' : ''}: ${l.text}`);
        if (day.insight) this.lines.push(`- home thought: ${day.insight}`);
        if (day.note) this.lines.push(`- note: ${day.note}`);
        for (const d of day.dropped) this.lines.push(`- dropped ${d.what}: ${d.why}`);
        const asks = await this.c.prisma.buddyAsk.findMany({ where: { userId: this.userId, buddyDayId: day._id } });
        for (const a of asks) this.lines.push(`- question (${this.local(a.fromAt)} to ${this.local(a.untilAt)}): ${a.text} [${JSON.stringify(a.answers)}]`);
        await this.held('after the night');
        return { day, asks };
    }
    async surfaces(at: Date) {
        const [home, line, phone] = await Promise.all([this.c.asks.openAsks(this.userId, 'web', at), this.c.voice.currentLine(this.userId, at), this.c.ambient.getAmbient(this.userId, at)]);
        this.lines.push('', `### ${this.local(at)}: what shows`, `- Home's question: ${home.map((a) => a.text).join(' | ') || '(none)'}`, `- the line now: ${line?.text ?? '(none)'}`, `- the phone's line: ${phone.line?.text ?? '(none)'}`);
        return { home, line, phone };
    }
    async held(when: string) {
        const p = this.c.prisma;
        const [threads, events, todos, suggestions, notes] = await Promise.all([
            p.buddyThread.findMany({ where: { userId: this.userId }, orderBy: { createdAt: 'asc' } }),
            p.buddyThreadEvent.findMany({ where: { userId: this.userId }, orderBy: { saidAt: 'asc' } }),
            p.todo.count({ where: { userId: this.userId } }),
            p.suggestion.findMany({ where: { userId: this.userId } }),
            p.observation.findMany({ where: { userId: this.userId }, orderBy: { createdAt: 'asc' } }),
        ]);
        this.lines.push(`- held ${when}:`);
        for (const t of threads) {
            this.lines.push(`  - thread "${t.title}" · ${t.stage} · rev ${t.revision}${t.rhythm !== 'none' ? ` · ${t.rhythm}` : ''}${t.sensitive ? ' · private' : ''}`);
            for (const e of events.filter((x) => x.threadId === t.id)) this.lines.push(`    - ${e.forDay.toISOString().slice(0, 10)} ${e.kind}${e.duplicate ? ' (duplicate)' : ''}: ${e.text}`);
        }
        for (const n of notes) this.lines.push(`  - note (${n.kind}): ${n.text}`);
        if (todos) this.lines.push(`  - tasks: ${todos}`);
        for (const s of suggestions) this.lines.push(`  - suggestion (${s.kind}, ${s.status}): ${s.text}`);
    }
    async spent() {
        const rows = await this.c.prisma.aiUsage.findMany({ where: { userId: this.userId } });
        this.costUsd = rows.reduce((s, r) => s + Number(r.costUsd), 0);
    }
}

/** Stage 10 (--own-key): the person brings their own key (the server's key stored as theirs here: the own-key code path, the same bill). */
const OWN_KEY = process.argv.includes('--own-key');
/** Stage 11 (--friend): the person is an invited friend on the server's key through a $5 allowance, not on the allowlist. */
const FRIEND = process.argv.includes('--friend');

async function person(c: Ctx, name: string, tag: string) {
    const email = `${tag}-${Date.now()}@journey.test`;
    // On their own key, or as a friend on an allowance, the server's allowlist does not apply: they are left out of it on purpose.
    if (!OWN_KEY && !FRIEND) process.env.AI_ALLOWED_EMAILS = [process.env.AI_ALLOWED_EMAILS, email].filter(Boolean).join(',');
    const user = await c.users.createUser({ email, name, password: 'not-a-real-login-1' });
    if (FRIEND) {
        if (!process.env.AI_ALLOWED_EMAILS) process.env.AI_ALLOWED_EMAILS = 'nobody-else@journey.test';
        const { giveAllowance } = await import('../src/services/claude/allowance');
        const { aiAccessFor } = await import('../src/services/claude/access');
        await giveAllowance(user.id, 5, null, 'Journey: an invited friend');
        const a = await aiAccessFor(user.id);
        if (a.source !== 'house' || a.state !== 'ok' || !a.allowance) throw new Error(`expected a friend on the server's key, got ${a.source}/${a.state}`);
    }
    if (OWN_KEY) {
        process.env.AI_KEYS_SECRET ||= 'journeys-own-key-secret-not-for-production';
        if (!process.env.AI_ALLOWED_EMAILS) process.env.AI_ALLOWED_EMAILS = 'nobody-else@journey.test';
        const { setOwnKey } = await import('../src/services/claude/ownKeys');
        const { keyFor } = await import('../src/services/claude/access');
        await setOwnKey(user.id, process.env.CLAUDE_API_KEY ?? '');
        const k = await keyFor(user.id);
        if (k.source !== 'own_key') throw new Error(`expected the person's own key, got ${k.source}`);
    }
    await c.state.updateBuddySettings(user.id, { enabled: true, loop: true });
    return user;
}

// Kolkata time (UTC+5:30). J1: Fri 20 Nov 20:00, the night at 05:00, Sun 22 Nov 21:00, Mon 23 Nov 05:00, 19:00, 19:05; Tue 24 Nov 05:00.
const at = (iso: string) => new Date(iso);

/** J1, Maya, a nurse (§4.10): the core. */
async function j1(c: Ctx, r: Run) {
    await r.say('Long week at the ward, three nights in a row and I am wiped. I also want to get back to guitar most evenings. Anyway, what is due tomorrow?', at('2026-11-20T14:30:00Z'));
    let threads = await c.prisma.buddyThread.findMany({ where: { userId: r.userId } });
    const guitar = threads.find((t) => /guitar/i.test(`${t.title} ${t.keywords.join(' ')}`));
    r.check('the passing intention opens one thread', !!guitar && threads.filter((t) => /guitar/i.test(`${t.title} ${t.keywords.join(' ')}`)).length === 1, threads.map((t) => `${t.title} (${t.stage})`).join('; '));
    r.check('it stays noticed', guitar?.stage === 'noticed', guitar?.stage ?? 'none');
    r.check('no task, no suggestion', (await c.prisma.todo.count({ where: { userId: r.userId } })) === 0 && (await c.prisma.suggestion.count({ where: { userId: r.userId } })) === 0);

    await r.night(at('2026-11-20T23:30:00Z'));
    r.check('no question after one mention', (await c.prisma.buddyAsk.count({ where: { userId: r.userId } })) === 0);

    await r.say('Played guitar for fifteen minutes tonight, felt good.', at('2026-11-22T15:30:00Z'));
    threads = await c.prisma.buddyThread.findMany({ where: { userId: r.userId } });
    const after = guitar ? threads.find((t) => t.id === guitar.id) : undefined;
    r.check('the update joins the same thread', !!after && threads.filter((t) => /guitar/i.test(`${t.title} ${t.keywords.join(' ')}`)).length === 1, threads.map((t) => t.title).join('; '));
    r.check('the thread is active', after?.stage === 'active', after?.stage ?? 'none');

    const n4 = await r.night(at('2026-11-22T23:30:00Z'));
    const asked = (n4?.asks ?? []).filter((a) => a.threadId === guitar?.id);
    r.check('the next evening the buddy asks once about it', asked.length === 1, (n4?.asks ?? []).map((a) => a.text).join(' | ') || 'no question');
    const evening = at('2026-11-23T13:30:00Z');
    const shown = await r.surfaces(evening);
    const q = shown.home.find((a) => a.threadId === guitar?.id);
    r.check("Home shows the question in the evening", !!q, shown.home.map((a) => a.text).join(' | ') || 'none');
    if (q) {
        const doneIdx = q.answers.findIndex((a) => a.meaning === 'done');
        await c.asks.answerAsk(r.userId, q._id, doneIdx >= 0 ? { choice: doneIdx } : { text: 'Yes, played for twenty minutes' }, new Date(evening.getTime() + 60_000));
        r.lines.push('', `### ${r.local(new Date(evening.getTime() + 60_000))}: ${r.name} answers "${doneIdx >= 0 ? q.answers[doneIdx]!.label : 'Yes, played for twenty minutes'}"`);
        if (doneIdx < 0) await c.worker.drainBuddyQueue(new Date(evening.getTime() + 90_000));
        const gone = await r.surfaces(new Date(evening.getTime() + 2 * 60_000));
        r.check('the question is gone from Home', !gone.home.some((a) => a.threadId === guitar?.id));
        const aboutGuitar = (t: string | undefined | null) => !!t && /guitar/i.test(t);
        r.check('no line about it shows after the answer', !aboutGuitar(gone.line?.text) && !aboutGuitar(gone.phone.line?.text), `${gone.line?.text ?? '-'} / ${gone.phone.line?.text ?? '-'}`);
    }
    const next = await c.nightLoop.threadsForNight(r.userId, '2026-11-24', at('2026-11-23T23:30:00Z'));
    r.check('the next night knows the answer', /answered|done/i.test(next.block), '');
    // The night after she answered: not the same question two evenings running.
    const n5 = await r.night(at('2026-11-23T23:30:00Z'));
    const again = (n5?.asks ?? []).filter((x) => x.threadId === guitar?.id);
    r.check('no question about it the evening after she answered', again.length === 0, again.map((x) => x.text).join(' | '));
}

/** J3, Lena, a designer (§4.10): a passing thought makes no task and no question. */
async function j3(c: Ctx, r: Run) {
    await r.say('Someday I would love to try pottery. Anyway, can you move my review of the onboarding flow to Friday?', at('2026-11-20T09:30:00Z'));
    const threads = await c.prisma.buddyThread.findMany({ where: { userId: r.userId } });
    r.check('no active thread', !threads.some((t) => t.stage !== 'noticed'), threads.map((t) => `${t.title} (${t.stage})`).join('; ') || 'none');
    r.check('no task, no suggestion', (await c.prisma.todo.count({ where: { userId: r.userId } })) === 0 && (await c.prisma.suggestion.count({ where: { userId: r.userId } })) === 0);
    const n = await r.night(at('2026-11-20T23:30:00Z'));
    r.check('no question', (await c.prisma.buddyAsk.count({ where: { userId: r.userId } })) === 0);
    const words = [...(n?.day.lines ?? []).map((l) => l.text), n?.day.insight ?? '', n?.day.note ?? ''].join(' ');
    r.check('the night says nothing about pottery', !/pottery|ceramic|clay/i.test(words), words.slice(0, 200));
}

/** J6, Lena (§4.10): "stop asking about my diet": no word about it on any surface until she raises it. */
async function j6(c: Ctx, r: Run) {
    await r.say('I am trying to cut sugar, no sweets on weekdays from now on.', at('2026-11-20T09:30:00Z'));
    await r.say('No sweets all day today, felt fine.', at('2026-11-21T16:00:00Z'));
    const t = (await c.prisma.buddyThread.findMany({ where: { userId: r.userId } })).find((x) => /sugar|sweet/i.test(`${x.title} ${x.keywords.join(' ')}`));
    r.check('the plan is a thread, active after her update', t?.stage === 'active', t ? `${t.title} (${t.stage})` : 'none');
    await r.say('Please stop asking me about the sugar thing, I want to just do it quietly.', at('2026-11-21T16:30:00Z'));
    const after = t ? await c.prisma.buddyThread.findUnique({ where: { id: t.id } }) : null;
    r.check('her steer is applied: no questions about it', after?.noAsk === true, after ? `noAsk ${after.noAsk}, steer ${after.steer ?? '-'}` : 'none');
    const n = await r.night(at('2026-11-21T23:30:00Z'));
    const words = [...(n?.day.lines ?? []).map((l) => l.text), n?.day.insight ?? '', n?.day.note ?? '', ...(n?.asks ?? []).map((a) => a.text)].join(' ');
    r.check('the night says nothing about it', !/sugar|sweet/i.test(words), words.slice(0, 200));
    const shown = await r.surfaces(at('2026-11-22T13:30:00Z'));
    r.check('no surface shows it', ![...shown.home.map((a) => a.text), shown.line?.text ?? '', shown.phone.line?.text ?? ''].some((x) => /sugar|sweet/i.test(x)));
}

const dayOf = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : 'none');
/** 05:00 of a stored day (a date at 00:00 UTC) on his clock: the night of that day. */
const nightOfDay = (d: Date) => new Date(d.getTime() - 30 * 60_000);
const threadLike = async (c: Ctx, userId: string, re: RegExp) => (await c.prisma.buddyThread.findMany({ where: { userId } })).find((t) => re.test(`${t.title} ${t.keywords.join(' ')}`));
const asksText = (asks: Array<{ threadId: string | null; text: string }> | undefined) => (asks ?? []).map((a) => a.text).join(' | ') || 'no question';

/** J2, Arjun, a student (§4.10): a plan with a time is silent until its day, then asked; "pushed to May" moves it. */
async function j2(c: Ctx, r: Run) {
    await r.say('My semester ends in February, so I am planning to start the GATE prep course around March. For now, what is due this week?', at('2026-11-20T05:30:00Z'));
    const plan = await threadLike(c, r.userId, /gate|prep|course/i);
    r.check('the plan is a thread with its day in March', dayOf(plan?.lookAgainOn).startsWith('2027-03'), plan ? `${plan.title} · ${plan.stage} · day ${dayOf(plan.lookAgainOn)}` : 'none');
    const n1 = await r.night(at('2026-11-20T23:30:00Z'));
    r.check('no question before its day', !(n1?.asks ?? []).some((a) => a.threadId === plan?.id), asksText(n1?.asks));
    await r.say('Small change: the GATE course got pushed to May because of my exams.', at('2027-02-10T13:30:00Z'));
    const moved = await threadLike(c, r.userId, /gate|prep|course/i);
    r.check('the same thread', !!moved && moved.id === plan?.id, moved ? moved.title : 'none');
    r.check('"pushed to May" moves its day', dayOf(moved?.lookAgainOn).startsWith('2027-05'), dayOf(moved?.lookAgainOn));
    const n2 = await r.night(at('2027-03-01T23:30:00Z'));
    r.check('no question in March any more', !(n2?.asks ?? []).some((a) => a.threadId === moved?.id), asksText(n2?.asks));
    if (moved?.lookAgainOn) {
        const n3 = await r.night(nightOfDay(moved.lookAgainOn));
        const asked = (n3?.asks ?? []).filter((a) => a.threadId === moved.id);
        r.check('on its day it is asked, as a question', asked.length === 1 && /\?\s*$/.test(asked[0]!.text.trim()), asksText(n3?.asks));
        const words = [...(n3?.day.lines ?? []).map((l) => l.text), n3?.day.note ?? '', n3?.day.insight ?? ''].join(' ');
        r.check('never assumes it started', !/\b(started|signed up|enrolled|first class|first lesson)\b/i.test(words), words.slice(0, 200));
    }
}

/** J5, Sam, a new parent (§4.10, a judgement): after "wrecked today, no sleep", the day's question is dropped or softened. */
async function j5(c: Ctx, r: Run) {
    await r.say('Since the baby came I barely move. I want to get back to running three mornings a week, before she wakes up.', at('2026-11-16T03:30:00Z'));
    await r.say('Did a slow 2 km run this morning, it felt great to be out.', at('2026-11-17T03:00:00Z'));
    const run = await threadLike(c, r.userId, /run/i);
    r.check('the running plan is an active thread', run?.stage === 'active', run ? `${run.title} (${run.stage})` : 'none');
    await r.say('Wrecked today. The baby was up all night and I got maybe an hour of sleep.', at('2026-11-17T16:30:00Z'));
    const n = await r.night(at('2026-11-17T23:30:00Z'));
    const asked = (n?.asks ?? []).filter((a) => a.threadId === run?.id);
    const soft = /rest|sleep|easy|if you('re| are) up|no pressure|skip|tired|wrecked|gentle|only if|feel like/i;
    r.check('the question about running is dropped or softened', asked.every((a) => soft.test(a.text)), asksText(asked));
    const words = [...(n?.day.lines ?? []).map((l) => l.text), n?.day.note ?? '', n?.day.insight ?? ''].join(' ');
    r.check('no push to run and no guilt', !/(get|go) (out )?(for )?(a|your) run|don'?t skip|missed|no excuses|push through/i.test(words), words.slice(0, 200));
}

/** J7, Sam (§4.10): a medical worry never reaches a screen; a reading habit may; a new account still has every line checked. */
async function j7(c: Ctx, r: Run) {
    await r.say('My doctor found a lump and I have a biopsy next Tuesday. Honestly I am scared. On a lighter note, I started reading before bed again, twenty pages last night.', at('2026-11-20T05:30:00Z'));
    const medical = await threadLike(c, r.userId, /biopsy|lump|doctor|medical|scan|health/i);
    const reading = await threadLike(c, r.userId, /read/i);
    r.check('the medical worry, if a thread, is private', !medical || medical.sensitive, medical ? `${medical.title} · private ${medical.sensitive}` : 'no thread');
    r.check('the reading habit is a thread, not private', !!reading && !reading.sensitive, reading ? `${reading.title} · private ${reading.sensitive}` : 'none');
    const checksBefore = await c.prisma.aiUsage.count({ where: { userId: r.userId, feature: 'buddy_check' } });
    const n = await r.night(at('2026-11-20T23:30:00Z'));
    const spoken = (n?.day.lines ?? []).filter((l) => l.text.trim());
    const checked = (await c.prisma.aiUsage.count({ where: { userId: r.userId, feature: 'buddy_check' } })) > checksBefore;
    r.check('with no private memory, every line is still checked', !spoken.length && !n?.day.insight && !n?.day.note ? true : checked, `${spoken.length} lines, checked ${checked}`);
    const medicalWords = /biopsy|lump|doctor|scan|cancer|medical|hospital|results|tumou?r|scared/i;
    const lock = spoken.filter((l) => l.lockOk).map((l) => l.text);
    r.check('no lock-screen line names the worry', !lock.some((t) => medicalWords.test(t)), lock.join(' | ') || 'none');
    for (const when of ['2026-11-21T03:30:00Z', '2026-11-21T08:30:00Z', '2026-11-21T14:30:00Z']) {
        const shown = await r.surfaces(at(when));
        r.check(`the phone shows nothing of it (${r.local(at(when))})`, !medicalWords.test(shown.phone.line?.text ?? ''), shown.phone.line?.text ?? '(none)');
    }
}

/** A task of hers whose title matches, with its reminders (stage 5b). */
const taskLike = async (c: Ctx, userId: string, re: RegExp) => (await c.prisma.todo.findMany({ where: { userId }, include: { reminders: true } })).find((t) => re.test(t.title));
/** The day of an instant on his clock (Kolkata). */
const localDay = (d: Date | null | undefined) => (d ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d) : 'none');
const localTime = (d: Date | null | undefined) => (d ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d) : 'none');
const remindersText = (t: { reminders: Array<{ reminderDate: Date; silent: boolean; status: string }> } | undefined) => (t?.reminders ?? []).map((x) => `${localDay(x.reminderDate)} ${localTime(x.reminderDate)}${x.silent ? ' quiet' : ' rings'} ${x.status}`).join('; ') || 'no reminder';

/**
 * J11, Omar, a freelancer (§4.10; stage 5b, the owner's answer): a client deadline is a task (due Friday, a quiet
 * reminder the day before); the wedding is a thread on its day; the gift is a task before it. No question about the
 * wedding before it is over, one at most after it, and it closes by itself a week later.
 */
async function j11(c: Ctx, r: Run) {
    await r.say("The client wants the dashboard redesign delivered by Friday the 27th. Also my cousin's wedding is on December 5th and I still need to sort out a gift.", at('2026-11-23T05:30:00Z'));
    const deadline = await taskLike(c, r.userId, /dashboard|redesign|client/i);
    const gift = await taskLike(c, r.userId, /gift|present/i);
    const wedding = await threadLike(c, r.userId, /wedding|cousin/i);
    r.check('the deadline is a task due Friday the 27th', localDay(deadline?.dueDate) === '2026-11-27', deadline ? `${deadline.title} · due ${localDay(deadline.dueDate)}` : 'no task');
    r.check('its quiet reminder comes early (the day before, 09:00)', !!deadline && deadline.reminders.some((x) => x.silent && localDay(x.reminderDate) === '2026-11-26' && localTime(x.reminderDate) === '09:00'), remindersText(deadline));
    r.check('the deadline is not a thread', !(await threadLike(c, r.userId, /dashboard|redesign|client/i)));
    r.check('the wedding is an event on 5 December', !!wedding && wedding.event && dayOf(wedding.lookAgainOn) === '2026-12-05' && wedding.rhythm === 'none', wedding ? `${wedding.title} · event ${wedding.event} · ${dayOf(wedding.lookAgainOn)}` : 'no thread');
    r.check('the gift is a task before the wedding, with a reminder', !!gift && localDay(gift.dueDate) >= '2026-11-23' && localDay(gift.dueDate) <= '2026-12-05' && gift.reminders.length === 1, gift ? `${gift.title} · due ${localDay(gift.dueDate)} · ${remindersText(gift)}` : 'no task');
    r.check('not on today’s list days ahead', (await c.prisma.todo.count({ where: { userId: r.userId, OR: [{ dueDate: null }, { dueDate: { lt: at('2026-11-23T18:30:00Z') } }] } })) === 0);
    const n1 = await r.night(at('2026-11-23T23:30:00Z'));
    r.check('no question about the wedding before it', !(n1?.asks ?? []).some((a) => a.threadId === wedding?.id), asksText(n1?.asks));
    if (!wedding) return;
    // The wedding's day and the two after it: at most one question, never before the evening of its day.
    const after: Array<{ threadId: string | null; text: string; fromAt: Date }> = [];
    for (const night of ['2026-12-04T23:30:00Z', '2026-12-05T23:30:00Z', '2026-12-06T23:30:00Z']) after.push(...((await r.night(at(night)))?.asks ?? []).filter((a) => a.threadId === wedding.id));
    r.check('at most one question about it after, none before its evening', after.length <= 1 && after.every((a) => a.fromAt.getTime() >= at('2026-12-05T12:30:00Z').getTime()), asksText(after));
    await r.night(at('2026-12-11T23:30:00Z'));
    const closed = await c.prisma.buddyThread.findUnique({ where: { id: wedding.id } });
    r.check('a week after its day it is closed, remembered', closed?.stage === 'done', closed ? closed.stage : 'none');
}

/**
 * J9, second part, Arjun (§4.10; stage 5b): the dentist booking is a task for Monday with a quiet reminder that
 * shows while the credits are out (code needs no AI); "booked it" closes it; the interview that fell due meanwhile
 * is followed up once when the AI is back; nobody says "you've been quiet".
 */
async function j9b(c: Ctx, r: Run) {
    await r.say('I need to book the dentist appointment on Monday, the tooth keeps bugging me. And my job interview is on Monday at 11, wish me luck.', at('2026-11-20T05:30:00Z'));
    const dentist = await taskLike(c, r.userId, /dentist|tooth/i);
    const interview = await threadLike(c, r.userId, /interview/i);
    r.check('the booking is a task due Monday the 23rd', localDay(dentist?.dueDate) === '2026-11-23', dentist ? `${dentist.title} · due ${localDay(dentist.dueDate)}` : 'no task');
    r.check('with a quiet reminder Monday 09:00', !!dentist && dentist.reminders.some((x) => x.silent && localDay(x.reminderDate) === '2026-11-23' && localTime(x.reminderDate) === '09:00'), remindersText(dentist));
    r.check('the interview is an event on Monday at 11', !!interview && interview.event && dayOf(interview.lookAgainOn) === '2026-11-23' && interview.eventMinute === 11 * 60, interview ? `${interview.title} · event ${interview.event} · ${dayOf(interview.lookAgainOn)} ${interview.eventMinute}` : 'no thread');
    const { markKeyOk } = await import('../src/services/claude/access');
    await c.prisma.aiKeyState.upsert({ where: { keyId: 'house' }, create: { keyId: 'house', state: 'no_credit', since: at('2026-11-21T03:00:00Z') }, update: { state: 'no_credit', since: at('2026-11-21T03:00:00Z') } });
    try {
        const paused = await r.night(at('2026-11-22T23:30:00Z'));
        r.check('no night while the credits are out', paused === null);
        // Monday 10:00, the AI still out: the reminder is on the home picture all the same.
        const { homeReminders } = await import('../src/services/ambient/ambient.service');
        const home = await homeReminders(r.userId, at('2026-11-23T04:30:00Z'));
        r.lines.push('', `### ${r.local(at('2026-11-23T04:30:00Z'))}: the home picture's reminders`, ...home.items.map((x) => `- ${x.time} ${x.text}`));
        r.check('Monday morning its reminder shows, the AI out', home.items.some((x) => /dentist|tooth/i.test(x.text)), home.items.map((x) => x.text).join(' | ') || 'none');
    } finally {
        await markKeyOk('house', at('2026-11-24T04:30:00Z'));
    }
    await r.say('Booked the dentist for Thursday. The interview went okay I think.', at('2026-11-24T04:40:00Z'));
    const booked = dentist ? await c.prisma.todo.findUnique({ where: { id: dentist.id } }) : null;
    r.check('"booked it" ticks the task', booked?.status === 'complete', booked ? booked.status : 'no task');
    const n = await r.night(at('2026-11-24T23:30:00Z'));
    const words = [...(n?.day.lines ?? []).map((l) => l.text), n?.day.note ?? '', n?.day.insight ?? '', ...(n?.asks ?? []).map((a) => a.text)].join(' ');
    r.check('nobody says "you have been quiet"', !/been quiet|haven'?t heard|been a while|where have you been|disappeared|gone quiet/i.test(words), words.slice(0, 200));
    const asked = interview ? await c.prisma.buddyAsk.count({ where: { userId: r.userId, threadId: interview.id } }) : 0;
    r.check('the interview is followed up at most once', asked <= 1, `${asked} questions`);
}

/**
 * J12, Lena (stage 5b, part B): the screens that learn. An ordinary routine may reach the lock screen, her sister's
 * news never; "ask me later in the evening" moves the next questions after 19:00; "keep anything about my sister off
 * my lock screen" holds.
 */
async function j12(c: Ctx, r: Run) {
    await r.say("Ran 5k this morning, I'm trying to run three mornings a week. Also my sister is going through a messy divorce and I'm worried about her.", at('2026-11-23T03:30:00Z'));
    const run = await threadLike(c, r.userId, /run|5k/i);
    const sister = await threadLike(c, r.userId, /sister|divorce/i);
    r.check('her sister’s news, if a thread, is private', !sister || sister.sensitive, sister ? `${sister.title} · private ${sister.sensitive}` : 'no thread');
    r.check('her running is a thread, not private', !!run && !run.sensitive, run ? `${run.title} · private ${run.sensitive}` : 'none');
    const n1 = await r.night(at('2026-11-23T23:30:00Z'));
    const lock1 = (n1?.day.lines ?? []).filter((l) => l.lockOk).map((l) => l.text);
    r.check('no lock-screen line names her sister or the divorce', !lock1.some((t) => /sister|divorce|separat|lawyer/i.test(t)), lock1.join(' | ') || 'none');
    await r.say('Can you ask me things later in the evening? Mornings are chaos. And keep anything about my sister off my lock screen.', at('2026-11-24T03:30:00Z'));
    const rule = await c.prisma.buddyScreenRule.findFirst({ where: { userId: r.userId, kind: 'asks_from', endedAt: null } });
    r.check('“later in the evening” is a rule: questions not before the evening', !!rule && rule.fromMin != null && rule.fromMin >= 17 * 60 && rule.fromMin <= 21 * 60, rule ? `from ${rule.fromMin! / 60}h · ${rule.text}` : 'no rule');
    const sisterNow = sister ? await c.prisma.buddyThread.findUnique({ where: { id: sister.id } }) : null;
    r.check('her sister’s thread stays off the screens', !sisterNow || sisterNow.sensitive || !sisterNow.onScreens, sisterNow ? `private ${sisterNow.sensitive} · on screens ${sisterNow.onScreens}` : 'no thread');
    const n2 = await r.night(at('2026-11-24T23:30:00Z'));
    const earliest = (rule?.fromMin ?? 19 * 60) * 60_000;
    const early = (n2?.asks ?? []).filter((a) => a.fromAt.getTime() < new Date(`${localDay(a.fromAt)}T00:00:00+05:30`).getTime() + earliest);
    r.check('the next questions come after her evening hour', early.length === 0, asksText(n2?.asks));
    const lock2 = (n2?.day.lines ?? []).filter((l) => l.lockOk).map((l) => l.text);
    r.check('still nothing about her sister on the lock screen', !lock2.some((t) => /sister|divorce|separat|lawyer/i.test(t)), lock2.join(' | ') || 'none');
}

/**
 * J13, Omar (stage 5b, a judgement: 4 runs of 5): a follow-up must feel useful, not automatic. Labels set before the
 * run: the job interview is asked about once after it (never before); the haircut never; the birthday dinner either.
 */
async function j13(c: Ctx, r: Run) {
    await r.say("Big week. Job interview at Stripe on Wednesday at 2pm, a haircut on Thursday at 6, and my friend Ravi's birthday dinner on Friday night.", at('2026-11-23T04:30:00Z'));
    const interview = await threadLike(c, r.userId, /interview|stripe/i);
    const haircut = await threadLike(c, r.userId, /haircut|hair|barber/i);
    r.check('the interview is an event on Wednesday at 14:00', !!interview && interview.event && dayOf(interview.lookAgainOn) === '2026-11-25' && interview.eventMinute === 14 * 60, interview ? `${interview.title} · ${dayOf(interview.lookAgainOn)} ${interview.eventMinute}` : 'no thread');
    r.check('no task for any of them', (await c.prisma.todo.count({ where: { userId: r.userId } })) === 0);
    const all: Array<{ threadId: string | null; text: string; fromAt: Date }> = [];
    for (const night of ['2026-11-24T23:30:00Z', '2026-11-25T23:30:00Z', '2026-11-26T23:30:00Z', '2026-11-27T23:30:00Z']) {
        all.push(...((await r.night(at(night)))?.asks ?? []));
        // He opens the app that evening (19:00): a question shows, so a question he saw and left counts as asked.
        await r.surfaces(new Date(at(night).getTime() + 14 * 3600_000));
    }
    const aboutInterview = all.filter((a) => a.threadId === interview?.id);
    r.check('the interview is followed up once, after it', aboutInterview.length === 1 && aboutInterview[0]!.fromAt.getTime() >= at('2026-11-25T09:30:00Z').getTime(), asksText(aboutInterview));
    r.check('the haircut is never asked about', !all.some((a) => a.threadId === haircut?.id || /hair/i.test(a.text)), asksText(all.filter((a) => /hair/i.test(a.text) || a.threadId === haircut?.id)));
}

/** J4, Maya (§4.10, stage 4): the same update from two sources counts once; an older word that arrives late only joins the history. */
async function j4(c: Ctx, r: Run) {
    await r.say('I want to get back to guitar, most evenings, even fifteen minutes counts.', at('2026-11-20T14:30:00Z'));
    const guitar = await threadLike(c, r.userId, /guitar/i);
    r.check('the habit is a thread', !!guitar, guitar ? `${guitar.title} (${guitar.stage})` : 'none');
    if (!guitar) return;
    // Sunday evening: her words in a Claude Code session, then an agent's note about the same twenty minutes.
    await r.hook('cc_j4', 1, [{ n: 1, at: '2026-11-22T14:00:00.000Z', text: 'played guitar for twenty minutes before dinner, my fingertips hurt' }], at('2026-11-22T14:00:00Z'));
    await r.agentNote('Played guitar for twenty minutes this evening', 'win', at('2026-11-22T14:20:00Z'));
    const sunday = await c.prisma.buddyThreadEvent.findMany({ where: { threadId: guitar.id, forDay: new Date('2026-11-22T00:00:00Z') }, orderBy: { createdAt: 'asc' } });
    const shown = sunday.map((e) => `${e.kind}${e.direct ? '' : ' (passed on)'}${e.duplicate ? ' (duplicate)' : ''}: ${e.text}`).join('; ') || 'none';
    r.check('her update lands on the habit', sunday.some((e) => e.direct), shown);
    r.check('the agent’s note about the same evening counts once', sunday.filter((e) => !e.duplicate).length === 1, shown);
    // A word said on Friday morning, before she took the habit up, arrives on Monday (held on her laptop): history only.
    const before = await c.prisma.buddyThread.findUniqueOrThrow({ where: { id: guitar.id } });
    await r.hook('cc_j4b', 1, [{ n: 1, at: '2026-11-20T03:00:00.000Z', text: 'honestly might give up on guitar, no time this week' }], at('2026-11-23T03:30:00Z'));
    const after = await c.prisma.buddyThread.findUniqueOrThrow({ where: { id: guitar.id } });
    r.check('an older word arriving late only joins the history', after.stage === before.stage && after.stage !== 'dropped', `${before.stage} → ${after.stage}`);
}

/** J9 (first part), Arjun (§4.10, stage 4): credits out for two days and back; held words are read in order, each on its own day, and nobody says "you have been quiet". */
async function j9(c: Ctx, r: Run) {
    await r.say('Starting the machine learning course this week, one module every two days.', at('2026-11-20T09:30:00Z'));
    const { markKeyOk } = await import('../src/services/claude/access');
    await c.prisma.aiKeyState.upsert({ where: { keyId: 'house' }, create: { keyId: 'house', state: 'no_credit', since: at('2026-11-21T03:00:00Z') }, update: { state: 'no_credit', since: at('2026-11-21T03:00:00Z') } });
    const held = [
        { n: 1, at: '2026-11-21T10:00:00.000Z', text: 'started the ML course today, watched the first two videos' },
        { n: 2, at: '2026-11-22T08:00:00.000Z', text: 'finished module 1 of the ML course, the quiz was easier than I feared' },
    ];
    let refused: unknown;
    try {
        refused = await r.hook('cc_j9', 1, held, at('2026-11-22T12:00:00Z'));
    } finally {
        await markKeyOk('house', at('2026-11-23T04:30:00Z'));
    }
    r.check('her words are held while the credits are out', JSON.stringify(refused).includes('refused'), JSON.stringify(refused));
    await r.hook('cc_j9', 1, held, at('2026-11-23T04:31:00Z'));
    const course = await threadLike(c, r.userId, /course|machine learning|\bml\b|module/i);
    const evs = course ? await c.prisma.buddyThreadEvent.findMany({ where: { threadId: course.id }, orderBy: { saidAt: 'asc' } }) : [];
    const days = evs.filter((e) => e.saidAt.getTime() >= at('2026-11-21T00:00:00Z').getTime()).map((e) => dayOf(e.forDay));
    r.check('the held words are read in order, each on its own day', days.includes('2026-11-21') && days.includes('2026-11-22') && days.indexOf('2026-11-21') < days.lastIndexOf('2026-11-22'), `${course?.title ?? 'no thread'}: ${evs.map((e) => `${dayOf(e.forDay)} ${e.kind}: ${e.text}`).join('; ')}`);
    const n = await r.night(at('2026-11-23T23:30:00Z'));
    const words = [...(n?.day.lines ?? []).map((l) => l.text), n?.day.note ?? '', n?.day.insight ?? '', ...(n?.asks ?? []).map((a) => a.text)].join(' ');
    r.check('nobody says "you have been quiet"', !/been quiet|haven'?t heard|been a while|where have you been|disappeared|gone quiet|went quiet|missed you/i.test(words), words.slice(0, 200) || '(nothing said)');
}

/** J10's sixty open threads (a freelance designer's life): titles and keywords that share no words with each other. */
const J10_THREADS: Array<[string, string[]]> = [
    ['Logo for the bakery client', ['logo', 'bakery', 'branding']],
    ['Invoice the yoga studio', ['invoice', 'yoga', 'billing']],
    ['Renew the portfolio domain', ['domain', 'portfolio', 'renewal']],
    ['Quarterly tax filing', ['tax', 'filing', 'gst']],
    ['Learn Blender for 3D mockups', ['blender', '3d', 'modelling']],
    ['Morning walk before work', ['walk', 'walking', 'steps']],
    ['Call the landlord about the leak', ['landlord', 'leak', 'plumbing']],
    ['Spanish on Tuesday evenings', ['spanish', 'language']],
    ['Website for the bike shop', ['website', 'bike', 'cycling']],
    ['Brochure for the dental clinic', ['brochure', 'dental', 'print']],
    ['Read a novel every month', ['novel', 'reading', 'fiction']],
    ['Meal prep on Sundays', ['meal', 'prep', 'cooking']],
    ["Sister's wedding gift", ['wedding', 'gift', 'sister']],
    ['Replace the laptop battery', ['laptop', 'battery', 'repair']],
    ['Posters for the jazz festival', ['posters', 'jazz', 'festival']],
    ['Newsletter for the coffee roaster', ['newsletter', 'coffee', 'roaster']],
    ['Stretch for the lower back', ['stretch', 'back', 'posture']],
    ['Save up for a new camera', ['camera', 'savings', 'lens']],
    ['Packaging for the tea company', ['packaging', 'tea', 'boxes']],
    ["Pitch deck for Ravi's startup", ['pitch', 'deck', 'startup']],
    ['Six-month dentist checkup', ['dentist', 'checkup', 'teeth']],
    ['Car service is due', ['car', 'service', 'mechanic']],
    ['Visa papers for the Lisbon trip', ['visa', 'lisbon', 'passport']],
    ['Instagram content calendar', ['instagram', 'content', 'posts']],
    ['Learn Figma auto layout', ['figma', 'autolayout', 'components']],
    ['Gym three times a week', ['gym', 'weights', 'workout']],
    ['Menu redesign for the cafe', ['menu', 'cafe', 'restaurant']],
    ["Mum's birthday dinner", ['birthday', 'mum', 'dinner']],
    ['Typeface licence for the agency', ['typeface', 'licence', 'fonts']],
    ['Sleep before midnight', ['sleep', 'bedtime', 'night']],
    ['Album cover for the indie band', ['album', 'cover', 'band']],
    ['Signage for the hotel lobby', ['signage', 'hotel', 'lobby']],
    ['Photography course', ['photography', 'photos', 'exposure']],
    ['Annual report for the NGO', ['annual', 'report', 'ngo']],
    ['Repaint the balcony railing', ['balcony', 'paint', 'railing']],
    ['Icons for the payments app', ['icons', 'payments', 'fintech']],
    ['Drink more water', ['water', 'hydration']],
    ['Invitations for the Mehta engagement', ['invitations', 'engagement', 'mehta']],
    ['Chess club on Thursdays', ['chess', 'club', 'thursday']],
    ['Move to a bigger flat', ['flat', 'moving', 'rent']],
    ['Style guide for the gin distillery', ['styleguide', 'gin', 'distillery']],
    ['Driving test in January', ['driving', 'test', 'january']],
    ['Herbs on the windowsill', ['herbs', 'windowsill', 'basil']],
    ['Ebook jacket for the author', ['ebook', 'jacket', 'author']],
    ['Volunteer at the animal shelter', ['volunteer', 'shelter', 'animals']],
    ['Update the CV', ['cv', 'resume']],
    ['T-shirts for the city marathon', ['tshirts', 'marathon', 'city']],
    ['Raise my day rate', ['rate', 'pricing', 'fees']],
    ['Label for the hot sauce', ['label', 'sauce', 'chilli']],
    ['Guitar practice', ['guitar', 'chords']],
    ['Archive the old hard drive', ['archive', 'harddrive', 'storage']],
    ['Infographic for the climate nonprofit', ['infographic', 'climate', 'nonprofit']],
    ["Dad's knee surgery", ['knee', 'surgery', 'dad']],
    ['Merch for the podcast', ['merch', 'podcast']],
    ['Monthly budget sheet', ['budget', 'spreadsheet', 'expenses']],
    ['Storyboard for the explainer video', ['storyboard', 'explainer', 'video']],
    ['10k run in March', ['10k', 'running', 'race']],
    ['Mural for the school wall', ['mural', 'school', 'wall']],
    ['Business cards for the architect', ['businesscards', 'architect']],
    ['Thai curry night for friends', ['thai', 'curry', 'friends']],
];

/** J10, Omar, a freelancer (§4.10, stage 4): among 60 open threads an update in other words finds its own (the oldest); a word about a dropped one opens it again. */
async function j10(c: Ctx, r: Run) {
    const { withPersonLock, openOrFindThread } = await import('../src/services/buddy/threads');
    const now = at('2026-11-20T09:00:00Z');
    const ids = new Map<string, string>();
    await withPersonLock(r.userId, async (tx) => {
        for (const [i, [title, keywords]] of J10_THREADS.entries()) {
            // The bakery logo is the oldest (50 days); the rest from 1 to 40 days ago.
            const saidAt = new Date(now.getTime() - (i === 0 ? 50 : 1 + (i % 40)) * 86_400_000);
            ids.set(title, (await openOrFindThread(tx, r.userId, { title, keywords }, { saidAt, forDay: dayOf(saidAt) as never }, now)).thread.id);
        }
        const pottery = (await openOrFindThread(tx, r.userId, { title: 'Weekend pottery class', keywords: ['pottery', 'ceramics', 'clay'] }, { saidAt: new Date(now.getTime() - 40 * 86_400_000), forDay: '2026-10-11' as never }, now)).thread;
        await tx.buddyThread.update({ where: { id: pottery.id }, data: { stage: 'dropped', closedAt: new Date(now.getTime() - 10 * 86_400_000) } });
        ids.set('pottery', pottery.id);
    });
    await c.prisma.buddyThread.updateMany({ where: { userId: r.userId, stage: 'noticed' }, data: { stage: 'active' } });
    const start = await c.prisma.buddyThread.count({ where: { userId: r.userId } });
    r.check('61 threads to start with (60 open, one dropped)', start === 61, String(start));
    r.lines.push('', `(the threads: ${J10_THREADS.map(([t]) => t).join(' · ')} · Weekend pottery class, dropped 10 days ago)`);
    await r.say('sent the final files to the cake shop people today, they loved the new mark', at('2026-11-20T09:30:00Z'));
    await r.say('also signed up for the clay workshop again, Saturday mornings', at('2026-11-20T09:40:00Z'));
    const logoId = ids.get(J10_THREADS[0]![0])!;
    const onLogo = await c.prisma.buddyThreadEvent.findMany({ where: { threadId: logoId, saidAt: { gte: now } } });
    const all = await c.prisma.buddyThread.findMany({ where: { userId: r.userId } });
    const known = new Set(ids.values());
    const fresh = all.filter((t) => !known.has(t.id));
    r.check('the update in other words finds its own thread (the oldest of 60)', onLogo.length >= 1, `${onLogo.map((e) => `${e.kind}: ${e.text}`).join('; ') || 'nothing on it'}; new threads: ${fresh.map((t) => t.title).join('; ') || 'none'}`);
    const pottery = all.find((t) => t.id === ids.get('pottery'));
    r.check('a word about the dropped one opens it again', !!pottery && pottery.stage !== 'dropped' && !pottery.closedAt, pottery ? `${pottery.title}: ${pottery.stage}` : 'gone');
    r.check('no new thread', fresh.length === 0, fresh.map((t) => t.title).join('; ') || 'none');
}

/** Kolkata wall time on a day of November 2026. */
const ist = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
const minuteOfLine = (hhmm: string | undefined) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};

/**
 * J14, Riya (stage 17): picking up where they left off. Five evenings of study around 20:45, and on Tuesday a practice
 * problem, 3Sum, left unsolved with where they stopped. Wednesday's night may bring it back in the evening, in their
 * terms (judgement: 2 of 3 runs). Code holds the rest in every run: a study session started just before the line's hours
 * takes it off; solved, it never shows; Thursday says nothing about it (never two days running).
 */
async function j14(c: Ctx, r: Run) {
    const p = c.prisma;
    const day = (d: string) => new Date(`${d}T00:00:00Z`);
    for (const [i, d] of ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-16'].entries()) {
        await p.workSession.create({ data: { userId: r.userId, key: `s_j14_${i}`, kind: 'study', day: day(d), startedAt: ist(d, `20:4${i}`), endedAt: ist(d, '21:30'), minutes: 48, title: 'Evening study: DSA patterns', source: 'agent', updatedAt: ist(d, '21:30') } });
    }
    const sum = await p.workSession.create({
        data: { userId: r.userId, key: 's_j14_3sum:1', kind: 'practice', day: day('2026-11-17'), startedAt: ist('2026-11-17', '21:00'), endedAt: ist('2026-11-17', '21:40'), minutes: 40, title: '3Sum', problem: '3Sum', nextStep: 'has the two-pointer idea; duplicates still break it', source: 'agent', updatedAt: ist('2026-11-17', '21:40') },
    });
    const pu = `pu_${sum.id}`;
    r.lines.push('', '(seeded: study sessions 11-16 Nov around 20:45; Tue 17 Nov 21:00 practice "3Sum", no outcome, next step "has the two-pointer idea; duplicates still break it")');
    const n1 = await r.night(ist('2026-11-18', '05:00'));
    const lines = n1?.day.lines ?? [];
    const line = lines.find((l) => (l.refs ?? []).includes(pu)) ?? lines.find((l) => /3\s?sum/i.test(l.text));
    const from = minuteOfLine(line?.from);
    r.check(
        '(judgement) Wednesday: a line starting 19:30-21:30 names 3Sum and where they stopped, resting on it',
        !!line && /3\s?sum/i.test(line.text) && /duplicat|two.pointer|pointer/i.test(line.text) && (line.refs ?? []).includes(pu) && from >= 19 * 60 + 30 && from <= 21 * 60 + 30,
        line ? `${line.from}-${line.until}: ${line.text} · refs ${JSON.stringify(line.refs ?? [])}` : 'no line about it'
    );
    if (line?.from && (line.refs ?? []).includes(pu)) {
        const start = ist('2026-11-18', line.from);
        const during = new Date(start.getTime() + 5 * 60_000);
        const shown = await c.voice.currentLine(r.userId, during);
        r.check('it shows in its hours', shown?.text === line.text, shown?.text ?? 'nothing shows');
        const other = await p.workSession.create({ data: { userId: r.userId, key: 's_j14_now', kind: 'study', day: day('2026-11-18'), startedAt: new Date(start.getTime() - 30 * 60_000), minutes: 10, title: 'Heaps', source: 'agent', updatedAt: new Date(start.getTime() - 20 * 60_000) } });
        const busy = await c.voice.currentLine(r.userId, during);
        r.check('a study session started just before its hours takes it off (no pulse)', busy === null, busy?.text ?? 'gone');
        await p.workSession.delete({ where: { id: other.id } });
        await p.workSession.update({ where: { id: sum.id }, data: { outcome: 'alone' } });
        const solved = await c.voice.currentLine(r.userId, during);
        r.check('solved in the afternoon, it never shows', solved === null, solved?.text ?? 'gone');
        await p.workSession.update({ where: { id: sum.id }, data: { outcome: null } });
    }
    const n2 = await r.night(ist('2026-11-19', '05:00'));
    const again = (n2?.day.lines ?? []).filter((l) => (l.refs ?? []).includes(pu) || /3\s?sum/i.test(l.text));
    const raisedWed = !!line && (line.refs ?? []).includes(pu);
    r.check('Thursday: nothing about it after Wednesday’s line (never two days running)', !raisedWed || again.length === 0, again.map((l) => l.text).join(' | ') || (raisedWed ? 'none' : 'Wednesday had no line about it'));
}

/**
 * J15, Kabir (stage 17): a heads-up while there is still time. Monday, in their own words: "my sister's birthday is on
 * Sunday, I still need to get her something". By code in every run: Coming up lists the gift from Tuesday; after
 * "ordered the gift" on Thursday evening the task is ticked and no words about it remain. Judgement (2 of 3 runs): a
 * line or the home thought raises the gift on Wednesday or Thursday, before its own reminder's day.
 */
async function j15(c: Ctx, r: Run) {
    await r.say("My sister's birthday is on Sunday and I still need to get her something.", ist('2026-11-23', '09:30'));
    const gift = await taskLike(c, r.userId, /gift|present|something|sister/i);
    r.check('the gift is a task due before Sunday is over, with its reminder', !!gift && localDay(gift.dueDate) >= '2026-11-23' && localDay(gift.dueDate) <= '2026-11-29', gift ? `${gift.title} · due ${localDay(gift.dueDate)} · ${remindersText(gift)}` : 'no task');
    if (!gift) return;
    const { aheadFor } = await import('../src/services/ahead/ahead.service');
    const tuesday = await aheadFor(r.userId, ist('2026-11-24', '09:00'), { aheadMax: 8 });
    r.lines.push('', `### ${r.local(ist('2026-11-24', '09:00'))}: Coming up`, ...tuesday.comingUp.map((x) => `- ${x.at} · ${x.text}`));
    r.check('Coming up lists the gift from Tuesday', tuesday.comingUp.some((x) => x.id === `tk_${gift.id}`), tuesday.comingUp.map((x) => `${x.at} ${x.text}`).join(' | ') || 'empty');
    const tk = `tk_${gift.id}`;
    const words: string[] = [];
    for (const d of ['2026-11-25', '2026-11-26']) {
        const n = await r.night(ist(d, '05:00'));
        const about = [...(n?.day.lines ?? []).filter((l) => (l.refs ?? []).includes(tk) || /gift|present/i.test(l.text)).map((l) => `${d} line ${l.from}: ${l.text}`), ...(n?.day.insight && /gift|present|birthday/i.test(n.day.insight) ? [`${d} home: ${n.day.insight}`] : [])];
        words.push(...about);
    }
    r.check('(judgement) a line or the home thought raises the gift on Wednesday or Thursday, before its reminder’s day', words.length > 0, words.join(' | ') || 'nothing about it');
    await r.say('Ordered the gift for my sister, it arrives Saturday.', ist('2026-11-26', '20:00'));
    const after = await c.prisma.todo.findUnique({ where: { id: gift.id } });
    r.check('"ordered the gift" ticks the task', after?.status === 'complete', after?.status ?? 'gone');
    const shows = await c.ambient.getAmbient(r.userId, ist('2026-11-26', '20:10'));
    const left = [shows.line?.text ?? '', shows.insight ?? '', ...(shows.comingUp ?? []).map((x) => x.text), ...(shows.today ?? []).map((x) => x.text)].filter((t) => /gift|present/i.test(t));
    r.check('no words about the gift remain on the screens', left.length === 0, left.join(' | ') || 'none');
    await r.night(ist('2026-11-27', '05:00'));
}

/** Stage 18: a step already written today (a night, or a pulse), seeded so a journey starts mid-day for free. */
async function seedStep(c: Ctx, userId: string, day: string, kind: 'night' | 'pulse', hhmm: string, lines: Array<{ from: string; until: string; text: string }>) {
    await c.prisma.buddyDay.create({
        data: {
            userId,
            day: new Date(`${day}T00:00:00Z`),
            kind,
            lines: lines.map((l) => ({ slot: Number(l.from.slice(0, 2)) >= 18 ? 'evening' : Number(l.from.slice(0, 2)) >= 12 ? 'afternoon' : 'morning', from: l.from, until: l.until, text: l.text, form: 'push', lockOk: true, sourceId: null })),
            model: 'seeded',
            createdAt: ist(day, hhmm),
        },
    });
}

/** The newest step's words of a day (lines, thought, note), for the checks. */
async function stepWords(c: Ctx, userId: string, day: string) {
    const row = await c.prisma.buddyDay.findFirst({ where: { userId, day: new Date(`${day}T00:00:00Z`) }, orderBy: { createdAt: 'desc' } });
    const lines = ((row?.lines ?? []) as unknown as Array<{ from?: string; until?: string; text: string }>).filter((l) => l.text);
    return { row, lines, all: [...lines.map((l) => l.text), row?.insight ?? '', row?.note ?? ''].filter(Boolean) };
}

/**
 * J16a, Dev (stage 18): a plan for tonight. At 18:40 they tell Buddy "tonight I'm finishing the 3Sum problem, starting
 * at 9". By code: a pulse on it runs within 6 minutes. Judgement (2 of 3): a line whose hours hold 21:00 names it. Next
 * morning's night: nothing says it as a plan for today (a question about last night is fine), 3 of 3.
 */
async function j16a(c: Ctx, r: Run) {
    const { pulseIfDue } = await import('../src/services/buddy/pulse');
    const day = '2026-11-20';
    await seedStep(c, r.userId, day, 'night', '05:00', [{ from: '19:00', until: '21:30', text: 'Two reviews are waiting, both short.' }]);
    await seedStep(c, r.userId, day, 'pulse', '18:05', [{ from: '19:00', until: '21:30', text: 'Two reviews are waiting, both short.' }]);
    r.lines.push('', '(seeded: this morning’s night and the 18:05 pulse, one evening line 19:00-21:30 about two short reviews)');
    await r.say("Tonight I'm finishing the 3Sum problem, starting at 9.", ist(day, '18:40'));
    const stamp = (await c.prisma.buddyCaptureDay.findFirst({ where: { userId: r.userId, day: new Date(`${day}T00:00:00Z`) } }))?.todayAt ?? null;
    r.check('the digest marks the words as changing today', !!stamp, stamp ? r.local(stamp) : 'no stamp');
    let ran: { ran: boolean; reason: string } = { ran: false, reason: 'not tried' };
    for (const m of ['18:43', '18:44', '18:45', '18:46']) {
        ran = await pulseIfDue(r.userId, ist(day, m));
        if (ran.ran) {
            r.lines.push('', `### ${r.local(ist(day, m))}: a pulse (${ran.reason})`);
            break;
        }
    }
    await r.spent();
    r.check('a pulse on it runs within 6 minutes', ran.ran, ran.reason);
    const after = await stepWords(c, r.userId, day);
    for (const l of after.lines) r.lines.push(`- line ${l.from}-${l.until}: ${l.text}`);
    // Measured 11-20 (run 1): the digest makes the plan a 9 pm task, so the lock's rows show it ("9 pm · Finish 3Sum") and
    // the pulse rightly writes no line that restates them. The check is what the lock shows before 21:00: Buddy's line
    // or one of today's rows names it.
    const lock = await c.ambient.getAmbient(r.userId, ist(day, '20:50'), { app: '0.6.0' });
    const shown = [lock.line?.text ?? '', ...(lock.today ?? []).map((x) => `${x.at} · ${x.text}`)].filter(Boolean);
    r.lines.push('', `### ${r.local(ist(day, '20:50'))}: the lock shows`, ...shown.map((t) => `- ${t}`));
    r.check('(judgement) before 21:00 the lock names it (Buddy’s line or today’s rows)', shown.some((t) => /3\s?sum/i.test(t)), shown.join(' | ') || 'nothing');
    const stale = after.lines.filter((l) => /reviews? (are )?waiting|two (short )?reviews/i.test(l.text) && minuteOfLine(l.until) > 18 * 60 + 45);
    r.lines.push(`- the reviews line ${stale.length ? 'kept' : 'dropped or rewritten'} by the pulse`);
    const n = await r.night(ist('2026-11-21', '05:00'));
    const words = [...(n?.day.lines ?? []).map((l) => l.text), n?.day.insight ?? '', n?.day.note ?? ''].filter(Boolean);
    const asToday = words.filter((w) => /3\s?sum/i.test(w) && /\b(tonight|this evening|today|at 9)\b/i.test(w) && !/\b(last night|yesterday|did you|did 3\s?sum|get done|finish(ed)? it\?)/i.test(w));
    r.check('next morning: nothing says it as a plan for today', asToday.length === 0, asToday.join(' | ') || words.filter((w) => /3\s?sum/i.test(w)).join(' | ') || 'not mentioned');
}

/**
 * J16b, Mira (stage 18): a hard day. An evening line that pushes study is in place; at 17:30: "wiped today, zero energy,
 * skipping study tonight". After the pulse no line that evening pushes or asks about study (3 of 3); next morning's
 * night says nothing as if they are worn out today (3 of 3).
 */
async function j16b(c: Ctx, r: Run) {
    const { pulseIfDue } = await import('../src/services/buddy/pulse');
    const day = '2026-11-20';
    const push = 'An hour on system design tonight? You’re close to the end of the chapter.';
    await seedStep(c, r.userId, day, 'night', '05:00', [{ from: '19:00', until: '21:30', text: push }]);
    await seedStep(c, r.userId, day, 'pulse', '12:05', [{ from: '19:00', until: '21:30', text: push }]);
    r.lines.push('', `(seeded: this morning’s night and the noon pulse, one evening line 19:00-21:30: "${push}")`);
    await r.say('Wiped today, zero energy, skipping study tonight.', ist(day, '17:30'));
    let ran: { ran: boolean; reason: string } = { ran: false, reason: 'not tried' };
    for (const m of ['17:33', '17:34', '17:35', '17:36']) {
        ran = await pulseIfDue(r.userId, ist(day, m));
        if (ran.ran) {
            r.lines.push('', `### ${r.local(ist(day, m))}: a pulse (${ran.reason})`);
            break;
        }
    }
    await r.spent();
    r.check('a pulse on it runs within 6 minutes', ran.ran, ran.reason);
    const after = await stepWords(c, r.userId, day);
    for (const l of after.lines) r.lines.push(`- line ${l.from}-${l.until}: ${l.text}`);
    const evening = after.lines.filter((l) => minuteOfLine(l.until) > 18 * 60 || minuteOfLine(l.until) < 4 * 60);
    const pushes = evening.filter((l) => /\b(study|system design|chapter|review|practice|an hour on|revise|lesson)\b/i.test(l.text) && !/\b(rest|skip|no study|off tonight|sleep|take it easy|tomorrow)\b/i.test(l.text));
    r.check('no evening line pushes or asks about study after the pulse', pushes.length === 0, pushes.map((l) => l.text).join(' | ') || evening.map((l) => l.text).join(' | ') || 'no evening line');
    const n = await r.night(ist('2026-11-21', '05:00'));
    const words = [...(n?.day.lines ?? []).map((l) => l.text), n?.day.insight ?? '', n?.day.note ?? ''].filter(Boolean);
    const asToday = words.filter((w) => /\b(you'?re|you are|feeling) (still )?(worn out|wiped|exhausted|drained|tired)\b|\bzero energy\b|\bwiped today\b/i.test(w) && !/\b(yesterday|last night)\b/i.test(w));
    r.check('next morning: nothing says they are worn out today', asToday.length === 0, asToday.join(' | ') || words.join(' | ').slice(0, 240) || 'no words');
}

/**
 * J17, Kabir (the owner, 11-21: "When I tap Later, bring Buddy's nudge back at the time shown and show it once across both
 * screens"). Friday 11:00 the widget's card is the gift for Sunday; they tap Later at the time it shows ("Tonight · 7:30
 * pm"). By code, every run: a pulse on the tap runs within 6 minutes; until 19:30 nothing about the gift shows on either
 * screen; from 19:30 it shows once across both (Buddy's line on the lock, or its row there), never also in Coming up, Pick
 * up, the home thought or on the card. Judgement (2 of 3): the pulse gives it a line from 19:30 (never before), resting on it.
 * J17b, the same with an everyday errand (returning library books): Buddy's line may show on the lock, in place of the row
 * (judgement, 2 of 3). Measured 11-21: the gift's line names their sister, so it is kept off the lock (family) and the row shows.
 * J17c, the errand tapped at 18:00 ("Tomorrow · 9 am"): no pulse on it (tomorrow's is the night's); Saturday's night gives it
 * a line from 09:00 (judgement); until 09:00 nothing about it; from 09:00 once, on the lock.
 */
const j17 = (c: Ctx, r: Run) => laterComesBack(c, r, { title: 'Get a gift for my sister', aboutIt: /\b(gift|present|birthday)\b/i, lineOnLock: false, evening: false });
const j17b = (c: Ctx, r: Run) => laterComesBack(c, r, { title: 'Return the library books', aboutIt: /\b(library|books?)\b/i, lineOnLock: true, evening: false });
const j17c = (c: Ctx, r: Run) => laterComesBack(c, r, { title: 'Return the library books', aboutIt: /\b(library|books?)\b/i, lineOnLock: true, evening: true });

async function laterComesBack(c: Ctx, r: Run, o: { title: string; aboutIt: RegExp; lineOnLock: boolean; evening: boolean }) {
    const { pulseIfDue } = await import('../src/services/buddy/pulse');
    const { setLater } = await import('../src/services/ahead/later');
    const day = '2026-11-20';
    // Tapped at 11:00 it comes back tonight at 19:30 (a pulse writes for it); at 18:00, tomorrow at 09:00 (the night does).
    const tap = o.evening ? '18:00' : '11:00';
    const backDay = o.evening ? '2026-11-21' : day;
    const back = o.evening ? '09:00' : '19:30';
    const label = o.evening ? 'Tomorrow · 9 am' : 'Tonight · 7:30 pm';
    const APP = { app: '0.7.1' };
    await seedStep(c, r.userId, day, 'night', '05:00', [{ from: '08:00', until: '10:30', text: 'Two reviews are waiting, both short.' }]);
    const item = await c.prisma.todo.create({ data: { userId: r.userId, title: o.title, dueDate: ist('2026-11-22', '18:00'), status: 'pending' } });
    const tk = `tk_${item.id}`;
    r.lines.push('', `(seeded: this morning’s night, one morning line about two short reviews; the task "${o.title}", due Sunday 18:00)`);
    const card = (await c.ambient.getAmbient(r.userId, ist(day, tap), APP)).next;
    r.lines.push('', `### ${r.local(ist(day, tap))}: the widget's card`, `- ${card ? `${card.label} · ${card.title} · Later: ${card.later?.label ?? '(none)'}` : '(none)'}`);
    r.check(`the card is the item, its Later "${label}"`, card?.id === tk && card.later?.label === label, card ? `${card.title} · ${card.later?.label ?? ''}` : 'no card');
    if (card?.id !== tk || !card.later) return;
    const tapped = await setLater(r.userId, tk, ist(day, tap), ist(day, tap), new Date(card.later.at));
    r.lines.push(`- they tap Later: back ${tapped.label}`);
    let ran: { ran: boolean; reason: string } = { ran: false, reason: 'not tried' };
    const [hh, mm] = tap.split(':').map(Number) as [number, number];
    for (const m of [3, 4, 5, 6]) {
        const at = ist(day, `${String(hh).padStart(2, '0')}:${String(mm + m).padStart(2, '0')}`);
        ran = await pulseIfDue(r.userId, at);
        if (ran.ran) {
            r.lines.push('', `### ${r.local(at)}: a pulse (${ran.reason})`);
            break;
        }
    }
    await r.spent();
    if (o.evening) {
        r.check('no pulse on it: tomorrow’s Later is the night’s', !ran.ran, ran.reason);
        await r.night(ist(backDay, '05:00'));
    } else r.check('a pulse on the tap runs within 6 minutes', ran.ran, ran.reason);
    const row = await c.prisma.buddyDay.findFirst({ where: { userId: r.userId, day: new Date(`${backDay}T00:00:00Z`) }, orderBy: { createdAt: 'desc' } });
    const lines = ((row?.lines ?? []) as unknown as Array<{ from?: string; until?: string; text: string; refs?: string[]; lockOk?: boolean }>).filter((l) => l.text);
    if (!o.evening) for (const l of lines) r.lines.push(`- line ${l.from}-${l.until}${l.lockOk ? ' (lock screen)' : ''}: ${l.text}${l.refs?.length ? ` · rests on ${l.refs.join(', ')}` : ''}`);
    else for (const l of lines) if (l.refs?.length) r.lines.push(`  (rests on ${l.refs.join(', ')}: ${l.from}-${l.until})`);
    if (row?.insight && !o.evening) r.lines.push(`- home thought: ${row.insight}`);
    const about = (t: string | undefined | null) => o.aboutIt.test(t ?? '');
    const backMin = minuteOfLine(back);
    const nudge = lines.find((l) => (l.refs ?? []).includes(tk));
    r.check(`(judgement) ${o.evening ? 'the night' : 'the pulse'} gives it a line from ${back} (within the hour after), resting on it`, !!nudge && minuteOfLine(nudge.from) >= backMin && minuteOfLine(nudge.from) <= backMin + 60, nudge ? `${nudge.from}-${nudge.until}: ${nudge.text}` : 'no line rests on it');
    const early = lines.filter((l) => ((l.refs ?? []).includes(tk) || about(l.text)) && minuteOfLine(l.from) < backMin);
    r.check(`no line about it starts before ${back}`, early.length === 0, early.map((l) => `${l.from}: ${l.text}`).join(' | ') || 'none');
    // What each screen shows: the lock (Buddy's line, today's rows), the home picture (Coming up, Pick up, the thought), the widget's card.
    const shows = async (d: string, hhmm: string) => {
        const a = await c.ambient.getAmbient(r.userId, ist(d, hhmm), APP);
        const n = {
            line: about(a.line?.text) ? 1 : 0,
            lockRows: (a.today ?? []).filter((x) => about(x.text)).length,
            comingUp: (a.comingUp ?? []).filter((x) => about(x.text)).length,
            pickUp: about(a.pickUp?.text) ? 1 : 0,
            thought: about(a.insight) ? 1 : 0,
            card: a.next?.id === tk || about(a.next?.title) ? 1 : 0,
        };
        r.lines.push('', `### ${r.local(ist(d, hhmm))}: the screens`, `- lock: ${a.line?.text ?? '(no line)'}${(a.today ?? []).map((x) => `\n- lock row: ${x.at || 'Today'} · ${x.text}`).join('')}`, `- home: Coming up ${(a.comingUp ?? []).map((x) => `${x.at} ${x.text}`).join(' | ') || '(none)'}; thought ${a.insight ?? '(none)'}`, `- card: ${a.next ? `${a.next.label} · ${a.next.title}` : '(none)'}`, `- the item: ${JSON.stringify(n)}`);
        return n;
    };
    const total = (n: Record<string, number>) => Object.values(n).reduce((s, x) => s + x, 0);
    const before = o.evening ? [await shows(day, '21:00'), await shows(backDay, '08:30')] : [await shows(day, '15:00'), await shows(day, '19:15')];
    r.check(`until ${back} nothing about it on either screen`, before.every((n) => total(n) === 0), before.map((n) => JSON.stringify(n)).join(' · '));
    const plus = (min: number) => `${String(Math.floor((backMin + min) / 60)).padStart(2, '0')}:${String((backMin + min) % 60).padStart(2, '0')}`;
    const backNow = await shows(backDay, plus(10));
    r.check(`from ${back} it shows once across both screens, on the lock`, total(backNow) === 1 && backNow.line + backNow.lockRows === 1, JSON.stringify(backNow));
    if (o.lineOnLock) r.check('(judgement) on the lock as Buddy’s line, in place of its row', backNow.line === 1 && backNow.lockRows === 0, JSON.stringify(backNow));
    const still = await shows(backDay, plus(45));
    r.check(`still once at ${plus(45)}`, total(still) === 1 && still.line + still.lockRows === 1, JSON.stringify(still));
}

const JOURNEYS: Record<string, { person: [string, string]; run: (c: Ctx, r: Run) => Promise<void> }> = {
    J4: { person: ['Maya', 'maya4'], run: j4 },
    J9: { person: ['Arjun', 'arjun9a'], run: j9 },
    J10: { person: ['Omar', 'omar10'], run: j10 },
    J6: { person: ['Lena', 'lena6'], run: j6 },
    J1: { person: ['Maya', 'maya'], run: j1 },
    J3: { person: ['Lena', 'lena'], run: j3 },
    J2: { person: ['Arjun', 'arjun'], run: j2 },
    J5: { person: ['Sam', 'sam5'], run: j5 },
    J7: { person: ['Sam', 'sam7'], run: j7 },
    J11: { person: ['Omar', 'omar'], run: j11 },
    J9b: { person: ['Arjun', 'arjun9'], run: j9b },
    J12: { person: ['Lena', 'lena12'], run: j12 },
    J13: { person: ['Omar', 'omar13'], run: j13 },
    J14: { person: ['Riya', 'riya14'], run: j14 },
    J15: { person: ['Kabir', 'kabir15'], run: j15 },
    J16a: { person: ['Dev', 'dev16a'], run: j16a },
    J16b: { person: ['Mira', 'mira16b'], run: j16b },
    J17: { person: ['Kabir', 'kabir17'], run: j17 },
    J17b: { person: ['Kabir', 'kabir17b'], run: j17b },
    J17c: { person: ['Kabir', 'kabir17c'], run: j17c },
};

async function main() {
    const args = process.argv.slice(2);
    const outDir = args[0];
    if (!outDir) throw new Error('usage: eval-journeys.ts <outDir> [J1|J3]... [--runs 3]');
    const runsAt = args.indexOf('--runs');
    const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : 1;
    const which = args.slice(1).filter((a, i, all) => /^J\d+[abc]?$/.test(a) && all[i - 1] !== '--runs');
    fs.mkdirSync(outDir, { recursive: true });
    const c = await boot();
    const summary: Array<{ journey: string; run: number; pass: boolean; costUsd: number; failed: string[] }> = [];
    for (const j of which.length ? which : Object.keys(JOURNEYS)) {
        const def = JOURNEYS[j];
        if (!def) throw new Error(`no journey ${j}`);
        for (let i = 1; i <= runs; i++) {
            const user = await person(c, def.person[0], def.person[1]);
            const r = new Run(c, user.id, def.person[0]);
            r.lines.push(`# ${j}, run ${i} (${new Date().toISOString()})`);
            try {
                await def.run(c, r);
            } catch (err) {
                r.check('the run finished', false, err instanceof Error ? err.message : String(err));
            }
            await r.spent();
            const pass = r.checks.every((x) => x.pass);
            r.lines.push('', `**${pass ? 'PASS' : 'FAIL'}** · model cost $${r.costUsd.toFixed(4)}`);
            fs.writeFileSync(path.join(outDir, `${j}-run${i}.md`), `${r.lines.join('\n')}\n`);
            summary.push({ journey: j, run: i, pass, costUsd: Number(r.costUsd.toFixed(4)), failed: r.checks.filter((x) => !x.pass).map((x) => `${x.name}${x.detail ? ` (${x.detail})` : ''}`) });
            console.log(`${j} run ${i}: ${pass ? 'PASS' : 'FAIL'} $${r.costUsd.toFixed(4)}${pass ? '' : ` · ${summary[summary.length - 1]!.failed.join('; ')}`}`);
        }
    }
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ ranAt: new Date().toISOString(), summary, costUsd: Number(summary.reduce((s, x) => s + x.costUsd, 0).toFixed(4)) }, null, 2));
    await c.prisma.$disconnect();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
