// Recall mode (/api/recall) and the other AI routes (/api/ai: the spend meter, practice notes, the
// weekly coach): the app's UI only. Cookie sessions only (an access token gets a 403: these paths
// are not in src/services/apiTokens/tokenRoutes.ts, and cookieOnly says so per route). Without
// CLAUDE_API_KEY every route answers 503 AI_NOT_CONFIGURED, which the app shows as "the AI isn't
// set up yet".
import express from 'express';
import { authOnce, cookieOnly } from '../middlwares/scopes';
import { requireAiAccess } from '../config/aiAccess';
import { requireAiReady } from '../services/claude/access';
import { answer, finish, requireAiConfigured, settings, start, usage } from '../controllers/recall.controller';
import { coach, latestCoach, practiceNote } from '../controllers/aiNotes.controller';

const recallRouter = express.Router();
recallRouter.use(authOnce, cookieOnly, requireAiConfigured, requireAiAccess, requireAiReady); // AI_ALLOWED_EMAILS: 403 (hosting P1-5); a paused key: 503 AI_PAUSED
recallRouter.post('/start', start);
recallRouter.post('/sets/:id/answer', answer);
recallRouter.post('/sets/:id/finish', finish);

export const aiRouter = express.Router();
aiRouter.use(authOnce, cookieOnly, requireAiConfigured, requireAiAccess);
aiRouter.get('/usage', usage);
aiRouter.patch('/settings', settings);
aiRouter.post('/practice-note', practiceNote);
aiRouter.get('/coach', latestCoach);
aiRouter.post('/coach', coach);

export default recallRouter;
