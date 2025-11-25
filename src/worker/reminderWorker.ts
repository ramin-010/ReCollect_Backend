import { Worker } from "bullmq";
import { redis } from "../server/redis";
import Reminder from "../models/reminderSchema";
import User from "../models/userSchema";
import Content from "../models/contentSchema";
import Block from "../models/canvasBlockSchema";
import Dashboard from "../models/dashboardSchema";
import { sendReminderEmail } from "../utils/emailService";
import ConnectDb from "../server/db";
import dotenv from "dotenv";

dotenv.config();

// Connect to database
ConnectDb();

// Ensure models are registered (importing them above registers them)
console.log("✓ Worker models registered:", {
    User: !!User,
    Content: !!Content,
    Block: !!Block,
    Dashboard: !!Dashboard,
    Reminder: !!Reminder
});

const worker = new Worker(
    "reminder",
    async (job) => {
        const { reminderId } = job.data as { reminderId: string };

        try {
            const reminder = await Reminder.findById(reminderId)
                .populate([{
                    path: "user",
                    select: "name email"
                },
                {
                    path: "content",
                    select: "title description DashId"
                }])


            if (!reminder) {
                console.error(`Reminder ${reminderId} not found`);
                return;
            }

            if (reminder.emailSent || reminder.status === "sent") {
                console.log(`Reminder ${reminderId} already sent, skipping`);
                return;
            }

            const user = reminder.user as any;
            const content = reminder.content as any;

            if (!user || !content) {
                console.error(`Missing user or content for reminder ${reminderId}`);
                reminder.status = "failed";
                await reminder.save();
                return;
            }

            // Send email
            const emailSent = await sendReminderEmail(user, content, reminder);

            if (emailSent) {
                reminder.emailSent = true;
                reminder.status = "sent";
                console.log(`✓ [BullMQ] Reminder sent to ${user.email} for "${content.title}"`);
            } else {
                reminder.status = "failed";
                console.error(`✗ [BullMQ] Failed to send reminder ${reminderId}`);
            }

            await reminder.save();
        } catch (error) {
            console.error(`Error processing reminder job ${reminderId}:`, error);
            throw error; // Let BullMQ handle retry logic
        }
    },
    { connection: redis }
);

worker.on("completed", (job) => {
    console.log(`✓ Job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
    console.error(`✗ Job ${job?.id} failed:`, err.message);
});

console.log("✓ BullMQ reminder worker started and listening for jobs...");
