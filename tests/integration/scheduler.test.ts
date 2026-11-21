// The quiet scheduler on the real passes and the test database (hosting P1-11: the blueprint's §4.1
// accept list). The scheduler's clock is moved by hand (tests/helpers/manualClock.ts), starting at
// the real time so rows the database stamps agree with it; the database's own I/O stays real.
// Accept 1 (poll mode keeps every existing job test) is the rest of this suite.
import { LOCK_SCHEMA } from '../../src/services/buddy/think';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { Prisma } from '@prisma/client';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { setAiClientForTests } from '../../src/services/claude/client';
import { Scheduler, setActiveScheduler, type Job } from '../../src/services/scheduler/scheduler';
import { housekeeping, quietJobs } from '../../src/services/scheduler/jobs';
import { createTodoReminder } from '../../src/services/reminders/reminders.service';
import { queueWords } from '../../src/services/buddy/capture.service';
import { authCookie, createTestUser } from '../helpers/auth';
import { api, createChainRows, createLearner, createSubjectRow, createTopicRow, d } from '../helpers/learning';
import { clearSentMails, mailsTo, sentMails } from '../helpers/mail';
import { FakeClaude, fakeMessage } from '../helpers/claude';
import { ManualClock } from '../helpers/manualClock';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

let running: Scheduler | null = null;
let logs: string[] = [];

/** The quiet scheduler on the real job table, on a clock moved by hand. */
async function startQuiet(clock: ManualClock, jobs: Job[] = quietJobs()) {
    const s = new Scheduler(jobs, { sweepMinutes: 180, housekeeping, clock, log: (l) => logs.push(l) });
    running = s;
    setActiveScheduler(s);
    await s.start();
    return { s, advance: (ms: number) => clock.advance(ms, () => s.idle()) };
}

const reminderMails = () => sentMails().filter((m) => (m.subject ?? '').startsWith('Task Due:'));
const todoFor = (userId: string, title: string) => prisma.todo.create({ data: { userId, title } });

beforeEach(async () => {
    await prisma.reminder.deleteMany();
    clearSentMails();
    logs = [];
});

afterEach(async () => {
    await running?.stop();
    running = null;
    setActiveScheduler(null);
});

