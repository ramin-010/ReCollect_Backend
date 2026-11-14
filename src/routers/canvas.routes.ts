// /api/canvas: stateless diagram tools for a board (src/controllers/canvas.controller.ts). Cookie
// sessions, or an access token with `read` (src/services/apiTokens/tokenRoutes.ts lists them).
import express from 'express';
import { authOnce, requireScope } from '../middlwares/scopes';
import { layoutCanvas, renderCanvas } from '../controllers/canvas.controller';

const router = express.Router();

router.use(authOnce);
router.post('/layout', requireScope('read'), layoutCanvas);
router.post('/render', requireScope('read'), renderCanvas);

export default router;
