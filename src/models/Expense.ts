import mongoose, { Schema, Document } from 'mongoose';

export interface IExpense extends Document {
  userId: mongoose.Types.ObjectId;
  amount: number;
  type: 'income' | 'expense';
  category: string;
  date: Date;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ExpenseSchema: Schema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  type: { type: String, enum: ['income', 'expense'], required: true },
  category: { type: String, required: true },
  date: { type: Date, required: true, default: Date.now },
  note: { type: String },
}, { timestamps: true });

// Index for efficient hquerying

ExpenseSchema.index({ userId: 1, date: -1 });

export default mongoose.model<IExpense>('Expense', ExpenseSchema);

