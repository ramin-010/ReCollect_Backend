// Stage 16 (ECOSYSTEM_V2_PLAN): what is ahead, the pure rules every surface reads. The lock picture's rows (today's
// next scheduled things), Coming up (the next seven days) and Pick up (a problem or topic left unfinished this week).
import { describe, expect, it } from 'vitest';
import { aheadWords, comingUp, dayOnly, leftOff, todayRows, type EventIn, type ReminderIn, type SessionIn, type TaskIn } from '../../../src/services/ahead/aheadRules';

const TZ = 'Asia/Kolkata';
/** Friday 20 Nov 2026 at hh:mm in Kolkata (UTC+5:30). */
const at = (hh: number, mm = 0, day = 20) => new Date(Date.UTC(2026, 10, day, hh - 5, mm - 30));
const NOW = at(14, 0);

const rem = (id: string, when: Date, text: string, over: Partial<ReminderIn> = {}): ReminderIn => ({ id, by: 'you', when, text, taskId: null, ...over });
const task = (id: string, title: string, dueDate: Date | null, nextReminder: Date | null = null): TaskIn => ({ id, title, dueDate, nextReminder });
const event = (id: string, title: string, day: string, minute: number | null = null): EventIn => ({ id, title, day: day as EventIn['day'], minute });

describe('today’s rows (the lock picture: now)', () => {
    it('timed things still to come, soonest first; then today’s tasks without a time; then late ones, the newest first; three at most', () => {
        const rows = todayRows(
            {
                now: NOW,
                tz: TZ,
                reminders: [rem('r1', at(19, 0), 'Call the bank'), rem('b1', at(17, 30), 'Guitar after dinner', { by: 'buddy' })],
                tasks: [task('t1', 'Send the invoice', at(18, 0)), task('t2', 'Pay rent', at(18, 0, 18)), task('t3', 'Submit the form', at(16, 15)), task('t4', 'Renew passport', at(18, 0, 19))],
                events: [event('e1', 'Interview', '2026-11-20', 15 * 60), event('e2', 'Dinner with Asha', '2026-11-20')],
            },
            true,
            9
        );
        expect(rows.map((r) => [r.id, r.at, r.text])).toEqual([
            ['th_e1', '3 pm', 'Interview'],
            ['tk_t3', '4:15 pm', 'Submit the form'],
            ['br_b1', '5:30 pm', 'Guitar after dinner'],
            ['rm_r1', '7 pm', 'Call the bank'],
            ['tk_t1', '', 'Send the invoice'],
            ['tk_t4', 'late', 'Renew passport'],
            ['tk_t2', 'late', 'Pay rent'],
        ]);
        expect(todayRows({ now: NOW, tz: TZ, reminders: [rem('r1', at(19, 0), 'Call the bank')], tasks: [task('t1', 'Send the invoice', at(18, 0))], events: [] })).toHaveLength(2);
    });

    it('a task shown through its own reminder appears once; a passed timed task is late; an event already begun is gone', () => {
        const rows = todayRows({
            now: NOW,
            tz: TZ,
            reminders: [rem('r1', at(16, 0), 'Book the dentist', { taskId: 't1' })],
            tasks: [task('t1', 'Book the dentist', at(18, 0)), task('t2', 'Stand-up notes', at(11, 0))],
            events: [event('e1', 'Lunch with the team', '2026-11-20', 13 * 60)],
        });
        expect(rows.map((r) => [r.id, r.at])).toEqual([
            ['rm_r1', '4 pm'],
            ['tk_t2', 'late'],
        ]);
    });

    it('hidden titles say plain words; an item under a pending Later is left out', () => {
        const input = { now: NOW, tz: TZ, reminders: [rem('r1', at(19, 0), 'Call the bank')], tasks: [task('t1', 'Send the invoice', at(18, 0))], events: [event('e1', 'Interview', '2026-11-20', 15 * 60)] };
        expect(todayRows(input, false).map((r) => r.text)).toEqual(['An event', 'A reminder', 'A task']);
        expect(todayRows({ ...input, hidden: new Set(['th_e1']) }).map((r) => r.id)).toEqual(['rm_r1', 'tk_t1']);
    });

    it('a day-only due date is the app’s 18:00 or a goal’s last millisecond: no time shown', () => {
        expect(dayOnly(at(18, 0), TZ)).toBe(true);
        expect(dayOnly(new Date(at(0, 0, 21).getTime() - 1), TZ)).toBe(true);
        expect(dayOnly(at(18, 30), TZ)).toBe(false);
        expect(dayOnly(at(9, 0), TZ)).toBe(false);
    });
});

