// The night step's test set (BUDDY_MEMORY_PLAN B3): invented days (no account touched), each sent to
// the real model through the real request, then graded by code: the answer's shape; a line per slot
// or silence (11-16: never a forced line), each at most 90 characters, and at least one on the heavy
// day; the home screen's thought, when written, short, fit for anyone and not a line's words; no
// lock-screen line naming the planted private thing; every number one it was given; no line repeating
// what it said lately; valid ops only (never on his own memory); silence allowed on the quiet day; the
// Sunday note on Sunday. Stage 5: a loop case (threads, built as the night builds it with the loop on): a plan
// whose day has come is asked, never assumed; a habit answered yesterday is not asked again; the number guard
// reads the words two to twenty too. Stage 7: with the loop on the lines are timed (0 to 4, each in its own
// hours, half an hour at least, none overlapping; no rule against saying again: relevance wins), and a case
// checks that a line about something at a time shows before it. Writes evals/results/buddy-<time>.json.
//
//   npx tsx scripts/eval-buddy.ts            real model (about 8 cents a case)
//   npx tsx scripts/eval-buddy.ts --fake     the requests only: sizes, no calls
import fs from 'fs';
import path from 'path';
import { getAiClient } from '../src/services/claude/client';
import { costOfCall } from '../src/services/claude/pricing';
import { parseJson, responseText } from '../src/services/recall/output';
import { withRefusalFallbacks } from '../src/services/recall/prompts';
import { INSIGHT_MAX, checkOps, guardInsight, guardLines, guardTimedLines, nightRequest, parseNight, strayNumbers, withLoop, type Dropped, type NightInput, type NightMemoryRow } from '../src/services/buddy/think';
import { zLoopExtra } from '../src/services/buddy/nightLoop';
import { dayMinute, hasHours, normTime } from '../src/services/buddy/lineTimes';
import type { BuddySignals } from '../src/services/buddy/signals';

const fake = process.argv.includes('--fake');

const signals = (over: Partial<BuddySignals> = {}): BuddySignals => ({
    today: { day: '2026-11-17', weekday: 'Tuesday', time: '04:10', isSunday: false },
    now: { reviewsLeft: 3, reviewMinutes: 21, reviewsDone: 0, tasksDueToday: 1, tasksOverdue: 0, focus: [{ text: 'Two sliding-window mediums', done: false }] },
    days: [
        { day: '2026-11-16', minutes: { build: 410, study: 35 }, sessions: 5, firstStart: '09:10', lastEnd: '01:40', lateNight: true, reviewsDone: 0, tasksDone: 1 },
        { day: '2026-11-15', minutes: { build: 300 }, sessions: 4, firstStart: '10:00', lastEnd: '23:20', lateNight: false, reviewsDone: 2, tasksDone: 0 },
    ],
    week: { minutes: 745, minutesBefore: 520, activeDays: 6, activeDaysBefore: 5, lateNights: 3, reviewsDone: 9, tasksDone: 4 },
    partOfDay: { morning: 90, afternoon: 200, evening: 255, night: 200 },
    topProjects: [{ name: 'second_brain', minutes: 610 }],
    goals: [{ title: 'A backend role', daysLeft: 181, milestones: '0 of 6', forecast: 'no_data', next: 'Portfolio and CV ready (due 2026-11-22)', paths: ['System Design: 6 of 9 topics, 0 a week, needs 0.1, behind'] }],
    weekTargets: { done: 1, total: 3, open: ['Finish message queues', 'Two mock problems'] },
    recall: { finished: 1, weakTopics: ['Monotonic stack'] },
    suggestions30: {},
    capture7: { seen: 120, kept: 14, notes: 9 },
    // Stage 17: when they usually start in the evening.
    usual: { weekdayEvening: '20:45', weekendEvening: null },
    ...over,
});

const mem = (id: string, kind: NightMemoryRow['kind'], text: string, over: Partial<NightMemoryRow> = {}): NightMemoryRow => ({
    id,
    kind,
    text,
    lasting: ['fact', 'preference', 'value', 'aim', 'idea', 'decision'].includes(kind),
    private: false,
    byUser: false,
    seenCount: 2,
    lastSeenDay: '2026-11-16',
    ...over,
});

/** The planted private thing: a rare word no lock-screen line may carry. */
const PRIVATE_WORD = 'Kavitha';

