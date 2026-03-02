import { Router, RequestHandler } from 'express';
import protect from '../middlwares/auth';
import { getLiveKitToken, admitViewer, knockOnRoom } from '../controllers/livekit.controller';

const router = Router();

router.get('/token', protect, getLiveKitToken as RequestHandler);
router.post('/admit', protect, admitViewer as RequestHandler);
router.post('/knock', protect, knockOnRoom as RequestHandler);

export default router;
