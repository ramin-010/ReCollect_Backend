// Reminder Schema for Note and Todo Reminders
import mongoose, { Document, Schema } from "mongoose";

export interface Reminder extends Document {
  user: mongoose.Types.ObjectId;
  type: 'note' | 'todo';
  // Note reminder fields (optional when type is 'todo')
  content?: mongoose.Types.ObjectId;
  dashboard?: mongoose.Types.ObjectId;
  // Todo reminder field (optional when type is 'note')
  todoId?: mongoose.Types.ObjectId;
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
    type: {
      type: String,
      enum: ['note', 'todo'],
      default: 'note',
      required: true
    },
    content: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Content',
      required: function(this: Reminder) { return this.type === 'note'; }
    },
    dashboard: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dashboard',
      required: function(this: Reminder) { return this.type === 'note'; }
    },
    todoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Todo',
      required: function(this: Reminder) { return this.type === 'todo'; }
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
ReminderSchema.index({ type: 1, status: 1 });

export default mongoose.model<Reminder>('Reminder', ReminderSchema);
