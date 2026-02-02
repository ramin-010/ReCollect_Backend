import mongoose, { Document, Schema } from "mongoose";

export interface ICollaborator {
  user: mongoose.Types.ObjectId;
  role: 'editor' | 'viewer';
  addedAt: Date;
}

export interface ICloudImage {
  imageId: string;        // Excalidraw fileId
  cloudUrl: string;
  cloudPublicId: string;
}

export interface IDrawing extends Document {
  user: mongoose.Types.ObjectId;
  localId: string;
  name: string;
  yjsState?: string;  // Base64 encoded Yjs state
  thumbnail: string;
  collaborators: ICollaborator[];
  cloudImages: ICloudImage[];  // Track uploaded images for cleanup
  createdAt: Date;
  updatedAt: Date;
}

const collaboratorSchema = new Schema<ICollaborator>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    role: {
      type: String,
      enum: ['editor', 'viewer'],
      default: 'editor'
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  },
  { _id: false }
);

const cloudImageSchema = new Schema<ICloudImage>(
  {
    imageId: { type: String, required: true },
    cloudUrl: { type: String, required: true },
    cloudPublicId: { type: String, required: true }
  },
  { _id: false }
);

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
    yjsState: {
      type: String,
      default: undefined
    },
    thumbnail: {
      type: String,
      default: ''
    },
    collaborators: {
      type: [collaboratorSchema],
      default: []
    },
    cloudImages: {
      type: [cloudImageSchema],
      default: []
    }
  },
  {
    timestamps: true
  }
);

drawingSchema.index({ user: 1, localId: 1 }, { unique: true });

export default mongoose.model<IDrawing>('Drawing', drawingSchema);
