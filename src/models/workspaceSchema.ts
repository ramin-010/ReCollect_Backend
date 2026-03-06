import mongoose, { Document, Schema } from 'mongoose';

export interface WorkspaceMember {
  user: mongoose.Types.ObjectId;
  role: 'admin' | 'member';
  joinedAt: Date;
}

export interface Workspace extends Document {
  name: string;
  owner: mongoose.Types.ObjectId;
  members: WorkspaceMember[];
  spaces: { _id: mongoose.Types.ObjectId; name: string }[];
  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceMemberSchema = new Schema<WorkspaceMember>({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['admin', 'member'], default: 'member' },
  joinedAt: { type: Date, default: Date.now }
}, { _id: false });

const WorkspaceSchema = new Schema<Workspace>({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  members: { type: [WorkspaceMemberSchema], default: [] },
  spaces: [
    {
      name: { type: String, required: true, trim: true, maxlength: 50 },
    }
  ],
}, { timestamps: true });

// Indexes
WorkspaceSchema.index({ owner: 1 });
WorkspaceSchema.index({ 'members.user': 1 });

export default mongoose.model<Workspace>('Workspace', WorkspaceSchema);
