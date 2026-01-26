import express, { RequestHandler } from 'express';
import authMiddleware from '../middlwares/auth';
import { upflyUpload } from 'upfly';
import {
  syncDrawing,
  getCloudDrawings,
  deleteCloudDrawing,
  getDrawing,
  createDrawingShareLink,
  getSharedDrawingBySlug,
  updateCollaboratorRole,
  removeCollaborator
} from '../controllers/drawing.controller';
import {
  createDrawingAccessRequest,
  listDrawingAccessRequests,
  approveDrawingAccessRequest,
  rejectDrawingAccessRequest,
  getAllPendingDrawingRequests
} from '../controllers/drawingAccess.controller';

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
router.get('/pending-requests', getAllPendingDrawingRequests as RequestHandler); // Must be before /:id generic route

router.get('/:id', getDrawing as RequestHandler);
router.delete('/:localId', deleteCloudDrawing); // Keeping this for backward compat if clients use localId

// Collaboration Routes
router.get('/shared/:slug', getSharedDrawingBySlug as RequestHandler);
router.post('/:id/link', createDrawingShareLink as RequestHandler);
router.patch('/:id/collaborators/:collaboratorId', updateCollaboratorRole as RequestHandler);
router.delete('/:id/collaborators/:collaboratorId', removeCollaborator as RequestHandler);

// Access Request Routes
router.post('/:id/request-access', createDrawingAccessRequest as RequestHandler);
router.get('/:id/requests', listDrawingAccessRequests as RequestHandler);
router.post('/:id/requests/:reqId/approve', approveDrawingAccessRequest as RequestHandler);
router.post('/:id/requests/:reqId/reject', rejectDrawingAccessRequest as RequestHandler);

export default router;
