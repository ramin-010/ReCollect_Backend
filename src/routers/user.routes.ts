// User Profile Routes
import express from 'express';
import { upflyUpload } from 'upfly';
import authMiddleware from '../middlwares/auth';
import {
  getUserProfile,
  updateUserProfile,
  uploadProfilePicture,
  deleteUserAccount
} from '../controllers/user.controller';

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// Profile routes
router.get('/profile', getUserProfile);
router.put('/profile', updateUserProfile);
router.delete('/account', deleteUserAccount);

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

if (!cloudName || !apiKey || !apiSecret) {
  throw new Error("❌ Missing Cloudinary configuration environment variables.");
}


// Profile picture upload with Upfly
router.post('/avatar', 
  upflyUpload({
    fields: {
      "avatar": {
        cloudStorage: true,
        cloudProvider: 'cloudinary',
        cloudConfig: {
          cloud_name: cloudName,
          api_key: apiKey,
          api_secret: apiSecret,
          folder: 'recollect/avatars'
        },
        format: 'webp',
        quality: 85,
        output: 'memory'
      }
    },
    limit: 5 * 1024 * 1024, // 5MB limit
    safeFile: true
  }),
  uploadProfilePicture
);

export default router;
