// Learning dev data for the seed user (called from prisma/seed.ts; local only).
// A small, realistic DSA-prep dataset relative to "today" in the user's zone, so the learning
// Home page has something in every widget:
//   - subjects DSA + System Design, 7 topics (each with a doc): due today, overdue, done today
//     (undo-able), mastered, not started, starting tomorrow
//   - captures: a NOTE with a revision due today, a LINK resource, Inbox notes (one pinned)
//   - quick notes (Vault + Scratch, one pinned)
//   - a MASTER routine of 4 time blocks, 14 days of past slots (adherence + delta), debriefs,
//     and YESTERDAY's slots left unresolved, so Home opens the "Action Required" debrief
//   - todos: overdue, due today, upcoming, a weekly + a monthly goal, one completed today
//   - a streak (5, longest 12) and a DSA subject streak
// Daily loop v2 (LOOP_V2_SPEC §9):
//   - settings: dailyBudgetMin 25, routine OFF (the routine data above stays, hidden), nudge on
//     at 08:30, last seen yesterday (so Today opens in normal mode)
//   - an overdue backlog of ~15 items (several ~35 days late), so Today shows the budget and
//     "waiting"
//   - the example goal "Product-company SDE role" by 2027-06-30 (DSA + System Design), 6
//     milestones, 2 done
//   - 2 focus lines today (+ yesterday: one done, one unfinished for the carry-over row)
//   - pinned quick notes with an ssh / deploy command in a fenced code block, one long-text note
//     and one link note
// Today's slots are NOT created here: learningRolledOverDay = null, so the Home page calls
// ensure-today (or the cron does), like in real use; with the routine off it creates none.
// Re-running resets the dev user's learning data (subjects, topics + their docs, captures,
// quick notes, routine, slots, debriefs, goals, focus lines, the seeded todos).
import { Prisma } from '@prisma/client';
import type { prisma as PrismaClientType } from '../src/db/prisma';
import { docJsonToYjsState } from '../src/services/docs/docContent';
import { generatePreviewState } from '../src/utils/previewUtils';
import { parseDateOnly } from '../src/utils/timezone';
import {
    addDays,
    completeRevision,
    dayToUtcMidnight as d,
    initialGoalDueDay,
    startOfDay,
    startRevisions,
    today as todayIn,
    type Revision,
} from '../src/services/learning';

type Db = typeof PrismaClientType;

const TZ = 'Asia/Kolkata';

const SEED_TODO_TITLES = [
    'Write up LeetCode weekly contest',
    'Mock interview with Arjun',
    'Revise graph templates before contest',
    'Finish NeetCode 150: trees section',
    'Read DDIA chapter 5 (replication)',
    'Book the system design mock',
];

/** An instant at local wall time `hh:mm` on `day` in IST (+05:30, no DST). */
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);

function docState(title: string, paragraphs: string[]) {
    const json = {
        type: 'doc',
        content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: title }] },
            ...paragraphs.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
        ],
    };
    const yjsState = docJsonToYjsState(json);
    return { yjsState, previewState: generatePreviewState(yjsState) };
}

async function resetLearningData(db: Db, userId: string): Promise<void> {
    const topics = await db.topic.findMany({ where: { userId }, select: { docId: true } });
    const docIds = topics.map((t) => t.docId).filter((x): x is string => !!x);
    await db.revision.deleteMany({ where: { userId } });
    await db.subject.deleteMany({ where: { userId } }); // topics, streaks, history cascade
    await db.doc.deleteMany({ where: { userId, id: { in: docIds } } });
    await db.capture.deleteMany({ where: { userId } });
    await db.quickNote.deleteMany({ where: { userId } });
    await db.dailyScheduleSlot.deleteMany({ where: { userId } });
    await db.timeBlock.deleteMany({ where: { userId } }); // logs cascade
    await db.dayDebrief.deleteMany({ where: { userId } });
    await db.todo.deleteMany({ where: { userId, title: { in: SEED_TODO_TITLES } } });
    await db.goal.deleteMany({ where: { userId } }); // milestones + subject links cascade
    await db.focusItem.deleteMany({ where: { userId } });
}

