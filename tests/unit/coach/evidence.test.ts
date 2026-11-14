// The weekly coach's evidence from fixture rows (src/services/coach/evidence.ts). No database.
// Today is Sat 2026-11-14 in Asia/Kolkata, so the week is Sat 11-07 … Fri 11-13.
import { describe, expect, it } from 'vitest';
import { LITTLE_EVIDENCE_POINTS, buildCoachEvidence, coachWindow, type CoachRows } from '../../../src/services/coach/evidence';

const tz = 'Asia/Kolkata';
const today = '2026-11-14';
const ctx = { ...coachWindow(today), today, tz };
/** A local (IST) instant. */
const at = (day: string, time = '10:00') => new Date(`${day}T${time}:00+05:30`);

const empty: CoachRows = { revisions: [], backlog: 0, recall: [], focus: [], docs: [], goals: [] };

const rows: CoachRows = {
    revisions: [
        { title: 'Two Sum', subject: 'DSA', scheduledFor: '2026-11-08', status: 'done', completedAt: at('2026-11-08') },
        { title: 'LRU cache', subject: 'DSA', scheduledFor: '2026-11-10', status: 'pending', completedAt: null },
        // Due in the week, done only today: missed.
        { title: 'Rate limiter', subject: 'System Design', scheduledFor: '2026-11-12', status: 'done', completedAt: at('2026-11-14', '09:00') },
        // Due before the week, caught up in it.
        { title: 'Dijkstra', subject: 'DSA', scheduledFor: '2026-11-03', status: 'done', completedAt: at('2026-11-09', '08:00') },
        // Done late on the week's last day (local time): on time.
        { title: 'Postgres MVCC', subject: null, scheduledFor: '2026-11-13', status: 'done', completedAt: at('2026-11-13', '23:30') },
        // Done the evening before the week began: not this week.
        { title: 'Heap', subject: 'DSA', scheduledFor: '2026-11-06', status: 'done', completedAt: at('2026-11-06', '23:50') },
    ],
    backlog: 2,
    recall: [
        {
            title: 'Dijkstra',
            finishedAt: at('2026-11-09', '08:30'),
            result: 'weak',
            questions: [
                { id: 'q1', prompt: 'Why does Dijkstra fail with negative edges?' },
                { id: 'q2', prompt: 'What does the priority queue hold?' },
                { id: 'q3', prompt: 'What is the complexity with a binary heap?' },
            ],
            attempts: [
                { questionId: 'q1', grade: 'weak', createdAt: at('2026-11-09', '08:10') },
                { questionId: 'q2', grade: 'weak', createdAt: at('2026-11-09', '08:12') },
                { questionId: 'q3', grade: 'partial', createdAt: at('2026-11-09', '08:14') },
            ],
        },
        {
            title: 'Two Sum',
            finishedAt: at('2026-11-08', '10:30'),
            result: 'strong',
            questions: [
                { id: 'q1', prompt: 'What does the map hold?' },
                { id: 'q2', prompt: 'Why check before storing?' },
            ],
            attempts: [
                { questionId: 'q1', grade: 'strong', createdAt: at('2026-11-08', '10:20') },
                { questionId: 'q2', grade: 'strong', createdAt: at('2026-11-08', '10:25') },
            ],
        },
        // Answered today: not this week.
        { title: 'Rate limiter', finishedAt: null, result: null, questions: [{ id: 'q1', prompt: 'Token bucket?' }], attempts: [{ questionId: 'q1', grade: 'weak', createdAt: at('2026-11-14', '09:00') }] },
    ],
    focus: [
        { day: '2026-11-08', text: 'Solve 2 graph problems', done: true },
        { day: '2026-11-08', text: 'Read DDIA ch. 5', done: false },
        { day: '2026-11-09', text: 'read DDIA ch. 5', done: false },
        { day: '2026-11-12', text: 'Mock interview', done: true },
    ],
    docs: [
        { title: 'Two Sum', createdAt: at('2026-11-08', '11:00'), updatedAt: at('2026-11-08', '11:30') },
        { title: 'Graphs', createdAt: at('2026-10-01'), updatedAt: at('2026-11-10') },
        { title: 'Old notes', createdAt: at('2026-10-01'), updatedAt: at('2026-11-14', '08:00') },
    ],
    goals: [
        {
            title: 'Product-company SDE role',
            deadline: '2027-06-30',
            createdDay: '2026-09-14',
            milestones: [
                { title: 'Arrays and hashing', done: true, doneAt: at('2026-10-01'), dueDay: null },
                { title: 'Graphs', done: true, doneAt: at('2026-11-10'), dueDay: null },
                { title: 'Dynamic programming', done: false, doneAt: null, dueDay: '2026-12-01' },
                { title: 'Mock interviews', done: false, doneAt: null, dueDay: null },
            ],
        },
    ],
};

describe('coachWindow', () => {
    it('is the 7 local days ending yesterday', () => {
        expect(coachWindow('2026-11-14')).toEqual({ weekStart: '2026-11-07', weekEnd: '2026-11-13' });
        expect(coachWindow('2026-03-01')).toEqual({ weekStart: '2026-02-22', weekEnd: '2026-02-28' });
    });
});

