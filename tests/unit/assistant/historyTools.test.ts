// The chat reads its own earlier turns with what it did in them (the week's simulation, 11-18: without its tool
// calls in the history it said "I hadn't actually set it" of an alarm it had set, and set a second one).
import { describe, expect, it } from 'vitest';
import { withToolsDone } from '../../../src/controllers/assistant.controller';

describe('the chat history with what each turn did', () => {
    it('adds the tools of its own turns, with their results; his turns and turns without tools stay as they were', () => {
        const tools = [
            { name: 'set_reminder', input: '{"at":"2026-11-25T06:30","title":"Run","ring":true}', result: 'Reminder set: "Run" at Wed 25 Nov, 06:30 (rings)\n(a new task)', ok: true },
            { name: 'list_due', input: '{}', result: 'Nothing due', ok: false },
        ];
        expect(withToolsDone({ role: 'assistant', text: 'Done. It rings at 6:30.', tools })).toBe(
            'Done. It rings at 6:30.\n\n[What you did in that turn: set_reminder {"at":"2026-11-25T06:30","title":"Run","ring":true} → Reminder set: "Run" at Wed 25 Nov, 06:30 (rings) · list_due (failed) {} → Nothing due]'
        );
        expect(withToolsDone({ role: 'assistant', text: 'Sure.', tools: [] })).toBe('Sure.');
        expect(withToolsDone({ role: 'user', text: 'set an alarm', tools })).toBe('set an alarm');
    });
});
