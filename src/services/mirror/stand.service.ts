// Where you stand (WHERE_YOU_STAND_PLAN §5): the record of the last 7 days, 4 weeks and 52 weeks, each
// against the same span before it, and the verdict, all worked out by code (services/learning/stand.ts).
// The mirror (mirror.service.ts) keeps its own shape for the brief and the MCP's get_mirror.
//
//   GET /api/mirror/stand   read
import { prisma } from '../../db/prisma';
import { addDays, dayOf, startOfDay, type DayString } from '../learning';
import { buildStand, goalLineOf, recordStartOf, STAND_GRID_DAYS, STAND_LOOKBACK_DAYS, type Stand, type StandRows } from '../learning/stand';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { goalInclude } from '../learningDb/goals.service';
import { pathsOfGoal } from './paths';

/** Something finished on a day of the last 364 (the page's moments, §9): a topic of a path, a goal's milestone. */
export interface StandMoment {
    day: DayString;
    kind: 'topic' | 'milestone';
    title: string;
    /** The topic's subject, the milestone's goal. */
    of: string | null;
}

export interface StandJson extends Stand {
    /** Reviews still waiting from before today (pending, scheduled before today). */
    openNow: number;
    /** Weak spots open now. */
    weakOpenNow: number;
    /** What was finished in the last 364 days, oldest first. */
    moments: StandMoment[];
}

