// Schedule writes (LEARNING_SPEC §2 #25–27, #30–33): the Day Manager save, the day debrief, the
// multi-day catch-up and the routine's time blocks. The engine plans each write
// (planDayScheduleSave, stampActualTimes, planDebriefSave, findTriageSlots + applyCatchUp); this
// file only loads rows, applies the plan in one transaction and shapes the response.
import type { Prisma, SlotStatus } from '@prisma/client';
import { prisma, type TxClient } from '../../db/prisma';
import {

    applyCatchUp,
    findTriageSlots,

    planDayScheduleSave,
    planDebriefSave,
    stampActualTimes,
    type CatchUpDecision,
    type DayManagerSlotUpdate,
    type DayString,
    type DebriefForm,
    type DebriefSlot,
} from '../learning';
import { LearningError } from '../learning/errors';
import { badRequest, notFound } from '../learning/http';
import { serializeDebrief, serializeSlot, serializeTimeBlock } from '../../db/serializers/learning';
import {
    debriefData,

    loadBlockLogs,
    lockLearningContext,
    nowHHmm,
    requireTime,
    toDbDay,
    toEngineDebrief,
    toEngineSlot,
    upsertBlockLog,
} from './common';

async function daySlots(userId: string, day: DayString, db: TxClient | typeof prisma = prisma) {
    return db.dailyScheduleSlot.findMany({ where: { userId, date: toDbDay(day) }, orderBy: [{ sortOrder: 'asc' }, { startTime: 'asc' }] });
}

// ─── #25 Day Manager save ──────────────────────────────────────────────

export interface ScheduleSlotInput {
    /** 'new-…' = create */
    _id: string;
    title: string;
    color: string;
    startTime: string;
    endTime: string;
    status: SlotStatus;
    sortOrder: number;
    remark?: string | null | undefined;
    minutesDone?: number | null | undefined;
}

/**
 * PUT /api/schedule/today: today's slots become exactly `slots` (missing ones are deleted,
 * 'new-…' ones created UPCOMING), actual start/end times are stamped on status changes, and
 * resolved slots from a block keep their BlockSessionLog in sync. Returns today's slots.
 */
export async function saveTodaySchedule(userId: string, slots: readonly ScheduleSlotInput[], now: Date = new Date()) {
    for (const s of slots) {
        requireTime(s.startTime, 'startTime');
        requireTime(s.endTime, 'endTime');
    }
    const today = await prisma.$transaction(async (tx) => {
        const ctx = await lockLearningContext(tx, userId, now);
        const existingRows = await daySlots(userId, ctx.today, tx);
        const updates: DayManagerSlotUpdate[] = slots.map((s) => ({
            id: s._id,
            title: s.title.trim() || 'New Block',
            color: s.color,
            startTime: s.startTime,
            endTime: s.endTime,
            status: s.status,
            sortOrder: s.sortOrder,
            remark: s.remark?.trim() || null,
            ...(s.minutesDone !== undefined ? { minutesDone: s.minutesDone } : {}),
        }));
        const plan = planDayScheduleSave(existingRows.map(toEngineSlot), updates, ctx.today);
        const clock = nowHHmm(ctx);
        const byId = new Map(existingRows.map((r) => [r.id, r]));

        if (plan.deleteIds.length > 0) await tx.dailyScheduleSlot.deleteMany({ where: { userId, id: { in: plan.deleteIds } } });
        if (plan.creates.length > 0) {
            await tx.dailyScheduleSlot.createMany({ data: plan.creates.map((c) => ({ ...c, userId, date: toDbDay(c.date) })) });
        }
        for (const u of plan.updates) {
            const row = byId.get(u.id)!;
            const times = stampActualTimes(row, u, clock);
            await tx.dailyScheduleSlot.update({
                where: { id: u.id },
                data: {
                    title: u.title,
                    color: u.color,
                    startTime: u.startTime,
                    endTime: u.endTime,
                    status: u.status,
                    sortOrder: u.sortOrder,
                    remark: u.remark,
                    ...times,
                    ...(u.minutesDone !== undefined ? { minutesDone: u.minutesDone } : {}),
                },
                select: { id: true },
            });
        }
        for (const log of plan.logUpserts) {
            const u = plan.updates.find((x) => byId.get(x.id)?.sourceBlockId === log.timeBlockId);
            await upsertBlockLog({ ...log, ...(u?.minutesDone !== undefined ? { minutesDone: u.minutesDone } : {}) }, tx);
        }
        return ctx.today;
    });
    return (await daySlots(userId, today)).map(serializeSlot);
}

// ─── #26 Day debrief ───────────────────────────────────────────────────

export interface DebriefSlotInput {
    _id: string;
    status: SlotStatus;
    remark?: string | null | undefined;
    minutesDone?: number | null | undefined;
    actualStartTime?: string | null | undefined;
    actualEndTime?: string | null | undefined;
}

