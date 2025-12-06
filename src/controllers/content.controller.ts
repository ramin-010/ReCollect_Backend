import ContentModel, { Content as ContentType } from '../models/contentSchema';
import { Request, Response, NextFunction } from 'express';
import ErrorResponse from '../utils/errorResponse';
import TagsModel from '../models/tagsSchema'
import { file, string, success } from 'zod';
import mongoose, { mongo } from 'mongoose';
import dashboardSchema from '../models/dashboardSchema';
import BlockSchema, { IBlock } from '../models/canvasBlockSchema';
import reminderSchema, { Reminder as ReminderType } from '../models/reminderSchema';
import { scheduleReminder } from '../services/reminderService';
import cloudinary from '../utils/cloudinary';
import User from '../models/userSchema';

export type ContentInput = {
    title: string;
    description?: string;
    body?: mongoose.Types.ObjectId[];
    tags?: string[];
    links?: string[];
    isPinned?: boolean;
    isArchived?: boolean;
    visibility?: 'Public' | 'Private';
    DashId: string,
    imageBlockIds?: string[];
    reminderData?: string,
    upsertBlocks?: string;
    finalBlockOrder?: string;
}

type UpdateInput = Partial<ContentInput>

type ContentDBInput = Omit<ContentInput, 'tags' | 'DashId'> & {
    user: mongoose.Types.ObjectId,
    tags?: mongoose.Types.ObjectId[],

}

type ContentDBUpdateInput = Omit<ContentInput, 'tags'> & {
    tags?: mongoose.Types.ObjectId[];
}

interface CloudFileOutput extends Express.Multer.File {
    cloudUrl: string,
    cloudProvider: string,
    cloudPublicId: string
}

type ReminderCreateInput = {
    user: mongoose.Types.ObjectId;
    content: mongoose.Types.ObjectId;
    dashboard: mongoose.Types.ObjectId;
    reminderDate: Date;
    message?: string;
    emailSent: boolean;
    status: 'pending' | 'sent' | 'failed' | 'cancelled';
};

const ParseJson = <T>(data: any, fallback: T): T => {
    try {
        if (typeof data === "object" && data !== null) return data as T;
        if (typeof data === "string") return JSON.parse(data) as T;
        return fallback;
    } catch (err) {
        return fallback;
    }
}

const deleteFromCloud = async (publicId: string): Promise<void> => {
    try {
        console.log("Deleting from cloud:", publicId);
        return new Promise((resolve, reject) => {
            cloudinary.uploader.destroy(publicId, { invalidate: true }, (err: any, result: any) => {
                if (err) {
                    console.error("Cloud deletion error:", err);
                    reject(err);
                } else {
                    console.log("Cloud deletion result:", result);
                    resolve();
                }
            });
        });
    } catch (error) {
        console.error("Failed to delete from cloud:", publicId, error);
        throw error;
    }
}

const batchDeleteFromCloud = async (publicIds: string[]): Promise<void> => {
    if (publicIds.length === 0) return;
    
    const deletePromises = publicIds.map(id => 
        deleteFromCloud(id).catch(err => {
            console.error(`Failed to delete ${id}:`, err);
        })
    );
    
    await Promise.allSettled(deletePromises);
}

const validateInputs = (data: ContentInput, isUpdate: boolean = false) => {
    if (!data.DashId || !mongoose.Types.ObjectId.isValid(data.DashId)) {
        throw new ErrorResponse(400, "Invalid or missing DashId");
    }
    
    if (!isUpdate && (!data.title || !data.title.trim())) {
        throw new ErrorResponse(400, "Title is required");
    }
    
    if (isUpdate && data.title !== undefined && !data.title.trim()) {
        throw new ErrorResponse(400, "Title cannot be empty");
    }
}

