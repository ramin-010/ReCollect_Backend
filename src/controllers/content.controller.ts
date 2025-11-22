import ContentModel, { Content as ContentType } from '../models/contentSchema';
import { Request, Response,NextFunction } from 'express';
import ErrorResponse from '../utils/errorResponse';
import TagsModel from '../models/tagsSchema'
import { file, string, success } from 'zod';
import mongoose, { mongo } from 'mongoose';
import dashboardSchema from '../models/dashboardSchema';
import BlockSchema,{IBlock } from '../models/canvasBlockSchema';
import RemiderSchema,{Reminder as ReminderType} from '../models/reminderSchema';
import reminderSchema from '../models/reminderSchema';

export type ContentInput = {        
  title: string;
  body?: mongoose.Types.ObjectId[];
  tags?: string[] ;
  links?: string[];
  isPinned?: boolean;
  isArchived?: boolean;
  visibility?: 'Public' | 'Private';
  DashId : string,
  imageBlockIds? : string[];
  reminderData ? : string,
}

type UpdateInput = Partial<ContentInput>

type ContentDBInput = Omit<ContentInput, 'tags' | 'DashId'> & {
    user : mongoose.Types.ObjectId,
    tags? : mongoose.Types.ObjectId[],
    
} 

type ContentDBUpdateInput = Omit<ContentInput, 'tags'> & {
    tags? : mongoose.Types.ObjectId[];
}

interface CloudFileOutput extends Express.Multer.File {
    cloudUrl : string,
    cloudProvider : string,
    cloudPublicId : string
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

export const addContent = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const data = req.body as ContentInput;
        const user = req.user?._id as string;

        const dashId  = data.DashId;
        const title_untrim = data.title;
        const title = title_untrim.trim();
           
        if(!dashId) throw new ErrorResponse(400, "DashId is missing");
        if (!title) throw new ErrorResponse(400, "Title can't be empty");

        const dashboard = await dashboardSchema.findById(dashId).session(session);
        if (!dashboard) {
            throw new ErrorResponse(404, "Dashboard not found");
        }

        const exist = await ContentModel.exists({
            _id: { $in: dashboard.contents },
            title: title
        }).session(session);

        console.log('exist', exist, title)
        if(exist){
            throw new ErrorResponse(400, 'Content title already exist')
        }
   

        const files = req.files as Record<string, Express.Multer.File[]>;
        const imageBlockIds = ParseJson<string[]>(data.imageBlockIds , []);
        let blocks = ParseJson<IBlock[]>(data.body, []);
        const tags = ParseJson<string[]>(data.tags , []);
        const links = ParseJson<string[]>(data.links, []); 

        interface ReminderParseData {
            reminderDate: string;
            message ? : string
        }

        const reminderData = ParseJson<ReminderParseData>(data.reminderData, {
            reminderDate: ""
        });

        const reminderDate_str = reminderData.reminderDate;
        const reminder_msg = reminderData.message;
        let reminderDate ;
        if(reminderDate_str) reminderDate = new Date(reminderDate_str);

        
        const blockIdToUrlMap: Record<string, {
            url: string;
            cloudProvider?: string;
            cloudPublicId?: string;
        }> = {};



        for(const blockId of imageBlockIds){
            const fieldname = `image_${blockId}`;
            const fileArray = files[fieldname];
 
            if (fileArray && fileArray.length > 0) {
                const file  = fileArray[0] as CloudFileOutput;
                
                const imageUrl = file.cloudUrl || '';
                
                blockIdToUrlMap[blockId] = {
                    url: imageUrl,
                    cloudProvider: file.cloudProvider,
                    cloudPublicId: file.cloudPublicId,

                };
                
                console.log(`✓ Successfully mapped block ${blockId} to URL: ${imageUrl}`);
            } else {
                console.warn(`✗ No file found for block ${blockId} (field: ${fieldname})`);
            }

        }

        blocks = blocks.map((block : IBlock)  =>{
            if (block.type === 'image' && !block.isUploaded) {
                const imageData = blockIdToUrlMap[block.blockId];
                if(imageData ){
                    Object.assign(block,{
                        ...imageData,
                        isUploaded : true
                    })
                }
            }
            return block;
        });        
       
        const unuploadedImages = blocks.filter(
            block => block.type === 'image' && !block.isUploaded
        );
       
        let dbData: ContentDBInput = {
            user:  new mongoose.Types.ObjectId(user),
            title: title,
        };
       
         if (blocks && blocks.length > 0) {
            const createdBlocks = await BlockSchema.create(blocks, { session, ordered : true });
            dbData.body = createdBlocks.map(block => block._id as mongoose.Types.ObjectId);
        }

        if (links !== undefined) dbData.links = links;
        if (data.visibility !== undefined) dbData.visibility = data.visibility;

