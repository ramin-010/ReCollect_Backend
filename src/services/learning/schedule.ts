/**
 * Daily schedule engine: time blocks → per-day slots, backfill of missed days,
 * triage of unresolved past slots, the multi-day catch-up, and block adherence.
 *
 * Sources (revise/src/):
 *   - app/actions/schedule-slot.actions.ts  ensureTodaySlots, backfillMissedDays
 *   - app/actions/planner.actions.ts        getUnverifiedBlocks (triage + auto-heal),
 *                                           bulkPreSkip (the correct one-off rule)
 *   - components/dashboard/TriageInterceptor.tsx      1 day → debrief, 2+ days → catch-up
 *   - components/dashboard/MultiDayCatchUpModal.tsx   unresolved → SKIPPED on save
 *   - app/actions/debrief.actions.ts        saveMultiDayCatchUp
 *   - app/(protected)/dashboard/page.tsx    block adherence
 *
 * In Revise all of this ran inside the dashboard GET and wrote to the
 * database during render. Here it is pure: the functions say what to write,
 * and the service layer (a per-user midnight job, or the triage endpoints)
 * writes it.
 */
// debrief.ts imports isResolvedStatus from here; both sides only use the other at call time, so
// the import cycle is harmless (CommonJS and ESM).
import { computeDebriefStats } from './debrief';
import { LearningError } from './errors';
import { addDays, assertDay, dayOf, type DayString, weekday } from './time';
import type {
  BlockLogStatus,
  BlockSessionLog,
  DayDebrief,
  NewScheduleSlot,
  RoutineMode,
  ScheduleSlot,
  SlotStatus,
  TimeBlock,
} from './types';

/** backfillMissedDays never fills more than the last 30 days. */
export const BACKFILL_MAX_DAYS = 30;

/** getUnverifiedBlocks looks back 30 days (matching the backfill cap). */
export const TRIAGE_LOOKBACK_DAYS = 30;

/** COMPLETED, SKIPPED and PARTIAL are "resolved" (DayManagerModal `isPastStatus`). */
export function isResolvedStatus(status: SlotStatus): status is BlockLogStatus {
  return status === 'COMPLETED' || status === 'SKIPPED' || status === 'PARTIAL';
}

/** Prisma's `orderBy: { startTime: 'asc' }` is a plain string order on 'HH:mm'; Array#sort is stable for ties. */
const byStartTime = (a: { startTime: string }, b: { startTime: string }): number =>
  a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0;

// ─────────────────────────────────────────────────────────────────────────────
// Which blocks apply to a day
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does `block` produce a slot on `day`?
 *   - a one-off block (`date` set) applies ONLY on its date, in both modes;
 *   - MASTER mode: recurring blocks with `dayOfWeek === null`;
 *   - DAILY mode: recurring blocks whose `dayOfWeek` is the day's weekday (0 = Monday).
 *
 * Fixed: ensureTodaySlots / backfillMissedDays selected MASTER blocks with
 * `dayOfWeek: null` only, which also matches one-off blocks (they have
 * dayOfWeek null and a date), so a one-off showed up EVERY day in MASTER mode
 * (and never in DAILY mode). This is the rule bulkPreSkip already used.
 */
export function blockAppliesOn(block: TimeBlock, day: DayString, mode: RoutineMode): boolean {
  if (block.date !== null) return block.date === day;
  return mode === 'MASTER' ? block.dayOfWeek === null : block.dayOfWeek === weekday(day);
}

/** The blocks for `day`, ordered by start time (ties keep input order). */
export function blocksForDay(blocks: readonly TimeBlock[], day: DayString, mode: RoutineMode): TimeBlock[] {
  assertDay(day);
  return blocks.filter((b) => blockAppliesOn(b, day, mode)).sort(byStartTime);
}

/**
 * One slot copied from a block. A BlockSessionLog for (block, day) written
 * ahead of time (vacation pre-skip, shift/replace) sets the initial status
 * and copies its remark and minutesDone (ensureTodaySlots / backfillMissedDays).
 */
