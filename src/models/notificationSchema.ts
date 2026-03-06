import mongoose, { Document, Schema } from 'mongoose';

// ── Categories (broad buckets) ──
// 'actionable'     → requires user response (accept/decline)
// 'informational'  → FYI only (task assigned, reminder, etc.)
// 'promotional'    → owner/system broadcasts
export type NotificationCategory = 'actionable' | 'informational' | 'promotional';

// ── Status tracking ──
export type NotificationStatus = 'pending' | 'accepted' | 'declined' | 'dismissed';

export interface INotification extends Document {
  recipient: mongoose.Types.ObjectId;
  sender?: mongoose.Types.ObjectId;
  category: NotificationCategory;
  type: string;          // free-form: workspace_invite, task_assigned, task_reminder, etc.
  title: string;
  message: string;
  icon?: string;         // optional icon name or emoji
  metadata: Record<string, any>;  // flexible payload per type
  status: NotificationStatus;
  isRead: boolean;
  scheduledFor?: Date;   // don't show until this time
  expiresAt?: Date;      // auto-expire stale notifications
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    category: {
      type: String,
      enum: ['actionable', 'informational', 'promotional'],
      required: true,
    },
    type: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      default: '',
    },
    icon: {
      type: String,
      default: null,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'dismissed'],
      default: 'pending',
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    scheduledFor: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Compound indexes for fast inbox queries
NotificationSchema.index({ recipient: 1, isRead: 1, createdAt: -1 });
NotificationSchema.index({ recipient: 1, status: 1 });
NotificationSchema.index({ recipient: 1, type: 1 });

export default mongoose.model<INotification>('Notification', NotificationSchema);
