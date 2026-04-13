import express from 'express';
import authMiddleware from '../middlwares/auth';
import {
  trackVisit,
  getRecentVisits,
  removeVisit,
} from '../controllers/recentVisit.controller';

const router = express.Router();

router.use(authMiddleware);

router.post('/', trackVisit);
router.get('/', getRecentVisits);
router.delete('/:itemId', removeVisit);

export default router;
