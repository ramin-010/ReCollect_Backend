// Schedule, debriefs, catch-up, time blocks, goal shift and the mentor export (#25–33). Thin.
import { z } from 'zod';
import { requireUser } from '../../middlwares/auth';
import { mentorExport, shiftGoal } from '../../services/learningDb/misc.service';
import {
    createTimeBlock,
    deleteTimeBlock,
    listTimeBlocks,
    saveCatchUp,
    saveDebrief,
    saveTodaySchedule,
    updateTimeBlock,
} from '../../services/learningDb/schedule.service';
import { handler, ok, param, parse, zDay, zId, zRating, zSlotStatus } from './common';

const zTime = z.string().max(5);
const zMinutes = z.number().int().min(0).max(24 * 60).nullable().optional();

// ─── #25 ───────────────────────────────────────────────────────────────

const scheduleSchema = z.object({
    slots: z
        .array(
            z.object({
                _id: zId,
                title: z.string().max(200),
                color: z.string().max(32),
                startTime: zTime,
                endTime: zTime,
                status: zSlotStatus,
                sortOrder: z.number().int().min(0).max(10_000),
                remark: z.string().max(2000).nullable().optional(),
                minutesDone: zMinutes,
            })
        )
        .max(100),
});

export const saveTodayScheduleHandler = handler(async (req, res) => {
    const { slots } = parse(scheduleSchema, req.body);
    ok(res, await saveTodaySchedule(requireUser(req).id, slots));
});

// ─── #26 ───────────────────────────────────────────────────────────────

const debriefSchema = z.object({
    form: z.object({
        energy: zRating,
        focus: zRating,
        mood: zRating,
        tags: z.array(z.string().max(64)).max(30).default([]),
        narrative: z.string().max(20_000).default(''),
        tomorrowIntent: z.string().max(20_000).default(''),
        freeWrite: z.string().max(50_000).default(''),
    }),
    slots: z
        .array(
            z.object({
                _id: zId,
                status: zSlotStatus,
                remark: z.string().max(2000).nullable().optional(),
                minutesDone: zMinutes,
                actualStartTime: zTime.nullable().optional(),
                actualEndTime: zTime.nullable().optional(),
            })
        )
        .max(100)
        .default([]),
});

export const saveDebriefHandler = handler(async (req, res) => {
    const day = parse(zDay, req.params.day);
    const { form, slots } = parse(debriefSchema, req.body);
    ok(res, await saveDebrief(requireUser(req).id, day, form, slots));
});

// ─── #27 ───────────────────────────────────────────────────────────────

const catchUpSchema = z.object({
    dates: z.array(zDay).min(1).max(31),
    context: z.object({
        energy: zRating,
        focus: zRating,
        mood: zRating,
        tags: z.array(z.string().max(64)).max(30).default([]),
        narrative: z.string().max(20_000).default(''),
    }),
    decisions: z
        .array(z.object({ slotId: zId, status: z.enum(['COMPLETED', 'SKIPPED', 'UNRESOLVED']), remark: z.string().max(2000).nullable().optional() }))
        .max(500)
        .default([]),
});

export const catchUpHandler = handler(async (req, res) => {
    ok(res, await saveCatchUp(requireUser(req).id, parse(catchUpSchema, req.body)));
});

// ─── #28, #29 ──────────────────────────────────────────────────────────

const shiftSchema = z.object({ target: z.enum(['THIS_WEEK', 'MONTHLY']) });

export const shiftGoalHandler = handler(async (req, res) => {
    const { target } = parse(shiftSchema, req.body);
    ok(res, await shiftGoal(requireUser(req).id, param(req, 'todoId'), target));
});

const exportSchema = z.object({ from: zDay, to: zDay });

export const mentorExportHandler = handler(async (req, res) => {
    const { from, to } = parse(exportSchema, req.query);
    ok(res, await mentorExport(requireUser(req).id, from, to));
});

// ─── #30–33 Time blocks ────────────────────────────────────────────────

const blockSchema = z.object({
    title: z.string().max(200),
    startTime: zTime,
    endTime: zTime,
    color: z.string().max(32).optional(),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    date: zDay.nullable().optional(),
});

export const listBlocksHandler = handler(async (req, res) => {
    ok(res, await listTimeBlocks(requireUser(req).id));
});
export const createBlockHandler = handler(async (req, res) => {
    ok(res, await createTimeBlock(requireUser(req).id, parse(blockSchema, req.body)), 201);
});
export const updateBlockHandler = handler(async (req, res) => {
    ok(res, await updateTimeBlock(requireUser(req).id, param(req, 'id'), parse(blockSchema.partial(), req.body)));
});
export const deleteBlockHandler = handler(async (req, res) => {
    ok(res, await deleteTimeBlock(requireUser(req).id, param(req, 'id')));
});