/**
 * Inserts an item's chain as if started on `startDay`, then completes the given cycles (in
 * order) at the given instants with the real engine (so dates shift and undo records are right).
 */
async function seedChain(
    db: Db,
    userId: string,
    item: { topicId: string } | { captureId: string },
    startDay: string,
    completions: Array<{ cycle: number; at: Date }> = []
): Promise<void> {
    const topicId = 'topicId' in item ? item.topicId : null;
    const captureId = 'captureId' in item ? item.captureId : null;
    let chain: Revision[] = [];
    for (const p of startRevisions(startDay)) {
        const row = await db.revision.create({
            data: { userId, topicId, captureId, cycleNumber: p.cycleNumber, intervalDays: p.intervalDays, scheduledFor: d(p.scheduledFor), status: 'pending' },
            select: { id: true },
        });
        chain.push({ id: row.id, topicId, captureId, ...p });
    }
    const undo = new Map<string, Prisma.InputJsonValue>();
    for (const c of completions) {
        const target = chain.find((r) => r.cycleNumber === c.cycle)!;
        const result = completeRevision(chain, target.id, c.at, TZ);
        chain = result.revisions;
        undo.set(target.id, { revisionId: target.id, completedDay: result.undo.completedDay, shifts: result.undo.shifts.map((x) => ({ ...x })) });
    }
    for (const r of chain) {
        await db.revision.update({
            where: { id: r.id },
            data: { scheduledFor: d(r.scheduledFor), status: r.status, completedAt: r.completedAt, ...(undo.has(r.id) ? { undo: undo.get(r.id)! } : {}) },
        });
    }
}

