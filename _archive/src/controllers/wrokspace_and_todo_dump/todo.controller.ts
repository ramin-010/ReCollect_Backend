// import { Request, Response, NextFunction } from 'express';
// import mongoose from 'mongoose';
// import TodoModel from '../models/todoSchema';
// import WorkspaceModel from '../models/workspaceSchema';
// import ActivityLogModel from '../models/activityLogSchema';
// import ErrorResponse from '../utils/errorResponse';
// import reminderSchema from '../models/reminderSchema';
// import { scheduleTodoReminder } from '../services/reminderService';
// import cloudinary from '../utils/cloudinary';
// import TagsModel from '../models/tagsSchema';

// interface CloudFileOutput extends Express.Multer.File {
//     cloudUrl: string;
//     cloudProvider: string;
//     cloudPublicId: string;
// }

// const parseJson = <T>(data: any, fallback: T): T => {
//     try {
//         if (typeof data === "object" && data !== null) return data as T;
//         if (typeof data === "string") return JSON.parse(data) as T;
//         return fallback;
//     } catch {
//         return fallback;
//     }
// };

// export const deleteFromCloud = async (publicId: string): Promise<void> => {
//     try {
//         return new Promise((resolve, reject) => {
//             cloudinary.uploader.destroy(publicId, { invalidate: true }, (err: any, result: any) => {
//                 if (err) {
//                     reject(err);
//                 } else {
//                     resolve();
//                 }
//             });
//         });
//     } catch (error) {
//         throw error;
//     }
// }

// export const batchDeleteFromCloud = async (publicIds: string[]): Promise<void> => {
//     if (publicIds.length === 0) return;
    
//     const deletePromises = publicIds.map(id => 
//         deleteFromCloud(id).catch(err => {
//             console.error(`Failed to delete ${id}:`, err);
//         })
//     );
    
//     await Promise.allSettled(deletePromises);
// }

// export const createTodo = async (
//     req: Request,
//     res: Response,
//     next: NextFunction
// ): Promise<void> => {
//     const session = await mongoose.startSession();
//     session.startTransaction();
    
//     try {
//         const userId = req.user?._id as string;

//         let { 
//             title, 
//             description,
//             status,
//             priority,
//             dueDate,
//             reminderDate,
//             subtasks,
//             tags, 
//             assignees, // Now an array of User IDs or Emails
//             recurrence,
//             imageNodeIds,
//             references,
//             workspace,
//             spaceId,
//             visibility
//         } = req.body;

//         subtasks = parseJson<any[]>(subtasks, []);
//         references = parseJson<any[]>(references, []);
//         tags = parseJson<string[]>(tags, []);
//         recurrence = parseJson<any>(recurrence, null);
//         imageNodeIds = parseJson<string[]>(imageNodeIds, []);

//         if (!title || !title.trim()) {
//             throw new ErrorResponse(400, "Task title is required");
//         }

//         const files = req.files as Record<string, Express.Multer.File[]> | undefined;
//         const cloudImages: { imageId: string; cloudUrl: string; cloudPublicId: string }[] = [];
        
//         if (files && imageNodeIds.length > 0 && description) {
//             const imageUrlMap: Record<string, { url: string; publicId: string }> = {};
            
//             for (const imageId of imageNodeIds) {
//                 const fieldName = `image_${imageId}`;
//                 const fileArray = files[fieldName];
                
//                 if (fileArray && fileArray.length > 0) {
//                     const file = fileArray[0] as CloudFileOutput;
                    
//                     if (file.cloudUrl && file.cloudPublicId) {
//                         imageUrlMap[imageId] = {
//                             url: file.cloudUrl,
//                             publicId: file.cloudPublicId,
//                         };
//                         cloudImages.push({
//                             imageId,
//                             cloudUrl: file.cloudUrl,
//                             cloudPublicId: file.cloudPublicId,
//                         });
//                     }
//                 }
//             }

//             for (const [imageId, data] of Object.entries(imageUrlMap)) {
//                 const pattern = new RegExp(`__PENDING_UPLOAD_${imageId}__`, 'g');
//                  description = description.replace(pattern, data.url);
//             }
//         }

//         const parsedReminderDate = reminderDate ? new Date(reminderDate) : null;
        
//         const parsedReferences = (references || []).map((ref: any) => ({
//             type: ref.type,
//             refId: new mongoose.Types.ObjectId(ref.refId),
//             title: ref.title || undefined
//         }));
        
//         // Process Tags
//         let populatedTags: mongoose.Types.ObjectId[] = [];
//         if (tags && tags.length > 0) {
//             const existingTags = await TagsModel.find({ name: { $in: tags } }).session(session).lean();
//             const existingTagNames = new Set(existingTags.map(t => t.name));
//             const newTagNames = tags.filter((name: string) => !existingTagNames.has(name));

