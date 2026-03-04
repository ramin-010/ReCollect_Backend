import mongoose, { Document, Schema } from "mongoose";

export interface ISlideCloudImage {
  imageId: string;
  cloudUrl: string;
  cloudPublicId: string;
}

export interface ISlideCollaborator {
  user: mongoose.Types.ObjectId;
  role: 'editor' | 'viewer' | 'presenter';
  addedAt: Date;
}

export interface ISlideDeck extends Document {
  user: mongoose.Types.ObjectId;
  name: string;
  content: string;              // JSON string of SlideCanvasData
  previewContent: string;       // JSON string of first slide only (for lightweight listing)
  cloudImages: ISlideCloudImage[];
  collaborators: ISlideCollaborator[];
  shareToken?: string;
  shareEnabled: boolean;
  isPinned: boolean;
  deckType: 'presentation' | 'meeting' | 'project' | 'personal';
  createdAt: Date;
  updatedAt: Date;
  admittedViewers?: string[];
}

const cloudImageSchema = new Schema<ISlideCloudImage>(
  {
    imageId: { type: String, required: true },
    cloudUrl: { type: String, required: true },
    cloudPublicId: { type: String, required: true },
  },
  { _id: false }
);

const collaboratorSchema = new Schema<ISlideCollaborator>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: {
      type: String,
      enum: ['editor', 'viewer', 'presenter'],
      default: 'viewer',
    },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const slideDeckSchema = new Schema<ISlideDeck>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: String,
      default: '',
    },
    previewContent: {
      type: String,
      default: '',
    },
    cloudImages: {
      type: [cloudImageSchema],
      default: [],
    },
    collaborators: {
      type: [collaboratorSchema],
      default: [],
    },
    shareToken: {
      type: String,
      unique: true,
      sparse: true,
    },
    shareEnabled: {
      type: Boolean,
      default: false,
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
    deckType: {
      type: String,
      enum: ['presentation', 'meeting', 'project', 'personal'],
      default: 'presentation',
    },
    admittedViewers: [{ type: String }],
  },
  { timestamps: true }
);

slideDeckSchema.index({ user: 1, updatedAt: -1 });
slideDeckSchema.index({ 'collaborators.user': 1 });

export default mongoose.model<ISlideDeck>('SlideDeck', slideDeckSchema);
