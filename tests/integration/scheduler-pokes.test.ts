// Every writer of something due pokes the quiet scheduler (hosting P1-11: "a forgotten poke is a new
// kind of bug"; the guard is a test per writer). A recorder stands in for the scheduler; in poll
// mode and in the rest of the suite the pokes go nowhere.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../../src/app';
import { prisma } from '../../src/db/prisma';
import { setActiveScheduler, type JobName } from '../../src/services/scheduler/scheduler';
import { restoreReminder, unsetReminder } from '../../src/services/tasks/taskReminders.service';
import { markPhoneHeld } from '../../src/services/ambient/ambient.service';
import { queueWords } from '../../src/services/buddy/capture.service';
import { saveSubscription } from '../../src/services/push/push.service';
import { setMonthlyCap } from '../../src/services/claude/usage.service';
import { authCookie, createTestUser } from '../helpers/auth';
import { api } from '../helpers/learning';
import { createRoleFixture, createWorkspaceTodoRow } from '../helpers/workspaces';

let pokes: JobName[] = [];
beforeEach(() => {
    pokes = [];
    setActiveScheduler({ poke: (name) => void pokes.push(name) });
});
afterEach(() => setActiveScheduler(null));

const ahead = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const took = () => {
    const got = [...new Set(pokes)].sort();
    pokes = [];
    return got;
};

describe('the writers of reminders poke "reminders"', () => {
    it('a personal task: made with a reminder, its time changed, deleted', async () => {
        const me = await createTestUser();
        const made = await request(app).post('/api/todos').set('Cookie', authCookie(me)).send({ title: 'Book the flight', reminderDate: ahead(2) });
        expect(made.status).toBe(201);
        expect(took()).toEqual(['reminders']);
        expect((await request(app).patch(`/api/todos/${made.body.data._id}`).set('Cookie', authCookie(me)).send({ reminderDate: ahead(3) })).status).toBe(200);
        expect(took()).toEqual(['reminders']);
        expect((await request(app).patch(`/api/todos/${made.body.data._id}`).set('Cookie', authCookie(me)).send({ title: 'Book the flight today' })).status).toBe(200);
        expect(took()).toEqual([]); // its reminder untouched: nothing to re-read
        expect((await request(app).delete(`/api/todos/${made.body.data._id}`).set('Cookie', authCookie(me))).status).toBe(200);
        expect(took()).toEqual(['reminders']);
    });

    it('a workspace task: its reminder set, then the task deleted', async () => {
        const { workspace, owner, member } = await createRoleFixture();
        const todo = await createWorkspaceTodoRow(workspace, owner, { title: 'Remind me' });
        const patch = (body: object) => request(app).patch(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(member)).send(body);
        expect((await patch({ reminderDate: ahead(1) })).status).toBe(200);
        expect(took()).toEqual(['reminders']);
        expect((await request(app).delete(`/api/workspace-todos/${todo.id}`).set('Cookie', authCookie(owner))).status).toBe(200);
        expect(took()).toEqual(['reminders']);
    });

    it('set, cancel, the undo of each, and the phone that holds it', async () => {
        const me = await createTestUser();
        const set = await api(me).post('/api/reminders', { title: 'Call the bank', at: ahead(1) });
        expect(set.status).toBe(201);
        expect(took()).toEqual(['reminders']);
        const id = set.body.data._id;

        expect((await api(me).post(`/api/reminders/${id}/cancel`)).status).toBe(200);
        expect(took()).toEqual(['reminders']);
        await restoreReminder(me.id, id);
        expect(took()).toEqual(['reminders']);
        expect(await markPhoneHeld(me.id, [id])).toEqual({ held: 1 });
        expect(took()).toEqual(['reminders']);
        expect(await markPhoneHeld(me.id, ['not-a-reminder'])).toEqual({ held: 0 });
        expect(took()).toEqual([]);
        await unsetReminder(me.id, id, set.body.data.taskId);
        expect(took()).toEqual(['reminders']);
        expect(await prisma.reminder.count({ where: { id } })).toBe(0);
    });
});

describe('the writers of per-user times poke their jobs', () => {
    it('his time zone moves the rollover, the morning email and the buddy; the nudge time the email alone', async () => {
        const me = await createTestUser();
        expect((await api(me).patch('/api/learning/settings', { timezone: 'Europe/London' })).status).toBe(200);
        expect(took()).toEqual(['buddy', 'nudge', 'rollover']);
        expect((await api(me).patch('/api/learning/settings', { nudgeTime: '07:15' })).status).toBe(200);
        expect(took()).toEqual(['nudge']);
        expect((await api(me).patch('/api/learning/settings', { nudgeEmailEnabled: false })).status).toBe(200);
        expect(took()).toEqual(['nudge']);
        expect((await api(me).patch('/api/learning/settings', { dailyBudgetMin: 30 })).status).toBe(200);
        expect(took()).toEqual([]);
    });

    it("the buddy's settings and the account's AI cap poke the buddy and its queue", async () => {
        const me = await createTestUser();
        expect((await api(me).patch('/api/buddy/settings', { enabled: true })).status).toBe(200);
        expect(took()).toEqual(['buddy', 'capture']);
        await setMonthlyCap(me.id, 30); // (its route answers 503 here: the tests run with no AI key)
        expect(took()).toEqual(['buddy', 'capture']);
    });

    it('words queued poke the queue; a phone that subscribes pokes the morning notification', async () => {
        const me = await createTestUser();
        await api(me).patch('/api/buddy/settings', { enabled: true });
        took();
        expect((await queueWords(me.id, { sessionKey: 'cc_pokes', seq: 1, project: 'second_brain', messages: [{ at: new Date().toISOString(), text: 'remember to call the bank' }] })).queued).toBe(1);
        expect(took()).toEqual(['capture']);
        await saveSubscription(me.id, { endpoint: `https://fcm.googleapis.com/fcm/send/pokes-${Date.now()}`, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } });
        expect(took()).toEqual(['nudge']);
    });
});