/**
 * PUT /api/debriefs/:day (day ≤ today): the debrief is computed over ALL of the day's slots with
 * the client's edits merged in (so `planned` counts every block), every slot's status / remark /
 * minutes / actual times are written, and resolved block slots get their BlockSessionLog.
 */
export async function saveDebrief(userId: string, day: DayString, form: DebriefForm, edits: readonly DebriefSlotInput[], now: Date = new Date()) {
    for (const e of edits) {
        if (e.actualStartTime) requireTime(e.actualStartTime, 'actualStartTime');
        if (e.actualEndTime) requireTime(e.actualEndTime, 'actualEndTime');
    }
    const id = await prisma.$transaction(async (tx) => {
        const ctx = await lockLearningContext(tx, userId, now);
        if (day > ctx.today) throw badRequest('A debrief can only be saved for today or an earlier day', 'INVALID_DAY');
        const rows = await daySlots(userId, day, tx);
        const editById = new Map(edits.map((e) => [e._id, e]));
        const slots: DebriefSlot[] = rows.map((r) => {
            const e = editById.get(r.id);
            return {
                id: r.id,
                sourceBlockId: r.sourceBlockId,
                startTime: r.startTime,
                endTime: r.endTime,
                status: e ? e.status : r.status,
                remark: e && e.remark !== undefined ? e.remark?.trim() || null : r.remark,
                minutesDone: e && e.minutesDone !== undefined ? e.minutesDone : r.minutesDone,
                actualStartTime: e && e.actualStartTime !== undefined ? e.actualStartTime || null : r.actualStartTime,
                actualEndTime: e && e.actualEndTime !== undefined ? e.actualEndTime || null : r.actualEndTime,
            };
        });
        const plan = planDebriefSave(day, slots, form);
        for (const u of plan.slotUpdates) {
            await tx.dailyScheduleSlot.update({
                where: { id: u.slotId },
                data: {
                    status: u.status,
                    remark: u.remark,
                    minutesDone: u.minutesDone,
                    actualStartTime: u.actualStartTime,
                    actualEndTime: u.actualEndTime,
                },
                select: { id: true },
            });
        }
        for (const log of plan.logUpserts) await upsertBlockLog(log, tx);
        const data = debriefData(plan.debrief);
        const saved = await tx.dayDebrief.upsert({
            where: { userId_date: { userId, date: toDbDay(day) } },
            create: { userId, date: toDbDay(day), ...data },
            update: data,
            select: { id: true },
        });
        return saved.id;
    });
    return serializeDebrief(await prisma.dayDebrief.findUniqueOrThrow({ where: { id } }));
}

// ─── #27 Multi-day catch-up ────────────────────────────────────────────

export interface CatchUpInput {
    dates: DayString[];
    context: { energy: number | null; focus: number | null; mood: number | null; tags: string[]; narrative: string };
    decisions: Array<{ slotId: string; status: CatchUpDecision; remark?: string | null | undefined }>;
}

/**
 * POST /api/schedule/catch-up: heal first (slots whose log already says how they went), then
 * engine applyCatchUp over every slot of the (past) dates; one debrief per date.
 */
export async function saveCatchUp(userId: string, input: CatchUpInput, now: Date = new Date()) {
    const dates = [...new Set(input.dates)].sort();
    if (dates.length === 0) throw new LearningError('CATCH_UP_INVALID', 'Pick at least one day to catch up on');
    const ids = await prisma.$transaction(async (tx) => {
        const ctx = await lockLearningContext(tx, userId, now);
        const last = dates[dates.length - 1]!;
        if (last >= ctx.today) throw new LearningError('CATCH_UP_INVALID', 'A catch-up is only for days before today');

        const rows = await tx.dailyScheduleSlot.findMany({
            where: { userId, date: { in: dates.map(toDbDay) } },
            orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }],
        });
        const logs = await loadBlockLogs(userId, dates[0]!, last, tx);
        const slots = rows.map(toEngineSlot);

        const { heal } = findTriageSlots(slots, logs, ctx.today);
        const healed = new Map(heal.map((h) => [h.slotId, h]));
        for (const h of heal) {
            await tx.dailyScheduleSlot.update({ where: { id: h.slotId }, data: { status: h.status, remark: h.remark }, select: { id: true } });
        }
        const afterHeal = slots.map((s) => {
            const h = healed.get(s.id);
            return h ? { ...s, status: h.status as SlotStatus, remark: h.remark } : s;
        });

        const existing = await tx.dayDebrief.findMany({ where: { userId, date: { in: dates.map(toDbDay) } } });
        const result = applyCatchUp({
            dates,
            context: input.context,
            decisions: input.decisions.map((d) => ({ slotId: d.slotId, status: d.status, remark: d.remark ?? null })),
            slots: afterHeal,
            existingDebriefs: existing.map(toEngineDebrief),
        });
        for (const u of result.slotUpdates) {
            await tx.dailyScheduleSlot.update({ where: { id: u.slotId }, data: { status: u.status, remark: u.remark }, select: { id: true } });
        }
        for (const log of result.logUpserts) await upsertBlockLog(log, tx);
        const savedIds: string[] = [];
        for (const d of result.debriefs) {
            const data = debriefData(d);
            const saved = await tx.dayDebrief.upsert({
                where: { userId_date: { userId, date: toDbDay(d.date) } },
                create: { userId, date: toDbDay(d.date), ...data },
                update: data,
                select: { id: true },
            });
            savedIds.push(saved.id);
        }
        return savedIds;
    });
    const debriefs = await prisma.dayDebrief.findMany({ where: { id: { in: ids } }, orderBy: { date: 'asc' } });
    return { debriefs: debriefs.map(serializeDebrief) };
}

