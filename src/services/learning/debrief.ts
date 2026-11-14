/**
 * The day debrief ("Wrap Up Day", and "Action Required" for one missed day).
 *
 * Sources (revise/src/):
 *   - components/dashboard/DayDebriefModal.tsx  `stats` (Layer 1 auto-context), `handleSave`,
 *                                               the save button's enabled state
 *   - app/actions/debrief.actions.ts            saveDebrief (debrief upsert, slot writes,
 *                                               BlockSessionLog sync)
 */
import { LearningError } from './errors';
import { isResolvedStatus } from './schedule';
import { assertDay, durationMinutes, type DayString } from './time';
import type { BlockLogStatus, DayDebrief, SlotStatus } from './types';

/** A slot as the debrief edits it: the slot plus the user's status / remark. */
export interface DebriefSlot {
  id: string;
  sourceBlockId: string | null;
  startTime: string;
  endTime: string;
  status: SlotStatus;
  remark: string | null;
  minutesDone: number | null;
  actualStartTime: string | null;
  actualEndTime: string | null;
}

export interface DebriefStats {
  /** All slots of the debrief ("x/planned blocks done"). */
  planned: number;
  /** COMPLETED + PARTIAL */
  completed: number;
  skipped: number;
  /** planned - completed - skipped */
  remaining: number;
  focusedMin: number;
  /** focusedMin / 60 with one decimal, as shown ("2.5h"). */
  focusedHrs: string;
}

/**
 * DayDebriefModal `stats`. Focused time counts COMPLETED and PARTIAL blocks:
 * `minutesDone` when it is set and non-zero, otherwise the span from
 * (actualStartTime or startTime) to (actualEndTime or endTime), crossing
 * midnight when the end is earlier.
 */
export function computeDebriefStats(slots: readonly DebriefSlot[]): DebriefStats {
  const planned = slots.length;
  let completed = 0;
  let skipped = 0;
  let focusedMin = 0;
  for (const s of slots) {
    if (s.status === 'SKIPPED') skipped++;
    if (s.status !== 'COMPLETED' && s.status !== 'PARTIAL') continue;
    completed++;
    focusedMin += s.minutesDone
      ? s.minutesDone
      : durationMinutes(s.actualStartTime || s.startTime, s.actualEndTime || s.endTime, 'zero');
  }
  return {
    planned,
    completed,
    skipped,
    remaining: planned - completed - skipped,
    focusedMin,
    focusedHrs: (focusedMin / 60).toFixed(1),
  };
}

/** The debrief form (Layers 2 and 3). */
export interface DebriefForm {
  energy: number | null;
  focus: number | null;
  mood: number | null;
  tags: readonly string[];
  narrative: string;
  tomorrowIntent: string;
  freeWrite: string;
}

const isRating = (v: number | null): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;

/**
 * The save button is enabled once energy, focus and mood are rated (narrative
 * optional). Added: ratings must be integers 1-5 (the only values the modal offers).
 */
export function canSaveDebrief(form: Pick<DebriefForm, 'energy' | 'focus' | 'mood'>): boolean {
  return isRating(form.energy) && isRating(form.focus) && isRating(form.mood);
}

export interface DebriefSavePlan {
  /** Upsert on (owner, date). */
  debrief: DayDebrief;
  /** Written for every slot, as saveDebrief does. */
  slotUpdates: Array<{
    slotId: string;
    status: SlotStatus;
    remark: string | null;
    minutesDone: number | null;
    actualStartTime: string | null;
    actualEndTime: string | null;
  }>;
  /** Slots with a source block and a resolved status, logged under the debrief's date. */
  logUpserts: Array<{ timeBlockId: string; date: DayString; status: BlockLogStatus; remark: string | null; minutesDone: number | null }>;
}

/**
 * DayDebriefModal handleSave + saveDebrief: Layer 1 numbers from
 * `computeDebriefStats`, texts trimmed (empty → null), every slot's status /
 * remark / minutes / actual times written back, and BlockSessionLog upserted
 * for resolved slots that come from a block. Throws DEBRIEF_INVALID unless
 * `canSaveDebrief`.
 */
export function planDebriefSave(date: DayString, slots: readonly DebriefSlot[], form: DebriefForm): DebriefSavePlan {
  assertDay(date);
  if (!canSaveDebrief(form)) {
    throw new LearningError('DEBRIEF_INVALID', 'Rate energy, focus and mood (1-5) to save the debrief');
  }
  const stats = computeDebriefStats(slots);
  return {
    debrief: {
      date,
      blocksPlanned: stats.planned,
      blocksCompleted: stats.completed,
      blocksSkipped: stats.skipped,
      totalFocusedMin: stats.focusedMin,
      energy: form.energy,
      focus: form.focus,
      mood: form.mood,
      tags: [...form.tags],
      narrative: form.narrative.trim() || null,
      tomorrowIntent: form.tomorrowIntent.trim() || null,
      freeWrite: form.freeWrite.trim() || null,
    },
    slotUpdates: slots.map((s) => ({
      slotId: s.id,
      status: s.status,
      remark: s.remark,
      minutesDone: s.minutesDone,
      actualStartTime: s.actualStartTime,
      actualEndTime: s.actualEndTime,
    })),
    logUpserts: slots.flatMap((s) =>
      s.sourceBlockId && isResolvedStatus(s.status)
        ? [{ timeBlockId: s.sourceBlockId, date, status: s.status, remark: s.remark, minutesDone: s.minutesDone }]
        : [],
    ),
  };
}
