import express, { RequestHandler } from 'express';
import authMiddleware from '../middlwares/auth';
import { upflyUpload } from 'upfly';
import {
  syncDrawing,
  getCloudDrawings,
  deleteCloudDrawing
} from '../controllers/drawing.controller';

const router = express.Router();

// Cloudinary config
const cloud_name = process.env.CLOUDINARY_CLOUD_NAME || '';
const cloud_key = process.env.CLOUDINARY_API_KEY || '';
const cloud_secret = process.env.CLOUDINARY_API_SECRET || '';

// Upload middleware for drawing images and thumbnail
const upload = upflyUpload({
  fields: {
    "image_*": {
      output: 'memory',
      format: 'webp',
      quality: 50,
      cloudStorage: true,
      cloudProvider: "cloudinary",
      cloudConfig: {
        cloud_name: cloud_name,
        api_key: cloud_key,
        api_secret: cloud_secret,
        folder: 'recollect/drawings'
      }
    },
    "thumbnail": {
      output: 'memory',
      format: 'webp',
      quality: 60,
      cloudStorage: true,
      cloudProvider: "cloudinary",
      cloudConfig: {
        cloud_name: cloud_name,
        api_key: cloud_key,
        api_secret: cloud_secret,
        folder: 'recollect/drawings/thumbnails'
      }
    }
  }
});

// All routes require authentication
router.use(authMiddleware);

// Sync a drawing to cloud (with image upload support)
router.post('/sync', upload as RequestHandler, syncDrawing);

// Get all cloud-synced drawings
router.get('/', getCloudDrawings);

// Delete a cloud-synced drawing
router.delete('/:localId', deleteCloudDrawing);

export default router;
