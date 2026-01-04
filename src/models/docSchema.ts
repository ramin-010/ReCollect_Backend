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
  // Yjs state for real-time collaboration
  yjsState?: string; // Base64 encoded Yjs state
  // Track cloud images for cleanup on update/delete
  cloudImages: {
    nodeId: string;
    cloudUrl: string;
    cloudPublicId: string;
  }[];
  createdAt: Date;
  updatedAt: Date;
  collaborators: {
    user: mongoose.Types.ObjectId;
    role: 'editor' | 'viewer';
    addedAt: Date;
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
    yjsState: {
      type: String,
      default: null,
    },
    collaborators: [{
      user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
      role: {
        type: String,
        enum: ['editor', 'viewer'],
        default: 'viewer',
      },
      addedAt: {
        type: Date,
        default: Date.now,
      }
    }],
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
