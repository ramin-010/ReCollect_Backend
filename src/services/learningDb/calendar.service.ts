// The revision calendar (Revise had it: a month to pick a day, that day's load beside it,
// "Move here"; 2026-11-15). For each day: the pending reviews scheduled on it with their minutes,
// and the open personal tasks due on it, against his daily budget, so a move can be judged before
// it is made. Read only; moving is the existing reschedule.
//
//   GET /api/revisions/calendar?from=YYYY-MM-DD&days=42   read
import { prisma } from '../../db/prisma';
import { serializeRevisionItem } from '../../db/serializers/learning';
import { addDays, dayOf, startOfDay, type DayString } from '../learning/time';
import { revisionMinutes } from '../learning/plan';
import { badRequest } from '../learning/http';
import { fromDbDay, loadLearningContext, toDbDay } from './common';
import { itemSource, revisionItemInclude } from './revisions.service';

const DAYS_MAX = 62;

export interface CalendarDayJson {
    day: DayString;
    /** The reviews' minutes (tasks have no estimate). */
    minutes: number;
    revisions: Array<{ _id: string; title: string; cycleNumber: number; minutes: number; subject: { name: string; color: string | null } | null }>;
    tasks: Array<{ _id: string; title: string }>;
}

export interface CalendarJson {
    today: DayString;
    budgetMin: number;
    days: CalendarDayJson[];
}

export async function revisionCalendar(userId: string, opts: { from?: DayString | undefined; days?: number | undefined } = {}, now: Date = new Date()): Promise<CalendarJson> {
    const ctx = await loadLearningContext(userId, now);
    const from = opts.from ?? ctx.today;
    const count = opts.days ?? 42;
    if (!Number.isInteger(count) || count < 1 || count > DAYS_MAX) throw badRequest(`days is 1 to ${DAYS_MAX}`);
    const end = addDays(from, count);
    const [revisions, tasks] = await Promise.all([
        prisma.revision.findMany({
            where: { userId, status: 'pending', scheduledFor: { gte: toDbDay(from), lt: toDbDay(end) } },
            include: revisionItemInclude,
            orderBy: [{ scheduledFor: 'asc' }, { cycleNumber: 'asc' }, { id: 'asc' }],
        }),
        prisma.todo.findMany({
            where: { userId, workspaceId: null, status: { not: 'complete' }, dueDate: { gte: startOfDay(from, ctx.tz), lt: startOfDay(end, ctx.tz) } },
            select: { id: true, title: true, dueDate: true },
            orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        }),
    ]);
    const byDay = new Map<DayString, CalendarDayJson>();
    for (let i = 0; i < count; i++) {
        const day = addDays(from, i);
        byDay.set(day, { day, minutes: 0, revisions: [], tasks: [] });
    }
    for (const r of revisions) {
        const slot = byDay.get(fromDbDay(r.scheduledFor));
        if (!slot) continue;
        const item = serializeRevisionItem(r, itemSource(r));
        const minutes = revisionMinutes(r);
        slot.minutes += minutes;
        slot.revisions.push({ _id: r.id, title: item.title, cycleNumber: r.cycleNumber, minutes, subject: item.subject ? { name: item.subject.name, color: item.subject.color ?? null } : null });
    }
    for (const t of tasks) {
        const slot = t.dueDate ? byDay.get(dayOf(t.dueDate, ctx.tz)) : undefined;
        if (slot) slot.tasks.push({ _id: t.id, title: t.title });
    }
    return { today: ctx.today, budgetMin: ctx.user.dailyBudgetMin, days: [...byDay.values()] };
}
