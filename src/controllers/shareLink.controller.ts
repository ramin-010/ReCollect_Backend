import shareLinkSchema,{ShareLink as ShareLinkType} from "../models/shareLinkSchema";
import DocModel from "../models/docSchema";
import mongoose from 'mongoose';
import { Request, Response, NextFunction } from "express";
import ErrorResponse from "../utils/errorResponse";
import {randomUUID} from 'crypto'
import dashboardSchema, {Dashboard as DashboardType} from "../models/dashboardSchema";
import { success } from "zod";
import { populate } from "dotenv";

type contentInput = {
    type : 'content',
    contentId : string
}
type dashInput = {
    type : 'dashboard',
    dashId : string
}
export const createContentShareLink = async(req : Request, res : Response, next: NextFunction) : Promise<void> =>{
    try{
        const user = req.user?._id as string;
        const {type, contentId} : contentInput = req.body;

        if (!contentId || !contentId.trim()) {
            throw new ErrorResponse(400, "Missing content");
        }
        if(!type.trim()){
            throw new ErrorResponse(400, 'Type cannot be empty')
        }
        if(type.toLocaleLowerCase() !== 'content') throw new ErrorResponse(400 , 'Type should be Content');

        const isExist = await shareLinkSchema.findOne({
            user : user,
            content : contentId,
            expiresAt : { $gt : new Date()}
        })
        if(isExist){
            return void res.status(200).json({
                success : true,
                data: {
                    url : `${process.env.FRONTEND_URL}/${type}/${isExist.slug}`
                }
            })
        }

        const slug = randomUUID();

        const dbData = {
            user : user,
            type : type,
            content : contentId,
            slug : slug
        }

        const link = await shareLinkSchema.create(dbData);
        if(!link){
            throw new ErrorResponse(400,'Unable to generate the public url')
        }

        res.status(200).json({
            success : true,
            data: {
                url :  `${process.env.FRONTEND_URL}/${type}/${slug}`
            }
        })

    }catch(err : any){
        next(err)
    }
}

export const createDashShareLink = async(req : Request, res : Response, next : NextFunction) : Promise<void> =>{
    try{
        const user = req.user?._id as string;
        const {type, dashId} : dashInput = req.body;

         if (!dashId || !dashId.trim()) {
            throw new ErrorResponse(400, "Missing dashboard");
        }
        if(!type.trim()){
            throw new ErrorResponse(400, 'Type cannot be empty')
        }
        if(type.toLocaleLowerCase() !== 'dashboard') throw new ErrorResponse(400 , 'Type should be dashboard');

        const isExist = await shareLinkSchema.findOne({
            user :  user,
            dashboard : dashId,
            expiresAt : {$gt : new Date()}
        })
        
        if(isExist){
        
            return void res.status(200).json({
                success : true,
                data: {
                    url :  `${process.env.FRONTEND_URL}/${type}/${isExist.slug}`
                }
            })
        }
        const slug = randomUUID();

        const dbData = {
            user : user,
            type : type,
            dashboard : dashId,
            slug : slug
        }

        const link = await shareLinkSchema.create(dbData);
        if(!link){
            throw new ErrorResponse(400,'Unable to generate the public url')
        }
       
        res.status(200).json({
            success : true,
            data: {
                url :  `${process.env.FRONTEND_URL}/${type}/${slug}`
            }
        })


    }catch(err : any){
        next(err)
    }
}

export const fetchContentLink = async (req : Request, res : Response, next : NextFunction) : Promise<void> =>{
    try{
        const {slug} = req.params;
        
       const contentDoc = await shareLinkSchema.findOne({
            slug,
            expiresAt: { $gt: new Date() }
        })
        .populate({
            path: 'content',
            select: 'title body links tags visibility description updatedAt', 
            populate: [
                { 
                    path: 'tags',                  
                    select: 'name'                 
                },
                {
                    path : 'body'
                }
            ]
        });


        if (!contentDoc) {
            throw new ErrorResponse(404, 'URL is expired');
        }

        res.status(200).json({
            success : true,
            data : contentDoc,
            message : 'Succesfully fetched the content'
        })

    }catch(err : any){
        next(err)
    }
}

