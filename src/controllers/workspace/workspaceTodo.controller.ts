// Workspace Todo Controller — CRUD operations for workspace tasks only
// Assignment logic is in workspaceAssign.controller.ts

import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import TodoModel from '../../models/todoSchema';
import WorkspaceModel from '../../models/workspaceSchema';
import ActivityLogModel from '../../models/activityLogSchema';
import ErrorResponse from '../../utils/errorResponse';
import reminderSchema from '../../models/reminderSchema';
import { scheduleTodoReminder } from '../../services/reminderService';
import cloudinary from '../../utils/cloudinary';
import TagsModel from '../../models/tagsSchema';
import UserModel from '../../models/userSchema';
import NotificationModel from '../../models/notificationSchema';
import { sendWorkspaceTaskAssignmentEmail } from './workspaceEmails';

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

export const createWorkspaceTodo = async (
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
            tags, 
            assignees,
            recurrence,
            imageNodeIds,
            references,
            workspace,
            spaceId,
            visibility
        } = req.body;

        subtasks = parseJson<any[]>(subtasks, []);
        references = parseJson<any[]>(references, []);
        tags = parseJson<string[]>(tags, []);
        recurrence = parseJson<any>(recurrence, null);
        imageNodeIds = parseJson<string[]>(imageNodeIds, []);

        if (!title || !title.trim()) {
            throw new ErrorResponse(400, "Task title is required");
        }

        if (!workspace) {
            throw new ErrorResponse(400, "Workspace ID is required for a workspace task");
        }

        const workspaceDoc = await WorkspaceModel.findById(workspace).select('name owner members').session(session).lean();
        if (!workspaceDoc) {
            throw new ErrorResponse(404, "Workspace not found");
        }

        const isOwner = workspaceDoc.owner.toString() === String(userId);
        const workspaceMember = workspaceDoc.members.find(m => m.user.toString() === String(userId));
        
        if (!isOwner && (!workspaceMember || workspaceMember.role === 'viewer')) {
            throw new ErrorResponse(403, "Viewers cannot create tasks in this workspace");
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
        
       
        let populatedTags: mongoose.Types.ObjectId[] = [];
        if (tags && tags.length > 0) {
            const existingTags = await TagsModel.find({ name: { $in: tags } }).session(session).lean();
            const existingTagNames = new Set(existingTags.map(t => t.name));
            const newTagNames = tags.filter((name: string) => !existingTagNames.has(name));

            let newTags: any[] = [];
            if (newTagNames.length > 0) {
                newTags = await TagsModel.insertMany(
                    newTagNames.map((name: string) => ({ name })),
                    { session, ordered: false }
                );
            }
            populatedTags = [...existingTags, ...newTags].map(t => t._id as mongoose.Types.ObjectId);
        }
        
        const todoData = {
            user: new mongoose.Types.ObjectId(userId),
            title: title.trim(),
            description: description || null,
            status: status || 'pending',
            priority: priority || 'medium',
            dueDate: dueDate ? new Date(dueDate) : null,
            reminderDate: parsedReminderDate,
            subtasks: subtasks || [],
            tags: populatedTags,
            recurrence: recurrence || null,
            cloudImages: cloudImages.map(img => ({ imageId: img.imageId, cloudPublicId: img.cloudPublicId })),
            assignees: Array.isArray(assignees) ? assignees.map((id: string) => new mongoose.Types.ObjectId(id)) : [],
            assignedAt: assignees && assignees.length > 0 ? new Date() : null,
            references: parsedReferences,
            workspace: new mongoose.Types.ObjectId(workspace),
            spaceId: spaceId ? new mongoose.Types.ObjectId(spaceId) : null,
            visibility: 'workspace',
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

       
        if (todo.visibility === 'workspace' && todo.workspace) {
            ActivityLogModel.create({
                workspace: todo.workspace,
                actor: new mongoose.Types.ObjectId(userId),
                action: 'task_created',
                targetTask: todo._id,
                metadata: todo.title,
            }).catch(err => console.error('[activity] Failed to log task_created:', err));

            // Log and notify assignees initially selected
            if (Array.isArray(assignees) && assignees.length > 0) {
                UserModel.findById(userId).select('name email').then(currentUser => {
                    assignees.forEach(async (targetUserIdStr: string) => {
                        const targetUserId = new mongoose.Types.ObjectId(targetUserIdStr);
                        if (targetUserId.equals(userId)) return;

                        const targetUser = await UserModel.findById(targetUserId);
                        if (!targetUser) return;

                        ActivityLogModel.create({
                            workspace: todo.workspace,
                            actor: new mongoose.Types.ObjectId(userId),
                            action: 'task_assigned',
                            targetTask: todo._id,
                            targetUser: targetUserId,
                            metadata: todo.title
                        }).catch(err => console.error('[activity]', err));

                        await NotificationModel.create({
                            recipient: targetUser._id,
                            sender: new mongoose.Types.ObjectId(userId),
                            category: 'informational',
                            type: 'task_assigned',
                            title: 'Task Assigned',
                            message: `${currentUser?.name || 'Someone'} assigned you "${todo.title}"`,
                            metadata: {
                                taskId: todo._id,
                                taskTitle: todo.title,
                                workspaceId: todo.workspace,
                            },
                        });

                        sendWorkspaceTaskAssignmentEmail(
                            { name: targetUser.name, email: targetUser.email },
                            { name: currentUser?.name || 'Someone', email: currentUser?.email || '' },
                            todo,
                            workspaceDoc?.name || 'Workspace',
                            false
                        ).catch(err => console.error('[assign] Email failed:', err));
                    });
                });
            }
        }

        if (reminderScheduleData) {
            scheduleTodoReminder(reminderScheduleData).catch(err => {
                console.error("Failed to schedule todo reminder:", err);
            });
        }

        const populatedTodo = await TodoModel.findById(todo._id)
            .populate('user', 'name email avatar')
            .populate('assignees', 'name email avatar')
            .session(session)
            .lean();

        res.status(201).json({
            success: true,
            data: populatedTodo,
            message: 'Task created successfully'
        });

    } catch (err) {
        await session.abortTransaction();
        next(err);
    } finally {
        session.endSession();
    }
};


