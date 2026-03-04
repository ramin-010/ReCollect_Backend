// Task Schema for Rich Task System
import mongoose, { Document, Schema } from "mongoose";

// Subtask interface
export interface Subtask {
  id: string;
  text: string;
  isCompleted: boolean;
}

// Reference to doc or content
export interface TaskReference {
  type: 'doc' | 'content' | 'slide';
  refId: mongoose.Types.ObjectId;
  title?: string;
}

// Recurrence pattern
export interface TaskRecurrence {
  pattern: 'daily' | 'weekly' | 'monthly';
  interval?: number; // Every N days/weeks/months
}

export interface Todo extends Document {
  user: mongoose.Types.ObjectId;
  title: string;
  description?: string; // Rich text (TipTap JSON)
  
  // Status & Priority
  status: 'pending' | 'in_progress' | 'complete';
  priority: 'low' | 'medium' | 'high';
  
  // Dates
  dueDate?: Date;
  reminderDate?: Date;
  completedAt?: Date;
  
  // Subtasks
  subtasks?: Subtask[];
  
  // Cloud Images for deletion tracking
  cloudImages?: { imageId: string; cloudPublicId: string }[];

  // Tags (Unified)
  tags?: mongoose.Types.ObjectId[];
  
  // References (bi-directional linking)
  references?: TaskReference[];
  
  // Recurrence
  recurrence?: TaskRecurrence;

  // Collaboration
  assignee?: mongoose.Types.ObjectId;
  assignedAt?: Date;

  // Visibility
  visibility: 'private' | 'shared' | 'workspace';
  workspace?: mongoose.Types.ObjectId;
  
  // Legacy compat
  createdAt: Date;
  updatedAt: Date;
}

const SubtaskSchema = new Schema<Subtask>({
  id: { type: String, required: true },
  text: { type: String, required: true },
  isCompleted: { type: Boolean, default: false }
}, { _id: false });

// Task reference schema
const TaskReferenceSchema = new Schema<TaskReference>({
  type: { type: String, enum: ['doc', 'content', 'slide'], required: true },
  refId: { type: mongoose.Schema.Types.ObjectId, required: true },
  title: { type: String }
}, { _id: false });

// Recurrence schema
const RecurrenceSchema = new Schema<TaskRecurrence>({
  pattern: { type: String, enum: ['daily', 'weekly', 'monthly'], required: true },
  interval: { type: Number, default: 1 }
}, { _id: false });



// Cloud image schema (for deletion tracking)
const CloudImageSchema = new Schema({
  imageId: { type: String, required: true },
  cloudPublicId: { type: String, required: true }
}, { _id: false });

const TodoSchema = new Schema<Todo>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      default: null
    },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'complete'],
      default: 'pending'
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium'
    },
    dueDate: {
      type: Date,
      default: null
    },
    reminderDate: {
      type: Date,
      default: null
    },
    completedAt: {
      type: Date,
      default: null
    },
    // Sub-items
    subtasks: {
      type: [SubtaskSchema],
      default: []
    },
    // Cloud images for deletion tracking
    cloudImages: {
      type: [CloudImageSchema],
      default: []
    },
    // Unified Tags (References)
    tags: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tags'
    }],
    // Recurrence
    recurrence: {
      type: RecurrenceSchema,
      default: null
    },
    // Unified Collaboration (P2P)
    assignee: {
       type: mongoose.Schema.Types.ObjectId, 
       ref: 'User',
       default: null 
    },
    assignedAt: {
       type: Date,
       default: null
    },
    // Visibility
    visibility: {
      type: String,
      enum: ['private', 'shared', 'workspace'],
      default: 'private'
    },
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      default: null
    },
    // Tracking & Refs
    references: {
      type: [TaskReferenceSchema],
      default: []
    },
  },
  { timestamps: true }
);

// Indexes for efficient queries
TodoSchema.index({ user: 1, createdAt: -1 });
TodoSchema.index({ user: 1, status: 1 });
TodoSchema.index({ user: 1, priority: 1 });
TodoSchema.index({ user: 1, dueDate: 1 });
TodoSchema.index({ 'references.refId': 1 }); // For finding tasks by doc/content
TodoSchema.index({ assignee: 1 }); // For assigned task lookups

// Pre-save hook to sync completedAt with status
TodoSchema.pre<Todo>('save', function(next) {
  if (this.isModified('status')) {
    if (this.status === 'complete' && !this.completedAt) {
      this.completedAt = new Date();
    }
  }
  next();
});

export default mongoose.model<Todo>('Todo', TodoSchema);
