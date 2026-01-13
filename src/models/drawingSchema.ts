import mongoose, { Document, Schema } from "mongoose";

export interface IDrawing extends Document {
  user: mongoose.Types.ObjectId;
  localId: string;   name: string;
  data: any;   thumbnail: string;
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

drawingSchema.index({ user: 1, localId: 1 }, { unique: true });

export default mongoose.model<IDrawing>('Drawing', drawingSchema);
