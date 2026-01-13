import express, { RequestHandler } from 'express';
import authMiddleware from '../middlwares/auth';
import { upflyUpload } from 'upfly';
import {
  syncDrawing,
  getCloudDrawings,
  deleteCloudDrawing
} from '../controllers/drawing.controller';

const router = express.Router();

const cloud_name = process.env.CLOUDINARY_CLOUD_NAME || '';
const cloud_key = process.env.CLOUDINARY_API_KEY || '';
const cloud_secret = process.env.CLOUDINARY_API_SECRET || '';

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

router.use(authMiddleware);

router.post('/sync', upload as RequestHandler, syncDrawing);

router.get('/', getCloudDrawings);

router.delete('/:localId', deleteCloudDrawing);

export default router;
