// Learning (Revise's dashboard inside Recollect): LEARNING_SPEC §2 endpoints #1–33, plus the daily
// loop v2 (LOOP_V2_SPEC): settings GET, focus lines, goals + milestones, fresh start.
// Mounted with app.use('/api', …) after userRoutes. Every route is behind authMiddleware and
// scoped to the logged-in user (another user's ids are 404 `Not found`).
//
// Agents (personal access tokens) may call only the routes listed in
// src/services/apiTokens/tokenRoutes.ts. On those writes, `idempotency` (Idempotency-Key header)
// and the agent log middlewares (src/services/agent/learningEdits.ts) run before the handler;
// both do nothing for the app's cookie requests.
import express, { type RequestHandler } from 'express';
import authMiddleware from '../middlwares/auth';
import { idempotency } from '../middlwares/idempotency';
import { scopeByMethod } from '../middlwares/scopes';
import * as agentLog from '../services/agent/learningEdits';
import * as paths from '../controllers/learning/path.controller';
import * as rev from '../controllers/learning/revisions.controller';
import * as items from '../controllers/learning/items.controller';
import * as sched from '../controllers/learning/schedule.controller';
import * as loop from '../controllers/learning/loop.controller';
import { learningUploadMiddleware } from '../services/learningDb/uploads.service';

const router = express.Router();
// userRoutes (mounted before this router on '/api') already ran authMiddleware for every /api
// request; skip the second user lookup then, but never rely on that mount order.
const authenticate: RequestHandler = (req, res, next) => (req.user ? next() : authMiddleware(req, res, next));
// Access tokens: GETs need `read`, writes `learning:write` (a cookie session has every scope).
const auth: RequestHandler[] = [authenticate, scopeByMethod('learning:write')];

// #1–3 Home payload, rollover, settings
router.get('/today', auth, rev.today);
router.post('/learning/ensure-today', auth, rev.ensureToday);
router.get('/learning/settings', auth, loop.getSettingsHandler);
router.patch('/learning/settings', auth, loop.patchSettingsHandler);

// #4–7 Revisions
router.post('/revisions/start', auth, idempotency, agentLog.logRevisionStart, rev.start);
router.post('/revisions/:id/complete', auth, rev.complete);
router.post('/revisions/:id/uncomplete', auth, rev.uncomplete);
router.post('/revisions/:id/reschedule', auth, rev.reschedule);
router.post('/revisions/fresh-start', auth, loop.freshStartHandler);

// #8–11 Subjects
router.get('/subjects', auth, items.listSubjectsHandler);
router.post('/subjects', auth, idempotency, agentLog.logSubjectCreate, items.createSubjectHandler);
router.patch('/subjects/:id', auth, items.updateSubjectHandler);
router.delete('/subjects/:id', auth, items.deleteSubjectHandler);
// A subject's path (BUDDY_PLAN B1): its topics in order, and what comes next.
router.get('/subjects/:id/path', auth, paths.readPathHandler);
router.post('/subjects/:id/path', auth, idempotency, agentLog.logPathPlan, paths.planTopicsHandler);
router.patch('/topics/:id/path', auth, idempotency, agentLog.logTopicUpdate, paths.updateTopicOnPathHandler);

// #12–16 Topics
router.get('/topics/statuses', auth, items.topicStatusesHandler);
router.get('/topics/by-doc/:docId', auth, items.topicByDocHandler);
router.post('/topics', auth, idempotency, agentLog.logTopicCreate, items.createTopicHandler);
router.patch('/topics/:id', auth, items.updateTopicHandler);
router.delete('/topics/:id', auth, items.deleteTopicHandler);
router.post('/topics/:id/doc', auth, items.ensureTopicDocHandler);

// #17–20 Captures (NOTE / LINK)
router.get('/captures/categories', auth, items.captureCategoriesHandler);
router.post('/captures', auth, items.createCaptureHandler);
router.patch('/captures/:id', auth, items.updateCaptureHandler);
router.delete('/captures/:id', auth, items.deleteCaptureHandler);

// #21 Uploads
router.post('/learning/uploads', auth, learningUploadMiddleware, items.uploadHandler);

// #22–24 Quick notes
router.put('/quick-notes/:id', auth, idempotency, agentLog.logPocketAdd, items.putQuickNoteHandler);
router.patch('/quick-notes/:id', auth, items.pinQuickNoteHandler);
router.delete('/quick-notes/:id', auth, items.deleteQuickNoteHandler);

// #25–27 Schedule
router.put('/schedule/today', auth, sched.saveTodayScheduleHandler);
router.put('/debriefs/:day', auth, sched.saveDebriefHandler);
router.post('/schedule/catch-up', auth, sched.catchUpHandler);

// #28–29 Goals, export
router.post('/learning/goals/:todoId/shift', auth, sched.shiftGoalHandler);
router.get('/learning/export/mentor', auth, sched.mentorExportHandler);

// #30–33 Time blocks (the routine)
router.get('/schedule/blocks', auth, sched.listBlocksHandler);
router.post('/schedule/blocks', auth, sched.createBlockHandler);
router.patch('/schedule/blocks/:id', auth, sched.updateBlockHandler);
router.delete('/schedule/blocks/:id', auth, sched.deleteBlockHandler);

// Daily loop v2: focus lines (LOOP_V2_SPEC §3)
router.post('/focus', auth, idempotency, agentLog.logFocusAdd, loop.createFocusHandler);
router.post('/focus/carry-over', auth, loop.carryOverFocusHandler);
router.patch('/focus/:id', auth, idempotency, agentLog.logFocusUpdate, loop.updateFocusHandler);
router.delete('/focus/:id', auth, idempotency, agentLog.logFocusRemove, loop.deleteFocusHandler);

// Daily loop v2: goals with deadlines + milestones (LOOP_V2_SPEC §4)
router.get('/goals', auth, loop.listGoalsHandler);
router.post('/goals', auth, idempotency, agentLog.logGoalCreate, loop.createGoalHandler);
router.patch('/goals/:id', auth, idempotency, agentLog.logGoalUpdate, loop.updateGoalHandler);
router.delete('/goals/:id', auth, loop.deleteGoalHandler);
router.post('/goals/:id/milestones', auth, idempotency, agentLog.logMilestoneAdd, loop.createMilestoneHandler);
router.patch('/goal-milestones/:id', auth, idempotency, agentLog.logMilestoneUpdate, loop.updateMilestoneHandler);
router.delete('/goal-milestones/:id', auth, idempotency, agentLog.logMilestoneRemove, loop.deleteMilestoneHandler);

export default router;
