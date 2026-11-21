// /api/buddy (BUDDY_MEMORY_PLAN §7): what the buddy knows about the user, his settings, and the ways in.
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
// MCP_MEMORY_PLAN §4.2: update_memory (progress, a change, an end), with Undo for a change or an end.
router.post('/update', requireScope('sessions:write'), idempotency, buddy.updateHandler);
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
// Stage 3 (the web) and stage 6: the phone app's own token too (app 0.6.0: a notification's quick answer or reply).
router.post('/asks/:id/answer', requireScope('ambient'), buddy.answerAskHandler);
// B6: a routine's switch.
router.patch('/routines/:id', cookieOnly, buddy.routineHandler);
// B7: his answer to a chapter's "Still true?".
router.post('/questions', cookieOnly, buddy.questionHandler);
router.get('/chapters', requireScope('read'), buddy.chaptersHandler);
// Stage 3 (ECOSYSTEM_V2_PLAN §4.12): what is going on in his life, for recall_memory.
router.get('/threads', requireScope('read'), buddy.threadsHandler);
// Stage 5 (§4.9): /you's "On my mind": one thread's history and his controls (the app only).
router.post('/threads', cookieOnly, buddy.addThreadHandler);
router.get('/threads/:id', cookieOnly, buddy.threadHandler);
router.patch('/threads/:id', cookieOnly, buddy.updateThreadHandler);
router.delete('/threads/:id', cookieOnly, buddy.forgetThreadHandler);
// Stage 7 (§4.7): the buddy's own reminders, and his undo of one (the app only).
router.get('/reminders', cookieOnly, buddy.buddyRemindersHandler);
router.delete('/reminders/:id', cookieOnly, buddy.cancelBuddyReminderHandler);
// Stage 8 (E5): bring in other chats (an export): the estimate first, then his yes with a limit (the app only).
router.post('/import', cookieOnly, buddy.importHandler);
router.get('/imports', cookieOnly, buddy.importsHandler);
router.post('/imports/:id/approve', cookieOnly, buddy.approveImportHandler);
router.post('/imports/:id/cancel', cookieOnly, buddy.cancelImportHandler);
// Stage 5b (part B): his Remove on /you › On my screens (the app only).
router.delete('/screens/:id', cookieOnly, buddy.endScreenRuleHandler);
// B9: the work log (what he did, per project and day); removing a line is his alone.
router.get('/work', requireScope('read'), buddy.workHandler);
// Stage 12: what a writer is shown (what is open, the day's lines), for Claude Code's log_work.
router.get('/work/picture', requireScope('read'), buddy.workPictureHandler);
// B10: an agent logs a day's work on his word (log_work); no model call.
router.post('/work', requireScope('sessions:write'), idempotency, buddy.logWorkHandler);
// Stage 12: one outcome from a connected chat (claude.ai, ChatGPT), and the writing app's own changes to its line.
router.post('/work/line', requireScope('sessions:write'), idempotency, buddy.logLineHandler);
router.patch('/work/line/:id', requireScope('sessions:write'), buddy.changeLineHandler);
router.delete('/work/:id', cookieOnly, buddy.hideWorkHandler);

export default router;
