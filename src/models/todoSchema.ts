// Todo Schema for Task Management
import mongoose, { Document, Schema } from "mongoose";

export interface Todo extends Document {
  user: mongoose.Types.ObjectId;
  text: string;
  isCompleted: boolean;
  reminderDate?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TodoSchema = new Schema<Todo>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    text: {
      type: String,
      required: true,
      trim: true
    },
    isCompleted: {
      type: Boolean,
      default: false
    },
    reminderDate: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

// Index for efficient queries
TodoSchema.index({ user: 1, createdAt: -1 });
TodoSchema.index({ user: 1, isCompleted: 1 });

export default mongoose.model<Todo>('Todo', TodoSchema);
