// Stage 7 of ECOSYSTEM_V2_PLAN (mouths), the server's part: silent and ringing reminders (the chat and agents set
// silent ones unless he says alarm or ring: no email, no phone alarm, on the home picture until 2 hours past their
// time), repeats (the next of a series is made when one passes, once; cancelling ends the series; a done task
// too), and his own words pinned to the lock screen for a window (his pin wins over the buddy's words in it).
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/db/prisma';
import { createTodoReminder, findDueReminderIds, firstOccurrence, nextOccurrence, normalizeRepeat, processDueReminders, rollRepeats } from '../../src/services/reminders/reminders.service';
import { getAmbient, homeReminders, todayReminders, upcomingAlarms } from '../../src/services/ambient/ambient.service';
import { loadLearningContext } from '../../src/services/learningDb/common';
import { activePin, pinShowsNow } from '../../src/services/reminders/lockPins.service';
import { createTestUser } from '../helpers/auth';
import { asAgent, createTestToken } from '../helpers/agent';
import { api } from '../helpers/learning';
import { dayOf } from '../../src/services/learning';
import { mailsTo } from '../helpers/mail';

beforeEach(async () => {
    // The cron works on every due reminder: each test starts from none.
    await prisma.reminder.deleteMany();
});

/** His clock (Kolkata). */
const at = (iso: string) => new Date(`${iso}+05:30`);
const TZ = 'Asia/Kolkata';

