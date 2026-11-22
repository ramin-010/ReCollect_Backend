// Stage 7 of ECOSYSTEM_V2_PLAN (V1; his point 4: "up to the buddy whether it shows 2, 3 or 4 at most"): with the
// loop on the night writes 0 to 6 lines (4 before 11-22), each with its own hours inside his buddy day (04:00 to 04:00). Code holds
// the hours, the overlaps and the six (four before 11-22); a line without hours holds its part of the day, read the same way.
import { describe, expect, it } from 'vitest';
import { clockOf, dayMinute, instantOf, lineAt, lineKey, lineLabel, lineWindow, minuteOf, normTime, slotOfMinute } from '../../../src/services/buddy/lineTimes';
import { LOCK_SCHEMA, LOCK_SCHEMA_TIMED, NIGHT_SCHEMA, guardTimedLines, lockRequest, nightRequest, withLoop, type Line, type NightInput } from '../../../src/services/buddy/think';

const input = (loop: boolean): NightInput => ({
    name: null,
    tone: 'candid',
    loop,
    signals: { today: { day: '2026-11-16', weekday: 'Monday', time: '04:10', isSunday: false } } as unknown as NightInput['signals'],
    portrait: { who: null, heading: null, now: null },
    memories: [],
    notes: [],
    candidates: [],
    hisNotes: [],
    notebook: null,
    said: [],
    timezone: 'Asia/Kolkata',
});
const line = (from: string, until: string, text = 'A line worth reading') => ({ from, until, text, form: 'push' as const, lockOk: true, sourceId: '' });

describe('timed lines: his day from 04:00 to 04:00', () => {
    it('reads times of day, minutes into his day and back', () => {
        expect(normTime('7:05')).toBe('07:05');
        expect(normTime(' 23:59 ')).toBe('23:59');
        for (const bad of ['24:00', '7.05', '', 'soon', '12:60', undefined]) expect(normTime(bad)).toBeNull();
        expect([dayMinute('04:00'), dayMinute('12:00'), dayMinute('23:00'), dayMinute('00:30'), dayMinute('03:59')]).toEqual([0, 480, 1140, 1230, 1439]);
        expect([clockOf(0), clockOf(480), clockOf(1230), clockOf(1440)]).toEqual(['04:00', '12:00', '00:30', '04:00']);
        expect([slotOfMinute(0), slotOfMinute(479), slotOfMinute(480), slotOfMinute(840), slotOfMinute(1439)]).toEqual(['morning', 'morning', 'afternoon', 'evening', 'evening']);
    });

    it('a line’s hours: its own (to 04:00 is the day’s end, across midnight is fine), else its part of the day; its key and label', () => {
        expect(lineWindow({ slot: 'morning', from: '07:30', until: '09:00' })).toEqual([210, 300]);
        expect(lineWindow({ slot: 'evening', from: '22:30', until: '00:30' })).toEqual([1110, 1230]);
        expect(lineWindow({ slot: 'evening', from: '23:00', until: '04:00' })).toEqual([1140, 1440]);
        expect([lineWindow({ slot: 'morning' }), lineWindow({ slot: 'afternoon' }), lineWindow({ slot: 'evening' })]).toEqual([
            [0, 480],
            [480, 840],
            [840, 1440],
        ]);
        expect(lineKey({ slot: 'morning', from: '7:30' })).toBe('07:30');
        expect(lineKey({ slot: 'evening' })).toBe('evening');
        expect(lineLabel({ slot: 'evening', from: '22:30', until: '00:30' })).toBe('22:30-00:30');
        expect(lineLabel({ slot: 'afternoon' })).toBe('afternoon');
    });

    it('the line now: the one whose hours hold the minute; between lines none (the dial shows); a day of slots reads as before', () => {
        const timed = [
            { slot: 'morning' as const, from: '07:00', until: '09:00', text: 'a' },
            { slot: 'evening' as const, from: '22:00', until: '01:00', text: 'b' },
        ];
        expect(lineAt(timed, dayMinute('08:59'))?.text).toBe('a');
        expect(lineAt(timed, dayMinute('09:00'))).toBeUndefined();
        expect(lineAt(timed, dayMinute('00:30'))?.text).toBe('b');
        const slots = [{ slot: 'morning' as const, text: 'm' }, { slot: 'evening' as const, text: 'e' }];
        expect(lineAt(slots, dayMinute('11:59'))?.text).toBe('m');
        expect(lineAt(slots, dayMinute('12:00'))).toBeUndefined();
        expect(lineAt(slots, dayMinute('03:00'))?.text).toBe('e');
    });

    it('minutes of his buddy day from an instant and back (his zone)', () => {
        const day = '2026-11-16';
        expect(minuteOf(day, 'Asia/Kolkata', new Date('2026-11-16T07:30:00+05:30'))).toBe(210);
        expect(minuteOf(day, 'Asia/Kolkata', new Date('2026-11-17T00:30:00+05:30'))).toBe(1230);
        expect(instantOf(day, 'Asia/Kolkata', 1440).toISOString()).toBe(new Date('2026-11-17T04:00:00+05:30').toISOString());
    });
});

