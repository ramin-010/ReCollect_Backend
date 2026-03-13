import cron from "node-cron";
import Reminder from "../models/reminderSchema";
import Todo from "../models/todoSchema";
import WorkspaceModel from "../models/workspaceSchema";
import { sendReminderEmail, sendTodoReminderEmail } from "../utils/emailService";

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
                const reminderType = doc.type || 'note'; // Default to 'note' for backward compatibility

                try {
                    let emailSent = false;

                    if (reminderType === 'todo') {
                        const reminder = await Reminder.findById(reminderId)
                            .populate([
                                { path: "user", select: "email name" },
                                { path: "todoId", select: "title status description priority labels workspace" }
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

                        console.log(`📧 Sending todo reminder email for ${reminderId}...`);
                        
                        // Fetch workspace name if available
                        let wsName: string | undefined;
                        const todoDoc = reminder.todoId as any;
                        if (todoDoc?.workspace) {
                            const ws = await WorkspaceModel.findById(todoDoc.workspace).select('name').lean();
                            wsName = ws?.name;
                        }
                        
                        emailSent = await sendTodoReminderEmail(
                            reminder.user,
                            reminder.todoId,
                            reminder,
                            wsName
                        );
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

