// Reminder Schema for Note Reminders
import mongoose, { Document, Schema } from "mongoose";

export interface Reminder extends Document {
  user: mongoose.Types.ObjectId;
  content: mongoose.Types.ObjectId;
  dashboard: mongoose.Types.ObjectId;
  reminderDate: Date;
  message?: string;
  emailSent: boolean;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}

const ReminderSchema = new Schema<Reminder>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    content: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Content',
      required: true
    },
    dashboard: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dashboard',
      required: true
    },
    reminderDate: {
      type: Date,
      required: true
    },
    message: {
      type: String,
      default: ''
    },
    emailSent: {
      type: Boolean,
      default: false
    },
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed', 'cancelled'],
      default: 'pending'
    }
  },
  { timestamps: true }
);

// Index for efficient queries
ReminderSchema.index({ user: 1, reminderDate: 1 });
ReminderSchema.index({ status: 1, reminderDate: 1 });

export default mongoose.model<Reminder>('Reminder', ReminderSchema);
