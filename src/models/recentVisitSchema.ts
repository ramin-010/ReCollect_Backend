import mongoose, { Schema, Document } from 'mongoose';

export interface IRecentVisit extends Document {
  user: mongoose.Types.ObjectId;
  itemId: string;
  itemType: 'doc' | 'drawing' | 'slide' | 'workspace';
  title: string;
  route: string;
  visitedAt: Date;
}

const RecentVisitSchema = new Schema<IRecentVisit>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    itemId: {
      type: String,
      required: true,
    },
    itemType: {
      type: String,
      enum: ['doc', 'drawing', 'slide', 'workspace'],
      required: true,
    },
    title: {
      type: String,
      required: true,
      default: 'Untitled',
    },
    route: {
      type: String,
      required: true,
    },
    visitedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

// Compound unique index: one entry per user+item pair (upsert on revisit)
RecentVisitSchema.index({ user: 1, itemId: 1 }, { unique: true });
// For fast sorted queries on the home page
RecentVisitSchema.index({ user: 1, visitedAt: -1 });

const RecentVisit = mongoose.model<IRecentVisit>('RecentVisit', RecentVisitSchema);
export default RecentVisit;