describe('the quiet scheduler: reminders', () => {
    it('accept 3: one due in 90 s is sent between 90 and 95 s; one made with a past time at once', async () => {
        const clock = new ManualClock(Date.now());
        const owner = await createTestUser();
        const { advance } = await startQuiet(clock);
        const t0 = clock.now();
        const set = await api(owner).post('/api/reminders', { title: 'Call the bank', at: new Date(t0 + 90 * SEC).toISOString() });
        expect(set.status).toBe(201);
        await advance(89 * SEC);
        expect(reminderMails()).toHaveLength(0);
        let sentAt: number | null = null;
        for (let i = 0; i < 6 && sentAt === null; i++) {
            await advance(SEC);
            if (reminderMails().length) sentAt = clock.now() - t0;
        }
        expect(sentAt).toBeGreaterThanOrEqual(90 * SEC);
        expect(sentAt).toBeLessThanOrEqual(95 * SEC);

        const late = await todoFor(owner.id, 'Already late');
        await createTodoReminder({ userId: owner.id, todoId: late.id, reminderDate: new Date(clock.now() - MIN), title: late.title });
        await advance(2 * SEC); // the poke's short wait
        expect(reminderMails().map((m) => m.subject)).toEqual(['Task Due: Call the bank', 'Task Due: Already late']);
    });

    it('accept 4: the process killed with a reminder due in 30 s and started 2 minutes later sends it once', async () => {
        const clock = new ManualClock(Date.now());
        const owner = await createTestUser();
        const first = await startQuiet(clock);
        const todo = await todoFor(owner.id, 'Water the plants');
        await createTodoReminder({ userId: owner.id, todoId: todo.id, reminderDate: new Date(clock.now() + 30 * SEC), title: todo.title });
        await first.advance(10 * SEC);
        expect(first.s.nextAt('reminders')).not.toBeNull();
        await first.s.stop(); // killed: its timers are gone
        await clock.advance(2 * MIN, async () => {});
        expect(reminderMails()).toHaveLength(0);

        const second = await startQuiet(clock); // the start-up catch-up
        expect(reminderMails()).toHaveLength(1);
        await second.advance(10 * MIN);
        expect(reminderMails()).toHaveLength(1);
    });

    it('accept 5: the database unreachable when one falls due and back 4 minutes later: sent once, no error escapes', async () => {
        const clock = new ManualClock(Date.now());
        const owner = await createTestUser();
        let down = false;
        const unreachable = () => new Prisma.PrismaClientKnownRequestError("Can't reach database server at `db:5432`", { code: 'P1001', clientVersion: '7.8.0' });
        const jobs = quietJobs().map((j): Job =>
            j.name !== 'reminders' ? j : { ...j, run: (now) => (down ? Promise.reject(unreachable()) : j.run(now)), next: (now) => (down ? Promise.reject(unreachable()) : j.next(now)) },
        );
        const { advance } = await startQuiet(clock, jobs);
        const todo = await todoFor(owner.id, 'Pay rent');
        await createTodoReminder({ userId: owner.id, todoId: todo.id, reminderDate: new Date(clock.now() + MIN), title: todo.title });
        await advance(59 * SEC);
        down = true;
        await advance(5 * MIN); // it falls due at 1:00; the database is back at 6:00
        expect(reminderMails()).toHaveLength(0);
        down = false;
        await advance(10 * MIN);
        expect(reminderMails()).toHaveLength(1);
        expect(logs.filter((l) => l.includes('reminders failed')).length).toBeGreaterThanOrEqual(2);
        await advance(30 * MIN);
        expect(reminderMails()).toHaveLength(1);
    }, 30_000);

    it('accept 6: two pokes and its timer at the same moment make one email', async () => {
        const clock = new ManualClock(Date.now());
        const owner = await createTestUser();
        const { s, advance } = await startQuiet(clock);
        const todo = await todoFor(owner.id, 'Renew the domain');
        await createTodoReminder({ userId: owner.id, todoId: todo.id, reminderDate: new Date(clock.now() + MIN), title: todo.title });
        await advance(MIN - 1500); // the pokes' short wait ends exactly at the minute
        s.poke('reminders');
        s.poke('reminders');
        await advance(10 * SEC);
        expect(reminderMails()).toHaveLength(1);
    });

    it("accept 7: changing a reminder's time re-arms its timer; deleting it clears the timer", async () => {
        const clock = new ManualClock(Date.now());
        const owner = await createTestUser();
        const { s, advance } = await startQuiet(clock);
        const first = new Date(clock.now() + 2 * HOUR);
        const made = await request(app).post('/api/todos').set('Cookie', authCookie(owner)).send({ title: 'Book the flight', reminderDate: first.toISOString() });
        expect(made.status).toBe(201);
        await advance(2 * SEC);
        expect(s.nextAt('reminders')?.getTime()).toBe(first.getTime());

        const moved = new Date(clock.now() + 5 * HOUR);
        expect((await request(app).patch(`/api/todos/${made.body.data._id}`).set('Cookie', authCookie(owner)).send({ reminderDate: moved.toISOString() })).status).toBe(200);
        await advance(2 * SEC);
        expect(s.nextAt('reminders')?.getTime()).toBe(moved.getTime());

        expect((await request(app).delete(`/api/todos/${made.body.data._id}`).set('Cookie', authCookie(owner))).status).toBe(200);
        await advance(2 * SEC);
        expect(s.nextAt('reminders')).toBeNull();
    });

    it('accept 10: a row written straight into the database (no poke) is sent at the next sweep', async () => {
        const clock = new ManualClock(Date.now());
        const owner = await createTestUser();
        const { s, advance } = await startQuiet(clock);
        const todo = await todoFor(owner.id, 'Written by hand');
        await prisma.reminder.create({ data: { userId: owner.id, todoId: todo.id, reminderDate: new Date(clock.now() - MIN), message: 'Reminder: Written by hand', type: 'todo' } });
        await advance(3 * HOUR - MIN);
        expect(reminderMails()).toHaveLength(0);
        expect(s.nextSweepAt()?.getTime()).toBeLessThanOrEqual(clock.now() + MIN);
        await advance(MIN);
        expect(reminderMails()).toHaveLength(1);
    });
});