export const updateWorkspaceTodo = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const session = await mongoose.startSession();

    try {
       
        let updatedTodo: any = null;
        let existingTodoSnapshot: any = null;
        let todoUpdatesCopy: any = {};
        let reminderScheduleData: any = null;

        await session.withTransaction(async () => {
        const userId = req.user?._id;
        const { id: todoId } = req.params;

        if (!userId) {
            throw new ErrorResponse(401, "Unauthorized");
        }

            const existingTodo = await TodoModel.findOne({
                _id: todoId
            }).session(session).lean();

        if (!existingTodo) {
            throw new ErrorResponse(404, "Task not found");
        }

       
        let hasPermission = false;
        if (existingTodo.user.toString() === String(userId)) {
            hasPermission = true;
        } else if (existingTodo.assignees && existingTodo.assignees.some(a => a.toString() === String(userId))) {
            hasPermission = true;
        } else if (existingTodo.visibility === 'workspace' && existingTodo.workspace) {
            const workspace = await WorkspaceModel.findById(existingTodo.workspace).select('owner members').session(session).lean();
            if (workspace) {
                const isOwner = workspace.owner.toString() === String(userId);
                const workspaceMember = workspace.members.find(m => m.user.toString() === String(userId));
                if (isOwner || (workspaceMember && workspaceMember.role !== 'viewer')) {
                    hasPermission = true;
                }
            }
        }

        if (!hasPermission) {
            throw new ErrorResponse(403, "You don't have permission to update this workspace task");
        }

        const allowedUpdates = [
            'title', 'description', 'status', 'priority',
            'dueDate', 'reminderDate', 'subtasks', 'tags',
            'assignees', 'recurrence', 'imageNodeIds', 'references', 'spaceId'
        ];

        const todoUpdates: any = {};
        const updates: any = {};

        let description = req.body.description;
        const imageNodeIds: string[] = typeof req.body.imageNodeIds === 'string'
            ? JSON.parse(req.body.imageNodeIds)
            : (req.body.imageNodeIds || []);

        const newCloudImages: { imageId: string; cloudUrl: string; cloudPublicId: string }[] = [];

        if (description && imageNodeIds.length > 0) {
            const files = req.files as Record<string, Express.Multer.File[]> | undefined;
            if (files) {
                const imageUrlMap: Record<string, { url: string; publicId: string }> = {};
                for (const imageId of imageNodeIds) {
                    const fieldName = `image_${imageId}`;
                    const fileArray = files[fieldName];
                    if (fileArray && fileArray.length > 0) {
                        const file = fileArray[0] as CloudFileOutput;
                        if (file.cloudUrl && file.cloudPublicId) {
                            imageUrlMap[imageId] = { url: file.cloudUrl, publicId: file.cloudPublicId };
                            newCloudImages.push({
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
        }
        
        if (description !== undefined) {
             todoUpdates.description = description;
        }

        if (newCloudImages.length > 0) {
            updates.$push = { cloudImages: { $each: newCloudImages } };
        }

        for (const key of allowedUpdates) {
             if (key === 'imageNodeIds') continue;
             if (key === 'description') continue;

            if (req.body[key] !== undefined) {
                const value = req.body[key];
                if (key === 'dueDate' || key === 'reminderDate') {
                    if (value === 'null' || !value) {
                        todoUpdates[key] = null;
                    } else {
                        const date = new Date(value);
                        todoUpdates[key] = isNaN(date.getTime()) ? null : date;
                    }
                } else if (key === 'assignees') {
                    if (Array.isArray(value)) {
                        todoUpdates.assignees = value.map((item: any) => {
                            const idStr = typeof item === 'object' && item !== null ? item._id : item;
                            return new mongoose.Types.ObjectId(String(idStr));
                        }).filter((id: mongoose.Types.ObjectId) => id.toString() !== 'undefined');
                        todoUpdates.assignedAt = value.length > 0 ? new Date() : null;
                    } else {
                        todoUpdates.assignees = [];
                        todoUpdates.assignedAt = null;
                    }
                } else if (key === 'subtasks' || key === 'references' || key === 'recurrence') {
                     const parsed = parseJson(value, null) as any;
                     if (key === 'references' && Array.isArray(parsed)) {
                         todoUpdates[key] = parsed.map((ref: any) => ({
                             type: ref.type,
                             refId: new mongoose.Types.ObjectId(ref.refId),
                             title: ref.title || undefined
                         }));
                     } else {
                         todoUpdates[key] = parsed;
                     }
                } else if (key === 'tags') {
                     const rawTags = parseJson<string[]>(value, []);
                     if (rawTags.length > 0) {
                        const existingTags = await TagsModel.find({ name: { $in: rawTags } }).session(session).lean();
                        const existingTagNames = new Set(existingTags.map(t => t.name));
                        const newTagNames = rawTags.filter((name: string) => !existingTagNames.has(name));

                        let newTags: any[] = [];
                        if (newTagNames.length > 0) {
                            newTags = await TagsModel.insertMany(
                                newTagNames.map((name: string) => ({ name })),
                                { session, ordered: false }
                            );
                        }
                        todoUpdates.tags = [...existingTags, ...newTags].map(t => t._id as mongoose.Types.ObjectId);
                     }
                } else if (key === 'spaceId') {
                    if (value === 'null' || !value) {
                        todoUpdates.spaceId = null;
                    } else {
                        todoUpdates.spaceId = new mongoose.Types.ObjectId(String(value));
                    }
                } else {
                    todoUpdates[key] = value;
                }
            }
        }

        if (todoUpdates.status === 'complete' && existingTodo.status !== 'complete') {
            todoUpdates.completedAt = new Date();
        } else if (todoUpdates.status === 'pending' && existingTodo.status === 'complete') {
            todoUpdates.completedAt = null;
        }

       
        updates.$set = todoUpdates;

        reminderScheduleData = null;
        
        if (req.body.reminderDate !== undefined) {
             await reminderSchema.deleteMany({ todoId: existingTodo._id }).session(session);
             
             const newDate = todoUpdates.reminderDate;
             if (newDate) {
                 if (isNaN(new Date(newDate).getTime())) throw new ErrorResponse(400, "Invalid reminder date");
                 
                 const [newReminder] = await reminderSchema.create([{
                     user: new mongoose.Types.ObjectId(String(userId)),
                     type: 'todo',
                     todoId: existingTodo._id,
                     reminderDate: newDate,
                     message: `Reminder: ${(todoUpdates.title || existingTodo.title).trim()}`,
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

        const result = await TodoModel.findByIdAndUpdate(
            todoId,
            updates,
            { new: true, runValidators: true, session }
        ).lean();
        
        if (!result) {
            throw new ErrorResponse(404, "Task not found");
        }

        updatedTodo = result;
        existingTodoSnapshot = existingTodo;
        todoUpdatesCopy = { ...todoUpdates };
        });

       
        const userId = req.user?._id;

        if (existingTodoSnapshot?.visibility === 'workspace' && existingTodoSnapshot.workspace) {
            const wsId = existingTodoSnapshot.workspace;
            const actorId = new mongoose.Types.ObjectId(String(userId));
            const wsDoc = await WorkspaceModel.findById(wsId).select('name').lean();
            const updatesLog: Promise<any>[] = [];

            if (todoUpdatesCopy.status === 'complete' && existingTodoSnapshot.status !== 'complete') {
                updatesLog.push(ActivityLogModel.create({
                    workspace: wsId, actor: actorId, action: 'task_completed',
                    targetTask: existingTodoSnapshot._id, metadata: existingTodoSnapshot.title,
                }));
            } else if (todoUpdatesCopy.status && todoUpdatesCopy.status !== existingTodoSnapshot.status) {
                updatesLog.push(ActivityLogModel.create({
                    workspace: wsId, actor: actorId, action: 'task_status_changed',
                    targetTask: existingTodoSnapshot._id, metadata: `${existingTodoSnapshot.status} → ${todoUpdatesCopy.status}`,
                }));
            }

            if (todoUpdatesCopy.priority && todoUpdatesCopy.priority !== existingTodoSnapshot.priority) {
                updatesLog.push(ActivityLogModel.create({
                    workspace: wsId, actor: actorId, action: 'task_priority_changed',
                    targetTask: existingTodoSnapshot._id, metadata: `${existingTodoSnapshot.priority || 'none'} → ${todoUpdatesCopy.priority}`,
                }));
            }

            const titleChanged = todoUpdatesCopy.title && todoUpdatesCopy.title !== existingTodoSnapshot.title;
            const descChanged = 'description' in todoUpdatesCopy && todoUpdatesCopy.description !== existingTodoSnapshot.description;
            
            if (titleChanged || descChanged) {
                let msg = 'updated the content';
                updatesLog.push(ActivityLogModel.create({
                    workspace: wsId, actor: actorId, action: 'task_content_changed',
                    targetTask: existingTodoSnapshot._id, metadata: msg,
                }));
            }

            if ('dueDate' in todoUpdatesCopy) {
                const oldTime = existingTodoSnapshot.dueDate ? new Date(existingTodoSnapshot.dueDate).getTime() : 0;
                const newTime = todoUpdatesCopy.dueDate ? new Date(todoUpdatesCopy.dueDate).getTime() : 0;
                if (oldTime !== newTime) {
                    const oldDate = existingTodoSnapshot.dueDate ? new Date(existingTodoSnapshot.dueDate).toISOString() : 'none';
                    const newDate = todoUpdatesCopy.dueDate ? new Date(todoUpdatesCopy.dueDate).toISOString() : 'none';
                    updatesLog.push(ActivityLogModel.create({
                        workspace: wsId, actor: actorId, action: 'task_due_date_changed',
                        targetTask: existingTodoSnapshot._id, metadata: `${oldDate} → ${newDate}`,
                    }));
                }
            }

            if (todoUpdatesCopy.assignees && Array.isArray(todoUpdatesCopy.assignees)) {
                const existingAssigneeStrs = existingTodoSnapshot.assignees ? existingTodoSnapshot.assignees.map((a: any) => a.toString()) : [];
                const newAssignees = todoUpdatesCopy.assignees.filter((id: any) => !existingAssigneeStrs.includes(id.toString()));
                const removedAssignees = existingAssigneeStrs.filter((id: string) => !todoUpdatesCopy.assignees.map((a: any) => a.toString()).includes(id));
                
                if (removedAssignees.length > 0) {
                    for (const removedId of removedAssignees) {
                        updatesLog.push(ActivityLogModel.create({
                            workspace: wsId, actor: actorId, action: 'task_unassigned',
                            targetTask: existingTodoSnapshot._id, targetUser: new mongoose.Types.ObjectId(removedId),
                            metadata: existingTodoSnapshot.title
                        }));
                    }
                }

                if (newAssignees.length > 0) {
                    UserModel.findById(userId).select('name email').then(currentUser => {
                        for (const newAssigneeId of newAssignees) {
                            if (newAssigneeId.toString() !== String(userId)) {
                                UserModel.findById(newAssigneeId).then(targetUser => {
                                    if (!targetUser) return;
                                    
                                    ActivityLogModel.create({
                                        workspace: wsId, actor: actorId, action: 'task_assigned',
                                        targetTask: existingTodoSnapshot._id, targetUser: new mongoose.Types.ObjectId(newAssigneeId),
                                        metadata: existingTodoSnapshot.title
                                    }).catch(err => console.error('[activity]', err));

                                    NotificationModel.create({
                                        recipient: targetUser._id,
                                        sender: actorId,
                                        category: 'informational',
                                        type: 'task_assigned',
                                        title: 'Task Assigned',
                                        message: `${currentUser?.name || 'Someone'} assigned you "${existingTodoSnapshot.title}"`,
                                        metadata: {
                                            taskId: existingTodoSnapshot._id,
                                            taskTitle: existingTodoSnapshot.title,
                                            workspaceId: wsId,
                                        },
                                    });

                                    sendWorkspaceTaskAssignmentEmail(
                                        { name: targetUser.name, email: targetUser.email },
                                        { name: currentUser?.name || 'Someone', email: currentUser?.email || '' },
                                        { ...existingTodoSnapshot, ...todoUpdatesCopy },
                                        wsDoc?.name || 'Workspace',
                                        false
                                    ).catch(err => console.error('[assign] Email failed:', err));
                                });
                            } else {
                                ActivityLogModel.create({
                                    workspace: wsId, actor: actorId, action: 'task_assigned',
                                    targetTask: existingTodoSnapshot._id, targetUser: actorId,
                                    metadata: existingTodoSnapshot.title
                                }).catch(err => console.error('[activity]', err));
                            }
                        }
                    });
                }
            }
            Promise.all(updatesLog).catch(err => console.error('[activity] Failed to log updates:', err));
        }

        if (reminderScheduleData) {
            scheduleTodoReminder(reminderScheduleData).catch(err => console.error(err));
        }

        const populatedTodo = await TodoModel.findById(updatedTodo._id)
            .populate('user', 'name email avatar')
            .populate('assignees', 'name email avatar')
            .session(session)
            .lean();

        res.status(200).json({
            success: true,
            data: populatedTodo,
            message: 'Task updated successfully'
        });
    } catch (err) {
        next(err);
    } finally {
        session.endSession();
    }
};


export const deleteWorkspaceTodo = async (
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
            _id: new mongoose.Types.ObjectId(id)
        }).session(session).lean();

        if (!todoToDelete) {
             throw new ErrorResponse(404, "Task not found");
        }

        let hasPermission = false;

        if (todoToDelete.visibility === 'workspace' && todoToDelete.workspace) {
            const workspace = await WorkspaceModel.findById(todoToDelete.workspace).select('owner members').session(session).lean();
            if (workspace) {
                const isOwner = workspace.owner.toString() === String(userId);
                const workspaceMember = workspace.members.find(m => m.user.toString() === String(userId));
                
               
                if (isOwner || (workspaceMember && workspaceMember.role !== 'viewer')) {
                    hasPermission = true;
                }
            }
        } else if (todoToDelete.user.toString() === String(userId)) {
            hasPermission = true;
        }

        if (!hasPermission) {
            throw new ErrorResponse(403, "You don't have permission to delete this workspace task");
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

export const getTaskActivity = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const { id } = req.params;
        const userId = req.user?._id;

        if (!userId) {
            throw new ErrorResponse(401, 'Unauthorized');
        }

        const task = await TodoModel.findById(id).lean();
        if (!task) {
            throw new ErrorResponse(404, 'Task not found');
        }

        const activities = await ActivityLogModel.find({ targetTask: new mongoose.Types.ObjectId(id) })
            .populate('actor', 'name email avatar')
            .populate('targetUser', 'name email avatar')
            .sort({ createdAt: -1 })
            .lean();

        res.status(200).json({
            success: true,
            data: activities
        });
    } catch (err) {
        next(err);
    }
};
