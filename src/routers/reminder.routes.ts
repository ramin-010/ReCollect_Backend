// Reminder Routes
import express from 'express';
import authMiddleware from '../middlwares/auth';
import {
  createReminder,
  getUserReminders,
  getContentReminder,
  cancelReminder,
  updateReminder
} from '../controllers/reminder.controller';

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// Reminder routes
router.post('/create', createReminder);
router.get('/user', getUserReminders);
router.get('/content/:contentId', getContentReminder);
router.put('/:reminderId', updateReminder);
router.delete('/:reminderId', cancelReminder);

export default router;
