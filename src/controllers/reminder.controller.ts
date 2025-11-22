// Reminder Controller for Note Reminders
import { Request, Response, NextFunction } from "express";
import { z } from 'zod';
import Reminder from '../models/reminderSchema';
import Content from '../models/contentSchema';
import ErrorResponse from "../utils/errorResponse";

// Create reminder schema
const createReminderSchema = z.object({
  contentId: z.string(),
  dashboardId: z.string(),
  reminderDate: z.string().datetime(),
  message: z.string().optional()
});

// Create a reminder for a note
export const createReminder = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    if (!req.user) {
      throw new ErrorResponse(401, "Not authenticated");
    }

    const result = createReminderSchema.safeParse(req.body);
    
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid data',
        errors: result.error.flatten()
      });
    }
    
    const { contentId, dashboardId, reminderDate, message } = result.data;
    
    // Verify the content belongs to the user
    const content = await Content.findOne({
      _id: contentId,
      user: req.user.id
    });
    
    if (!content) {
      throw new ErrorResponse(404, "Content not found or not authorized");
    }
    
    // Check if reminder date is in the future
    const reminderDateObj = new Date(reminderDate);
    if (reminderDateObj <= new Date()) {
      throw new ErrorResponse(400, "Reminder date must be in the future");
    }
    
    // Check for existing reminder
    const existingReminder = await Reminder.findOne({
      user: req.user.id,
      content: contentId,
      status: 'pending'
    });
    
    if (existingReminder) {
      // Update existing reminder
      existingReminder.reminderDate = reminderDateObj;
      const nextMessage = message ?? existingReminder.message ?? "";
      existingReminder.message = nextMessage;
      await existingReminder.save();
      
      res.status(200).json({
        success: true,
        data: existingReminder,
        message: "Reminder updated successfully"
      });
    } else {
      // Create new reminder
      const reminder = await Reminder.create({
        user: req.user.id,
        content: contentId,
        dashboard: dashboardId,
        reminderDate: reminderDateObj,
        message: message ?? `Don't forget to review: ${content.title}`,
        status: 'pending'
      });
      
      res.status(201).json({
        success: true,
        data: reminder,
        message: "Reminder created successfully"
      });
    }
  } catch (err: any) {
    next(err);
  }
};

// Get user's reminders
export const getUserReminders = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    if (!req.user) {
      throw new ErrorResponse(401, "Not authenticated");
    }
    
    const { status, upcoming } = req.query;
    
    let query: any = { user: req.user.id };
    
    if (status) {
      query.status = status;
    }
    
    if (upcoming === 'true') {
      query.reminderDate = { $gte: new Date() };
      query.status = 'pending';
    }
    
    const reminders = await Reminder.find(query)
      .populate('content', 'title body')
      .populate('dashboard', 'name')
      .sort({ reminderDate: 1 });
    
    res.status(200).json({
      success: true,
      data: reminders
    });
  } catch (err: any) {
    next(err);
  }
};

// Get reminder for specific content
export const getContentReminder = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    if (!req.user) {
      throw new ErrorResponse(401, "Not authenticated");
    }
    
    const { contentId } = req.params;
    
    const reminder = await Reminder.findOne({
      user: req.user.id,
      content: contentId,
      status: 'pending'
    });
    
    res.status(200).json({
      success: true,
      data: reminder
    });
  } catch (err: any) {
    next(err);
  }
};

// Cancel a reminder
export const cancelReminder = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    if (!req.user) {
      throw new ErrorResponse(401, "Not authenticated");
    }
    
    const { reminderId } = req.params;
    
    const reminder = await Reminder.findOne({
      _id: reminderId,
      user: req.user.id
    });
    
    if (!reminder) {
      throw new ErrorResponse(404, "Reminder not found");
    }
    
    if (reminder.status !== 'pending') {
      throw new ErrorResponse(400, "Cannot cancel this reminder");
    }
    
    reminder.status = 'cancelled';
    await reminder.save();
    
    res.status(200).json({
      success: true,
      message: "Reminder cancelled successfully"
    });
  } catch (err: any) {
    next(err);
  }
};

// Update a reminder
export const updateReminder = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    if (!req.user) {
      throw new ErrorResponse(401, "Not authenticated");
    }
    
    const { reminderId } = req.params;
    const { reminderDate, message } = req.body;
    
    const reminder = await Reminder.findOne({
      _id: reminderId,
      user: req.user.id
    });
    
    if (!reminder) {
      throw new ErrorResponse(404, "Reminder not found");
    }
    
    if (reminder.status !== 'pending') {
      throw new ErrorResponse(400, "Cannot update this reminder");
    }
    
    if (reminderDate) {
      const newDate = new Date(reminderDate);
      if (newDate <= new Date()) {
        throw new ErrorResponse(400, "Reminder date must be in the future");
      }
      reminder.reminderDate = newDate;
    }
    
    if (message !== undefined) {
      reminder.message = message;
    }
    
    await reminder.save();
    
    res.status(200).json({
      success: true,
      data: reminder,
      message: "Reminder updated successfully"
    });
  } catch (err: any) {
    next(err);
  }
};