export const fetchDashLink = async (req : Request, res : Response, next : NextFunction) : Promise<void> =>{
    try{
        const {slug} = req.params;
        console.log("here at get dash")
       const dashDoc = await shareLinkSchema.findOne({
            slug,
            expiresAt: { $gt: new Date() }
        })
        .populate(
            {
                path : 'dashboard',
                select : 'name description createdAt updatedAt',
                populate : {
                    path : 'contents',
                    select : 'title body links tags visibility description updatedAt',
                    match: { visibility: 'Public' }, 
                    populate : [
                        {
                            path : 'tags',
                            select : 'name'
                        },
                        {
                            path: 'body',
                        }
                    ]
                }
            }
        )

        if (!dashDoc) {
            throw new ErrorResponse(404, 'URL is expired');
        }

        res.status(200).json({
            success : true,
            data : dashDoc,
            message : 'Succesfully fetched the dashboard'
        })

    }catch(err : any){
        next(err)
    }
}





type docInput = {
    type: 'doc',
    docId: string,
    role?: 'editor' | 'viewer'
}

export const createDocShareLink = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const user = req.user?._id as string;
        const { type, docId, role = 'viewer' }: docInput = req.body;

        if (!docId || !docId.trim()) {
            throw new ErrorResponse(400, "Missing document ID");
        }
        if (!type?.trim()) {
            throw new ErrorResponse(400, 'Type cannot be empty');
        }
        if (type.toLowerCase() !== 'doc') {
            throw new ErrorResponse(400, 'Type should be doc');
        }

        
        const targetDoc = await DocModel.findById(docId);
        if (!targetDoc) {
            throw new ErrorResponse(404, "Document not found");
        }
        
        
        const isOwner = targetDoc.user.toString() === user.toString();
        if (!isOwner) {
            throw new ErrorResponse(403, "Only the document owner can generate share links");
        }

                await shareLinkSchema.deleteMany({
            doc: docId
        });

                await DocModel.updateOne(
            { _id: docId },
            { $set: { bannedUsers: [] } }
        );

                const AccessRequest = (await import('../models/accessRequestSchema')).default;
        await AccessRequest.deleteMany({ doc: docId });

                const slug = randomUUID();

        const dbData = {
            user: user,
            type: type,
            doc: docId,
            role: role,
            slug: slug
        };
        const link = await shareLinkSchema.create(dbData);
        if (!link) {
            throw new ErrorResponse(400, 'Unable to generate the public url');
        }
        
        res.status(200).json({
            success: true,
            data: {
                url: `${process.env.FRONTEND_URL}/${type}/${slug}`
            },
            message: 'New share link generated. Previous links invalidated.'
        });

    } catch (err: any) {
        next(err);
    }
}

export const fetchDocLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { slug } = req.params;

        const docLink = await shareLinkSchema.findOne({
            slug,
            type: 'doc',
            expiresAt: { $gt: new Date() }
        })
        .populate({
            path: 'doc',
            select: 'title yjsState docType isPinned createdAt updatedAt coverImage cloudImages'
        });

        if (!docLink) {
            throw new ErrorResponse(404, 'URL is expired or not found');
        }

        res.status(200).json({
            success: true,
            data: docLink,
            message: 'Successfully fetched the document'
        });

    } catch (err: any) {
        next(err);
    }
}

import Doc from '../models/docSchema';

