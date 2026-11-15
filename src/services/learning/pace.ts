/**
 * The mirror's numbers (LOOP_COMPLETE_SPEC 1.7), pure: no DB, no clock. Code computes every number;
 * the coach and the page only put them into words and pictures.
 *
 *   pathPace        a path's pace: topics finished in the last 28 days ÷ 4 (a week's pace), what the
 *                   deadline needs, the day the last topic lands at this pace, a status in the
 *                   goal forecast's words, and the smallest fix as numbers
 *   weeklyMinutes   minutes per week per kind, for the last N weeks (Monday to Sunday)
 *   minutesPerTopic minutes of study per finished topic, only with 3 or more finished topics that
 *                   have sessions ("not enough yet" otherwise: never a guess)
 */
import { addDays, diffDays, type DayString } from './time';

export const PACE_WINDOW_DAYS = 28;
/** At least this many finished topics with sessions before minutes per topic is shown. */
export const MINUTES_PER_TOPIC_MIN = 3;

export type PaceStatus = 'done' | 'overdue' | 'no_data' | 'behind' | 'ahead' | 'on_track';

export interface PathPace {
    done: number;
    total: number;
    remaining: number;
    /** Topics finished in the last 28 days ÷ 4, one decimal. */
    perWeek: number;
    /** Remaining ÷ weeks left to the deadline, one decimal; null without a deadline. */
    requiredPerWeek: number | null;
    /** The day the last topic lands at this pace; null when the pace is 0 or nothing is left. */
    landsOn: DayString | null;
    status: PaceStatus;
    /** The smallest fix, in numbers: one more topic a week, or the day it would land. */
    fix: { extraPerWeek: number; orLandsOn: DayString | null } | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Monday of the week a day is in. */
export function mondayOf(day: DayString): DayString {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    return addDays(day, -((dow + 6) % 7));
}

export function pathPace(input: {
    /** The path's topics (skipped ones are left out of the count). */
    topics: ReadonlyArray<{ status: string; doneDay: DayString | null }>;
    today: DayString;
    deadline?: DayString | null;
}): PathPace {
    const topics = input.topics.filter((t) => t.status !== 'skipped');
    const total = topics.length;
    const done = topics.filter((t) => t.status === 'done').length;
    const remaining = total - done;
    const from = addDays(input.today, -(PACE_WINDOW_DAYS - 1));
    const recent = topics.filter((t) => t.status === 'done' && t.doneDay && t.doneDay >= from && t.doneDay <= input.today).length;
    const perWeek = round1(recent / (PACE_WINDOW_DAYS / 7));
    const landsOn = remaining > 0 && perWeek > 0 ? addDays(input.today, Math.ceil((remaining / perWeek) * 7)) : null;
    const deadline = input.deadline ?? null;
    const daysLeft = deadline ? diffDays(deadline, input.today) : null;
    const requiredPerWeek = deadline && remaining > 0 ? round1(remaining / Math.max(1 / 7, (daysLeft ?? 0) / 7)) : deadline ? 0 : null;

    let status: PaceStatus;
    if (total > 0 && remaining === 0) status = 'done';
    else if (deadline && daysLeft !== null && daysLeft < 0) status = 'overdue';
    else if (total === 0 || (perWeek === 0 && recent === 0 && done === 0)) status = 'no_data';
    else if (!deadline) status = perWeek > 0 ? 'on_track' : 'behind';
    else if (perWeek === 0 || (landsOn && landsOn > deadline)) status = 'behind';
    else if (requiredPerWeek !== null && perWeek >= requiredPerWeek * 1.25) status = 'ahead';
    else status = 'on_track';

    const fix =
        status === 'behind' && requiredPerWeek !== null
            ? { extraPerWeek: Math.max(1, Math.ceil(requiredPerWeek - perWeek)), orLandsOn: landsOn }
            : null;
    return { done, total, remaining, perWeek, requiredPerWeek, landsOn, status, fix };
}

export type MinutesByKind = Record<'study' | 'practice' | 'build' | 'review', number>;

/** Minutes per week per kind for the `weeks` weeks ending with today's, oldest first. */
export function weeklyMinutes(
    sessions: ReadonlyArray<{ day: DayString; kind: keyof MinutesByKind; minutes: number | null }>,
    today: DayString,
    weeks = 6
): Array<{ weekStart: DayString; minutes: MinutesByKind }> {
    const thisWeek = mondayOf(today);
    const out = Array.from({ length: weeks }, (_, i) => ({ weekStart: addDays(thisWeek, -7 * (weeks - 1 - i)), minutes: { study: 0, practice: 0, build: 0, review: 0 } as MinutesByKind }));
    for (const s of sessions) {
        const w = out.find((x) => s.day >= x.weekStart && s.day <= addDays(x.weekStart, 6));
        if (w) w.minutes[s.kind] += s.minutes ?? 0;
    }
    return out;
}

/** Minutes of sessions per finished topic, over finished topics that have sessions; null below 3. */
export function minutesPerTopic(finished: ReadonlyArray<{ topicId: string; minutes: number }>): number | null {
    const withTime = finished.filter((f) => f.minutes > 0);
    if (withTime.length < MINUTES_PER_TOPIC_MIN) return null;
    return Math.round(withTime.reduce((a, f) => a + f.minutes, 0) / withTime.length);
}
