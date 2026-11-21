// The buddy talks, it doesn't file things (the owner, 11-16: "From your notes: …" reads like a bot): a label
// in front of a line or a note comes off, the words after it stay; anything else is left alone.
import { describe, expect, it } from 'vitest';
import { strayNumbers, unlabel } from '../../../src/services/buddy/think';
import { characterPrompt } from '../../../src/services/buddy/character';

describe('the buddy’s voice', () => {
    it('takes a label off the front, keeps the words', () => {
        expect(unlabel('From your notes: an honest hour beats a heroic weekend.')).toBe('An honest hour beats a heroic weekend.');
        expect(unlabel('From your saved notes — sliding windows need two pointers.')).toBe('Sliding windows need two pointers.');
        expect(unlabel('Reminder - three reviews before lunch')).toBe('Three reviews before lunch');
        expect(unlabel('Tip: try the window before the heap')).toBe('Try the window before the heap');
        expect(unlabel('Heads-up: the milestone is on Sunday.')).toBe('The milestone is on Sunday.');
    });

    it('leaves a sentence alone', () => {
        for (const t of ['Notes on heaps can wait till tomorrow.', 'Today is yours: nothing is due.', 'Tonight, stop before midnight.', 'Two reviews and you are clear.']) expect(unlabel(t)).toBe(t);
    });

    it('the character asks for a friend’s voice, without labels', () => {
        const p = characterPrompt({ name: null, tone: 'candid' });
        expect(p).toContain('like a close friend texting them');
        expect(p).toContain('Never open with a label');
        expect(p).not.toContain('say where it came from');
    });

    it('the character is for the account’s own person: its first name, else "the user"; no one’s life story', () => {
        expect(characterPrompt({ name: null, tone: 'candid', person: '  Sam Lee ' })).toMatch(/^You are Sam's buddy inside Recollect/);
        expect(characterPrompt({ name: 'Pip', tone: 'gentle', person: 'Sam' })).toMatch(/^You are "Pip", Sam's buddy/);
        const none = characterPrompt({ name: null, tone: 'candid', person: '   ' });
        expect(none).toMatch(/^You are the user's buddy/);
        // Who the person is comes from the portrait and the memories, never from this text.
        expect(none).not.toMatch(/India|full-time job|job offer|software engineer/);
    });

    it('three voices (stage 5): candid, gentle and bro; anything unknown is candid', async () => {
        const { toneOf } = await import('../../../src/services/buddy/state.service');
        expect(characterPrompt({ name: null, tone: 'bro' })).toContain('Your tone is "bro"');
        expect(characterPrompt({ name: null, tone: 'gentle' })).toContain('warm and gentle');
        expect([toneOf('bro'), toneOf('gentle'), toneOf('candid'), toneOf('loud'), toneOf(null)]).toEqual(['bro', 'gentle', 'candid', 'candid', 'candid']);
    });
});

describe('stage 5: the character with the loop on, and the number guard’s words (ECOSYSTEM_V2_PLAN §4.3, §4.16 rule 9)', () => {
    it('with the loop on, relevance wins over "never twice in a week" and a plan with a time comes back at its time, as a question; off, today’s text', () => {
        const on = characterPrompt({ name: null, tone: 'candid', loop: true });
        expect(on).toContain('What matters now wins over variety');
        expect(on).toContain('how they answered');
        expect(on).toContain('A plan with a time is different: it comes back at its time, as a question, never as an assumption.');
        expect(on).not.toContain('Never the same point twice in a week');
        const off = characterPrompt({ name: null, tone: 'candid' });
        expect(off).toContain('Never the same point twice in a week');
        expect(off).not.toContain('A plan with a time');
        // Ideas still come back only when touched, on or off.
        for (const p of [on, off]) expect(p).toContain('Ideas and old decisions come back when today\'s notes touch them, not on a timer.');
    });

    it('a count written as a word must be one it was given, like digits (two to twenty; "one" is not read as a count)', () => {
        const sources = '{"reviewsLeft":3,"week":{"activeDays":4}} Runs three times a week. Read 12 pages.';
        expect(strayNumbers('Three quick reviews and you are clear.', sources)).toEqual([]);
        expect(strayNumbers('Four days this week, the habit is back.', sources)).toEqual([]);
        expect(strayNumbers('3 runs this week, as planned.', sources)).toEqual([]);
        expect(strayNumbers('Twelve pages, then sleep.', sources)).toEqual([]);
        expect(strayNumbers('Ten minutes of guitar is plenty tonight.', sources)).toEqual(['10']);
        expect(strayNumbers('Five reviews left, then one more push.', sources)).toEqual(['5']);
        expect(strayNumbers('Twenty-one days in a row now.', sources)).toEqual(['21']);
        expect(strayNumbers('The one you saved last week fits here.', sources)).toEqual([]);
        expect(strayNumbers('A two-minute review before bed.', sources)).toEqual(['2']);
    });
});
