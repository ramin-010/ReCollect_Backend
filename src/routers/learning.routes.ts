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
import * as sessions from '../controllers/learning/sessions.controller';
import * as brief from '../controllers/learning/brief.controller';
import * as week from '../controllers/learning/week.controller';
import * as mirror from '../controllers/learning/mirror.controller';
import * as tasks from '../controllers/learning/tasks.controller';
import * as decisions from '../controllers/learning/decisions.controller';
import * as actions from '../controllers/actions.controller';
import * as managerTools from '../controllers/learning/managerTools.controller';
import { learningUploadMiddleware } from '../services/learningDb/uploads.service';

const router = express.Router();
// userRoutes (mounted before this router on '/api') already ran authMiddleware for every /api
// request; skip the second user lookup then, but never rely on that mount order.
const authenticate: RequestHandler = (req, res, next) => (req.user ? next() : authMiddleware(req, res, next));
// Access tokens: GETs need `read`, writes `learning:write` (a cookie session has every scope).
const auth: RequestHandler[] = [authenticate, scopeByMethod('learning:write')];
/** The record: a token writes sessions with sessions:write (a Claude Code hook has only that and read). */
const sessionAuth: RequestHandler[] = [authenticate, scopeByMethod('sessions:write')];
/** Personal tasks for agents (LOOP_COMPLETE_SPEC 4.1): reads need `read`, writes `tasks:write`. */
const taskAuth: RequestHandler[] = [authenticate, scopeByMethod('tasks:write')];

// #1–3 Home payload, rollover, settings
router.get('/today', auth, rev.today);
router.post('/learning/ensure-today', auth, rev.ensureToday);
router.get('/learning/settings', auth, loop.getSettingsHandler);
router.patch('/learning/settings', auth, idempotency, agentLog.logSettingsUpdate, loop.patchSettingsHandler);

// #4–7 Revisions
router.post('/revisions/start', auth, idempotency, agentLog.logRevisionStart, rev.start);
router.post('/revisions/:id/complete', auth, idempotency, agentLog.logRevisionComplete, rev.complete);
router.post('/revisions/:id/uncomplete', auth, rev.uncomplete);
router.post('/revisions/:id/reschedule', auth, idempotency, agentLog.logRevisionReschedule, rev.reschedule);
router.get('/revisions/calendar', auth, managerTools.revisionCalendarHandler); // each day's load (the reschedule calendar)
router.post('/revisions/fresh-start', auth, loop.freshStartHandler);
// An agent spreads the overdue reviews (undoable); more than 20 only asks (his tap).
router.post('/revisions/spread', auth, idempotency, agentLog.logRevisionsSpread, managerTools.spreadBacklogHandler);

// #8–11 Subjects
router.get('/subjects', auth, items.listSubjectsHandler);
router.post('/subjects', auth, idempotency, agentLog.logSubjectCreate, items.createSubjectHandler);
router.patch('/subjects/:id', auth, items.updateSubjectHandler);
router.delete('/subjects/:id', auth, items.deleteSubjectHandler);
router.get('/subjects/:id/deletion', auth, items.subjectDeletionPreviewHandler);
router.get('/subject-deletions', auth, items.listSubjectDeletionsHandler);
router.post('/subject-deletions/:id/undo', auth, items.undoSubjectDeletionHandler);
// A subject's path (BUDDY_PLAN B1): its topics in order, and what comes next.
router.get('/subjects/:id/path', auth, paths.readPathHandler);
router.post('/subjects/:id/path', auth, idempotency, agentLog.logPathPlan, paths.planTopicsHandler);
router.patch('/topics/:id/path', auth, idempotency, agentLog.logTopicUpdate, paths.updateTopicOnPathHandler);

// #12–16 Topics
router.get('/topics/statuses', auth, items.topicStatusesHandler);
router.get('/topics/by-doc/:docId', auth, items.topicByDocHandler);
router.get('/topics/:id/recall', auth, managerTools.recallResultsHandler); // results and weak answers (get_recall)
router.post('/topics', auth, idempotency, agentLog.logTopicCreate, items.createTopicHandler);
router.patch('/topics/:id', auth, items.updateTopicHandler);
router.delete('/topics/:id', auth, items.deleteTopicHandler);
router.post('/topics/:id/doc', auth, items.ensureTopicDocHandler);

