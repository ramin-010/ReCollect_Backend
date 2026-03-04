import { Request, Response, NextFunction } from "express";
import { z } from 'zod';
import User from '../models/userSchema';
import ErrorResponse from "../utils/errorResponse";


interface CloudFileOutput extends Express.Multer.File {
    cloudUrl: string,
    cloudProvider: string,
    cloudPublicId: string
}
const updateProfileSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(20).optional(),
  reminderEmail: z.string().email().optional(),
  bio: z.string().max(500).optional(),
  preferences: z.object({
    theme: z.enum(['light', 'dark', 'blue', 'gray']).optional(),
    emailNotifications: z.boolean().optional(),
    reminderNotifications: z.boolean().optional()
  }).optional()
});

import { deleteFromCloud } from "./content.controller";

export const getUserProfile = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const userId = req.user?._id;
    
    const user = await User.findById(userId).select('-password');
    
    if (!user) {
      throw new ErrorResponse(404, "User not found");
    }
    
    res.status(200).json({
      success: true,
      data: user
    });
  } catch (err: any) {
    next(err);
  }
};

export const updateUserProfile = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const userId = req.user?._id;
    
    const result = updateProfileSchema.safeParse(req.body);
    
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid data',
        errors: result.error.flatten()
      });
    }
    
    const updateData = result.data;
    
        if (updateData.email) {
      const existingUser = await User.findOne({ 
        email: updateData.email, 
        _id: { $ne: userId } 
      });
      
      if (existingUser) {
        throw new ErrorResponse(400, "Email already in use");
      }
    }
    
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      updateData,
      { new: true, runValidators: true }
    ).select('-password');
    
    if (!updatedUser) {
      throw new ErrorResponse(404, "User not found");
    }
    
    res.status(200).json({
      success: true,
      data: updatedUser
    });
  } catch (err: any) {
    next(err);
  }
};

export const uploadProfilePicture = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const userId = req.user?._id;
    const files = req.files as Record<string, Express.Multer.File[]>

    if (!files || !files.avatar || !files?.avatar[0]) {
      throw new ErrorResponse(400, "No image file provided");
    }
    
    const avatarFile = files.avatar[0] as CloudFileOutput;
    
    const avatarUrl = avatarFile.cloudUrl || avatarFile.path;
    const avatarPublicId = avatarFile.cloudPublicId;
    const avatarProvider = avatarFile.cloudProvider;
    
    if (!avatarUrl) {
      throw new ErrorResponse(500, "Failed to upload image");
    }
    
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { avatar: avatarUrl, cloudPublicId: avatarPublicId, cloudProvider: avatarProvider },
    ).select('-password');
    
    const existingAvatar = updatedUser?.cloudPublicId || '';
   
    console.log("Existing Avatar",existingAvatar); 
    if(existingAvatar){
      await deleteFromCloud(existingAvatar);
    }
    
    if (!updatedUser) {
      throw new ErrorResponse(404, "User not found");
    }
    
    res.status(200).json({
      success: true,
      data: {
        avatar: avatarUrl
      }
    });
  } catch (err: any) {
    next(err);
  }
};

export const deleteUserAccount = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    if (!req.user) {
      throw new ErrorResponse(401, "Not authenticated");
    }
    const userId = req.user.id;
    const { password } = req.body;
    
    if (!password) {
      throw new ErrorResponse(400, "Password required to delete account");
    }
    
        const user = await User.findById(userId).select('+password');
    
    if (!user) {
      throw new ErrorResponse(404, "User not found");
    }
    
    const isMatch = await user.comparePassword(password);
    
    if (!isMatch) {
      throw new ErrorResponse(401, "Invalid password");
    }
    
        await User.findByIdAndDelete(userId);
    
        
    res.status(200).json({
      success: true,
      message: "Account deleted successfully"
    });
  } catch (err: any) {
    next(err);
  }
};


export const getUserSettings = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const userId = req.user?.id;
    console.log("ENTERED");
    if (!userId) {
      throw new ErrorResponse(401, 'User not authenticated');
    }

        const user = await User.findById(userId)
      .populate({
        path: 'archivedNotes',
        select: 'title body links tags visibility description updatedAt isPinned isArchived connections',
        populate: [
          {
            path: 'tags',
            select: 'name'
          },
          {
            path: 'body'
          }
        ]
      })
      .populate({
        path: 'favoriteNotes',
        select: 'title body links tags visibility description updatedAt isPinned isArchived connections',
        populate: [
          {
            path: 'tags',
            select: 'name'
          },
          {
            path: 'body'
          }
        ]
      })
      .select('-password')
      .lean();

      console.log(user);

    if (!user) {
      throw new ErrorResponse(404, 'User not found');
    }

        const Dashboard = (await import('../models/dashboardSchema')).default;

        const archivedNoteIds = (user.archivedNotes || []).map((note: any) => note._id);
    const favoriteNoteIds = (user.favoriteNotes || []).map((note: any) => note._id);
    const allContentIds = [...new Set([...archivedNoteIds, ...favoriteNoteIds])];

        const dashboards = await Dashboard.find({
      user: userId,
      contents: { $in: allContentIds }
    }).select('_id contents').lean();

    const contentToDashboardMap = new Map<string, string>();
    dashboards.forEach((dashboard: any) => {
      dashboard.contents.forEach((contentId: any) => {
        contentToDashboardMap.set(contentId.toString(), dashboard._id.toString());
      });
    });

        const enrichedArchivedNotes = (user.archivedNotes || []).map((note: any) => ({
      ...note,
      DashId: contentToDashboardMap.get(note._id.toString()) || ''
    }));

    const enrichedFavoriteNotes = (user.favoriteNotes || []).map((note: any) => ({
      ...note,
      DashId: contentToDashboardMap.get(note._id.toString()) || ''
    }));

    res.status(200).json({
      success: true,
      data: {
        user,
        archivedNotes: enrichedArchivedNotes,
        favoriteNotes: enrichedFavoriteNotes
      },
      message: 'User settings fetched successfully'
    });
  } catch (error: any) {
    next(error);
  }
};

const changePasswordSchema = z.object({
  newPassword: z.string().min(8, { message: 'Password must be at least 8 characters long' }),
  confirmPassword: z.string()
}).refine((data) => data.newPassword === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"]
});

export const changePassword = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const userId = req.user?._id;
    
    if (!userId) {
      throw new ErrorResponse(401, 'User not authenticated');
    }

    const result = changePasswordSchema.safeParse(req.body);
    
    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid data',
        errors: result.error.flatten()
      });
    }

    const { newPassword } = result.data;

        const user = await User.findById(userId).select('+password');
    
    if (!user) {
      throw new ErrorResponse(404, 'User not found');
    }

        user.password = newPassword;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (err: any) {
    next(err);
  }
};

/**
 * GET /api/user/search?q=...
 * Searches users by name or email (for assignee picker)
 * Returns only non-ghost, active users
 */
export const searchUsers = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const currentUserId = req.user?._id;
    const { q } = req.query;

    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.status(200).json({
        success: true,
        data: []
      });
    }

    const searchRegex = new RegExp(q.trim(), 'i');

    const users = await User.find({
      $and: [
        { _id: { $ne: currentUserId } },            // Exclude self
        { isGhost: { $ne: true } },                   // Exclude ghost users
        {
          $or: [
            { name: searchRegex },
            { email: searchRegex }
          ]
        }
      ]
    })
    .select('name email avatar')
    .limit(10)
    .lean();

    res.status(200).json({
      success: true,
      data: users
    });
  } catch (err: any) {
    next(err);
  }
};
