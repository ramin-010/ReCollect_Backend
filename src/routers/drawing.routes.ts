import { Router, RequestHandler } from 'express';
import { upflyUpload } from 'upfly';
import protect from '../middlwares/auth';

import {
  getAllDrawings,
  getDrawing,
  createDrawing,
  saveDrawing,
  updateDrawing,
  deleteDrawing,
  enableShare,
  disableShare,
  getSharedDrawing,
  getShareStatus,
} from '../controllers/drawing.controller';

const router = Router();

// Upfly config for image uploads (matches docs pattern)
const cloud_name = process.env.CLOUDINARY_CLOUD_NAME || '';
const cloud_key = process.env.CLOUDINARY_API_KEY || '';
const cloud_secret = process.env.CLOUDINARY_API_SECRET || '';

const upload = upflyUpload({
  fields: {
    "image_*": {
      output: 'memory',
      format: 'webp',
      quality: 60,
      cloudStorage: true,
      cloudProvider: "cloudinary",
      cloudConfig: {
        cloud_name: cloud_name,
        api_key: cloud_key,
        api_secret: cloud_secret,
        folder: 'recollect-drawings'
      }
    },
  },
});

// ========== PUBLIC ROUTE (no auth) ==========
console.log('[drawing.routes] Registering PUBLIC route: /public/shared/:token (NO AUTH)');
router.get('/public/shared/:token', getSharedDrawing as RequestHandler);

// ========== PROTECTED ROUTES (require auth) ==========
router.get('/', protect, getAllDrawings as RequestHandler);
router.get('/:id', protect, getDrawing as RequestHandler);
router.post('/', protect, createDrawing as RequestHandler);
router.post('/:id/save', protect, upload as RequestHandler, saveDrawing as RequestHandler);
router.patch('/:id', protect, updateDrawing as RequestHandler);
router.delete('/:id', protect, deleteDrawing as RequestHandler);

// Share management routes (owner only)
router.get('/:id/share', protect, getShareStatus as RequestHandler);
router.post('/:id/share', protect, enableShare as RequestHandler);
router.delete('/:id/share', protect, disableShare as RequestHandler);

export default router;
