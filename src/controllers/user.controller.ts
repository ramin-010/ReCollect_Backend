// User Profile Controller with Upfly Integration
import { Request, Response, NextFunction } from "express";
import { z } from 'zod';
import User from '../models/userSchema';
import ErrorResponse from "../utils/errorResponse";


interface CloudFileOutput extends Express.Multer.File {
    cloudUrl: string,
    cloudProvider: string,
    cloudPublicId: string
}
// Update profile schema
const updateProfileSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  email: z.string().email().optional(),
  bio: z.string().max(500).optional(),
  preferences: z.object({
    theme: z.enum(['light', 'dark', 'blue', 'gray']).optional(),
    emailNotifications: z.boolean().optional(),
    reminderNotifications: z.boolean().optional()
  }).optional()
});

// Get user profile
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

// Update user profile
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
    
    // Check if email is being updated and is unique
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

// Upload profile picture using Upfly
export const uploadProfilePicture = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const userId = req.user?._id;
    const files = req.files as Record<string, Express.Multer.File[]>
    // Check if file was uploaded
    if (!files || !files.avatar || !files?.avatar[0]) {
      throw new ErrorResponse(400, "No image file provided");
    }
    
    const avatarFile = files.avatar[0] as CloudFileOutput;
    
    // Get the cloud URL from Upfly processed file
    const avatarUrl = avatarFile.cloudUrl || avatarFile.path;
    
    if (!avatarUrl) {
      throw new ErrorResponse(500, "Failed to upload image");
    }
    
    // Update user avatar
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { avatar: avatarUrl },
      { new: true }
    ).select('-password');
    
    if (!updatedUser) {
      throw new ErrorResponse(404, "User not found");
    }
    
    res.status(200).json({
      success: true,
      data: {
        user: updatedUser,
        avatar: avatarUrl
      }
    });
  } catch (err: any) {
    next(err);
  }
};

// Delete user account
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
    
    // Verify user password
    const user = await User.findById(userId).select('+password');
    
    if (!user) {
      throw new ErrorResponse(404, "User not found");
    }
    
    const isMatch = await user.comparePassword(password);
    
    if (!isMatch) {
      throw new ErrorResponse(401, "Invalid password");
    }
    
    // Delete user and all related data
    await User.findByIdAndDelete(userId);
    
    // TODO: Delete all user's dashboards, contents, and share links
    
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

    // Fetch user with populated archived and favorite notes
    const user = await User.findById(userId)
      .populate({
        path: 'archivedNotes',
        select: 'title body links tags visibility description updatedAt isPinned isArchived',
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
        select: 'title body links tags visibility description updatedAt isPinned isArchived',
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

    res.status(200).json({
      success: true,
      data: {
        user,
        archivedNotes: user.archivedNotes || [],
        favoriteNotes: user.favoriteNotes || []
      },
      message: 'User settings fetched successfully'
    });
  } catch (error: any) {
    next(error);
  }
};