describe('silent and ringing reminders', () => {
    it('an agent’s reminder is silent unless it asks to ring: no email, no phone alarm, on the home picture until 2 hours past its time', async () => {
        const user = await createTestUser();
        const agent = asAgent((await createTestToken(user)).token);
        const soon = new Date(Date.now() + 30 * 60_000);
        const later = new Date(Date.now() + 40 * 60_000);
        const silent = (await agent.post('/api/reminders', { title: 'Stretch', at: soon.toISOString() })).body.data;
        const ringing = (await agent.post('/api/reminders', { title: 'Catch the train', at: later.toISOString(), ring: true })).body.data;
        expect(silent).toMatchObject({ ring: false, repeat: null });
        expect(ringing).toMatchObject({ ring: true });
        expect((await agent.get('/api/reminders')).body.data.map((r: { task: string; ring: boolean }) => [r.task, r.ring])).toEqual([
            ['Stretch', false],
            ['Catch the train', true],
        ]);
        // The phone rings only the ringing one; the home picture lists both.
        expect((await upcomingAlarms(user.id, new Date())).map((a) => a.text)).toEqual(['Catch the train']);
        const tz = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).timezone || 'UTC';
        const today = dayOf(new Date(), tz);
        expect((await todayReminders(user.id, new Date(), tz)).map((r) => r.text)).toEqual([[soon, 'Stretch'], [later, 'Catch the train']].filter(([d]) => dayOf(d as Date, tz) === today).map(([, t]) => t)); // both, while still today
        // Past their time: the email goes only for the ringing one; the silent one stays on the picture 2 hours.
        const after = new Date(Date.now() + 45 * 60_000);
        expect(await findDueReminderIds(after)).toEqual([ringing._id]);
        await processDueReminders(after);
        expect(mailsTo(user.email).map((m) => m.subject)).toEqual(['Task Due: Catch the train']);
        expect((await prisma.reminder.findUniqueOrThrow({ where: { id: silent._id } })).status).toBe('sent');
        // (Real clock: past midnight in his zone the silent one belongs to yesterday and leaves the picture: 11-19, a run after 22:00 IST.)
        const at90 = new Date(soon.getTime() + 90 * 60_000);
        if (dayOf(at90, tz) === dayOf(soon, tz)) expect((await todayReminders(user.id, at90, tz)).map((r) => r.text)).toContain('Stretch');
        expect((await todayReminders(user.id, new Date(soon.getTime() + 125 * 60_000), tz)).map((r) => r.text)).not.toContain('Stretch');
    });

    it('the web’s view (Home): today’s reminders by the home picture’s rule, with how each rings, its repeat and whose it is; the picture keeps three', async () => {
        const user = await createTestUser();
        // 08:00 UTC: the same day in his zone, whichever it is (10:30 to 16:00 in Kolkata).
        const now = new Date('2026-12-01T08:00:00Z');
        const min = (m: number) => new Date(now.getTime() + m * 60_000);
        const remind = async (title: string, m: number, over: { silent?: boolean; repeat?: 'daily'; status?: 'complete' } = {}) => {
            const todo = await prisma.todo.create({ data: { userId: user.id, title, ...(over.status ? { status: over.status } : {}) } });
            return createTodoReminder({ userId: user.id, todoId: todo.id, reminderDate: min(m), title, ...(over.silent ? { silent: true } : {}), ...(over.repeat ? { repeat: over.repeat } : {}) });
        };
        const stretch = await remind('Stretch', -60, { silent: true }); // silent, an hour past: still shows
        await remind('Too long ago', -180, { silent: true }); // silent, three hours past: gone
        await remind('Rang already', -30); // a ringing one past its time: gone
        const train = await remind('Catch the train', 60); // rings
        const plants = await remind('Water the plants', 120, { silent: true, repeat: 'daily' });
        await remind('Tomorrow’s', 26 * 60, { silent: true });
        await remind('Done already', 90, { status: 'complete' });
        await prisma.buddyState.create({ data: { userId: user.id, enabled: true, name: 'Juno' } });
        const guitar = await prisma.buddyReminder.create({ data: { userId: user.id, text: 'Guitar after dinner', at: min(150) } });

        const { tz } = await loadLearningContext(user.id, now);
        const time = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
        const home = await homeReminders(user.id, now);
        expect(home.name).toBe('Juno');
        expect(home.items).toEqual([
            { _id: stretch.id, at: min(-60).toISOString(), time: time(min(-60)), text: 'Stretch', ring: false, repeat: null, past: true, by: 'you', taskId: stretch.todoId },
            { _id: train.id, at: min(60).toISOString(), time: time(min(60)), text: 'Catch the train', ring: true, repeat: null, past: false, by: 'you', taskId: train.todoId },
            { _id: plants.id, at: min(120).toISOString(), time: time(min(120)), text: 'Water the plants', ring: false, repeat: 'daily', past: false, by: 'you', taskId: plants.todoId },
            { _id: guitar.id, at: min(150).toISOString(), time: time(min(150)), text: 'Guitar after dinner', ring: false, repeat: null, past: false, by: 'buddy', taskId: null },
        ]);
        // The home picture keeps its three, by the same rule.
        expect((await todayReminders(user.id, now, tz)).map((r) => r.text)).toEqual(['Stretch', 'Catch the train', 'Water the plants']);
        // The app's Home reads it; an agent's token may not (it is not on the token list).
        expect((await api(user).get('/api/reminders/today')).body.data).toMatchObject({ name: 'Juno', items: expect.any(Array) });
        expect((await asAgent((await createTestToken(user)).token).get('/api/reminders/today')).status).toBe(403);
    });
});

describe('the same reminder twice (the week’s simulation, 11-18)', () => {
    it('one reminder per minute and meaning: asked again it is brought up to date (a ring wins, a repeat stays), never a second task', async () => {
        const user = await createTestUser();
        const agent = asAgent((await createTestToken(user)).token);
        const six30 = new Date(Date.now() + 26 * 3600_000);
        six30.setUTCSeconds(0, 0);
        const weekly = (await agent.post('/api/reminders', { title: 'Run (3k, easy pace)', at: six30.toISOString(), repeat: 'weekly' })).body.data;
        const alarm = (await agent.post('/api/reminders', { title: 'Run', at: six30.toISOString(), ring: true })).body.data;
        const again = (await agent.post('/api/reminders', { title: 'Run', at: six30.toISOString(), ring: true })).body.data;
        expect(alarm._id).toBe(weekly._id);
        expect(again._id).toBe(weekly._id);
        expect(again).toMatchObject({ ring: true, repeat: 'weekly', createdTask: false });
        expect(await prisma.reminder.count({ where: { userId: user.id, status: 'pending' } })).toBe(1);
        expect(await prisma.todo.count({ where: { userId: user.id } })).toBe(1);
        // Something else at the same minute is its own reminder.
        const mum = (await agent.post('/api/reminders', { title: 'Call mum', at: six30.toISOString() })).body.data;
        const bank = (await agent.post('/api/reminders', { title: 'Call the bank', at: six30.toISOString() })).body.data;
        expect(new Set([weekly._id, mum._id, bank._id]).size).toBe(3);
    });
});

