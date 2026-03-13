import mongoose, { Document, Schema } from 'mongoose';

export type ActivityAction =
  | 'task_created'
  | 'task_completed'
  | 'task_assigned'
  | 'task_unassigned'
  | 'task_status_changed'
  | 'task_priority_changed'
  | 'task_due_date_changed'
  | 'task_content_changed'
  | 'member_joined'
  | 'member_removed'
  | 'workspace_created';

export interface ActivityLog extends Document {
  workspace: mongoose.Types.ObjectId;
  actor: mongoose.Types.ObjectId;
  action: ActivityAction;
  targetTask?: mongoose.Types.ObjectId;
  targetUser?: mongoose.Types.ObjectId;
  metadata?: string; // e.g. task title snapshot, status change details
  createdAt: Date;
}

const ActivityLogSchema = new Schema<ActivityLog>(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    action: {
      type: String,
      enum: [
        'task_created',
        'task_completed',
        'task_assigned',
        'task_unassigned',
        'task_status_changed',
        'task_priority_changed',
        'task_due_date_changed',
        'task_content_changed',
        'member_joined',
        'member_removed',
        'workspace_created',
      ],
      required: true,
    },
    targetTask: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Todo',
      default: null,
    },
    targetUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    metadata: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

// Indexes for efficient queries
ActivityLogSchema.index({ workspace: 1, createdAt: -1 });
ActivityLogSchema.index({ actor: 1 });

export default mongoose.model<ActivityLog>('ActivityLog', ActivityLogSchema);