describe('the guard of timed lines', () => {
    it('0 to 6, each in its own hours: no time, backwards, under half an hour, overlapping, a seventh: dropped with the reason', () => {
        const g = guardTimedLines(
            [
                line('6:30', '08:00', 'One honest hour before work'),
                line('07:30', '09:00', 'Overlaps the first'),
                line('12:00', '12:10', 'Too short to see'),
                line('soon', '13:00', 'No time of day'),
                line('15:00', '14:00', 'Ends before it starts'),
                line('13:00', '14:00', 'A walk after lunch, no screens'),
                line('18:30', '20:00', 'Guitar after dinner'),
                line('22:30', '00:30', 'Lights out soon, it was a long day'),
                line('01:00', '02:00', 'A fifth line'),
                line('02:00', '03:00', 'A sixth line'),
                line('03:00', '03:45', 'A seventh line'),
                line('10:00', '11:00', ''),
            ],
            { sources: '' }
        );
        expect(g.lines.map((l) => [l.from, l.until, l.slot])).toEqual([
            ['06:30', '08:00', 'morning'],
            ['13:00', '14:00', 'afternoon'],
            ['18:30', '20:00', 'evening'],
            ['22:30', '00:30', 'evening'],
            ['01:00', '02:00', 'evening'],
            ['02:00', '03:00', 'evening'],
        ]);
        expect(g.dropped.map((d) => d.why).sort()).toEqual(['ends before it starts', 'more than 6 lines today', 'not a time of day', 'overlaps another line', 'shorter than half an hour'].sort());
    });

    it('a pulse: the lines whose hours are over stay and count in the six (four before 11-22); a new line must not have ended or overlap them', () => {
        const kept: Line[] = [
            { slot: 'morning', from: '06:30', until: '08:00', text: 'Over', form: 'push', lockOk: true, sourceId: null },
            { slot: 'afternoon', from: '13:00', until: '14:00', text: 'Over too', form: 'push', lockOk: true, sourceId: null },
        ];
        const g = guardTimedLines([line('13:00', '13:30', 'Already over'), line('13:45', '15:00', 'Overlaps one over'), line('15:00', '16:00', 'Stretch before the call'), line('18:30', '20:00', 'Guitar after dinner'), line('20:30', '21:30', 'Wind down'), line('22:00', '22:45', 'Lights out'), line('23:00', '23:45', 'One too many')], {
            sources: '',
            kept,
            after: dayMinute('14:30'),
        });
        expect(g.lines.map((l) => l.from)).toEqual(['15:00', '18:30', '20:30', '22:00']);
        expect(g.dropped.map((d) => `${d.what}: ${d.why}`)).toEqual(['line 13:00: its hours are over', 'line 13:45: overlaps another line', 'line 23:00: more than 6 lines today']);
    });

    it('the same checks of words: too long, a number it was not given; nothing refused for having been said another day', () => {
        const g = guardTimedLines([line('08:00', '09:00', 'x'.repeat(91)), line('10:00', '11:00', 'Seven reviews today'), line('12:00', '13:00', 'Three reviews today')], { sources: 'three reviews due' });
        expect(g.lines.map((l) => l.text)).toEqual(['Three reviews today']);
        expect(g.dropped.map((d) => d.why)).toEqual(['too long', 'a number it was not given']);
    });
});

describe('the requests with timed lines', () => {
    it('the night with the loop on asks for 0 to 6 lines with their hours (schema: from and until, no slot); the loop off keeps the slots, word for word', () => {
        const off = nightRequest(input(false)) as unknown as { system: Array<{ text: string }>; output_config: { format: { schema: unknown } } };
        expect(off.system[0]!.text).toContain('- lines: one per slot (morning, afternoon, evening)');
        expect(off.system[0]!.text).not.toContain('0 to 6 lines');
        expect(off.output_config.format.schema).toBe(NIGHT_SCHEMA);
        const on = withLoop(nightRequest(input(true)), 't1 · active · Guitar most evenings', { sunday: false }) as unknown as { system: Array<{ text: string }>; messages: Array<{ content: Array<{ text: string }> }>; output_config: { format: { schema: { properties: { lines: { items: { required: string[]; properties: Record<string, unknown> } } } } } } };
        expect(on.system[0]!.text).toContain('- lines: 0 to 6 lines for their lock screen today, each shown in its own hours');
        expect(on.system[0]!.text).not.toContain('one per slot');
        expect(on.messages[0]!.content[0]!.text).toContain('<threads>\nt1 · active · Guitar most evenings\n</threads>');
        const items = on.output_config.format.schema.properties.lines.items;
        expect(items.required).toEqual(['from', 'until', 'text', 'form', 'lockOk', 'sourceId', 'about']);
        expect(Object.keys(items.properties)).not.toContain('slot');
    });

    it('the lock check: timed lines by number, a day of slots by its slots (the same request as before)', () => {
        const timed: Line[] = [
            { slot: 'morning', from: '07:00', until: '08:00', text: 'First', form: 'push', lockOk: true, sourceId: null },
            { slot: 'morning', from: '10:00', until: '11:00', text: 'Second', form: 'push', lockOk: true, sourceId: null },
        ];
        const t = lockRequest(timed, []) as unknown as { system: Array<{ text: string }>; messages: Array<{ content: Array<{ text: string }> }>; output_config: { format: { schema: unknown } } };
        expect(t.output_config.format.schema).toBe(LOCK_SCHEMA_TIMED);
        expect(t.messages[0]!.content[0]!.text).toContain('<lines>\n0: First\n1: Second\n</lines>');
        expect(t.system[0]!.text).toContain('answer each line by its number');
        const s = lockRequest([{ slot: 'evening', text: 'Slot line', form: 'push', lockOk: true, sourceId: null }], []) as unknown as { system: Array<{ text: string }>; messages: Array<{ content: Array<{ text: string }> }>; output_config: { format: { schema: unknown } } };
        expect(s.output_config.format.schema).toBe(LOCK_SCHEMA);
        expect(s.messages[0]!.content[0]!.text).toContain('<lines>\nevening: Slot line\n</lines>');
        expect(s.system[0]!.text).not.toContain('by its number (i)');
    });
});
