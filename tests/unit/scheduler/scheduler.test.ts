// The quiet scheduler's engine (hosting P1-11) with stand-in jobs and a clock moved by hand. The
// real passes on the test database: tests/integration/scheduler.test.ts.
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { BACKOFF_MS, MAX_IMMEDIATE, MAX_WAIT_MS, MIN_GAP_MS, POKE_DELAY_MS, Scheduler, type Job, type JobOutcome } from '../../../src/services/scheduler/scheduler';
import { ManualClock } from '../../helpers/manualClock';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 10, 16, 3, 30); // 09:00 in India

interface Stand {
    job: Job;
    runs: number[];
    nexts: number[];
    due: { at: number | null };
    fail: { left: number };
}

/** A job whose next moment is `due.at`, which records when it ran and when it was asked. */
function stand(name: Job['name'], clock: ManualClock, opts: Partial<Job> & { outcome?: () => JobOutcome | void } = {}): Stand {
    const st: Stand = { runs: [], nexts: [], due: { at: null }, fail: { left: 0 }, job: undefined as unknown as Job };
    st.job = {
        name,
        run: async () => {
            st.runs.push(clock.now());
            if (st.fail.left > 0) {
                st.fail.left -= 1;
                throw new Error('the mail server is down');
            }
            if (st.due.at !== null && st.due.at <= clock.now()) st.due.at = null; // the work is done
            return opts.outcome?.();
        },
        next: async () => {
            st.nexts.push(clock.now());
            return st.due.at === null ? null : new Date(st.due.at);
        },
        ...opts,
    };
    return st;
}

function setup(jobs: (clock: ManualClock) => Stand[], sweepMinutes = 180) {
    const clock = new ManualClock(T0);
    const stands = jobs(clock);
    const housekeeping: number[] = [];
    const log: string[] = [];
    const s = new Scheduler(
        stands.map((x) => x.job),
        { sweepMinutes, housekeeping: async () => void housekeeping.push(clock.now()), log: (l) => log.push(l), clock },
    );
    const advance = (ms: number) => clock.advance(ms, () => s.idle());
    return { clock, s, stands, housekeeping, log, advance };
}

