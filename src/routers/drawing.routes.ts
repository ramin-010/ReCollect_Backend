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

// All routes require authentication
router.use(protect);

// CRUD routes
router.get('/', getAllDrawings as RequestHandler);
router.get('/:id', getDrawing as RequestHandler);
router.post('/', createDrawing as RequestHandler);
router.post('/:id/save', upload as RequestHandler, saveDrawing as RequestHandler);
router.patch('/:id', updateDrawing as RequestHandler);
router.delete('/:id', deleteDrawing as RequestHandler);

export default router;
