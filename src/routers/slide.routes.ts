import { Router, RequestHandler } from 'express';
import { upflyUpload } from 'upfly';
import protect from '../middlwares/auth';

import {
  getAllDecks,
  getDeck,
  createDeck,
  saveDeck,
  updateDeck,
  deleteDeck,
  exportDeckPdf,
} from '../controllers/slide.controller';

const router = Router();

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
        cloud_name,
        api_key: cloud_key,
        api_secret: cloud_secret,
        folder: 'recollect-slides',
      },
    },
  },
});

// All routes require auth
router.get('/', protect, getAllDecks as RequestHandler);
router.get('/:id', protect, getDeck as RequestHandler);
router.get('/:id/export', protect, exportDeckPdf as RequestHandler);
router.post('/', protect, createDeck as RequestHandler);
router.post('/:id/save', protect, upload as RequestHandler, saveDeck as RequestHandler);
router.patch('/:id', protect, updateDeck as RequestHandler);
router.delete('/:id', protect, deleteDeck as RequestHandler);

export default router;
