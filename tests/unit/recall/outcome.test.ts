// A finished review's result and its effect (src/services/recall/outcome.ts). No database.
import { describe, expect, it } from 'vitest';
import { AGAIN_IN_DAYS, countGrades, intendedEffect, parseStoredOutcome, recallResult, type RecallCounts } from '../../../src/services/recall/outcome';

const c = (strong: number, partial: number, weak: number): RecallCounts => ({ strong, partial, weak });

describe('recallResult', () => {
    it.each([
        // n = 4: strong needs ≥ 3 strong and no weak; weak needs ≥ 2 weak
        [c(4, 0, 0), 'strong'],
        [c(3, 1, 0), 'strong'],
        [c(2, 2, 0), 'partial'],
        [c(3, 0, 1), 'partial'], // one weak blocks strong
        [c(2, 0, 2), 'weak'],
        [c(0, 4, 0), 'partial'],
        // n = 5: strong needs ≥ 4; weak needs ≥ 3
        [c(4, 1, 0), 'strong'],
        [c(3, 2, 0), 'partial'],
        [c(3, 0, 2), 'partial'],
        [c(2, 0, 3), 'weak'],
        // n = 3: strong needs all 3; weak needs ≥ 2
        [c(3, 0, 0), 'strong'],
        [c(2, 1, 0), 'partial'],
        [c(1, 0, 2), 'weak'],
        [c(1, 1, 1), 'partial'],
        // n = 1
        [c(1, 0, 0), 'strong'],
        [c(0, 1, 0), 'partial'],
        [c(0, 0, 1), 'weak'],
    ] as const)('%o → %s', (counts, expected) => {
        expect(recallResult(counts)).toBe(expected);
    });

    it('no questions at all is weak', () => {
        expect(recallResult(c(0, 0, 0))).toBe('weak');
    });
});

describe('countGrades', () => {
    it('one grade per question; unanswered questions count as weak; stray attempts are ignored', () => {
        const counts = countGrades(
            ['q1', 'q2', 'q3', 'q4'],
            [
                { questionId: 'q1', grade: 'strong' },
                { questionId: 'q2', grade: 'partial' },
                { questionId: 'q9', grade: 'strong' },
            ]
        );
        expect(counts).toEqual({ strong: 1, partial: 1, weak: 2 });
    });

    it('all answered strong', () => {
        expect(countGrades(['q1', 'q2'], [{ questionId: 'q1', grade: 'strong' }, { questionId: 'q2', grade: 'strong' }])).toEqual(c(2, 0, 0));
    });
});

describe('the effect of a result', () => {
    it('strong → the next cycle, partial → the same review again in 2 days, weak → tomorrow', () => {
        expect(intendedEffect('strong')).toBe('advanced');
        expect(intendedEffect('partial')).toBe('repeat');
        expect(intendedEffect('weak')).toBe('tomorrow');
        expect(AGAIN_IN_DAYS).toEqual({ partial: 2, weak: 1 });
    });
});

describe('parseStoredOutcome', () => {
    it('round-trips a stored outcome', () => {
        const outcome = { result: 'partial', effect: { kind: 'repeat', nextDay: '2026-11-16' }, counts: c(2, 1, 1) };
        expect(parseStoredOutcome(JSON.parse(JSON.stringify(outcome)))).toEqual(outcome);
        expect(parseStoredOutcome({ result: 'strong', effect: { kind: 'mastered', nextDay: null }, counts: c(4, 0, 0) })).toEqual({
            result: 'strong',
            effect: { kind: 'mastered', nextDay: null },
            counts: c(4, 0, 0),
        });
    });

    it('anything malformed is null (not finished)', () => {
        expect(parseStoredOutcome(null)).toBeNull();
        expect(parseStoredOutcome([])).toBeNull();
        expect(parseStoredOutcome({ result: 'great', effect: { kind: 'repeat', nextDay: null }, counts: c(1, 0, 0) })).toBeNull();
        expect(parseStoredOutcome({ result: 'weak', effect: { kind: 'later', nextDay: null }, counts: c(0, 0, 1) })).toBeNull();
        expect(parseStoredOutcome({ result: 'weak', effect: { kind: 'tomorrow', nextDay: 5 }, counts: c(0, 0, 1) })).toBeNull();
        expect(parseStoredOutcome({ result: 'weak', effect: { kind: 'tomorrow', nextDay: null }, counts: { strong: 1 } })).toBeNull();
    });
});
