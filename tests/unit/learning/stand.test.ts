// Where you stand (WHERE_YOU_STAND_PLAN §5), pure: spans, where the record starts, every measure, the
// words and the verdict.
import { describe, expect, it } from 'vitest';
import { addDays, rhythmLast7, type DayString } from '../../../src/services/learning';
import {
    activeDaySet,
    buildStand,
    compareWords,
    goalLineOf,
    isEmpty,
    measures,
    recordStartOf,
    spanBefore,
    spanEnding,
    standDays,
    verdictLines,
    type GoalLine,
    type StandPeriod,
    type StandRows,
} from '../../../src/services/learning/stand';

const d = (s: string) => s as DayString;
const TODAY = d('2026-11-22'); // a Sunday: this week's Monday is 16 Nov

const empty = (): StandRows => ({ sessions: [], revisions: [], topicsDone: [], focus: [], targets: [], milestonesDone: [], weakSpots: [], recallSets: [], docs: [], subjects: [] });

/** Two weeks of record: the last 7 days (16-22 Nov) and the 7 before (9-15 Nov), with older edges. */
function fixture(): StandRows {
    return {
        sessions: [
            { day: d('2026-11-16'), kind: 'study', minutes: 40, outcome: null },
            { day: d('2026-11-17'), kind: 'build', minutes: 20, outcome: null },
            { day: d('2026-11-17'), kind: 'build', minutes: 15, outcome: null },
            { day: d('2026-11-18'), kind: 'practice', minutes: 25, outcome: 'alone' },
            { day: d('2026-11-20'), kind: 'practice', minutes: 10, outcome: 'hints' },
            { day: d('2026-11-10'), kind: 'study', minutes: 60, outcome: null },
            { day: d('2026-11-12'), kind: 'review', minutes: 30, outcome: null },
        ],
        revisions: [
            { scheduledFor: d('2026-11-16'), completedDay: d('2026-11-16'), status: 'done' }, // on its day
            { scheduledFor: d('2026-11-17'), completedDay: d('2026-11-19'), status: 'done' }, // late
            { scheduledFor: d('2026-11-21'), completedDay: null, status: 'pending' }, // still open
            { scheduledFor: d('2026-11-05'), completedDay: d('2026-11-18'), status: 'done' }, // a catch-up now
            { scheduledFor: d('2026-11-10'), completedDay: d('2026-11-10'), status: 'done' }, // before: on its day
            { scheduledFor: d('2026-11-12'), completedDay: d('2026-11-16'), status: 'done' }, // before: late; now: a catch-up
        ],
        topicsDone: [
            { doneDay: d('2026-11-18'), subjectId: 's1' },
            { doneDay: d('2026-11-19'), subjectId: 's2' },
            { doneDay: d('2026-11-20'), subjectId: 's1' },
            { doneDay: d('2026-11-13'), subjectId: 's1' },
        ],
        focus: [
            { day: d('2026-11-16'), done: true },
            { day: d('2026-11-17'), done: false },
            { day: d('2026-11-19'), done: true },
            { day: d('2026-11-11'), done: true },
        ],
        targets: [
            { weekStart: d('2026-11-16'), status: 'done' },
            { weekStart: d('2026-11-16'), status: 'open' },
            { weekStart: d('2026-11-16'), status: 'dropped' },
            { weekStart: d('2026-11-09'), status: 'done' },
            { weekStart: d('2026-11-09'), status: 'done' },
        ],
        milestonesDone: [d('2026-11-20'), d('2026-11-01')],
        weakSpots: [
            { createdDay: d('2026-11-17'), clearedDay: d('2026-11-19') },
            { createdDay: d('2026-11-02'), clearedDay: d('2026-11-18') },
            { createdDay: d('2026-11-10'), clearedDay: null },
        ],
        recallSets: [
            { finishedDay: d('2026-11-19'), result: 'strong' },
            { finishedDay: d('2026-11-20'), result: 'partial' },
        ],
        docs: [
            { createdDay: d('2026-11-18'), updatedDay: d('2026-11-18') }, // written now
            { createdDay: d('2026-10-01'), updatedDay: d('2026-11-20') }, // an older note worked on now
            { createdDay: d('2026-11-10'), updatedDay: d('2026-11-20') }, // written before, worked on now
        ],
        subjects: [
            { id: 's1', name: 'DSA' },
            { id: 's2', name: 'System design' },
        ],
    };
}

