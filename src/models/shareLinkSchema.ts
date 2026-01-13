import mongoose,{Document, mongo, Schema} from "mongoose";
import {randomUUID} from 'crypto'

export interface ShareLink extends Document {
    user : mongoose.Schema.Types.ObjectId,
    content ?: mongoose.Schema.Types.ObjectId,
    dashboard? : mongoose.Schema.Types.ObjectId,
    doc? : mongoose.Schema.Types.ObjectId,
    type : string,
    slug : string,
    expiresAt? : Date;
    role?: 'editor' | 'viewer';
}

const ShareLinkSchema = new Schema<ShareLink>({
    user : {
        type : mongoose.Schema.Types.ObjectId,
        ref : 'User'
    },
    type : {
        type : String,
        enum : ['dashboard', 'content', 'doc']
    },
    role: {
        type: String,
        enum: ['editor', 'viewer'],
        default: 'viewer'
    },
    dashboard : {
        type : mongoose.Schema.Types.ObjectId,
        ref : 'Dashboard'
    },
    content : {
        type : mongoose.Schema.Types.ObjectId,
        ref : 'Content'
    },
    doc : {
        type : mongoose.Schema.Types.ObjectId,
        ref : 'Doc'
    },
    slug : {
        type : String,
        unique : true,
        required : true
    },
    expiresAt : {
        type : Date,
        default : ()=>{
            const date = new Date();
            date.setDate(date.getDate() + 3);
            return date;
        }
    }
}, {timestamps : true});

ShareLinkSchema.index({user : 1, content : 1, dashboard : 1, expiresAt : 1})
ShareLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });



export default mongoose.model<ShareLink>('ShareLink', ShareLinkSchema)