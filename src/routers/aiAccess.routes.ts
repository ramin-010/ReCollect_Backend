// /api/ai/access (ECOSYSTEM_V2_PLAN stage 2): the account's AI now, and "Try again" for a paused key.
// Mounted before /api/ai, whose routes need the AI set up; these answer whatever its state. Cookie only.
import express from 'express';
import { authOnce, cookieOnly } from '../middlwares/scopes';
import { accessHandler, ownKeyHandler, removeOwnKeyHandler, retryHandler, setOwnKeyHandler } from '../controllers/aiAccess.controller';

const router = express.Router();
router.use(authOnce, cookieOnly);
router.get('/', accessHandler);
router.post('/retry', retryHandler);

export default router;

/** Stage 10: /api/ai/key, their own Claude key (cookie only; mounted before /api/ai, so it works with no AI at all). */
export const aiKeyRouter = express.Router();
aiKeyRouter.use(authOnce, cookieOnly);
aiKeyRouter.get('/', ownKeyHandler);
aiKeyRouter.put('/', setOwnKeyHandler);
aiKeyRouter.delete('/', removeOwnKeyHandler);