const goalBehind: GoalLine = {
    title: 'Offer',
    deadline: d('2027-05-16'),
    paths: [
        { subject: 'DSA', perWeek: 2, requiredPerWeek: 3, remaining: 50, status: 'behind' },
        { subject: 'System design', perWeek: 1, requiredPerWeek: 1.5, remaining: 20, status: 'behind' },
    ],
};

describe('spans and where the record starts', () => {
    it('rolling windows end today; the span before has the same length and ends the day before', () => {
        expect(spanEnding(TODAY, 'week')).toEqual({ from: '2026-11-16', to: '2026-11-22' });
        expect(spanEnding(TODAY, 'month')).toEqual({ from: '2026-10-26', to: '2026-11-22' });
        expect(spanEnding(TODAY, 'year')).toEqual({ from: '2025-11-24', to: '2026-11-22' });
        expect(spanBefore(spanEnding(TODAY, 'week'))).toEqual({ from: '2026-11-09', to: '2026-11-15' });
        expect(spanBefore(spanEnding(TODAY, 'month'))).toEqual({ from: '2026-09-28', to: '2026-10-25' });
        expect(spanBefore(spanEnding(TODAY, 'year'))).toEqual({ from: '2024-11-25', to: '2025-11-23' });
    });

    it('the record starts on the earliest known day; nulls are skipped; the fallback without any', () => {
        expect(recordStartOf([d('2026-11-21'), d('2026-08-23'), null, d('2026-10-15'), undefined], d('2026-11-21'))).toBe('2026-08-23');
        expect(recordStartOf([null, undefined], d('2026-11-21'))).toBe('2026-11-21');
    });
});

describe('the active days', () => {
    it('follow the rhythm’s rule exactly (a review done, a focus line done, a session logged), on random records', () => {
        let seed = 7;
        const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        const pick = () => addDays(TODAY, -Math.floor(rand() * 20));
        for (let run = 0; run < 25; run++) {
            const rows = empty();
            const revisions = [] as Array<StandRows['revisions'][number]>;
            for (let i = 0; i < 6; i++) {
                const done = rand() < 0.6;
                revisions.push({ scheduledFor: pick(), completedDay: done ? pick() : null, status: done ? 'done' : 'pending' });
            }
            const focus = Array.from({ length: 4 }, () => ({ day: pick(), done: rand() < 0.5 }));
            const sessions = Array.from({ length: 3 }, () => ({ day: pick(), kind: 'study' as const, minutes: 10, outcome: null }));
            Object.assign(rows, { revisions, focus, sessions });
            const rhythm = rhythmLast7({
                today: TODAY,
                tz: 'UTC',
                completions: revisions.filter((r) => r.completedDay).map((r) => new Date(`${r.completedDay}T12:00:00Z`)),
                focusDoneDays: focus.filter((f) => f.done).map((f) => f.day),
                sessionDays: sessions.map((s) => s.day),
            });
            const ours = [...activeDaySet(rows, spanEnding(TODAY, 'week'))].sort();
            expect(ours).toEqual(rhythm.last7.filter((x) => x.active).map((x) => x.day));
        }
    });
});