// #17–20 Captures (NOTE / LINK)
router.get('/captures', auth, items.listCapturesHandler); // Ctrl K → Find; All notes › Inbox (?inbox=1)
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
// The record (SYNC_SPINE_SPEC 1.2): sessions written by agents, hooks or by hand; projects.
router.put('/sessions/by-key/:key', sessionAuth, sessions.putSessionByKeyHandler);
router.post('/sessions', sessionAuth, sessions.createSessionHandler);
router.get('/sessions', sessionAuth, sessions.listSessionsHandler);
router.patch('/sessions/:id', sessionAuth, sessions.updateSessionHandler);
router.delete('/sessions/:id', sessionAuth, sessions.deleteSessionHandler);
router.get('/projects', sessionAuth, sessions.listProjectsHandler);
// The brief (SYNC_SPINE_SPEC 1.3): where the user stands, in one call.
router.get('/brief', auth, brief.getBriefHandler);

// The week and suggestions (LOOP_COMPLETE_SPEC 1.6). Accepting a suggestion is the app's only (tokens
// may not call those routes at all: tokenRoutes.ts).
router.get('/week', auth, week.getWeekHandler);
router.get('/mirror', auth, mirror.getMirrorHandler); // LOOP_COMPLETE_SPEC 1.7
router.get('/mirror/stand', auth, mirror.getStandHandler); // WHERE_YOU_STAND_PLAN §5.5
// The buddy's take on the page (§9): the app's only (no token route: an agent has its own words).
router.get('/mirror/stand/takes', auth, mirror.getStandTakesHandler);
router.post('/mirror/stand/takes', auth, mirror.askStandTakeHandler);
// LeetCode (11-22): their accepted problems logged as practice; the app's only (no token route).
router.get('/leetcode', auth, loop.getLeetcodeHandler);
router.put('/leetcode', auth, loop.setLeetcodeHandler);
router.post('/leetcode/sync', auth, loop.syncLeetcodeHandler);
router.get('/tasks', taskAuth, tasks.listTasksHandler);
router.post('/tasks', taskAuth, idempotency, agentLog.logTaskCreate, tasks.createTaskHandler);
router.patch('/tasks/:id', taskAuth, idempotency, agentLog.logTaskUpdate, tasks.updateTaskHandler);
// Reminders: a personal task with a time (MANAGER_AND_DOCS_PLAN §3.3).
router.get('/reminders', taskAuth, managerTools.listRemindersHandler);
router.get('/reminders/today', taskAuth, managerTools.todayRemindersHandler); // Home's view (the app; not on the token list)
router.post('/reminders', taskAuth, idempotency, agentLog.logReminderSet, managerTools.setReminderHandler);
router.post('/reminders/:id/cancel', taskAuth, idempotency, agentLog.logReminderCancel, managerTools.cancelReminderHandler);
// Stage 7 (V1): his words pinned to the lock screen for a window; clear_lock_line takes one off.
router.get('/lock-pins', taskAuth, managerTools.listLockPinsHandler);
router.post('/lock-pins', taskAuth, idempotency, managerTools.setLockPinHandler);
router.post('/lock-pins/clear', taskAuth, idempotency, managerTools.clearLockPinsHandler);
// The decision journal (LOOP_COMPLETE_SPEC 4.2).
router.get('/decisions', auth, decisions.listDecisionsHandler);
router.post('/decisions', auth, idempotency, agentLog.logDecisionCreate, decisions.createDecisionHandler);
router.patch('/decisions/:id', auth, idempotency, agentLog.logDecisionUpdate, decisions.updateDecisionHandler);
router.post('/week/targets', auth, idempotency, agentLog.logWeekTargetCreate, week.addWeekTargetHandler);
router.patch('/week/targets/:id', auth, idempotency, agentLog.logWeekTargetUpdate, week.updateWeekTargetHandler);
router.get('/suggestions', auth, week.listSuggestionsHandler);
router.post('/suggestions', auth, idempotency, week.proposeSuggestionHandler);
// Level 3 (MANAGER_AND_DOCS_PLAN §3.2): an action kept for the user's tap; only accepting it runs it.
router.post('/actions', auth, idempotency, actions.requestActionHandler);
router.post('/suggestions/decide', auth, week.decideSuggestionsHandler);
router.post('/suggestions/:id/accept', auth, week.acceptSuggestionHandler);
router.post('/suggestions/:id/dismiss', auth, week.dismissSuggestionHandler);
router.patch('/projects/:id', sessionAuth, idempotency, agentLog.logProjectUpdate, sessions.updateProjectHandler);

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
