import { Request, Response } from 'express';
import Doc from '../models/docSchema';
import mongoose from 'mongoose';

// Get all docs for user
export const getDocs = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id as string;
    
    const docs = await Doc.find({ 
      user: new mongoose.Types.ObjectId(userId),
      isArchived: false
    })
      .select('title emoji isPinned createdAt updatedAt')
      .sort({ isPinned: -1, updatedAt: -1 })
      .lean();
    
    res.status(200).json({
      success: true,
      data: docs
    });
  } catch (error) {
    console.error('Error fetching docs:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch docs' });
  }
};

// Get single doc
export const getDoc = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id as string;
    const { id } = req.params;

    const doc = await Doc.findOne({
      _id: id,
      user: new mongoose.Types.ObjectId(userId)
    }).lean();

    if (!doc) {
      return res.status(404).json({ success: false, message: 'Doc not found' });
    }

    res.status(200).json({
      success: true,
      data: doc
    });
  } catch (error) {
    console.error('Error fetching doc:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch doc' });
  }
};

// Create new doc
export const createDoc = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id as string;
    const { title, emoji } = req.body;

    const doc = new Doc({
      user: new mongoose.Types.ObjectId(userId),
      title: title || 'Untitled',
      emoji: emoji || '📄',
      content: '[]'
    });

    await doc.save();

    res.status(201).json({
      success: true,
      data: doc
    });
  } catch (error) {
    console.error('Error creating doc:', error);
    res.status(500).json({ success: false, message: 'Failed to create doc' });
  }
};

// Update doc
export const updateDoc = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id as string;
    const { id } = req.params;
    const { title, content, emoji, isPinned, isArchived } = req.body;

    const updateData: any = {};
    if (title !== undefined) updateData.title = title;
    if (content !== undefined) updateData.content = content;
    if (emoji !== undefined) updateData.emoji = emoji;
    if (isPinned !== undefined) updateData.isPinned = isPinned;
    if (isArchived !== undefined) updateData.isArchived = isArchived;

    const doc = await Doc.findOneAndUpdate(
      { _id: id, user: new mongoose.Types.ObjectId(userId) },
      updateData,
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({ success: false, message: 'Doc not found' });
    }

    res.status(200).json({
      success: true,
      data: doc
    });
  } catch (error) {
    console.error('Error updating doc:', error);
    res.status(500).json({ success: false, message: 'Failed to update doc' });
  }
};

// Delete doc
export const deleteDoc = async (req: Request, res: Response) => {
  try {
    const userId = req.user?._id as string;
    const { id } = req.params;

    const doc = await Doc.findOneAndDelete({
      _id: id,
      user: new mongoose.Types.ObjectId(userId)
    });

    if (!doc) {
      return res.status(404).json({ success: false, message: 'Doc not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Doc deleted'
    });
  } catch (error) {
    console.error('Error deleting doc:', error);
    res.status(500).json({ success: false, message: 'Failed to delete doc' });
  }
};
