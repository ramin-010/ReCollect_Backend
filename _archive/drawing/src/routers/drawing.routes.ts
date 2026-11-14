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
import { generateDrawingContent } from '../controllers/drawingAi.controller';

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

// ========== PUBLIC ROUTER (no auth) ==========
// A SEPARATE router, mounted in src/app.ts BEFORE the user routes: those are mounted on '/api' with
// router.use(authMiddleware), so any '/api/*' request that reaches them needs a login. When this
// route lived in the router below (mounted after them), anonymous viewers got 401.
export const publicDrawingRouter = Router();
publicDrawingRouter.get('/public/shared/:token', getSharedDrawing as RequestHandler);

// ========== PROTECTED ROUTES (require auth) ==========
const router = Router();

router.get('/', protect, getAllDrawings as RequestHandler);

// AI generation route (must be before /:id to avoid route conflict)
router.post('/ai/generate', protect, generateDrawingContent as RequestHandler);

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
