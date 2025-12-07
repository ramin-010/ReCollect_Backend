import mongoose, { Document, Schema } from "mongoose";

export interface IDrawing extends Document {
  user: mongoose.Types.ObjectId;
  localId: string; // The ID from localStorage to prevent duplicates
  name: string;
  data: any; // Mixed type for Excalidraw complex JSON
  thumbnail: string;
  createdAt: Date;
  updatedAt: Date;
}

const drawingSchema = new Schema<IDrawing>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    localId: {
      type: String,
      required: true
    },
    name: {
      type: String,
      required: true,
      trim: true
    },
    data: {
      type: Schema.Types.Mixed,
      default: {}
    },
    thumbnail: {
      type: String,
      default: ''
    }
  },
  {
    timestamps: true
  }
);

// Compound index to prevent duplicate syncs for the same user+localId
drawingSchema.index({ user: 1, localId: 1 }, { unique: true });

export default mongoose.model<IDrawing>('Drawing', drawingSchema);
