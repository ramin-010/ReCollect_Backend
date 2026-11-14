// User profile endpoints (Postgres). DB access lives in src/services/users/users.service.ts.
import { Request, Response, NextFunction } from "express";
import { z } from 'zod';
import ErrorResponse from "../utils/errorResponse";
import { deleteFromCloud } from "../utils/cloudinary";
import { serializeUser, serializeUserSummary } from '../db/serializers';
import { verifyPassword } from '../services/auth/password';
import {
  deleteUser,
  findUserById,
  findUserByIdWithPassword,
  searchUsers as searchUsersInDb,
  setUserAvatar,
  setUserPassword,
  updateUserProfile as updateUserProfileInDb,
} from '../services/users/users.service';


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
  // Accepted but not stored (they were never in the user model; Mongoose dropped them silently).
  bio: z.string().max(500).optional(),
  preferences: z.object({
    theme: z.enum(['light', 'dark', 'blue', 'gray']).optional(),
    emailNotifications: z.boolean().optional(),
    reminderNotifications: z.boolean().optional()
  }).optional()
});

export const getUserProfile = async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const userId = req.user?._id;

    const user = userId ? await findUserById(userId) : null;

    if (!user) {
      throw new ErrorResponse(404, "User not found");
    }

    res.status(200).json({
      success: true,
      data: serializeUser(user)
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

    const { name, email, phone, reminderEmail } = result.data;

    const updatedUser = userId
      ? await updateUserProfileInDb(userId, { name, email, phone, reminderEmail })
      : null;

    if (!updatedUser) {
      throw new ErrorResponse(404, "User not found");
    }

    res.status(200).json({
      success: true,
      data: serializeUser(updatedUser)
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

    // Returns the user as it was before the update, so the previous image can be deleted.
    const previousUser = userId
      ? await setUserAvatar(userId, { url: avatarUrl, cloudPublicId: avatarPublicId || '', cloudProvider: avatarProvider || '' })
      : null;

    const existingAvatar = previousUser?.cloudPublicId || '';

    console.log("Existing Avatar",existingAvatar);
    if(existingAvatar){
      await deleteFromCloud(existingAvatar);
    }

    if (!previousUser) {
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
    const { password } = req.body ?? {};

    if (!password) {
      throw new ErrorResponse(400, "Password required to delete account");
    }

    const user = await findUserByIdWithPassword(userId);

    if (!user) {
      throw new ErrorResponse(404, "User not found");
    }

    const isMatch = await verifyPassword(String(password), user.password);

    if (!isMatch) {
      throw new ErrorResponse(401, "Invalid password");
    }

    // Postgres cascades the user's own rows (docs, todos, owned workspaces, …); Mongo left them orphaned.
    await deleteUser(userId);

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
    if (!userId) {
      throw new ErrorResponse(401, 'User not authenticated');
    }

    const user = await findUserById(userId);

    if (!user) {
      throw new ErrorResponse(404, 'User not found');
    }

    res.status(200).json({
      success: true,
      data: {
        user: serializeUser(user),
        // Archived/favourite notes belonged to the cut legacy Content feature. The keys stay
        // (always empty) because the settings page still reads them.
        archivedNotes: [],
        favoriteNotes: []
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

    const updated = await setUserPassword(userId, result.data.newPassword);

    if (!updated) {
      throw new ErrorResponse(404, 'User not found');
    }

    res.status(200).json({
      success: true,
      message: 'Password changed successfully'
    });
  } catch (err: any) {
    next(err);
  }
};

/**
 * GET /api/search?q=...
 * Searches users by name or email (for assignee picker)
 * Returns only non-ghost users, never the caller. ILIKE with the input escaped (it used to be an
 * unescaped RegExp).
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

    const users = await searchUsersInDb(q.trim(), currentUserId);

    res.status(200).json({
      success: true,
      data: users.map(serializeUserSummary)
    });
  } catch (err: any) {
    next(err);
  }
};
