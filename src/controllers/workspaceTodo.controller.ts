import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import TodoModel from '../models/todoSchema';
import WorkspaceModel from '../models/workspaceSchema';
import ActivityLogModel from '../models/activityLogSchema';
import ErrorResponse from '../utils/errorResponse';
import reminderSchema from '../models/reminderSchema';
import { scheduleTodoReminder } from '../services/reminderService';
import cloudinary from '../utils/cloudinary';
import TagsModel from '../models/tagsSchema';
import UserModel from '../models/userSchema';
import NotificationModel from '../models/notificationSchema';
import { sendTaskAssignmentEmail } from '../utils/emailService';

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

        const workspaceDoc = await WorkspaceModel.findById(workspace).select('owner members').session(session).lean();
        if (!workspaceDoc) {
            throw new ErrorResponse(404, "Workspace not found");
        }

        const isOwner = workspaceDoc.owner.toString() === String(userId);
        const workspaceMember = workspaceDoc.members.find(m => m.user.toString() === String(userId));
        
        if (!isOwner && (!workspaceMember || workspaceMember.role === 'viewer')) {
            throw new ErrorResponse(403, "Viewers cannot create tasks in this workspace");
        }
        console.log("diescroption 22",description)

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
        }

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

            if (todoUpdatesCopy.assignees && Array.isArray(todoUpdatesCopy.assignees)) {
                const existingAssigneeStrs = existingTodoSnapshot.assignees ? existingTodoSnapshot.assignees.map((a: any) => a.toString()) : [];
                const newAssignees = todoUpdatesCopy.assignees.filter((id: any) => !existingAssigneeStrs.includes(id.toString()));
                
                for (const newAssigneeId of newAssignees) {
                    updatesLog.push(ActivityLogModel.create({
                        workspace: wsId, actor: actorId, action: 'task_assigned',
                        targetTask: existingTodoSnapshot._id, targetUser: new mongoose.Types.ObjectId(newAssigneeId),
                        metadata: existingTodoSnapshot.title
                    }));
                }
            }
            Promise.all(updatesLog).catch(err => console.error('[activity] Failed to log updates:', err));
        }

        if (reminderScheduleData) {
            scheduleTodoReminder(reminderScheduleData).catch(err => console.error(err));
        }

        res.status(200).json({
            success: true,
            data: updatedTodo,
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




/**
 * POST /api/workspace-todos/:id/assign
 * Body: { emails: string[] }
 */
export const assignWorkspaceTask = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const currentUserId = req.user?._id ? req.user._id.toString() : '';
        const todoId = req.params.id;
        const { emails } = req.body;

        if (!emails || !Array.isArray(emails)) {
            throw new ErrorResponse(400, 'Emails array is required');
        }

        const normalizedEmails = emails.map(email => email.toLowerCase().trim()).filter(Boolean);

        if (normalizedEmails.length === 0) {
            throw new ErrorResponse(400, 'At least one valid email is required');
        }

       
        const todo = await TodoModel.findOne({
            _id: new mongoose.Types.ObjectId(todoId),
            visibility: 'workspace'
        });

        if (!todo) {
            throw new ErrorResponse(404, 'Task not found or you do not own it');
        }

       
        if (todo.workspace) {
            const ws = await WorkspaceModel.findById(todo.workspace).lean();
            if (ws) {
                const workspaceMember = ws.members.find((m: any) => m.user.toString() === currentUserId);
                if (ws.owner.toString() !== currentUserId && (!workspaceMember || workspaceMember.role === 'viewer')) {
                    throw new ErrorResponse(403, 'Viewers cannot modify task assignments');
                }
            }
        }

        const currentUser = await UserModel.findById(currentUserId).select('name email');
        let workspace: any = null;
        if (todo.workspace) {
            workspace = await WorkspaceModel.findById(todo.workspace);
        }

        const assignedUsers: any[] = [];
        const ghostEmails: string[] = [];

       
        if (!todo.assignees) todo.assignees = [];
        const existingAssigneeStrs = todo.assignees.map(a => a.toString());

       
        for (const normalizedEmail of normalizedEmails) {
           
            let targetUser = await UserModel.findOne({ email: normalizedEmail });
            let isNewGhost = false;

            if (!targetUser) {
                const emailPrefix = normalizedEmail.split('@')[0];
                targetUser = await UserModel.create({
                    email: normalizedEmail,
                    name: emailPrefix,
                    password: `ghost_${Date.now()}_${Math.random().toString(36)}`,
                    isGhost: true,
                    status: 'pending'
                });
                isNewGhost = true;
                ghostEmails.push(normalizedEmail);
                console.log(`[assign] Created ghost user: ${normalizedEmail} (${targetUser._id})`);
            }

            const targetUserIdStr = (targetUser._id as any).toString();

           
            if (targetUserIdStr === currentUserId) {
                continue;
            }

           
            if (existingAssigneeStrs.includes(targetUserIdStr)) {
                continue;
            }

            todo.assignees.push(targetUser._id as mongoose.Types.ObjectId);
            assignedUsers.push(targetUser);

           
            if (workspace) {
                const isAlreadyMember = workspace.members.some(
                    (m: any) => m.user.toString() === targetUserIdStr
                );

                if (!isAlreadyMember) {
                   
                    const existingInvite = await NotificationModel.findOne({
                        recipient: targetUser._id,
                        type: 'workspace_invite',
                        status: 'pending',
                        'metadata.workspaceId': workspace._id,
                    });

                    if (!existingInvite) {
                       
                        await NotificationModel.create({
                            recipient: targetUser._id,
                            sender: new mongoose.Types.ObjectId(currentUserId),
                            category: 'actionable',
                            type: 'workspace_invite',
                            title: 'Workspace Invite',
                            message: `${currentUser?.name || 'Someone'} invited you to join "${workspace.name}"`,
                            metadata: {
                                workspaceId: workspace._id,
                                workspaceName: workspace.name,
                                role: 'member',
                            },
                            status: 'pending',
                        });
                    }
                }

               
                ActivityLogModel.create({
                    workspace: workspace._id,
                    actor: new mongoose.Types.ObjectId(currentUserId),
                    action: 'task_assigned',
                    targetTask: todo._id,
                    targetUser: targetUser._id,
                    metadata: todo.title,
                }).catch(err => console.error('[activity]', err));
            }

           
            await NotificationModel.create({
                recipient: targetUser._id,
                sender: new mongoose.Types.ObjectId(currentUserId),
                category: 'informational',
                type: 'task_assigned',
                title: 'Task Assigned',
                message: `${currentUser?.name || 'Someone'} assigned you "${todo.title}"`,
                metadata: {
                    taskId: todo._id,
                    taskTitle: todo.title,
                    workspaceId: todo.workspace || null,
                },
            });

           
            sendTaskAssignmentEmail(
                { name: targetUser.name, email: targetUser.email },
                { name: currentUser?.name || 'Someone', email: currentUser?.email || '' },
                todo.title,
                isNewGhost
            ).catch(err => console.error('[assign] Email send failed:', err));
        }

            if (assignedUsers.length > 0) {
            todo.assignedAt = new Date();
           
            todo.visibility = 'workspace';
            await todo.save();
        }

       
        const updatedTodo = await TodoModel.findById(todoId)
            .populate('assignees', 'name email avatar')
            .populate('tags', 'name')
            .lean();

        res.status(200).json({
            success: true,
            data: updatedTodo,
            message: Object.keys(ghostEmails).length > 0
                ? `Task assigned. Invitations sent to ${ghostEmails.join(', ')}.`
                : `Task assigned successfully.`
        });

    } catch (err) {
        next(err);
    }
};

