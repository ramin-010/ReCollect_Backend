// A line a little over the limit keeps its whole first sentences that fit (the week's simulation, 11-18: the only
// line before his mock interview ran 92 characters and was dropped whole).
import { describe, expect, it } from 'vitest';
import { LINE_MAX, fitLine, guardTimedLines } from '../../../src/services/buddy/think';

describe('a line over the limit', () => {
    it('keeps the whole first sentences that fit; one long sentence stays as it is (and is dropped)', () => {
        const mock = "If Priya's mock is still on, no cramming. Brute force out loud first, that's the whole plan.";
        expect(mock.length).toBeGreaterThan(LINE_MAX);
        expect(fitLine(mock, LINE_MAX)).toBe("If Priya's mock is still on, no cramming.");
        expect(fitLine('Short and sweet.', LINE_MAX)).toBe('Short and sweet.');
        const long = 'x'.repeat(95);
        expect(fitLine(long, LINE_MAX)).toBe(long);
    });
    it('the timed lines keep the fitted line', () => {
        const out = guardTimedLines([{ from: '08:00', until: '11:00', text: "If Priya's mock is still on, no cramming. Brute force out loud first, that's the whole plan.", form: 'plain', lockOk: true, sourceId: '' } as never], { sources: '' });
        expect(out.lines.map((l) => l.text)).toEqual(["If Priya's mock is still on, no cramming."]);
        expect(out.dropped).toEqual([]);
    });
});
