// The database's awake-time meter (hosting P1-15; the deployment blueprint §3.5).
//
// Neon's free plan stays awake for 5 minutes after each query and allows 100 compute-unit hours a
// month: 400 awake hours at the smallest size; when they run out the database is suspended until
// the next month. This meter is the early warning (Neon's console is the truth): it counts the
// awake time as the union of 5-minute windows after each query the pool hands out, keeps it in a
// small JSON file in RECOLLECT_STATE_DIR (written at most once a minute, so a restart keeps it),
// starts again on the 1st of each month (UTC, as Neon bills), writes one line a day to the log and
// emails OWNER_EMAIL at 60, 80 and 90 % of the allowance and when the month's pace projects past
// 100 % (from the 3rd day on): each once a month. Without OWNER_EMAIL it only logs.
import fs from 'node:fs';
import path from 'node:path';
import { pgPool } from '../../db/prisma';
import { ownerEmail } from '../../config/owner';
import { sendAwakeAlertEmail } from '../../utils/emailService';

/** Neon suspends a compute after this long without a query. */
export const AWAKE_WINDOW_MS = 5 * 60_000;
/** 100 compute-unit hours at 0.25 CU (the fixed size): the free plan's month. */
export const ALLOWANCE_HOURS = 400;
export const ALERT_PERCENTS = [60, 80, 90] as const;
/** The pace alert waits for this much of the month (a first busy day says little). */
export const PACE_FROM_MS = 3 * 86_400_000;
const SAVE_EVERY_MS = 60_000;
const HOUR_MS = 3_600_000;

export type AwakeAlert = `${(typeof ALERT_PERCENTS)[number]}` | 'pace';

export interface AwakeState {
    /** The UTC month counted, 'YYYY-MM'. */
    month: string;
    /** Awake time of the windows already closed this month. */
    awakeMs: number;
    /** The open window: from the first query after a sleep to 5 minutes after the last one. */
    windowStart: number | null;
    windowEnd: number | null;
    /** The alerts sent this month. */
    alerted: AwakeAlert[];
    /** The UTC day of the last daily log line, 'YYYY-MM-DD'. */
    loggedDay: string | null;
}

export interface AwakeSummary {
    month: string;
    hours: number;
    allowanceHours: number;
    percent: number;
    /** The month's total at this pace. */
    projectedHours: number;
}

export interface AwakeAlertInfo extends AwakeSummary {
    alert: AwakeAlert;
}

const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);
const dayOfUtc = (at: number) => new Date(at).toISOString().slice(0, 10);
const monthStart = (month: string) => Date.parse(`${month}-01T00:00:00.000Z`);
const nextMonthStart = (month: string) => {
    const d = new Date(monthStart(month));
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.getTime();
};
const round1 = (n: number) => Math.round(n * 10) / 10;

export function freshAwakeState(at: number): AwakeState {
    return { month: monthOf(at), awakeMs: 0, windowStart: null, windowEnd: null, alerted: [], loggedDay: null };
}

export interface AwakeMeterOptions {
    save?: (state: AwakeState) => void;
    alert?: (info: AwakeAlertInfo) => void;
    log?: (line: string) => void;
}

/** The arithmetic, with no clock or file of its own (tests pass the times). */
export class AwakeMeter {
    private lastSave = 0;

    constructor(
        private state: AwakeState,
        private readonly options: AwakeMeterOptions = {},
    ) {}

    /** A query at `at`: the database is awake until 5 minutes later. */
    touch(at: number): void {
        if (monthOf(at) !== this.state.month) this.newMonth(at);
        const s = this.state;
        if (s.windowStart !== null && s.windowEnd !== null && at <= s.windowEnd) {
            s.windowEnd = Math.max(s.windowEnd, at + AWAKE_WINDOW_MS);
        } else {
            this.closeWindow();
            s.windowStart = at;
            s.windowEnd = at + AWAKE_WINDOW_MS;
        }
        this.daily(at);
        this.checkAlerts(at);
        if (at - this.lastSave >= SAVE_EVERY_MS) this.flush(at);
    }

    /** This month's awake time so far, the open window counted to its end (the database stays up that long). */
    awakeMs(): number {
        const s = this.state;
        return s.awakeMs + (s.windowStart !== null && s.windowEnd !== null ? s.windowEnd - s.windowStart : 0);
    }

    summary(at: number): AwakeSummary {
        if (monthOf(at) !== this.state.month) return { month: monthOf(at), hours: 0, allowanceHours: ALLOWANCE_HOURS, percent: 0, projectedHours: 0 };
        const hours = this.awakeMs() / HOUR_MS;
        const start = monthStart(this.state.month);
        const elapsed = Math.max(at - start, 1);
        const projectedHours = (hours * (nextMonthStart(this.state.month) - start)) / elapsed;
        return { month: this.state.month, hours: round1(hours), allowanceHours: ALLOWANCE_HOURS, percent: Math.round((hours / ALLOWANCE_HOURS) * 100), projectedHours: round1(projectedHours) };
    }