describe('repeats', () => {
    it('the next time of a series: every day, every weekday (over a weekend), every week; same clock time', () => {
        const fri = at('2026-11-20T17:30:00');
        expect(nextOccurrence(fri, 'daily', TZ, fri).toISOString()).toBe(at('2026-11-21T17:30:00').toISOString());
        expect(nextOccurrence(fri, 'weekdays', TZ, fri).toISOString()).toBe(at('2026-11-23T17:30:00').toISOString());
        expect(nextOccurrence(fri, 'weekly', TZ, fri).toISOString()).toBe(at('2026-11-27T17:30:00').toISOString());
        // A server that was off for days: the first time after now.
        expect(nextOccurrence(fri, 'daily', TZ, at('2026-11-23T09:00:00')).toISOString()).toBe(at('2026-11-23T17:30:00').toISOString());
        // Chosen days (issue 15): Friday's next is Monday, Monday's next is Wednesday.
        expect(nextOccurrence(fri, 'mo,we,fr', TZ, fri).toISOString()).toBe(at('2026-11-23T17:30:00').toISOString());
        expect(nextOccurrence(at('2026-11-23T06:30:00'), 'mo,we,fr', TZ, at('2026-11-23T06:30:00')).toISOString()).toBe(at('2026-11-25T06:30:00').toISOString());
    });

    it('chosen days as asked, in their stored form; a series starts on its first day', () => {
        expect(normalizeRepeat('mon, wed and fri')).toBe('mo,we,fr');
        expect(normalizeRepeat('FR,MO,WE')).toBe('mo,we,fr');
        expect(normalizeRepeat('Monday Tuesday Wednesday Thursday Friday')).toBe('weekdays');
        expect(normalizeRepeat('sat sun mon tue wed thu fri')).toBe('daily');
        expect(normalizeRepeat('weekly')).toBe('weekly');
        expect(normalizeRepeat('every other day')).toBeNull();
        expect(normalizeRepeat('')).toBeNull();
        // Asked on a Saturday: a weekday series starts on Monday, a Mon/Wed/Fri one too; one on its day stays.
        const sat = at('2026-11-21T09:30:00');
        expect(firstOccurrence(sat, 'weekdays', TZ).toISOString()).toBe(at('2026-11-23T09:30:00').toISOString());
        expect(firstOccurrence(sat, 'mo,we,fr', TZ).toISOString()).toBe(at('2026-11-23T09:30:00').toISOString());
        expect(firstOccurrence(sat, 'sa,su', TZ).toISOString()).toBe(sat.toISOString());
        expect(firstOccurrence(sat, 'weekly', TZ).toISOString()).toBe(sat.toISOString());
    });

    it('runs on Monday, Wednesday and Friday at the same time are one series on one task; Undo takes the day back out', async () => {
        const user = await createTestUser();
        const agent = asAgent((await createTestToken(user)).token);
        // The next Monday, Wednesday and Friday at 06:30 his time (a week or more ahead, so none has passed).
        const ahead = (weekday: number) => {
            const d = new Date(Date.now() + 5.5 * 3600_000 + 7 * 86_400_000);
            while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1);
            return `${d.toISOString().slice(0, 10)}T06:30`;
        };
        const mon = (await agent.post('/api/reminders', { title: 'Run (3k, easy pace)', at: ahead(1), repeat: 'weekly' })).body.data;
        const wed = (await agent.post('/api/reminders', { title: 'Run (3k, easy pace)', at: ahead(3), repeat: 'weekly' })).body.data;
        const fri = (await agent.post('/api/reminders', { title: 'Run 3k', at: ahead(5), repeat: 'weekly' })).body.data;
        expect(wed._id).toBe(mon._id);
        expect(fri._id).toBe(mon._id);
        expect(fri).toMatchObject({ repeat: 'mo,we,fr', createdTask: false });
        expect(await prisma.reminder.count({ where: { userId: user.id, status: 'pending' } })).toBe(1);
        expect(await prisma.todo.count({ where: { userId: user.id } })).toBe(1);
        // Its next time is the soonest of its days.
        const row = await prisma.reminder.findUniqueOrThrow({ where: { id: mon._id } });
        const soonest = [ahead(1), ahead(3), ahead(5)].map((s) => new Date(`${s}:00+05:30`).getTime()).sort((a, b) => a - b)[0]!;
        expect(row.reminderDate.getTime()).toBe(soonest);
        // Another time or another thing is its own series.
        const seven = (await agent.post('/api/reminders', { title: 'Run (3k, easy pace)', at: ahead(2).replace('06:30', '07:00'), repeat: 'weekly' })).body.data;
        const bank = (await agent.post('/api/reminders', { title: 'Call the bank', at: ahead(2), repeat: 'weekly' })).body.data;
        expect(new Set([mon._id, seven._id, bank._id]).size).toBe(3);
        // Undo of the Friday set puts the series back to Monday and Wednesday (it is not cancelled).
        const fridayEdit = await prisma.agentEdit.findFirstOrThrow({ where: { userId: user.id, kind: 'reminder_set', entityId: mon._id }, orderBy: { createdAt: 'desc' } });
        expect((await api(user).post(`/api/agent/edits/${fridayEdit.id}/undo`)).status).toBe(200);
        const back = await prisma.reminder.findUniqueOrThrow({ where: { id: mon._id } });
        expect(back).toMatchObject({ status: 'pending', repeat: 'mo,we' });
        // Chosen days in one ask work too, and a wrong one is refused.
        expect((await agent.post('/api/reminders', { title: 'Swim', at: ahead(2), repeat: 'tue, thu' })).body.data).toMatchObject({ repeat: 'tu,th' });
        expect((await agent.post('/api/reminders', { title: 'Swim', at: ahead(2), repeat: 'fortnightly' })).status).toBe(400);
        // A weekly one needs its first day (issue 14: a bare "06:30" landed Monday's run on a Tuesday). The refusal never
        // names ring or repeat: the MCP reads a 400 naming them as an older server and would drop both.
        const bare = await agent.post('/api/reminders', { title: 'Swim', at: '06:30', repeat: 'weekly' });
        expect(bare.status).toBe(400);
        expect(JSON.stringify(bare.body)).toContain('needs its first day');
        expect(JSON.stringify(bare.body)).not.toMatch(/\b(ring|repeat)\b/);
    });

    it('set again after a cancel, or for another time: the reminder goes on the task made for the first (one task)', async () => {
        const user = await createTestUser();
        const agent = asAgent((await createTestToken(user)).token);
        const soon = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
        const first = (await agent.post('/api/reminders', { title: 'Run (3k, easy pace)', at: soon(20) })).body.data;
        expect(first.createdTask).toBe(true);
        expect((await agent.post(`/api/reminders/${first._id}/cancel`)).status).toBe(200);
        const again = (await agent.post('/api/reminders', { title: 'Run 3k', at: soon(44), ring: true })).body.data;
        expect(again).toMatchObject({ taskId: first.taskId, createdTask: false });
        // A task he made himself is never taken over; nor is a done one.
        const own = (await api(user).post('/api/tasks', { title: 'Call the bank' })).body.data;
        const bank = (await agent.post('/api/reminders', { title: 'Call the bank', at: soon(30) })).body.data;
        expect(bank.taskId).not.toBe(own._id);
        await prisma.todo.update({ where: { id: first.taskId }, data: { status: 'complete', completedAt: new Date() } });
        expect((await agent.post('/api/reminders', { title: 'Run 3k', at: soon(68) })).body.data.createdTask).toBe(true);
    });

    it('when one passes the next is made once, silent as it was; cancelling the next ends the series; a done task with its own day ends it too', async () => {
        const user = await createTestUser();
        const agent = asAgent((await createTestToken(user)).token);
        // A weekday series asked for on a weekend starts on Monday (issue 15): on a weekend this test uses a daily one.
        const today = new Date(Date.now() + 5.5 * 3600_000 + 60_000).getUTCDay();
        const repeat = today === 0 || today === 6 ? 'daily' : 'weekdays';
        const first = (await agent.post('/api/reminders', { title: 'Stand up and stretch', at: new Date(Date.now() + 60_000).toISOString(), repeat })).body.data;
        expect(first).toMatchObject({ ring: false, repeat });
        const row = await prisma.reminder.findUniqueOrThrow({ where: { id: first._id } });
        expect(row.seriesId).toBe(row.id);
        const passed = new Date(Date.now() + 2 * 60_000);
        await processDueReminders(passed);
        const series = await prisma.reminder.findMany({ where: { seriesId: row.id }, orderBy: { reminderDate: 'asc' } });
        expect(series).toHaveLength(2);
        expect(series[1]).toMatchObject({ silent: true, repeat, status: 'pending', todoId: row.todoId });
        expect(series[1]!.reminderDate.getTime()).toBeGreaterThan(passed.getTime());
        if (repeat === 'weekdays') expect([1, 2, 3, 4, 5]).toContain(new Date(series[1]!.reminderDate.getTime() + 5.5 * 3600_000).getUTCDay());
        expect(await rollRepeats(passed)).toBe(0); // once
        // Cancelling the next one ends the series.
        expect((await agent.post(`/api/reminders/${series[1]!.id}/cancel`)).status).toBe(200);
        expect(await rollRepeats(new Date(series[1]!.reminderDate.getTime() + 60_000))).toBe(0);
        expect(await prisma.reminder.count({ where: { seriesId: row.id } })).toBe(2);

        // A task with a day of its own (a deadline a daily reminder points at) that is done ends its series.
        const report = (await api(user).post('/api/tasks', { title: 'Finish the annual report', due: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) })).body.data;
        await agent.post('/api/reminders', { taskId: report._id, at: new Date(Date.now() + 60_000).toISOString(), repeat: 'daily' });
        await prisma.todo.update({ where: { id: report._id }, data: { status: 'complete', completedAt: new Date() } });
        expect(await rollRepeats(new Date(Date.now() + 2 * 60_000))).toBe(0);
    });

    it('a habit ticked done comes back for its next time; its day moves on with it, ticked or not (his call, 11-18)', async () => {
        const user = await createTestUser();
        const agent = asAgent((await createTestToken(user)).token);
        // Made by a reminder (the chat's way): the task is due at the reminder's own time, so its day follows the series.
        const daily = (await agent.post('/api/reminders', { title: 'Water the plants', at: new Date(Date.now() + 60_000).toISOString(), repeat: 'daily', ring: true })).body.data;
        await prisma.todo.update({ where: { id: daily.taskId }, data: { status: 'complete', completedAt: new Date() } });
        expect(await rollRepeats(new Date(Date.now() + 2 * 60_000))).toBe(1);
        const next = await prisma.reminder.findFirstOrThrow({ where: { todoId: daily.taskId, status: 'pending' }, orderBy: { reminderDate: 'desc' } });
        const task = await prisma.todo.findUniqueOrThrow({ where: { id: daily.taskId } });
        expect(task).toMatchObject({ status: 'pending', completedAt: null });
        expect(task.dueDate?.getTime()).toBe(next.reminderDate.getTime());
        expect(Math.abs(next.reminderDate.getTime() - new Date(daily.at).getTime() - 86_400_000)).toBeLessThan(60_000);
        // Not ticked: the next time still moves its day on, so a missed day never piles up as overdue.
        expect(await rollRepeats(new Date(next.reminderDate.getTime() + 60_000))).toBe(1);
        const after = await prisma.todo.findUniqueOrThrow({ where: { id: daily.taskId } });
        expect(after.dueDate!.getTime() - next.reminderDate.getTime()).toBe(86_400_000);
        // Only a cancel ends a habit's reminders.
        const pending = await prisma.reminder.findFirstOrThrow({ where: { todoId: daily.taskId, status: 'pending' }, orderBy: { reminderDate: 'desc' } });
        expect((await agent.post(`/api/reminders/${pending.id}/cancel`)).status).toBe(200);
        expect(await rollRepeats(new Date(pending.reminderDate.getTime() + 60_000))).toBe(0);
    });
});

