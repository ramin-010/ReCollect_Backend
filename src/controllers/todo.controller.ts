import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import TodoModel from '../models/todoSchema';
import ErrorResponse from '../utils/errorResponse';
import reminderSchema from '../models/reminderSchema';
import { scheduleTodoReminder } from '../services/reminderService';
import cloudinary from '../utils/cloudinary';

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

export const deleteFromCloud = async (publicId: string): Promise<void> => {
    try {
        return new Promise((resolve, reject) => {
            cloudinary.uploader.destroy(publicId, { invalidate: true }, (err: any, result: any) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    } catch (error) {
        throw error;
    }
}

export const batchDeleteFromCloud = async (publicIds: string[]): Promise<void> => {
    if (publicIds.length === 0) return;
    
    const deletePromises = publicIds.map(id => 
        deleteFromCloud(id).catch(err => {
            console.error(`Failed to delete ${id}:`, err);
        })
    );
    
    await Promise.allSettled(deletePromises);
}

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
            imageNodeIds,
            references
        } = req.body;

        subtasks = parseJson<any[]>(subtasks, []);
        references = parseJson<any[]>(references, []);
        labels = parseJson<any[]>(labels, []);
        recurrence = parseJson<any>(recurrence, null);
        imageNodeIds = parseJson<string[]>(imageNodeIds, []);

        if (!title || !title.trim()) {
            throw new ErrorResponse(400, "Task title is required");
        }

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

            for (const [imageId, data] of Object.entries(imageUrlMap)) {
                const pattern = new RegExp(`__PENDING_UPLOAD_${imageId}__`, 'g');
                 description = description.replace(pattern, data.url);
            }
        }

        const parsedReminderDate = reminderDate ? new Date(reminderDate) : null;
        
        const parsedReferences = (references || []).map((ref: any) => ({
            type: ref.type,
            refId: new mongoose.Types.ObjectId(ref.refId),
            title: ref.title || undefined
        }));
        
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
            assignedAt: assignee ? new Date() : null,
            references: parsedReferences
        };

        const [todo] = await TodoModel.create([todoData], { session });
        
        if (!todo) {
            throw new ErrorResponse(400, "Failed to create task");
        }

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
        const { status, priority, refType, refId } = req.query;

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

        if (refType && refId && ['doc', 'content'].includes(refType as string)) {
            query['references'] = {
                $elemMatch: {
                    type: refType,
                    refId: new mongoose.Types.ObjectId(refId as string)
                }
            };
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


export const updateTodo = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const userId = req.user?._id;
        const { id } = req.params;

        if (!userId) {
            throw new ErrorResponse(401, "Unauthorized");
        }

        const existingTodo = await TodoModel.findOne({
            _id: new mongoose.Types.ObjectId(id),
            $or: [
                { user: new mongoose.Types.ObjectId(String(userId)) },
                { assignee: new mongoose.Types.ObjectId(String(userId)) }
            ]
        }).session(session);

        if (!existingTodo) {
            throw new ErrorResponse(404, "Task not found or you don't have permission to update it");
        }

        const allowedUpdates = [
            'title', 
            'description', 
            'status', 
            'priority', 
            'dueDate', 
            'reminderDate', 
            'subtasks', 
            'labels',
            'assignee',
            'recurrence',
            'references',
            'imageNodeIds'
        ];

        const updates: Record<string, any> = {};
        let description = req.body.description;
        
        const imageNodeIds = req.body.imageNodeIds ? parseJson<string[]>(req.body.imageNodeIds, []) : [];
        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        
        const newCloudImages: { imageId: string; cloudPublicId: string }[] = [];

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
                         newCloudImages.push({
                            imageId: imageId,
                            cloudPublicId: file.cloudPublicId
                        }); 
                    }
                }
            }

            for (const [imageId, data] of Object.entries(imageUrlMap)) {
                 const pattern = new RegExp(`__PENDING_UPLOAD_${imageId}__`, 'g');
                 description = description.replace(pattern, data.url);
            }
        }
        
        if (description !== undefined) {
             updates.description = description;
        }

        if (newCloudImages.length > 0) {
            updates.$push = { cloudImages: { $each: newCloudImages } };
        }


        for (const key of allowedUpdates) {
             if (key === 'imageNodeIds') continue;
             if (key === 'description') continue;

            if (req.body[key] !== undefined) {
                if (key === 'dueDate' || key === 'reminderDate') {
                    updates[key] = req.body[key] ? new Date(req.body[key]) : null;
                } else if (key === 'assignee') {
                    updates[key] = req.body[key] ? new mongoose.Types.ObjectId(req.body[key]) : null;
                    if (req.body[key]) {
                        updates.assignedAt = new Date();
                    }
                } else if (key === 'subtasks' || key === 'labels' || key === 'references' || key === 'recurrence') {
                     updates[key] = parseJson(req.body[key], null); 
                } else {
                    updates[key] = req.body[key];
                }
            }
        }

        if (updates.status === 'complete' && existingTodo.status !== 'complete') {
            updates.completedAt = new Date();
        } else if (updates.status === 'pending' && existingTodo.status === 'complete') {
            updates.completedAt = null;
        }

        let reminderScheduleData = null;
        
        if (req.body.reminderDate !== undefined) {
             await reminderSchema.deleteMany({ todoId: existingTodo._id }).session(session);
             
             const newDate = updates.reminderDate;
             if (newDate) {
                 if (isNaN(new Date(newDate).getTime())) throw new ErrorResponse(400, "Invalid reminder date");
                 
                 const [newReminder] = await reminderSchema.create([{
                     user: new mongoose.Types.ObjectId(String(userId)),
                     type: 'todo',
                     todoId: existingTodo._id,
                     reminderDate: newDate,
                     message: `Reminder: ${(updates.title || existingTodo.title).trim()}`,
                     emailSent: false,
                     status: 'pending'
                 }], { session });

                 if (!newReminder) {
                     throw new ErrorResponse(400, "Failed to create reminder");
                 }

                 reminderScheduleData = {
                     reminderId: newReminder._id as mongoose.Types.ObjectId,
                     remindAt: newDate
                 };
             }
        }

        const updatedTodo = await TodoModel.findByIdAndUpdate(
            id,
            updates.$push ? { $set: updates, $push: updates.$push } : { $set: updates },
            { new: true, runValidators: true, session }
        ).lean();
        
        if (updates.$push) delete updates.$push;

        if (!updatedTodo) {
            throw new ErrorResponse(404, "Task not found");
        }
        
        await session.commitTransaction();

        if (reminderScheduleData) {
            scheduleTodoReminder(reminderScheduleData).catch(err => console.error(err));
        }

        res.status(200).json({
            success: true,
            data: updatedTodo,
            message: 'Task updated successfully'
        });
    } catch (err) {
        await session.abortTransaction();
        next(err);
    } finally {
        session.endSession();
    }
};


export const deleteTodo = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const userId = req.user?._id;
        const { id } = req.params;

        if (!userId) {
            throw new ErrorResponse(401, "Unauthorized");
        }

        const todoToDelete = await TodoModel.findOne({
            _id: new mongoose.Types.ObjectId(id),
            user: new mongoose.Types.ObjectId(String(userId))
        }).session(session);

        if (!todoToDelete) {
             throw new ErrorResponse(404, "Task not found or you don't have permission to delete it");
        }

        const cleanupPromises: Promise<any>[] = [];

        if (todoToDelete.cloudImages && todoToDelete.cloudImages.length > 0) {
            const publicIds = todoToDelete.cloudImages.map(img => img.cloudPublicId);
            cleanupPromises.push(batchDeleteFromCloud(publicIds));
        }

        cleanupPromises.push(reminderSchema.deleteMany({ todoId: todoToDelete._id }).session(session));

        cleanupPromises.push(TodoModel.deleteOne({ _id: todoToDelete._id }).session(session));

        await Promise.all(cleanupPromises);

        await session.commitTransaction();

        res.status(200).json({
            success: true,
            message: 'Task deleted successfully'
        });
    } catch (err) {
        await session.abortTransaction();
        next(err);
    } finally {
        session.endSession();
    }
};