//             let newTags: any[] = [];
//             if (newTagNames.length > 0) {
//                 newTags = await TagsModel.insertMany(
//                     newTagNames.map((name: string) => ({ name })),
//                     { session, ordered: false }
//                 );
//             }
//             populatedTags = [...existingTags, ...newTags].map(t => t._id as mongoose.Types.ObjectId);
//         }
        
//         const todoData = {
//             user: new mongoose.Types.ObjectId(userId),
//             title: title.trim(),
//             description: description || null,
//             status: status || 'pending',
//             priority: priority || 'medium',
//             dueDate: dueDate ? new Date(dueDate) : null,
//             reminderDate: parsedReminderDate,
//             subtasks: subtasks || [],
//             tags: populatedTags,
//             recurrence: recurrence || null,
//             cloudImages: cloudImages.map(img => ({ imageId: img.imageId, cloudPublicId: img.cloudPublicId })),
//             assignees: Array.isArray(assignees) ? assignees.map((id: string) => new mongoose.Types.ObjectId(id)) : [],
//             assignedAt: assignees && assignees.length > 0 ? new Date() : null,
//             references: parsedReferences,
//             workspace: null, // Personal tasks have no workspace
//             spaceId: null,
//             visibility: visibility === 'shared' ? 'shared' : 'private',
//         };

//         const [todo] = await TodoModel.create([todoData], { session });
        
//         if (!todo) {
//             throw new ErrorResponse(400, "Failed to create task");
//         }

//         let reminderScheduleData: { reminderId: mongoose.Types.ObjectId; remindAt: Date } | null = null;
        
//         if (parsedReminderDate) {
//             if (isNaN(parsedReminderDate.getTime())) {
//                 throw new ErrorResponse(400, "Invalid reminder date");
//             }

//             const reminderPayload = {
//                 user: new mongoose.Types.ObjectId(userId),
//                 type: 'todo' as const,
//                 todoId: todo._id as mongoose.Types.ObjectId,
//                 reminderDate: parsedReminderDate,
//                 message: `Reminder: ${title.trim()}`,
//                 emailSent: false,
//                 status: 'pending' as const,
//             };

//             const [createdReminder] = await reminderSchema.create([reminderPayload], { session });
            
//             if (!createdReminder) {
//                 throw new ErrorResponse(400, "Failed to create reminder");
//             }

//             reminderScheduleData = {
//                 reminderId: createdReminder._id as mongoose.Types.ObjectId,
//                 remindAt: parsedReminderDate,
//             };
//         }

//         await session.commitTransaction();

//         // (Workspace Activity Logging is now handled in workspaceTodo.controller.ts)

//         if (reminderScheduleData) {
//             scheduleTodoReminder(reminderScheduleData).catch(err => {
//                 console.error("Failed to schedule todo reminder:", err);
//             });
//         }

//         res.status(201).json({
//             success: true,
//             data: todo,
//             message: 'Task created successfully'
//         });

//     } catch (err) {
//         await session.abortTransaction();
//         next(err);
//     } finally {
//         session.endSession();
//     }
// };


// export const getTodos = async (
//     req: Request,
//     res: Response,
//     next: NextFunction
// ): Promise<void> => {
//     try {
//         const userId = req.user?._id as string;
//         const { status, priority, refType, refId } = req.query;

//         const oid = new mongoose.Types.ObjectId(userId);

//         const matchFilter: any = {
//             $or: [
//                 { user: new mongoose.Types.ObjectId(String(userId)) },
//                 { assignees: new mongoose.Types.ObjectId(String(userId)) }
//             ],
//             visibility: { $in: ['private', 'shared', null, undefined] } // Strictly prevent workspace tasks from bleeding in
//         };

//         if (status && ['pending', 'complete'].includes(status as string)) {
//             matchFilter.status = status;
//         }

//         if (priority && ['low', 'medium', 'high'].includes(priority as string)) {
//             matchFilter.priority = priority;
//         }

//         if (refType && refId && ['doc', 'content', 'slide'].includes(refType as string)) {
//             matchFilter['references'] = {
//                 $elemMatch: {
//                     type: refType,
//                     refId: new mongoose.Types.ObjectId(refId as string)
//                 }
//             };
//         }

//             const todos = await TodoModel.find(matchFilter)
//                 .populate('tags', 'name color')
//                 .populate('assignees', 'name email avatar')
//                 .sort({ updatedAt: -1 })
//                 .exec();

//         res.status(200).json({
//             success: true,
//             data: todos,
//             count: todos.length
//         });
//     } catch (err) {
//         next(err);
//     }
// };