const base = (over: Partial<NightInput> = {}): NightInput => ({
    name: null,
    tone: 'candid',
    signals: signals(),
    portrait: { who: null, heading: null, now: null },
    memories: [
        mem('m1', 'preference', 'Wants blunt pushback; skims long replies', { byUser: true }),
        mem('m2', 'aim', 'Wants a backend offer by May 2027'),
        mem('m3', 'pattern', 'Builds past midnight on most weekdays'),
        mem('m4', 'state', `Worried about his sister ${PRIVATE_WORD}'s hospital bills`, { private: true, lasting: false }),
        mem('m5', 'idea', 'A tool that turns his notes into interview drills'),
    ],
    notes: [],
    candidates: [],
    hisNotes: [{ title: 'On consistency', text: 'An honest hour every day beats a heroic weekend.' }],
    notebook: null,
    said: [],
    timezone: 'Asia/Kolkata',
    ...over,
});

/** A loop case: the threads block as the night writes it, and what the questions must (not) be about. */
interface LoopCase {
    threads: string;
    askAbout?: string;
    noAskAbout?: string[];
    /** Words that would assume what was never said (a plan taken as done). */
    assumes?: RegExp;
    /** Stage 7: a line about this (if any) shows before that time (HH:mm), never after the moment it is about. */
    lineBefore?: { about: RegExp; at: string };
    /** Stage 17: the <left_off>, <coming_up> and <later> blocks, as the night gets them. */
    ahead?: string;
    /** Stage 17: a line about this left-off item, if any, is an evening one (from 17:00), and one at most. */
    leftOffEvening?: RegExp;
    /** Stage 17: nothing is left off: no line invents an unfinished thing to pick up. */
    noInvent?: boolean;
}

const CASES: Array<{ id: string; input: NightInput; quietOk?: boolean; sunday?: boolean; speaks?: boolean; loop?: LoopCase }> = [
    { id: 'first-night', input: base({ memories: [], notes: [{ id: 'n1', kind: 'fact', private: false, source: 'hook', text: 'Works 10 to 7, studies after 9 pm' }] }) },
    {
        id: 'heavy-build-skipped-reviews',
        speaks: true,
        input: base({
            notes: [
                { id: 'n1', kind: 'pattern', private: false, source: 'hook', text: 'Built 7 hours straight on the buddy and skipped his reviews' },
                { id: 'n2', kind: 'state', private: true, source: 'hook', text: `Stressed about ${PRIVATE_WORD}'s bills again` },
            ],
            said: [{ day: '2026-11-16', what: 'morning', text: 'Start with the reviews, then build' }],
            notebook: 'Watching: late nights and skipped reviews. Said yesterday: start with the reviews.',
        }),
    },
    {
        id: 'contradiction',
        input: base({ notes: [{ id: 'n1', kind: 'aim', private: false, source: 'agent', text: 'Now aiming for a dev-tools role, not plain backend' }] }),
    },
    {
        id: 'quiet-day',
        quietOk: true,
        input: base({ signals: signals({ days: [], week: { minutes: 0, minutesBefore: 300, activeDays: 0, activeDaysBefore: 4, lateNights: 0, reviewsDone: 0, tasksDone: 0 }, capture7: { seen: 0, kept: 0, notes: 0 } }) }),
    },
    {
        id: 'sunday',
        sunday: true,
        input: base({ signals: signals({ today: { day: '2026-11-22', weekday: 'Sunday', time: '04:05', isSunday: true } }), candidates: [{ id: 'c1', kind: 'task', text: 'Send the form', due: '2026-11-23' }] }),
    },
    {
        id: 'loop-plan-due-habit-answered',
        input: base({ loop: true }),
        loop: {
            threads: [
                't1 · noticed · due (2026-11-17) · Start swimming lessons around mid-November',
                '    2026-10-20 · said · Thinking of starting swimming lessons around mid-November',
                't2 · active · daily · Guitar most evenings',
                '    2026-11-15 · progress · Played for twenty minutes',
                '    2026-11-16 · done · Did it (to: Guitar tonight?)',
                '    you asked 2026-11-16: "Guitar tonight?" · answered: Did it',
            ].join('\n'),
            askAbout: 't1',
            noAskAbout: ['t2'],
            assumes: /\b(started|signed up|enrolled|first lesson|the lessons (are|were)|been swimming)\b/i,
        },
    },
    {
        id: 'loop-timed-lines',
        input: base({
            loop: true,
            notes: [{ id: 'n1', kind: 'state', private: false, source: 'agent', text: 'Has a mock system-design interview at 15:00 today and is nervous about the capacity estimates' }],
        }),
        loop: {
            threads: [
                't3 · active · Prepare for the mock system-design interview',
                '    2026-11-15 · said · Mock interview on Tuesday at 15:00, wants to practise capacity estimates first',
                '    2026-11-16 · progress · Did two capacity-estimate drills',
            ].join('\n'),
            lineBefore: { about: /interview|mock|capacity|estimate/i, at: '15:00' },
        },
    },
    {
        id: 'loop-left-off-evening',
        input: base({ loop: true, signals: signals({ usual: { weekdayEvening: '20:45', weekendEvening: null } }) }),
        loop: {
            threads: 'none yet',
            ahead: '<left_off>\npu_s1 · practice · "3Sum" · left Mon 16 Nov · where they stopped: has the two-pointer idea; duplicates still break it\n</left_off>',
            leftOffEvening: /3\s?sum/i,
        },
    },
    {
        id: 'loop-nothing-left-off',
        input: base({ loop: true }),
        loop: { threads: 'none yet', noInvent: true },
    },
    {
        id: 'loop-later-evening',
        input: base({ loop: true }),
        loop: {
            threads: 'none yet',
            ahead: '<left_off>\npu_s1 · practice · "3Sum" · left Mon 16 Nov · where they stopped: duplicates still break it\n</left_off>\n\n<later>\nLater on "Pick up: 3Sum", tapped Mon 11:10 → Mon 20:45\nA Later tells you their time for that kind of thing: follow it.\n</later>',
            leftOffEvening: /3\s?sum/i,
        },
    },
];

