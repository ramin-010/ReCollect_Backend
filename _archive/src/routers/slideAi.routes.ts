import { Router, RequestHandler } from 'express';
import protect from '../middlwares/auth';
import { generateSlides } from '../controllers/slideAi.controller';

const router = Router();

// POST /api/slides/ai/generate — Generate slides from a text prompt
router.post('/generate', protect, generateSlides as RequestHandler);

export default router;