// export const updateTodo = async (
//     req: Request,
//     res: Response,
//     next: NextFunction
// ): Promise<void> => {
//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const userId = req.user?._id;
//         const { id: todoId } = req.params;

//         if (!userId) {
//             throw new ErrorResponse(401, "Unauthorized");
//         }

//             const existingTodo = await TodoModel.findOne({
//                 _id: todoId
//             }).session(session).lean();

//         if (!existingTodo) {
//             throw new ErrorResponse(404, "Task not found");
//         }

//         let hasPermission = false;
//         if (existingTodo.user.toString() === String(userId)) {
//             hasPermission = true;
//         } else if (existingTodo.assignees && existingTodo.assignees.some(a => a.toString() === String(userId))) {
//             hasPermission = true;
//         }

//         if (!hasPermission || existingTodo.visibility === 'workspace') {
//             throw new ErrorResponse(403, "You don't have permission to update this personal task");
//         }

//         const allowedUpdates = [
//             'title', 
//             'description', 
//             'status', 
//             'priority', 
//             'dueDate', 
//             'reminderDate', 
//             'subtasks', 
//             'tags', 
//             'assignees',
//             'recurrence',
//             'references',
//             'imageNodeIds',
//             'visibility' // Excludes workspace and spaceId
//         ];

//         const updates: Record<string, any> = {};
//         const todoUpdates: Record<string, any> = {}; // To hold updates for $set
//         let description = req.body.description;
        
//         const imageNodeIds = req.body.imageNodeIds ? parseJson<string[]>(req.body.imageNodeIds, []) : [];
//         const files = req.files as Record<string, Express.Multer.File[]> | undefined;



//         const newCloudImages: { imageId: string; cloudPublicId: string }[] = [];

//         if (files && imageNodeIds.length > 0 && description) {
//             const imageUrlMap: Record<string, { url: string; publicId: string }> = {};
            
//             for (const imageId of imageNodeIds) {
//                 const fieldName = `image_${imageId}`;
//                 const fileArray = files[fieldName];
                
//                 if (fileArray && fileArray.length > 0) {
//                     const file = fileArray[0] as CloudFileOutput;
//                     if (file.cloudUrl && file.cloudPublicId) {
//                          imageUrlMap[imageId] = {
//                             url: file.cloudUrl,
//                             publicId: file.cloudPublicId,
//                         };
//                          newCloudImages.push({
//                             imageId: imageId,
//                             cloudPublicId: file.cloudPublicId
//                         }); 
//                     }
//                 }
//             }

//             for (const [imageId, data] of Object.entries(imageUrlMap)) {
//                  const pattern = new RegExp(`__PENDING_UPLOAD_${imageId}__`, 'g');
//                  description = description.replace(pattern, data.url);
//             }
//         }
        
//         if (description !== undefined) {
//              todoUpdates.description = description;
//         }

//         if (newCloudImages.length > 0) {
//             updates.$push = { cloudImages: { $each: newCloudImages } };
//         }


//         for (const key of allowedUpdates) {
//              if (key === 'imageNodeIds') continue;
//              if (key === 'description') continue;

//             if (req.body[key] !== undefined) {
//                 const value = req.body[key];
//                 if (key === 'dueDate' || key === 'reminderDate') {
//                     if (value === 'null' || !value) {
//                         todoUpdates[key] = null;
//                     } else {
//                         const date = new Date(value);
//                         todoUpdates[key] = isNaN(date.getTime()) ? null : date;
//                     }
//                 } else if (key === 'assignees') {
//                     if (Array.isArray(value)) {
//                         todoUpdates.assignees = value.map((id: string) => new mongoose.Types.ObjectId(id));
//                         todoUpdates.assignedAt = value.length > 0 ? new Date() : null;
//                     } else {
//                         todoUpdates.assignees = [];
//                         todoUpdates.assignedAt = null;
//                     }
//                 } else if (key === 'subtasks' || key === 'references' || key === 'recurrence') {
//                      const parsed = parseJson(value, null) as any;
//                      if (key === 'references' && Array.isArray(parsed)) {
//                          todoUpdates[key] = parsed.map((ref: any) => ({
//                              type: ref.type,
//                              refId: new mongoose.Types.ObjectId(ref.refId),
//                              title: ref.title || undefined
//                          }));
//                      } else {
//                          todoUpdates[key] = parsed;
//                      }
//                 } else if (key === 'tags') {
//                      // Process Tags Update
//                      const rawTags = parseJson<string[]>(value, []);
//                      if (rawTags.length > 0) {
//                         const existingTags = await TagsModel.find({ name: { $in: rawTags } }).session(session).lean();
//                         const existingTagNames = new Set(existingTags.map(t => t.name));
//                         const newTagNames = rawTags.filter((name: string) => !existingTagNames.has(name));

