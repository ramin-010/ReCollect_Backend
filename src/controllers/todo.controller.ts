import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import TodoModel, { Todo } from '../models/todoSchema';
import ErrorResponse from '../utils/errorResponse';
import reminderSchema from '../models/reminderSchema';
import { scheduleTodoReminder } from '../services/reminderService';

interface CloudFileOutput extends Express.Multer.File {
  cloudUrl: string;
  cloudProvider: string;
  cloudPublicId: string;
}

const parseJson = <T>(data: any, fallback: T): T => {
  try {
    if (typeof data === "object" && data !== null) return data as T;
    if (typeof data === "string") return JSON.parse(data) as T;
    return fallback;
  } catch {
    return fallback;
  }
};


export const createTodo = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
        const userId = req.user?._id as string;

        let { 
            title, 
            description,
            status,
            priority,
            dueDate,
            reminderDate,
            subtasks,
            labels,
            assignee,
            recurrence,
            imageNodeIds
        } = req.body;

        subtasks = parseJson<any[]>(subtasks, []);
        labels = parseJson<any[]>(labels, []);
        recurrence = parseJson<any>(recurrence, null);
        imageNodeIds = parseJson<string[]>(imageNodeIds, []);

        if (!title || !title.trim()) {
            throw new ErrorResponse(400, "Task title is required");
        }

        // Process uploaded images
        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        const cloudImages: { imageId: string; cloudUrl: string; cloudPublicId: string }[] = [];
        
        if (files && imageNodeIds.length > 0 && description) {
            const imageUrlMap: Record<string, { url: string; publicId: string }> = {};
            
            for (const imageId of imageNodeIds) {
                const fieldName = `image_${imageId}`;
                const fileArray = files[fieldName];
                
                if (fileArray && fileArray.length > 0) {
                    const file = fileArray[0] as CloudFileOutput;
                    
                    if (file.cloudUrl && file.cloudPublicId) {
                        imageUrlMap[imageId] = {
                            url: file.cloudUrl,
                            publicId: file.cloudPublicId,
                        };
                        cloudImages.push({
                            imageId,
                            cloudUrl: file.cloudUrl,
                            cloudPublicId: file.cloudPublicId,
                        });
                    }
                }
            }

            // Replace placeholders with actual URLs
            for (const [imageId, data] of Object.entries(imageUrlMap)) {
                const placeholder = `__PENDING_UPLOAD_${imageId}__`;
                description = description.replace(placeholder, data.url);
            }
        }

        // Parse reminder date
        const parsedReminderDate = reminderDate ? new Date(reminderDate) : null;
        
        const todoData = {
            user: new mongoose.Types.ObjectId(userId),
            title: title.trim(),
            description: description || null,
            status: status || 'pending',
            priority: priority || 'medium',
            dueDate: dueDate ? new Date(dueDate) : null,
            reminderDate: parsedReminderDate,
            subtasks: subtasks || [],
            labels: labels || [],
            recurrence: recurrence || null,
            cloudImages: cloudImages.map(img => ({ imageId: img.imageId, cloudPublicId: img.cloudPublicId })),
            assignee: assignee ? new mongoose.Types.ObjectId(assignee) : null,
            assignedAt: assignee ? new Date() : null
        };

        // Create todo within transaction
        const [todo] = await TodoModel.create([todoData], { session });
        
        if (!todo) {
            throw new ErrorResponse(400, "Failed to create task");
        }

        // Create reminder document if reminderDate is provided
        let reminderScheduleData: { reminderId: mongoose.Types.ObjectId; remindAt: Date } | null = null;
        
        if (parsedReminderDate) {
            if (isNaN(parsedReminderDate.getTime())) {
                throw new ErrorResponse(400, "Invalid reminder date");
            }

            const reminderPayload = {
                user: new mongoose.Types.ObjectId(userId),
                type: 'todo' as const,
                todoId: todo._id as mongoose.Types.ObjectId,
                reminderDate: parsedReminderDate,
                message: `Reminder: ${title.trim()}`,
                emailSent: false,
                status: 'pending' as const,
            };

            const [createdReminder] = await reminderSchema.create([reminderPayload], { session });
            
            if (!createdReminder) {
                throw new ErrorResponse(400, "Failed to create reminder");
            }

            reminderScheduleData = {
                reminderId: createdReminder._id as mongoose.Types.ObjectId,
                remindAt: parsedReminderDate,
            };
        }

        await session.commitTransaction();

        if (reminderScheduleData) {
            scheduleTodoReminder(reminderScheduleData).catch(err => {
                console.error("Failed to schedule todo reminder:", err);
            });
        }

        res.status(201).json({
            success: true,
            data: todo,
            message: 'Task created successfully'
        });

    } catch (err) {
        await session.abortTransaction();
        next(err);
    } finally {
        session.endSession();
    }
};


export const getTodos = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const userId = req.user?._id as string;
        const { status, priority } = req.query;

        const query: Record<string, any> = {
            $or: [
                { user: new mongoose.Types.ObjectId(userId) },
                { assignee: new mongoose.Types.ObjectId(userId) }
            ]
        };

        if (status && ['pending', 'complete'].includes(status as string)) {
            query.status = status;
        }

        if (priority && ['low', 'medium', 'high'].includes(priority as string)) {
            query.priority = priority;
        }

        const todos = await TodoModel.find(query)
            .sort({ createdAt: -1 })
            .lean();

        res.status(200).json({
            success: true,
            data: todos,
            count: todos.length
        });
    } catch (err) {
        next(err);
    }
};
