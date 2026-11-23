// Where you stand (WHERE_YOU_STAND_PLAN §5): the record of the last 7 days, 4 weeks and 52 weeks, each
// against the same span before it, and the verdict, all worked out by code (services/learning/stand.ts).
// The mirror (mirror.service.ts) keeps its own shape for the brief and the MCP's get_mirror.
//
//   GET /api/mirror/stand?lens=personal|learning|building|work|all   read (no lens: what counts as progress for them)
//
// PERSONAL_OFFICE_PLAN (11-23): the record through a lens. Personal: their own sessions, reviews, focus lines, goals.
// Work: work sessions only (time at work; nothing of learning). All: both. Home's year and week ask without a lens,
// so they show what counts as progress.
// STUDY_FLOW_PLAN §4.5: Learning = the Personal record without build sessions; Building = build sessions only (no
// reviews, topics, goals or habits, as the Work lens), with the folders of their own the time went to.
import { prisma } from '../../db/prisma';
import { addDays, dayOf, startOfDay, type DayString } from '../learning';
import { buildStand, coverageOf, goalLineOf, recordStartOf, STAND_GRID_DAYS, STAND_LOOKBACK_DAYS, STAND_WINDOWS, type CoverageInput, type Stand, type StandRows } from '../learning/stand';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { goalInclude } from '../learningDb/goals.service';
import { inLens, progressLens, SESSIONS_ONLY, type Lens, type ProgressLens } from '../learningDb/lens';
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
    /** The lens this record was read through, and the person's progress lens (what Home shows). */
    lens: Lens;
    progressLens: ProgressLens;
    /** They have work tracked (a folder marked Work, or work sessions in the last two years): the page offers the lenses. */
    hasWork: boolean;
    /** The keys of their folders marked Work (the Work lens lists what was done in them). */
    workFolders: string[];
    /** The record holds learning (study, practice, review sessions; reviews; topics finished) and building (build
     * sessions of their own): the page offers Learning and Building only when both are there. */
    hasLearning: boolean;
    hasBuilding: boolean;
    /** The keys of their own folders with build time in the record (the Building lens lists what was built in them). */
    buildFolders: string[];
    /** Reviews still waiting from before today (pending, scheduled before today). */
    openNow: number;
    /** Weak spots open now. */
    weakOpenNow: number;
    /** What was finished in the last 364 days, oldest first. */
    moments: StandMoment[];
}

