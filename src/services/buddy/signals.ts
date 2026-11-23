// The buddy's signals (BUDDY_MEMORY_PLAN §3.3): the numbers of his last 14 days, worked out by code,
// so the model never calculates (every number it writes must be found in what it was given). Built
// from the services that already own each part: the brief (goals and pace, today, the week, tasks,
// Recall), the session list, revisions and tasks done, capture counts, his answers to suggestions.
import { prisma } from '../../db/prisma';
import { getBrief, type Brief } from '../brief/brief.service';
import { listSessions } from '../learningDb/sessions.service';
import { progressLens } from '../learningDb/lens';
import { addDays, type DayString } from '../learning';
import { dayRange, loadLearningContext, toDbDay } from '../learningDb/common';

export const SIGNAL_DAYS = 14;

export interface BuddySignals {
    today: { day: DayString; weekday: string; time: string; isSunday: boolean };
    /** What is left today. */
    now: { reviewsLeft: number; reviewMinutes: number; reviewsDone: number; tasksDueToday: number; tasksOverdue: number; focus: Array<{ text: string; done: boolean }> };
    days: Array<{ day: DayString; minutes: Record<string, number>; sessions: number; firstStart: string | null; lastEnd: string | null; lateNight: boolean; reviewsDone: number; tasksDone: number }>;
    /** The last 7 days against the 7 before. */
    week: { minutes: number; minutesBefore: number; activeDays: number; activeDaysBefore: number; lateNights: number; reviewsDone: number; tasksDone: number };
    partOfDay: { morning: number; afternoon: number; evening: number; night: number };
    topProjects: Array<{ name: string; minutes: number }>;
    goals: Array<{ title: string; daysLeft: number; milestones: string; forecast: string | null; next: string | null; paths: string[] }>;
    weekTargets: { done: number; total: number; open: string[] };
    recall: { finished: number; weakTopics: string[] };
    suggestions30: Record<string, { accepted: number; dismissed: number }>;
    capture7: { seen: number; kept: number; notes: number };
    /**
     * Stage 17: when they usually start studying in the evening ("20:45"), weekdays and weekends apart: the median of
     * each day's first study or practice start after 17:00 in these 14 days, from 3 such days up; else null.
     */
    usual: { weekdayEvening: string | null; weekendEvening: string | null };
}