describe('the quiet scheduler: idle', () => {
    it('accept 2: six idle hours with nothing due: the database is asked only at the sweeps', async () => {
        const clock = new ManualClock(Date.now());
        const owner = await createTestUser();
        const todo = await todoFor(owner.id, 'Far ahead');
        await createTodoReminder({ userId: owner.id, todoId: todo.id, reminderDate: new Date(clock.now() + 10 * HOUR), title: todo.title });
        const { s, advance } = await startQuiet(clock);
        expect(s.nextAt('reminders')?.getTime()).toBe(clock.now() + 10 * HOUR); // a timer waiting, re-armed hourly with no query

        const t0 = clock.now();
        const queriedAt: number[] = [];
        const original = pg.Client.prototype.query;
        pg.Client.prototype.query = function counted(this: pg.Client, ...args: unknown[]) {
            queriedAt.push(clock.now());
            return (original as (...a: unknown[]) => unknown).apply(this, args);
        } as typeof original;
        try {
            await advance(6 * HOUR);
        } finally {
            pg.Client.prototype.query = original;
        }
        const moments = [...new Set(queriedAt.map((t) => (t - t0) / HOUR))];
        expect(moments).toEqual([3, 6]);
        expect(reminderMails()).toHaveLength(0);
    });
});

describe('the quiet scheduler: the buddy and the day', () => {
    const fake = new FakeClaude();
    beforeAll(() => {
        process.env.CLAUDE_API_KEY = 'test-key-not-real';
        setAiClientForTests(fake);
    });
    afterAll(() => {
        process.env.CLAUDE_API_KEY = '';
        setAiClientForTests(null);
    });
    beforeEach(async () => {
        fake.reset();
        await prisma.buddyChunk.deleteMany({});
    });

    it('accept 9: words posted while the AI is down are digested within 15 minutes of it returning', async () => {
        const clock = new ManualClock(Date.now());
        const user = await createTestUser();
        await api(user).patch('/api/buddy/settings', { enabled: true });
        // The queue alone: the buddy's night would otherwise run at the start and take the fake's answers.
        const { advance } = await startQuiet(clock, quietJobs().filter((j) => j.name === 'capture'));
        fake.push(new Error('The AI is overloaded, try again'), new Error('The AI is overloaded, try again'), fakeMessage({ labels: [{ i: 1, label: 'none' }] }));
        await queueWords(user.id, { sessionKey: 'cc_quiet', seq: 1, project: 'second_brain', messages: [{ at: new Date(clock.now()).toISOString(), text: 'run the tests again' }] });
        await advance(2 * MIN); // down: the first two tries (at 5 s and about a minute later) fail
        expect(fake.calls).toHaveLength(2);
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(1);
        const back = clock.now(); // the AI answers from here on
        await advance(15 * MIN);
        expect(fake.calls).toHaveLength(3);
        expect(await prisma.buddyChunk.count({ where: { userId: user.id } })).toBe(0);
        expect(back).toBeGreaterThan(0);
    });

    it('accept 8: the rollover, the morning email, the night and a pulse each run once on the right local day, across a time-zone change', async () => {
        // Tue 17 Nov, 23:30 in India: that day's rollover, email and night are done.
        const clock = new ManualClock(Date.UTC(2026, 10, 17, 18, 0));
        const email = `quiet-day-${Date.now()}@example.org`; // a test domain gets no morning email
        const user = await createLearner('Asia/Kolkata', { email, reminderEmail: email, nudgeTime: '08:30', learningRolledOverDay: d('2026-11-17'), lastNudgeDay: d('2026-11-17') });
        await prisma.buddyState.updateMany({ data: { enabled: false } }); // earlier tests' buddies stay quiet
        const subject = await createSubjectRow(user.id);
        const { topic } = await createTopicRow(user.id, subject.id);
        await createChainRows(user.id, { topicId: topic.id }, '2026-11-14');
        await api(user).patch('/api/buddy/settings', { enabled: true });
        await prisma.buddyState.update({ where: { userId: user.id }, data: { lastNightDay: d('2026-11-17') } });
        const night = {
            memory: [], who: '', heading: '', now: 'Building the quiet scheduler.',
            lines: [{ slot: 'morning', text: 'Reviews first, then the scheduler', form: 'push', lockOk: true, sourceId: '' }],
            note: '', followUp: '', suggestions: [], notebook: '', insight: '',
            weekly: { use: false, strong: '', slipping: '', fix: '', deadline: '', focus: [] },
        };
        // Since stage 3 (ECOSYSTEM_V2_PLAN §4.8) every line is lock-checked, so each step is followed by its check.
        const lock = () => fakeMessage({ lines: ['morning', 'afternoon', 'evening'].map((slot) => ({ slot, reveals: false })), note: false, insight: false }, { model: 'claude-sonnet-5-5' });
        fake.push(
            fakeMessage(night),
            lock(),
            fakeMessage({ lines: [{ slot: 'afternoon', text: 'The mock moved: one problem after lunch', form: 'push', lockOk: true, sourceId: '' }], note: '' }, { model: 'claude-sonnet-5-5' }),
            lock(),
            fakeMessage(night),
            lock(),
        );
        const jobs = quietJobs().filter((j) => j.name === 'rollover' || j.name === 'nudge' || j.name === 'buddy');
        const { advance } = await startQuiet(clock, jobs);
        const at = (iso: string) => Date.parse(iso) - clock.now();
        const state = async () => {
            const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { learningRolledOverDay: true, lastNudgeDay: true } });
            const steps = await prisma.buddyDay.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' }, select: { kind: true, day: true } });
            return {
                rolled: u.learningRolledOverDay?.toISOString().slice(0, 10),
                nudged: u.lastNudgeDay?.toISOString().slice(0, 10),
                emails: mailsTo(email).length,
                steps: steps.map((s) => `${s.kind} ${s.day.toISOString().slice(0, 10)}`),
            };
        };

        await advance(at('2026-11-18T04:30:00Z')); // 10:00 in India
        expect(await state()).toEqual({ rolled: '2026-11-18', nudged: '2026-11-18', emails: 1, steps: ['night 2026-11-18'] });
        // Something new at 10:00: the pulse waits for 12:00 his time.
        await prisma.observation.create({ data: { userId: user.id, text: 'The mock interview moved to Friday', kind: 'thread', source: 'tell', day: d('2026-11-18'), createdAt: new Date(clock.now()) } });
        await advance(at('2026-11-18T06:29:00Z'));
        expect((await state()).steps).toEqual(['night 2026-11-18']);
        await advance(at('2026-11-18T07:00:00Z'));
        expect((await state()).steps).toEqual(['night 2026-11-18', 'pulse 2026-11-18']);

        // He moves to New York (02:00 there, still Wed 18 Nov): the next ones follow his new day.
        expect((await api(user).patch('/api/learning/settings', { timezone: 'America/New_York' })).status).toBe(200);
        await advance(at('2026-11-19T14:00:00Z')); // 09:00 Thu 19 Nov in New York
        expect(await state()).toEqual({ rolled: '2026-11-19', nudged: '2026-11-19', emails: 2, steps: ['night 2026-11-18', 'pulse 2026-11-18', 'night 2026-11-19'] });
        // Two nights and one pulse (no second pulse: nothing new after the first); the pulse's line needs no check here.
        expect(fake.calls.filter((c) => c.output_config?.format?.schema !== LOCK_SCHEMA)).toHaveLength(3);
    });
});
