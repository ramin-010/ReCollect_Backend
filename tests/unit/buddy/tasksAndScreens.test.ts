// Stage 5b of ECOSYSTEM_V2_PLAN, the pure rules: when a to-do's early reminder goes, which sources' to-dos may
// become tasks, a question's hours under his screen rules, and the digest's schema under the API's grammar limit.
import { describe, expect, it } from 'vitest';
import type { BuddyScreenRule } from '@prisma/client';
import { earlyReminderAt, minuteOf, tasksFromWordsOk } from '../../../src/services/buddy/tasks';
import { WEEKDAYS, askWindow, rulesInWords } from '../../../src/services/buddy/screens';
import { DIGEST_LOOP_SCHEMA } from '../../../src/services/buddy/understand';
import type { DayString } from '../../../src/services/learning';

const TZ = 'Asia/Kolkata';
const day = (d: string) => d as DayString;
// Fri 20 Nov 2026, 11:00 in Kolkata.
const FRI = new Date('2026-11-20T05:30:00Z');

describe('the early reminder of a to-do (5b A3)', () => {
    it('on a day: 09:00 that day; a named time: then', () => {
        expect(earlyReminderAt({ dueDay: day('2026-11-23'), deadline: false, minute: null }, { tz: TZ, now: FRI })?.toISOString()).toBe('2026-11-23T03:30:00.000Z');
        expect(earlyReminderAt({ dueDay: day('2026-11-23'), deadline: false, minute: 15 * 60 }, { tz: TZ, now: FRI })?.toISOString()).toBe('2026-11-23T09:30:00.000Z');
    });
    it('by a day (a deadline): 09:00 the day before; that day when the day before has passed', () => {
        expect(earlyReminderAt({ dueDay: day('2026-11-27'), deadline: true, minute: null }, { tz: TZ, now: FRI })?.toISOString()).toBe('2026-11-26T03:30:00.000Z');
        // Said on Friday at 11:00 for "by Saturday": Friday 09:00 has passed, so Saturday 09:00.
        expect(earlyReminderAt({ dueDay: day('2026-11-21'), deadline: true, minute: null }, { tz: TZ, now: FRI })?.toISOString()).toBe('2026-11-21T03:30:00.000Z');
        // A deadline with a time still reminds the day before (the time is when it is due).
        expect(earlyReminderAt({ dueDay: day('2026-11-27'), deadline: true, minute: 17 * 60 }, { tz: TZ, now: FRI })?.toISOString()).toBe('2026-11-26T03:30:00.000Z');
    });
    it('none when its time has passed (a to-do for today said after 09:00), or over a year away', () => {
        expect(earlyReminderAt({ dueDay: day('2026-11-20'), deadline: false, minute: null }, { tz: TZ, now: FRI })).toBeNull();
        expect(earlyReminderAt({ dueDay: day('2026-11-20'), deadline: true, minute: null }, { tz: TZ, now: FRI })).toBeNull();
        expect(earlyReminderAt({ dueDay: day('2028-01-10'), deadline: false, minute: null }, { tz: TZ, now: FRI })).toBeNull();
    });
    it('reads a time', () => {
        expect(minuteOf('09:05')).toBe(545);
        expect(minuteOf('9:30')).toBe(570);
        expect(minuteOf('24:00')).toBeNull();
        expect(minuteOf('')).toBeNull();
    });
});

describe('whose to-dos become tasks (5b A1)', () => {
    it('their own words heard live; never an export, a catch-up, a connector or an agent’s note', () => {
        expect(tasksFromWordsOk({ source: 'app', via: 'ask_ai' })).toBe(true);
        expect(tasksFromWordsOk({ source: 'hook', via: null })).toBe(true);
        expect(tasksFromWordsOk({ source: 'app', via: 'tell' })).toBe(true);
        expect(tasksFromWordsOk({ source: 'app', via: 'pocket' })).toBe(true);
        expect(tasksFromWordsOk({ source: 'hook', via: 'import' })).toBe(false);
        expect(tasksFromWordsOk({ source: 'app', via: 'catchup' })).toBe(false);
        expect(tasksFromWordsOk({ source: 'agent', via: 'connector' })).toBe(false);
        expect(tasksFromWordsOk({ source: 'agent', via: 'agent' })).toBe(false);
    });
});

const rule = (o: Partial<BuddyScreenRule>): BuddyScreenRule => ({ id: 'r', userId: 'u', kind: 'asks_from', threadId: null, fromMin: null, days: [], text: '', source: 'said', createdAt: new Date(0), endedAt: null, ...o });

describe('a question’s hours under his rules (5b B)', () => {
    const from = new Date('2026-11-21T03:30:00Z'); // Sat 21 Nov, 09:00 in Kolkata
    const until = new Date('2026-11-21T07:30:00Z'); // 13:00
    it('"ask me later in the evening": its start moves to 19:00, and it keeps three hours', () => {
        const w = askWindow([rule({ kind: 'asks_from', fromMin: 19 * 60 })], 't1', from, until, TZ);
        expect(w).toEqual({ from: new Date('2026-11-21T13:30:00Z'), until: new Date('2026-11-21T16:30:00Z') });
    });
    it('not on weekends: a Saturday question is dropped; a thread’s own rule wins over the one about everything', () => {
        expect(askWindow([rule({ kind: 'asks_days', days: WEEKDAYS })], 't1', from, until, TZ)).toEqual({ why: 'not on the days they asked for' });
        expect(askWindow([rule({ kind: 'asks_days', days: WEEKDAYS, threadId: 't2' })], 't1', from, until, TZ)).toEqual({ from, until });
        expect(askWindow([rule({ kind: 'asks_from', fromMin: 19 * 60 }), rule({ kind: 'asks_from', fromMin: 7 * 60, threadId: 't1' })], 't1', from, until, TZ)).toEqual({ from, until });
    });
    it('in words for the night and the lock check', () => {
        expect(rulesInWords([rule({ kind: 'asks_from', fromMin: 19 * 60, text: 'ask me later in the evening' }), rule({ kind: 'topic', text: 'money matters' })])).toEqual(['questions not before 19:00 (ask me later in the evening)', 'keep off their lock screen: money matters']);
    });
});

/** Properties, arrays and objects, counted through the whole schema (as tests/unit/buddy/nightSchema.test.ts counts them). */
function weight(schema: unknown): number {
    let n = 0;
    const walk = (s: unknown) => {
        if (!s || typeof s !== 'object') return;
        if (Array.isArray(s)) return s.forEach(walk);
        const o = s as Record<string, unknown>;
        if (o['type'] === 'object' || o['properties']) n += 1 + Object.keys((o['properties'] as object) ?? {}).length;
        if (o['type'] === 'array') n += 1;
        for (const v of Object.values(o)) walk(v);
    };
    walk(schema);
    return n;
}

describe('the digest’s schema with stage 5b’s fields', () => {
    it('stays under the API’s grammar limit (70: the heaviest accepted, 11-18)', () => {
        expect(weight(DIGEST_LOOP_SCHEMA)).toBeLessThanOrEqual(70);
    });
});
