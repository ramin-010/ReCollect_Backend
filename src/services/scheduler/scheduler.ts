// The quiet scheduler's engine (hosting P1-11; the deployment blueprint §4.1).
//
// The database stays the only record of what is due; the timers here are a cache of it, rebuilt
// at every start. Each job is one "is anything due?" pass (the same function its cron tick runs
// in poll mode) plus a question: when is its next due moment? The engine:
//   1. at start runs every pass once (the catch-up: whatever fell due while the server was down);
//   2. after every run asks each job for its next moment and sets ONE timer for it; a timer never
//      waits longer than an hour in memory (it re-checks the clock and re-arms, with no query);
//   3. takes pokes from the service functions that change what is due, and re-reads that job's next
//      moment (or, for work on arrival, runs it a few seconds later);
//   4. retries a failed run after 1, 2, 5, then every 15 minutes (after one quick retry for a dropped
//      connection, src/db/retry.ts); nothing is lost meanwhile, the rows stay pending;
//   5. sweeps every SWEEP_MINUTES: every pass plus the housekeeping, the safety net for anything a
//      timer or a poke missed;
//   6. runs one pass of a job at a time; a poke during a run causes one more pass afterwards.
// Between those moments it never touches the database, so a database that sleeps when idle (Neon,
// after 5 minutes) can sleep. Every job keeps the claim it already had, so a pass that runs twice is
// harmless. This file knows no job: src/services/scheduler/jobs.ts holds the table.
import { retryOnConnectionError } from '../../db/retry';

export type JobName = 'reminders' | 'capture' | 'rollover' | 'nudge' | 'buddy' | 'recallPoll' | 'recallNightly';

export interface JobOutcome {
    /** Some of the pass failed (a user's step, an email): the job runs again on the backoff. */
    failed?: number;
    /** It stopped at its batch size with work left: it runs again shortly. */
    more?: boolean;
}

export interface Job {
    name: JobName;
    /** One pass: does what is due now (exactly what its cron tick does in poll mode). */
    run(now: Date): Promise<JobOutcome | void>;
    /** The next moment this job has work, from the database; null when nothing is known (the sweep looks again). */
    next(now: Date): Promise<Date | null>;
    /** Left out of the sweep and the catch-up (a job at a fixed hour: the nightly Recall batch). */
    timedOnly?: boolean;
    /** A poke runs the pass (work on arrival) instead of re-reading the next moment. */
    runOnPoke?: boolean;
    /** How long a poke waits, so a burst of changes becomes one read (default 1.5 s). */
    pokeDelayMs?: number;
}

/** Time and timers; tests pass a clock they move by hand (the database's own I/O stays real). */
export interface Clock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.(); // the HTTP server keeps the process alive, never a timer of ours
        return t;
    },
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface SchedulerOptions {
    /** SWEEP_MINUTES (180 in production). */
    sweepMinutes: number;
    /** The sweep's housekeeping: expired codes, the trash, old chats and agent history, OAuth leftovers. */
    housekeeping: () => Promise<void>;
    log?: (line: string) => void;
    clock?: Clock;
}

/** A timer waits at most this long, then re-checks the clock (a clock change, a suspended machine). */
export const MAX_WAIT_MS = 60 * 60_000;
/** The waits after a failed run: 1, 2, 5, then every 15 minutes. */
export const BACKOFF_MS = [1, 2, 5, 15].map((m) => m * 60_000);
export const POKE_DELAY_MS = 1_500;
/** A job due again right after a run waits at least this long (a batch with work left)... */
export const MIN_GAP_MS = 5_000;
/** ...and after this many such runs in a row it waits 15 minutes (a job that never settles). */
export const MAX_IMMEDIATE = 20;

interface JobState {
    job: Job;
    timer: unknown;
    pokeTimer: unknown;
    /** When the armed timer runs the job (epoch ms), or null. */
    at: number | null;
    /** What the pump does next: run the pass, or only re-read the next moment. */
    pending: 'run' | 'refresh' | null;
    pump: Promise<void> | null;
    failures: number;
    immediate: number;
    lastRun: number;
}

