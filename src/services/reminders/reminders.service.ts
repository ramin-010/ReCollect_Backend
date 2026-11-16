// Todo reminders: the rows written by the todo endpoints and the cron that emails them.
//
// The cron (src/services/cronScheduler.ts) calls processDueReminders() every minute. Same steps as
// the Mongo version:
//   1. reset 'processing' reminders stuck for more than 5 minutes back to 'pending';
//   2. take up to 50 due reminders (pending, not emailed, reminderDate <= now);
//   3. claim each one atomically (pending → processing) so two instances never send it twice;
//   4. load reminder → user (name, email) and todo → assignees (name, email) [+ workspace name];
//   5. email every assignee, or the reminder's owner when the todo has none (the workspace template
//      for workspace todos, the personal one otherwise);
//   6. mark it 'sent' (emailSent = true) if at least one email went out, else 'failed'.
// 'processing' was missing from the Mongo enum; the Postgres enum has it.
import type { Prisma, Reminder } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { sendPersonalTaskReminderEmail } from '../../controllers/personalTasks/personalEmails';
import { sendWorkspaceTaskReminderEmail } from '../../controllers/workspace/workspaceEmails';
import { poke } from '../scheduler/scheduler';

export const REMINDER_BATCH_SIZE = 50;

/** REMINDER_EMAIL=off: no reminder emails at all (his phone rings for them; app 0.5.0). Default: an email for any reminder no phone holds. */
export const reminderEmailsOff = (): boolean => /^(off|0|false|no)$/i.test(process.env['REMINDER_EMAIL'] ?? '');
export const STALE_PROCESSING_MS = 5 * 60 * 1000;

/** The message stored with a todo reminder (unchanged). */
export function todoReminderMessage(title: string): string {
    return `Reminder: ${title.trim()}`;
}

export interface CreateTodoReminderInput {
    userId: string;
    todoId: string;
    reminderDate: Date;
    /** The todo title; the message becomes "Reminder: <title>". */
    title: string;
}

/**
 * A pending, not-yet-emailed todo reminder. Every writer of a reminder pokes the quiet scheduler
 * (hosting P1-11), which re-reads the next due one a moment later (after a caller's transaction).
 */
export async function createTodoReminder(input: CreateTodoReminderInput, db: DbClient = prisma): Promise<Reminder> {
    const row = await db.reminder.create({
        data: {
            userId: input.userId,
            type: 'todo',
            todoId: input.todoId,
            reminderDate: input.reminderDate,
            message: todoReminderMessage(input.title),
            emailSent: false,
            status: 'pending',
        },
    });
    poke('reminders');
    return row;
}

/** Delete every reminder of a todo (before replacing it, or when the todo is deleted). */
export async function deleteTodoReminders(todoId: string, db: DbClient = prisma) {
    const result = await db.reminder.deleteMany({ where: { todoId } });
    if (result.count > 0) poke('reminders');
    return result;
}

/**
 * The quiet scheduler's next moment for reminder emails (hosting P1-11): the earliest pending one
 * that needs an email (a phone that holds one rings it), or a stale claim's reset. None with
 * REMINDER_EMAIL=off (the sweep marks the past ones).
 */
export async function nextReminderDue(_now: Date = new Date(), db: DbClient = prisma): Promise<Date | null> {
    if (reminderEmailsOff()) return null;
    const pending = await db.reminder.findFirst({
        where: { status: 'pending', emailSent: false, phoneAt: null },
        orderBy: { reminderDate: 'asc' },
        select: { reminderDate: true },
    });
    const claimed = await db.reminder.findFirst({ where: { status: 'processing' }, orderBy: { updatedAt: 'asc' }, select: { updatedAt: true } });
    const times = [pending?.reminderDate.getTime(), claimed ? claimed.updatedAt.getTime() + STALE_PROCESSING_MS : undefined].filter((t): t is number => t !== undefined);
    return times.length ? new Date(Math.min(...times)) : null;
}

// ─── Cron ──────────────────────────────────────────────────────────────

// The old populate: user 'email name'; todoId 'title status description priority labels workspace
// assignees' with assignees 'email name' (+ the workspace name for the workspace template).
const deliveryInclude = {
    user: { select: { id: true, name: true, email: true } },
    todo: {
        select: {
            id: true,
            title: true,
            status: true,
            description: true,
            priority: true,
            workspaceId: true,
            workspace: { select: { name: true } },
            assignees: {
                select: { user: { select: { id: true, name: true, email: true } } },
                orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
            },
        },
    },
} satisfies Prisma.ReminderInclude;

/** 'processing' rows older than STALE_PROCESSING_MS go back to 'pending' (a crashed run). */
export async function resetStaleProcessingReminders(now: Date, db: DbClient = prisma): Promise<number> {
    const { count } = await db.reminder.updateMany({
        where: { status: 'processing', updatedAt: { lt: new Date(now.getTime() - STALE_PROCESSING_MS) } },
        data: { status: 'pending' },
    });
    return count;
}