// ─── #30–33 Time blocks (the routine) ──────────────────────────────────

export interface TimeBlockInput {
    title?: string | undefined;
    startTime?: string | undefined;
    endTime?: string | undefined;
    color?: string | undefined;
    /** 0 = Mon … 6 = Sun (DAILY routine); null for MASTER blocks */
    dayOfWeek?: number | null | undefined;
    /** a one-off block for this day only */
    date?: DayString | null | undefined;
}

export const DEFAULT_BLOCK_COLOR = '#8b5cf6';

function timeBlockData(input: TimeBlockInput): Prisma.TimeBlockUncheckedUpdateInput {
    const data: Prisma.TimeBlockUncheckedUpdateInput = {};
    if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) throw badRequest('A block needs a title');
        data.title = title;
    }
    if (input.startTime !== undefined) data.startTime = requireTime(input.startTime, 'startTime');
    if (input.endTime !== undefined) data.endTime = requireTime(input.endTime, 'endTime');
    if (input.color !== undefined) data.color = input.color.trim() || DEFAULT_BLOCK_COLOR;
    if (input.dayOfWeek !== undefined) data.dayOfWeek = input.dayOfWeek;
    if (input.date !== undefined) data.date = input.date === null ? null : toDbDay(input.date);
    return data;
}

/** #30: the routine, by weekday then start time (MASTER blocks first). */
export async function listTimeBlocks(userId: string) {
    const rows = await prisma.timeBlock.findMany({
        where: { userId },
        orderBy: [{ date: { sort: 'asc', nulls: 'first' } }, { dayOfWeek: { sort: 'asc', nulls: 'first' } }, { startTime: 'asc' }],
    });
    return rows.map(serializeTimeBlock);
}

/** #31 */
export async function createTimeBlock(userId: string, input: TimeBlockInput) {
    if (input.title === undefined || input.startTime === undefined || input.endTime === undefined) {
        throw badRequest('title, startTime and endTime are required');
    }
    const data = timeBlockData(input);
    const row = await prisma.timeBlock.create({
        data: {
            userId,
            title: data.title as string,
            startTime: data.startTime as string,
            endTime: data.endTime as string,
            color: (data.color as string | undefined) ?? DEFAULT_BLOCK_COLOR,
            dayOfWeek: (data.dayOfWeek as number | null | undefined) ?? null,
            date: (data.date as Date | null | undefined) ?? null,
        },
    });
    return serializeTimeBlock(row);
}

/** #32: changes apply to days whose slots are created from now on (today's slots are not touched, as Revise). */
export async function updateTimeBlock(userId: string, blockId: string, input: TimeBlockInput) {
    const { count } = await prisma.timeBlock.updateMany({ where: { id: blockId, userId }, data: timeBlockData(input) as Prisma.TimeBlockUpdateManyMutationInput });
    if (count === 0) throw notFound();
    return serializeTimeBlock(await prisma.timeBlock.findUniqueOrThrow({ where: { id: blockId } }));
}

/** #33: its logs go; existing slots stay (sourceBlockId SET NULL). */
export async function deleteTimeBlock(userId: string, blockId: string): Promise<{ deleted: true }> {
    const { count } = await prisma.timeBlock.deleteMany({ where: { id: blockId, userId } });
    if (count === 0) throw notFound();
    return { deleted: true };
}

// ─── Reads used by GET /api/today and the export ───────────────────────

export function slotsBetween(userId: string, from: DayString, toExclusive: DayString) {
    return prisma.dailyScheduleSlot.findMany({
        where: { userId, date: { gte: toDbDay(from), lt: toDbDay(toExclusive) } },
        orderBy: [{ date: 'asc' }, { sortOrder: 'asc' }],
    });
}

export { daySlots };