describe('measures', () => {
    it('counts each dimension of the last 7 days and of the 7 before', () => {
        const rows = fixture();
        const now = measures(rows, spanEnding(TODAY, 'week'), d('2026-10-01'));
        expect(now).toMatchObject({
            days: 7,
            activeDays: 5,
            daysWithSitting: 2,
            minutes: { study: 40, practice: 35, build: 35, review: 0 },
            totalMinutes: 110,
            sessions: 5,
            reviews: { due: 3, onDay: 1, late: 1, open: 1, catchUps: 2 },
            focus: { set: 3, done: 2 },
            targets: { set: 3, done: 1, dropped: 1 },
            topicsDone: 3,
            topicsBySubject: [
                { subjectId: 's1', name: 'DSA', done: 2 },
                { subjectId: 's2', name: 'System design', done: 1 },
            ],
            milestonesDone: 1,
            weakSpots: { found: 1, cleared: 2 },
            recall: { sets: 2, strong: 1, partial: 1, weak: 0 },
            practice: { total: 2, alone: 1, hints: 1, afterAnswer: 0 },
            notes: { written: 1, workedOn: 2 },
        });
        const before = measures(rows, spanBefore(spanEnding(TODAY, 'week')), d('2026-10-01'));
        expect(before).toMatchObject({
            activeDays: 3,
            daysWithSitting: 2,
            totalMinutes: 90,
            reviews: { due: 2, onDay: 1, late: 1, open: 0, catchUps: 0 },
            focus: { set: 1, done: 1 },
            targets: { set: 2, done: 2, dropped: 0 },
            topicsDone: 1,
            milestonesDone: 0,
            weakSpots: { found: 1, cleared: 0 },
            recall: { sets: 0 },
            notes: { written: 1, workedOn: 0 },
        });
    });

    it('covers only the days since the record started; an empty span is empty', () => {
        expect(measures(empty(), spanEnding(TODAY, 'week'), d('2026-11-20')).days).toBe(3);
        expect(isEmpty(measures(empty(), spanEnding(TODAY, 'week'), d('2026-11-20')))).toBe(true);
        expect(isEmpty(measures(fixture(), spanEnding(TODAY, 'week'), d('2026-10-01')))).toBe(false);
    });
});

describe('words', () => {
    it('compares counts and minutes (minutes under 15 apart are about the same)', () => {
        expect(compareWords(5, 3, 'count')).toBe('2 more than');
        expect(compareWords(3, 5, 'count')).toBe('2 fewer than');
        expect(compareWords(4, 4, 'count')).toBe('the same as');
        expect(compareWords(110, 100, 'minutes')).toBe('about the same as');
        expect(compareWords(110, 90, 'minutes')).toBe('20 min more than');
        expect(compareWords(60, 190, 'minutes')).toBe('2 h 10 min less than');
    });
});

