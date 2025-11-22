import tagsSchema from "../models/tagsSchema";
import { Request, Response, NextFunction } from "express";
import ErrorResponse from "../utils/errorResponse";
import { success } from "zod";



export const tagSearchQuery = async(req : Request, res : Response, next : NextFunction) : Promise<void> =>{
    try{    
        const qParam = req.query?.q;

        const q = typeof qParam === 'string' ? qParam.trim() : '';

        if(!q){
            return void res.status(200).json({
                success : true,
                data : [],
                count : 0
            })
        }

        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const regex = new RegExp('^'+escaped, 'i');

        const result = await tagsSchema.find({name : regex})
        .limit(5)
        .select('name')
        .lean()

        res.status(200).json({
            success : true,
            data : result,
            count : result.length
        })

    }catch(err : any){
        next(err);
    }   
}