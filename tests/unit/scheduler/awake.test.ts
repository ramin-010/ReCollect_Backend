// The database's awake-time meter (hosting P1-15): the window arithmetic, the month's reset, each
// alert once, the daily log line, and the state kept across a restart. Times are passed in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    ALLOWANCE_HOURS,
    AWAKE_WINDOW_MS,
    AwakeMeter,
    freshAwakeState,
    readAwakeState,
    stateDir,
    writeAwakeState,
    type AwakeAlertInfo,
    type AwakeState,
} from '../../../src/services/scheduler/awake';
import { awakeAlertText } from '../../../src/utils/emailService';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOV1 = Date.UTC(2026, 10, 1);

function meter(start = NOV1) {
    const alerts: AwakeAlertInfo[] = [];
    const saves: AwakeState[] = [];
    const log: string[] = [];
    const m = new AwakeMeter(freshAwakeState(start), { alert: (a) => alerts.push(a), save: (s) => saves.push(s), log: (l) => log.push(l) });
    return { m, alerts, saves, log };
}

/** Keeps the database awake from `from` for `hours` (a query every 4 minutes). */
function busy(m: AwakeMeter, from: number, hours: number): void {
    for (let t = from; t < from + hours * HOUR; t += 4 * MIN) m.touch(t);
}

let tmp: string | null = null;
afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
});

describe('the awake meter', () => {
    it('counts the union of the 5-minute windows after each query', () => {
        const { m } = meter();
        const t = NOV1 + 9 * HOUR;
        m.touch(t);
        expect(m.awakeMs()).toBe(AWAKE_WINDOW_MS); // one query: 5 minutes
        m.touch(t + MIN);
        m.touch(t + 4 * MIN);
        expect(m.awakeMs()).toBe(9 * MIN); // overlapping windows: from t to 5 minutes after the last
        m.touch(t + 20 * MIN); // asleep in between
        expect(m.awakeMs()).toBe(9 * MIN + 5 * MIN);
        m.touch(t + 20 * MIN); // the same moment twice adds nothing
        expect(m.awakeMs()).toBe(14 * MIN);
    });

    it("starts again on the 1st of the month (UTC, as Neon bills) and logs the month that ended", () => {
        const { m, log } = meter();
        busy(m, NOV1 + 2 * DAY, 3); // queries for 3 hours: awake from the first to 5 minutes after the last
        expect(m.awakeMs()).toBe(181 * MIN);
        expect(m.summary(NOV1 + 3 * DAY).hours).toBe(3);
        const dec1 = Date.UTC(2026, 11, 1);
        m.touch(dec1 + MIN);
        expect(m.awakeMs()).toBe(AWAKE_WINDOW_MS);
        expect(m.summary(dec1 + 2 * MIN).month).toBe('2026-12');
        expect(log.some((l) => l.startsWith('[awake] 2026-11 ended: 3 h'))).toBe(true);
    });

    it('writes one log line a day', () => {
        const { m, log } = meter();
        m.touch(NOV1 + HOUR);
        m.touch(NOV1 + 2 * HOUR);
        m.touch(NOV1 + DAY + HOUR);
        expect(log.filter((l) => l.includes('so far'))).toHaveLength(2);
    });

    it('alerts at 60, 80 and 90 % of the 400 hours, each once a month', () => {
        const { m, alerts } = meter();
        expect(ALLOWANCE_HOURS).toBe(400);
        // Awake around the clock from the 1st: 240 h is 60 %, reached on the 11th.
        busy(m, NOV1, 24 * 17);
        const kinds = alerts.map((a) => a.alert);
        expect(kinds.filter((k) => k === '60')).toHaveLength(1);
        expect(kinds.filter((k) => k === '80')).toHaveLength(1);
        expect(kinds.filter((k) => k === '90')).toHaveLength(1);
        const at60 = alerts.find((a) => a.alert === '60')!;
        expect(at60.hours).toBeGreaterThanOrEqual(240);
        expect(at60.hours).toBeLessThan(241);
    });

    it("alerts when the month's pace passes 100 %, only after its first 3 days, once", () => {
        const { m, alerts } = meter();
        busy(m, NOV1, 71); // awake around the clock: a pace of 720 h, but too early to say
        expect(alerts).toEqual([]);
        busy(m, NOV1 + 71 * HOUR, 2); // past 72 hours
        const pace = alerts.filter((a) => a.alert === 'pace');
        expect(pace).toHaveLength(1);
        expect(pace[0]!.projectedHours).toBeGreaterThan(ALLOWANCE_HOURS);
        busy(m, NOV1 + 4 * DAY, 20);
        expect(alerts.filter((a) => a.alert === 'pace')).toHaveLength(1);
    });

    it('a month at 10 hours a day crosses 60 % only, with no pace alert', () => {
        const { m, alerts } = meter();
        for (let d = 0; d < 30; d++) busy(m, NOV1 + d * DAY + 9 * HOUR, 10); // 10 h a day: 300 h
        expect(alerts.map((a) => a.alert)).toEqual(['60']);
    });

    it('the state survives a restart: written at most once a minute, read back, counting on', () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awake-'));
        const dir = tmp;
        const saved: AwakeState[] = [];
        const first = new AwakeMeter(freshAwakeState(NOV1), {
            save: (s) => {
                saved.push(s);
                writeAwakeState(dir, s);
            },
        });
        const t = NOV1 + 10 * HOUR;
        first.touch(t);
        first.touch(t + 10_000);
        first.touch(t + 20_000);
        expect(saved).toHaveLength(1); // not on every query
        first.touch(t + 2 * MIN);
        expect(saved).toHaveLength(2);

        const second = new AwakeMeter(readAwakeState(dir, t + HOUR));
        expect(second.awakeMs()).toBe(7 * MIN);
        second.touch(t + HOUR);
        expect(second.awakeMs()).toBe(12 * MIN);
    });

    it('a missing or broken state file starts the month fresh', () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awake-'));
        expect(readAwakeState(tmp, NOV1).awakeMs).toBe(0);
        fs.writeFileSync(path.join(tmp, 'awake.json'), '{ not json');
        expect(readAwakeState(tmp, NOV1)).toEqual(freshAwakeState(NOV1));
    });

    it('its folder: RECOLLECT_STATE_DIR, else backend/.devdb/state', () => {
        expect(stateDir({ RECOLLECT_STATE_DIR: '/srv/workspace/state' })).toBe('/srv/workspace/state');
        expect(stateDir({}).replace(/\\/g, '/')).toMatch(/backend\/\.devdb\/state$/);
    });

    it("the alert email says the hours, the allowance and the pace", () => {
        const pace = awakeAlertText({ alert: 'pace', month: '2026-11', hours: 120, allowanceHours: 400, percent: 30, projectedHours: 450 });
        expect(pace.subject).toContain('on pace for 450 of 400');
        const eighty = awakeAlertText({ alert: '80', month: '2026-11', hours: 321, allowanceHours: 400, percent: 80, projectedHours: 410 });
        expect(eighty.subject).toContain('80%');
        expect(eighty.text).toContain('about 321 h of the 400 h');
    });
});
