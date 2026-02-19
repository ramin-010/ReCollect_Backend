import Reminder from "../models/reminderSchema";
import { Queue } from "bullmq";
// import { redis } from "../server/redis";
import mongoose from "mongoose";

// Force disable BullMQ/Redis as per user request to rely on DB polling
export const USE_BULLMQ = false; // process.env.USE_BULLMQ === "true";

interface ScheduleReminderDTO {
    userId: string | mongoose.Types.ObjectId;
    contentId: string | mongoose.Types.ObjectId;
    dashboardId: string | mongoose.Types.ObjectId;
    message: string;
    remindAt: Date;
    reminderId?: string | mongoose.Types.ObjectId; // Optional: pass reminder ID directly
}

// BullMQ queue - always initialize (will be used if USE_BULLMQ is true)
let reminderQueue: Queue | null = null;

// Initialized only if enabled
if (USE_BULLMQ) {
    // Dynamic import to avoid Redis connection when disabled
    const { redis } = require("../server/redis"); 
    reminderQueue = new Queue("reminder", { connection: redis });
    console.log("✓ BullMQ reminder queue initialized");
}

export const scheduleReminder = async ({
    userId,
    contentId,
    dashboardId,
    message,
    remindAt,
    reminderId, // New parameter
}: ScheduleReminderDTO): Promise<void> => {
    try {

        if (reminderId) {
            if (USE_BULLMQ && reminderQueue) {
                const delay = new Date(remindAt).getTime() - Date.now();
                if (delay > 0) {
                    await reminderQueue.add(
                        "sendReminder",
                        { reminderId: String(reminderId) },
                        { delay, jobId: `reminder-${String(reminderId)}` }
                    );
                    console.log(`✓ BullMQ job scheduled for reminder ${reminderId}`);
                } else {
                    console.log(`⚠️ Delay is negative (${delay}ms), job not scheduled`);
                }
            } else {
                console.log(`✓ Reminder created. Cron will handle sending it. (USE_BULLMQ: ${USE_BULLMQ}, queue: ${!!reminderQueue})`);
            }
            return;
        }

        const existingReminder = await Reminder.findOne({
            user: userId,
            content: contentId,
            status: "pending",
        });

        if (existingReminder) {
            existingReminder.reminderDate = remindAt;
            existingReminder.message = message;
            existingReminder.emailSent = false;
            existingReminder.status = "pending";
            await existingReminder.save();

            if (USE_BULLMQ && reminderQueue) {
                const delay = new Date(remindAt).getTime() - Date.now();
                console.log(`[BullMQ] Scheduling job with delay: ${delay}ms`);
                if (delay > 0) {
                    await reminderQueue.add(
                        "sendReminder",
                        { reminderId: String(existingReminder._id) },
                        { delay, jobId: `reminder-${String(existingReminder._id)}` }
                    );
                    console.log(`✓ BullMQ job scheduled for reminder ${existingReminder._id}`);
                } else {
                    console.log(`⚠️ Delay is negative (${delay}ms), job not scheduled`);
                }
            } else {
                console.log(`✓ Reminder updated. Cron will handle sending it. (USE_BULLMQ: ${USE_BULLMQ}, queue: ${!!reminderQueue})`);
            }
        } else {
            console.log(`⚠️ No reminderId provided and no existing reminder found for user ${userId} and content ${contentId}`);
        }
    } catch (error) {
        console.error("Error scheduling reminder:", error);
        throw error;
    }
};

// DTO for todo reminders
interface ScheduleTodoReminderDTO {
    reminderId: string | mongoose.Types.ObjectId;
    remindAt: Date;
}

/**
 * Schedule a todo reminder via BullMQ or let cron handle it
 * Simpler than scheduleReminder since we already have the reminder ID from creation
 */
export const scheduleTodoReminder = async ({
    reminderId,
    remindAt,
}: ScheduleTodoReminderDTO): Promise<void> => {
    try {
        if (USE_BULLMQ && reminderQueue) {
            const delay = new Date(remindAt).getTime() - Date.now();
            if (delay > 0) {
                await reminderQueue.add(
                    "sendReminder",
                    { reminderId: String(reminderId) },
                    { delay, jobId: `reminder-${String(reminderId)}` }
                );
            }
        }
        // If not using BullMQ, cron will pick up pending reminders
    } catch (error) {
        console.error("Error scheduling todo reminder:", error);
        throw error;
    }
};

export { reminderQueue };
