import mongoose, { Schema, Document } from 'mongoose';

export interface IExpenseCategory extends Document {
  user: mongoose.Types.ObjectId;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const ExpenseCategorySchema: Schema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true },
}, { timestamps: true });

// Compound index - unique category name per user
ExpenseCategorySchema.index({ user: 1, name: 1 }, { unique: true });

export default mongoose.model<IExpenseCategory>('ExpenseCategory', ExpenseCategorySchema);
