// The mirror's numbers (LOOP_COMPLETE_SPEC 1.7), pure.
import { describe, expect, it } from 'vitest';
import { minutesPerTopic, mondayOf, pathPace, weeklyMinutes } from '../../../src/services/learning/pace';
import type { DayString } from '../../../src/services/learning';

const d = (s: string) => s as DayString;
const topics = (done: string[], open: number) => [...done.map((day) => ({ status: 'done', doneDay: d(day) })), ...Array.from({ length: open }, () => ({ status: 'planned', doneDay: null }))];

describe('pathPace', () => {
    it('pace = topics finished in the last 28 days / 4; lands at that pace; behind gets the smallest fix', () => {
        const p = pathPace({ topics: topics(['2026-11-01', '2026-11-08'], 10), today: d('2026-11-14'), deadline: d('2026-12-31') });
        expect(p).toMatchObject({ done: 2, total: 12, remaining: 10, perWeek: 0.5, requiredPerWeek: 1.5, status: 'behind', fix: { extraPerWeek: 1 } });
        expect(p.landsOn).toBe('2027-04-03'); // 10 left at 0.5 a week: 20 weeks
    });

    it('ahead at 1.25 times the need; on track without a deadline when moving; done; overdue; no data', () => {
        const fast = pathPace({ topics: topics(['2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10'], 2), today: d('2026-11-14'), deadline: d('2027-05-16') });
        expect(fast.status).toBe('ahead');
        expect(pathPace({ topics: topics(['2026-11-10'], 3), today: d('2026-11-14') }).status).toBe('on_track');
        expect(pathPace({ topics: topics(['2026-11-10'], 0), today: d('2026-11-14'), deadline: d('2026-12-01') }).status).toBe('done');
        expect(pathPace({ topics: topics([], 3), today: d('2026-11-14'), deadline: d('2026-11-01') }).status).toBe('overdue');
        expect(pathPace({ topics: topics([], 3), today: d('2026-11-14'), deadline: d('2027-01-01') }).status).toBe('no_data');
        expect(pathPace({ topics: [{ status: 'skipped', doneDay: null }, ...topics([], 1)], today: d('2026-11-14') }).total).toBe(1);
    });
});

describe('weeks and minutes', () => {
    it('Monday weeks, oldest first, minutes per kind', () => {
        expect(mondayOf(d('2026-11-15'))).toBe('2026-11-09');
        const w = weeklyMinutes([{ day: d('2026-11-10'), kind: 'study', minutes: 40 }, { day: d('2026-11-02'), kind: 'build', minutes: 90 }, { day: d('2026-09-01'), kind: 'study', minutes: 10 }], d('2026-11-14'), 3);
        expect(w.map((x) => x.weekStart)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
        expect(w[1]!.minutes.build).toBe(90);
        expect(w[2]!.minutes.study).toBe(40);
    });

    it('minutes per topic only with 3 finished topics that have time', () => {
        expect(minutesPerTopic([{ topicId: 'a', minutes: 60 }, { topicId: 'b', minutes: 0 }, { topicId: 'c', minutes: 30 }])).toBeNull();
        expect(minutesPerTopic([{ topicId: 'a', minutes: 60 }, { topicId: 'b', minutes: 45 }, { topicId: 'c', minutes: 30 }])).toBe(45);
    });
});
