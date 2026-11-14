// The reminder cron: processDueReminders() (one tick) and startCronScheduler() wiring.
// Email is the nodemailer mock (tests/helpers/mail.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-cron', () => {
    const schedule = vi.fn();
    return { default: { schedule }, schedule };
});

import cron from 'node-cron';
import { prisma } from '../../src/db/prisma';
import { claimReminder, createTodoReminder, processDueReminders, STALE_PROCESSING_MS } from '../../src/services/reminders/reminders.service';
import { startCronScheduler } from '../../src/services/cronScheduler';
import { mailsTo, setMailFailure } from '../helpers/mail';
import { createTestUser } from '../helpers/auth';

const past = () => new Date(Date.now() - 60_000);

beforeEach(async () => {
    // processDueReminders works on every due reminder: start each test from none.
    await prisma.reminder.deleteMany();
    setMailFailure(false);
});

describe('processDueReminders', () => {
    it('emails the owner of a personal todo without assignees and marks the reminder sent', async () => {
        const owner = await createTestUser({ name: 'Owner Olive' });
        const todo = await prisma.todo.create({ data: { userId: owner.id, title: 'Renew passport', priority: 'high', description: 'Bring photos' } });
        const reminder = await createTodoReminder({ userId: owner.id, todoId: todo.id, reminderDate: past(), title: todo.title });
        expect(reminder).toMatchObject({ message: 'Reminder: Renew passport', status: 'pending', emailSent: false, type: 'todo' });

        const result = await processDueReminders(new Date());
        expect(result).toEqual({ due: 1, sent: 1, failed: 0, skipped: 0 });

        const mails = mailsTo(owner.email);
        expect(mails).toHaveLength(1);
        expect(mails[0]!.subject).toBe('Task Due: Renew passport');
        expect(mails[0]!.html).toContain('Hi Owner Olive');
        expect(mails[0]!.html).toContain('High priority');
        expect(await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } })).toMatchObject({ status: 'sent', emailSent: true });

        // Nothing left to do on the next tick.
        expect(await processDueReminders(new Date())).toEqual({ due: 0, sent: 0, failed: 0, skipped: 0 });
        expect(mailsTo(owner.email)).toHaveLength(1);
    });

    it('emails every assignee instead of the owner', async () => {
        const owner = await createTestUser();
        const a = await createTestUser();
        const b = await createTestUser();
        const todo = await prisma.todo.create({ data: { userId: owner.id, title: 'Team chore', visibility: 'shared' } });
        await prisma.todoAssignee.createMany({ data: [{ todoId: todo.id, userId: a.id }, { todoId: todo.id, userId: b.id }] });
        await createTodoReminder({ userId: owner.id, todoId: todo.id, reminderDate: past(), title: todo.title });

        await processDueReminders(new Date());
        expect(mailsTo(a.email)).toHaveLength(1);
        expect(mailsTo(b.email)).toHaveLength(1);
        expect(mailsTo(owner.email)).toHaveLength(0);
    });

    it('uses the workspace template (with the workspace name) for a workspace todo created by another module', async () => {
        const owner = await createTestUser();
        const ws = await prisma.workspace.create({ data: { name: 'Rocket Team', ownerId: owner.id } });
        const todo = await prisma.todo.create({ data: { userId: owner.id, title: 'Launch checklist', visibility: 'workspace', workspaceId: ws.id } });
        // A reminder row as the workspace todo module writes it.
        const reminder = await prisma.reminder.create({ data: { userId: owner.id, todoId: todo.id, reminderDate: past(), message: 'Reminder: Launch checklist' } });

        await processDueReminders(new Date());
        const mails = mailsTo(owner.email);
        expect(mails).toHaveLength(1);
        expect(mails[0]!.html).toContain('Rocket Team workspace');
        expect(await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } })).toMatchObject({ status: 'sent', emailSent: true });
    });

    it('leaves future, sent, failed and freshly claimed reminders alone; resets stale processing ones', async () => {
        const owner = await createTestUser();
        const todo = await prisma.todo.create({ data: { userId: owner.id, title: 'Mixed bag' } });
        const base = { userId: owner.id, todoId: todo.id, message: 'Reminder: Mixed bag' };
        const future = await prisma.reminder.create({ data: { ...base, reminderDate: new Date(Date.now() + 3_600_000) } });
        const sent = await prisma.reminder.create({ data: { ...base, reminderDate: past(), status: 'sent', emailSent: true } });
        const failed = await prisma.reminder.create({ data: { ...base, reminderDate: past(), status: 'failed' } });
        const fresh = await prisma.reminder.create({ data: { ...base, reminderDate: past(), status: 'processing' } });
        const stale = await prisma.reminder.create({
            data: { ...base, reminderDate: past(), status: 'processing', updatedAt: new Date(Date.now() - STALE_PROCESSING_MS - 60_000) },
        });

        const result = await processDueReminders(new Date());
        expect(result).toEqual({ due: 1, sent: 1, failed: 0, skipped: 0 });

        const byId = new Map((await prisma.reminder.findMany()).map((r) => [r.id, r]));
        expect(byId.get(future.id)).toMatchObject({ status: 'pending', emailSent: false });
        expect(byId.get(sent.id)).toMatchObject({ status: 'sent' });
        expect(byId.get(failed.id)).toMatchObject({ status: 'failed' });
        expect(byId.get(fresh.id)).toMatchObject({ status: 'processing' });
        expect(byId.get(stale.id)).toMatchObject({ status: 'sent', emailSent: true });
    });

    it("marks the reminder failed when no email could be sent, or when sending throws", async () => {
        const owner = await createTestUser();
        const todo = await prisma.todo.create({ data: { userId: owner.id, title: 'Unlucky' } });
        const reminder = await createTodoReminder({ userId: owner.id, todoId: todo.id, reminderDate: past(), title: todo.title });

        setMailFailure(true);
        expect(await processDueReminders(new Date())).toEqual({ due: 1, sent: 0, failed: 1, skipped: 0 });
        expect(await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } })).toMatchObject({ status: 'failed', emailSent: false });

        setMailFailure(false);
        const second = await createTodoReminder({ userId: owner.id, todoId: todo.id, reminderDate: past(), title: todo.title });
        const throwing = {
            personal: async () => {
                throw new Error('template exploded');
            },
            workspace: async () => true,
        };
        expect(await processDueReminders(new Date(), throwing)).toMatchObject({ failed: 1 });
        expect((await prisma.reminder.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('failed');
    });

    it('claimReminder is atomic: only one caller wins', async () => {
        const owner = await createTestUser();
        const todo = await prisma.todo.create({ data: { userId: owner.id, title: 'Race' } });
        const reminder = await createTodoReminder({ userId: owner.id, todoId: todo.id, reminderDate: past(), title: todo.title });

        const results = await Promise.all([claimReminder(reminder.id), claimReminder(reminder.id), claimReminder(reminder.id)]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await prisma.reminder.findUniqueOrThrow({ where: { id: reminder.id } })).status).toBe('processing');
    });

    it('a deleted todo takes its reminders with it (cascade), so nothing is sent', async () => {
        const owner = await createTestUser();
        const todo = await prisma.todo.create({ data: { userId: owner.id, title: 'Gone' } });
        await createTodoReminder({ userId: owner.id, todoId: todo.id, reminderDate: past(), title: todo.title });
        await prisma.todo.delete({ where: { id: todo.id } });

        expect(await processDueReminders(new Date())).toEqual({ due: 0, sent: 0, failed: 0, skipped: 0 });
        expect(mailsTo(owner.email)).toHaveLength(0);
    });
});

describe('startCronScheduler', () => {
    it('schedules processDueReminders every minute', async () => {
        const schedule = vi.mocked(cron.schedule);
        schedule.mockClear();
        startCronScheduler();

        expect(schedule).toHaveBeenCalledTimes(1);
        const [expression, task] = schedule.mock.calls[0]!;
        expect(expression).toBe('* * * * *');

        // One tick through the scheduled callback sends a due reminder.
        const owner = await createTestUser();
        const todo = await prisma.todo.create({ data: { userId: owner.id, title: 'Via cron' } });
        await createTodoReminder({ userId: owner.id, todoId: todo.id, reminderDate: past(), title: todo.title });
        await (task as unknown as () => Promise<void>)();
        expect(mailsTo(owner.email)).toHaveLength(1);
    });
});
