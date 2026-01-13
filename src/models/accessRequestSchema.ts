import mongoose, { Document, Schema } from 'mongoose';

export interface IAccessRequest extends Document {
  user: mongoose.Types.ObjectId;       // Requester
  doc: mongoose.Types.ObjectId;        // Target document
  shareLink: mongoose.Types.ObjectId;  // The link used to request
  status: 'pending' | 'approved' | 'rejected';
  role: 'editor' | 'viewer';           // Requested role (from link)
  requestedAt: Date;
  respondedAt?: Date;
}

const AccessRequestSchema = new Schema<IAccessRequest>({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  doc: {
    type: Schema.Types.ObjectId,
    ref: 'Doc',
    required: true,
  },
  shareLink: {
    type: Schema.Types.ObjectId,
    ref: 'ShareLink',
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  role: {
    type: String,
    enum: ['editor', 'viewer'],
    default: 'viewer',
  },
  requestedAt: {
    type: Date,
    default: Date.now,
  },
  respondedAt: {
    type: Date,
  },
}, { timestamps: true });

// Indexes for efficient queries
AccessRequestSchema.index({ doc: 1, status: 1 });          // Find pending requests for a doc
AccessRequestSchema.index({ user: 1, doc: 1 }, { unique: true }); // One request per user per doc

export default mongoose.model<IAccessRequest>('AccessRequest', AccessRequestSchema);
