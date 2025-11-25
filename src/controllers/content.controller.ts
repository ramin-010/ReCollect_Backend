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
        // If it's already parsed (object/array), return it
        if (typeof data === "object" && data !== null) return data as T;
        // If it's a string, parse it
        if (typeof data === "string") return JSON.parse(data) as T;
        // Otherwise return fallback
        return fallback;
    } catch (err) {
        return fallback;
    }
}

export const addContent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const data = req.body as ContentInput;
        const user = req.user?._id as string;

        const dashId = data.DashId;
        const title = data.title.trim();
        const description = data.description ? data.description.trim() : '';

        if (!dashId) throw new ErrorResponse(400, "DashId is missing");
        if (!title) throw new ErrorResponse(400, "Title can't be empty");

        // 1. Parallelize Validation Checks
        const [dashboard, exist] = await Promise.all([
            dashboardSchema.findById(dashId).select('contents').lean().session(session),
            ContentModel.exists({
                _id: { $in: (await dashboardSchema.findById(dashId).select('contents').lean().session(session) as any)?.contents || [] },
                title: title
            }).session(session)
        ]);

        if (!dashboard) throw new ErrorResponse(404, "Dashboard not found");
        if (exist) throw new ErrorResponse(400, 'Content title already exists');

        const files = req.files as Record<string, Express.Multer.File[]>;
        const imageBlockIds = ParseJson<string[]>(data.imageBlockIds, []);
        let blocks = ParseJson<IBlock[]>(data.body, []);
        const tags = ParseJson<string[]>(data.tags, []);
        const links = ParseJson<string[]>(data.links, []);

        // Prepare Image Map (Synchronous)
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

        // Map blocks (Synchronous)
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

        // 2. Parallelize Dependencies (Blocks & Tags)
        let populatedBody: any[] = [];
        let populatedTags: any[] = [];
        let dbData: ContentDBInput = {
            user: new mongoose.Types.ObjectId(user),
            title: title,
            description: description
        };

        const [createdBlocks, processedTags] = await Promise.all([
            // Create Blocks
            (async () => {
                if (blocks && blocks.length > 0) {
                    const res = await BlockSchema.create(blocks, { session, ordered: true });
                    return res;
                }
                return [];
            })(),
            // Process Tags
            (async () => {
                if (tags && tags.length > 0) {
                    const existingTags = await TagsModel.find({ name: { $in: tags } }).session(session).lean();
                    const existingTagNames = new Set(existingTags.map(t => t.name));
                    const newTagNames = tags.filter(name => !existingTagNames.has(name));

                    let newTags: any[] = [];
                    if (newTagNames.length > 0) {
                        newTags = await TagsModel.create(
                            newTagNames.map(name => ({ name })),
                            { session, ordered: true }
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

        // 3. Create Content
        const contentArray = await ContentModel.create([dbData], { session, ordered: true });
        const content = contentArray[0];
        if (!content) throw new ErrorResponse(400, "Unable to add content");
        const contentId = content._id as mongoose.Types.ObjectId;

        // 4. Parallelize Post-Actions (Reminder & Dashboard Update)
        const reminderPromise = (async () => {
            const reminderData = ParseJson<{ reminderDate: string; message?: string }>(data.reminderData, { reminderDate: "", message: '' });
            const reminderDate = reminderData.reminderDate ? new Date(reminderData.reminderDate) : undefined;

            if (reminderDate) {
                const reminderPayload = {
                    user: new mongoose.Types.ObjectId(user),
                    content: contentId,
                    dashboard: new mongoose.Types.ObjectId(dashId),
                    emailSent: false,
                    status: 'pending',
                    reminderDate: reminderDate,
                    message: reminderData.message
                };

                const [createdReminder] = await reminderSchema.create([reminderPayload], { session, ordered: true });

                if (!createdReminder) throw new ErrorResponse(400, "Unable to add reminder");
                // Schedule (Non-blocking ideally, but await for safety in this context)
                await scheduleReminder({
                    userId: user,
                    contentId: contentId,
                    dashboardId: dashId,
                    message: reminderPayload.message || `Don't forget to review: ${title}`,
                    remindAt: reminderDate,
                    reminderId: String(createdReminder._id) 
                });
            }
        })();

        const dashboardUpdatePromise = dashboardSchema.findByIdAndUpdate(
            dashId,
            { $push: { contents: contentId } },
            { new: true, runValidators: true, session }
        );

        await Promise.all([reminderPromise, dashboardUpdatePromise]);

        await session.commitTransaction();

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

        if (data.title && !data.title.trim()) {
            throw new ErrorResponse(400, "Title cannot be empty");
        }

        const existingContent = await ContentModel.findById(id).session(session);
        if (!existingContent) {
            throw new ErrorResponse(404, "Content not found");
        }

        let UpdateDbData: Partial<ContentDBUpdateInput> = {};

        if (data.title !== undefined) UpdateDbData.title = data.title.trim();
        if (data.description !== undefined) UpdateDbData.description = data.description.trim();
        if (data.links !== undefined)
            UpdateDbData.links = ParseJson<string[]>(data.links, []);
        if (data.visibility !== undefined) UpdateDbData.visibility = data.visibility;
        if (data.isPinned !== undefined) UpdateDbData.isPinned = data.isPinned;
        if (data.isArchived !== undefined)
            UpdateDbData.isArchived = data.isArchived;

        const files = req.files as Record<string, Express.Multer.File[]>;
        const imageBlockIds = ParseJson<string[]>(data.imageBlockIds, []);
        let blocks = ParseJson<IBlock[]>(data.body, []);
        const tags = ParseJson<string[]>(data.tags, []);

        const blockIdToUrlMap: Record<
            string,
            { url: string; cloudProvider?: string; cloudPublicId?: string }
        > = {};

        for (const blockId of imageBlockIds) {
            const fieldname = `image_${blockId}`;
            const fileArray = files[fieldname];

            if (fileArray && fileArray.length > 0) {
                const file = fileArray[0] as CloudFileOutput;
                blockIdToUrlMap[blockId] = {
                    url: file.cloudUrl || "",
                    cloudProvider: file.cloudProvider,
                    cloudPublicId: file.cloudPublicId,
                };
            }
        }

        blocks = blocks.map((block: IBlock) => {
            if (block.type === "image" && !block.isUploaded) {
                const imageData = blockIdToUrlMap[block.blockId];
                if (imageData) {
                    Object.assign(block, {
                        ...imageData,
                        isUploaded: true,
                    });
                }
            }
            return block;
        });

        const unuploadedImages = blocks.filter(
            (block) => block.type === "image" && !block.isUploaded
        );

        if (blocks.length > 0) {
            if (existingContent.body && existingContent.body.length) {
                await BlockSchema.deleteMany({
                    _id: { $in: existingContent.body },
                }).session(session);
            }
            const createdBlocks = await BlockSchema.create(blocks, {
                session,
                ordered: true,
            });
            UpdateDbData.body = createdBlocks.map(
                (block) => block._id as mongoose.Types.ObjectId
            );
        }

        if (tags && tags.length > 0) {
            const parsedTags = await TagsModel.find({ name: { $in: tags } }).session(
                session
            );
            const existingTagNames = new Set(parsedTags.map((t) => t.name));
            const newTagNames = tags.filter((name) => !existingTagNames.has(name));
            let newTags: any[] = [];
            if (newTagNames.length > 0) {
                newTags = await TagsModel.create(
                    newTagNames.map((name) => ({ name })),
                    { session, ordered: true }
                );
            }
            const allTags = [...parsedTags, ...newTags];
            UpdateDbData.tags = allTags.map(
                (tag) => tag._id as mongoose.Types.ObjectId
            );
        }

        const reminderData = ParseJson<{ reminderDate: string; message?: string }>(
            data.reminderData,
            { reminderDate: "", message: "" }
        );
        const reminderDateStr = reminderData.reminderDate;
        const reminder_msg = reminderData.message;
        let reminderDate: Date | undefined;
        if (reminderDateStr) reminderDate = new Date(reminderDateStr);

        const updatedContent = await ContentModel.findByIdAndUpdate(
            id,
            { $set: UpdateDbData },
            { new: true, runValidators: true, session }
        );

        if (!updatedContent) {
            throw new ErrorResponse(400, "Failed to update content");
        }

        if (reminderDate) {
            const reminder = await reminderSchema
                .findOne({
                    content: updatedContent._id,
                    user: new mongoose.Types.ObjectId(user),
                })
                .session(session);

            const reminderPayload: Partial<ReminderCreateInput> = {
                user: new mongoose.Types.ObjectId(user),
                content: updatedContent._id as mongoose.Types.ObjectId,
                dashboard: new mongoose.Types.ObjectId(dashId),
                reminderDate,
                emailSent: false,
                status: "pending",
            };

            if (reminder_msg !== undefined) reminderPayload.message = reminder_msg;

            if (reminder) {
                Object.assign(reminder, reminderPayload);
                await reminder.save({ session });
            } else {
                reminderPayload.message ||= `Don't forget to review: ${updatedContent.title}`;
                await reminderSchema.create([reminderPayload], {
                    session,
                    ordered: true,
                });
            }


            await scheduleReminder({
                userId: user,
                contentId: updatedContent._id as mongoose.Types.ObjectId,
                dashboardId: new mongoose.Types.ObjectId(dashId),
                message: reminderPayload.message || `Don't forget to review: ${updatedContent.title}`,
                remindAt: reminderDate
            });
        }

        await session.commitTransaction();

        res.status(200).json({
            success: true,
            data: updatedContent,
            message: "content successfully updated",
            unuploadedImages: unuploadedImages.length,
        });
    } catch (err: any) {
        await session.abortTransaction();
        next(err);
    } finally {
        session.endSession();
    }
};

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

        if (!DashId) {
            throw new ErrorResponse(400, "DashId is missing");
        }

        const dashboardUpdate = await dashboardSchema.findByIdAndUpdate(
            DashId,
            { $pull: { contents: id } },
            { new: true, runValidators: true, session }
        );

        if (!dashboardUpdate) {
            throw new ErrorResponse(400, "Failed to delete the content from the dashboard");
        }

        const deletedContent = await ContentModel.findByIdAndDelete(id).session(session);

        if (!deletedContent) {
            throw new ErrorResponse(404, "Content not found");
        }

        if (deletedContent.body && deletedContent.body.length > 0) {
            await BlockSchema.deleteMany({ _id: { $in: deletedContent.body } }).session(session);
        }

        await reminderSchema
            .deleteMany({ content: deletedContent._id })
            .session(session);

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
