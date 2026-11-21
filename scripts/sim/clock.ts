// The simulation's clock (SIMULATION_PLAN §4.3): one process, one moved clock. Installed before anything
// else is imported, so every `new Date()` and `Date.now()` in this process reads it: the services, the API
// served in this same process (the chat's tools call it back), Prisma's own timestamps. Between moves it
// ticks with real time, so the order of what happens inside a step stays real.
const RealDate = Date;
let base = RealDate.now();
let anchor = RealDate.now();

/** The simulated time now (ms). */
export const simNow = (): number => base + (RealDate.now() - anchor);

/** Moves the clock to `at`; it ticks on from there. Never backwards within a run. */
export function setClock(at: Date | number): void {
    base = typeof at === 'number' ? at : at.getTime();
    anchor = RealDate.now();
}

/** Real wall time (ms), for measuring how long a step took. */
export const realNow = (): number => RealDate.now();

let installed = false;

export function installClock(start: Date | number): void {
    setClock(start);
    if (installed) return;
    installed = true;
    class SimDate extends RealDate {
        constructor(...args: unknown[]) {
            if (args.length === 0) super(simNow());
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            else super(...(args as [any]));
        }
        static override now(): number {
            return simNow();
        }
        // A date made before the clock was installed (or by code that kept the real one) still counts as a Date.
        static [Symbol.hasInstance](x: unknown): boolean {
            return x instanceof RealDate;
        }
    }
    globalThis.Date = SimDate as unknown as DateConstructor;
}
