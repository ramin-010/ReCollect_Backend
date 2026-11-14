import { Request, Response, NextFunction } from "express";
import { searchTagsByPrefix, serializeTag } from "../services/tags/tags.service";

/**
 * GET /api/tagQuery/search?q=… — at most 5 tags whose name starts with q (case-insensitive).
 * Body: { success, data: [{ _id, name }], count }. An empty q returns no tags.
 */
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

        // The old prefix RegExp escaped the input; startsWithInsensitive escapes LIKE wildcards.
        const result = (await searchTagsByPrefix(q)).map(serializeTag);

        res.status(200).json({
            success : true,
            data : result,
            count : result.length
        })

    }catch(err : any){
        next(err);
    }
}
