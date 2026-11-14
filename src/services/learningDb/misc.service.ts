// The weekly-goal shift and the AI mentor export (LEARNING_SPEC §2 #28, #29). Settings (#3) moved
// to settings.service.ts (daily loop v2).
import { prisma } from '../../db/prisma';
import { parseDateOnly } from '../../utils/timezone';
import { todoInclude, serializeTodo } from '../todos/todoShape';
import { PERSONAL_VISIBILITIES } from '../todos/todos.service';
import {
    buildMentorPrompt,
    buildMentorReportInput,
    diffDays,
    effectiveStreak,
    shiftWeeklyGoal,
    type DayString,
} from '../learning';
import { LearningError } from '../learning/errors';
import { notFound } from '../learning/http';
import { captureTitle, topicTitle } from '../../db/serializers/learning';
import { dayRange, fromDbDay, globalStreakOf, loadLearningContext, toDbDay, toEngineDebrief, toEngineSlot } from './common';

// ─── #28 Weekly goal shift ─────────────────────────────────────────────

/** "Shift to This Week" (new weekly due day) or "Make it Monthly"; due at 18:00 local on that day. */
export async function shiftGoal(userId: string, todoId: string, target: 'THIS_WEEK' | 'MONTHLY', now: Date = new Date()) {
    const ctx = await loadLearningContext(userId, now);
    const { count } = await prisma.todo.updateMany({
        where: { id: todoId, userId, visibility: { in: [...PERSONAL_VISIBILITIES] } },
        data: (() => {
            const shifted = shiftWeeklyGoal(target, ctx.today);
            return { goalType: shifted.goalType, dueDate: parseDateOnly(shifted.dueDay, { timeZone: ctx.tz }), updatedAt: now };
        })(),
    });
    if (count === 0) throw notFound();
    return serializeTodo(await prisma.todo.findUniqueOrThrow({ where: { id: todoId }, include: todoInclude }));
}

// ─── #29 Mentor export ─────────────────────────────────────────────────

/** Longest range the export accepts (Revise offered up to a few weeks). */
export const MENTOR_EXPORT_MAX_DAYS = 92;

export async function mentorExport(userId: string, from: DayString, to: DayString, now: Date = new Date()): Promise<{ prompt: string }> {
    if (from > to) throw new LearningError('INVALID_RANGE', 'Start date is after end date');
    if (diffDays(to, from) + 1 > MENTOR_EXPORT_MAX_DAYS) {
        throw new LearningError('INVALID_RANGE', `Pick at most ${MENTOR_EXPORT_MAX_DAYS} days`);
    }
    const ctx = await loadLearningContext(userId, now);
    const { tz } = ctx;
    const range = { gte: toDbDay(from), lte: toDbDay(to) };
    const completedIn = { gte: dayRange(from, tz).gte, lt: dayRange(to, tz).lt };

    const [slots, logs, debriefs, revisions] = await Promise.all([
        prisma.dailyScheduleSlot.findMany({ where: { userId, date: range } }),
        prisma.blockSessionLog.findMany({
            where: { timeBlock: { userId }, date: range },
            include: { timeBlock: { select: { title: true, startTime: true, endTime: true } } },
        }),
        prisma.dayDebrief.findMany({ where: { userId, date: range } }),
        prisma.revision.findMany({
            where: { userId, OR: [{ status: 'pending' }, { status: 'done', completedAt: completedIn }] },
            include: {
                topic: { select: { title: true, doc: { select: { title: true } }, subject: { select: { name: true } } } },
                capture: { select: { title: true, content: true, subject: { select: { name: true } } } },
            },
        }),
    ]);

    const input = buildMentorReportInput({
        from,
        to,
        tz,
        slots: slots.map(toEngineSlot),
        logs: logs.map((l) => ({
            timeBlockId: l.timeBlockId,
            date: fromDbDay(l.date),
            status: l.status,
            remark: l.remark,
            minutesDone: l.minutesDone,
            block: l.timeBlock,
        })),
        debriefs: debriefs.map(toEngineDebrief),
        revisions: revisions.map((r) => ({
            // Revise: topic title || capture title || first 40 chars of the capture || 'Untitled'; subject || 'General'.
            title: r.topic ? topicTitle(r.topic, r.topic.doc?.title) : r.capture ? captureTitle(r.capture).slice(0, 40) : 'Untitled',
            subject: r.topic?.subject?.name ?? r.capture?.subject?.name ?? 'General',
            cycleNumber: r.cycleNumber,
            scheduledFor: fromDbDay(r.scheduledFor),
            status: r.status,
            completedAt: r.completedAt,
        })),
        habits: [],
        globalStreak: effectiveStreak(globalStreakOf(ctx.user), ctx.today),
    });
    return { prompt: buildMentorPrompt(input) };
}