/**
 * POST /api/workspace-todos/:id/unassign
 * Body: { email?: string }
 * Removes specific assignee, or all if no email provided.
 */
export const unassignWorkspaceTask = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const currentUserId = req.user?._id ? req.user._id.toString() : '';
        const todoId = req.params.id;
        const { email } = req.body;

        const todo = await TodoModel.findOne({
            _id: new mongoose.Types.ObjectId(todoId),
            visibility: 'workspace'
        });

        if (!todo) {
            throw new ErrorResponse(404, 'Task not found');
        }

       
        if (todo.workspace) {
            const ws = await WorkspaceModel.findById(todo.workspace).lean();
            if (ws) {
                const workspaceMember = ws.members.find((m: any) => m.user.toString() === currentUserId);
                if (ws.owner.toString() !== currentUserId && (!workspaceMember || workspaceMember.role === 'viewer')) {
                    throw new ErrorResponse(403, 'Viewers cannot modify task assignments');
                }
            }
        }

        if (!todo.assignees) todo.assignees = [];

        if (email) {
           
            const normalizedEmail = email.toLowerCase().trim();
            const targetUser = await UserModel.findOne({ email: normalizedEmail });
            if (targetUser) {
                todo.assignees = todo.assignees.filter(
                    id => id.toString() !== (targetUser._id as any).toString()
                );
            }
        } else {
           
            todo.assignees = [];
        }

        if (todo.assignees.length === 0) {
            todo.assignedAt = null as any;
           
        }

        await todo.save();

        const updatedTodo = await TodoModel.findById(todoId)
            .populate('assignees', 'name email avatar')
            .populate('tags', 'name')
            .lean();

        res.status(200).json({
            success: true,
            data: updatedTodo,
            message: email ? `Assignee removed` : 'All assignees removed'
        });

    } catch (err) {
        next(err);
    }
};

