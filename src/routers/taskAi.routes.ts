import { Router, RequestHandler } from 'express';
import protect from '../middlwares/auth';
import { requireAiAccess } from '../config/aiAccess';
import { requireAiReady } from '../services/claude/access';
import { generateTaskContent } from '../controllers/taskAi.controller';

const router = Router();

// POST /api/todos/ai/generate — Generate task fields from an AI prompt
router.post('/generate', protect, requireAiAccess, requireAiReady, generateTaskContent as RequestHandler); // AI_ALLOWED_EMAILS: 403 (hosting P1-5)

export default router;
