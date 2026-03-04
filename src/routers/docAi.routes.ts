import { Router, RequestHandler } from 'express';
import protect from '../middlwares/auth';
import { generateDocContent } from '../controllers/docAi.controller';

const router = Router();

// POST /api/docs/ai/generate — Generate document content from a text prompt
router.post('/generate', protect, generateDocContent as RequestHandler);

export default router;