    snapshot(): AwakeState {
        return { ...this.state, alerted: [...this.state.alerted] };
    }

    /** Writes the state now (every minute at most while queries come; at shutdown). */
    flush(at: number): void {
        this.lastSave = at;
        this.options.save?.(this.snapshot());
    }

    private closeWindow(): void {
        const s = this.state;
        if (s.windowStart !== null && s.windowEnd !== null) s.awakeMs += s.windowEnd - s.windowStart;
        s.windowStart = s.windowEnd = null;
    }

    private newMonth(at: number): void {
        const ended = this.summary(nextMonthStart(this.state.month) - 1);
        if (this.awakeMs() > 0) this.options.log?.(`[awake] ${ended.month} ended: ${ended.hours} h awake of ${ALLOWANCE_HOURS} h (${ended.percent}%)`);
        this.state = freshAwakeState(at);
        this.lastSave = 0;
    }

    private daily(at: number): void {
        const day = dayOfUtc(at);
        if (this.state.loggedDay === day) return;
        this.state.loggedDay = day;
        const s = this.summary(at);
        this.options.log?.(`[awake] ${s.month} so far: ${s.hours} h of ${ALLOWANCE_HOURS} h (${s.percent}%); this pace: ${s.projectedHours} h`);
    }

    private checkAlerts(at: number): void {
        const s = this.summary(at);
        const send = (alert: AwakeAlert) => {
            this.state.alerted.push(alert);
            this.options.alert?.({ ...s, alert });
            this.flush(at);
        };
        for (const p of ALERT_PERCENTS) {
            if (s.hours >= (ALLOWANCE_HOURS * p) / 100 && !this.state.alerted.includes(`${p}`)) send(`${p}`);
        }
        if (at - monthStart(this.state.month) >= PACE_FROM_MS && s.projectedHours > ALLOWANCE_HOURS && !this.state.alerted.includes('pace')) send('pace');
    }
}

// ─── The running meter ─────────────────────────────────────────────────────────

/** RECOLLECT_STATE_DIR, else backend/.devdb/state (dev; never a path shared with production). */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
    return env['RECOLLECT_STATE_DIR']?.trim() || path.resolve(__dirname, '..', '..', '..', '.devdb', 'state');
}

const FILE = 'awake.json';

export function readAwakeState(dir: string, at: number): AwakeState {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')) as Partial<AwakeState>;
        if (typeof raw.month !== 'string' || typeof raw.awakeMs !== 'number') return freshAwakeState(at);
        return {
            month: raw.month,
            awakeMs: raw.awakeMs,
            windowStart: typeof raw.windowStart === 'number' ? raw.windowStart : null,
            windowEnd: typeof raw.windowEnd === 'number' ? raw.windowEnd : null,
            alerted: Array.isArray(raw.alerted) ? (raw.alerted.filter((a) => typeof a === 'string') as AwakeAlert[]) : [],
            loggedDay: typeof raw.loggedDay === 'string' ? raw.loggedDay : null,
        };
    } catch {
        return freshAwakeState(at);
    }
}

export function writeAwakeState(dir: string, state: AwakeState): void {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
    fs.renameSync(`${file}.tmp`, file);
}

let meter: AwakeMeter | null = null;

/** src/index.ts: counts every query the pool hands out. Never under NODE_ENV=test. */
export function startAwakeMeter(env: NodeJS.ProcessEnv = process.env): AwakeMeter | null {
    if (env['NODE_ENV'] === 'test' || meter) return meter;
    const pool = pgPool();
    if (!pool) return null;
    const dir = stateDir(env);
    meter = new AwakeMeter(readAwakeState(dir, Date.now()), {
        save: (state) => {
            try {
                writeAwakeState(dir, state);
            } catch (err) {
                console.error(`[awake] could not write ${FILE}: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
        log: (line) => console.log(line),
        alert: (info) => {
            const to = ownerEmail(env);
            console.log(`[awake] alert ${info.alert}: ${info.hours} h of ${info.allowanceHours} h (${info.percent}%), pace ${info.projectedHours} h${to ? '; emailed the owner' : ' (no OWNER_EMAIL: not emailed)'}`);
            if (to) void sendAwakeAlertEmail(to, info);
        },
    });
    const m = meter;
    pool.on('acquire', () => m.touch(Date.now()));
    return meter;
}

/** The owner's usage page: this month's awake hours, or null when no meter runs (tests). */
export function awakeSummary(at: number = Date.now()): AwakeSummary | null {
    return meter ? meter.summary(at) : null;
}

/** Graceful shutdown (P1-2): the state written now. */
export function flushAwakeMeter(): void {
    meter?.flush(Date.now());
}
