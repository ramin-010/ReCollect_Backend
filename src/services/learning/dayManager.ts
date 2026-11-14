/**
 * The Day Manager's scheduling logic, extracted from
 * revise/src/components/dashboard/DayManagerModal.tsx (and the save half of
 * revise/src/app/actions/schedule-slot.actions.ts updateDaySchedule).
 *
 * Each React handler of the modal becomes a pure function
 * `(state, ...args) => newState`, with the same behaviour, including the
 * quirks documented below, so the rebuilt modal can keep Revise's feel:
 *
 *   DayManagerModal                 here
 *   ─────────────────────────────   ──────────────────────────────
 *   useEffect init                  initDayManager
 *   recalculate                     recalculate
 *   handleUpdate                    updateSlot (+ editStartTime, editEndTime,
 *                                   togglePin, stepDuration, setDuration)
 *   handleDelete                    deleteSlot
 *   handleAddBlock                  addBlock
 *   handleCreateCustomBlock         createCustomBlock
 *   handleFillGap                   fillGap
 *   handlePushDelay ("+30m")        pushDelay
 *   handleDayStartChange            setDayStart
 *   handleDragEnd                   moveSlot
 *   gap / overlap rendering         dayManagerRows
 *   header counts                   dayManagerSummary
 *   handleSave                      toSaveUpdates
 *   updateDaySchedule (server)      planDayScheduleSave
 *
 * Times are minutes since local midnight; "now" is passed in as
 * `nowMinutes` (use `minutesOfDay(new Date(), userTz)`), where Revise read
 * the browser clock.
 *
 * Deliberate differences from Revise (everything else is the same):
 *   - Revise's `formatTime` wrapped a value past midnight only once, so a
 *     block ending 48 h or more after midnight produced strings like '25:20';
 *     `minutesToTime` wraps fully.
 *   - Blocks after midnight: `recalculate` reads a start that is more than
 *     12 h before the cascade point as the next day, so a 00:30 block after a
 *     22:00 one keeps its length instead of collapsing to 5 minutes.
 *   - "Delay +30m" pushes the rest of the day back by 30 minutes (durations
 *     and gaps kept) instead of shrinking the first block (Ramin's choice).
 *   - Saving stamps actual start / end times (`stampActualTimes`), which
 *     Revise never set.
 */
import { isResolvedStatus } from './schedule';
import { MINUTES_PER_DAY, minutesToTime, timeToMinutes, type DayString } from './time';
import type { BlockLogStatus, NewScheduleSlot, ScheduleSlot, SlotStatus } from './types';

const parseTime = timeToMinutes;
const formatTime = minutesToTime;

/** The modal's local slot (DayManagerModal `LocalSlot`). */
export interface DayManagerSlot {
  id: string;
  title: string;
  color: string;
  /** 'HH:mm' */
  startTime: string;
  /** 'HH:mm' */
  endTime: string;
  status: SlotStatus;
  sortOrder: number;
  durationMin: number;
  /** A pinned block keeps its start time; the others cascade. */
  isPinned: boolean;
  remark?: string | null;
}

export interface DayManagerState {
  slots: DayManagerSlot[];
  /** "Resume at": where the cascade of unresolved blocks starts. */
  dayStartMin: number;
}

/** A slot as the modal receives it (today's DailyScheduleSlot rows). */
export interface DayManagerInputSlot {
  id: string;
  title: string;
  color: string;
  startTime: string;
  endTime: string;
  status: SlotStatus;
  sortOrder: number;
  remark?: string | null;
}

/** Colours and defaults used by the modal. */
export const DAY_MANAGER_COLORS = {
  block: '#8b5cf6',
  break: '#6b7280',
} as const;

/** Revise ids new slots `new-<Date.now()>`; updateDaySchedule creates any id starting with 'new-'. */
export function newSlotId(prefix: 'new' | 'new-break' = 'new', now: number = Date.now()): string {
  return `${prefix}-${now}`;
}

