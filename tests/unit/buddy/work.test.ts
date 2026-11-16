// The work log's pure parts (BUDDY_MEMORY_PLAN §11.2, B9): what the summariser reads and how its lines
// are cleaned before they are written.
import { describe, expect, it } from 'vitest';
import { WORK_LINES_MAX, WORK_LINE_MAX, cleanWorkLines, workChat } from '../../../src/services/buddy/work';

describe('the work summariser', () => {
    it('reads his words (600 characters at most) and the start of each reply', () => {
        const chat = workChat([
            { at: '2026-11-15T09:00:00Z', text: `fix the export ${'x'.repeat(900)}`, reply: 'Fixed the export.' },
            { at: '2026-11-15T09:05:00Z', text: 'yes   do\nit' },
        ]);
        const [first, reply, second] = chat.split('\n');
        expect(first!.length).toBeLessThanOrEqual('him: '.length + 600);
        expect(first!.endsWith('…')).toBe(true);
        expect(reply).toBe('agent: Fixed the export.');
        expect(second).toBe('him: yes do it');
    });

    it('cleans its lines: no label, no secret, short, no repeat, nothing he removed, six at most', () => {
        const key = `sk-ant-api03-${'Ab1'.repeat(12)}`;
        const lines = cleanWorkLines(
            {
                lines: [
                    { kind: 'did', text: 'Note: fixed the GST rounding' },
                    { kind: 'did', text: 'Fixed the GST rounding!' },
                    { kind: 'did', text: `Rotated the deploy key ${key}` },
                    { kind: 'decided', text: 'renamed   the client folders' },
                    { kind: 'next', text: 'y'.repeat(300) },
                    { kind: 'stuck', text: '   ' },
                    ...Array.from({ length: 8 }, (_, i) => ({ kind: 'did' as const, text: `Step ${i}` })),
                ],
            },
            ['Renamed the client folders.']
        );
        expect(lines.length).toBe(WORK_LINES_MAX);
        expect(lines[0]).toEqual({ kind: 'did', text: 'Fixed the GST rounding' });
        expect(lines[1]!.text).not.toContain('sk-ant-');
        expect(lines.some((l) => /client folders/i.test(l.text))).toBe(false);
        expect(lines[2]!.text.length).toBeLessThanOrEqual(WORK_LINE_MAX);
        expect(() => cleanWorkLines({ lines: [{ kind: 'shipped', text: 'x' }] }, [])).toThrow(/wrong shape/);
    });
});
