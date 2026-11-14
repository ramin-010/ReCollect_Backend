import express, { RequestHandler } from 'express';
import { upflyUpload } from 'upfly';
import authMiddleware from '../middlwares/auth';
import { scopeByMethod } from '../middlwares/scopes';
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
// Access tokens: GETs need `read`, writes `docs:write` (a cookie session has every scope). Which doc
// routes accept a token at all: src/services/apiTokens/tokenRoutes.ts (reads only; agents write
// through /api/agent/docs).
const auth: RequestHandler[] = [authMiddleware as RequestHandler, scopeByMethod('docs:write')];

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
        folder: 'recollect-docs'
      }
    },
  },
});


router.get('/', auth, getAllDocs as RequestHandler);           router.get('/shared-by-me', auth, getSharedByMe as RequestHandler); router.get('/pending-requests', auth, getAllPendingRequests as RequestHandler); router.post('/', auth, createDoc as RequestHandler);            router.get('/:id', auth, getDoc as RequestHandler);             router.patch('/:id', auth, updateDoc as RequestHandler);        router.post('/:id', auth, upload as RequestHandler, saveDoc as RequestHandler);  router.delete('/:id', auth, deleteDoc as RequestHandler);       
router.patch('/:id/collaborators/:collaboratorId', auth, updateCollaboratorRole as RequestHandler);
router.delete('/:id/collaborators/:collaboratorId', auth, removeCollaborator as RequestHandler);

router.post('/:id/request-access', auth, createAccessRequest as RequestHandler);
router.get('/:id/requests', auth, listAccessRequests as RequestHandler);
router.post('/:id/requests/:reqId/approve', auth, approveAccessRequest as RequestHandler);
router.post('/:id/requests/:reqId/reject', auth, rejectAccessRequest as RequestHandler);

export default router;