export const addContent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {

        console.log('files', req.files); 
        const data = req.body as ContentInput;
        const user = req.user?._id as string;

        validateInputs(data);

        const dashId = data.DashId;
        const title = data.title.trim();
        const description = data.description ? data.description.trim() : '';

        const [dashboard, exist] = await Promise.all([
            dashboardSchema.findById(dashId).select('contents').lean().session(session),
            ContentModel.exists({
                title: title,
                _id: { $in: (await dashboardSchema.findById(dashId).select('contents').lean().session(session) as any)?.contents || [] }
            }).session(session)
        ]);

        if (!dashboard) throw new ErrorResponse(404, "Dashboard not found");
        if (exist) throw new ErrorResponse(400, 'Content title already exists');

        const files = req.files as Record<string, Express.Multer.File[]>;
        const imageBlockIds = ParseJson<string[]>(data.imageBlockIds, []);
        let blocks = ParseJson<IBlock[]>(data.body, []);
        const tags = ParseJson<string[]>(data.tags, []);
        const links = ParseJson<string[]>(data.links, []);

        if (blocks.some(b => !b.blockId || !b.type)) {
            throw new ErrorResponse(400, "Invalid block data");
        }

        const blockIdToUrlMap: Record<string, { url: string; cloudProvider?: string; cloudPublicId?: string; }> = {};
        for (const blockId of imageBlockIds) {
            const fieldname = `image_${blockId}`;
            const fileArray = files[fieldname];
            if (fileArray && fileArray.length > 0) {
                const file = fileArray[0] as CloudFileOutput;
                blockIdToUrlMap[blockId] = {
                    url: file.cloudUrl || '',
                    cloudProvider: file.cloudProvider,
                    cloudPublicId: file.cloudPublicId,
                };
            }
        }

        blocks = blocks.map((block: IBlock) => {
            if (block.type === 'image' && !block.isUploaded) {
                const imageData = blockIdToUrlMap[block.blockId];
                if (imageData) {
                    Object.assign(block, { ...imageData, isUploaded: true });
                }
            }
            return block;
        });

        const unuploadedImages = blocks.filter(block => block.type === 'image' && !block.isUploaded);

       
        let populatedBody: any[] = [];
        let populatedTags: any[] = [];
        let dbData: ContentDBInput = {
            user: new mongoose.Types.ObjectId(user),
            title: title,
            description: description
        };

        const [createdBlocks, processedTags] = await Promise.all([
            (async () => {
                if (blocks && blocks.length > 0) {
                    const res = await BlockSchema.insertMany(blocks, { session, ordered: false });
                    return res;
                }
                return [];
            })(),
            (async () => {
                if (tags && tags.length > 0) {
                    const existingTags = await TagsModel.find({ name: { $in: tags } }).session(session).lean();
                    const existingTagNames = new Set(existingTags.map(t => t.name));
                    const newTagNames = tags.filter(name => !existingTagNames.has(name));

                    let newTags: any[] = [];
                    if (newTagNames.length > 0) {
                        newTags = await TagsModel.insertMany(
                            newTagNames.map(name => ({ name })),
                            { session, ordered: false }
                        );
                    }
                    return [...existingTags, ...newTags];
                }
                return [];
            })()
        ]);

        if (createdBlocks.length > 0) {
            dbData.body = createdBlocks.map(b => b._id as mongoose.Types.ObjectId);
            populatedBody = createdBlocks;
        }

        if (processedTags.length > 0) {
            dbData.tags = processedTags.map(t => t._id as mongoose.Types.ObjectId);
            populatedTags = processedTags;
        }

        if (links !== undefined) dbData.links = links;
        if (data.visibility !== undefined) dbData.visibility = data.visibility;

        const contentArray = await ContentModel.create([dbData], { session, ordered: true });
        const content = contentArray[0];
        if (!content) throw new ErrorResponse(400, "Unable to add content");
        const contentId = content._id as mongoose.Types.ObjectId;

        const reminderPromise = (async () => {
            const reminderData = ParseJson<{ reminderDate: string; message?: string }>(data.reminderData, { reminderDate: "", message: '' });
            const reminderDate = reminderData.reminderDate ? new Date(reminderData.reminderDate) : undefined;

            if (reminderDate) {
                if (isNaN(reminderDate.getTime())) {
                    throw new ErrorResponse(400, "Invalid reminder date");
                }

                const reminderPayload = {
                    user: new mongoose.Types.ObjectId(user),
                    content: contentId,
                    dashboard: new mongoose.Types.ObjectId(dashId),
                    emailSent: false,
                    status: 'pending' as const,
                    reminderDate: reminderDate,
                    message: reminderData.message
                };

                const [createdReminder] = await reminderSchema.create([reminderPayload], { session, ordered: true });

                if (!createdReminder) throw new ErrorResponse(400, "Unable to add reminder");
                
                return {
                    userId: user,
                    contentId: contentId,
                    dashboardId: dashId,
                    message: reminderPayload.message || `Don't forget to review: ${title}`,
                    remindAt: reminderDate,
                    reminderId: String(createdReminder._id)
                };
            }
            return null;
        })();

        const dashboardUpdatePromise = dashboardSchema.findByIdAndUpdate(
            dashId,
            { $push: { contents: contentId } },
            { new: true, runValidators: true, session }
        );

        const [reminderScheduleData] = await Promise.all([reminderPromise, dashboardUpdatePromise]);

        await session.commitTransaction();

        if (reminderScheduleData) {
            scheduleReminder(reminderScheduleData).catch(err => {
                console.error("Failed to schedule reminder:", err);
            });
        }

        const contentResponse = content.toObject();
        contentResponse.body = populatedBody;
        contentResponse.tags = populatedTags;

        res.status(200).json({
            success: true,
            data: contentResponse,
            message: 'content successfully added',
            unuploadedImages: unuploadedImages.length
        });

    } catch (err: any) {
        await session.abortTransaction();
        next(err);
    } finally {
        session.endSession();
    }
}