export function slotFromBlock(
  block: TimeBlock,
  day: DayString,
  sortOrder: number,
  log?: BlockSessionLog,
): NewScheduleSlot {
  return {
    sourceBlockId: block.id,
    date: day,
    title: block.title,
    color: block.color,
    startTime: block.startTime,
    endTime: block.endTime,
    status: log ? log.status : 'UPCOMING',
    actualStartTime: null,
    actualEndTime: null,
    remark: log ? log.remark : null,
    minutesDone: log ? log.minutesDone : null,
    sortOrder,
  };
}

/** The slots `day` should get from the routine; sortOrder follows start time. */
export function generateDaySlots(
  blocks: readonly TimeBlock[],
  day: DayString,
  mode: RoutineMode,
  logs: readonly BlockSessionLog[] = [],
): NewScheduleSlot[] {
  const logByBlock = new Map<string, BlockSessionLog>();
  for (const log of logs) if (log.date === day) logByBlock.set(log.timeBlockId, log);
  return blocksForDay(blocks, day, mode).map((block, index) => slotFromBlock(block, day, index, logByBlock.get(block.id)));
}

/**
 * ensureTodaySlots: a day that already has slots (from an earlier run or the
 * Day Manager) is left alone; otherwise it gets `generateDaySlots`.
 */
