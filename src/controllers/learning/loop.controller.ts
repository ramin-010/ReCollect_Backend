// Daily loop v2 (LOOP_V2_SPEC): settings, focus lines, goals + milestones, fresh start. Thin:
// validate with zod (400 INVALID_INPUT), call the learningDb service, wrap in { success, data }.
import { z } from 'zod';
import { requireUser } from '../../middlwares/auth';
import { isValidTime } from '../../services/learning/time';
import { carryOverFocus, createFocusItem, deleteFocusItem, FOCUS_TEXT_MAX, updateFocusItem } from '../../services/learningDb/focus.service';
import {
    createGoal,
    createMilestone,
    deleteGoal,
    deleteMilestone,
    listGoals,
    updateGoal,
    updateMilestone,
} from '../../services/learningDb/goals.service';
import { freshStart } from '../../services/learningDb/plan.service';
import { getLearningSettings, updateLearningSettings } from '../../services/learningDb/settings.service';
import { getLeetcode, setLeetcode, syncLeetcode } from '../../services/learningDb/leetcode.service';
import { handler, ok, param, parse, zDay, zId } from './common';

// ─── §1 Settings ───────────────────────────────────────────────────────

const settingsSchema = z.object({
    timezone: z.string().trim().min(1).max(64).optional(),
    routineMode: z.enum(['MASTER', 'DAILY']).optional(),
    dailyBudgetMin: z.number().int().min(5).max(120).optional(),
    routineEnabled: z.boolean().optional(),
    busyUntil: zDay.nullable().optional(),
    nudgeEmailEnabled: z.boolean().optional(),
    nudgeTime: z.string().refine((v) => isValidTime(v), { message: "must be a time 'HH:mm'" }).optional(),
    agentProfile: z.string().max(600, 'At most 600 characters').nullable().optional(),
});

export const getSettingsHandler = handler(async (req, res) => {
    ok(res, await getLearningSettings(requireUser(req).id));
});

export const patchSettingsHandler = handler(async (req, res) => {
    ok(res, await updateLearningSettings(requireUser(req).id, parse(settingsSchema, req.body)));
});

// ─── §3 Focus ──────────────────────────────────────────────────────────

const focusText = z.string().trim().min(1, 'A focus line cannot be empty').max(FOCUS_TEXT_MAX);
const focusCreateSchema = z.object({ text: focusText });
const focusPatchSchema = z
    .object({ text: focusText.optional(), done: z.boolean().optional() })
    .refine((v) => v.text !== undefined || v.done !== undefined, { message: 'Send text or done' });
const carryOverSchema = z.object({ ids: z.array(zId).min(1).max(20) });

export const createFocusHandler = handler(async (req, res) => {
    const { text } = parse(focusCreateSchema, req.body);
    ok(res, await createFocusItem(requireUser(req).id, text), 201);
});
export const updateFocusHandler = handler(async (req, res) => {
    ok(res, await updateFocusItem(requireUser(req).id, param(req, 'id'), parse(focusPatchSchema, req.body)));
});
export const deleteFocusHandler = handler(async (req, res) => {
    ok(res, await deleteFocusItem(requireUser(req).id, param(req, 'id')));
});
export const carryOverFocusHandler = handler(async (req, res) => {
    const { ids } = parse(carryOverSchema, req.body);
    ok(res, await carryOverFocus(requireUser(req).id, ids));
});

// ─── §4 Goals + milestones ─────────────────────────────────────────────

const goalTitle = z.string().trim().min(1, 'A goal needs a title').max(120);
const goalWhy = z.string().max(500).nullable().optional();
const milestoneTitle = z.string().trim().min(1, 'A milestone needs a title').max(140);
const zSubjectIds = z.array(zId).max(20);

const goalCreateSchema = z.object({
    title: goalTitle,
    why: goalWhy,
    deadline: zDay,
    subjectIds: zSubjectIds.optional(),
    milestones: z.array(z.object({ title: milestoneTitle, dueDay: zDay.nullable().optional() })).max(20).optional(),
});
const goalPatchSchema = z.object({
    title: goalTitle.optional(),
    why: goalWhy,
    deadline: zDay.optional(),
    status: z.enum(['active', 'done', 'archived']).optional(),
    subjectIds: zSubjectIds.optional(),
});
const milestoneCreateSchema = z.object({ title: milestoneTitle, dueDay: zDay.nullable().optional() });
const milestonePatchSchema = z.object({
    title: milestoneTitle.optional(),
    dueDay: zDay.nullable().optional(),
    done: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export const listGoalsHandler = handler(async (req, res) => {
    ok(res, await listGoals(requireUser(req).id));
});
export const createGoalHandler = handler(async (req, res) => {
    ok(res, await createGoal(requireUser(req).id, parse(goalCreateSchema, req.body)), 201);
});
export const updateGoalHandler = handler(async (req, res) => {
    ok(res, await updateGoal(requireUser(req).id, param(req, 'id'), parse(goalPatchSchema, req.body)));
});
export const deleteGoalHandler = handler(async (req, res) => {
    ok(res, await deleteGoal(requireUser(req).id, param(req, 'id')));
});
export const createMilestoneHandler = handler(async (req, res) => {
    ok(res, await createMilestone(requireUser(req).id, param(req, 'id'), parse(milestoneCreateSchema, req.body)), 201);
});
export const updateMilestoneHandler = handler(async (req, res) => {
    ok(res, await updateMilestone(requireUser(req).id, param(req, 'id'), parse(milestonePatchSchema, req.body)));
});
export const deleteMilestoneHandler = handler(async (req, res) => {
    ok(res, await deleteMilestone(requireUser(req).id, param(req, 'id')));
});

// ─── §2 Fresh start ────────────────────────────────────────────────────

const freshStartSchema = z.object({ dryRun: z.boolean().optional() });

/** POST /api/revisions/fresh-start {dryRun?} → { moved, spreadDays } (dryRun: the same answer, nothing written). */
export const freshStartHandler = handler(async (req, res) => {
    const { dryRun } = parse(freshStartSchema, req.body);
    const { moved, spreadDays } = await freshStart(requireUser(req).id, { dryRun });
    ok(res, { moved, spreadDays });
});

// ─── LeetCode (11-22): their accepted problems logged as practice ──────

const leetcodeSchema = z.object({ username: z.string().trim().max(60).nullable() });

export const getLeetcodeHandler = handler(async (req, res) => {
    ok(res, await getLeetcode(requireUser(req).id));
});
export const setLeetcodeHandler = handler(async (req, res) => {
    const { username } = parse(leetcodeSchema, req.body);
    ok(res, await setLeetcode(requireUser(req).id, username ? username : null));
});
export const syncLeetcodeHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const r = await syncLeetcode(userId);
    ok(res, { ...(await getLeetcode(userId)), imported: r.logged });
});
