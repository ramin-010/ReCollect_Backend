// A clock moved by hand, for the quiet scheduler's tests (src/services/scheduler/scheduler.ts takes
// a Clock). Only the scheduler's own timers use it: the database's I/O, pg's timeouts and the retry
// helper's one-second wait stay real, so tests can run the real passes against the test database.
import type { Clock } from '../../src/services/scheduler/scheduler';

interface Pending {
    at: number;
    fn: () => void;
}

export class ManualClock implements Clock {
    private t: number;
    private seq = 0;
    private readonly timers = new Map<number, Pending>();

    constructor(start: Date | number = Date.now()) {
        this.t = typeof start === 'number' ? start : start.getTime();
    }

    now(): number {
        return this.t;
    }

    setTimeout(fn: () => void, ms: number): unknown {
        const id = ++this.seq;
        this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
        return id;
    }

    clearTimeout(handle: unknown): void {
        this.timers.delete(handle as number);
    }

    /** The moments timers are set for, soonest first. */
    pendingAt(): number[] {
        return [...this.timers.values()].map((p) => p.at).sort((a, b) => a - b);
    }

    /**
     * Moves time forward by `ms`. The timers due at the same instant fire together, in the order they
     * were set (as real timers at the same millisecond run before any I/O answers); then `settle` (the
     * scheduler's idle()) is awaited, so the work they start finishes before the next instant.
     */
    async advance(ms: number, settle: () => Promise<void>): Promise<void> {
        const end = this.t + ms;
        for (;;) {
            await settle();
            const due = [...this.timers.entries()].filter(([, p]) => p.at <= end);
            if (!due.length) break;
            const at = Math.min(...due.map(([, p]) => p.at));
            const now = due.filter(([, p]) => p.at === at).sort((a, b) => a[0] - b[0]);
            this.t = Math.max(this.t, at);
            for (const [id] of now) this.timers.delete(id);
            for (const [, p] of now) p.fn();
        }
        this.t = end;
        await settle();
    }
}
