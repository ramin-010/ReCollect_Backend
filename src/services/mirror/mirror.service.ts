// The mirror (LOOP_COMPLETE_SPEC 1.7): where the user stands, per goal and per subject, worked out by
// code from the record (paths, sessions, weak spots, Recall, the week). The coach, the brief and the
// "Where you stand" page read these numbers; models only put them into words.
//
//   GET /api/mirror   read
import type { SessionKind } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { addDays, type DayString } from '../learning';
import { minutesPerTopic, mondayOf, weeklyMinutes, type MinutesByKind, type PathPace } from '../learning/pace';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { goalInclude, forecastOf } from '../learningDb/goals.service';
import { weekSummary } from '../learningDb/week.service';
import { paceOfSubject, pathsOfGoal } from './paths';

const WEEKS = 6;
const QUIZ_POINTS = 12;
const PRACTICE_DAYS = 90;

export interface MirrorPath extends PathPace {
    subject: { _id: string; name: string; color: string | null };
}

export interface MirrorJson {
    today: DayString;
    goals: Array<{
        _id: string;
        title: string;
        deadline: DayString;
        daysLeft: number;
        milestones: { done: number; total: number };
        forecast: { status: string; behindDays: number | null };
        paths: MirrorPath[];
        /** Minutes per week per kind in the goal's subjects (and their projects' build time is not split out). */
        hoursPerWeek: Array<{ weekStart: DayString; minutes: MinutesByKind }>;
    }>;
    subjects: Array<{
        _id: string;
        name: string;
        color: string | null;
        path: PathPace | null;
        /** Quiz scores from sessions, oldest first (at most 12). */
        quiz: Array<{ day: DayString; done: number; total: number }>;
        weakSpots: { open: number; clearedIn30: number };
        /** Practice sessions of the last 90 days by how they were solved. */
        practice: { alone: number; hints: number; after_answer: number };
        /** Minutes per finished topic, null below 3 finished topics with time logged. */
        minutesPerTopic: number | null;
    }>;
    weeks: Array<{ weekStart: DayString; minutes: MinutesByKind; targets: { done: number; total: number } }>;
}

export async function getMirror(userId: string, now: Date = new Date()): Promise<MirrorJson> {
    const ctx = await loadLearningContext(userId, now);
    const today = ctx.today;
    const since = addDays(mondayOf(today), -7 * (WEEKS - 1));
    const [goals, subjects, topics, sessions, weak, cleared] = await Promise.all([
        prisma.goal.findMany({ where: { userId, status: 'active' }, include: goalInclude, orderBy: { deadline: 'asc' } }),
        prisma.subject.findMany({ where: { userId }, select: { id: true, name: true, color: true }, orderBy: { name: 'asc' } }),
        prisma.topic.findMany({ where: { userId, isArchived: false }, select: { id: true, subjectId: true, status: true, doneAt: true } }),
        prisma.workSession.findMany({
            where: { userId, day: { gte: toDbDay(addDays(today, -PRACTICE_DAYS)) } },
            select: { day: true, kind: true, minutes: true, subjectId: true, topicId: true, scoreDone: true, scoreTotal: true, outcome: true },
            orderBy: [{ day: 'asc' }, { startedAt: 'asc' }],
        }),
        prisma.weakSpot.groupBy({ by: ['subjectId', 'topicId'], where: { userId, status: 'open' }, _count: true }),
        prisma.weakSpot.findMany({ where: { userId, status: 'cleared', clearedAt: { gte: new Date(now.getTime() - 30 * 24 * 3600_000) } }, select: { subjectId: true, topicId: true } }),
    ]);

    const subjectOfTopic = new Map(topics.map((t) => [t.id, t.subjectId]));
    const sessionSubject = (s: { subjectId: string | null; topicId: string | null }) => s.subjectId ?? (s.topicId ? subjectOfTopic.get(s.topicId) ?? null : null);
    const day = (d: Date) => fromDbDay(d);
    const recentSessions = sessions.filter((s) => day(s.day) >= since).map((s) => ({ day: day(s.day), kind: s.kind as SessionKind, minutes: s.minutes, subjectId: sessionSubject(s) }));

    const goalsJson = goals.map((g) => {
        const forecast = forecastOf(g, ctx);
        const subjectIds = g.subjects.map((x) => x.subject.id);
        return {
            _id: g.id,
            title: g.title,
            deadline: fromDbDay(g.deadline),
            daysLeft: forecast.daysLeft,
            milestones: forecast.progress,
            forecast: { status: forecast.status, behindDays: forecast.behindDays ?? null },
            paths: pathsOfGoal(g, topics, ctx),
            hoursPerWeek: weeklyMinutes(recentSessions.filter((s) => s.subjectId && subjectIds.includes(s.subjectId)), today, WEEKS),
        };
    });

    const subjectsJson = subjects.map((s) => {
        const mine = sessions.filter((x) => sessionSubject(x) === s.id);
        const finished = topics.filter((t) => t.subjectId === s.id && t.status === 'done');
        const perTopic = finished.map((t) => ({ topicId: t.id, minutes: mine.filter((x) => x.topicId === t.id).reduce((a, x) => a + (x.minutes ?? 0), 0) }));
        return {
            _id: s.id,
            name: s.name,
            color: s.color,
            path: paceOfSubject(topics, s.id, ctx, null),
            quiz: mine.filter((x) => x.scoreTotal).slice(-QUIZ_POINTS).map((x) => ({ day: day(x.day), done: x.scoreDone ?? 0, total: x.scoreTotal! })),
            weakSpots: {
                open: weak.filter((w) => w.subjectId === s.id || (w.topicId && subjectOfTopic.get(w.topicId) === s.id)).reduce((a, w) => a + w._count, 0),
                clearedIn30: cleared.filter((w) => w.subjectId === s.id || (w.topicId && subjectOfTopic.get(w.topicId) === s.id)).length,
            },
            practice: {
                alone: mine.filter((x) => x.kind === 'practice' && x.outcome === 'alone').length,
                hints: mine.filter((x) => x.kind === 'practice' && x.outcome === 'hints').length,
                after_answer: mine.filter((x) => x.kind === 'practice' && x.outcome === 'after_answer').length,
            },
            minutesPerTopic: minutesPerTopic(perTopic),
        };
    });

    const minutes = weeklyMinutes(recentSessions, today, WEEKS);
    const weeks = [];
    for (const w of minutes) weeks.push({ ...w, targets: (await weekSummary(userId, w.weekStart, ctx.tz)).targets });

    return { today, goals: goalsJson, subjects: subjectsJson, weeks };
}