/** The median of minutes of the day as "HH:mm", from `min` samples up; else null. */
export function usualStart(minutes: readonly number[], min = 3): string | null {
    if (minutes.length < min) return null;
    const sorted = [...minutes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const m = Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const clock = (iso: string, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const hourOf = (iso: string, tz: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(iso))) % 24;

/** A session ending between 00:30 and 05:00 counts as a late night (for the day it started). */
export function isLateEnd(endIso: string, tz: string): boolean {
    const [h, m] = clock(endIso, tz).split(':').map(Number) as [number, number];
    return (h === 0 && m >= 30) || (h >= 1 && h < 5);
}

export async function buddySignals(userId: string, now: Date = new Date(), brief?: Brief): Promise<BuddySignals> {
    const ctx = await loadLearningContext(userId, now);
    const from = addDays(ctx.today, -(SIGNAL_DAYS - 1));
    const fromInstant = dayRange(from, ctx.tz).gte;
    const [b, sessions, revisions, tasks, capture, decided] = await Promise.all([
        brief ? Promise.resolve(brief) : getBrief(userId, {}, now),
        progressLens(userId).then((lens) => listSessions(userId, { days: SIGNAL_DAYS, lens }, now)),
        prisma.revision.findMany({ where: { userId, status: 'done', completedAt: { gte: fromInstant } }, select: { completedAt: true } }),
        prisma.todo.findMany({ where: { userId, workspaceId: null, completedAt: { gte: fromInstant } }, select: { completedAt: true } }),
        prisma.buddyCaptureDay.findMany({ where: { userId, day: { gte: toDbDay(addDays(ctx.today, -6)) } } }),
        prisma.suggestion.groupBy({ by: ['kind', 'status'], where: { userId, decidedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } }, _count: { _all: true } }),
    ]);
    const dayOfInstant = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ctx.tz }).format(d) as DayString;

    const days: BuddySignals['days'] = [];
    for (let i = 0; i < SIGNAL_DAYS; i++) {
        const day = addDays(ctx.today, -i);
        const own = sessions.sessions.filter((s) => s.day === day);
        const minutes: Record<string, number> = {};
        for (const s of own) minutes[s.kind] = (minutes[s.kind] ?? 0) + (s.minutes ?? 0);
        const starts = own.map((s) => s.startedAt).sort();
        const ends = own.map((s) => s.endedAt).filter((e): e is string => !!e).sort();
        days.push({
            day,
            minutes,
            sessions: own.length,
            firstStart: starts[0] ? clock(starts[0], ctx.tz) : null,
            lastEnd: ends.length ? clock(ends[ends.length - 1]!, ctx.tz) : null,
            lateNight: own.some((s) => s.endedAt && isLateEnd(s.endedAt, ctx.tz)),
            reviewsDone: revisions.filter((r) => r.completedAt && dayOfInstant(r.completedAt) === day).length,
            tasksDone: tasks.filter((t) => t.completedAt && dayOfInstant(t.completedAt) === day).length,
        });
    }
    const total = (d: BuddySignals['days'][number]) => Object.values(d.minutes).reduce((a, m) => a + m, 0);
    const last7 = days.slice(0, 7);
    const before7 = days.slice(7);
    const parts = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    for (const s of sessions.sessions) {
        const h = hourOf(s.startedAt, ctx.tz);
        const key = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'night';
        parts[key] += s.minutes ?? 0;
    }
    const projects = new Map<string, number>();
    for (const s of sessions.sessions) if (s.project) projects.set(s.project.name, (projects.get(s.project.name) ?? 0) + (s.minutes ?? 0));

    const suggestions30: BuddySignals['suggestions30'] = {};
    for (const g of decided) {
        const row = (suggestions30[g.kind] ??= { accepted: 0, dismissed: 0 });
        if (g.status === 'accepted') row.accepted += g._count._all;
        if (g.status === 'dismissed') row.dismissed += g._count._all;
    }
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: ctx.tz, weekday: 'long' }).format(now);
    // Stage 17: each day's first study or practice start after 17:00 (their clock), weekdays and weekends apart.
    const evenings = new Map<string, number>();
    for (const s of sessions.sessions) {
        if (s.kind !== 'study' && s.kind !== 'practice') continue;
        const [h, m] = clock(s.startedAt, ctx.tz).split(':').map(Number) as [number, number];
        const minute = h * 60 + m;
        if (minute < 17 * 60) continue;
        const had = evenings.get(s.day);
        if (had === undefined || minute < had) evenings.set(s.day, minute);
    }
    const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());
    const usual = {
        weekdayEvening: usualStart([...evenings.entries()].filter(([d]) => !isWeekend(d)).map(([, m]) => m)),
        weekendEvening: usualStart([...evenings.entries()].filter(([d]) => isWeekend(d)).map(([, m]) => m)),
    };
    return {
        today: { day: ctx.today, weekday, time: clock(now.toISOString(), ctx.tz), isSunday: weekday === 'Sunday' },
        now: {
            reviewsLeft: Math.max(0, b.today.revisions.planned - b.today.revisions.done),
            reviewMinutes: b.today.revisions.estMinutes,
            reviewsDone: b.today.revisions.done,
            tasksDueToday: b.tasks.dueToday,
            tasksOverdue: b.tasks.overdue,
            focus: b.today.focus.map((f) => ({ text: f.text, done: f.done })),
        },
        days: days.filter((d) => d.sessions || d.reviewsDone || d.tasksDone),
        week: {
            minutes: last7.reduce((a, d) => a + total(d), 0),
            minutesBefore: before7.reduce((a, d) => a + total(d), 0),
            activeDays: last7.filter((d) => d.sessions || d.reviewsDone).length,
            activeDaysBefore: before7.filter((d) => d.sessions || d.reviewsDone).length,
            lateNights: last7.filter((d) => d.lateNight).length,
            reviewsDone: last7.reduce((a, d) => a + d.reviewsDone, 0),
            tasksDone: last7.reduce((a, d) => a + d.tasksDone, 0),
        },
        partOfDay: parts,
        topProjects: [...projects.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 3).map(([name, minutes]) => ({ name, minutes })),
        goals: b.goals.map((g) => ({
            title: g.title,
            daysLeft: g.daysLeft,
            milestones: `${g.progress.done} of ${g.progress.total}`,
            forecast: g.forecast?.status ?? null,
            next: g.nextMilestone ? `${g.nextMilestone.title}${g.nextMilestone.dueDay ? ` (due ${g.nextMilestone.dueDay})` : ''}` : null,
            paths: g.paths.map((p) => `${p.subject}: ${p.done} of ${p.total} topics, ${p.perWeek} a week${p.requiredPerWeek !== null ? `, needs ${p.requiredPerWeek}` : ''}, ${p.status.replace('_', ' ')}`),
        })),
        weekTargets: { done: b.week.targets.filter((t) => t.done).length, total: b.week.targets.length, open: b.week.targets.filter((t) => !t.done).map((t) => t.text) },
        recall: { finished: b.recall.finished, weakTopics: b.recall.weakTopics.map((t) => t.title) },
        suggestions30,
        capture7: { seen: capture.reduce((a, c) => a + c.seen, 0), kept: capture.reduce((a, c) => a + c.kept, 0), notes: capture.reduce((a, c) => a + c.notes, 0) },
        usual,
    };
}

/** "3 reviews and 1 task left today", the code-written line the pictures fall back to. */
export function plainLine(s: BuddySignals): string {
    const { reviewsLeft, tasksDueToday } = s.now;
    const parts = [reviewsLeft ? `${reviewsLeft} ${reviewsLeft === 1 ? 'review' : 'reviews'}` : null, tasksDueToday ? `${tasksDueToday} ${tasksDueToday === 1 ? 'task' : 'tasks'}` : null].filter(Boolean);
    if (!parts.length) return s.now.reviewsDone ? 'Done for today' : 'A free day';
    return `${parts.join(' and ')} left today`;
}

