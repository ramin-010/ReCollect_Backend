// The background jobs, in one of two modes (hosting P1-11; the deployment blueprint §4.1).
//
//   SCHEDULER_MODE=poll  (the default: dev, tests, a database on the same machine) keeps today's
//                         cron schedules exactly: each job's start function, as before.
//   SCHEDULER_MODE=quiet (production on Neon) runs the same passes through the quiet scheduler
//                         (./scheduler.ts): timers for known moments, pokes from the services, a
//                         sweep every SWEEP_MINUTES (180). The database is touched only when
//                         something is due, so it can sleep.
//
// Moving the database next to the server later means setting SCHEDULER_MODE back to poll.
// Timers never start under NODE_ENV=test.
import cron from 'node-cron';
import { startCronScheduler } from '../cronScheduler';
import { deleteExpiredOtps, startOtpCleanupCron } from '../auth/otp.service';
import { runLearningRolloverPass, nextRolloverDue, startLearningCron } from '../learningDb/rollover.service';
import { nextNudgeEmailDue, runMorningNudgePass, startMorningNudgeCron } from '../learningDb/nudge.service';
import { nextMorningPushDue, runMorningPushPass } from '../push/push.service';
import { nextRecallNightly, nextRecallPollDue, pollRecallBatches, startRecallCrons, submitNightlyRecallBatch } from '../recall/batch.service';
import { startTrashCron, trashHousekeeping } from '../docs/trash.service';
import { drainBuddyQueue, nextBuddyDue, nextCaptureDue, runDueNights, startBuddyWorker } from '../buddy/worker';
import { isAiConfigured } from '../claude/client';
import { nextReminderDue, processDueReminders, REMINDER_BATCH_SIZE } from '../reminders/reminders.service';
import { Scheduler, poke, setActiveScheduler, type Job } from './scheduler';

export type SchedulerMode = 'poll' | 'quiet';

export function schedulerMode(env: NodeJS.ProcessEnv = process.env): SchedulerMode {
    return env['SCHEDULER_MODE']?.trim().toLowerCase() === 'quiet' ? 'quiet' : 'poll';
}

export const SWEEP_MINUTES_DEFAULT = 180;

/** SWEEP_MINUTES: whole minutes, 5 to 1440; anything else is the default 180. */
export function sweepMinutes(env: NodeJS.ProcessEnv = process.env): number {
    const n = Number(env['SWEEP_MINUTES']);
    return Number.isInteger(n) && n >= 5 && n <= 1440 ? n : SWEEP_MINUTES_DEFAULT;
}

const soonest = (...times: (Date | null)[]): Date | null => times.reduce<Date | null>((a, b) => (b && (!a || b < a) ? b : a), null);

const buddyOff = (env: NodeJS.ProcessEnv) => /^(off|0|false)$/i.test(env['BUDDY_WORKER'] ?? '');

