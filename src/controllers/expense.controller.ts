import { Request, Response } from 'express';
import Expense, { IExpense } from '../models/Expense';
import ExpenseCategory from '../models/expenseCategorySchema';
import mongoose from 'mongoose';

const DEFAULT_CATEGORIES = [
  'transport',
  'grocery', 
  'bills',
  'shopping',
  'gym_health',
  'medicine',
  'cheat_snacks',    'miscellaneous'
];

export const getExpenses = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id as string;
    
    const expenses = await Expense.find({ userId })
      .sort({ date: -1 })
      .lean();
    
    res.status(200).json({
      success: true,
      data: expenses
    });
  } catch (error) {
    console.error('Error fetching expenses:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch expenses' });
  }
};

export const addExpense = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id as string;
    const { amount, category, date, note } = req.body;

    if (!amount || !category) {
      return res.status(400).json({ success: false, message: 'Amount and category are required' });
    }

    const expense = new Expense({
      userId: new mongoose.Types.ObjectId(userId),
      amount,
      type: 'expense',
      category: category.toLowerCase().trim(),
      date: date ? new Date(date) : new Date(),
      note
    });

    await expense.save();

    res.status(201).json({
      success: true,
      data: expense
    });
  } catch (error) {
    console.error('Error adding expense:', error);
    res.status(500).json({ success: false, message: 'Failed to add expense' });
  }
};

export const deleteExpense = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id as string;
    const { id } = req.params;

    const expense = await Expense.findOneAndDelete({
      _id: id,
      userId: new mongoose.Types.ObjectId(userId)
    });

    if (!expense) {
      return res.status(404).json({ success: false, message: 'Expense not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Expense deleted'
    });
  } catch (error) {
    console.error('Error deleting expense:', error);
    res.status(500).json({ success: false, message: 'Failed to delete expense' });
  }
};

export const getCategories = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id as string;
    
    const customCategories = await ExpenseCategory.find({ 
      user: new mongoose.Types.ObjectId(userId) 
    }).lean();
    
    const customNames = customCategories.map(c => c.name);
    
    res.status(200).json({
      success: true,
      data: {
        default: DEFAULT_CATEGORIES,
        custom: customNames
      }
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch categories' });
  }
};

export const addCategory = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id as string;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Category name is required' });
    }

    const categoryName = name.toLowerCase().trim();

    if (DEFAULT_CATEGORIES.includes(categoryName)) {
      return res.status(400).json({ success: false, message: 'This is already a default category' });
    }

    const existing = await ExpenseCategory.findOne({
      user: new mongoose.Types.ObjectId(userId),
      name: categoryName
    });

    if (existing) {
      return res.status(400).json({ success: false, message: 'Category already exists' });
    }

    const category = new ExpenseCategory({
      user: new mongoose.Types.ObjectId(userId),
      name: categoryName
    });

    await category.save();

    res.status(201).json({
      success: true,
      data: category
    });
  } catch (error) {
    console.error('Error adding category:', error);
    res.status(500).json({ success: false, message: 'Failed to add category' });
  }
};

export const deleteCategory = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id as string;
    const { id } = req.params;

    const category = await ExpenseCategory.findOneAndDelete({
      _id: id,
      user: new mongoose.Types.ObjectId(userId)
    });

    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Category deleted'
    });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ success: false, message: 'Failed to delete category' });
  }
};