describe('Coming up (the home picture and the night: ahead)', () => {
    it('the next seven days after today: dated to-dos (or the day of their reminder) and events, soonest first, a day-only one before timed ones', () => {
        const rows = comingUp(
            {
                now: NOW,
                tz: TZ,
                tasks: [
                    task('t1', 'Get a gift for my sister', at(18, 0, 22)),
                    task('t2', 'Book the dentist', null, at(9, 0, 23)),
                    task('t3', 'Pay rent', at(18, 0, 20)),
                    task('t4', 'Renew passport', at(18, 0, 27)),
                    task('t5', 'File the taxes', at(10, 0, 22)),
                    task('t6', 'Eight days out', at(18, 0, 28)),
                ],
                events: [event('e1', 'Interview', '2026-11-26', 15 * 60), event('e2', 'Sister’s birthday', '2026-11-22')],
            },
            true,
            9
        );
        expect(rows.map((r) => [r.id, r.at, r.text])).toEqual([
            ['tk_t1', 'Sun', 'Get a gift for my sister'],
            ['th_e2', 'Sun', 'Sister’s birthday'],
            ['tk_t5', 'Sun 10 am', 'File the taxes'],
            ['tk_t2', 'Mon 9 am', 'Book the dentist'],
            ['th_e1', 'Thu 3 pm', 'Interview'],
            ['tk_t4', 'Fri', 'Renew passport'],
        ]);
        expect(comingUp({ now: NOW, tz: TZ, tasks: [], events: [event('e1', 'Interview', '2026-11-26', 15 * 60)], hidden: new Set(['th_e1']) })).toEqual([]);
        expect(aheadWords('2026-11-26', null, TZ)).toBe('Thu');
    });
});

describe('Pick up (left off this week)', () => {
    const s = (over: Partial<SessionIn>): SessionIn => ({
        id: 's1',
        kind: 'practice',
        problem: '3Sum',
        outcome: null,
        topicId: null,
        topicTitle: null,
        topicDone: false,
        nextStep: 'has the two-pointer idea; duplicates still break it',
        url: 'https://leetcode.com/problems/3sum/',
        docId: null,
        day: '2026-11-17' as SessionIn['day'],
        startedAt: at(20, 30, 17),
        updatedAt: at(21, 15, 17),
        ...over,
    });

    it('a practice problem with no outcome; a study topic not done with a next step; newest first', () => {
        const rows = leftOff(
            {
                now: NOW,
                tz: TZ,
                sessions: [s({}), s({ id: 's2', kind: 'study', problem: null, topicId: 'tp1', topicTitle: 'Consistent hashing', nextStep: 'virtual nodes next', day: '2026-11-18' as SessionIn['day'], startedAt: at(20, 0, 18), updatedAt: at(21, 0, 18), url: null, docId: 'd1' })],
            },
            true,
            3
        );
        expect(rows.map((r) => [r.id, r.text, r.detail])).toEqual([
            ['pu_s2', 'Consistent hashing', 'virtual nodes next'],
            ['pu_s1', '3Sum', 'has the two-pointer idea; duplicates still break it'],
        ]);
        expect(rows[0]).toMatchObject({ docId: 'd1', url: null });
        expect(rows[1]).toMatchObject({ url: 'https://leetcode.com/problems/3sum/' });
    });

    it('gone when solved, when a later session on it was solved, when the topic is done, after seven days, or for a build; still going is not left off', () => {
        const none = (sessions: SessionIn[]) => leftOff({ now: NOW, tz: TZ, sessions });
        expect(none([s({ outcome: 'alone' })])).toEqual([]);
        expect(none([s({}), s({ id: 's9', outcome: 'hints', startedAt: at(10, 0, 19), updatedAt: at(11, 0, 19), day: '2026-11-19' as SessionIn['day'] })])).toEqual([]);
        expect(none([s({ kind: 'study', problem: null, topicId: 'tp1', topicTitle: 'Heaps', topicDone: true })])).toEqual([]);
        expect(none([s({ day: '2026-11-13' as SessionIn['day'] })])).toEqual([]);
        expect(none([s({ kind: 'build' })])).toEqual([]);
        expect(none([s({ updatedAt: new Date(NOW.getTime() - 10 * 60_000), day: '2026-11-20' as SessionIn['day'] })])).toEqual([]);
        // A later unsolved session on the same problem replaces the older one (its words are the newest).
        const later = leftOff({ now: NOW, tz: TZ, sessions: [s({}), s({ id: 's3', nextStep: 'only the duplicates left', startedAt: at(9, 0, 19), updatedAt: at(9, 40, 19), day: '2026-11-19' as SessionIn['day'] })] });
        expect(later.map((r) => [r.id, r.detail])).toEqual([['pu_s3', 'only the duplicates left']]);
        // Hidden titles: plain words, no detail.
        expect(leftOff({ now: NOW, tz: TZ, sessions: [s({})] }, false)[0]).toMatchObject({ text: 'Something you were working on', detail: '' });
    });
});