describe('his words on the lock screen', () => {
    it('the window rule: its hours, its weekdays, a last day; a window across midnight belongs to the day it began', () => {
        const today = '2026-11-16'; // a Monday
        expect(pinShowsNow({ fromMin: 840, toMin: 1080, days: [], untilDay: today }, today, 900)).toBe(true);
        expect(pinShowsNow({ fromMin: 840, toMin: 1080, days: [], untilDay: today }, today, 1100)).toBe(false);
        expect(pinShowsNow({ fromMin: 840, toMin: 1080, days: [], untilDay: today }, '2026-11-17', 900)).toBe(false);
        expect(pinShowsNow({ fromMin: 540, toMin: 600, days: [1, 2, 3, 4, 5], untilDay: null }, today, 570)).toBe(true);
        expect(pinShowsNow({ fromMin: 540, toMin: 600, days: [1, 2, 3, 4, 5], untilDay: null }, '2026-11-21', 570)).toBe(false);
        expect(pinShowsNow({ fromMin: 1320, toMin: 120, days: [], untilDay: today }, today, 1380)).toBe(true);
        expect(pinShowsNow({ fromMin: 1320, toMin: 120, days: [], untilDay: today }, '2026-11-17', 60)).toBe(true);
        expect(pinShowsNow({ fromMin: 1320, toMin: 120, days: [], untilDay: today }, '2026-11-17', 180)).toBe(false);
        expect(pinShowsNow({ fromMin: 600, toMin: 0, days: [], untilDay: today }, today, 1430)).toBe(true);
    });

    it('a pin set by an agent is the lock line in its window, over the buddy’s line; it ends at its time; cleared, it goes; four at most', async () => {
        const user = await createTestUser();
        await api(user).patch('/api/buddy/settings', { enabled: true });
        const agent = asAgent((await createTestToken(user)).token, 'Claude Code');
        const now = new Date();
        const inTwoHours = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now.getTime() + 2 * 3600_000));
        const crossesMidnight = Number(inTwoHours.slice(0, 2)) < 2;
        const set = await agent.post('/api/lock-pins', { text: 'Ship the invoice fix', ...(crossesMidnight ? {} : { to: inTwoHours }) });
        expect(set.status).toBe(201);
        expect(set.body.data).toMatchObject({ text: 'Ship the invoice fix', setBy: 'agent', now: true });
        const pin = await activePin(user.id, now);
        expect(pin?.text).toBe('Ship the invoice fix');
        const a = await getAmbient(user.id, now, { app: '0.6.0' });
        expect(a.line).toMatchObject({ text: 'Ship the invoice fix', pinId: pin!.id, until: pin!.until });
        // Hidden titles: still his own words, set for the lock screen.
        expect((await getAmbient(user.id, now, { titles: false })).line?.text).toBe('Ship the invoice fix');
        expect((await agent.get('/api/lock-pins')).body.data.map((p: { text: string }) => p.text)).toEqual(['Ship the invoice fix']);
        // Cleared: gone.
        expect((await agent.post('/api/lock-pins/clear', {})).body.data).toEqual({ cleared: 1 });
        expect(await activePin(user.id, now)).toBeNull();
        expect((await getAmbient(user.id, now, { app: '0.6.0' })).line ?? null).toBeNull();
        // Four at most at once.
        for (const t of ['One', 'Two', 'Three', 'Four']) expect((await agent.post('/api/lock-pins', { text: t, from: '06:00', to: '07:00', days: 'weekdays' })).status).toBe(201);
        expect((await agent.post('/api/lock-pins', { text: 'Five', from: '06:00', to: '07:00', days: 'weekdays' })).status).toBe(400);
        expect((await agent.post('/api/lock-pins/clear', { all: true })).body.data).toEqual({ cleared: 4 });
    });
});
