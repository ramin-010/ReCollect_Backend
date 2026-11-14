// A finished review's result and what it does to the schedule (pure).
//
//   strong  every answer strong or almost: ≥ ceil(¾·n) strong and no weak → the next cycle
//   weak    at least half weak: ≥ ceil(n/2) weak                          → back tomorrow
//   partial anything else                                                → the same review in 2 days
// Unanswered questions count as weak. The service applies the effect with the existing revision
// services (complete / reschedule), so streaks and history stay right.
import type { DayString } from '../learning';
import type { RecallGradeValue } from './output';

export type RecallCounts = Record<RecallGradeValue, number>;

export type RecallEffectKind = 'advanced' | 'repeat' | 'tomorrow' | 'mastered';

export interface RecallEffect {
    kind: RecallEffectKind;
    /** When the item comes back (null once mastered). */
    nextDay: DayString | null;
}

/** POST /api/recall/sets/:id/finish */
export interface RecallOutcome {
    result: RecallGradeValue;
    effect: RecallEffect;
    counts: RecallCounts;
}

/** Days until a partial / weak review comes back. */
export const AGAIN_IN_DAYS = { partial: 2, weak: 1 } as const;

/** One grade per question; a question without an attempt is weak. */
export function countGrades(questionIds: readonly string[], attempts: ReadonlyArray<{ questionId: string; grade: RecallGradeValue }>): RecallCounts {
    const byQuestion = new Map(attempts.map((a) => [a.questionId, a.grade]));
    const counts: RecallCounts = { strong: 0, partial: 0, weak: 0 };
    for (const id of questionIds) counts[byQuestion.get(id) ?? 'weak'] += 1;
    return counts;
}

export function recallResult(counts: RecallCounts): RecallGradeValue {
    const n = counts.strong + counts.partial + counts.weak;
    if (n === 0) return 'weak';
    if (counts.strong >= Math.ceil(0.75 * n) && counts.weak === 0) return 'strong';
    if (counts.weak >= Math.ceil(n / 2)) return 'weak';
    return 'partial';
}

/** The effect a result asks for before it is applied (strong may turn out to be `mastered`). */
export function intendedEffect(result: RecallGradeValue): Exclude<RecallEffectKind, 'mastered'> {
    return result === 'strong' ? 'advanced' : result === 'partial' ? 'repeat' : 'tomorrow';
}

const GRADES: readonly RecallGradeValue[] = ['strong', 'partial', 'weak'];
const EFFECTS: readonly RecallEffectKind[] = ['advanced', 'repeat', 'tomorrow', 'mastered'];

/** RecallSet.outcome as stored by finish, or null when missing or malformed. */
export function parseStoredOutcome(value: unknown): RecallOutcome | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    const effect = v.effect as Record<string, unknown> | undefined;
    const counts = v.counts as Record<string, unknown> | undefined;
    if (!GRADES.includes(v.result as RecallGradeValue) || !effect || !counts) return null;
    if (!EFFECTS.includes(effect.kind as RecallEffectKind)) return null;
    if (effect.nextDay !== null && typeof effect.nextDay !== 'string') return null;
    if (!GRADES.every((g) => Number.isInteger(counts[g]))) return null;
    return {
        result: v.result as RecallGradeValue,
        effect: { kind: effect.kind as RecallEffectKind, nextDay: (effect.nextDay as DayString | null) ?? null },
        counts: { strong: counts.strong as number, partial: counts.partial as number, weak: counts.weak as number },
    };
}