export async function seedLearning(db: Db, userId: string, now: Date = new Date()): Promise<string> {
    await resetLearningData(db, userId);
    const today = todayIn(TZ, now);
    const yesterday = addDays(today, -1);

    await db.user.update({
        where: { id: userId },
        data: {
            timezone: TZ,
            routineMode: 'MASTER',
            globalStreak: 5,
            longestGlobalStreak: 12,
            lastGlobalStreakDay: d(yesterday),
            globalStreakBeforeCredit: Prisma.DbNull,
            learningRolledOverDay: null,
            // Daily loop v2 settings
            dailyBudgetMin: 25,
            routineEnabled: false,
            busyUntil: null,
            nudgeEmailEnabled: true,
            nudgeTime: '08:30',
            lastNudgeDay: null,
            lastSeenDay: d(yesterday),
            prevSeenDay: d(addDays(today, -2)),
        },
    });

    // ── Subjects + topics (each topic is a doc) ──
    const dsa = await db.subject.create({ data: { userId, name: 'DSA', description: 'NeetCode 150 + contest prep', color: '#007acc', icon: '🧠' } });
    const sd = await db.subject.create({ data: { userId, name: 'System Design', description: 'DDIA + Alex Xu', color: '#8b5cf6', icon: '🏗️' } });
    await db.subjectStreak.create({ data: { userId, subjectId: dsa.id, currentStreak: 3, longestStreak: 9, lastCreditDay: d(yesterday) } });

    const topic = async (subjectId: string, title: string, tags: string[], body: string[]) => {
        const doc = await db.doc.create({ data: { userId, title, docType: 'notes', ...docState(title, body) } });
        return db.topic.create({ data: { userId, subjectId, docId: doc.id, title, tags } });
    };
    const binary = await topic(dsa.id, 'Binary search', ['arrays', 'search'], ['lo/hi invariant: answer is in [lo, hi].', 'Search on the answer for "minimise the maximum" problems.']);
    const sliding = await topic(dsa.id, 'Sliding window', ['arrays'], ['Grow right, shrink left while the window is invalid.']);
    const twoPtr = await topic(dsa.id, 'Two pointers', ['arrays'], ['Sorted input → move the pointer that improves the sum.']);
    const heaps = await topic(dsa.id, 'Heaps & priority queues', ['heap'], ['Top-k: a min-heap of size k.']);
    const bfs = await topic(dsa.id, 'BFS / DFS', ['graphs'], ['BFS for shortest path in unweighted graphs.']);
    await topic(dsa.id, 'Dijkstra', ['graphs'], ['Not started yet.']);
    const hashing = await topic(sd.id, 'Consistent hashing', ['distributed'], ['Virtual nodes smooth the load across the ring.']);

    await seedChain(db, userId, { topicId: binary.id }, yesterday); // cycle 1 due today
    await seedChain(db, userId, { topicId: sliding.id }, addDays(today, -5), [{ cycle: 1, at: at(addDays(today, -4), '21:10') }]); // cycle 2 overdue 2 days
    await seedChain(db, userId, { topicId: twoPtr.id }, addDays(today, -3), [{ cycle: 1, at: at(addDays(today, -2), '08:30') }]); // cycle 2 due today
    const doneTodayAt = new Date(Math.max(startOfDay(today, TZ).getTime() + 60_000, now.getTime() - 30 * 60_000));
    await seedChain(db, userId, { topicId: heaps.id }, addDays(today, -1), [{ cycle: 1, at: doneTodayAt }]); // done today (undo-able)
    await seedChain(db, userId, { topicId: bfs.id }, addDays(today, -40), [
        { cycle: 1, at: at(addDays(today, -39), '20:00') },
        { cycle: 2, at: at(addDays(today, -37), '20:00') },
        { cycle: 3, at: at(addDays(today, -33), '20:00') },
        { cycle: 4, at: at(addDays(today, -19), '20:00') },
    ]); // mastered
    await seedChain(db, userId, { topicId: hashing.id }, today); // starts tomorrow

    // ── Captures ──
    const lru = await db.capture.create({
        data: { userId, type: 'NOTE', title: 'LRU cache', content: 'HashMap + doubly linked list: O(1) get/put. Move to head on access; evict the tail.', category: 'design', subjectId: dsa.id },
    });
    await seedChain(db, userId, { captureId: lru.id }, addDays(today, -3), [{ cycle: 1, at: at(addDays(today, -2), '22:00') }]); // cycle 2 due today
    await db.capture.create({
        data: { userId, type: 'LINK', title: 'Designing Data-Intensive Applications, ch. 5', url: 'https://dataintensive.net/', category: 'reading', subjectId: sd.id, topicId: hashing.id },
    });
    await db.capture.create({ data: { userId, type: 'NOTE', content: 'Try the "monotonic stack" pattern list this weekend', isPinned: true, category: 'ideas' } });
    await db.capture.create({ data: { userId, type: 'NOTE', title: 'Union-Find', content: 'Path compression + union by rank = almost O(1).' } });
    await db.capture.create({ data: { userId, type: 'LINK', url: 'https://neetcode.io/roadmap', title: 'NeetCode roadmap' } });

    // ── Quick notes ──
    await db.quickNote.createMany({
        data: [
            { id: '5e1d3c2a-1b0f-4e8d-9c7b-6a5f4e3d2c1b', userId, content: '**Contest checklist**: read all 4 first, brute force Q3 before optimising.', isPinned: true, category: 'PRIMARY', createdAt: at(addDays(today, -2), '09:00') },
            { id: '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d', userId, content: 'Ask Arjun about the Amazon LP questions', category: 'TEMPORARY', createdAt: at(yesterday, '18:20') },
            { id: '9f8e7d6c-5b4a-4392-a1b0-c9d8e7f6a5b4', userId, content: 'KMP failure function: longest proper prefix that is also a suffix.', category: 'PRIMARY', createdAt: new Date(now.getTime() - 2 * 3600_000) },
        ],
    });

    // ── Routine + past slots + debriefs ──
    const blocksSpec = [
        { title: 'Gym', startTime: '07:00', endTime: '08:00', color: '#10b981' },
        { title: 'Deep work: DSA', startTime: '09:00', endTime: '11:00', color: '#3b82f6' },
        { title: 'LeetCode practice', startTime: '14:00', endTime: '15:00', color: '#f59e0b' },
        { title: 'Review + plan tomorrow', startTime: '21:00', endTime: '21:30', color: '#8b5cf6' },
    ];
    const blocks = [];
    for (const b of blocksSpec) blocks.push(await db.timeBlock.create({ data: { userId, ...b, createdAt: at(addDays(today, -20), '08:00') } }));

    // Day -14..-2: resolved with a realistic mix; yesterday: unresolved (triage "Action Required").
    const pattern: Array<Array<'COMPLETED' | 'SKIPPED' | 'PARTIAL'>> = [
        ['COMPLETED', 'COMPLETED', 'SKIPPED', 'COMPLETED'],
        ['SKIPPED', 'COMPLETED', 'PARTIAL', 'COMPLETED'],
        ['COMPLETED', 'PARTIAL', 'COMPLETED', 'SKIPPED'],
        ['SKIPPED', 'SKIPPED', 'COMPLETED', 'COMPLETED'],
    ];
    for (let offset = 14; offset >= 1; offset--) {
        const day = addDays(today, -offset);
        const statuses = offset === 1 ? null : pattern[offset % pattern.length]!;
        await db.dailyScheduleSlot.createMany({
            data: blocks.map((b, i) => ({
                userId,
                sourceBlockId: b.id,
                date: d(day),
                title: b.title,
                color: b.color,
                startTime: b.startTime,
                endTime: b.endTime,
                status: statuses ? statuses[i]! : 'UPCOMING',
                remark: statuses?.[i] === 'SKIPPED' ? 'late at work' : null,
                minutesDone: statuses?.[i] === 'PARTIAL' ? 40 : null,
                sortOrder: i,
            })),
        });
        if (statuses) {
            const completed = statuses.filter((s) => s !== 'SKIPPED').length;
            await db.dayDebrief.create({
                data: {
                    userId,
                    date: d(day),
                    blocksPlanned: 4,
                    blocksCompleted: completed,
                    blocksSkipped: 4 - completed,
                    totalFocusedMin: completed * 60,
                    energy: 2 + (offset % 3),
                    focus: 3 + (offset % 2),
                    mood: 3 + (offset % 3 === 0 ? 1 : 0),
                    tags: offset % 2 ? ['Focused'] : ['Tired'],
                    narrative: offset % 2 ? 'Solid DSA block, got two mediums.' : 'Work ran late, skipped the gym.',
                    tomorrowIntent: 'Start with the hardest problem.',
                },
            });
        }
    }

    // ── Todos (tasks panel) ──
    const due = (day: string, hhmm = '18:00') => at(day, hhmm);
    const todos: Prisma.TodoCreateManyInput[] = [
        { userId, title: SEED_TODO_TITLES[0]!, dueDate: due(yesterday), priority: 'high' },
        { userId, title: SEED_TODO_TITLES[1]!, dueDate: due(today, '19:30'), priority: 'urgent' },
        { userId, title: SEED_TODO_TITLES[2]!, dueDate: due(addDays(today, 2)), priority: 'medium' },
        { userId, title: SEED_TODO_TITLES[3]!, goalType: 'WEEKLY', dueDate: parseDateOnly(initialGoalDueDay('WEEKLY', today)!, { timeZone: TZ }) },
        { userId, title: SEED_TODO_TITLES[4]!, goalType: 'MONTHLY', dueDate: parseDateOnly(initialGoalDueDay('MONTHLY', today)!, { timeZone: TZ }) },
        { userId, title: SEED_TODO_TITLES[5]!, dueDate: due(today, '12:00'), status: 'complete', completedAt: new Date(Math.max(startOfDay(today, TZ).getTime() + 60_000, now.getTime() - 3600_000)) },
    ];
    await db.todo.createMany({ data: todos });

    // ── Daily loop v2 (LOOP_V2_SPEC §9) ──
    const v2 = await seedLoopV2(db, userId, today, now, { dsa: dsa.id, sd: sd.id }, topic);

    return (
        `learning data for ${today} (${TZ}): 2 subjects, ${7 + v2.topics} topics, ${5 + v2.captures} captures, ` +
        `${3 + v2.quickNotes} quick notes, 4 blocks (routine off), 14 days of slots, ${todos.length} todos, ` +
        `${v2.overdue} overdue items, 1 goal (6 milestones, 2 done), ${v2.focus} focus lines`
    );
}

