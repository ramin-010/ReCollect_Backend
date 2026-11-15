// /api/buddy (BUDDY_MEMORY_PLAN §7): what the buddy knows about Ramin, his settings, and the ways in.
// Agents (tokens) may save a note (sessions:write), read memories (read) and forget one
// (sessions:write, with Undo); everything else is the app's (cookie only). Token access is decided
// by authMiddleware (src/services/apiTokens/tokenRoutes.ts); the checks below say the same per route.
import express from 'express';
import { authOnce, cookieOnly, requireScope } from '../middlwares/scopes';
import { idempotency } from '../middlwares/idempotency';
import * as buddy from '../controllers/buddy.controller';

const router = express.Router();
router.use(authOnce);

router.post('/remember', requireScope('sessions:write'), idempotency, buddy.rememberHandler);
router.get('/memories', requireScope('read'), buddy.listMemoriesHandler);
router.post('/memories', cookieOnly, buddy.createMemoryHandler);
router.patch('/memories/:id', cookieOnly, buddy.updateMemoryHandler);
router.delete('/memories/:id', cookieOnly, buddy.deleteMemoryHandler);
router.post('/memories/:id/close', requireScope('sessions:write'), idempotency, buddy.closeMemoryHandler);
router.get('/settings', cookieOnly, buddy.getSettingsHandler);
router.patch('/settings', cookieOnly, buddy.patchSettingsHandler);
router.get('/you', cookieOnly, buddy.youHandler);
router.get('/export', cookieOnly, buddy.exportHandler);

export default router;
