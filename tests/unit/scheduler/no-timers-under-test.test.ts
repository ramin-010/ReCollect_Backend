// Hosting warning 4: background timers never start under NODE_ENV=test. Every recurring job starts in
// startBackgroundJobs (src/services/scheduler/jobs.ts), the awake meter in startAwakeMeter; both stop
// first under NODE_ENV=test, so no test (the shutdown test runs the real server with it) starts one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBackgroundJobs } from '../../../src/services/scheduler/jobs';
import { startAwakeMeter } from '../../../src/services/scheduler/awake';

afterEach(() => vi.useRealTimers());

describe('timers under NODE_ENV=test', () => {
    it('neither the jobs, in either scheduler mode, nor the awake meter start one', () => {
        vi.useFakeTimers();
        for (const mode of [undefined, 'poll', 'quiet']) {
            expect(startBackgroundJobs({ NODE_ENV: 'test', ...(mode ? { SCHEDULER_MODE: mode } : {}) })).toBeNull();
        }
        expect(startAwakeMeter({ NODE_ENV: 'test', SCHEDULER_MODE: 'quiet' })).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
});
