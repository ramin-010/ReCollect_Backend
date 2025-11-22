import mongoose, {Document, Schema} from "mongoose";
import { maxLength } from "zod";

interface Tags extends Document {
    name : string
}

const TagsSchema = new Schema<Tags>({
    name : {
        type : String,
        required : true,
        trim : true,
        unique : true,
    }
}, { timestamps : true})

TagsSchema.index({ name: 1 });


export default mongoose.model<Tags>('Tags', TagsSchema)