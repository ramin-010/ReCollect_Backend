// GET /api/today (LEARNING_SPEC §2 #1 + LOOP_V2_SPEC §2–6): everything the learning Home page
// needs, in one call.
// ZERO WRITES: the rollover (cron / POST /api/learning/ensure-today) does the writing;
// `needsEnsure` tells the client to call it (it is also true once a day until the app is marked
// seen). Slots that the rollover would heal are SHOWN as resolved here (excluded from triage), not
// written. All queries run in parallel on the root client (never in a transaction).
//
// Daily loop v2 adds `plan` (the budgeted Today), `focus`, `goals` and `stats.rhythm`; the sync
// spine adds `next` (up to 3 paths' next topics, goal-linked first: path.service nextUpOf). With the
// routine off (User.routineEnabled, the default) `schedule`, `triage` and `todayDebrief` are null
// and no slot is loaded.
import { prisma } from '../../db/prisma';
import { todoInclude, serializeTodo } from '../todos/todoShape';
import { PERSONAL_VISIBILITIES } from '../todos/todos.service';
import {
    addDays,
    buildRevisionBuckets,
    catchUpPrefill,
    computeAdherence,
    dayOf,
    effectiveStreak,
    findTriageSlots,
    isUnresolvedWeeklyGoal,
    isWeeklyReviewDay,
    revisionProgress,
    rhythmLast7,
    rhythmStart,
    startOfDay,
    TRIAGE_LOOKBACK_DAYS,
    planTriage,
    type Revision,
} from '../learning';
import {
    serializeCapture,
    serializeDebrief,
    serializeQuickNote,
    serializeRevisionItem,
    serializeSlot,
} from '../../db/serializers/learning';
import {
    contextOf,
    dayRange,
    fromDbDay,
    globalStreakOf,
    learningUserSelect,
    loadBlockLogs,
    toDbDay,
    toEngineDebrief,
    toEngineSlot,
} from './common';
import { focusForToday } from './focus.service';
import { goalInclude, todayGoalsJson } from './goals.service';
import { computePlan, hasRevisionHistory, needsHistoryCheck, planRevisionWhere, serializePlanItem, toPlanRow, type PlanRow } from './plan.service';
import { itemSource, revisionItemInclude, type RevisionWithItem } from './revisions.service';
import { needsEnsure } from './rollover.service';
import { loadNextUpRows, nextUpOf } from './path.service';
import { sessionDays } from './sessions.service';

export const INBOX_LIMIT = 10;

const subjectRefSelect = { id: true, name: true, color: true } as const;

/** Personal todos the Home page shows (same owner/visibility filter as listPersonalTodos). */
function personalTaskWhere(userId: string) {
    return {
        OR: [{ userId }, { assignees: { some: { userId } } }],
        visibility: { in: [...PERSONAL_VISIBILITIES] },
    };
}

