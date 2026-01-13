import express, { RequestHandler } from 'express';
import { upflyUpload } from 'upfly';
import authMiddleware from '../middlwares/auth';
import { 
  saveDoc, getDoc, deleteDoc, getAllDocs, createDoc, updateDoc,
  getSharedByMe, updateCollaboratorRole, removeCollaborator 
} from '../controllers/doc.controller';
import {
  createAccessRequest,
  listAccessRequests,
  approveAccessRequest,
  rejectAccessRequest,
  getAllPendingRequests
} from '../controllers/accessRequest.controller';

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
router.get('/shared-by-me', authMiddleware, getSharedByMe as RequestHandler); // GET /api/docs/shared-by-me
router.get('/pending-requests', authMiddleware, getAllPendingRequests as RequestHandler); // GET /api/docs/pending-requests
router.post('/', authMiddleware, createDoc as RequestHandler);            // POST /api/docs (create new)
router.get('/:id', authMiddleware, getDoc as RequestHandler);             // GET /api/docs/:id
router.patch('/:id', authMiddleware, updateDoc as RequestHandler);        // PATCH /api/docs/:id (update fields)
router.post('/:id', authMiddleware, upload as RequestHandler, saveDoc as RequestHandler);  // POST /api/docs/:id (save with images)
router.delete('/:id', authMiddleware, deleteDoc as RequestHandler);       // DELETE /api/docs/:id

// Collaborator management routes
router.patch('/:id/collaborators/:collaboratorId', authMiddleware, updateCollaboratorRole as RequestHandler);
router.delete('/:id/collaborators/:collaboratorId', authMiddleware, removeCollaborator as RequestHandler);

// Access request routes
router.post('/:id/request-access', authMiddleware, createAccessRequest as RequestHandler);
router.get('/:id/requests', authMiddleware, listAccessRequests as RequestHandler);
router.post('/:id/requests/:reqId/approve', authMiddleware, approveAccessRequest as RequestHandler);
router.post('/:id/requests/:reqId/reject', authMiddleware, rejectAccessRequest as RequestHandler);

export default router;
