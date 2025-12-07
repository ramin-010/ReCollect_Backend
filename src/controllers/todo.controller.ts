import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import TodoModel, { Todo } from '../models/todoSchema';
import ReminderModel from '../models/reminderSchema';
import ErrorResponse from '../utils/errorResponse';
import { scheduleReminder } from '../services/reminderService';

// Get all todos for authenticated user
export const getTodos = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    try {
        const userId = req.user?._id as string;

        const todos = await TodoModel.find({ user: userId })
            .sort({ createdAt: -1 })
            .lean();

        res.status(200).json({
            success: true,
            data: todos,
            count: todos.length
        });
    } catch (err) {
        next(err);
    }
};

// Create a new todo
export const createTodo = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
        const userId = req.user?._id as string;
        const { text, reminderDate } = req.body;

        if (!text || !text.trim()) {
            throw new ErrorResponse(400, "Todo text is required");
        }

        const todoData = {
            user: new mongoose.Types.ObjectId(userId),
            text: text.trim(),
            isCompleted: false,
            reminderDate: reminderDate ? new Date(reminderDate) : undefined
        };

        const [todo] = await TodoModel.create([todoData], { session });
        
        if (!todo) {
            throw new ErrorResponse(400, "Failed to create todo");
        }

        let reminderScheduleData = null;

        // Create reminder if reminderDate is provided
        if (reminderDate) {
            const parsedDate = new Date(reminderDate);
            
            if (isNaN(parsedDate.getTime())) {
                throw new ErrorResponse(400, "Invalid reminder date");
            }

            if (parsedDate <= new Date()) {
                throw new ErrorResponse(400, "Reminder date must be in the future");
            }

            const reminderPayload = {
                user: new mongoose.Types.ObjectId(userId),
                type: 'todo' as const,
                todoId: todo._id as mongoose.Types.ObjectId,
                reminderDate: parsedDate,
                message: `Don't forget: ${text.trim()}`,
                emailSent: false,
                status: 'pending' as const
            };

            const [createdReminder] = await ReminderModel.create([reminderPayload], { session });

            if (!createdReminder) {
                throw new ErrorResponse(400, "Failed to create reminder");
            }

            reminderScheduleData = {
                userId,
                contentId: null,
                dashboardId: null,
                message: reminderPayload.message,
                remindAt: parsedDate,
                reminderId: String(createdReminder._id)
            };
        }

        await session.commitTransaction();

        // Schedule reminder outside transaction
        if (reminderScheduleData) {
            scheduleReminder(reminderScheduleData as any).catch(err => {
                console.error("Failed to schedule todo reminder:", err);
            });
        }

        res.status(201).json({
            success: true,
            data: todo,
            message: 'Todo created successfully'
        });

    } catch (err) {
        await session.abortTransaction();
        next(err);
    } finally {
        session.endSession();
    }
};

// Update a todo
export const updateTodo = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const userId = req.user?._id as string;
        const { id } = req.params;
        const { text, isCompleted, reminderDate } = req.body;

        // if (!mongoose.Types.ObjectId.isValid(id)) {
        //     throw new ErrorResponse(400, "Invalid todo ID");
        // }

        const existingTodo = await TodoModel.findOne({ 
            _id: id, 
            user: new mongoose.Types.ObjectId(userId) 
        }).session(session);

        if (!existingTodo) {
            throw new ErrorResponse(404, "Todo not found");
        }

        // Build update object
        const updateData: Record<string, any> = {};
        if (text !== undefined) updateData.text = text.trim();
        if (isCompleted !== undefined) updateData.isCompleted = isCompleted;
        if (reminderDate !== undefined) {
            updateData.reminderDate = reminderDate ? new Date(reminderDate) : null;
        }

        const updatedTodo = await TodoModel.findByIdAndUpdate(
            id,
            { $set: updateData },
            { new: true, runValidators: true, session }
        );

        if (!updatedTodo) {
            throw new ErrorResponse(400, "Failed to update todo");
        }

        let reminderScheduleData = null;

        // Handle reminder updates
        if (reminderDate !== undefined) {
            // Delete existing reminder for this todo
            await ReminderModel.deleteMany({ 
                todoId: id, 
                user: userId,
                type: 'todo'
            }).session(session);

            // Create new reminder if date is provided
            if (reminderDate) {
                const parsedDate = new Date(reminderDate);
                
                if (isNaN(parsedDate.getTime())) {
                    throw new ErrorResponse(400, "Invalid reminder date");
                }

                if (parsedDate <= new Date()) {
                    throw new ErrorResponse(400, "Reminder date must be in the future");
                }

                const reminderPayload = {
                    user: new mongoose.Types.ObjectId(userId),
                    type: 'todo' as const,
                    todoId: updatedTodo._id as mongoose.Types.ObjectId,
                    reminderDate: parsedDate,
                    message: `Don't forget: ${updatedTodo.text}`,
                    emailSent: false,
                    status: 'pending' as const
                };

                const [createdReminder] = await ReminderModel.create([reminderPayload], { session });

                if (!createdReminder) {
                    throw new ErrorResponse(400, "Failed to create reminder");
                }

                reminderScheduleData = {
                    userId,
                    contentId: null,
                    dashboardId: null,
                    message: reminderPayload.message,
                    remindAt: parsedDate,
                    reminderId: String(createdReminder._id)
                };
            }
        }

        await session.commitTransaction();

        // Schedule reminder outside transaction
        if (reminderScheduleData) {
            scheduleReminder(reminderScheduleData as any).catch(err => {
                console.error("Failed to schedule todo reminder:", err);
            });
        }

        res.status(200).json({
            success: true,
            data: updatedTodo,
            message: 'Todo updated successfully'
        });

    } catch (err) {
        await session.abortTransaction();
        next(err);
    } finally {
        session.endSession();
    }
};

// Delete a todo
export const deleteTodo = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const userId = req.user?._id as string;
        const { id } = req.params;

        // if (!mongoose.Types.ObjectId.isValid(id)) {
        //     throw new ErrorResponse(400, "Invalid todo ID");
        // }

        const todo = await TodoModel.findOne({ 
            _id: id, 
            user: new mongoose.Types.ObjectId(userId) 
        }).session(session);

        if (!todo) {
            throw new ErrorResponse(404, "Todo not found");
        }

        await Promise.all([
            // Delete the todo
            TodoModel.findByIdAndDelete(id).session(session),
            // Delete associated reminder
            ReminderModel.deleteMany({ 
                todoId: id, 
                user: userId,
                type: 'todo'
            }).session(session)
        ]);

        await session.commitTransaction();

        res.status(200).json({
            success: true,
            message: 'Todo deleted successfully'
        });

    } catch (err) {
        await session.abortTransaction();
        next(err);
    } finally {
        session.endSession();
    }
};