export async function getToday(userId: string, now: Date = new Date()) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: learningUserSelect });
    const ctx = contextOf(user, now);
    const { tz, today } = ctx;
    const todayStart = dayRange(today, tz).gte;
    const windowStart = addDays(today, -TRIAGE_LOOKBACK_DAYS);
    const reviewDay = isWeeklyReviewDay(today);
    const routine = user.routineEnabled;
    const rhythmFrom = rhythmStart(today);

    const [
        revisionRows,
        topicChains,
        slotRows,
        logs,
        debriefRows,
        taskRows,
        inboxRows,
        inboxCount,
        quickNotes,
        weeklyGoalRows,
        focusRows,
        goalRows,
        rhythmRows,
        hasHistory,
        nextRows,
        workDays,
    ] = await Promise.all([
        // Pending revisions due by today + revisions completed today.
        prisma.revision.findMany({
            where: planRevisionWhere(userId, today, tz),
            include: revisionItemInclude,
            orderBy: [{ scheduledFor: 'asc' }, { cycleNumber: 'asc' }],
        }),
        // Topic progress: every topic with its chain's (cycle, status).
        prisma.topic.findMany({
            where: { userId },
            select: { id: true, revisions: { select: { cycleNumber: true, status: true } } },
        }),
        // Routine only: slots from 30 days back through today (triage, adherence, today's schedule).
        routine
            ? prisma.dailyScheduleSlot.findMany({
                  where: { userId, date: { gte: toDbDay(windowStart), lte: toDbDay(today) } },
                  orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }],
              })
            : Promise.resolve([]),
        routine ? loadBlockLogs(userId, windowStart, today, prisma) : Promise.resolve([]),
        routine ? prisma.dayDebrief.findMany({ where: { userId, date: { gte: toDbDay(windowStart), lte: toDbDay(today) } } }) : Promise.resolve([]),
        // Tasks: open with a due date or a goal, or completed today.
        prisma.todo.findMany({
            where: {
                AND: [
                    personalTaskWhere(userId),
                    {
                        OR: [
                            { status: { not: 'complete' }, OR: [{ dueDate: { not: null } }, { goalType: { not: 'NONE' } }] },
                            { status: 'complete', completedAt: { gte: todayStart } },
                        ],
                    },
                ],
            },
            include: todoInclude,
            orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        }),
        // Inbox: every capture not on a revision schedule (filed ones carry their subject), so nothing
        // saved with Ctrl K is out of sight. Pinned first, then newest.
        prisma.capture.findMany({
            where: { userId, revisions: { none: { status: 'pending' } } },
            include: { subject: { select: subjectRefSelect } },
            orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
            take: INBOX_LIMIT,
        }),
        prisma.capture.count({ where: { userId, revisions: { none: { status: 'pending' } } } }),
        prisma.quickNote.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
        reviewDay
            ? prisma.todo.findMany({
                  where: { AND: [personalTaskWhere(userId), { goalType: 'WEEKLY', status: { not: 'complete' }, dueDate: { not: null } }] },
                  include: todoInclude,
                  orderBy: { dueDate: 'asc' },
              })
            : Promise.resolve([]),
        // Focus lines of the rhythm window (today's, yesterday's carry-over, done days).
        prisma.focusItem.findMany({ where: { userId, day: { gte: toDbDay(rhythmFrom), lte: toDbDay(today) } } }),
        // Active goals with milestones + subjects.
        prisma.goal.findMany({ where: { userId, status: 'active' }, include: goalInclude }),
        // Rhythm: revisions completed in the last 7 days.
        prisma.revision.findMany({
            where: { userId, status: 'done', completedAt: { gte: startOfDay(rhythmFrom, tz), lt: startOfDay(addDays(today, 1), tz) } },
            select: { completedAt: true },
        }),
        // Comeback mode for a user never seen before today: did they ever revise before?
        needsHistoryCheck(user, today) ? hasRevisionHistory(userId, today, tz) : Promise.resolve(false),
        // Next up: the paths with something planned or in progress (SYNC_SPINE_SPEC 1.1).
        loadNextUpRows(userId),
        // Rhythm: a day with a logged session is an active day (SYNC_SPINE_SPEC 1.2).
        sessionDays(userId, rhythmFrom, today),
    ]);

    // ── Revisions (back-compat buckets) ──
    const planRows: PlanRow[] = revisionRows.map(toPlanRow);
    const buckets = buildRevisionBuckets(planRows, today, tz);
    const doneRows = buckets.doneToday.map((r) => r.row);
    const laterDone = await laterDoneKeys(doneRows);
    const item = (r: PlanRow, extras = {}) => serializeRevisionItem(r.row, itemSource(r.row), extras);
    const revisions = {
        totalDue: buckets.totalDue,
        dueToday: buckets.dueTodayBySubject.flatMap((g) => g.revisions).map((r) => item(r)),
        overdue: buckets.overdue.map((r) => item(r, { daysLate: r.daysLate })),
        doneToday: buckets.doneToday.map((r) => item(r, { canUndo: !laterDone.has(r.row.id) })),
    };

    // ── Plan (LOOP_V2_SPEC §2) ──
    const goalSubjectIds = goalRows.flatMap((g) => g.subjects.map((s) => s.subject.id));
    const computed = computePlan(ctx, planRows, goalSubjectIds, hasHistory);
    const plan = {
        mode: computed.mode,
        budgetMin: computed.result.budgetMin,
        estMinutes: computed.result.estMinutes,
        planned: computed.result.planned.map((r) => serializePlanItem(r, today)),
        waitingCount: computed.result.waitingCount,
        doneToday: computed.doneToday.map((r) => serializePlanItem(r, today, { canUndo: !laterDone.has(r.row.id) })),
    };

    // ── Stats ──
    const progress = revisionProgress(
        topicChains.map((t) => t.revisions.map((r) => ({ cycleNumber: r.cycleNumber, status: r.status }) as Revision))
    );
    const global = globalStreakOf(user);
    const slots = slotRows.map(toEngineSlot);
    const adherence = computeAdherence(slots, today);
    const rhythm = rhythmLast7({
        today,
        tz,
        completions: rhythmRows.map((r) => r.completedAt).filter((d): d is Date => d !== null),
        focusDoneDays: focusRows.filter((f) => f.done).map((f) => fromDbDay(f.day)),
        sessionDays: workDays,
    });

    // ── Schedule + triage (routine only; healed slots shown as resolved, nothing written) ──
    let schedule = null;
    let triage = null;
    let todayDebrief = null;
    if (routine) {
        const todaySlots = slotRows.filter((s) => fromDbDay(s.date) === today);
        const pastSlotRows = slotRows.filter((s) => fromDbDay(s.date) < today);
        const scan = findTriageSlots(pastSlotRows.map(toEngineSlot), logs, today);
        const triagePlan = planTriage(scan.unverified);
        const rowById = new Map(slotRows.map((s) => [s.id, s]));
        const debriefByDay = new Map(debriefRows.map((d) => [fromDbDay(d.date), d]));
        const slotJson = (id: string) => serializeSlot(rowById.get(id)!);
        if (triagePlan.kind === 'debrief') {
            const existing = debriefByDay.get(triagePlan.date);
            triage = {
                kind: 'debrief' as const,
                date: triagePlan.date,
                slots: triagePlan.slots.map((s) => slotJson(s.id)),
                existingDebrief: existing ? serializeDebrief(existing) : null,
            };
        } else if (triagePlan.kind === 'catch-up') {
            const existing = triagePlan.days.map((d) => debriefByDay.get(d.date)).filter((d): d is NonNullable<typeof d> => !!d);
            triage = {
                kind: 'catch-up' as const,
                days: triagePlan.days.map((d) => ({ date: d.date, slots: d.slots.map((s) => slotJson(s.id)) })),
                prefill: catchUpPrefill(existing.map(toEngineDebrief)),
            };
        } else {
            triage = { kind: 'none' as const };
        }
        schedule = { routineMode: user.routineMode, slots: todaySlots.map(serializeSlot) };
        const debrief = debriefByDay.get(today);
        todayDebrief = debrief ? serializeDebrief(debrief) : null;
    }

    // ── Weekly review (Mondays) ──
    const weeklyGoals = weeklyGoalRows.filter((t) =>
        isUnresolvedWeeklyGoal({ goalType: t.goalType, isDone: t.status === 'complete', dueDay: t.dueDate ? dayOf(t.dueDate, tz) : null }, today)
    );

    return {
        today,
        timezone: tz,
        needsEnsure: needsEnsure(user, now),
        user: { _id: user.id, name: user.name },
        stats: {
            streak: effectiveStreak(global, today),
            longestStreak: global.longest,
            adherence: adherence.adherence,
            adherenceDelta: adherence.adherenceDelta,
            adherenceDone: adherence.adherenceDone,
            adherenceTotal: adherence.adherenceTotal,
            totalTopics: progress.totalTopics,
            mastered: progress.mastered,
            inProgress: progress.inProgress,
            notStarted: progress.notStarted,
            rhythm,
        },
        revisions,
        plan,
        focus: focusForToday(focusRows, today),
        goals: todayGoalsJson(goalRows, ctx),
        next: nextUpOf(nextRows, goalSubjectIds),
        schedule,
        triage,
        todayDebrief,
        tasks: taskRows.map(serializeTodo),
        inbox: {
            count: inboxCount,
            items: inboxRows.map(({ subject, ...c }) => serializeCapture(c, subject)),
        },
        quickNotes: quickNotes.map(serializeQuickNote),
        weeklyReview: { isReviewDay: reviewDay, goals: weeklyGoals.map(serializeTodo) },
    };
}

/** Ids of done revisions that have a LATER cycle done too (their undo is blocked: LATER_CYCLE_DONE). */
async function laterDoneKeys(done: readonly RevisionWithItem[]): Promise<Set<string>> {
    if (done.length === 0) return new Set();
    const topicIds = done.map((r) => r.topicId).filter((x): x is string => !!x);
    const captureIds = done.map((r) => r.captureId).filter((x): x is string => !!x);
    const others = await prisma.revision.findMany({
        where: { status: 'done', OR: [{ topicId: { in: topicIds } }, { captureId: { in: captureIds } }] },
        select: { topicId: true, captureId: true, cycleNumber: true },
    });
    const blocked = new Set<string>();
    for (const r of done) {
        if (others.some((o) => (r.topicId ? o.topicId === r.topicId : o.captureId === r.captureId) && o.cycleNumber > r.cycleNumber)) blocked.add(r.id);
    }
    return blocked;
}