type TopicMaker = (subjectId: string, title: string, tags: string[], body: string[]) => Promise<{ id: string }>;

/**
 * The daily loop v2 part of the seed: an overdue backlog, the example goal, focus lines and the
 * pocket's pinned commands / long note / link note.
 */
async function seedLoopV2(
    db: Db,
    userId: string,
    today: string,
    now: Date,
    subjects: { dsa: string; sd: string },
    topic: TopicMaker
): Promise<{ topics: number; captures: number; quickNotes: number; overdue: number; focus: number }> {
    const daysAgo = (n: number) => addDays(today, -n);
    /** The item's cycle `cycle` is due `late` days ago; the earlier cycles were done on time (21:00 IST). */
    const overdueChain = async (item: { topicId: string } | { captureId: string }, cycle: 1 | 2 | 3, late: number) => {
        const toCycle = [0, 1, 3, 7]; // days from the start day to cycle k
        const start = daysAgo(late + toCycle[cycle]!);
        const completions = [1, 2].filter((c) => c < cycle).map((c) => ({ cycle: c, at: at(addDays(start, toCycle[c]!), '21:00') }));
        await seedChain(db, userId, item, start, completions);
    };

    // ── Overdue backlog: 14 items (+ "Sliding window" above = 15), several ~35 days late ──
    const backlogTopics: Array<[string, string, string[], 1 | 2 | 3, number]> = [
        [subjects.dsa, 'Monotonic stack', ['stack'], 1, 35],
        [subjects.dsa, 'Tries', ['trees', 'strings'], 2, 34],
        [subjects.dsa, 'Intervals: merge and insert', ['arrays'], 2, 21],
        [subjects.dsa, 'Backtracking templates', ['recursion'], 3, 12],
        [subjects.dsa, 'DP: 0/1 knapsack', ['dp'], 1, 9],
        [subjects.sd, 'Rate limiter design', ['api'], 2, 33],
        [subjects.sd, 'Caching strategies', ['cache'], 2, 16],
        [subjects.sd, 'Database indexing', ['databases'], 1, 6],
    ];
    for (const [subjectId, title, tags, cycle, late] of backlogTopics) {
        const t = await topic(subjectId, title, tags, [`Notes on ${title.toLowerCase()}.`]);
        await overdueChain({ topicId: t.id }, cycle, late);
    }
    const backlogCaptures: Array<[string | null, string, string, 1 | 2 | 3, number]> = [
        [subjects.dsa, "Kadane's algorithm", 'Track the best sum ending here; reset when it drops below zero.', 2, 35],
        [subjects.dsa, 'Two-heap median', 'Max-heap for the low half, min-heap for the high half; keep the sizes within 1.', 2, 27],
        [subjects.sd, 'CAP theorem in one line', 'During a partition, pick consistency or availability.', 3, 18],
        [null, 'Python heapq cheatsheet', 'heappush, heappop, heapify, nlargest(k, xs). Negate values for a max-heap.', 2, 11],
        [null, 'Big-O of common operations', 'dict get/set O(1) average; list.insert(0, x) O(n); sort O(n log n).', 1, 4],
        [subjects.dsa, 'Bit tricks', 'x & (x - 1) clears the lowest set bit; x & -x keeps only it.', 2, 3],
    ];
    for (const [subjectId, title, content, cycle, late] of backlogCaptures) {
        const c = await db.capture.create({ data: { userId, type: 'NOTE', title, content, subjectId } });
        await overdueChain({ captureId: c.id }, cycle, late);
    }

    // ── The example goal (editable; LOOP_V2_SPEC decision 2) ──
    const goal = await db.goal.create({
        data: {
            userId,
            title: 'Product-company SDE role',
            why: 'Harder problems, a stronger team and better pay. Edit this to your real goal.',
            deadline: d('2027-06-30'),
            status: 'active',
            createdAt: at(daysAgo(42), '09:00'),
        },
        select: { id: true },
    });
    await db.goalSubject.createMany({ data: [{ goalId: goal.id, subjectId: subjects.dsa }, { goalId: goal.id, subjectId: subjects.sd }] });
    const milestones: Array<[string, string, Date | null]> = [
        ['Finish NeetCode 150', '2026-10-31', at(daysAgo(20), '22:00')],
        ['Revise all core DSA patterns', '2026-11-30', at(daysAgo(6), '21:30')],
        ['System design: 10 classic designs', '2027-01-31', null],
        ['Build and ship one backend project', '2027-03-15', null],
        ['Resume, LinkedIn and referrals ready', '2027-04-15', null],
        ['Apply to 15 product companies', '2027-05-31', null],
    ];
    await db.goalMilestone.createMany({
        data: milestones.map(([title, dueDay, doneAt], i) => ({ goalId: goal.id, title, dueDay: d(dueDay), done: doneAt !== null, doneAt, sortOrder: i })),
    });

    // ── Focus lines: 2 today, and yesterday's (one done, one left for the carry-over row) ──
    await db.focusItem.createMany({
        data: [
            { userId, day: d(today), text: 'Two sliding-window mediums before work', sortOrder: 0 },
            { userId, day: d(today), text: 'Read DDIA ch. 5 (replication)', sortOrder: 1 },
            { userId, day: d(daysAgo(1)), text: 'Mock interview prep: LRU cache', done: true, sortOrder: 0 },
            { userId, day: d(daysAgo(1)), text: 'Update the resume project bullets', sortOrder: 1 },
        ],
    });

    // ── Pocket: pinned commands (one in a fenced code block), a long-text note, a link note ──
    // 203.0.113.10 is a documentation address (RFC 5737), not a real server.
    const deploy = [
        'Deploy Recollect',
        '```bash',
        "ssh deploy@203.0.113.10 'cd ~/apps/second-brain/backend && git pull && npm ci && npm run build && npm run db:deploy && pm2 reload ecosystem.config.js --env production'",
        '```',
    ].join('\n');
    const longNote = [
        'System design interview: my 45-minute plan',
        '',
        '1. Requirements (5 min): ask who the users are, the core features, and what is out of scope. Write the list down and get a nod before moving on.',
        '2. Estimates (5 min): daily active users, requests per second at peak, read/write ratio, storage per year. Round hard; the point is the order of magnitude.',
        '3. API and data model (10 min): the 3-4 endpoints that matter, then the tables or documents behind them. Say which queries must be fast.',
        '4. High-level design (10 min): clients, load balancer, stateless services, the database, a cache, a queue if anything is slow or bursty. Draw the read path and the write path separately.',
        '5. Deep dive (10 min): pick the hardest part (the feed, the counter, the ranking) and go one level down: sharding key, cache invalidation, idempotency, back-pressure.',
        '6. Wrap-up (5 min): bottlenecks, what breaks first at 10x, monitoring, and what you would do with another week.',
        '',
        'Habits that help: think out loud, name the trade-offs ("this gives us X at the cost of Y"), and keep an eye on the time.',
    ].join('\n');
    await db.quickNote.createMany({
        data: [
            { id: '3c9b1f2e-7d4a-4e6b-9f0c-2a1b3c4d5e6f', userId, content: deploy, isPinned: true, category: 'PRIMARY', createdAt: at(daysAgo(30), '10:00') },
            { id: '8d7c6b5a-4f3e-4d2c-8b1a-0f9e8d7c6b5a', userId, content: 'ssh -i ~/.ssh/recollect.pem ubuntu@203.0.113.10', isPinned: true, category: 'PRIMARY', createdAt: at(daysAgo(29), '10:05') },
            { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', userId, content: longNote, category: 'PRIMARY', createdAt: at(daysAgo(12), '20:15') },
            { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', userId, content: 'System design primer\nhttps://github.com/donnemartin/system-design-primer', category: 'PRIMARY', createdAt: new Date(now.getTime() - 26 * 3600_000) },
        ],
    });

    return { topics: backlogTopics.length, captures: backlogCaptures.length, quickNotes: 4, overdue: backlogTopics.length + backlogCaptures.length + 1, focus: 4 };
}
