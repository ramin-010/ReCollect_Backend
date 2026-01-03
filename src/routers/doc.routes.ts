import express, { RequestHandler } from 'express';
import { upflyUpload } from 'upfly';
import authMiddleware from '../middlwares/auth';
import { saveDoc, getDoc, deleteDoc, getAllDocs, createDoc, updateDoc } from '../controllers/doc.controller';

const router = express.Router();

const cloud_name = process.env.CLOUDINARY_CLOUD_NAME || '';
const cloud_key = process.env.CLOUDINARY_API_KEY || '';
const cloud_secret = process.env.CLOUDINARY_API_SECRET || '';

// Upfly middleware with wildcard pattern for doc images
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
        folder: 'recollect-docs'
      }
    },
  },
});

// Routes - aligned with frontend API calls
// Base path is /api/docs (set in index.ts)

router.get('/', authMiddleware, getAllDocs as RequestHandler);           // GET /api/docs
router.post('/', authMiddleware, createDoc as RequestHandler);            // POST /api/docs (create new)
router.get('/:id', authMiddleware, getDoc as RequestHandler);             // GET /api/docs/:id
router.patch('/:id', authMiddleware, updateDoc as RequestHandler);        // PATCH /api/docs/:id (update fields)
router.post('/:id', authMiddleware, upload as RequestHandler, saveDoc as RequestHandler);  // POST /api/docs/:id (save with images)
router.delete('/:id', authMiddleware, deleteDoc as RequestHandler);       // DELETE /api/docs/:id

export default router;
