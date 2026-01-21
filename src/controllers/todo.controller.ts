import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import TodoModel, { Todo } from '../models/todoSchema';
import ErrorResponse from '../utils/errorResponse';

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
    try {
        const userId = req.user?._id as string;
        
        console.log('[createTodo] ========== START ==========');
        console.log('[createTodo] User ID:', userId);
        console.log('[createTodo] Request body keys:', Object.keys(req.body));
        console.log('[createTodo] Has files:', !!req.files);
        if (req.files) {
            console.log('[createTodo] File keys:', Object.keys(req.files));
        }

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

        console.log('[createTodo] Title:', title);
        console.log('[createTodo] Description length:', description?.length || 0);
        console.log('[createTodo] imageNodeIds (raw):', imageNodeIds);

        subtasks = parseJson<any[]>(subtasks, []);
        labels = parseJson<any[]>(labels, []);
        recurrence = parseJson<any>(recurrence, null);
        imageNodeIds = parseJson<string[]>(imageNodeIds, []);

        console.log('[createTodo] imageNodeIds (parsed):', imageNodeIds);
        console.log('[createTodo] imageNodeIds length:', imageNodeIds.length);

        if (!title || !title.trim()) {
            throw new ErrorResponse(400, "Task title is required");
        }

        const files = req.files as Record<string, Express.Multer.File[]> | undefined;
        const cloudImages: { imageId: string; cloudUrl: string; cloudPublicId: string }[] = [];
        
        console.log('[createTodo] Condition check - files:', !!files, ', imageNodeIds.length:', imageNodeIds.length, ', description:', !!description);
        
        if (files && imageNodeIds.length > 0 && description) {
            console.log('[createTodo] Processing images...');

            const imageUrlMap: Record<string, { url: string; publicId: string }> = {};
            
            for (const imageId of imageNodeIds) {
                const fieldName = `image_${imageId}`;
                console.log('[createTodo] Looking for field:', fieldName);
                
                const fileArray = files[fieldName];
                console.log('[createTodo] Found file array:', !!fileArray, 'Length:', fileArray?.length || 0);
                
                if (fileArray && fileArray.length > 0) {
                    const file = fileArray[0] as CloudFileOutput;
                    console.log('[createTodo] File properties - cloudUrl:', !!file.cloudUrl, 'cloudPublicId:', !!file.cloudPublicId);
                    
                    if (file.cloudUrl && file.cloudPublicId) {
                        console.log('[createTodo] Adding to imageUrlMap:', imageId, '->', file.cloudUrl.substring(0, 50));
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
            
            console.log('[createTodo] Total cloudImages:', cloudImages.length);
            console.log('[createTodo] Replacing placeholders in description...');

            for (const [imageId, data] of Object.entries(imageUrlMap)) {
                const placeholder = `__PENDING_UPLOAD_${imageId}__`;
                console.log('[createTodo] Replacing placeholder:', placeholder);
                description = description.replace(placeholder, data.url);
            }
            
            console.log('[createTodo] Description after replacement (first 100 chars):', description?.substring(0, 100));
        } else {
            console.log('[createTodo] Skipping image processing - condition not met');
        }

        const todoData = {
            user: new mongoose.Types.ObjectId(userId),
            title: title.trim(),
            description: description || null,
            status: status || 'pending',
            priority: priority || 'medium',
            dueDate: dueDate ? new Date(dueDate) : null,
            reminderDate: reminderDate ? new Date(reminderDate) : null,
            subtasks: subtasks || [],
            labels: labels || [],
            recurrence: recurrence || null,
            cloudImages: cloudImages.map(img => ({ imageId: img.imageId, cloudPublicId: img.cloudPublicId })),
            assignee: assignee ? new mongoose.Types.ObjectId(assignee) : null,
            assignedAt: assignee ? new Date() : null
        };

        console.log('[createTodo] Final cloudImages count:', todoData.cloudImages.length);
        console.log('[createTodo] Creating todo in database...');

        const todo = await TodoModel.create(todoData);
        
        if (!todo) {
            throw new ErrorResponse(400, "Failed to create task");
        }

        console.log('[createTodo] Todo created successfully:', todo._id);
        console.log('[createTodo] ========== END ==========');

        res.status(201).json({
            success: true,
            data: todo,
            message: 'Task created successfully'
        });

    } catch (err) {
        console.error('[createTodo] ERROR:', err);
        next(err);
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
