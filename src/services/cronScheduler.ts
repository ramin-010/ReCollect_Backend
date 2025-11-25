import cron from "node-cron";
import Reminder from "../models/reminderSchema";
import User from "../models/userSchema";
import Content from "../models/contentSchema";
import { sendReminderEmail } from "../utils/emailService";

export const startCronScheduler = () => {
    // Run every minute
    cron.schedule("* * * * *", async () => {
        try {
            const now = new Date();

            // Find all pending reminders that are due
            const dueReminders = await Reminder.find(
                {
                    status: "pending",
                    emailSent: false,
                    reminderDate: { $lte: now },
                },
                { _id: 1 }
            )
                .limit(50)
                .maxTimeMS(5000)
                .lean();

            if (dueReminders.length > 0) {
                console.log(`📧 Found ${dueReminders.length} due reminders...`);
            }
            
            for (const doc of dueReminders) {
                const reminderId = doc._id;

                try {
                 
                    const reminder = await Reminder.findById(reminderId)
                        .populate([
                            { path: "user", select: "email name" },
                            { path: "content", select: "title description DashId" }
                        ])
                        .lean();

                    if (!reminder) {
                        console.error(`Reminder ${reminderId} vanished`);
                        await Reminder.findByIdAndUpdate(reminderId, { status: "failed" });
                        continue;
                    }

                    if (!reminder.user || !reminder.content) {
                        console.error(`Missing user/content for reminder ${reminderId}`);
                        await Reminder.findByIdAndUpdate(reminderId, { status: "failed" });
                        continue;
                    }
                   
                   
                    const emailSent = await sendReminderEmail(
                        reminder.user,
                        reminder.content,
                        reminder
                    );

                    await Reminder.findByIdAndUpdate(reminderId, {
                        status: emailSent ? "sent" : "failed",
                        emailSent: emailSent ? true : false,
                    });

                } catch (error) {
                    console.error(`Error processing reminder ${reminderId}:`, error);
                     await Reminder.findByIdAndUpdate(reminderId, { status: "failed" });
                }
            }
        } catch (error) {
            console.error("Error in cron scheduler:", error);
        }
    });

    console.log("✓ Cron scheduler started. Checking reminders every minute.");
};
