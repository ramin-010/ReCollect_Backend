import shareLinkSchema,{ShareLink as ShareLinkType} from "../models/shareLinkSchema";
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
            select: 'title body links tags visibility description updatedAt', // include tags field here
            populate: [
                { 
                    path: 'tags',                  // nested populate
                    select: 'name'                 // only select the tag name
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
                    match: { visibility: 'Public' }, // Only include Public visibility content
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

// ==================== DOC SHARE FUNCTIONS ====================

type docInput = {
    type: 'doc',
    docId: string
}

export const createDocShareLink = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const user = req.user?._id as string;
        const { type, docId }: docInput = req.body;

        if (!docId || !docId.trim()) {
            throw new ErrorResponse(400, "Missing document ID");
        }
        if (!type?.trim()) {
            throw new ErrorResponse(400, 'Type cannot be empty');
        }
        if (type.toLowerCase() !== 'doc') {
            throw new ErrorResponse(400, 'Type should be doc');
        }

        // Check if a valid share link already exists
        const isExist = await shareLinkSchema.findOne({
            user: user,
            doc: docId,
            expiresAt: { $gt: new Date() }
        });

        if (isExist) {
            return void res.status(200).json({
                success: true,
                data: {
                    url: `${process.env.FRONTEND_URL}/${type}/${isExist.slug}`
                }
            });
        }

        const slug = randomUUID();

        const dbData = {
            user: user,
            type: type,
            doc: docId,
            slug: slug
        };
        console.log("dbData", dbData)
        const link = await shareLinkSchema.create(dbData);
        if (!link) {
            throw new ErrorResponse(400, 'Unable to generate the public url');
        }
        console.log("link", link)
        res.status(200).json({
            success: true,
            data: {
                url: `${process.env.FRONTEND_URL}/${type}/${slug}`
            }
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
            select: 'title content docType isPinned createdAt updatedAt coverImage cloudImages'
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