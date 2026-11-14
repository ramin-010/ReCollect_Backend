// Todo reminders are delivered by the in-process cron (src/services/cronScheduler.ts), which polls
// Postgres every minute for due Reminder rows (processDueReminders). Nothing has to be scheduled
// when a reminder is created.
//
// The BullMQ/Redis mode was removed on the pg-migration branch: it was hard-disabled
// (USE_BULLMQ = false) and its only worker (legacy Content reminders) is in _archive/.

interface ScheduleTodoReminderDTO {
    /** The Reminder id (a Postgres cuid; anything with toString() is accepted). */
    reminderId: string | { toString(): string };
    remindAt: Date;
}

/**
 * Called by the todo controllers after a reminder row was committed. The cron picks the row up
 * when it is due, so this is a no-op kept as the single hook for a future queue.
 */
export const scheduleTodoReminder = async (_reminder: ScheduleTodoReminderDTO): Promise<void> => {};