        if (tags && tags.length > 0) {
            const existingTags = await TagsModel.find({ 
                name: { $in: tags } 
            }).session(session);
            
            const existingTagNames = new Set(existingTags.map(t => t.name));
            const newTagNames = tags.filter(name => !existingTagNames.has(name));
            
            let newTags: any[] = [];
            if (newTagNames.length > 0) {
                newTags = await TagsModel.create(
                    newTagNames.map(name => ({ name })), 
                    { session, ordered : true }
                );
            }
            
            const allTags = [...existingTags, ...newTags];
            dbData.tags = allTags.map(tag => tag._id as mongoose.Types.ObjectId);
        }

        const contentArray = await ContentModel.create([dbData], { session, ordered : true });
        const content = contentArray[0];

        if(!content){
            throw new ErrorResponse(400, "Unable to add content")
        }

        const contentId = content._id as mongoose.Types.ObjectId;

         if (reminderDate) {
            let reminderDBData: Partial<ReminderCreateInput> = {
                user: new mongoose.Types.ObjectId(user),
                content: new mongoose.Types.ObjectId(contentId),
                dashboard: new mongoose.Types.ObjectId(dashId),
                emailSent: false,
                status: 'pending',
                reminderDate: reminderDate
            };

            if (reminder_msg !== undefined) reminderDBData.message = reminder_msg;

            await reminderSchema.create([reminderDBData], { session , ordered : true });
        }

         const result = await dashboardSchema.findByIdAndUpdate(
            dashId,
            { $push: { contents: contentId } },
            { new: true, runValidators: true, session }
        );

        if(!result) throw new ErrorResponse(400, "Unable to add content");

        await session.commitTransaction();

        res.status(200).json({
            success: true,
            data: content,
            message: 'content successfully added',
            unuploadedImages : unuploadedImages.length
        })

    } catch(err: any) {
         await session.abortTransaction();
        next(err)
    }finally {
        session.endSession();
    }
}



// export const updateContent = async(req : Request, res : Response, next : NextFunction) : Promise<void> =>{
//     try{
//         const {id} = req.params;
//         const data = req.body as UpdateInput;

//         if(data.title && !data.title.trim()){
//             throw new ErrorResponse(400, "Title cannot be empty")
//         }
//         const existingContent = await ContentModel.findById(id).exec();

//         if(!existingContent){
//             throw new ErrorResponse(404, "Content not found")
//         }

//         let UpdateDbData : Partial<ContentDBUpdateInput> = {}

//         if(data.title !== undefined) UpdateDbData.title = data.title;
//         if (data.body !== undefined) UpdateDbData.body = data.body;
//         if (data.links !== undefined) UpdateDbData.links = data.links;
//         if (data.isPinned !== undefined) UpdateDbData.isPinned = data.isPinned;
//         if (data.isArchived !== undefined) UpdateDbData.isArchived = data.isArchived;
//         if (data.visibility !== undefined) UpdateDbData.visibility = data.visibility;
       
//         if(data.tags && data.tags.length > 0){
//             const tagIds = await Promise.all(data.tags.map(async(tagName : string)=>{
//                 let tag = await TagsModel.findOne({name : tagName});
//                 if(!tag){
//                     tag = await TagsModel.create({name : tagName})
//                 }
//                 return tag._id as mongoose.Types.ObjectId;
//             }))
//             UpdateDbData.tags = tagIds ;
//         }

//         const updatedContent = await ContentModel.findByIdAndUpdate(
//             id,
//             {$set : UpdateDbData},
//             {new : true, runValidators : true}
//         )

//         res.status(200).json({
//             success : true,
//             data : updatedContent,
//             message : 'content successfully updated'
//         })
//     }catch(err : any){
//         next(err)
//     }
// }

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
     const dashId  = data.DashId;

    if (data.title && !data.title.trim()) {
      throw new ErrorResponse(400, "Title cannot be empty");
    }

    const existingContent = await ContentModel.findById(id).session(session);
    if (!existingContent) {
      throw new ErrorResponse(404, "Content not found");
    }

    let UpdateDbData: Partial<ContentDBUpdateInput> = {};

    if (data.title !== undefined) UpdateDbData.title = data.title.trim();
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
      { reminderDate: "" }
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

export const deleteContent = async(
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



// export const deleteContent = async(req : Request, res :Response, next: NextFunction) : Promise<void> =>{
//     try{
//         const { id }  = req.params;
//         const {DashId} = req.body;

//         if(!DashId){
//             throw new ErrorResponse(400, "DashId is missing")
//         }
//         const DashIdDelete = await dashboardSchema.findByIdAndUpdate(DashId,{
//             $pull : {contents : id}
//         },{new : true, runValidators : true})

//         if(!DashIdDelete){
//             throw new ErrorResponse(400, "Failed to delete the content from the dashboard")
//         }
//         const deletedContent = await ContentModel.findByIdAndDelete(id);
//         if(!deletedContent){
//             throw new ErrorResponse(404, 'Content not found')
//         }

//         res.status(200).json({
//             success : true,
//             message : 'Content successfully deleted'
//         })
//     }catch(err : any){
//         next(err)
//     }
// }