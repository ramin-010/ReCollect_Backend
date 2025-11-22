import mongoose, { Schema, Model , Document} from 'mongoose';

export interface IBlock extends Document {
  blockId: string;
  type: 'text' | 'image';
  x: string;
  y: string;
  width: string;
  height: string;
  content?: string;
  url?: string;
  imageId?: string;
  isUploaded?: boolean;
  cloudPublicId? : string,
  cloudProvider? : string
}

const BlockSchema = new Schema<IBlock>(
  {
    blockId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['text', 'image'],
      required: true,
    },
    x: {
      type: String,
      required: true,
    },
    y: {
      type: String,
      required: true,
    },
    width: {
      type: String,
      required: true,
    },
    height: {
      type: String,
      required: true,
    },
    content: {
      type: String,
      required: false,
    },
    url: {
      type: String,
      required: false,
    },
    imageId: {
      type: String,
      required: false,
    },
    isUploaded: {
      type: Boolean,
      default: false,
      required: false,
    },
    cloudPublicId : {
      type : String,
      default: '',
      required: false,
    },
    cloudProvider : {
      type : String,
      default : '',
      required : false
    }
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
BlockSchema.index({ blockId: 1 });
BlockSchema.index({ type: 1 });


export default mongoose.model<IBlock>('Block', BlockSchema);;