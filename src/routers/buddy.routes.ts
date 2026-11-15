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
// B2: the hooks send his typed words (queued, scrubbed, digested, deleted) and fetch the buddy's note.
router.post('/words', requireScope('sessions:write'), buddy.wordsHandler);
router.get('/note', requireScope('read'), buddy.noteHandler);
router.get('/usage', cookieOnly, buddy.usageHandler);
// B3: think now; the day's lines, note and follow-up.
router.post('/think', cookieOnly, buddy.thinkHandler);
router.get('/today', cookieOnly, buddy.todayHandler);
// B4: his words straight in, his thumbs (the app; the phone app's ambient token too).
router.post('/tell', requireScope('ambient'), buddy.tellHandler);
router.post('/feedback', requireScope('ambient'), buddy.feedbackHandler);
// B6: a routine's switch.
router.patch('/routines/:id', cookieOnly, buddy.routineHandler);
// B7: his answer to a chapter's "Still true?".
router.post('/questions', cookieOnly, buddy.questionHandler);
router.get('/chapters', requireScope('read'), buddy.chaptersHandler);

export default router;