const describe = (err: unknown): string => {
    const e = err as { code?: unknown; message?: unknown } | null;
    const code = typeof e?.code === 'string' ? `${e.code} ` : '';
    const message = typeof e?.message === 'string' ? e.message.split('\n').filter(Boolean).pop() ?? '' : String(err);
    return `${code}${message}`.slice(0, 200);
};

export class Scheduler {
    private readonly states = new Map<JobName, JobState>();
    private readonly log: (line: string) => void;
    private readonly clock: Clock;
    private sweepTimer: unknown = null;
    private sweepAt: number | null = null;
    private sweeping: Promise<void> | null = null;
    private stopped = true;

    constructor(
        jobs: readonly Job[],
        private readonly options: SchedulerOptions,
    ) {
        this.log = options.log ?? ((line) => console.log(line));
        this.clock = options.clock ?? realClock;
        for (const job of jobs) {
            this.states.set(job.name, { job, timer: null, pokeTimer: null, at: null, pending: null, pump: null, failures: 0, immediate: 0, lastRun: 0 });
        }
    }

    /** The catch-up (every pass once), then every job's timer and the next sweep. */
    async start(): Promise<void> {
        this.stopped = false;
        await this.sweep('start');
    }

    /** No more timers or runs; resolves when the passes already running have finished. */
    async stop(): Promise<void> {
        this.stopped = true;
        if (this.sweepTimer) this.clock.clearTimeout(this.sweepTimer);
        this.sweepTimer = null;
        this.sweepAt = null;
        for (const s of this.states.values()) {
            if (s.timer) this.clock.clearTimeout(s.timer);
            if (s.pokeTimer) this.clock.clearTimeout(s.pokeTimer);
            s.timer = s.pokeTimer = null;
            s.at = null;
            s.pending = null;
        }
        await this.idle();
    }

    /** Resolves once no sweep and no pass is running (tests; shutdown). */
    async idle(): Promise<void> {
        for (;;) {
            const busy = [this.sweeping, ...[...this.states.values()].map((s) => s.pump)].filter((p): p is Promise<void> => !!p);
            if (!busy.length) return;
            await Promise.all(busy.map((p) => p.catch(() => {})));
        }
    }

    /** Something changed what `name` has due; a service function calls this through poke() below. */
    poke(name: JobName): void {
        const s = this.states.get(name);
        if (!s || this.stopped || s.pokeTimer) return; // a burst becomes one
        s.pokeTimer = this.clock.setTimeout(() => {
            s.pokeTimer = null;
            this.request(s, s.job.runOnPoke ? 'run' : 'refresh');
        }, s.job.pokeDelayMs ?? POKE_DELAY_MS);
    }

    /** When the job's timer will run it (tests and the log); null when none is set. */
    nextAt(name: JobName): Date | null {
        const at = this.states.get(name)?.at;
        return at === null || at === undefined ? null : new Date(at);
    }

    /** When the next sweep runs. */
    nextSweepAt(): Date | null {
        return this.sweepAt === null ? null : new Date(this.sweepAt);
    }

    /** Every pass and the housekeeping now (also what start() does); one sweep at a time. */
    sweep(why = 'sweep'): Promise<void> {
        if (this.sweeping) return this.sweeping;
        this.sweeping = (async () => {
            try {
                if (this.stopped) return;
                try {
                    await retryOnConnectionError(() => this.options.housekeeping());
                } catch (err) {
                    this.log(`[scheduler] housekeeping failed (${why}): ${describe(err)}`);
                }
                for (const s of this.states.values()) {
                    if (this.stopped) return;
                    this.request(s, s.job.timedOnly ? 'refresh' : 'run');
                    await s.pump;
                }
            } finally {
                this.sweeping = null;
                this.armSweep(this.clock.now() + this.options.sweepMinutes * 60_000);
            }
        })();
        return this.sweeping;
    }

    private armSweep(at: number): void {
        if (this.sweepTimer) this.clock.clearTimeout(this.sweepTimer);
        this.sweepTimer = null;
        if (this.stopped) return;
        this.sweepAt = at;
        const wait = at - this.clock.now();
        this.sweepTimer = wait > MAX_WAIT_MS ? this.clock.setTimeout(() => this.armSweep(at), MAX_WAIT_MS) : this.clock.setTimeout(() => void this.sweep(), Math.max(0, wait));
    }