export const saveSharedDoc = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { slug } = req.params;
        const userId = req.user?._id;

        if (!userId) {
            throw new ErrorResponse(401, 'Unauthorized');
        }

        
        const shareLink = await shareLinkSchema.findOne({
            slug,
            type: 'doc',
            expiresAt: { $gt: new Date() }
        });
        console.log('shareLink', shareLink)

        if (!shareLink || !shareLink.doc) {
            throw new ErrorResponse(404, 'Invalid or expired share link');
        }

        
        const doc = await Doc.findById(shareLink.doc);
        if (!doc) {
            throw new ErrorResponse(404, 'Document not found');
        }

        
        if (doc.user.toString() === userId.toString()) {
             return void res.status(400).json({
                success: false,
                message: 'You are the owner of this document'
             });
        }

                const isBanned = doc.bannedUsers?.some(b => b.user.toString() === userId.toString());
        if (isBanned) {
            return void res.status(403).json({
                success: false,
                message: 'Your access to this document has been revoked'
            });
        }

        
        const isCollaborator = doc.collaborators?.some(c => c.user.toString() === userId.toString());
        if (isCollaborator) {
            return void res.status(200).json({
                success: true,
                message: 'You are already a collaborator on this document'
            });
        }

        
        doc.collaborators.push({
            user: new mongoose.Types.ObjectId(userId.toString()),
            role: shareLink.role || 'viewer', 
            addedAt: new Date()
        });

        await doc.save();

                try {
            const { hocuspocusServer } = await import('../collaboration/hocuspocus');
            const docId = (doc._id as any).toString();
            const documentName = `doc_${docId}`;
            
                        const serverAny = hocuspocusServer as any;
            const activeDoc = serverAny.hocuspocus?.documents?.get(documentName);
            if (activeDoc) {
                activeDoc.broadcastStateless(
                    JSON.stringify({ 
                        type: 'COLLABORATOR_JOINED', 
                        userId: userId.toString() 
                    })
                );
                console.log(`[ShareLink] Broadcasted COLLABORATOR_JOINED to ${documentName}`);
            }
        } catch (broadcastErr) {
            console.error('[ShareLink] Failed to broadcast:', broadcastErr);
        }

        res.status(200).json({
            success: true,
            message: 'Document saved to your profile successfully'
        });

    } catch (err: any) {
        next(err);
    }
}

type slideInput = {
    type: 'slide',
    slideId: string,
    role?: 'editor' | 'viewer'
}

import SlideDeck from '../models/slideSchema';

export const createSlideShareLink = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const user = req.user?._id as string;
        const { type, slideId, role = 'viewer' }: slideInput = req.body;

        if (!slideId || !slideId.trim()) {
            throw new ErrorResponse(400, "Missing slide deck ID");
        }
        if (!type?.trim() || type.toLowerCase() !== 'slide') {
            throw new ErrorResponse(400, 'Type should be slide');
        }

        const targetSlide = await SlideDeck.findById(slideId);
        if (!targetSlide) {
            throw new ErrorResponse(404, "Slide Deck not found");
        }
        
        const isOwner = targetSlide.user.toString() === user.toString();
        if (!isOwner) {
            throw new ErrorResponse(403, "Only the slide deck owner can generate share links");
        }

        await shareLinkSchema.deleteMany({ slide: slideId });

        const slug = randomUUID();

        const dbData = {
            user: user,
            type: type,
            slide: slideId,
            role: role,
            slug: slug
        };
        const link = await shareLinkSchema.create(dbData);
        if (!link) {
            throw new ErrorResponse(400, 'Unable to generate the public url');
        }
        
        res.status(200).json({
            success: true,
            data: {
                url: `${process.env.FRONTEND_URL}/${type}/${slug}`
            },
            message: 'New share link generated. Previous links invalidated.'
        });

    } catch (err: any) {
        next(err);
    }
}

export const fetchSlideLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { slug } = req.params;

        const slideLink = await shareLinkSchema.findOne({
            slug,
            type: 'slide',
            expiresAt: { $gt: new Date() }
        })
        .populate({
            path: 'slide',
            select: 'name content previewContent deckType isPinned createdAt updatedAt cloudImages'
        });

        if (!slideLink) {
            throw new ErrorResponse(404, 'URL is expired or not found');
        }

        res.status(200).json({
            success: true,
            data: slideLink,
            message: 'Successfully fetched the slide deck'
        });

    } catch (err: any) {
        next(err);
    }
}