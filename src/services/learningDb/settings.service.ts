// Learning settings (LEARNING_SPEC §2 #3 + LOOP_V2_SPEC §1): GET / PATCH /api/learning/settings.
// lastNudgeDay and lastSeenDay are system state (the nudge cron and ensure-today write them): they
// are returned but never set through PATCH.
import type { RoutineMode } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { isValidTimeZone, minutesToTime, resolveTimeZone, timeToMinutes, today as todayIn, type DayString } from '../learning';
import { LearningError } from '../learning/errors';
import { serializeLearningSettings, type LearningSettingsJson } from '../../db/serializers/learning';
import { lockLearningContext, toDbDay } from './common';
import { ensureTodaySlots } from './rollover.service';

const settingsSelect = {
    timezone: true,
    routineMode: true,
    dailyBudgetMin: true,
    routineEnabled: true,
    busyUntil: true,
    nudgeEmailEnabled: true,
    nudgeTime: true,
    lastNudgeDay: true,
    lastSeenDay: true,
} as const;

export async function getLearningSettings(userId: string): Promise<LearningSettingsJson> {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: settingsSelect });
    return serializeLearningSettings(row);
}

export interface LearningSettingsInput {
    timezone?: string | undefined;
    routineMode?: RoutineMode | undefined;
    dailyBudgetMin?: number | undefined;
    routineEnabled?: boolean | undefined;
    /** null = busy mode off. */
    busyUntil?: DayString | null | undefined;
    nudgeEmailEnabled?: boolean | undefined;
    /** 'H:mm' or 'HH:mm'; stored as 'HH:mm'. */
    nudgeTime?: string | undefined;
}

/**
 * PATCH: any subset. Switching the routine ON creates today's slots right away (the rollover may
 * already have run today with it off); the next rollovers never backfill the days it was off.
 */
export async function updateLearningSettings(userId: string, input: LearningSettingsInput, now: Date = new Date()): Promise<LearningSettingsJson> {
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
        throw new LearningError('INVALID_TIMEZONE', `Unknown IANA time zone ${JSON.stringify(input.timezone)}`);
    }
    const row = await prisma.$transaction(async (tx) => {
        const before = await lockLearningContext(tx, userId, now);
        const updated = await tx.user.update({
            where: { id: userId },
            data: {
                ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
                ...(input.routineMode !== undefined ? { routineMode: input.routineMode } : {}),
                ...(input.dailyBudgetMin !== undefined ? { dailyBudgetMin: input.dailyBudgetMin } : {}),
                ...(input.routineEnabled !== undefined ? { routineEnabled: input.routineEnabled } : {}),
                ...(input.busyUntil !== undefined ? { busyUntil: input.busyUntil === null ? null : toDbDay(input.busyUntil) } : {}),
                ...(input.nudgeEmailEnabled !== undefined ? { nudgeEmailEnabled: input.nudgeEmailEnabled } : {}),
                ...(input.nudgeTime !== undefined ? { nudgeTime: minutesToTime(timeToMinutes(input.nudgeTime)) } : {}),
            },
            select: settingsSelect,
        });
        if (updated.routineEnabled && !before.user.routineEnabled) {
            // Today in the (possibly new) zone.
            await ensureTodaySlots(tx, userId, todayIn(resolveTimeZone(updated.timezone), now), updated.routineMode);
        }
        return updated;
    });
    return serializeLearningSettings(row);
}
