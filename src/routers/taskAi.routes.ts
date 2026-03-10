import { Router, RequestHandler } from 'express';
import protect from '../middlwares/auth';
import { generateTaskContent } from '../controllers/taskAi.controller';

const router = Router();

// POST /api/todos/ai/generate — Generate task fields from an AI prompt
router.post('/generate', protect, generateTaskContent as RequestHandler);

export default router;
