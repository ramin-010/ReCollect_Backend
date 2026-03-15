import { Router, RequestHandler } from 'express';
import authMiddleware from '../middlwares/auth';
import {
    getNotifications,
    getUnreadCount,
    markAsRead,
    markAllAsRead,
    acceptNotification,
    declineNotification,
    deleteNotification,
} from '../controllers/notification.controller';

const router = Router();

// All notification routes require auth
router.use(authMiddleware as RequestHandler);

router.get('/', getNotifications);
router.get('/unread-count', getUnreadCount);
router.patch('/read-all', markAllAsRead);
router.patch('/:id/read', markAsRead);
router.post('/:id/accept', acceptNotification);
router.post('/:id/decline', declineNotification);
router.delete('/:id', deleteNotification);

export default router;
