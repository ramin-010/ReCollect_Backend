import mongoose, { Schema, Model , Document} from 'mongoose';

export interface IBlock extends Document {
  blockId: string;
  type: 'text' | 'image' | 'embed' | 'code' | 'stack';
  x: number;
  y: number;
  width: number;
  height?: number | string; // 'auto' for text blocks
  fontSize?: string;
  content?: string;
  url?: string;
  imageId?: string;
  isUploaded?: boolean;
  cloudPublicId?: string;
  cloudProvider?: string;
  // New fields for SmartCanvas
  color?: string;           // Background color
  stackItems?: IBlock[];    // Nested blocks for stack type
}

// Sub-schema for nested stack items (no _id for nested)
const StackItemSchema = new Schema({
  blockId: { type: String, required: true },
  type: { type: String, enum: ['text', 'image', 'embed', 'code'], required: true },
  x: { type: Number },
  y: { type: Number },
  width: { type: Number },
  height: { type: Schema.Types.Mixed }, // Can be number or 'auto'
  fontSize: { type: String },
  color: { type: String },
  content: { type: String },
  url: { type: String },
  imageId: { type: String },
  isUploaded: { type: Boolean, default: false },
}, { _id: false });

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
      enum: ['text', 'image', 'embed', 'code', 'stack'],
      required: true,
    },
    x: {
      type: Number,
      required: true,
    },
    y: {
      type: Number,
      required: true,
    },
    width: {
      type: Number,
      required: true,
    },
    height: {
      type: Schema.Types.Mixed, // Can be number or 'auto'
      required: false,
    },
    content: {
      type: String,
      required: false,
    },
    url: {
      type: String,
      required: false,
    },
    fontSize: {
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
    cloudPublicId: {
      type: String,
      default: '',
      required: false,
    },
    cloudProvider: {
      type: String,
      default: '',
      required: false
    },
    // New fields
    color: {
      type: String,
      required: false,
    },
    stackItems: {
      type: [StackItemSchema],
      required: false,
      default: undefined,
    }
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
BlockSchema.index({ type: 1 });


export default mongoose.model<IBlock>('Block', BlockSchema);