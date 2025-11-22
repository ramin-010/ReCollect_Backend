import mongoose,{Document, mongo, Schema} from "mongoose";
import { title } from "process";

export interface Content extends Document{
    user : mongoose.Types.ObjectId,
    title : string,
    body : mongoose.Types.ObjectId[],
    tags : mongoose.Types.ObjectId[],
    links : string[],
    isPinned : boolean,
    isArchived : boolean,
    visibility : string
}

const ContentSchema = new Schema<Content>(
    {
        user : {
            type : mongoose.Schema.Types.ObjectId,
            ref : 'User'
        },
        title : {
            type : String,
            required : true,
            trim : true,
        },
        body :[{
            type : mongoose.Schema.Types.ObjectId,
            ref : 'Block'
        }],
        tags : [{
            type : mongoose.Schema.Types.ObjectId,
            ref : 'Tags'
        }],
        links : [
            {
                type : String,
                default : ''
            }
        ],
        isPinned : {
            type : Boolean,
            default : false
        },
        isArchived : {
            type : Boolean,
            default : false,
        },
        visibility : {
            type : String,
            enum : ['Public', 'Private'],
        }
    }, { timestamps : true}
);

ContentSchema.index({title : 1});

export default mongoose.model<Content>('Content', ContentSchema);