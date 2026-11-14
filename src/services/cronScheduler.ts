import cron from "node-cron";
import { processDueReminders } from "./reminders/reminders.service";

/**
 * Reminder emails: every minute, send the due todo reminders (Postgres). The work itself is in
 * processDueReminders() (src/services/reminders/reminders.service.ts) so tests can run one tick.
 */
export const startCronScheduler = () => {
    // Run every minute
    cron.schedule("* * * * *", async () => {
        try {
            await processDueReminders(new Date());
        } catch (error) {
            console.error("Error in cron scheduler:", error);
        }
    });

    console.log("✓ Cron scheduler started. Checking reminders every minute.");
};