    private arm(s: JobState, at: number | null): void {
        if (s.timer) this.clock.clearTimeout(s.timer);
        s.timer = null;
        s.at = at;
        if (at === null || this.stopped) return;
        const wait = at - this.clock.now();
        // Longer than an hour: wake to re-check the clock and re-arm, with no query.
        s.timer = wait > MAX_WAIT_MS ? this.clock.setTimeout(() => this.arm(s, at), MAX_WAIT_MS) : this.clock.setTimeout(() => this.request(s, 'run'), Math.max(0, wait));
    }

    /** Asks the job's pump for a run or a refresh; one pump per job, so one pass at a time. */
    private request(s: JobState, what: 'run' | 'refresh'): void {
        if (this.stopped) return;
        if (what === 'run' || !s.pending) s.pending = what;
        if (!s.pump) {
            s.pump = this.pumpLoop(s).finally(() => {
                s.pump = null;
            });
        }
    }

    private async pumpLoop(s: JobState): Promise<void> {
        while (s.pending && !this.stopped) {
            const what = s.pending;
            s.pending = null;
            if (what === 'run') await this.runPass(s);
            else await this.refresh(s, false, false);
        }
    }

    private backoff(s: JobState): void {
        const wait = BACKOFF_MS[Math.min(s.failures, BACKOFF_MS.length - 1)]!;
        s.failures += 1;
        this.arm(s, this.clock.now() + wait);
    }

    private async runPass(s: JobState): Promise<void> {
        if (s.timer) this.clock.clearTimeout(s.timer);
        s.timer = null;
        s.at = null;
        s.lastRun = this.clock.now();
        let outcome: JobOutcome | void;
        try {
            outcome = await retryOnConnectionError(() => s.job.run(new Date(this.clock.now())));
        } catch (err) {
            this.log(`[scheduler] ${s.job.name} failed (try ${s.failures + 1}): ${describe(err)}`);
            return this.backoff(s);
        }
        if (this.stopped) return;
        if ((outcome?.failed ?? 0) > 0) return this.backoff(s);
        s.failures = 0;
        await this.refresh(s, outcome?.more === true, true);
    }

    /** Re-reads the job's next moment and arms its timer. `afterRun`: straight after a pass of its own. */
    private async refresh(s: JobState, more: boolean, afterRun: boolean): Promise<void> {
        let next: Date | null;
        try {
            next = more ? new Date(this.clock.now()) : await retryOnConnectionError(() => s.job.next(new Date(this.clock.now())));
        } catch (err) {
            this.log(`[scheduler] ${s.job.name}: its next moment could not be read: ${describe(err)}`);
            return this.backoff(s);
        }
        if (this.stopped) return;
        const now = this.clock.now();
        let at = next ? next.getTime() : null;
        if (at !== null && at <= now && !afterRun) {
            at = now; // a poke or the sweep found something due: at once
        } else if (at !== null && at <= now) {
            // Due again straight after its own pass: work left over, or a job that does not settle. Never a busy loop.
            s.immediate += 1;
            if (s.immediate > MAX_IMMEDIATE) {
                this.log(`[scheduler] ${s.job.name} keeps finding work due; next look in 15 minutes`);
                s.immediate = 0;
                at = now + BACKOFF_MS[BACKOFF_MS.length - 1]!;
            } else {
                at = Math.max(at, s.lastRun + MIN_GAP_MS);
            }
        } else {
            s.immediate = 0;
        }
        this.arm(s, at);
    }
}

// ─── The one running scheduler (quiet mode) ──────────────────────────────────

/** What the service functions talk to: the running scheduler, or a test's stand-in. */
export interface Pokeable {
    poke(name: JobName): void;
}

let active: Pokeable | null = null;

/** jobs.ts sets the running scheduler (quiet mode); tests set a recorder; null stops the pokes. */
export function setActiveScheduler(s: Pokeable | null): void {
    active = s;
}

/**
 * A service function changed what a job has due (a reminder made, moved or ended; a time zone, a
 * nudge time or the buddy's settings saved; words queued; a Recall batch sent). Does nothing in
 * poll mode and in tests: the crons find the change on their own there.
 */
export function poke(...names: JobName[]): void {
    for (const name of names) active?.poke(name);
}
