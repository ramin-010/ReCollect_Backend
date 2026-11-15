// The week (LOOP_COMPLETE_SPEC 1.6), the pure parts: Mondays, the review's week, counts, proposals.
import { describe, expect, it } from 'vitest';
import { countProgress, isSunday, reviewWeekOf, weekStartOf } from '../../../src/services/learningDb/week.service';
import { weekProposals } from '../../../src/services/learningDb/suggestions.service';
import type { DayString } from '../../../src/services/learning';

const d = (s: string) => s as DayString;

describe('weeks', () => {
    it('Monday to Sunday; the review plans next week on Sunday, this week on other days', () => {
        expect(weekStartOf(d('2026-11-16'))).toBe('2026-11-16');
        expect(weekStartOf(d('2026-11-22'))).toBe('2026-11-16');
        expect(weekStartOf(d('2026-11-14'))).toBe('2026-11-09');
        expect(isSunday(d('2026-11-15'))).toBe(true);
        expect(reviewWeekOf(d('2026-11-15'))).toBe('2026-11-16');
        expect(reviewWeekOf(d('2026-11-18'))).toBe('2026-11-16');
    });

    it('counts: practice sessions, minutes, topics finished, in a subject or project; capped at the amount', () => {
        const activity = {
            sessions: [
                { kind: 'practice' as const, minutes: 20, subjectId: 'dsa', projectId: null },
                { kind: 'practice' as const, minutes: 30, subjectId: 'sd', projectId: null },
                { kind: 'build' as const, minutes: 90, subjectId: null, projectId: 'p1' },
            ],
            topicsDone: [{ subjectId: 'dsa' }, { subjectId: 'dsa' }, { subjectId: 'sd' }],
        };
        const t = (measure: 'practice' | 'minutes' | 'topics', amount: number, subjectId: string | null = null, projectId: string | null = null) => countProgress({ measure, amount, subjectId, projectId }, activity);
        expect(t('practice', 10)).toEqual({ done: 2, total: 10 });
        expect(t('practice', 10, 'dsa')).toEqual({ done: 1, total: 10 });
        expect(t('minutes', 600, null, 'p1')).toEqual({ done: 90, total: 600 });
        expect(t('topics', 1, 'dsa')).toEqual({ done: 1, total: 1 });
        expect(countProgress({ measure: null, amount: null, subjectId: null, projectId: null }, activity)).toBeNull();
    });
});

describe('the review’s proposals', () => {
    const topics = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ _id: `t${from + i}`, title: `Topic ${from + i}`, position: from + i, status: 'planned' }));

    it('goal paths at the pace the deadline needs (≤ 2 per path), a milestone soon, last week’s open ones, a recent path, the coach; 5 at most, no repeats', () => {
        const out = weekProposals({
            weekStart: d('2026-11-16'),
            goals: [{ title: 'Offer', deadline: d('2026-11-30'), subjectIds: ['sd'], milestones: [{ id: 'm1', title: 'Mock interview', dueDay: d('2026-11-20'), done: false }] }],
            paths: [
                { subjectId: 'sd', name: 'System Design', topics: [{ _id: 't0', title: 'Caching', position: 1, status: 'done' }, ...topics(4, 2)] },
                { subjectId: 'dsa', name: 'DSA', topics: topics(3, 10) },
            ],
            recentSubjectIds: ['dsa'],
            lastWeekOpen: [
                { text: 'Finish 2. Topic 2', topicId: 't2', milestoneId: null, todoId: null, measure: null, amount: null, subjectId: null, projectId: null },
                { text: '10 graph problems', topicId: null, milestoneId: null, todoId: null, measure: 'practice', amount: 10, subjectId: 'dsa', projectId: null },
            ],
            coachLine: 'Two sliding-window mediums',
        });
        expect(out.map((p) => p.text)).toEqual(['Finish 2. Topic 2', 'Finish 3. Topic 3', 'Mock interview', 'Keep: 10 graph problems', 'Finish 10. Topic 10']);
    });

    it('a far deadline asks one topic a week; nothing to propose is an empty list', () => {
        const far = weekProposals({ weekStart: d('2026-11-16'), goals: [{ title: 'Offer', deadline: d('2027-05-16'), subjectIds: ['sd'], milestones: [] }], paths: [{ subjectId: 'sd', name: 'SD', topics: topics(6) }], recentSubjectIds: [], lastWeekOpen: [], coachLine: null });
        expect(far.map((p) => p.text)).toEqual(['Finish 1. Topic 1']);
        expect(weekProposals({ weekStart: d('2026-11-16'), goals: [], paths: [], recentSubjectIds: [], lastWeekOpen: [], coachLine: null })).toEqual([]);
    });
});
