import mongoose, { Schema, Document } from 'mongoose';

export interface IDoc extends Document {
  user: mongoose.Types.ObjectId;
  title: string;
  content: string; // BlockNote JSON stringified
  emoji?: string;  // Document icon emoji
  isPinned: boolean;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DocSchema: Schema = new Schema({
  user: { 
    type: Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  title: { 
    type: String, 
    required: true, 
    default: 'Untitled',
    trim: true 
  },
  content: { 
    type: String, 
    default: '[]' // Empty BlockNote content
  },
  emoji: { 
    type: String, 
    default: '📄'
  },
  isPinned: { 
    type: Boolean, 
    default: false 
  },
  isArchived: { 
    type: Boolean, 
    default: false 
  },
}, { timestamps: true });

// Indexes
DocSchema.index({ user: 1, createdAt: -1 });
DocSchema.index({ user: 1, isPinned: -1, updatedAt: -1 });

export default mongoose.model<IDoc>('Doc', DocSchema);