export async function getStand(userId: string, now: Date = new Date()): Promise<StandJson> {
    const ctx = await loadLearningContext(userId, now);
    const { today, tz } = ctx;
    const from = addDays(today, -(STAND_LOOKBACK_DAYS - 1));
    const fromDay = toDbDay(from);
    const fromAt = startOfDay(from, tz);
    const local = (at: Date) => dayOf(at, tz);

    const [
        user,
        sessions,
        revisions,
        openNow,
        topicsDone,
        focus,
        targets,
        milestones,
        weakSpots,
        weakOpenNow,
        recallSets,
        docs,
        subjects,
        goals,
        pathTopics,
        firstReview,
        firstSession,
        firstTopic,
        firstDoc,
    ] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } }),
        prisma.workSession.findMany({ where: { userId, day: { gte: fromDay, lte: toDbDay(today) } }, select: { day: true, kind: true, minutes: true, outcome: true } }),
        // Due in the two years, or completed in them (catch-ups of older reviews).
        prisma.revision.findMany({
            where: { userId, OR: [{ scheduledFor: { gte: fromDay, lte: toDbDay(today) } }, { status: 'done', completedAt: { gte: fromAt } }] },
            select: { scheduledFor: true, completedAt: true, status: true },
        }),
        prisma.revision.count({ where: { userId, status: 'pending', scheduledFor: { lt: toDbDay(today) } } }),
        prisma.topic.findMany({ where: { userId, isArchived: false, status: 'done', doneAt: { gte: fromAt } }, select: { subjectId: true, doneAt: true, title: true, doc: { select: { title: true } } } }),
        prisma.focusItem.findMany({ where: { userId, day: { gte: fromDay, lte: toDbDay(today) } }, select: { day: true, done: true } }),
        prisma.weekTarget.findMany({ where: { userId, weekStart: { gte: fromDay, lte: toDbDay(today) } }, select: { weekStart: true, status: true } }),
        prisma.goalMilestone.findMany({ where: { goal: { userId }, done: true, doneAt: { gte: fromAt } }, select: { doneAt: true, title: true, goal: { select: { title: true } } } }),
        prisma.weakSpot.findMany({ where: { userId, OR: [{ createdAt: { gte: fromAt } }, { clearedAt: { gte: fromAt } }] }, select: { createdAt: true, clearedAt: true } }),
        prisma.weakSpot.count({ where: { userId, status: 'open' } }),
        prisma.recallSet.findMany({ where: { userId, finishedAt: { gte: fromAt }, result: { not: null } }, select: { finishedAt: true, result: true } }),
        prisma.doc.findMany({
            where: { userId, trashedAt: null, isArchived: false, OR: [{ createdAt: { gte: fromAt } }, { updatedAt: { gte: fromAt } }] },
            select: { createdAt: true, updatedAt: true },
        }),
        prisma.subject.findMany({ where: { userId }, select: { id: true, name: true } }),
        prisma.goal.findMany({ where: { userId, status: 'active' }, include: goalInclude, orderBy: [{ deadline: 'asc' }, { createdAt: 'asc' }] }),
        prisma.topic.findMany({ where: { userId, isArchived: false }, select: { subjectId: true, status: true, doneAt: true } }),
        // Where the record starts (imported reviews and docs can be older than the account).
        prisma.revision.aggregate({ where: { userId, status: 'done', completedAt: { not: null } }, _min: { completedAt: true } }),
        prisma.workSession.aggregate({ where: { userId }, _min: { day: true } }),
        prisma.topic.aggregate({ where: { userId, doneAt: { not: null } }, _min: { doneAt: true } }),
        prisma.doc.aggregate({ where: { userId, trashedAt: null }, _min: { createdAt: true } }),
    ]);

    const rows: StandRows = {
        sessions: sessions.map((s) => ({ day: fromDbDay(s.day), kind: s.kind, minutes: s.minutes, outcome: s.outcome })),
        revisions: revisions.map((r) => ({ scheduledFor: fromDbDay(r.scheduledFor), completedDay: r.completedAt ? local(r.completedAt) : null, status: r.status })),
        topicsDone: topicsDone.filter((t) => t.doneAt).map((t) => ({ doneDay: local(t.doneAt!), subjectId: t.subjectId })),
        focus: focus.map((f) => ({ day: fromDbDay(f.day), done: f.done })),
        targets: targets.map((t) => ({ weekStart: fromDbDay(t.weekStart), status: t.status })),
        milestonesDone: milestones.filter((m) => m.doneAt).map((m) => local(m.doneAt!)),
        weakSpots: weakSpots.map((w) => ({ createdDay: local(w.createdAt), clearedDay: w.clearedAt ? local(w.clearedAt) : null })),
        recallSets: recallSets.filter((r) => r.finishedAt && r.result).map((r) => ({ finishedDay: local(r.finishedAt!), result: r.result! })),
        docs: docs.map((d) => ({ createdDay: local(d.createdAt), updatedDay: local(d.updatedAt) })),
        subjects,
    };

    const created = local(user.createdAt);
    const recordStart = recordStartOf(
        [
            created,
            firstReview._min.completedAt ? local(firstReview._min.completedAt) : null,
            firstSession._min.day ? fromDbDay(firstSession._min.day) : null,
            firstTopic._min.doneAt ? local(firstTopic._min.doneAt) : null,
            firstDoc._min.createdAt ? local(firstDoc._min.createdAt) : null,
        ],
        created
    );
    // A record can't start after today (a clock or zone change): today's own numbers still show.
    const start: DayString = recordStart > today ? today : recordStart;

    const goal = goalLineOf(
        goals.map((g) => ({
            title: g.title,
            deadline: fromDbDay(g.deadline),
            paths: pathsOfGoal(g, pathTopics, ctx).map((p) => ({ subject: p.subject.name, perWeek: p.perWeek, requiredPerWeek: p.requiredPerWeek, remaining: p.remaining, status: p.status })),
        }))
    );

    const gridFrom = addDays(today, -(STAND_GRID_DAYS - 1));
    const subjectName = new Map(subjects.map((x) => [x.id, x.name]));
    const moments: StandMoment[] = [
        ...topicsDone.filter((t) => t.doneAt).map((t) => ({ day: local(t.doneAt!), kind: 'topic' as const, title: t.doc?.title || t.title, of: subjectName.get(t.subjectId) ?? null })),
        ...milestones.filter((m) => m.doneAt).map((m) => ({ day: local(m.doneAt!), kind: 'milestone' as const, title: m.title, of: m.goal.title })),
    ]
        .filter((m) => m.day >= gridFrom && m.day <= today)
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

    return { ...buildStand(rows, { today, recordStart: start, goal }), openNow, weakOpenNow, moments };
}