describe('the quiet scheduler', () => {
    it('starts with the catch-up: the housekeeping and every pass once, then one timer per job and the next sweep', async () => {
        const { s, stands, housekeeping } = setup((c) => [stand('reminders', c), stand('nudge', c), stand('recallNightly', c, { timedOnly: true })]);
        const [reminders, nudge, nightly] = stands as [Stand, Stand, Stand];
        reminders.due.at = T0 + 30 * MIN;
        nightly.due.at = T0 + 17 * HOUR;
        await s.start();
        await s.idle();
        expect(housekeeping).toEqual([T0]);
        expect(reminders.runs).toEqual([T0]);
        expect(nudge.runs).toEqual([T0]);
        expect(nightly.runs).toEqual([]); // a job at a fixed hour is not part of the catch-up
        expect(s.nextAt('reminders')?.getTime()).toBe(T0 + 30 * MIN);
        expect(s.nextAt('nudge')).toBeNull();
        expect(s.nextAt('recallNightly')?.getTime()).toBe(T0 + 17 * HOUR);
        expect(s.nextSweepAt()?.getTime()).toBe(T0 + 180 * MIN);
    });

    it('runs a job at its moment, and a wait past an hour re-arms each hour with no question to the database', async () => {
        const { s, stands, advance } = setup((c) => [stand('reminders', c)]);
        const [r] = stands as [Stand];
        r.due.at = T0 + 150 * MIN;
        await s.start();
        const asked = r.nexts.length;
        await advance(149 * MIN);
        expect(r.runs).toEqual([T0]);
        expect(r.nexts.length).toBe(asked); // the hourly re-arms asked nothing
        await advance(MIN);
        expect(r.runs).toEqual([T0, T0 + 150 * MIN]);
    });

    it('a poke re-reads the next moment after a short wait; a burst of pokes is one read', async () => {
        const { s, stands, advance } = setup((c) => [stand('reminders', c)]);
        const [r] = stands as [Stand];
        await s.start();
        expect(s.nextAt('reminders')).toBeNull();
        r.due.at = T0 + 10 * MIN;
        const asked = r.nexts.length;
        s.poke('reminders');
        s.poke('reminders');
        s.poke('reminders');
        await advance(POKE_DELAY_MS);
        expect(r.nexts.length).toBe(asked + 1);
        expect(s.nextAt('reminders')?.getTime()).toBe(T0 + 10 * MIN);
        expect(r.runs).toEqual([T0]); // only the start's
    });

    it('a job with work on arrival runs on a poke, a few seconds later', async () => {
        const { s, stands, advance } = setup((c) => [stand('capture', c, { runOnPoke: true, pokeDelayMs: 5_000 })]);
        const [c] = stands as [Stand];
        await s.start();
        s.poke('capture');
        await advance(4_999);
        expect(c.runs).toEqual([T0]);
        await advance(1);
        expect(c.runs).toEqual([T0, T0 + 5_000]);
    });

    it('a failed run tries again after 1, 2, 5, then every 15 minutes, and settles once it works', async () => {
        const { s, stands, advance, log } = setup((c) => [stand('reminders', c)]);
        const [r] = stands as [Stand];
        r.fail.left = 5;
        await s.start();
        await advance(60 * MIN);
        const gaps = r.runs.slice(1).map((t, i) => (t - r.runs[i]!) / MIN);
        expect(gaps).toEqual([1, 2, 5, 15, 15]);
        expect(BACKOFF_MS.map((b) => b / MIN)).toEqual([1, 2, 5, 15]);
        expect(r.fail.left).toBe(0);
        expect(r.runs).toHaveLength(6); // the sixth worked: no more runs
        expect(log.filter((l) => l.includes('reminders failed'))).toHaveLength(5);
    });

    it('a pass that reports failures (one user, one email) backs off the same way', async () => {
        let failed = 1;
        const { s, stands, advance } = setup((c) => [stand('nudge', c, { outcome: () => ({ failed: failed-- > 0 ? 1 : 0 }) })]);
        const [n] = stands as [Stand];
        await s.start();
        await advance(10 * MIN);
        expect(n.runs).toEqual([T0, T0 + MIN]);
    });

    it("a dropped connection is retried at once (the pool's one retry) before any backoff", async () => {
        const clock = new ManualClock(T0);
        let calls = 0;
        const job: Job = {
            name: 'reminders',
            run: async () => {
                calls += 1;
                if (calls === 1) throw new Prisma.PrismaClientKnownRequestError('Server has closed the connection.', { code: 'P1017', clientVersion: '7.8.0' });
            },
            next: async () => null,
        };
        const s = new Scheduler([job], { sweepMinutes: 180, housekeeping: async () => {}, clock, log: () => {} });
        await s.start();
        expect(calls).toBe(2);
        expect(s.nextAt('reminders')).toBeNull(); // no backoff armed
    }, 10_000);

    it('one pass at a time: two pokes and its timer at the same moment make one run, then one more pass for the pokes', async () => {
        const { clock, s, stands } = setup((c) => [stand('reminders', c)]);
        const [r] = stands as [Stand];
        await s.start();
        r.due.at = T0 + 10 * MIN;
        s.poke('reminders');
        await clock.advance(POKE_DELAY_MS, () => s.idle());
        // At the moment: the timer fires and two pokes arrive.
        const moment = T0 + 10 * MIN;
        await clock.advance(moment - clock.now() - 1, () => s.idle());
        s.poke('reminders');
        s.poke('reminders');
        await clock.advance(POKE_DELAY_MS + 1, () => s.idle());
        expect(r.runs.filter((t) => t >= moment)).toEqual([moment]); // the pokes found nothing due after the run
    });

    it('work left over runs again after a short gap; a job that never settles waits 15 minutes', async () => {
        let left = 3;
        const { s, stands, advance } = setup((c) => [stand('capture', c, { outcome: () => ({ more: left-- > 0 }) })]);
        const [c] = stands as [Stand];
        await s.start();
        await advance(MIN);
        expect(c.runs).toEqual([T0, T0 + MIN_GAP_MS, T0 + 2 * MIN_GAP_MS, T0 + 3 * MIN_GAP_MS]);

        const stuck = setup((cl) => [stand('buddy', cl)]);
        const [b] = stuck.stands as [Stand];
        b.job.next = async () => new Date(stuck.clock.now()); // always "due now"
        await stuck.s.start();
        await stuck.advance(MAX_IMMEDIATE * MIN_GAP_MS + MIN_GAP_MS);
        expect(b.runs).toHaveLength(MAX_IMMEDIATE + 1);
        expect(stuck.s.nextAt('buddy')?.getTime()).toBe(b.runs[b.runs.length - 1]! + 15 * MIN);
        expect(stuck.log.some((l) => l.includes('buddy keeps finding work due'))).toBe(true);
    });

    it('sweeps every SWEEP_MINUTES: the housekeeping and every pass, even with nothing armed', async () => {
        const { s, stands, housekeeping, advance } = setup((c) => [stand('reminders', c), stand('rollover', c)], 180);
        await s.start();
        await advance(6 * HOUR);
        expect(housekeeping).toEqual([T0, T0 + 3 * HOUR, T0 + 6 * HOUR]);
        for (const x of stands) expect(x.runs).toEqual([T0, T0 + 3 * HOUR, T0 + 6 * HOUR]);
    });

    it('stop() ends the timers and waits for a pass in progress; nothing runs after', async () => {
        const { s, stands, advance } = setup((c) => [stand('reminders', c)]);
        const [r] = stands as [Stand];
        r.due.at = T0 + 5 * MIN;
        await s.start();
        await s.stop();
        await advance(10 * HOUR);
        expect(r.runs).toEqual([T0]);
        s.poke('reminders');
        await advance(MIN);
        expect(r.nexts).toHaveLength(1);
        expect(MAX_WAIT_MS).toBe(HOUR);
    });
});
