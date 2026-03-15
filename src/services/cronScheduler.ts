import cron from "node-cron";
import Reminder from "../models/reminderSchema";
import WorkspaceModel from "../models/workspaceSchema";
import { sendReminderEmail } from "../utils/emailService";
import { sendWorkspaceTaskReminderEmail } from "../controllers/workspace/workspaceEmails";
import { sendPersonalTaskReminderEmail } from "../controllers/personalTasks/personalEmails";

export const startCronScheduler = () => {
    // Run every minute
    cron.schedule("* * * * *", async () => {
        try {
            const now = new Date();

            // Cleanup: reset stale 'processing' reminders older than 5 min back to pending
            await Reminder.updateMany(
                {
                    status: "processing",
                    updatedAt: { $lt: new Date(now.getTime() - 5 * 60 * 1000) }
                },
                { $set: { status: "pending" } }
            );

            // Find all pending reminders that are due
            const dueReminders = await Reminder.find(
                {
                    status: "pending",
                    emailSent: false,
                    reminderDate: { $lte: now },
                },
                { _id: 1, type: 1 }
            )
                .limit(50)
                .maxTimeMS(5000)
                .lean();

            if (dueReminders.length > 0) {
                console.log(`📧 Found ${dueReminders.length} due reminders...`);
            }
            
            for (const doc of dueReminders) {
                const reminderId = doc._id;
                const reminderType = doc.type || 'note';

                try {
                    // Atomic claim: prevent duplicate processing
                    const claimed = await Reminder.findOneAndUpdate(
                        { _id: reminderId, status: "pending", emailSent: false },
                        { $set: { status: "processing" } },
                        { new: true }
                    );

                    if (!claimed) {
                        // Another cron instance already picked this up
                        continue;
                    }

                    let emailSent = false;

                    if (reminderType === 'todo') {
                        const reminder = await Reminder.findById(reminderId)
                            .populate([
                                { path: "user", select: "email name" },
                                { 
                                    path: "todoId", 
                                    select: "title status description priority labels workspace assignees",
                                    populate: { path: "assignees", select: "email name" }
                                }
                            ])
                            .lean();

                        if (!reminder) {
                            console.error(`Reminder ${reminderId} vanished`);
                            await Reminder.findByIdAndUpdate(reminderId, { status: "failed" });
                            continue;
                        }

                        if (!reminder.user || !reminder.todoId) {
                            console.error(`Missing user/todo for reminder ${reminderId}`);
                            await Reminder.findByIdAndUpdate(reminderId, { status: "failed" });
                            continue;
                        }

                        const todoDoc = reminder.todoId as any;

                        const recipients = todoDoc.assignees && todoDoc.assignees.length > 0 
                            ? todoDoc.assignees 
                            : [reminder.user];

                        // Route to the correct email template based on workspace presence
                        if (todoDoc?.workspace) {
                            // Workspace task → use workspace email template
                            const ws = await WorkspaceModel.findById(todoDoc.workspace).select('name').lean();
                            const wsName = ws?.name || 'Workspace';
                            
                            console.log(`📧 Sending workspace task reminder email(s) for ${reminderId}...`);
                            const results = await Promise.all(recipients.map((recipient: any) => 
                                sendWorkspaceTaskReminderEmail(recipient, todoDoc, reminder, wsName)
                            ));
                            emailSent = results.some(res => res === true);
                        } else {
                            // Personal task → use personal email template
                            console.log(`📧 Sending personal task reminder email(s) for ${reminderId}...`);
                            const results = await Promise.all(recipients.map((recipient: any) => 
                                sendPersonalTaskReminderEmail(recipient, todoDoc, reminder)
                            ));
                            emailSent = results.some(res => res === true);
                        }
                    } else {
                        // Handle note reminder (original behavior)
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
                       
                        console.log(`📧 Sending note reminder email for ${reminderId}...`);
                        emailSent = await sendReminderEmail(
                            reminder.user,
                            reminder.content,
                            reminder
                        );
                    }

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