/** Ids of due reminders, oldest due first, at most `limit`. */
export async function findDueReminderIds(now: Date, db: DbClient = prisma, limit = REMINDER_BATCH_SIZE): Promise<string[]> {
    const rows = await db.reminder.findMany({
        // A reminder his phone holds rings there (app 0.5.0): no email for it.
        where: { status: 'pending', emailSent: false, reminderDate: { lte: now }, phoneAt: null },
        select: { id: true },
        orderBy: [{ reminderDate: 'asc' }, { id: 'asc' }],
        take: limit,
    });
    return rows.map((r) => r.id);
}

/** Atomically move one reminder from pending to processing. False if another run claimed it. */
export async function claimReminder(reminderId: string, db: DbClient = prisma): Promise<boolean> {
    const { count } = await db.reminder.updateMany({
        where: { id: reminderId, status: 'pending', emailSent: false },
        data: { status: 'processing' },
    });
    return count === 1;
}

async function setReminderOutcome(reminderId: string, sent: boolean, db: DbClient): Promise<void> {
    // updateMany: no error if the todo (and with it the reminder) was deleted meanwhile.
    await db.reminder.updateMany({
        where: { id: reminderId },
        data: sent ? { status: 'sent', emailSent: true } : { status: 'failed', emailSent: false },
    });
}

export interface ReminderEmailSenders {
    personal: (user: { name: string; email: string }, todo: any, reminder: any) => Promise<boolean>;
    workspace: (user: { name: string; email: string }, todo: any, reminder: any, workspaceName: string) => Promise<boolean>;
}

const defaultSenders: ReminderEmailSenders = {
    personal: sendPersonalTaskReminderEmail,
    workspace: sendWorkspaceTaskReminderEmail,
};

/** Email one claimed reminder. Returns true when at least one email was sent. */
async function deliverReminder(reminderId: string, senders: ReminderEmailSenders, db: DbClient): Promise<boolean | null> {
    const reminder = await db.reminder.findUnique({ where: { id: reminderId }, include: deliveryInclude });
    if (!reminder) {
        console.error(`Reminder ${reminderId} vanished`);
        return null;
    }

    const { todo } = reminder;
    const recipients = todo.assignees.length > 0 ? todo.assignees.map((a) => a.user) : [reminder.user];
    // The email templates read todo.title / description / priority (old populated shape).
    const todoForEmail = { ...todo, _id: todo.id, workspace: todo.workspaceId };

    if (todo.workspaceId) {
        const wsName = todo.workspace?.name || 'Workspace';
        console.log(`📧 Sending workspace task reminder email(s) for ${reminderId}...`);
        const results = await Promise.all(recipients.map((r) => senders.workspace(r, todoForEmail, reminder, wsName)));
        return results.some((ok) => ok === true);
    }

    console.log(`📧 Sending personal task reminder email(s) for ${reminderId}...`);
    const results = await Promise.all(recipients.map((r) => senders.personal(r, todoForEmail, reminder)));
    return results.some((ok) => ok === true);
}

export interface ReminderRunResult {
    due: number;
    sent: number;
    failed: number;
    skipped: number;
}

/** One cron tick. Never throws for a single reminder: it is marked 'failed' and the loop goes on. */
export async function processDueReminders(
    now: Date = new Date(),
    senders: ReminderEmailSenders = defaultSenders,
    db: DbClient = prisma
): Promise<ReminderRunResult> {
    await resetStaleProcessingReminders(now, db);
    // Past reminders his phone held rang there: done (lists show them sent).
    await db.reminder.updateMany({ where: { status: 'pending', phoneAt: { not: null }, reminderDate: { lte: now } }, data: { status: 'sent' } });
    if (reminderEmailsOff()) {
        // No emails: a past reminder no phone held is marked failed, so turning emails on later sends no flood of old ones.
        const { count } = await db.reminder.updateMany({ where: { status: 'pending', reminderDate: { lte: now } }, data: { status: 'failed' } });
        return { due: count, sent: 0, failed: count, skipped: 0 };
    }

    const dueIds = await findDueReminderIds(now, db);
    if (dueIds.length > 0) {
        console.log(`📧 Found ${dueIds.length} due reminders...`);
    }

    const result: ReminderRunResult = { due: dueIds.length, sent: 0, failed: 0, skipped: 0 };
    for (const reminderId of dueIds) {
        try {
            if (!(await claimReminder(reminderId, db))) {
                result.skipped += 1; // another cron instance already picked it up
                continue;
            }
            const sent = await deliverReminder(reminderId, senders, db);
            if (sent === null) {
                result.skipped += 1;
                continue;
            }
            await setReminderOutcome(reminderId, sent, db);
            if (sent) result.sent += 1;
            else result.failed += 1;
        } catch (error) {
            console.error(`Error processing reminder ${reminderId}:`, error);
            result.failed += 1;
            await setReminderOutcome(reminderId, false, db).catch(() => {});
        }
    }
    return result;
}