describe('the verdict', () => {
    const period = (rows: StandRows, window: StandPeriod['window'], recordStart: string): Omit<StandPeriod, 'verdict'> => {
        const span = spanEnding(TODAY, window);
        const prior = spanBefore(span);
        const before = prior.from < recordStart ? null : prior;
        return {
            window,
            span,
            partial: span.from < recordStart,
            before,
            current: measures(rows, span, d(recordStart)),
            previous: before ? measures(rows, before, d(recordStart)) : null,
        };
    };
    const ctx = (recordStart: string) => ({ today: TODAY, recordStart: d(recordStart) });

    it('a full week with a path behind: consistency, effort, the goal’s gap', () => {
        expect(verdictLines(period(fixture(), 'week', '2026-10-01'), goalBehind, ctx('2026-10-01'))).toEqual([
            'Active 5 of the last 7 days, 2 more than the 7 days before.',
            '1 h 50 min logged, 20 min more than the 7 days before.',
            'DSA needs 3 topics a week to make Offer by 16 May 2027; the last 4 weeks averaged 2.',
        ]);
    });

    it('a month with no full span before, and a year: the window’s own words; most of it by kind', () => {
        expect(verdictLines(period(fixture(), 'month', '2026-10-01'), null, ctx('2026-10-01'))).toEqual(['Active 8 days in the last 4 weeks.', '3 h 20 min logged; most of it study.']);
        expect(verdictLines(period(fixture(), 'year', '2024-01-01'), null, ctx('2024-01-01'))).toEqual([
            'Active 8 days in the last year, 8 more than the year before.',
            '3 h 20 min logged, 3 h 20 min more than the year before; most of it study.',
        ]);
    });

    it('a window the record starts inside says so; the first day; nothing at all', () => {
        const rows = empty();
        rows.sessions = [{ day: d('2026-11-20'), kind: 'study', minutes: 45, outcome: null }];
        rows.revisions = [{ scheduledFor: d('2026-11-21'), completedDay: d('2026-11-21'), status: 'done' }];
        expect(verdictLines(period(rows, 'week', '2026-11-20'), null, ctx('2026-11-20'))).toEqual(['Active 2 of the 3 days since the record started on 20 Nov.', '45 min logged since 20 Nov; all of it study.']);
        const first = empty();
        first.revisions = [{ scheduledFor: TODAY, completedDay: null, status: 'pending' }];
        expect(verdictLines(period(first, 'week', TODAY), null, ctx(TODAY))).toEqual(['Nothing yet today, the first day of the record.', 'Nothing logged since 22 Nov.']);
        expect(verdictLines(period(empty(), 'week', TODAY), null, ctx(TODAY))).toEqual(['Nothing in the record yet. Reviews, focus lines and logged sessions fill this in.']);
        expect(verdictLines(period(empty(), 'week', '2026-01-01'), null, ctx('2026-01-01'))).toEqual(['Nothing in the record for the last 7 days. Reviews, focus lines and logged sessions fill this in.']);
    });

    it('nothing logged now but hours before; the goal on pace, past its deadline, a path with nothing finished lately', () => {
        const rows = fixture();
        rows.sessions = rows.sessions.filter((s) => s.day < '2026-11-16');
        const p = period(rows, 'week', '2026-10-01');
        expect(verdictLines(p, null, ctx('2026-10-01'))[1]).toBe('Nothing logged in the last 7 days; 1 h 30 min the 7 days before.');
        const onPace = (n: number): GoalLine => ({ ...goalBehind, paths: goalBehind.paths.slice(0, n).map((x) => ({ ...x, status: 'on_track' as const })) });
        expect(verdictLines(p, onPace(1), ctx('2026-10-01'))[2]).toBe('DSA is on pace to make Offer by 16 May 2027.');
        expect(verdictLines(p, onPace(2), ctx('2026-10-01'))[2]).toBe('2 paths are on pace to make Offer by 16 May 2027.');
        const overdue: GoalLine = { title: 'Offer', deadline: d('2026-11-01'), paths: [{ subject: 'DSA', perWeek: 0, requiredPerWeek: 28, remaining: 4, status: 'overdue' }] };
        expect(verdictLines(p, overdue, ctx('2026-10-01'))[2]).toBe('Offer passed its deadline on 1 Nov with 4 topics left.');
        const stalled: GoalLine = { ...goalBehind, paths: [{ subject: 'DSA', perWeek: 0, requiredPerWeek: 1, remaining: 9, status: 'behind' }] };
        expect(verdictLines(p, stalled, ctx('2026-10-01'))[2]).toBe('DSA needs 1 topic a week to make Offer by 16 May 2027; none were finished in the last 4 weeks.');
    });

    it('the goal it speaks about: the nearest with a path in motion', () => {
        const idle: GoalLine = { title: 'Idle', deadline: d('2026-12-01'), paths: [{ subject: 'X', perWeek: 0, requiredPerWeek: 2, remaining: 3, status: 'no_data' }] };
        expect(goalLineOf([idle, goalBehind])?.title).toBe('Offer');
        expect(goalLineOf([idle])).toBeNull();
    });
});

describe('the whole stand', () => {
    it('three windows: a comparison only against a span the record covers in full; 364 days for the grid', () => {
        const s = buildStand(fixture(), { today: TODAY, recordStart: d('2026-10-01'), goal: goalBehind });
        expect(s.periods.week).toMatchObject({ partial: false, before: { from: '2026-11-09', to: '2026-11-15' } });
        expect(s.periods.week.previous?.activeDays).toBe(3);
        expect(s.periods.month).toMatchObject({ partial: false, before: null, previous: null });
        expect(s.periods.year).toMatchObject({ partial: true, before: null });
        expect(s.periods.year.current.days).toBe(53);
        expect(s.periods.week.verdict).toHaveLength(3);
        expect(s.days).toHaveLength(364);
        expect(s.days[s.days.length - 1]).toMatchObject({ day: TODAY, active: false });
        expect(s.days.find((x) => x.day === '2026-11-17')).toMatchObject({ active: true, minutes: 35, byKind: { build: 35 }, sessions: 2, reviews: 0, focus: 0 });
        expect(s.days.find((x) => x.day === '2026-11-19')).toMatchObject({ active: true, minutes: 0, reviews: 1, focus: 1, sessions: 0 });
        expect(standDays(empty(), TODAY)[0]!.day).toBe('2025-11-24');
    });
});