//                         let newTags: any[] = [];
//                         if (newTagNames.length > 0) {
//                             newTags = await TagsModel.insertMany(
//                                 newTagNames.map((name: string) => ({ name })),
//                                 { session, ordered: false }
//                             );
//                         }
//                         todoUpdates.tags = [...existingTags, ...newTags].map(t => t._id as mongoose.Types.ObjectId);
//                      }
//                 } else if (key === 'spaceId') {
//                     if (value === 'null' || !value) {
//                         todoUpdates.spaceId = null;
//                     } else {
//                         todoUpdates.spaceId = new mongoose.Types.ObjectId(String(value));
//                     }
//                 } else {
//                     todoUpdates[key] = value;
//                 }
//             }
//         }

//         if (todoUpdates.status === 'complete' && existingTodo.status !== 'complete') {
//             todoUpdates.completedAt = new Date();
//         } else if (todoUpdates.status === 'pending' && existingTodo.status === 'complete') {
//             todoUpdates.completedAt = null;
//         }

//         // Merge todoUpdates into updates
//         updates.$set = todoUpdates;

//         let reminderScheduleData = null;
        
//         if (req.body.reminderDate !== undefined) {
//              await reminderSchema.deleteMany({ todoId: existingTodo._id }).session(session);
             
//              const newDate = todoUpdates.reminderDate;
//              if (newDate) {
//                  if (isNaN(new Date(newDate).getTime())) throw new ErrorResponse(400, "Invalid reminder date");
                 
//                  const [newReminder] = await reminderSchema.create([{
//                      user: new mongoose.Types.ObjectId(String(userId)),
//                      type: 'todo',
//                      todoId: existingTodo._id,
//                      reminderDate: newDate,
//                      message: `Reminder: ${(todoUpdates.title || existingTodo.title).trim()}`,
//                      emailSent: false,
//                      status: 'pending'
//                  }], { session });

//                  if (!newReminder) {
//                      throw new ErrorResponse(400, "Failed to create reminder");
//                  }

//                  reminderScheduleData = {
//                      reminderId: newReminder._id as mongoose.Types.ObjectId,
//                      remindAt: newDate
//                  };
//              }
//         }

//         const updatedTodo = await TodoModel.findByIdAndUpdate(
//             todoId,
//             updates,
//             { new: true, runValidators: true, session }
//         ).lean();
        
//         if (!updatedTodo) {
//             throw new ErrorResponse(404, "Task not found");
//         }
        
//         await session.commitTransaction();

//         // (Workspace Activity Logging is now handled in workspaceTodo.controller.ts)

//         if (reminderScheduleData) {
//             scheduleTodoReminder(reminderScheduleData).catch(err => console.error(err));
//         }

//         res.status(200).json({
//             success: true,
//             data: updatedTodo,
//             message: 'Task updated successfully'
//         });
//     } catch (err) {
//         await session.abortTransaction();
//         next(err);
//     } finally {
//         session.endSession();
//     }
// };


// export const deleteTodo = async (
//     req: Request,
//     res: Response,
//     next: NextFunction
// ): Promise<void> => {
//     const session = await mongoose.startSession();
//     session.startTransaction();

//     try {
//         const userId = req.user?._id;
//         const { id } = req.params;

//         if (!userId) {
//             throw new ErrorResponse(401, "Unauthorized");
//         }

//         const todoToDelete = await TodoModel.findOne({
//             _id: new mongoose.Types.ObjectId(id)
//         }).session(session).lean();

//         if (!todoToDelete) {
//              throw new ErrorResponse(404, "Task not found");
//         }

//         let hasPermission = false;
//         if (todoToDelete.user.toString() === String(userId)) {
//             hasPermission = true;
//         }

//         if (!hasPermission || todoToDelete.visibility === 'workspace') {
//             throw new ErrorResponse(403, "You don't have permission to delete this personal task");
//         }

//         const cleanupPromises: Promise<any>[] = [];

//         if (todoToDelete.cloudImages && todoToDelete.cloudImages.length > 0) {
//             const publicIds = todoToDelete.cloudImages.map(img => img.cloudPublicId);
//             cleanupPromises.push(batchDeleteFromCloud(publicIds));
//         }

//         cleanupPromises.push(reminderSchema.deleteMany({ todoId: todoToDelete._id }).session(session));

//         cleanupPromises.push(TodoModel.deleteOne({ _id: todoToDelete._id }).session(session));

//         await Promise.all(cleanupPromises);

//         await session.commitTransaction();

//         res.status(200).json({
//             success: true,
//             message: 'Task deleted successfully'
//         });
//     } catch (err) {
//         await session.abortTransaction();
//         next(err);
//     } finally {
//         session.endSession();
//     }
// };