export async function getStand(userId: string, now: Date = new Date(), lensAsked?: Lens): Promise<StandJson> {
    const ctx = await loadLearningContext(userId, now);
    const progress = await progressLens(userId);
    const lens: Lens = lensAsked ?? progress;
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
        workFolders,
        tasksDue,
        milestonesDue,
        captures,
        workLines,
    ] = await Promise.all([
        prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } }),
        prisma.workSession.findMany({
            where: { userId, day: { gte: fromDay, lte: toDbDay(today) } },
            select: { day: true, kind: true, minutes: true, outcome: true, area: true, project: { select: { name: true, key: true } }, subject: { select: { name: true } } },
        }),
        // Due in the two years, or completed in them (catch-ups of older reviews).
        prisma.revision.findMany({
            where: { userId, OR: [{ scheduledFor: { gte: fromDay, lte: toDbDay(today) } }, { status: 'done', completedAt: { gte: fromAt } }] },
            select: { scheduledFor: true, completedAt: true, status: true },
        }),
        prisma.revision.count({ where: { userId, status: 'pending', scheduledFor: { lt: toDbDay(today) } } }),
        prisma.topic.findMany({ where: { userId, isArchived: false, status: 'done', doneAt: { gte: fromAt } }, select: { subjectId: true, doneAt: true, title: true, doc: { select: { title: true } } } }),
        prisma.focusItem.findMany({ where: { userId, day: { gte: fromDay, lte: toDbDay(today) } }, select: { day: true, done: true } }),
        prisma.weekTarget.findMany({ where: { userId, weekStart: { gte: fromDay, lte: toDbDay(today) } }, select: { weekStart: true, status: true, doneAt: true } }),
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
        prisma.project.findMany({ where: { userId, kind: 'work' }, select: { key: true }, orderBy: { key: 'asc' } }),
        // COVERAGE_PLAN: what came due (their own dated tasks, milestones with a date), notes on a subject or lesson,
        // and the work log's lines (a day of building or of work).
        prisma.todo.findMany({ where: { userId, workspaceId: null, dueDate: { gte: fromAt } }, select: { dueDate: true, completedAt: true, status: true } }),
        prisma.goalMilestone.findMany({ where: { goal: { userId }, dueDay: { gte: fromDay, lte: toDbDay(today) } }, select: { dueDay: true, done: true, doneAt: true } }),
        prisma.capture.findMany({ where: { userId, createdAt: { gte: fromAt }, OR: [{ subjectId: { not: null } }, { topicId: { not: null } }] }, select: { createdAt: true } }),
        prisma.workLine.findMany({ where: { userId, hidden: false, day: { gte: fromDay, lte: toDbDay(today) } }, select: { day: true, office: true }, distinct: ['day', 'office'] }),
    ]);
    // The Work and Building lenses read sessions and nothing else: reviews, focus lines, targets and goals are learning.
    const work = SESSIONS_ONLY.includes(lens);

    const rows: StandRows = {
        sessions: sessions
            .filter((s) => inLens(lens, s.area, s.kind))
            .map((s) => ({ day: fromDbDay(s.day), kind: s.kind, minutes: s.minutes, outcome: s.outcome, area: s.area, place: s.project?.name ?? s.subject?.name ?? null })),
        revisions: work ? [] : revisions.map((r) => ({ scheduledFor: fromDbDay(r.scheduledFor), completedDay: r.completedAt ? local(r.completedAt) : null, status: r.status })),
        topicsDone: work ? [] : topicsDone.filter((t) => t.doneAt).map((t) => ({ doneDay: local(t.doneAt!), subjectId: t.subjectId })),
        focus: work ? [] : focus.map((f) => ({ day: fromDbDay(f.day), done: f.done })),
        targets: work ? [] : targets.map((t) => ({ weekStart: fromDbDay(t.weekStart), status: t.status })),
        milestonesDone: work ? [] : milestones.filter((m) => m.doneAt).map((m) => local(m.doneAt!)),
        weakSpots: work ? [] : weakSpots.map((w) => ({ createdDay: local(w.createdAt), clearedDay: w.clearedAt ? local(w.clearedAt) : null })),
        recallSets: work ? [] : recallSets.filter((r) => r.finishedAt && r.result).map((r) => ({ finishedDay: local(r.finishedAt!), result: r.result! })),
        docs: work ? [] : docs.map((d) => ({ createdDay: local(d.createdAt), updatedDay: local(d.updatedAt) })),
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

    const goal = work ? null : goalLineOf(
        goals.map((g) => ({
            title: g.title,
            deadline: fromDbDay(g.deadline),
            paths: pathsOfGoal(g, pathTopics, ctx).map((p) => ({ subject: p.subject.name, perWeek: p.perWeek, requiredPerWeek: p.requiredPerWeek, remaining: p.remaining, status: p.status })),
        }))
    );

    const gridFrom = addDays(today, -(STAND_GRID_DAYS - 1));
    const subjectName = new Map(subjects.map((x) => [x.id, x.name]));
    const moments: StandMoment[] = work ? [] : [
        ...topicsDone.filter((t) => t.doneAt).map((t) => ({ day: local(t.doneAt!), kind: 'topic' as const, title: t.doc?.title || t.title, of: subjectName.get(t.subjectId) ?? null })),
        ...milestones.filter((m) => m.doneAt).map((m) => ({ day: local(m.doneAt!), kind: 'milestone' as const, title: m.title, of: m.goal.title })),
    ]
        .filter((m) => m.day >= gridFrom && m.day <= today)
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

    const hasWork = workFolders.length > 0 || sessions.some((s) => s.area === 'work') || workLines.some((l) => l.office);
    const built = sessions.filter((s) => s.area === 'personal' && s.kind === 'build');
    const hasBuilding = built.length > 0;
    const hasLearning = sessions.some((s) => s.area === 'personal' && s.kind !== 'build') || revisions.some((r) => r.status === 'done') || topicsDone.length > 0;
    const buildFolders = [...new Set(built.flatMap((s) => (s.project ? [s.project.key] : [])))].sort();
    // COVERAGE_PLAN: the four rates, from the whole record whatever the lens.
    const coverageInput: CoverageInput = {
        sessions: sessions.map((s) => ({ day: fromDbDay(s.day), kind: s.kind, area: s.area })),
        reviewsDone: revisions.filter((r) => r.status === 'done' && r.completedAt).map((r) => local(r.completedAt!)),
        topicsDone: topicsDone.filter((t) => t.doneAt).map((t) => local(t.doneAt!)),
        recallSets: recallSets.filter((r) => r.finishedAt).map((r) => local(r.finishedAt!)),
        captures: captures.map((c) => local(c.createdAt)),
        docs: docs.map((d) => ({ createdDay: local(d.createdAt), updatedDay: local(d.updatedAt) })),
        workLines: workLines.map((l) => ({ day: fromDbDay(l.day), office: l.office })),
        reviews: revisions.map((r) => ({ due: fromDbDay(r.scheduledFor), done: r.status === 'done' && r.completedAt ? local(r.completedAt) : null, missed: r.status === 'missed' })),
        tasks: tasksDue.filter((t) => t.dueDate).map((t) => ({ due: local(t.dueDate!), done: t.status === 'complete' && t.completedAt ? local(t.completedAt) : null })),
        milestones: milestonesDue.filter((m) => m.dueDay).map((m) => ({ due: fromDbDay(m.dueDay!), done: m.done && m.doneAt ? local(m.doneAt) : null })),
        targets: targets.map((t) => ({ weekStart: fromDbDay(t.weekStart), status: t.status, doneDay: t.doneAt ? local(t.doneAt) : null })),
        focus: focus.map((f) => ({ day: fromDbDay(f.day), done: f.done })),
        hasBuilding: hasBuilding || workLines.some((l) => !l.office),
        hasWork,
    };
    const stand = buildStand(rows, { today, recordStart: start, goal, lens });
    for (const w of STAND_WINDOWS) stand.periods[w].coverage = coverageOf(coverageInput, stand.periods[w].span, start, today);
    return {
        ...stand,
        lens,
        progressLens: progress,
        hasWork,
        workFolders: workFolders.map((f) => f.key),
        hasLearning,
        hasBuilding,
        buildFolders,
        openNow: work ? 0 : openNow,
        weakOpenNow: work ? 0 : weakOpenNow,
        moments,
    };
}
