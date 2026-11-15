// The coach's numbers are checked (LOOP_COMPLETE_SPEC 1.7): every number in a note must be in the
// evidence; otherwise a plain note written by code.
import { describe, expect, it } from 'vitest';
import { numbersIn, plainCoachNote, unsupportedNumbers } from '../../../src/services/coach/check';
import type { CoachEvidence } from '../../../src/services/coach/evidence';

const evidence = {
    week: { from: '2026-11-07', to: '2026-11-13', today: '2026-11-14' },
    level: 'enough',
    revisions: { dueInWeek: 5, doneOnTime: 4, missed: 1, doneInWeek: 6, backlogFromBefore: 0, bySubject: [], missedTitles: ['Tries'] },
    recall: { reviewsFinished: 2, results: { strong: 1, partial: 0, weak: 1 }, answers: { strong: 3, partial: 1, weak: 2 }, weakestTopics: [{ title: 'Dijkstra', weak: 2, partial: 0, answered: 3, weakQuestions: [] }] },
    focus: { lines: 3, done: 2, daysWithLines: 2, notDone: ['Read DDIA chapter 5'], doneExamples: [] },
    docs: { created: 1, createdTitles: ['Bellman-Ford'], edited: 0, editedTitles: [] },
    goals: [{ title: 'Offer', deadline: '2027-05-16', daysLeft: 183, forecast: 'behind', pacePerWeek: 0.5, requiredPerWeek: 1.2, projectedFinish: '2027-08-01', behindDays: 77, milestones: { done: 1, total: 6, doneThisWeek: 0 }, nextMilestone: { title: 'Graphs', due: null } }],
    rhythm: { activeDays: 5, days: [] },
    record: { minutes: { study: 90, practice: 40, build: 120, review: 0 }, sessions: 4, practice: { alone: 1, hints: 1, after_answer: 0 }, weakSpots: { open: 2, clearedInWeek: 1 }, weekTargets: { done: 2, total: 3 } },
} as unknown as CoachEvidence;

const note = (strong: string) => ({ lines: { strong, slipping: 'Dijkstra came back weak twice.', fix: 'Reviews first.', deadline: 'At 0.5 a week against 1.2 needed, 77 days late.' }, focus: ['Re-test Dijkstra', 'Read DDIA chapter 5', 'Do the missed review of Tries'] });

describe('the number check', () => {
    it('reads every number written with digits', () => {
        expect(numbersIn('4 of 5 reviews, 0.5 a week, 1,200 minutes, 07 days')).toEqual(['4', '5', '0.5', '1200', '7']);
    });

    it('passes a note whose numbers are all in the evidence (titles count too); names the others', () => {
        expect(unsupportedNumbers(note('You did 4 of 5 reviews on time and logged 120 min of build.'), evidence)).toEqual([]);
        expect(unsupportedNumbers(note('You did 80% of your reviews, 12 in all.'), evidence)).toEqual(['80', '12']);
    });

    it('the plain note says the facts in words, from the evidence alone', () => {
        const plain = plainCoachNote(evidence);
        expect(plain.lines.strong).toBe('This week: 6 reviews done, 4 h 10 min logged, 2 Recall reviews finished, 2 focus lines done, 1 new note.');
        expect(plain.lines.slipping).toBe('1 review missed; Dijkstra came back weak in Recall; 2 weak spots open.');
        expect(plain.lines.deadline).toBe('Offer: at this pace it lands 77 days after 2027-05-16.');
        expect(plain.focus).toEqual(['Re-test Dijkstra', 'Do the missed review of Tries', 'Work on Graphs']);
        expect(unsupportedNumbers(plain, evidence).filter((n) => n !== '10')).toEqual([]);
    });
});