/** The job table: each pass is the function its cron tick runs in poll mode. */
export function quietJobs(env: NodeJS.ProcessEnv = process.env): Job[] {
    const jobs: Job[] = [
        {
            // Reminder emails: a timer at the earliest one that needs an email (a phone that holds one rings it).
            name: 'reminders',
            run: async (now) => {
                const r = await processDueReminders(now);
                return { failed: r.failed, more: r.due >= REMINDER_BATCH_SIZE };
            },
            next: (now) => nextReminderDue(now),
        },
        {
            // The learning rollover: at each learner's local midnight (and now for anyone whose day changed).
            name: 'rollover',
            run: async (now) => {
                const r = await runLearningRolloverPass(now);
                if (r.rolledOver > 0 || r.failed > 0) console.log(`[learning] rollover: ${r.rolledOver} rolled over, ${r.failed} failed`);
                return { failed: r.failed };
            },
            next: (now) => nextRolloverDue(now),
        },
        {
            // The morning email and notification: at each one's nudge time.
            name: 'nudge',
            run: async (now) => {
                const r = await runMorningNudgePass(now);
                if (r.sent > 0 || r.failed > 0) console.log(`[learning] morning nudge: ${r.sent} sent, ${r.failed} failed`);
                const p = await runMorningPushPass(now);
                if (p.sent > 0) console.log(`[learning] morning notification: ${p.sent} sent`);
                return { failed: r.failed };
            },
            next: async (now) => soonest(await nextNudgeEmailDue(now), await nextMorningPushDue(now)),
        },
        {
            // A Recall batch that is open: polled every 10 minutes until it ends; none open, no poll.
            name: 'recallPoll',
            run: async (now) => {
                const r = await pollRecallBatches(now);
                if (r.stored > 0) console.log(`[recall] stored ${r.stored} finished batch(es)`);
            },
            next: (now) => nextRecallPollDue(now),
        },
        {
            // Tomorrow's Recall questions at 02:30 server time (as the cron); not in the sweep.
            name: 'recallNightly',
            timedOnly: true,
            run: async (now) => {
                if (!nextRecallNightly(now)) return; // off, or no AI
                const r = await submitNightlyRecallBatch(now);
                if (r.requests > 0) console.log(`[recall] nightly batch ${r.batchId}: ${r.requests} question sets`);
            },
            next: async (now) => nextRecallNightly(now),
        },
    ];
    if (!buddyOff(env)) {
        jobs.push(
            {
                // The buddy's queue: drained a few seconds after words arrive (the database is awake anyway);
                // pieces that must wait are tried again every 15 minutes while any wait.
                name: 'capture',
                runOnPoke: true,
                pokeDelayMs: 5_000,
                run: async (now) => {
                    if (!isAiConfigured()) return;
                    const r = await drainBuddyQueue(now);
                    if (r.digested || r.dropped || r.failed) console.log(`[buddy] queue: ${r.digested} digested, ${r.dropped} dropped, ${r.failed} failed, ${r.waiting} waiting`);
                    // Something new: a pulse may be due now (as the 15-minute pass would have found).
                    if (r.digested > 0) poke('buddy');
                    return { failed: r.failed, more: r.digested + r.dropped + r.failed >= 10 };
                },
                next: (now) => nextCaptureDue(now),
            },
            {
                // The buddy's night after 04:00 his time, the pulses at 12:00 and 18:00 when something new arrived.
                name: 'buddy',
                run: async (now) => {
                    if (!isAiConfigured()) return;
                    const r = await runDueNights(now);
                    if (r.ran || r.failed) console.log(`[buddy] nights: ${r.ran} ran, ${r.failed} failed`);
                    return { failed: r.failed };
                },
                next: (now) => nextBuddyDue(now),
            },
        );
    }
    return jobs;
}

/** The sweep's housekeeping: expired sign-in codes, the trash, old chats and agent history, OAuth leftovers. */
export async function housekeeping(): Promise<void> {
    const removed = await deleteExpiredOtps();
    if (removed > 0) console.log(`🧹 Removed ${removed} expired OTP(s)`);
    await trashHousekeeping();
}

let running: Scheduler | null = null;

/** src/index.ts: the background jobs in the mode SCHEDULER_MODE names. Nothing under NODE_ENV=test. */
export function startBackgroundJobs(env: NodeJS.ProcessEnv = process.env): SchedulerMode | null {
    if (env['NODE_ENV'] === 'test') return null;
    const mode = schedulerMode(env);
    if (mode === 'poll') {
        startCronScheduler(); // reminder emails, every minute
        startOtpCleanupCron(); // expired sign-in codes, every 5 minutes
        startLearningCron(); // the rollover, every 15 minutes and once now
        startMorningNudgeCron(); // the morning email and notification, every 15 minutes
        startRecallCrons(); // the nightly questions at 02:30, the batch poll every 10 minutes
        startTrashCron(); // the trash, old chats, agent history, OAuth leftovers: hourly
        startBuddyWorker(); // the buddy's queue every minute, its nights every 15 minutes
        return mode;
    }
    const minutes = sweepMinutes(env);
    running = new Scheduler(quietJobs(env), { sweepMinutes: minutes, housekeeping });
    setActiveScheduler(running);
    console.log(`✓ Quiet scheduler: timers for what is due, a sweep every ${minutes} min (SCHEDULER_MODE=quiet)`);
    running.start().catch((err) => console.error('[scheduler] the start-up catch-up failed:', err));
    return mode;
}

/** Graceful shutdown (P1-2): no new runs (poll mode's crons stop too); resolves once the quiet scheduler's passes end. */
export async function stopBackgroundJobs(): Promise<void> {
    for (const task of cron.getTasks().values()) await task.stop();
    const s = running;
    running = null;
    setActiveScheduler(null);
    await s?.stop();
}
