import mongoose, { Schema, Document } from 'mongoose';

export type DocType = 'notes' | 'meeting' | 'project' | 'personal';

export interface IDoc extends Document {
  user: mongoose.Types.ObjectId;
  title: string;
  yjsState?: string;
  previewState?: string;    docType: DocType;
  coverImage: string | null;
  isPinned: boolean;
  isArchived: boolean;
  cloudImages: {
    imageId: string;     cloudUrl: string;
    cloudPublicId: string;
  }[];
  createdAt: Date;
  updatedAt: Date;
  collaborators: {
    user: mongoose.Types.ObjectId;
    role: 'editor' | 'viewer';
    addedAt: Date;
  }[];
  bannedUsers: {
    user: mongoose.Types.ObjectId;
    bannedAt: Date;
  }[];
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
    yjsState: {
      type: String,
      default: null,
    },
    previewState: {
      type: String,
      default: null,
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
        imageId: { type: String, required: true },
        cloudUrl: { type: String, required: true },
        cloudPublicId: { type: String, required: true },
      },
    ],
    collaborators: [
      {
        user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        role: { type: String, enum: ['editor', 'viewer'], default: 'editor' },
        addedAt: { type: Date, default: Date.now },
      },
    ],
    bannedUsers: [
      {
        user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        bannedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

DocSchema.index({ 'collaborators.user': 1 });
// Compound indexes for faster gallery queries with sorting
DocSchema.index({ user: 1, updatedAt: -1 });
DocSchema.index({ 'collaborators.user': 1, updatedAt: -1 });

export default mongoose.model<IDoc>('Doc', DocSchema);
