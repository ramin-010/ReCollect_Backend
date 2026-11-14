// Text sizes without a DOM (src/services/docs/diagram/measure.ts): boxes as wide as their text
// needs (the shape's default at least, 240 at most), then taller as the text wraps.
import { describe, expect, it } from 'vitest';
import { boxSize, labelSize, textWidth, wrapText, zoneMinWidth, zoneTitleBand } from '../../../../src/services/docs/diagram/measure';

describe('textWidth', () => {
    it('narrow letters are narrower than wide ones; bold and bigger text are wider; nothing is free', () => {
        expect(textWidth('iiii', 14)).toBeLessThan(textWidth('mmmm', 14));
        expect(textWidth('Hello', 14, true)).toBeGreaterThan(textWidth('Hello', 14));
        expect(textWidth('Hello', 28)).toBeCloseTo(2 * textWidth('Hello', 14));
        expect(textWidth('', 14)).toBe(0);
        for (const ch of ['a', 'é', '中', '🚀', '\t']) expect(textWidth(ch, 14)).toBeGreaterThan(0);
        expect(textWidth('中', 14)).toBeGreaterThan(textWidth('a', 14));
    });

    it('never measures less than Arial would (the browser must not wrap a line we did not)', () => {
        // "API server 1" in Arial 14px is about 77 px.
        expect(textWidth('API server 1', 14)).toBeGreaterThanOrEqual(77);
        expect(textWidth('API server 1', 14)).toBeLessThan(90);
    });
});

describe('wrapText', () => {
    it('keeps line breaks, breaks at spaces, and breaks a word longer than a line anywhere', () => {
        expect(wrapText('one\ntwo', 14, 500)).toEqual(['one', 'two']);
        expect(wrapText('alpha beta gamma delta', 14, 90)).toEqual(['alpha beta', 'gamma delta']);
        const long = wrapText('x'.repeat(60), 14, 100);
        expect(long.length).toBeGreaterThan(3);
        expect(long.join('')).toBe('x'.repeat(60));
        for (const line of long) expect(textWidth(line, 14)).toBeLessThanOrEqual(100);
        expect(wrapText('', 14, 100)).toEqual(['']);
        expect(wrapText('abc', 14, -5)).toEqual(['a', 'b', 'c']);
    });
});

describe('boxSize', () => {
    it('short text keeps the shape’s default size', () => {
        expect(boxSize({ shape: 'rect', text: 'CDN' })).toEqual({ w: 160, h: 64 });
        expect(boxSize({ shape: 'cylinder', text: 'Redis' })).toEqual({ w: 120, h: 96 });
        expect(boxSize({ shape: 'diamond', text: 'Yes?' })).toEqual({ w: 140, h: 100 });
        expect(boxSize({ shape: 'queue', text: 'Jobs' })).toEqual({ w: 160, h: 64 });
        expect(boxSize({ shape: 'rounded', text: '' })).toEqual({ w: 160, h: 64 });
    });

    it('longer text widens the box up to 240, then wraps and grows it taller (4 px grid)', () => {
        const medium = boxSize({ shape: 'rect', text: 'Notification dispatcher service' });
        expect(medium.w).toBeGreaterThan(160);
        expect(medium.w).toBeLessThan(240);
        expect(medium.h).toBe(64);
        const long = boxSize({ shape: 'rect', text: 'A box with far more words than fit on two lines of a canvas box, so it has to grow taller' });
        expect(long.w).toBe(240);
        expect(long.h).toBeGreaterThan(64);
        for (const n of [medium.w, medium.h, long.w, long.h]) expect(n % 4).toBe(0);
    });

    it('a kind icon takes room; ellipses and diamonds need more room than a rect for the same text', () => {
        const wide = 'Payment gateway service';
        expect(boxSize({ shape: 'rect', text: wide, kind: 'service' }).w).toBeGreaterThan(boxSize({ shape: 'rect', text: wide }).w);
        const text = 'Payment service'; // fits a 160 px rect
        expect(boxSize({ shape: 'rect', text }).w).toBe(160);
        expect(boxSize({ shape: 'ellipse', text }).w).toBeGreaterThan(160);
        expect(boxSize({ shape: 'diamond', text }).w).toBeGreaterThan(boxSize({ shape: 'ellipse', text }).w);
    });

    it('stickies hug their text; large text is bigger', () => {
        expect(boxSize({ shape: 'sticky', text: 'One line' })).toEqual({ w: 200, h: 72 });
        expect(boxSize({ shape: 'sticky', text: 'Line\nline\nline\nline' }).h).toBeGreaterThan(72);
        const title = 'Request path for every read';
        expect(boxSize({ shape: 'text', text: title, size: 'l' }).w).toBeGreaterThan(boxSize({ shape: 'text', text: title }).w);
    });
});

describe('labels and zone titles', () => {
    it('an arrow label is its text plus 6 px each side, one line 21 px tall, wrapped at 220 px', () => {
        const short = labelSize('HTTPS');
        expect(short.h).toBe(21);
        expect(short.w).toBeGreaterThan(textWidth('HTTPS', 12.5));
        expect(short.w).toBeLessThan(60);
        const long = labelSize('a very long arrow label that will certainly need more than one line here');
        expect(long.w).toBeLessThanOrEqual(220);
        expect(long.h).toBeGreaterThan(21);
    });

    it('a zone is at least as wide as its title; the title band is about 28 px', () => {
        expect(zoneTitleBand('API tier').h).toBe(28);
        expect(zoneMinWidth('A rather long zone title')).toBeGreaterThan(textWidth('A rather long zone title', 13, true) + 20);
        expect(zoneTitleBand('').h).toBeLessThan(28);
    });
});