export const updateContent = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { id } = req.params;
        const data = req.body as UpdateInput;
        const user = req.user?._id as string;
        const dashId = data.DashId;

        validateInputs(data as ContentInput, true);
        
        if (!mongoose.Types.ObjectId.isValid(id as string)) {
            throw new ErrorResponse(400, "Invalid content ID");
        }

        const existingContent = await ContentModel.findById(id).session(session);
        if (!existingContent) {
            throw new ErrorResponse(404, "Content not found");
        }

        let updateDbData: Partial<ContentDBUpdateInput> = {};
        
        if (data.title !== undefined) updateDbData.title = data.title.trim();
        if (data.description !== undefined) updateDbData.description = data.description.trim();
        if (data.links !== undefined) updateDbData.links = ParseJson<string[]>(data.links, []);
        if (data.visibility !== undefined) updateDbData.visibility = data.visibility;
        if (data.isPinned !== undefined) updateDbData.isPinned = data.isPinned;
        if (data.isArchived !== undefined) updateDbData.isArchived = data.isArchived;

        const files = req.files as Record<string, Express.Multer.File[]>;
        const imageBlockIds = data.imageBlockIds ? ParseJson<string[]>(data.imageBlockIds, []) : [];
        
        const blockIdToUrlMap: Record<string, { url: string; cloudProvider?: string; cloudPublicId?: string; }> = {};
        if (imageBlockIds.length > 0) {
            for (const blockId of imageBlockIds) {
                const fieldname = `image_${blockId}`;
                const fileArray = files[fieldname];
                if (fileArray && fileArray.length > 0) {
                    const file = fileArray[0] as CloudFileOutput;
                    blockIdToUrlMap[blockId] = {
                        url: file.cloudUrl || '',
                        cloudProvider: file.cloudProvider,
                        cloudPublicId: file.cloudPublicId,
                    };
                }
            }
        }

        const [processedTags, { processedBlocks, finalBlockOrderIds }] = await Promise.all([
            (async () => {
                if (data.tags === undefined) return undefined;
                
                const rawTags = ParseJson<string[]>(data.tags, []);
                if (rawTags.length === 0) return [];

                const existingTags = await TagsModel.find({ 
                    name: { $in: rawTags } 
                }).session(session).lean();
                
                const existingTagNames = new Set(existingTags.map((t: any) => t.name));
                const newTagNames = rawTags.filter((name: string) => !existingTagNames.has(name));

                let newTags: any[] = [];
                if (newTagNames.length > 0) {
                    newTags = await TagsModel.insertMany(
                        newTagNames.map((name: string) => ({ name })),
                        { session, ordered: false }
                    );
                }

                return [...existingTags, ...newTags];
            })(),

            (async (): Promise<{ processedBlocks: IBlock[] | undefined; finalBlockOrderIds: mongoose.Types.ObjectId[] | undefined }> => {
                if (data.finalBlockOrder === undefined) {
                    return { processedBlocks: undefined, finalBlockOrderIds: undefined };
                }

                const upsertBlocks = data.upsertBlocks ? ParseJson<IBlock[]>(data.upsertBlocks, []) : [];
                const finalBlockOrder = ParseJson<string[]>(data.finalBlockOrder, []);

                console.log("upsertBlocks", upsertBlocks);
               
                if (finalBlockOrder.length === 0) {
                    return { processedBlocks: [], finalBlockOrderIds: [] };
                }

                const bulkOps = upsertBlocks.map((blockData: IBlock) => {
                    const imageData = blockIdToUrlMap[blockData.blockId];
                    
                    const updatePayload: any = {
                        type: blockData.type,
                        x: blockData.x,
                        y: blockData.y,
                        width: blockData.width,
                        height: blockData.height,
                        fontSize : blockData.fontSize,
                    };

                    if (blockData.content !== undefined) updatePayload.content = blockData.content;
                    if (blockData.imageId !== undefined) updatePayload.imageId = blockData.imageId;

                    if (imageData) {
                        updatePayload.url = imageData.url;
                        updatePayload.isUploaded = true;
                        updatePayload.cloudProvider = imageData.cloudProvider;
                        updatePayload.cloudPublicId = imageData.cloudPublicId;
                    } else if (blockData.url) {
                        updatePayload.url = blockData.url;
                        updatePayload.isUploaded = blockData.isUploaded ?? false;
                    }
                    
                    return {
                        updateOne: {
                            filter: { blockId: blockData.blockId },
                            update: { $set: updatePayload },
                            upsert: true
                        }
                    };
                });

                if (bulkOps.length > 0) {
                    await BlockSchema.bulkWrite(bulkOps, { session, ordered: false });
                }

                const allBlocksInOrder = await BlockSchema.find({
                    blockId: { $in: finalBlockOrder }
                }).session(session).lean();

                const blockMap = new Map(allBlocksInOrder.map(b => [b.blockId, b]));

                const finalIds: mongoose.Types.ObjectId[] = [];
                const finalBlocks: any[] = [];

                for (const blockId of finalBlockOrder) {
                    const block = blockMap.get(blockId);
                    if (block) {
                        finalIds.push(block._id as mongoose.Types.ObjectId);
                        finalBlocks.push(block);
                    }
                }

                const oldBlockIds = existingContent.body.map(id => id.toString());
                const newBlockIdsSet = new Set(finalIds.map(id => id.toString()));
                const blocksToDelete = oldBlockIds.filter(id => !newBlockIdsSet.has(id));
                
                if (blocksToDelete.length > 0) {
                    console.log('Deleting blocks:', blocksToDelete.length);
                    try {
                        const blocks = await BlockSchema.find({ 
                            _id: { $in: blocksToDelete } 
                        }).session(session).lean<IBlock[]>();
                        
                        const cloudPublicIds = blocks
                            .filter((block) => block?.type === 'image' && block?.cloudPublicId)
                            .map((block) => block.cloudPublicId as string);
                        
                        if (cloudPublicIds.length > 0) {
                            console.log('Deleting from cloud:', cloudPublicIds.length);
                            await batchDeleteFromCloud(cloudPublicIds);
                        }
                        
                        await BlockSchema.deleteMany({ 
                            _id: { $in: blocksToDelete } 
                        }).session(session);
                    } catch (err: any) {
                        console.error('Error deleting blocks:', err);
                        throw new ErrorResponse(400, `Error while deleting blocks: ${err.message}`);
                    }
                }

                return { processedBlocks: finalBlocks, finalBlockOrderIds: finalIds };
            })()
        ]);

        if (processedTags !== undefined) {
            updateDbData.tags = processedTags.map(t => t._id as mongoose.Types.ObjectId);
        }
        if (finalBlockOrderIds !== undefined) {
            updateDbData.body = finalBlockOrderIds;
        }

        const updatedContent = await ContentModel.findByIdAndUpdate(
            id,
            { $set: updateDbData },
            { new: true, runValidators: true, session }
        );

        if (!updatedContent) throw new ErrorResponse(400, "Failed to update content");

        let reminderScheduleData = null;
        if (data.reminderData !== undefined) {
            const reminderData = ParseJson<{ reminderDate: string; message?: string }>(data.reminderData, { reminderDate: "", message: '' });
            
            await reminderSchema.deleteMany({ content: id, user: user }).session(session);

            if (reminderData.reminderDate) {
                const reminderDate = new Date(reminderData.reminderDate);
                
                if (isNaN(reminderDate.getTime())) {
                    throw new ErrorResponse(400, "Invalid reminder date");
                }
                
                const reminderPayload = {
                    user: new mongoose.Types.ObjectId(user),
                    content: updatedContent._id,
                    dashboard: new mongoose.Types.ObjectId(dashId),
                    emailSent: false,
                    status: 'pending' as const,
                    reminderDate: reminderDate,
                    message: reminderData.message || `Don't forget to review: ${updatedContent.title}`
                };

                const [createdReminder] = await reminderSchema.create([reminderPayload], { session });
                
                if (!createdReminder) throw new ErrorResponse(400, "Failed to create reminder");
                
                reminderScheduleData = {
                    userId: user,
                    contentId: updatedContent._id as mongoose.Types.ObjectId,
                    dashboardId: reminderPayload.dashboard as mongoose.Types.ObjectId,
                    message: reminderPayload.message,
                    remindAt: reminderDate,
                     reminderId: String(createdReminder._id)
                };
            }
        }

        // Sync User schema arrays when isPinned or isArchived changes
        const userUpdateOps: any = {};
        
        if (data.isPinned !== undefined) {
            if (data.isPinned) {
                // Add to favoriteNotes if not already there
                userUpdateOps.$addToSet = { ...(userUpdateOps.$addToSet || {}), favoriteNotes: id };
            } else {
                // Remove from favoriteNotes
                userUpdateOps.$pull = { ...(userUpdateOps.$pull || {}), favoriteNotes: id };
            }
        }
        
        if (data.isArchived !== undefined) {
            if (data.isArchived) {
                // Add to archivedNotes if not already there
                userUpdateOps.$addToSet = { ...(userUpdateOps.$addToSet || {}), archivedNotes: id };
            } else {
                // Remove from archivedNotes
                userUpdateOps.$pull = { ...(userUpdateOps.$pull || {}), archivedNotes: id };
            }
        }

        // Apply user updates if any
        if (Object.keys(userUpdateOps).length > 0) {
            await User.findByIdAndUpdate(user, userUpdateOps, { session });
        }

        await session.commitTransaction();

        if (reminderScheduleData) {
            scheduleReminder(reminderScheduleData).catch(err => {
                console.error("Failed to schedule reminder:", err);
            });
        }

        const [fullBlocks, fullTags] = await Promise.all([
            processedBlocks !== undefined 
                ? Promise.resolve(processedBlocks)
                : updatedContent.body && updatedContent.body.length > 0
                    ? BlockSchema.find({ _id: { $in: updatedContent.body } }).lean()
                    : Promise.resolve([]),
            
            processedTags !== undefined
                ? Promise.resolve(processedTags)
                : updatedContent.tags && updatedContent.tags.length > 0
                    ? TagsModel.find({ _id: { $in: updatedContent.tags } }).lean()
                    : Promise.resolve([])
        ]);

        const responseData = updatedContent.toObject() as any;
        responseData.body = fullBlocks;
        responseData.tags = fullTags;

        res.status(200).json({
            success: true,
            data: responseData,
            message: 'Content successfully updated'
        });

    } catch (err: any) {
        await session.abortTransaction();
        next(err);
    } finally {
        session.endSession();
    }
}



