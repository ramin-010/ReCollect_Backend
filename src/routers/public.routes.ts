// Published docs (MANAGER_AND_DOCS_PLAN §2), for anyone with the link: no login to read; asking to
// edit needs one (cookie only: an access token is refused, the route is not on the token list).
// Mounted at /api/public.
import express, { RequestHandler } from 'express';
import authMiddleware from '../middlwares/auth';
import { readPublic, requestEdit } from '../controllers/docSharing.controller';

const router = express.Router();

router.get('/docs/:slug', readPublic);
router.post('/docs/:slug/request', authMiddleware as RequestHandler, requestEdit);

export default router;
