import mongoose, { Document, Schema } from 'mongoose';
import crypto from 'crypto';

export interface IWorkspaceInviteLink extends Document {
  workspace: mongoose.Types.ObjectId;
  space?: mongoose.Types.ObjectId;       // optional — if set, link is for a specific space
  token: string;                          // unique URL-safe token
  createdBy: mongoose.Types.ObjectId;     // admin who generated it
  expiresAt?: Date;                       // null = never expires
  maxUses?: number;                       // null = unlimited
  useCount: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceInviteLinkSchema = new Schema<IWorkspaceInviteLink>(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
      index: true,
    },
    space: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      default: () => crypto.randomBytes(24).toString('base64url'),
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
    maxUses: {
      type: Number,
      default: null,
    },
    useCount: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Compound index for fast lookups
WorkspaceInviteLinkSchema.index({ token: 1 });
WorkspaceInviteLinkSchema.index({ workspace: 1, isActive: 1 });

export default mongoose.model<IWorkspaceInviteLink>(
  'WorkspaceInviteLink',
  WorkspaceInviteLinkSchema
);
