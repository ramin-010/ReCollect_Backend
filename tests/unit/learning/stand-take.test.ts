// The buddy's take on where they stand (WHERE_YOU_STAND_PLAN §9), pure: the record it reads, its request, reading
// its answer back, and the number check (a take may only use numbers the record holds).
import { describe, expect, it } from 'vitest';
import type { DayString } from '../../../src/services/learning';
import { buildStand, type StandRows } from '../../../src/services/learning/stand';
import { parseTake, takeEvidence, takeRequest, TAKE_PERSPECTIVE, TAKE_SCHEMA, unsupported, type TakeInput } from '../../../src/services/mirror/take';
import { ModelOutputError } from '../../../src/services/recall/output';

const d = (s: string) => s as DayString;
const TODAY = d('2026-11-22');

function rows(): StandRows {
    return {
        sessions: [
            { day: d('2026-11-16'), kind: 'study', minutes: 40, outcome: null },
            { day: d('2026-11-18'), kind: 'build', minutes: 95, outcome: null },
            { day: d('2026-11-10'), kind: 'study', minutes: 60, outcome: null },
        ],
        revisions: [{ scheduledFor: d('2026-11-16'), completedDay: d('2026-11-16'), status: 'done' }],
        topicsDone: [{ doneDay: d('2026-11-18'), subjectId: 's1' }],
        focus: [],
        targets: [],
        milestonesDone: [],
        weakSpots: [],
        recallSets: [],
        docs: [],
        subjects: [{ id: 's1', name: 'System Design' }],
    };
}

function input(window: 'week' | 'month' | 'year' = 'week'): TakeInput {
    const stand = buildStand(rows(), { today: TODAY, recordStart: d('2026-08-23'), goal: null });
    return {
        today: TODAY,
        recordStart: d('2026-08-23'),
        period: stand.periods[window],
        days: stand.days,
        openNow: 4,
        weakOpenNow: 1,
        goals: [
            {
                title: 'Backend offer',
                deadline: d('2027-05-16'),
                daysLeft: 175,
                milestones: { done: 0, total: 6 },
                forecast: 'behind',
                paths: [{ subject: 'System Design', done: 3, total: 20, perWeek: 0.3, requiredPerWeek: 0.7, status: 'behind', landsOn: null }],
            },
        ],
        portrait: { who: 'An engineer who studies in the evenings.', heading: 'A backend role.', now: 'A quiet week.' },
    };
}

describe('takeEvidence', () => {
    it('reads the window against the span before, the timeline, the goals and the portrait, with dates and time as words', () => {
        const e = takeEvidence(input('week'));
        expect(e.window).toBe('the last 7 days');
        expect(e.span).toBe('16 Nov to 22 Nov');
        expect(e.now).toMatchObject({ active_days: '2 of 7', time_logged: '2 h 15 min', topics_finished: '1 (System Design 1)' });
        expect(e.before).toMatchObject({ span: '9 Nov to 15 Nov', active_days: '1 of 7', time_logged: '1 h' });
        expect(e.timeline).toHaveLength(7);
        expect(e.timeline[2]).toEqual({ when: 'Wed 18 Nov', logged: '1 h 35 min' });
        expect(e.goals[0]).toMatchObject({ due: '16 May 2027', days_left: 175, milestones: '0 of 6', paths: [{ topics: '3 of 20', per_week_now: 0.3, per_week_needed: 0.7 }] });
        expect(e.waiting_now).toEqual({ reviews_from_earlier_days: 4, weak_spots_open: 1 });
        expect(e.who_they_are).toBe('An engineer who studies in the evenings.');
        // Nothing empty is sent: no reviews line without reviews in the span before.
        expect(e.before).not.toHaveProperty('focus_lines');
    });

    it('a month reads week by week; a year month by month, inside the record only', () => {
        const month = takeEvidence(input('month'));
        expect(month.timeline).toHaveLength(4);
        expect(month.timeline[month.timeline.length - 1]).toMatchObject({ when: '16 Nov to 22 Nov', logged: '2 h 15 min', active_days: 2 });
        const year = takeEvidence(input('year'));
        expect(year.window).toBe('since the record started on 23 Aug');
        expect(year.timeline.map((t) => t.when)).toEqual(['Aug 2026', 'Sept 2026', 'Oct 2026', 'Nov 2026']);
        expect(year.before).toBeNull();
    });
});

describe('takeRequest', () => {
    it('is the buddy speaking: its character and the job cached, the record after, a structured text', () => {
        const r = takeRequest({ character: 'You are Sam, their buddy.', evidence: takeEvidence(input()), window: 'week' });
        const system = r.system as Array<{ text: string; cache_control?: unknown }>;
        expect(system[0]!.text.startsWith('You are Sam, their buddy.')).toBe(true);
        expect(system[0]!.text).toContain('Where you stand');
        expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' });
        expect(r.output_config?.format).toMatchObject({ type: 'json_schema', schema: TAKE_SCHEMA });
        const user = (r.messages[0]!.content as Array<{ text: string }>)[0]!.text;
        expect(user.startsWith('<record>\n{')).toBe(true);
        expect(user).toContain('Your take on the last 7 days.');
        const again = takeRequest({ character: 'x', evidence: takeEvidence(input()), window: 'week', retryWithout: ['12'] });
        expect((again.messages[0]!.content as Array<{ text: string }>)[0]!.text).toContain("numbers the record doesn't hold (12)");
    });

    it('asks for honest feedback and a way back from a bad stretch, from its own perspective per window', () => {
        const systemOf = (window: 'week' | 'month' | 'year') => (takeRequest({ character: 'x', evidence: takeEvidence(input(window)), window }).system as Array<{ text: string }>)[0]!.text;
        const [week, month, year] = [systemOf('week'), systemOf('month'), systemOf('year')];
        for (const s of [week, month, year]) {
            expect(s).toContain('Be honest above all');
            expect(s).toContain('help them come back');
            expect(s).toContain('This window:');
        }
        expect(week).toContain(TAKE_PERSPECTIVE.week);
        expect(week).toContain("the week's rhythm");
        expect(month).toContain("the month's trend");
        expect(year).toContain('the long arc');
        expect(new Set([week, month, year]).size).toBe(3);
    });
});

describe('parseTake and unsupported', () => {
    it('reads one tidy text; an empty or missing one is unusable', () => {
        expect(parseTake(JSON.stringify({ text: '  Two days this week,\n and both were real work.  ' }))).toBe('Two days this week, and both were real work.');
        expect(() => parseTake(JSON.stringify({ text: 'ok' }))).toThrow(ModelOutputError);
        expect(() => parseTake(JSON.stringify({ words: 'nothing' }))).toThrow(ModelOutputError);
    });

    it('finds numbers the record does not hold; the record’s own pass', () => {
        const e = takeEvidence(input());
        expect(unsupported('2 h 15 min over 2 days, up from 1 h; System Design needs 0.7 a week and you are at 0.3.', e)).toEqual([]);
        expect(unsupported('Almost 47 hours this week, 12 topics to go.', e)).toEqual(['47', '12']);
    });
});