/** Resolved blocks are shown read-only under "Earlier" (DayManagerModal `isPastStatus`). */
export const isPastStatus = (status: SlotStatus): boolean => isResolvedStatus(status);

const withState = (state: DayManagerState, slots: DayManagerSlot[], dayStartMin = state.dayStartMin): DayManagerState => ({
  slots,
  dayStartMin,
});

// ─────────────────────────────────────────────────────────────────────────────
// Init + the recalculation engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The modal's open effect: durations from start/end (a zero or negative span
 * is taken as crossing midnight: `dur <= 0 → dur + 1440`), nothing pinned,
 * ordered by sortOrder. "Resume at" starts at the first unresolved block; if
 * every block is resolved, at the end of the last one; with no blocks, at the
 * start of the current hour.
 */
export function initDayManager(initialSlots: readonly DayManagerInputSlot[], nowMinutes: number): DayManagerState {
  const slots = initialSlots
    .map((s): DayManagerSlot => {
      let durationMin = parseTime(s.endTime) - parseTime(s.startTime);
      if (durationMin <= 0) durationMin += MINUTES_PER_DAY;
      return { ...s, durationMin, isPinned: false };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const firstFuture = slots.find((s) => !isPastStatus(s.status));
  if (firstFuture) return { slots, dayStartMin: parseTime(firstFuture.startTime) };
  const past = slots.filter((s) => isPastStatus(s.status));
  const lastPast = past[past.length - 1];
  return { slots, dayStartMin: lastPast ? parseTime(lastPast.endTime) : Math.floor(nowMinutes / 60) * 60 };
}

/** Half a day: a start this far before the cascade point belongs to the next day. */
const NEXT_DAY_THRESHOLD_MIN = MINUTES_PER_DAY / 2;

/** A wall-clock start read relative to `refMin` (which may be past 24:00): after midnight → + 1440. */
function unwrapStart(startMin: number, refMin: number): number {
  let m = startMin;
  while (m < refMin - NEXT_DAY_THRESHOLD_MIN) m += MINUTES_PER_DAY;
  return m;
}

/**
 * DayManagerModal `recalculate`. Resolved ("past") blocks stay as
 * they are; the unresolved ones cascade from `max(startMin, end of the last
 * past block in array order)`:
 *   - ACTIVE: start locked, end = start + duration;
 *   - pinned: start kept as an anchor, end = start + duration;
 *   - normal: starts at the cascade point (the FIRST unresolved block always
 *     does; later ones at max(cascade point, own start), so a gap before
 *     them survives) and keeps its intended end (own start + duration), but
 *     never ends less than 5 minutes after its new start. So a block pushed
 *     later SHRINKS, and a first block pulled earlier GROWS.
 * The next block cascades from each block's end. Unresolved blocks get
 * sortOrder past.length + index; the result is [...past, ...unresolved].
 *
 * Fixed: a start that is more than 12 h before the cascade point is read as
 * the next day (+ 1440), so blocks after midnight keep their length (Revise
 * compared 00:30 with 23:00 and collapsed the block to 5 minutes).
 */
export function recalculate(allSlots: readonly DayManagerSlot[], startMin: number): DayManagerSlot[] {
  const past = allSlots.filter((s) => isPastStatus(s.status));
  const future = allSlots.filter((s) => !isPastStatus(s.status));
  if (future.length === 0) return [...allSlots];

  const lastPast = past[past.length - 1];
  const lastPastEnd = lastPast ? parseTime(lastPast.endTime) : 0;
  let currentMin = Math.max(startMin, lastPastEnd);

  const recalculated = future.map((slot, idx): DayManagerSlot => {
    if (slot.status === 'ACTIVE') {
      const start = unwrapStart(parseTime(slot.startTime), currentMin);
      const end = start + slot.durationMin;
      currentMin = end;
      return { ...slot, endTime: formatTime(end), sortOrder: past.length + idx };
    }

    if (slot.isPinned) {
      const pStart = unwrapStart(parseTime(slot.startTime), currentMin);
      const pEnd = pStart + slot.durationMin;
      currentMin = pEnd;
      return { ...slot, endTime: formatTime(pEnd), sortOrder: past.length + idx };
    }

    const existingStart = unwrapStart(parseTime(slot.startTime), currentMin);
    const newStart = idx === 0 ? currentMin : Math.max(currentMin, existingStart);
    const intendedEnd = existingStart + slot.durationMin;
    const newEnd = Math.max(newStart + 5, intendedEnd);
    currentMin = newEnd;
    return {
      ...slot,
      startTime: formatTime(newStart),
      endTime: formatTime(newEnd),
      durationMin: newEnd - newStart,
      sortOrder: past.length + idx,
    };
  });

  return [...past, ...recalculated];
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * handleUpdate: merges `updates` into the slot; recalculates when duration,
 * pin, start time or status changed. Resolving a block (unresolved →
 * COMPLETED / SKIPPED / PARTIAL) moves "Resume at" to that block's end when
 * that is later than the current resume time.
 */
export function updateSlot(state: DayManagerState, id: string, updates: Partial<DayManagerSlot>): DayManagerState {
  const idx = state.slots.findIndex((s) => s.id === id);
  const current = state.slots[idx];
  if (idx === -1 || !current) return state;

  const merged: DayManagerSlot = { ...current, ...updates };
  const updated = [...state.slots];
  updated[idx] = merged;

  let effectiveStartMin = state.dayStartMin;
  if (!isPastStatus(current.status) && updates.status && isPastStatus(updates.status)) {
    const newPastEnd = parseTime(merged.endTime);
    if (newPastEnd > state.dayStartMin) effectiveStartMin = newPastEnd;
  }

  const needsRecalc =
    updates.durationMin !== undefined ||
    updates.isPinned !== undefined ||
    updates.startTime !== undefined ||
    updates.status !== undefined;

  return withState(state, needsRecalc ? recalculate(updated, effectiveStartMin) : updated, effectiveStartMin);
}

/** SortableItem start-time input (on blur): sets the start, keeps the end, PINS the block. */
export function editStartTime(state: DayManagerState, id: string, value: string): DayManagerState {
  const slot = state.slots.find((s) => s.id === id);
  if (!slot || !value || value === slot.startTime) return state;
  const newStartMin = parseTime(value);
  let endMin = parseTime(slot.endTime);
  if (endMin <= newStartMin) endMin += MINUTES_PER_DAY;
  return updateSlot(state, id, { startTime: value, durationMin: Math.max(5, endMin - newStartMin), isPinned: true });
}

/** SortableItem end-time input (on blur): only changes the duration (min 5). */
export function editEndTime(state: DayManagerState, id: string, value: string): DayManagerState {
  const slot = state.slots.find((s) => s.id === id);
  if (!slot || !value || value === slot.endTime) return state;
  const startMin = parseTime(slot.startTime);
  let endMin = parseTime(value);
  if (endMin <= startMin) endMin += MINUTES_PER_DAY;
  return updateSlot(state, id, { durationMin: Math.max(5, endMin - startMin) });
}

/** The lock button. */
export function togglePin(state: DayManagerState, id: string): DayManagerState {
  const slot = state.slots.find((s) => s.id === id);
  return slot ? updateSlot(state, id, { isPinned: !slot.isPinned }) : state;
}

/** The ± buttons: −15 (never below 5) or +15 minutes. */
export function stepDuration(state: DayManagerState, id: string, direction: 1 | -1): DayManagerState {
  const slot = state.slots.find((s) => s.id === id);
  if (!slot) return state;
  const durationMin = direction < 0 ? Math.max(5, slot.durationMin - 15) : slot.durationMin + 15;
  return updateSlot(state, id, { durationMin });
}

/** The duration number input: `Math.max(5, parseInt(value) || 5)`. */
export function setDuration(state: DayManagerState, id: string, value: string): DayManagerState {
  return updateSlot(state, id, { durationMin: Math.max(5, parseInt(value) || 5) });
}

/** handleDelete */
export function deleteSlot(state: DayManagerState, id: string): DayManagerState {
  return withState(state, recalculate(state.slots.filter((s) => s.id !== id), state.dayStartMin));
}

function endOfLastUnresolved(state: DayManagerState): number {
  const future = state.slots.filter((s) => !isPastStatus(s.status));
  const lastFuture = future[future.length - 1];
  return lastFuture ? parseTime(lastFuture.endTime) : state.dayStartMin;
}

/** handleAddBlock: a 60-minute block, or a 15-minute break (the "15m Break" button), after the last unresolved block. */
export function addBlock(state: DayManagerState, isBreak: boolean, newId: string): DayManagerState {
  const start = endOfLastUnresolved(state);
  const dur = isBreak ? 15 : 60;
  const newSlot: DayManagerSlot = {
    id: newId,
    title: isBreak ? 'Break' : 'New Block',
    color: isBreak ? DAY_MANAGER_COLORS.break : DAY_MANAGER_COLORS.block,
    startTime: formatTime(start),
    endTime: formatTime(start + dur),
    status: 'UPCOMING',
    sortOrder: state.slots.length,
    durationMin: dur,
    isPinned: false,
  };
  return withState(state, recalculate([...state.slots, newSlot], state.dayStartMin));
}

/**
 * handleCreateCustomBlock ("Add Custom Block" form): appended at the end; it
 * is pinned when its start differs from where it would have cascaded to.
 * Empty title → 'New Block'; empty start → '09:00'.
 */
export function createCustomBlock(
  state: DayManagerState,
  block: { title: string; startTime: string; durationMin: number },
  newId: string,
): DayManagerState {
  const defaultStartMin = endOfLastUnresolved(state);
  const chosenStartMin = parseTime(block.startTime || '09:00');
  const newSlot: DayManagerSlot = {
    id: newId,
    title: block.title || 'New Block',
    color: DAY_MANAGER_COLORS.block,
    startTime: formatTime(chosenStartMin),
    endTime: formatTime(chosenStartMin + block.durationMin),
    status: 'UPCOMING',
    sortOrder: state.slots.length,
    durationMin: block.durationMin,
    isPinned: chosenStartMin !== defaultStartMin,
  };
  return withState(state, recalculate([...state.slots, newSlot], state.dayStartMin));
}

/** handleFillGap ("+ Fill" on a gap row): a block exactly covering the gap, inserted at `insertIdx` among the unresolved blocks. */
export function fillGap(
  state: DayManagerState,
  insertIdx: number,
  startMin: number,
  endMin: number,
  newId: string,
): DayManagerState {
  const past = state.slots.filter((s) => isPastStatus(s.status));
  const future = state.slots.filter((s) => !isPastStatus(s.status));
  future.splice(insertIdx, 0, {
    id: newId,
    title: 'New Block',
    color: DAY_MANAGER_COLORS.block,
    startTime: formatTime(startMin),
    endTime: formatTime(endMin),
    status: 'UPCOMING',
    sortOrder: 0,
    durationMin: endMin - startMin,
    isPinned: false,
  });
  return withState(state, recalculate([...past, ...future], state.dayStartMin));
}

/** How far "Delay +30m" pushes the day. */
export const DELAY_STEP_MIN = 30;

/**
 * handlePushDelay, the footer's "+30 min" button.
 *   - With an ACTIVE block ("Insert 30m Break"): a 30-minute break goes right
 *     after it and everything after cascades (as Revise).
 *   - Otherwise ("Delay +30m"): "Resume at" moves 30 minutes later and every
 *     unresolved, unpinned block moves 30 minutes later with it, keeping its
 *     duration and the gaps between blocks; pinned blocks stay put and the
 *     cascade flows around them. (Changed: Revise only moved "Resume at", so
 *     the first block SHRANK by 30 minutes; that is `shrinkFirstBlockDelay`.)
 */
export function pushDelay(state: DayManagerState, newId: string): DayManagerState {
  const past = state.slots.filter((s) => isPastStatus(s.status));
  const future = state.slots.filter((s) => !isPastStatus(s.status));
  const activeIdx = future.findIndex((s) => s.status === 'ACTIVE');
  const active = future[activeIdx];
  if (activeIdx >= 0 && active) {
    const afterEnd = parseTime(active.endTime);
    const newFuture = [...future];
    newFuture.splice(activeIdx + 1, 0, {
      id: newId,
      title: 'Break',
      color: DAY_MANAGER_COLORS.break,
      startTime: formatTime(afterEnd),
      endTime: formatTime(afterEnd + 30),
      status: 'UPCOMING',
      sortOrder: 0,
      durationMin: 30,
      isPinned: false,
    });
    return withState(state, recalculate([...past, ...newFuture], state.dayStartMin));
  }
  const newStart = state.dayStartMin + DELAY_STEP_MIN;
  const pushed = state.slots.map((s): DayManagerSlot => {
    if (isPastStatus(s.status) || s.isPinned) return s;
    const start = parseTime(s.startTime) + DELAY_STEP_MIN;
    return { ...s, startTime: formatTime(start), endTime: formatTime(start + s.durationMin) };
  });
  return withState(state, recalculate(pushed, newStart), newStart);
}

/**
 * Revise's original "Delay +30m": only "Resume at" moves, so the first
 * unresolved block shrinks by 30 minutes (down to 5) and later blocks move
 * only once it hits that floor. Kept for reference and tests; the Day Manager
 * uses `pushDelay`.
 */
export function shrinkFirstBlockDelay(state: DayManagerState): DayManagerState {
  const newStart = state.dayStartMin + DELAY_STEP_MIN;
  return withState(state, recalculate(state.slots, newStart), newStart);
}

/** handleDayStartChange (the "Resume at" input); an empty value is ignored. */
export function setDayStart(state: DayManagerState, value: string): DayManagerState {
  if (!value) return state;
  const newStart = parseTime(value);
  return withState(state, recalculate(state.slots, newStart), newStart);
}

/** @dnd-kit/sortable arrayMove */
function arrayMove<T>(array: readonly T[], from: number, to: number): T[] {
  const copy = array.slice();
  const [moved] = copy.splice(from, 1);
  if (moved !== undefined) copy.splice(to, 0, moved);
  return copy;
}

/**
 * handleDragEnd: moves the dragged unresolved block to the drop target's
 * position, UNPINS it and starts it where the block before it ends (or at
 * "Resume at" when it lands first), then recalculates. Unknown ids or a drop
 * on itself change nothing.
 */
export function moveSlot(state: DayManagerState, activeId: string, overId: string): DayManagerState {
  if (activeId === overId) return state;
  const past = state.slots.filter((s) => isPastStatus(s.status));
  const future = state.slots.filter((s) => !isPastStatus(s.status));
  const oldIdx = future.findIndex((s) => s.id === activeId);
  const newIdx = future.findIndex((s) => s.id === overId);
  if (oldIdx < 0 || newIdx < 0) return state;

  const reordered = arrayMove(future, oldIdx, newIdx);
  const dragIdx = reordered.findIndex((s) => s.id === activeId);
  const dragged = reordered[dragIdx];
  if (dragged) {
    const prev = dragIdx > 0 ? reordered[dragIdx - 1] : undefined;
    const prevEnd = prev ? parseTime(prev.endTime) : state.dayStartMin;
    reordered[dragIdx] = {
      ...dragged,
      isPinned: false,
      startTime: formatTime(prevEnd),
      endTime: formatTime(prevEnd + dragged.durationMin),
    };
  }
  return withState(state, recalculate([...past, ...reordered], state.dayStartMin));
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived views
// ─────────────────────────────────────────────────────────────────────────────

export interface DayManagerRow {
  slot: DayManagerSlot;
  /** Index among the unresolved blocks (what `fillGap` takes). */
  index: number;
  /** A free gap of 5+ minutes before this block, shown as "Xh Ym free · + Fill". */
  gapBefore: { startMin: number; endMin: number; minutes: number } | null;
  /** This block starts before the previous unresolved block ends ("OVERLAP" badge). */
  overlapsPrevious: boolean;
}

/**
 * The editable list as rendered: for each unresolved block, the gap before it
 * (from the previous unresolved block's end; for the first one, from the end
 * of the last resolved block by sortOrder, or "Resume at" when none) and
 * whether it overlaps the previous one.
 */
export function dayManagerRows(state: DayManagerState): DayManagerRow[] {
  const pastSlots = state.slots.filter((s) => isPastStatus(s.status)).sort((a, b) => a.sortOrder - b.sortOrder);
  const futureSlots = state.slots.filter((s) => !isPastStatus(s.status));
  const lastPast = pastSlots[pastSlots.length - 1];
  return futureSlots.map((slot, i) => {
    const prev = i > 0 ? futureSlots[i - 1] : undefined;
    // Read times after midnight as the next day (see recalculate), so no false gap/overlap.
    const prevEndMin = prev
      ? unwrapStart(parseTime(prev.endTime), unwrapStart(parseTime(prev.startTime), state.dayStartMin))
      : lastPast
        ? parseTime(lastPast.endTime)
        : state.dayStartMin;
    const startMin = unwrapStart(parseTime(slot.startTime), prevEndMin);
    const gapMin = startMin - prevEndMin;
    return {
      slot,
      index: i,
      gapBefore: gapMin >= 5 ? { startMin: prevEndMin, endMin: startMin, minutes: gapMin } : null,
      overlapsPrevious: prev !== undefined && prevEndMin > startMin,
    };
  });
}

export interface DayManagerSummary {
  /** "N remaining": unresolved blocks other than the ACTIVE one. */
  remaining: number;
  /** Total minutes of the unresolved blocks. */
  futureDurationMin: number;
  hasActiveBlock: boolean;
  /** The footer button: none without unresolved blocks, else 'Insert 30m Break' or 'Delay +30m'. */
  delayAction: 'insert-break' | 'delay-30' | null;
}

export function dayManagerSummary(state: DayManagerState): DayManagerSummary {
  const future = state.slots.filter((s) => !isPastStatus(s.status));
  const hasActiveBlock = future.some((s) => s.status === 'ACTIVE');
  return {
    remaining: future.filter((s) => s.status !== 'ACTIVE').length,
    futureDurationMin: future.reduce((sum, s) => sum + s.durationMin, 0),
    hasActiveBlock,
    delayAction: future.length === 0 ? null : hasActiveBlock ? 'insert-break' : 'delay-30',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Save
// ─────────────────────────────────────────────────────────────────────────────

/** schedule-slot.actions.ts `DayManagerSlotUpdate`. */
export interface DayManagerSlotUpdate {
  /** An id starting with 'new-' is a slot to create. */
  id: string;
  title: string;
  color: string;
  startTime: string;
  endTime: string;
  status: SlotStatus;
  sortOrder: number;
  remark: string | null;
  /** Optional: minutes actually done (debrief / PARTIAL). Omitted = keep the stored value. */
  minutesDone?: number | null;
}

/**
 * handleSave: every slot in list order (sortOrder = position); an ACTIVE
 * block whose start is still in the future goes back to UPCOMING.
 */
export function toSaveUpdates(slots: readonly DayManagerSlot[], nowMinutes: number): DayManagerSlotUpdate[] {
  return slots.map((s, i) => ({
    id: s.id,
    title: s.title,
    color: s.color,
    startTime: s.startTime,
    endTime: s.endTime,
    sortOrder: i,
    status: s.status === 'ACTIVE' && parseTime(s.startTime) > nowMinutes ? 'UPCOMING' : s.status,
    remark: s.remark ?? null,
  }));
}

export interface ActualTimes {
  actualStartTime: string | null;
  actualEndTime: string | null;
}

/**
 * The actual start / end times a status change records (new: Revise never set
 * them, so ACTIVE / PARTIAL and the "actual" columns stayed empty). `nowHHmm`
 * is the user's local wall-clock time ('HH:mm').
 *   - unchanged status → the stored times;
 *   - → ACTIVE ("Start") → actualStartTime = now (kept if already set), no end;
 *   - → COMPLETED / PARTIAL / SKIPPED from an unresolved status →
 *     actualEndTime = now, but only for a block that was started (it has an
 *     actual start). A block marked done without "Start" keeps null times, so
 *     the debrief counts its planned span instead of "planned start → the
 *     moment you clicked" (which could be hours later at wrap-up);
 *   - between resolved statuses (e.g. COMPLETED → PARTIAL) → the stored times;
 *   - → UPCOMING (un-started) → both cleared.
 */
export function stampActualTimes(
  existing: { status: SlotStatus; actualStartTime: string | null; actualEndTime: string | null },
  update: { status: SlotStatus },
  nowHHmm: string,
): ActualTimes {
  parseTime(nowHHmm); // validates (INVALID_TIME)
  const kept: ActualTimes = { actualStartTime: existing.actualStartTime, actualEndTime: existing.actualEndTime };
  if (update.status === existing.status) return kept;
  switch (update.status) {
    case 'UPCOMING':
      return { actualStartTime: null, actualEndTime: null };
    case 'ACTIVE':
      return { actualStartTime: existing.actualStartTime ?? nowHHmm, actualEndTime: null };
    default:
      if (isPastStatus(existing.status)) return kept;
      return {
        actualStartTime: existing.actualStartTime,
        actualEndTime: existing.actualStartTime ? (existing.actualEndTime ?? nowHHmm) : null,
      };
  }
}

export interface DayScheduleSavePlan {
  /** Today's slots that are no longer in the list. */
  deleteIds: string[];
  /** 'new-…' entries. Created UPCOMING with no source block, whatever status they had (as Revise). */
  creates: NewScheduleSlot[];
  updates: DayManagerSlotUpdate[];
  /** Resolved slots with a source block: keep BlockSessionLog in sync. */
  logUpserts: Array<{ timeBlockId: string; date: DayString; status: BlockLogStatus; remark: string | null }>;
}

/**
 * updateDaySchedule as a plan. `existing` is the day's slots as stored; ids
 * in `updates` that are neither 'new-…' nor among them are dropped (foreign
 * or stale), and existing slots missing from `updates` are deleted. A
 * BlockSessionLog is upserted for each updated slot with a source block and a
 * resolved status. (Revise never removes a log when a slot is set back to
 * UPCOMING; neither does this.)
 */
export function planDayScheduleSave(
  existing: readonly ScheduleSlot[],
  updates: readonly DayManagerSlotUpdate[],
  day: DayString,
): DayScheduleSavePlan {
  const isNew = (u: DayManagerSlotUpdate): boolean => u.id.startsWith('new-');
  const existingById = new Map(existing.map((s) => [s.id, s]));
  const keptIds = new Set(updates.filter((u) => !isNew(u)).map((u) => u.id));

  const plan: DayScheduleSavePlan = {
    deleteIds: existing.filter((s) => !keptIds.has(s.id)).map((s) => s.id),
    creates: [],
    updates: [],
    logUpserts: [],
  };
  for (const u of updates) {
    if (isNew(u)) {
      plan.creates.push({
        sourceBlockId: null,
        date: day,
        title: u.title,
        color: u.color,
        startTime: u.startTime,
        endTime: u.endTime,
        status: 'UPCOMING',
        actualStartTime: null,
        actualEndTime: null,
        remark: u.remark,
        minutesDone: null,
        sortOrder: u.sortOrder,
      });
      continue;
    }
    const row = existingById.get(u.id);
    if (!row) continue;
    plan.updates.push(u);
    if (row.sourceBlockId && isResolvedStatus(u.status)) {
      plan.logUpserts.push({ timeBlockId: row.sourceBlockId, date: day, status: u.status, remark: u.remark });
    }
  }
  return plan;
}