describe('lenses (PERSONAL_OFFICE_PLAN)', () => {
    /** A week with personal study and work time: the service hands in what each lens sees. */
    const rows = (lens: 'personal' | 'work' | 'all'): StandRows => {
        const all = [
            { day: d('2026-11-16'), kind: 'study' as const, minutes: 40, outcome: null, area: 'personal' as const, place: 'DSA' },
            { day: d('2026-11-17'), kind: 'build' as const, minutes: 300, outcome: null, area: 'work' as const, place: 'erp-workspace' },
            { day: d('2026-11-18'), kind: 'build' as const, minutes: 240, outcome: null, area: 'work' as const, place: 'erp-workspace' },
            { day: d('2026-11-18'), kind: 'build' as const, minutes: 30, outcome: null, area: 'personal' as const, place: 'second_brain' },
            { day: d('2026-11-10'), kind: 'build' as const, minutes: 200, outcome: null, area: 'work' as const, place: 'erp-workspace' },
        ];
        const base = lens === 'work' ? empty() : { ...empty(), revisions: [{ scheduledFor: d('2026-11-19'), completedDay: d('2026-11-19'), status: 'done' as const }] };
        return { ...base, sessions: all.filter((x) => lens === 'all' || x.area === lens) };
    };
    const stand = (lens: 'personal' | 'work' | 'all') => buildStand(rows(lens), { today: TODAY, recordStart: d('2026-10-01'), goal: null, lens });

    it('a day is active by the lens: personal ignores work days; work counts work days only; all counts both', () => {
        expect(stand('personal').periods.week.current.activeDays).toBe(3); // 16 (study), 18 (personal build), 19 (review)
        expect(stand('work').periods.week.current.activeDays).toBe(2); // 17, 18
        expect(stand('all').periods.week.current.activeDays).toBe(4);
        expect(stand('personal').days.find((x) => x.day === '2026-11-17')).toMatchObject({ active: false, minutes: 0 });
        expect(stand('work').days.find((x) => x.day === '2026-11-19')).toMatchObject({ active: false });
    });

    it('minutes by area, and where the time went on a day', () => {
        const all = stand('all');
        expect(all.periods.week.current.minutesByArea).toEqual({ personal: 70, work: 540 });
        expect(all.days.find((x) => x.day === '2026-11-18')).toMatchObject({
            minutes: 270,
            byArea: { personal: 30, work: 240 },
            places: [
                { name: 'erp-workspace', minutes: 240, area: 'work' },
                { name: 'second_brain', minutes: 30, area: 'personal' },
            ],
        });
        expect(all.days.find((x) => x.day === '2026-11-19')?.places).toBeUndefined();
    });

    it('the words: worked days and hours at work for Work; the split for All; Personal as before', () => {
        expect(stand('work').periods.week.verdict).toEqual(['Worked 2 of the last 7 days, 1 more than the 7 days before.', '9 h at work, 5 h 40 min more than the 7 days before.']);
        expect(stand('all').periods.week.verdict).toEqual([
            'Active 4 of the last 7 days, 3 more than the 7 days before.',
            '10 h 10 min logged, 6 h 50 min more than the 7 days before; 1 h 10 min personal, 9 h work.',
        ]);
        expect(stand('personal').periods.week.verdict).toEqual(['Active 3 of the last 7 days, 3 more than the 7 days before.', '1 h 10 min logged, 1 h 10 min more than the 7 days before; most of it study.']);
        const none = buildStand(empty(), { today: TODAY, recordStart: d('2026-01-01'), goal: null, lens: 'work' });
        expect(none.periods.week.verdict).toEqual(['No work tracked in the last 7 days. Claude Code in a folder marked Work fills this in.']);
    });
});