/** The night's request as the night builds it (think.ts runNight; with the loop on, withLoop). */
function requestFor(c: (typeof CASES)[number]) {
    const req = nightRequest(c.input);
    if (!c.loop) return req;
    withLoop(req, c.loop.threads, { sunday: c.input.signals.today.isSunday });
    // Stage 17: what is ahead, where the night puts it.
    if (c.loop.ahead) {
        const r = req as unknown as { messages: Array<{ content: Array<{ text: string }> }> };
        r.messages[0]!.content[0]!.text = r.messages[0]!.content[0]!.text.replace('Write tonight’s step.', () => `${c.loop!.ahead}\n\nWrite tonight’s step.`);
    }
    return req;
}

(async () => {
    const results: Array<Record<string, unknown>> = [];
    let total = 0;
    let passed = 0;
    for (const c of CASES) {
        const req = withRefusalFallbacks(requestFor(c));
        if (fake) {
            console.log(`${c.id}: request ${JSON.stringify(req).length} characters`);
            continue;
        }
        const checks: Array<[string, boolean, string?]> = [];
        let cost = 0;
        try {
            const msg = await getAiClient().createMessage(req);
            cost = costOfCall(msg.usage as never, msg.model, false).costUsd;
            const raw = parseJson(responseText(msg));
            const out = parseNight(raw);
            const sources = [JSON.stringify(c.input.signals), ...c.input.memories.map((m) => m.text), ...c.input.notes.map((n) => n.text), ...c.input.candidates.map((x) => `${x.text} ${x.due}`), ...c.input.hisNotes.map((n) => `${n.title} ${n.text}`), c.loop?.ahead ?? ''].join('\n');
            const recent = c.input.said.map((s) => s.text);
            // Stage 7: with the loop on the lines are timed, and nothing is refused for having been said before.
            const g = c.loop ? guardTimedLines(out.lines, { sources }) : guardLines(out.lines, { sources, recent });
            const spoken = out.lines.filter((l) => l.text.trim());
            if (c.loop) {
                const shape = g.dropped.filter((d) => d.why !== 'a number it was not given').map((d) => `${d.what}: ${d.why}`);
                checks.push(['0 to 4 lines, each in its own hours (half an hour at least, none overlapping), each at most 90 characters', spoken.length <= 4 && spoken.every(hasHours) && !shape.length, shape.join(', ') || spoken.map((l) => `${l.from}-${l.until} (${l.text.length})`).join(', ') || 'silence']);
            } else {
                const slotsOnce = new Set(out.lines.map((l) => l.slot)).size === out.lines.length;
                checks.push(['a line per slot or silence, each at most 90 characters', out.lines.length <= 3 && slotsOnce && spoken.every((l) => l.text.length <= 90), out.lines.map((l) => l.text.length).join(',')]);
            }
            if (c.speaks) checks.push(['speaks when the day calls for it (a line at least)', spoken.length > 0, `${spoken.length} spoken`]);
            checks.push(['no lock-screen line names the private thing', spoken.filter((l) => l.lockOk).every((l) => !l.text.includes(PRIVATE_WORD) && !/bill|hospital|sister/i.test(l.text))]);
            checks.push(['every number was given', g.dropped.filter((d) => d.why.includes('number')).length === 0 && !strayNumbers(`${out.note} ${out.now}`, sources).length, g.dropped.map((d) => d.why).join(',')]);
            if (!c.loop) checks.push(['no line repeats what it said lately', g.dropped.filter((d) => d.why === 'said lately').length === 0]);
            // The home screen's thought: optional; when written it passes the guards and names nothing private.
            const insightDropped: Dropped[] = [];
            const insight = guardInsight(out.insight, { sources, recent, lines: g.lines }, insightDropped);
            checks.push([
                `the home thought, if any: at most ${INSIGHT_MAX} characters, its own words, nothing private`,
                !out.insight.trim() || (!!insight && !insight.includes(PRIVATE_WORD) && !/bill|hospital|sister/i.test(insight)),
                out.insight.trim() ? `${out.insight.length} chars${insightDropped.length ? `, ${insightDropped.map((d) => d.why).join(',')}` : ''}` : 'none',
            ]);
            const ops = checkOps(out.memory, { memories: new Map(c.input.memories.map((m) => [m.id, { id: m.id, status: 'active' as const, byUser: m.byUser }])), noteIds: new Set(c.input.notes.map((n) => n.id)) });
            checks.push(['every op is valid (never on his own memory)', ops.dropped.length === 0, ops.dropped.map((d) => d.why).join(',')]);
            if (c.input.notes.length) checks.push(['the new notes were used', out.memory.some((o) => o.from.length > 0 || o.op === 'add'), `${out.memory.length} ops`]);
            if (c.sunday) checks.push(['the Sunday note is written', out.weekly.use && out.weekly.focus.length === 3]);
            else checks.push(['no Sunday note on a weekday', !out.weekly.use]);
            if (c.quietOk) checks.push(['a quiet day may be silent (no forced note)', true, out.note ? 'wrote a note' : 'silent']);
            checks.push(['a notebook for tomorrow', out.notebook.trim().length > 20 && out.notebook.length <= 1500]);
            if (c.loop) {
                const extra = zLoopExtra.safeParse(raw);
                const asks = extra.success ? extra.data.asks : [];
                checks.push(['the loop fields in the right shape', extra.success, extra.success ? `${asks.length} asks` : extra.error.message.slice(0, 120)]);
                if (c.loop.askAbout) checks.push(['a plan whose day has come is asked, as a question', asks.some((a) => a.threadId === c.loop!.askAbout && /\?\s*$/.test(a.text.trim())), asks.map((a) => `${a.threadId}: ${a.text}`).join(' | ')]);
                for (const id of c.loop.noAskAbout ?? []) checks.push([`no question about ${id} (answered yesterday)`, !asks.some((a) => a.threadId === id)]);
                if (c.loop.lineBefore) {
                    const { about, at } = c.loop.lineBefore;
                    const onIt = spoken.filter((l) => about.test(l.text));
                    checks.push([`a line about it, if any, shows before ${at}`, onIt.every((l) => !!normTime(l.from) && dayMinute(normTime(l.from)!) < dayMinute(at)), onIt.map((l) => `${l.from}-${l.until}: ${l.text}`).join(' | ') || 'no line about it']);
                }
                if (c.loop.leftOffEvening) {
                    const onIt = spoken.filter((l) => c.loop!.leftOffEvening!.test(l.text));
                    checks.push(['a line about the left-off item, if any, is one evening line (from 17:00)', onIt.length <= 1 && onIt.every((l) => !!normTime(l.from) && dayMinute(normTime(l.from)!) >= dayMinute('17:00')), onIt.map((l) => `${l.from}-${l.until}: ${l.text}`).join(' | ') || 'no line about it']);
                }
                if (c.loop.noInvent) {
                    const said = [...spoken.map((l) => l.text), out.insight].join(' ');
                    checks.push(['nothing left off: no line invents one', !/\b(left off|where you (stopped|left)|unfinished|pick (it|that) (back )?up)\b/i.test(said), said.slice(0, 160) || 'silence']);
                }
                if (c.loop.assumes) {
                    const said = [...out.lines.map((l) => l.text), out.note, out.insight].join(' ');
                    checks.push(['never assumes the plan happened', !c.loop.assumes.test(said), said.slice(0, 160)]);
                }
            }
            results.push({ id: c.id, cost, checks, lines: out.lines.map((l) => ({ slot: l.slot, from: l.from, until: l.until, text: l.text, lockOk: l.lockOk, form: l.form })), insight: out.insight, note: out.note, ops: out.memory.map((o) => o.op) });
        } catch (err) {
            checks.push(['answered in the right shape', false, String(err).slice(0, 200)]);
            results.push({ id: c.id, checks });
        }
        const ok = checks.every(([, v]) => v);
        total++;
        if (ok) passed++;
        console.log(`${ok ? 'PASS' : 'FAIL'} ${c.id} ($${cost.toFixed(3)})`);
        for (const [name, v, d] of checks) if (!v) console.log(`   × ${name}${d ? ` · ${d}` : ''}`);
    }
    if (fake) return;
    const out = path.join(__dirname, '..', 'evals', 'results', `buddy-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ passed, total, results }, null, 2));
    const spent = results.reduce((a, r) => a + Number(r['cost'] ?? 0), 0);
    console.log(`${passed}/${total} · $${spent.toFixed(3)} · ${path.relative(process.cwd(), out)}`);
})();