export const deleteContent = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { id } = req.params;
        const { DashId } = req.body;

        if (!DashId || !mongoose.Types.ObjectId.isValid(DashId)) {
            throw new ErrorResponse(400, "Invalid or missing DashId");
        }
        
        if (!mongoose.Types.ObjectId.isValid(id as string)) {
            throw new ErrorResponse(400, "Invalid content ID");
        }

        const contentToDelete = await ContentModel.findById(id).session(session).lean();
        
        if (!contentToDelete) {
            throw new ErrorResponse(404, "Content not found");
        }

        await Promise.all([
            (async () => {
                if (contentToDelete.body && contentToDelete.body.length > 0) {
                    const blocks = await BlockSchema.find({ 
                        _id: { $in: contentToDelete.body } 
                    }).session(session).lean<IBlock[]>();

                    const cloudPublicIds = blocks
                        .filter((b) => b.type === 'image' && b.isUploaded && b.cloudPublicId)
                        .map((b) => b.cloudPublicId as string);

                    if (cloudPublicIds.length > 0) {
                        await batchDeleteFromCloud(cloudPublicIds);
                    }

                    await BlockSchema.deleteMany({ 
                        _id: { $in: contentToDelete.body } 
                    }).session(session);
                }
            })(),

            reminderSchema.deleteMany({ 
                content: contentToDelete._id 
            }).session(session),

            ContentModel.findByIdAndDelete(id).session(session),

            // Remove from user's archivedNotes and favoriteNotes
            User.findByIdAndUpdate(
                req.user?.id,
                {
                    $pull: {
                        archivedNotes: id,
                        favoriteNotes: id
                    }
                },
                { session }
            )
        ]);

        const dashboardUpdate = await dashboardSchema.findByIdAndUpdate(
            DashId,
            { $pull: { contents: id } },
            { new: true, runValidators: true, session }
        );

        if (!dashboardUpdate) {
            throw new ErrorResponse(400, "Failed to update dashboard");
        }

        await session.commitTransaction();

        res.status(200).json({
            success: true,
            message: "Content successfully deleted",
        });
    } catch (err: any) {
        await session.abortTransaction();
        next(err);
    } finally {
        session.endSession();
    }
};