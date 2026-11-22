// A goal's paths and their pace (LOOP_COMPLETE_SPEC 1.7), shared by the mirror (GET /api/mirror, the
// brief, the MCP's get_mirror) and Where you stand (GET /api/mirror/stand), so both read one number.
import type { TopicStatus } from '@prisma/client';
import { dayOf, type DayString } from '../learning';
import { pathPace, type PathPace } from '../learning/pace';
import { fromDbDay } from '../learningDb/common';

export interface PaceTopic {
    subjectId: string;
    status: TopicStatus;
    doneAt: Date | null;
}

export interface PathOfGoal extends PathPace {
    subject: { _id: string; name: string; color: string | null };
}

/** A subject's path pace; null when it has no path (no topic planned or in progress, none finished on a known day). */
export function paceOfSubject(topics: readonly PaceTopic[], subjectId: string, ctx: { today: DayString; tz: string }, deadline: DayString | null): PathPace | null {
    const own = topics.filter((t) => t.subjectId === subjectId);
    if (!own.some((t) => t.status === 'planned' || t.status === 'in_progress') && !own.some((t) => t.status === 'done' && t.doneAt)) return null;
    return pathPace({ topics: own.map((t) => ({ status: t.status, doneDay: t.doneAt ? dayOf(t.doneAt, ctx.tz) : null })), today: ctx.today, deadline });
}

/** Each of a goal's subjects that has a path, with its pace against the goal's deadline (the goal's own subject order). */
export function pathsOfGoal(
    goal: { deadline: Date; subjects: ReadonlyArray<{ subject: { id: string; name: string; color: string | null } }> },
    topics: readonly PaceTopic[],
    ctx: { today: DayString; tz: string }
): PathOfGoal[] {
    const deadline = fromDbDay(goal.deadline);
    return goal.subjects.flatMap(({ subject }) => {
        const pace = paceOfSubject(topics, subject.id, ctx, deadline);
        return pace ? [{ subject: { _id: subject.id, name: subject.name, color: subject.color }, ...pace }] : [];
    });
}
