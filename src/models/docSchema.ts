import mongoose, { Schema, Document } from 'mongoose';

export type DocType = 'notes' | 'meeting' | 'project' | 'personal';

export interface IDoc extends Document {
  user: mongoose.Types.ObjectId;
  title: string;
  content: any; // TipTap JSON content
  docType: DocType;
  coverImage: string | null;
  emoji: string;
  isPinned: boolean;
  isArchived: boolean;
  // Track cloud images for cleanup on update/delete
  cloudImages: {
    nodeId: string;
    cloudUrl: string;
    cloudPublicId: string;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const DocSchema: Schema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    content: {
      type: Schema.Types.Mixed,
      default: { type: 'doc', content: [] },
    },
    docType: {
      type: String,
      enum: ['notes', 'meeting', 'project', 'personal'],
      default: 'notes',
    },
    coverImage: {
      type: String,
      default: null,
    },
    isPinned: {
      type: Boolean,
      default: false,
    },
    isArchived: {
      type: Boolean,
      default: false,
    },
    cloudImages: [
      {
        nodeId: { type: String, required: true },
        cloudUrl: { type: String, required: true },
        cloudPublicId: { type: String, required: true },
      },
    ],
  },
  {
    timestamps: true,
  }
);

export default mongoose.model<IDoc>('Doc', DocSchema);