export function planDaySlots(
  existingSlots: readonly Pick<ScheduleSlot, 'date'>[],
  blocks: readonly TimeBlock[],
  day: DayString,
  mode: RoutineMode,
  logs: readonly BlockSessionLog[] = [],
): NewScheduleSlot[] {
  if (existingSlots.some((s) => s.date === day)) return [];
  return generateDaySlots(blocks, day, mode, logs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Backfill
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The days backfillMissedDays would fill: from the day after the last day that
 * has slots (or, with no slots at all, the day after the earliest block was
 * created) up to yesterday, capped to the last 30 days. Null when there is
 * nothing to fill. Today is never included (that is `planDaySlots`' job).
 *
 * `notBefore` (daily loop v2): the first day that may be filled. The rollover
 * passes the day it last ran, so days on which the routine was switched off
 * (the rollover ran but made no slots) are never backfilled when it is
 * switched back on: nothing "missed" builds up while it was off.
 */
export function backfillRange(
  lastSlotDay: DayString | null,
  earliestBlockDay: DayString | null,
  today: DayString,
  notBefore: DayString | null = null,
): { from: DayString; to: DayString } | null {
  const startFrom = lastSlotDay ?? earliestBlockDay;
  if (startFrom === null) return null;
  let fillStart = addDays(startFrom, 1);
  if (notBefore !== null && fillStart < notBefore) fillStart = notBefore;
  const fillEnd = addDays(today, -1);
  if (fillStart > fillEnd) return null;
  const cap = addDays(today, -BACKFILL_MAX_DAYS);
  return { from: fillStart < cap ? cap : fillStart, to: fillEnd };
}

export interface BackfillInput {
  /** The most recent day that already has slots, or null if there are none. */
  lastSlotDay: DayString | null;
  blocks: readonly TimeBlock[];
  /** BlockSessionLogs in the window (vacation pre-skips etc.); others are ignored. */
  logs: readonly BlockSessionLog[];
  mode: RoutineMode;
  today: DayString;
  /** Used to turn `TimeBlock.createdAt` into a day when there are no slots yet. */
  tz: string;
  /** The first day that may be filled (see `backfillRange`); omit for no bound. */
  notBefore?: DayString | null;
}

export interface BackfillResult {
  slots: NewScheduleSlot[];
  /** Days that actually received slots (days with no applicable block are skipped). */
  backfilledDays: number;
  startDate: DayString | null;
  endDate: DayString | null;
}

/**
 * backfillMissedDays: creates the slots for days the user never opened the
 * app (now: days the midnight job missed), so triage can ask about them. Uses
 * today's routine mode and blocks for every filled day, as Revise does.
 * Insert with "skip duplicates" on (sourceBlockId, date).
 */
export function backfillMissedDays(input: BackfillInput): BackfillResult {
  const { blocks, logs, mode, today, tz } = input;
  const empty: BackfillResult = { slots: [], backfilledDays: 0, startDate: null, endDate: null };
  if (blocks.length === 0) return empty;

  let earliestBlockDay: DayString | null = null;
  for (const b of blocks) {
    const d = dayOf(b.createdAt, tz);
    if (earliestBlockDay === null || d < earliestBlockDay) earliestBlockDay = d;
  }
  const range = backfillRange(input.lastSlotDay, earliestBlockDay, today, input.notBefore ?? null);
  if (!range) return empty;

  const result: BackfillResult = { ...empty, slots: [] };
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    const daySlots = generateDaySlots(blocks, day, mode, logs);
    if (daySlots.length === 0) continue;
    result.slots.push(...daySlots);
    result.backfilledDays++;
    if (result.startDate === null) result.startDate = day;
    result.endDate = day;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Triage
// ─────────────────────────────────────────────────────────────────────────────

/** A slot whose BlockSessionLog already says how it went: copy status + remark onto it. */
export interface SlotHeal {
  slotId: string;
  status: BlockLogStatus;
  remark: string | null;
}

export interface TriageScan {
  /** Past slots still UPCOMING, oldest day first, then sortOrder. */
  unverified: ScheduleSlot[];
  /** Write these first; they are no longer unverified. */
  heal: SlotHeal[];
}

/**
 * getUnverifiedBlocks: slots dated in the last 30 days (strictly before
 * today) that are still UPCOMING. A slot whose source block has a
 * BlockSessionLog for that same day is "auto-healed" (status and remark
 * copied from the log) instead of being asked about.
 *
 * Changed: Revise matched the log to the slot when their dates were within
 * 24 hours, which also matched the previous or next day's log (so skipping
 * gym on Monday could heal Tuesday's gym slot). With calendar days the match
 * is exact.
 */
export function findTriageSlots(
  slots: readonly ScheduleSlot[],
  logs: readonly BlockSessionLog[],
  today: DayString,
): TriageScan {
  const from = addDays(today, -TRIAGE_LOOKBACK_DAYS);
  const logByKey = new Map<string, BlockSessionLog>();
  for (const log of logs) logByKey.set(`${log.timeBlockId}|${log.date}`, log);

  const candidates = slots
    .filter((s) => s.status === 'UPCOMING' && s.date >= from && s.date < today)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sortOrder - b.sortOrder));

  const scan: TriageScan = { unverified: [], heal: [] };
  for (const slot of candidates) {
    const log = slot.sourceBlockId ? logByKey.get(`${slot.sourceBlockId}|${slot.date}`) : undefined;
    if (log) scan.heal.push({ slotId: slot.id, status: log.status, remark: log.remark });
    else scan.unverified.push(slot);
  }
  return scan;
}

/** What the dashboard should ask about past days (TriageInterceptor.tsx). */
export type TriagePlan =
  | { kind: 'none' }
  /** One day: the debrief modal as "Action Required", for that day's unresolved slots. */
  | { kind: 'debrief'; date: DayString; slots: ScheduleSlot[] }
  /** Two or more days: the multi-day catch-up, one shared context for all of them. */
  | { kind: 'catch-up'; days: Array<{ date: DayString; slots: ScheduleSlot[] }> };

/**
 * Mirrors TriageInterceptor: no unverified slots → nothing; slots on 2+
 * distinct days → catch-up; otherwise the debrief for that day. (The debrief
 * then counts only these unresolved slots as "planned", as Revise does.)
 */
export function planTriage(unverified: readonly ScheduleSlot[]): TriagePlan {
  if (unverified.length === 0) return { kind: 'none' };
  const byDate = new Map<DayString, ScheduleSlot[]>();
  for (const slot of unverified) {
    const list = byDate.get(slot.date);
    if (list) list.push(slot);
    else byDate.set(slot.date, [slot]);
  }
  const days = [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, list]) => ({ date, slots: list }));
  const only = days[0];
  if (days.length === 1 && only) return { kind: 'debrief', date: only.date, slots: only.slots };
  return { kind: 'catch-up', days };
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-day catch-up
// ─────────────────────────────────────────────────────────────────────────────

export type CatchUpDecision = 'COMPLETED' | 'SKIPPED' | 'UNRESOLVED';

/** The shared context the catch-up asks for once, for every missed day. */
export interface CatchUpContext {
  energy: number | null;
  focus: number | null;
  mood: number | null;
  tags: readonly string[];
  narrative: string;
}

export interface CatchUpInput {
  /** The missed days ('YYYY-MM-DD'). */
  dates: readonly DayString[];
  context: CatchUpContext;
  /** Per-slot exceptions ("I did do gym that day"); slots not listed stay UNRESOLVED. */
  decisions: ReadonlyArray<{ slotId: string; status: CatchUpDecision; remark?: string | null }>;
  /** Every slot on `dates` (resolved ones too: they count in the day's stats). */
  slots: readonly ScheduleSlot[];
  /** Debriefs already saved for any of `dates` (a reopened, half-finished catch-up). */
  existingDebriefs: readonly DayDebrief[];
}

export interface CatchUpResult {
  slotUpdates: Array<{ slotId: string; status: 'COMPLETED' | 'SKIPPED'; remark: string | null }>;
  logUpserts: Array<{ timeBlockId: string; date: DayString; status: 'COMPLETED' | 'SKIPPED'; remark: string | null }>;
  /** One full row per date, to upsert on (owner, date). */
  debriefs: DayDebrief[];
}

const isRating = (v: number | null): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;

/**
 * MultiDayCatchUpModal `canSave`: energy, focus and mood rated and a
 * non-empty narrative. (Added: ratings must be integers 1-5; the modal only
 * offered those.)
 */
export function canSaveCatchUp(context: CatchUpContext): boolean {
  return isRating(context.energy) && isRating(context.focus) && isRating(context.mood) && context.narrative.trim().length > 0;
}

/**
 * Applies a catch-up as a pure transformation (MultiDayCatchUpModal handleSave
 * + debrief.actions.ts saveMultiDayCatchUp):
 *   - every still-UPCOMING slot on the dates is resolved: an explicit
 *     COMPLETED / SKIPPED decision wins, everything else (UNRESOLVED or no
 *     decision) becomes SKIPPED; a decision may also correct an already
 *     resolved slot on those dates; ids not on the dates are ignored;
 *   - remarks are trimmed, empty → null;
 *   - each resolved slot with a source block gets a BlockSessionLog upsert;
 *   - each date gets a debrief with the shared context (energy, focus, mood,
 *     tags, narrative) and stats from ALL its slots after the updates:
 *     planned = slots, completed = COMPLETED + PARTIAL, skipped = SKIPPED,
 *     totalFocusedMin = the COMPLETED/PARTIAL slots' minutes, all via
 *     `computeDebriefStats` (fixed: Revise's raw SQL wrote 0). tomorrowIntent /
 *     freeWrite of an existing debrief are kept, as Revise did.
 * Throws CATCH_UP_INVALID if `canSaveCatchUp` fails.
 * Apply `findTriageSlots(...).heal` before this, so healed slots are not skipped.
 */
export function applyCatchUp(input: CatchUpInput): CatchUpResult {
  if (!canSaveCatchUp(input.context)) {
    throw new LearningError('CATCH_UP_INVALID', 'A catch-up needs energy, focus and mood (1-5) and a narrative');
  }
  const dates = [...new Set(input.dates.map((d) => assertDay(d)))].sort();
  const dateSet = new Set(dates);
  const slots = input.slots.filter((s) => dateSet.has(s.date));
  const decisionById = new Map(input.decisions.map((d) => [d.slotId, d]));

  const result: CatchUpResult = { slotUpdates: [], logUpserts: [], debriefs: [] };
  const newStatus = new Map<string, SlotStatus>();
  for (const slot of slots) {
    const decision = decisionById.get(slot.id);
    const explicit = decision && decision.status !== 'UNRESOLVED' ? decision.status : null;
    if (explicit === null && slot.status !== 'UPCOMING') continue; // nothing to resolve
    const status: 'COMPLETED' | 'SKIPPED' = explicit ?? 'SKIPPED';
    const remark = decision?.remark?.trim() || null;
    newStatus.set(slot.id, status);
    result.slotUpdates.push({ slotId: slot.id, status, remark });
    if (slot.sourceBlockId) {
      result.logUpserts.push({ timeBlockId: slot.sourceBlockId, date: slot.date, status, remark });
    }
  }

  const existingByDate = new Map(input.existingDebriefs.map((d) => [d.date, d]));
  const narrative = input.context.narrative.trim();
  for (const date of dates) {
    const daySlots = slots
      .filter((slot) => slot.date === date)
      .map((slot) => ({ ...slot, status: newStatus.get(slot.id) ?? slot.status }));
    const stats = computeDebriefStats(daySlots);
    const existing = existingByDate.get(date);
    result.debriefs.push({
      date,
      blocksPlanned: stats.planned,
      blocksCompleted: stats.completed,
      blocksSkipped: stats.skipped,
      totalFocusedMin: stats.focusedMin,
      energy: input.context.energy,
      focus: input.context.focus,
      mood: input.context.mood,
      tags: [...input.context.tags],
      narrative,
      tomorrowIntent: existing?.tomorrowIntent ?? null,
      freeWrite: existing?.freeWrite ?? null,
    });
  }
  return result;
}

/**
 * The context to prefill when the catch-up reopens for days that already have
 * a saved debrief (MultiDayCatchUpModal + getDebriefsForDates). Revise took
 * whichever row came first; this takes the earliest date.
 */
export function catchUpPrefill(existingDebriefs: readonly DayDebrief[]): CatchUpContext | null {
  const first = [...existingDebriefs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0];
  if (!first) return null;
  return {
    energy: first.energy,
    focus: first.focus,
    mood: first.mood,
    tags: [...(first.tags ?? [])],
    narrative: first.narrative ?? '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Adherence
// ─────────────────────────────────────────────────────────────────────────────

export interface AdherenceStats {
  /** % of slots COMPLETED or PARTIAL over the 7 days before today; null with no slots. */
  adherence: number | null;
  /** The same for the 7 days before that. */
  priorAdherence: number | null;
  /** adherence - priorAdherence (points), null unless both exist. Positive = improving. */
  adherenceDelta: number | null;
  adherenceDone: number;
  adherenceTotal: number;
}

/**
 * Block adherence from dashboard/page.tsx: a slot counts as hit only if
 * COMPLETED or PARTIAL; SKIPPED and never-resolved count against it. Today is
 * excluded (still in progress). "This week" is [today - 7, today), the prior
 * week [today - 14, today - 7). rate = round(hit / total * 100).
 */
export function computeAdherence(
  slots: ReadonlyArray<Pick<ScheduleSlot, 'date' | 'status'>>,
  today: DayString,
): AdherenceStats {
  const weekStart = addDays(today, -7);
  const priorStart = addDays(today, -14);
  const thisWeek = slots.filter((s) => s.date >= weekStart && s.date < today);
  const priorWeek = slots.filter((s) => s.date >= priorStart && s.date < weekStart);
  const hits = (rows: typeof slots): number => rows.filter((r) => r.status === 'COMPLETED' || r.status === 'PARTIAL').length;
  const rate = (rows: typeof slots): number | null => (rows.length === 0 ? null : Math.round((hits(rows) / rows.length) * 100));
  const adherence = rate(thisWeek);
  const priorAdherence = rate(priorWeek);
  return {
    adherence,
    priorAdherence,
    adherenceDelta: adherence !== null && priorAdherence !== null ? adherence - priorAdherence : null,
    adherenceDone: hits(thisWeek),
    adherenceTotal: thisWeek.length,
  };
}
