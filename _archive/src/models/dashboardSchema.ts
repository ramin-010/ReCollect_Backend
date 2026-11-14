import mongoose,{Document, Schema} from "mongoose";
import { maxLength } from "zod";


export interface Dashboard extends Document {
    name : string,
    description : string,
    user : mongoose.Types.ObjectId,
    contents : mongoose.Types.ObjectId[]
}

const DashboardSchema = new Schema<Dashboard>(
    {
       name: {
            type: String,
            required: [true, "Dashboard Title Can't be empty"],
            trim: true,
            maxlength: [50, "Dashboard name cannot exceed 50 characters"],
        },
        description : {
            type : String,
            default : ''
        },
        user : {
            type : mongoose.Schema.Types.ObjectId,
            ref : 'User'
        },
        contents : [
            {
                type : mongoose.Schema.Types.ObjectId,
                ref : 'Content'
            }
        ]
    }, {timestamps : true}
);


export default mongoose.model<Dashboard>('Dashboard', DashboardSchema);