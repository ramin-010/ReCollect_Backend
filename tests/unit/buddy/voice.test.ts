// The buddy talks, it doesn't file things (the owner, 11-16: "From your notes: …" reads like a bot): a label
// in front of a line or a note comes off, the words after it stay; anything else is left alone.
import { describe, expect, it } from 'vitest';
import { unlabel } from '../../../src/services/buddy/think';
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
        expect(p).toContain('like a close friend texting him');
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
});
