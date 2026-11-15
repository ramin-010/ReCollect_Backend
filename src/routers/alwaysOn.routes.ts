// Stage 6 (ALWAYS_ON_SPEC): the phone's wallpaper and widget (6.6) and the morning notification's
// subscriptions (6.3).
import express, { RequestHandler } from 'express';
import authMiddleware from '../middlwares/auth';
import { cookieOnly, requireScope } from '../middlwares/scopes';
import { ambientWallpaperHandler, ambientWidgetHandler } from '../controllers/ambient.controller';
import { pushStatusHandler, removePushSubscriptionHandler, savePushSubscriptionHandler, testPushHandler } from '../controllers/push.controller';

const router = express.Router();
const auth = authMiddleware as RequestHandler;

router.get('/ambient/widget', auth, requireScope('read'), ambientWidgetHandler);
router.get('/ambient/wallpaper.png', auth, requireScope('read'), ambientWallpaperHandler);

router.get('/push/status', auth, cookieOnly, pushStatusHandler);
router.post('/push/subscription', auth, cookieOnly, savePushSubscriptionHandler);
router.delete('/push/subscription', auth, cookieOnly, removePushSubscriptionHandler);
router.post('/push/test', auth, cookieOnly, testPushHandler);

export default router;
