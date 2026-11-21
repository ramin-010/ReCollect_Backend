// /api/assistant: the Ask AI manager's conversations (cookie only: not on the token list).
import express from 'express';
import { authOnce, cookieOnly } from '../middlwares/scopes';
import { deleteThreadHandler, getThreadHandler, listThreadsHandler, sendMessageHandler, stopTurnHandler } from '../controllers/assistant.controller';
import { requireAiConfigured } from '../controllers/recall.controller';
import { requireAiAccess } from '../config/aiAccess';
import { requireAiReady } from '../services/claude/access';

const router = express.Router();
router.use(authOnce, cookieOnly);
router.get('/threads', listThreadsHandler);
router.get('/threads/:id', getThreadHandler);
router.delete('/threads/:id', deleteThreadHandler);
router.post('/threads/:id/stop', stopTurnHandler);
router.post('/messages', requireAiConfigured, requireAiAccess, requireAiReady, sendMessageHandler); // AI_ALLOWED_EMAILS: 403 (hosting P1-5)

export default router;