describe('buildCoachEvidence', () => {
    const e = buildCoachEvidence(rows, ctx);

    it('the week, and enough evidence', () => {
        expect(e.week).toEqual({ from: '2026-11-07', to: '2026-11-13', today: '2026-11-14' });
        expect(e.level).toBe('enough');
    });

    it('revisions: due / on time / missed / done (catch-up included) / backlog, by subject, missed titles (local-time boundaries)', () => {
        expect(e.revisions).toEqual({
            dueInWeek: 4,
            doneOnTime: 2,
            missed: 2,
            doneInWeek: 3,
            backlogFromBefore: 2,
            bySubject: [
                { subject: 'DSA', due: 2, done: 2, missed: 1 },
                { subject: 'No subject', due: 1, done: 1, missed: 0 },
                { subject: 'System Design', due: 1, done: 0, missed: 1 },
            ],
            missedTitles: ['LRU cache', 'Rate limiter'],
        });
    });

    it('recall: finished reviews by result, answers by grade, the weakest topics with their weak questions', () => {
        expect(e.recall).toEqual({
            reviewsFinished: 2,
            results: { strong: 1, partial: 0, weak: 1 },
            answers: { strong: 2, partial: 1, weak: 2 },
            weakestTopics: [
                { title: 'Dijkstra', weak: 2, partial: 1, answered: 3, weakQuestions: ['Why does Dijkstra fail with negative edges?', 'What does the priority queue hold?'] },
            ],
        });
    });

    it('focus lines: done / total, days, unfinished and done examples (newest first, no repeats)', () => {
        expect(e.focus).toEqual({ lines: 4, done: 2, daysWithLines: 3, notDone: ['read DDIA ch. 5'], doneExamples: ['Mock interview', 'Solve 2 graph problems'] });
    });

    it('docs created and edited in the week (a doc last edited today is not)', () => {
        expect(e.docs).toEqual({ created: 1, createdTitles: ['Two Sum'], edited: 1, editedTitles: ['Graphs'] });
    });

    it("goals: today's forecast, milestones done this week, the next milestone", () => {
        expect(e.goals).toHaveLength(1);
        expect(e.goals[0]).toMatchObject({
            title: 'Product-company SDE role',
            deadline: '2027-06-30',
            daysLeft: 228,
            forecast: 'ahead',
            pacePerWeek: 0.23,
            requiredPerWeek: 0.06,
            behindDays: 0,
            milestones: { done: 2, total: 4, doneThisWeek: 1 },
            nextMilestone: { title: 'Dynamic programming', due: '2026-12-01' },
        });
        expect(e.goals[0]!.projectedFinish).toMatch(/^2027-01-1\d$/);
    });

    it('rhythm: the 7 days with weekday names; active = a review or a focus line done that local day', () => {
        expect(e.rhythm).toEqual({
            activeDays: 4,
            days: [
                { day: '2026-11-07', weekday: 'Sat', active: false },
                { day: '2026-11-08', weekday: 'Sun', active: true },
                { day: '2026-11-09', weekday: 'Mon', active: true },
                { day: '2026-11-10', weekday: 'Tue', active: false },
                { day: '2026-11-11', weekday: 'Wed', active: false },
                { day: '2026-11-12', weekday: 'Thu', active: true },
                { day: '2026-11-13', weekday: 'Fri', active: true },
            ],
        });
    });

    it('is small: compact JSON of a few hundred tokens', () => {
        expect(JSON.stringify(e).length).toBeLessThan(2500);
    });
});

describe('how much there is to go on', () => {
    const goal = rows.goals[0]!;

    it('none: nothing done, nothing due, no backlog, no goal', () => {
        expect(buildCoachEvidence(empty, ctx).level).toBe('none');
        // A focus line from today (outside the week) changes nothing.
        expect(buildCoachEvidence({ ...empty, focus: [{ day: today, text: 'x', done: true }] }, ctx).level).toBe('none');
    });

    it(`little: a goal or a backlog alone, or at most ${LITTLE_EVIDENCE_POINTS} data points`, () => {
        expect(buildCoachEvidence({ ...empty, goals: [goal] }, ctx).level).toBe('little');
        expect(buildCoachEvidence({ ...empty, backlog: 5 }, ctx).level).toBe('little');
        const three: CoachRows = { ...empty, focus: [1, 2, 3].map((i) => ({ day: '2026-11-10', text: `line ${i}`, done: false })) };
        expect(buildCoachEvidence(three, ctx).level).toBe('little');
        const four: CoachRows = { ...empty, focus: [1, 2, 3, 4].map((i) => ({ day: '2026-11-10', text: `line ${i}`, done: false })) };
        expect(buildCoachEvidence(four, ctx).level).toBe('enough');
    });

    it('missing parts read as zeros and empty lists, never undefined', () => {
        const e = buildCoachEvidence({ ...empty, goals: [goal] }, ctx);
        expect(e.revisions).toEqual({ dueInWeek: 0, doneOnTime: 0, missed: 0, doneInWeek: 0, backlogFromBefore: 0, bySubject: [], missedTitles: [] });
        expect(e.recall).toEqual({ reviewsFinished: 0, results: { strong: 0, partial: 0, weak: 0 }, answers: { strong: 0, partial: 0, weak: 0 }, weakestTopics: [] });
        expect(e.rhythm.activeDays).toBe(0);
    });
});
