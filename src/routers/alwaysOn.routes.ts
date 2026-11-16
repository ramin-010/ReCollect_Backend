// Stage 6 (ALWAYS_ON_SPEC): the phone's wallpaper and widget (6.6) and the morning notification's
// subscriptions (6.3).
import express, { RequestHandler } from 'express';
import authMiddleware from '../middlwares/auth';
import { cookieOnly, requireScope } from '../middlwares/scopes';
import { ambientAddressesHandler, ambientDisconnectHandler, ambientRemindersHeldHandler, ambientStylesHandler, ambientWallpaperHandler, ambientWidgetHandler } from '../controllers/ambient.controller';
import { pushStatusHandler, removePushSubscriptionHandler, savePushSubscriptionHandler, testPushHandler } from '../controllers/push.controller';

const router = express.Router();
const auth = authMiddleware as RequestHandler;

// The phone app's `ambient` token opens these two (and nothing else); a `read` token still does.
router.get('/ambient/widget', auth, requireScope('read', 'ambient'), ambientWidgetHandler);
router.get('/ambient/wallpaper.png', auth, requireScope('read', 'ambient'), ambientWallpaperHandler);
router.get('/ambient/styles', auth, requireScope('read', 'ambient'), ambientStylesHandler);
// The phone app's Disconnect ends its own token.
router.post('/ambient/disconnect', auth, requireScope('ambient'), ambientDisconnectHandler);
// App 0.5.0: the reminders the phone will ring for (no email for them).
router.post('/ambient/reminders/scheduled', auth, requireScope('ambient'), ambientRemindersHeldHandler);
// Settings → Phone app: where the phone can reach this server.
router.get('/ambient/addresses', auth, cookieOnly, ambientAddressesHandler);

router.get('/push/status', auth, cookieOnly, pushStatusHandler);
router.post('/push/subscription', auth, cookieOnly, savePushSubscriptionHandler);
router.delete('/push/subscription', auth, cookieOnly, removePushSubscriptionHandler);
router.post('/push/test', auth, cookieOnly, testPushHandler);

export default router;
