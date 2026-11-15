// The record (SYNC_SPINE_SPEC 1.2), the pure parts: chat session keys carry their start; weak-spot
// keys; Recall's question task lists the open weak spots and the output keeps the id.
import { describe, expect, it } from 'vitest';
import { estimateMinutes, inferKind, keyStartedAt, newSessionKey, weakSpotKey } from '../../../src/services/learningDb/sessions.service';
import { questionsTask } from '../../../src/services/recall/prompts';
import { parseQuestionsOutput, parseStoredQuestions } from '../../../src/services/recall/output';

describe('session keys', () => {
    it('"s_" + 12 characters that carry the start second', () => {
        const now = new Date('2026-11-14T12:00:00.000Z');
        const key = newSessionKey(now);
        expect(key).toMatch(/^s_[0-9a-z]{12}$/);
        const later = new Date(now.getTime() + 50 * 60_000);
        expect(keyStartedAt(key, later)?.toISOString()).toBe(now.toISOString());
        expect(newSessionKey(now)).not.toBe(key);
    });

    it('a start more than a day old, in the future, or another key form is not believed', () => {
        const now = new Date('2026-11-14T12:00:00.000Z');
        const old = newSessionKey(new Date(now.getTime() - 25 * 3600_000));
        expect(keyStartedAt(old, now)).toBeNull();
        expect(keyStartedAt(newSessionKey(new Date(now.getTime() + 3600_000)), now)).toBeNull();
        expect(keyStartedAt('cc_0b2f3c4d-5e6f', now)).toBeNull();
    });

    it('weak spots match by lower-case text with single spaces', () => {
        expect(weakSpotKey('  Write-behind   vs  WRITE-through ')).toBe('write-behind vs write-through');
    });
});

describe('Recall and weak spots', () => {
    it('the question task lists the open weak spots with their ids, or says there are none', () => {
        const task = questionsTask(2, [], [{ _id: 'ws1', text: 'TTL jitter' }, { _id: 'ws2', text: 'write-behind vs write-through' }]);
        expect(task).toContain('Ask about these first');
        expect(task).toContain('- [ws1] TTL jitter\n- [ws2] write-behind vs write-through');
        expect(questionsTask(2, [])).toContain('every weakSpotId is an empty string');
    });

    it('a question keeps its weakSpotId (an empty one is dropped), also when stored and read back', () => {
        const qs = parseQuestionsOutput(
            JSON.stringify({
                questions: [
                    { kind: 'recall', prompt: 'What is TTL jitter for?', answerKey: 'Spreads expiries.', sourceQuote: '', weakSpotId: 'ws1' },
                    { kind: 'apply', prompt: 'When does write-behind lose data?', answerKey: 'On a crash before flush.', sourceQuote: '', weakSpotId: '' },
                ],
            })
        );
        expect(qs[0]!.weakSpotId).toBe('ws1');
        expect('weakSpotId' in qs[1]!).toBe(false);
        expect(parseStoredQuestions(JSON.parse(JSON.stringify(qs)))[0]!.weakSpotId).toBe('ws1');
    });
});

describe('what a write leaves out (LOOP_COMPLETE_SPEC S1.1)', () => {
    it('the kind of a new row', () => {
        expect(inferKind('s_x', { problem: 'Two sum' })).toBe('practice');
        expect(inferKind('cc_x', { outcome: 'hints' })).toBe('practice');
        expect(inferKind('cc_x', { topicId: 't1' })).toBe('study');
        expect(inferKind('s_x', { weakSpots: ['x'] })).toBe('study');
        expect(inferKind('s_x', { project: 'recollect' })).toBe('build');
        expect(inferKind('cc_x', {})).toBe('build');
        expect(inferKind('s_x', {})).toBe('study');
    });

    it('minutes: the first write since the start (1 to 45), later writes add the gap (at most 30)', () => {
        const now = new Date('2026-11-14T12:00:00.000Z');
        const ago = (m: number) => new Date(now.getTime() - m * 60_000);
        expect(estimateMinutes(null, ago(0.2), now)).toBe(1);
        expect(estimateMinutes(null, ago(20), now)).toBe(20);
        expect(estimateMinutes(null, ago(240), now)).toBe(45);
        expect(estimateMinutes({ minutes: 20, updatedAt: ago(12) }, ago(240), now)).toBe(32);
        expect(estimateMinutes({ minutes: 20, updatedAt: ago(130) }, ago(240), now)).toBe(50);
        expect(estimateMinutes({ minutes: null, updatedAt: ago(5) }, ago(240), now)).toBe(5);
    });
});
