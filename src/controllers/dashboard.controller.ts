import dashboardModel,{Dashboard as DashboardType}  from '../models/dashboardSchema';
import { Request, Response, NextFunction } from 'express';
import ErrorResponse from '../utils/errorResponse';
import mongoose,{Document, Error, Schema} from "mongoose";
import ContentModel, { Content as ContentType } from '../models/contentSchema';



type dashInput = {
    name : string,
    description : string
}

type updateDashInput = Partial<dashInput>;

export const createDash = async(req : Request, res : Response, next: NextFunction) : Promise<void> =>{
    try{
        const {name , description = ''} : dashInput = req.body;
        const id : string = req.user?.id;
        if (!id) throw new ErrorResponse(401, "User not authenticated");


        if(!name.trim()){
            throw new ErrorResponse(400, "Dashboard Title Can't be empty")
        }

        const isExist = await dashboardModel.findOne({user : id, name : name}).exec();

        if(isExist) throw new ErrorResponse(400, "Dashboard name must be unique")
        const dash = await dashboardModel.create({
            name,
            description,
            user : id
        })
        if(!dash){
            throw new ErrorResponse(400, "Unable to create the dashboard")
        }
        res.status(200).json({
            success : true,
            data : dash,
            message : "Successfully added the Dashboard"
        })
    }catch(err){
        next(err)
    }
}

export const updateDash = async(req: Request, res : Response, next : NextFunction) : Promise<void> =>{
    try{
        console.log('hit updatedash')
        const {name ='' , description =''} : updateDashInput = req.body;
        const {id} = req.params;

        if(!name.trim() && !description.trim()){
            throw new ErrorResponse(400, "Please update atleast one field");
        }
        const obj = {} as updateDashInput;
        if (name.trim()) obj.name = name.trim();
        if (description.trim()) obj.description = description.trim();


        const Dash = await dashboardModel.findByIdAndUpdate(id,
        {  $set : obj },
        {new : true, runValidators : true})
        

        console.log('dash', Dash)
        if (!Dash) {
            throw new ErrorResponse(404, "Dashboard not found");
        }

        res.status(200).json({
            success : true,
            message : 'successfully updated the Dash',
            data : Dash
        })
    }catch(err : any){
        next(err)
    }
}


export const DeletDash = async(req : Request, res : Response, next: NextFunction): Promise<void> =>{
    try{
        const {id} = req.params;

        const isDashExist  = await dashboardModel.findById(id);
        if(!isDashExist){
            throw new ErrorResponse(404, 'Dashboard not found');
        }

        const contentIds : mongoose.Types.ObjectId[] = isDashExist.contents 
       
        const content = await ContentModel.deleteMany({
            _id : {$in : contentIds}
        })

        if(!content.acknowledged && contentIds.length !== content.deletedCount){
            throw new ErrorResponse(400, 'Error deleting Content of the Dashboard')
        }
       
        await dashboardModel.findByIdAndDelete(id);

        res.status(200).json({
            success : content.acknowledged,
            data : content.deletedCount,
            message : 'Successfully deleted the Dashboard'
        })
    }catch(err : any){
        next(err)
    }
}


export const getDashboardContents = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;

        if (!userId) throw new ErrorResponse(401, "User not authenticated");

        // Find dashboard and verify ownership
        const dashboard = await dashboardModel.findById(id)
            .populate({
                path: 'contents',
                select: 'title body links tags visibility description updatedAt isPinned isArchived',
                populate: [
                    { 
                        path: 'tags',
                        select: 'name'
                    },
                    {
                        path: 'body'
                    }
                ]
            })
            .lean();

        if (!dashboard) {
            throw new ErrorResponse(404, 'Dashboard not found');
        }

        // Verify the dashboard belongs to the user
        if (dashboard.user.toString() !== userId) {
            throw new ErrorResponse(403, 'Not authorized to access this dashboard');
        }

        res.status(200).json({
            success: true,
            data: {
                contents: dashboard.contents || []
            },
            message: 'Dashboard contents fetched successfully'
        });
    } catch (err: any) {
        next(err);
    }
};

