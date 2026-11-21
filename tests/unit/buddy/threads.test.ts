// The thread rules code keeps (ECOSYSTEM_V2_PLAN §4.1, §4.11, §4.12): pure parts.
import { describe, expect, it } from 'vitest';
import { dayFor, dayState, isDuplicate, nextStage, overlap, SAME_THREAD } from '../../../src/services/buddy/threads';

const IST = 'Asia/Kolkata';
const at = (iso: string) => new Date(iso);

describe('his day', () => {
    it('ends at 04:00: a report at half past midnight belongs to the day before', () => {
        expect(dayFor(at('2026-11-17T18:00:00Z'), IST)).toBe('2026-11-17'); // 23:30 IST on the 17th
        expect(dayFor(at('2026-11-17T19:00:00Z'), IST)).toBe('2026-11-17'); // 00:30 IST on the 18th
        expect(dayFor(at('2026-11-17T22:29:00Z'), IST)).toBe('2026-11-17'); // 03:59 IST on the 18th
        expect(dayFor(at('2026-11-17T22:30:00Z'), IST)).toBe('2026-11-18'); // 04:00 IST on the 18th
    });
});

describe('the stage ladder', () => {
    const day = { firstDay: '2026-11-10' as const, forDay: '2026-11-10' as const };
    it('a passing mention stays noticed; coming back or acting makes it active', () => {
        expect(nextStage('noticed', 'said', day)).toBe('noticed');
        expect(nextStage('noticed', 'said', { ...day, forDay: '2026-11-12' })).toBe('active');
        expect(nextStage('noticed', 'progress', day)).toBe('active');
        expect(nextStage('noticed', 'done', day)).toBe('active');
    });
    it('never raises to committed (only his yes does)', () => {
        for (const k of ['said', 'progress', 'done', 'answered', 'changed'] as const) expect(nextStage('active', k, day)).toBe('active');
        expect(nextStage('committed', 'done', day)).toBe('committed');
    });
    it('closes on his word and opens again on a new one', () => {
        expect(nextStage('active', 'paused', day)).toBe('paused');
        expect(nextStage('active', 'dropped', day)).toBe('dropped');
        expect(nextStage('active', 'finished', day)).toBe('done');
        expect(nextStage('dropped', 'said', day)).toBe('active');
        expect(nextStage('paused', 'steer', day)).toBe('paused');
    });
});

describe("a day's state", () => {
    const t = (min: number) => new Date(Date.UTC(2026, 10, 17, 15, min));
    it('his later word wins, even seconds later', () => {
        expect(dayState([{ kind: 'done', saidAt: t(0), direct: true }, { kind: 'skipped', saidAt: new Date(t(0).getTime() + 40_000), direct: true }])).toBe('skipped');
    });
    it('the order he said things in, not the order they arrived', () => {
        expect(dayState([{ kind: 'skipped', saidAt: t(30), direct: true }, { kind: 'done', saidAt: t(10), direct: true }])).toBe('skipped');
    });
    it('a note an agent saved never overrules his own word', () => {
        expect(dayState([{ kind: 'done', saidAt: t(15), direct: true }, { kind: 'skipped', saidAt: t(30), direct: false }])).toBe('done');
    });
    it('two passed-on statements that disagree leave the day unclear', () => {
        expect(dayState([{ kind: 'done', saidAt: t(5), direct: false }, { kind: 'skipped', saidAt: t(9), direct: false }])).toBe('unclear');
        expect(dayState([{ kind: 'done', saidAt: t(5), direct: false }])).toBe('done');
    });
    it('a duplicate counts for nothing; no statement is no state', () => {
        expect(dayState([{ kind: 'skipped', saidAt: t(1), direct: true, duplicate: true }])).toBeNull();
        expect(dayState([{ kind: 'said', saidAt: t(1), direct: true }])).toBeNull();
    });
});

describe('the same thing said twice (§4.11 rule 4)', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 22, 14, m));
    const ev = (kind: string, m: number, direct = true, text = '') => ({ kind, text, saidAt: at(m), direct });
    it('his own day statement repeats only his latest one before it: back and forth is a correction each time', () => {
        expect(isDuplicate('done', 'Did it', at(5), true, [ev('done', 1)])).toBe(true);
        expect(isDuplicate('done', 'Did it', at(9), true, [ev('done', 1), ev('skipped', 5)])).toBe(false);
        expect(isDuplicate('skipped', 'Not today', at(9), true, [ev('done', 1), ev('skipped', 5)])).toBe(true);
        // A passed-on statement never decides it: her own latest word does.
        expect(isDuplicate('done', 'Did it', at(9), true, [ev('done', 1), ev('skipped', 5, false)])).toBe(true);
        // One that arrives late is compared with what came before it, not with what came after.
        expect(isDuplicate('skipped', 'x', at(3), true, [ev('done', 1), ev('skipped', 5)])).toBe(false);
    });
    it('a passed-on statement repeats any earlier one of its kind; other events repeat the same words', () => {
        expect(isDuplicate('skipped', 'x', at(9), false, [ev('skipped', 5)])).toBe(true);
        expect(isDuplicate('skipped', 'x', at(9), false, [ev('done', 5)])).toBe(false);
        expect(isDuplicate('progress', 'Played for fifteen minutes', at(9), true, [ev('progress', 5, true, 'played for FIFTEEN minutes!')])).toBe(true);
        expect(isDuplicate('progress', 'Played for an hour', at(9), true, [ev('progress', 5, true, 'Played for fifteen minutes')])).toBe(false);
    });
    it('an agent’s note of what her own words said of that day is the same thing in other words (J4 on the real models)', () => {
        expect(isDuplicate('progress', 'Played guitar for twenty minutes this evening', at(20), false, [ev('progress', 0, true, 'Played guitar for twenty minutes before dinner')])).toBe(true);
        // Did some of it and did it are the same news; did not is not.
        expect(isDuplicate('done', 'Played twenty minutes', at(20), false, [ev('progress', 0, true, 'Played guitar for twenty minutes')])).toBe(true);
        expect(isDuplicate('skipped', 'No guitar today', at(20), false, [ev('progress', 0, true, 'Played twenty minutes')])).toBe(false);
        // Only against her own words: two agents' notes in other words stay two; a plain statement is not a day's news.
        expect(isDuplicate('progress', 'Practised chords', at(20), false, [ev('progress', 0, false, 'Played twenty minutes')])).toBe(false);
        expect(isDuplicate('said', 'Wants to play more', at(20), false, [ev('said', 0, true, 'Wants to get back to guitar')])).toBe(false);
    });
});

describe('the same thread in other words', () => {
    it('overlapping words are the same thread; others are not', () => {
        expect(overlap({ title: 'Get back to guitar most evenings', keywords: ['guitar', 'practice', 'music'] }, { title: 'Guitar practice', keywords: ['guitar'] })).toBeGreaterThanOrEqual(SAME_THREAD);
        expect(overlap({ title: 'Get back to guitar most evenings' }, { title: 'Start a cut and walk 10,000 steps' })).toBeLessThan(SAME_THREAD);
        expect(overlap({ title: '' }, { title: 'anything' })).toBe(0);
    });
});
