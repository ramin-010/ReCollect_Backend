import { describe, expect, it } from 'vitest';
import {
  addBlock,
  createCustomBlock,
  dayManagerRows,
  dayManagerSummary,
  deleteSlot,
  editEndTime,
  editStartTime,
  fillGap,
  initDayManager,
  minutesToTime,
  moveSlot,
  newSlotId,
  planDayScheduleSave,
  pushDelay,
  recalculate,
  setDayStart,
  setDuration,
  shrinkFirstBlockDelay,
  stampActualTimes,
  stepDuration,
  timeToMinutes,
  togglePin,
  toSaveUpdates,
  updateSlot,
  type DayManagerSlot,
  type DayManagerSlotUpdate,
  type DayManagerState,
} from '../../../src/services/learning';
import { deepFreeze, slot } from './_fixtures';

// All behaviour below is DayManagerModal.tsx's (revise/src/components/dashboard/).

/** A Day Manager slot from a start time and a duration. */
const dm = (id: string, startTime: string, durationMin: number, over: Partial<DayManagerSlot> = {}): DayManagerSlot => ({
  id,
  title: id,
  color: '#000000',
  startTime,
  endTime: minutesToTime(timeToMinutes(startTime) + durationMin),
  status: 'UPCOMING',
  sortOrder: 0,
  durationMin,
  isPinned: false,
  ...over,
});

/** 'id HH:mm-HH:mm (duration)' for compact assertions. */
const view = (slots: readonly DayManagerSlot[]) => slots.map((s) => `${s.id} ${s.startTime}-${s.endTime} (${s.durationMin})`);
const state = (slots: DayManagerSlot[], dayStartMin: number): DayManagerState => ({ slots, dayStartMin });

describe('recalculate', () => {
  const day = () => [dm('A', '09:00', 60), dm('B', '10:30', 30), dm('C', '11:00', 60)];

  it('no unresolved blocks: nothing changes', () => {
    const past = [dm('P', '08:00', 60, { status: 'COMPLETED' })];
    expect(recalculate(past, 600)).toEqual(past);
  });

  it('cascades from the resume time; gaps after the first block survive', () => {
    const out = recalculate(day(), 540);
    expect(view(out)).toEqual(['A 09:00-10:00 (60)', 'B 10:30-11:00 (30)', 'C 11:00-12:00 (60)']);
    expect(out.map((s) => s.sortOrder)).toEqual([0, 1, 2]);
  });

  it('a block pushed later keeps its intended end, so it shrinks', () => {
    expect(view(recalculate(day(), 570))).toEqual(['A 09:30-10:00 (30)', 'B 10:30-11:00 (30)', 'C 11:00-12:00 (60)']);
  });

  it('...down to a 5-minute floor, then pushes the next ones', () => {
    expect(view(recalculate(day(), 620))).toEqual(['A 10:20-10:25 (5)', 'B 10:30-11:00 (30)', 'C 11:00-12:00 (60)']);
    expect(view(recalculate(day(), 700))).toEqual(['A 11:40-11:45 (5)', 'B 11:45-11:50 (5)', 'C 11:50-12:00 (10)']);
  });

  it('the first block pulled earlier keeps its end, so it grows', () => {
    expect(view(recalculate(day(), 480))).toEqual(['A 08:00-10:00 (120)', 'B 10:30-11:00 (30)', 'C 11:00-12:00 (60)']);
  });

  it('a pinned block keeps its start (an overlap is allowed); the next ones cascade from its end', () => {
    const out = recalculate([dm('A', '09:00', 60), dm('P', '09:30', 30, { isPinned: true }), dm('C', '10:00', 60)], 540);
    expect(view(out)).toEqual(['A 09:00-10:00 (60)', 'P 09:30-10:00 (30)', 'C 10:00-11:00 (60)']);
    const late = recalculate([dm('A', '09:00', 60), dm('P', '13:00', 60, { isPinned: true }), dm('C', '10:00', 30)], 600);
    expect(view(late)).toEqual(['A 10:00-10:05 (5)', 'P 13:00-14:00 (60)', 'C 14:00-14:05 (5)']);
  });

  it('an ACTIVE block keeps its start; only its end follows its duration', () => {
    const out = recalculate([dm('A', '09:00', 90, { status: 'ACTIVE', endTime: '10:00' }), dm('B', '10:00', 60)], 600);
    expect(view(out)).toEqual(['A 09:00-10:30 (90)', 'B 10:30-11:00 (30)']);
  });

  it('resolved blocks stay as they are and the cascade starts after the last one (array order)', () => {
    const past = dm('P', '08:00', 75, { status: 'COMPLETED', sortOrder: 0 });
    const out = recalculate([past, dm('A', '09:00', 60)], 540);
    expect(view(out)).toEqual(['P 08:00-09:15 (75)', 'A 09:15-10:00 (45)']);
    expect(out.map((s) => s.sortOrder)).toEqual([0, 1]);
    // "last" means last in the array, not latest end (Revise quirk, kept)
    const odd = recalculate(
      [dm('late', '08:00', 90, { status: 'COMPLETED' }), dm('early', '07:00', 30, { status: 'SKIPPED' }), dm('A', '09:00', 60)],
      420,
    );
    expect(view(odd)[2]).toBe('A 07:30-10:00 (150)');
  });

  it('crosses midnight', () => {
    expect(view(recalculate([dm('A', '23:00', 45), dm('B', '23:45', 30)], 1380))).toEqual([
      'A 23:00-23:45 (45)',
      'B 23:45-00:15 (30)',
    ]);
    // Fixed: a block already after midnight is read as the next day and keeps its length
    // (Revise compared 00:15 with 23:45 and collapsed it to 5 minutes).
    const after = recalculate([dm('A', '23:00', 45), dm('B', '23:45', 30), dm('C', '00:15', 30)], 1380);
    expect(view(after)[2]).toBe('C 00:15-00:45 (30)');
  });

  it('a 00:30-01:30 block after a 22:00-23:00 block stays 60 minutes (and the gap survives)', () => {
    const out = recalculate([dm('A', '22:00', 60), dm('B', '00:30', 60)], 1320);
    expect(view(out)).toEqual(['A 22:00-23:00 (60)', 'B 00:30-01:30 (60)']);
  });

  it('pinned and ACTIVE blocks after midnight are next-day anchors too', () => {
    const pinned = recalculate([dm('A', '23:00', 60), dm('P', '00:30', 30, { isPinned: true }), dm('C', '02:00', 30)], 1380);
    expect(view(pinned)).toEqual(['A 23:00-00:00 (60)', 'P 00:30-01:00 (30)', 'C 02:00-02:30 (30)']);
    const past = dm('X', '22:00', 120, { status: 'COMPLETED' });
    const active = recalculate([past, dm('A', '00:10', 50, { status: 'ACTIVE' }), dm('B', '01:00', 30)], 1440);
    expect(view(active).slice(1)).toEqual(['A 00:10-01:00 (50)', 'B 01:00-01:30 (30)']);
  });

  it('a morning block within 12 h of the cascade point is still the same day', () => {
    expect(view(recalculate([dm('A', '09:00', 60), dm('B', '08:30', 30)], 540))).toEqual(['A 09:00-10:00 (60)', 'B 10:00-10:05 (5)']);
  });

  it('never mutates its input', () => {
    const input = deepFreeze(day());
    expect(() => recalculate(input, 600)).not.toThrow();
  });
});

describe('initDayManager (the open effect)', () => {
  it('durations (a zero span = 24 h), unpinned, sorted by sortOrder; resume at the first unresolved block', () => {
    const st = initDayManager(
      [
        { id: 'b', title: 'b', color: '#1', startTime: '10:00', endTime: '11:00', status: 'UPCOMING', sortOrder: 1 },
        { id: 'a', title: 'a', color: '#1', startTime: '09:00', endTime: '10:00', status: 'COMPLETED', sortOrder: 0 },
        { id: 'c', title: 'c', color: '#1', startTime: '23:30', endTime: '00:30', status: 'UPCOMING', sortOrder: 2 },
        { id: 'z', title: 'z', color: '#1', startTime: '08:00', endTime: '08:00', status: 'UPCOMING', sortOrder: 3 },
      ],
      615,
    );
    expect(st.slots.map((s) => [s.id, s.durationMin, s.isPinned])).toEqual([
      ['a', 60, false],
      ['b', 60, false],
      ['c', 60, false],
      ['z', 1440, false],
    ]);
    expect(st.dayStartMin).toBe(600);
  });

  it('all resolved → resume at the end of the last one; nothing → the start of the current hour', () => {
    const all = initDayManager(
      [
        { id: 'a', title: 'a', color: '#1', startTime: '09:00', endTime: '10:00', status: 'COMPLETED', sortOrder: 0 },
        { id: 'b', title: 'b', color: '#1', startTime: '10:00', endTime: '10:45', status: 'SKIPPED', sortOrder: 1 },
      ],
      615,
    );
    expect(all.dayStartMin).toBe(645);
    expect(initDayManager([], 615).dayStartMin).toBe(600);
  });
});

describe('handlers', () => {
  const base = () => state([dm('a', '09:00', 60), dm('b', '10:00', 60)], 540);

  it('resolving a block moves "Resume at" to its end (only forward)', () => {
    const done = updateSlot(base(), 'a', { status: 'COMPLETED' });
    expect(done.dayStartMin).toBe(600);
    expect(view(done.slots)).toEqual(['a 09:00-10:00 (60)', 'b 10:00-11:00 (60)']);
    const later = updateSlot(state(base().slots, 660), 'a', { status: 'SKIPPED' });
    expect(later.dayStartMin).toBe(660);
  });

  it('a title, colour or remark change does not recalculate', () => {
    const st = base();
    const next = updateSlot(st, 'a', { title: 'Reading' });
    expect(next.slots[0]?.title).toBe('Reading');
    expect(next.slots[1]).toBe(st.slots[1]);
    expect(updateSlot(st, 'missing', { title: 'x' })).toBe(st);
  });

  it('editing the start time pins the block and keeps its end', () => {
    const next = editStartTime(base(), 'a', '09:20');
    expect(next.slots[0]).toMatchObject({ startTime: '09:20', endTime: '10:00', durationMin: 40, isPinned: true });
    expect(view(next.slots)[1]).toBe('b 10:00-11:00 (60)');
    expect(editStartTime(base(), 'a', '')).toEqual(base());
    const night = editStartTime(state([dm('n', '23:00', 90)], 1380), 'n', '23:30');
    expect(night.slots[0]).toMatchObject({ startTime: '23:30', endTime: '00:30', durationMin: 60, isPinned: true });
  });

  it('editing the end time only changes the duration (the next block then shrinks to keep its end)', () => {
    expect(view(editEndTime(base(), 'a', '10:30').slots)).toEqual(['a 09:00-10:30 (90)', 'b 10:30-11:00 (30)']);
  });

  it('pin toggle, ± 15 minutes (floor 5), and the typed duration', () => {
    expect(togglePin(base(), 'a').slots[0]?.isPinned).toBe(true);
    expect(view(stepDuration(base(), 'a', -1).slots)).toEqual(['a 09:00-09:45 (45)', 'b 10:00-11:00 (60)']);
    expect(view(stepDuration(base(), 'a', 1).slots)).toEqual(['a 09:00-10:15 (75)', 'b 10:15-11:00 (45)']);
    expect(stepDuration(state([dm('t', '09:00', 10)], 540), 't', -1).slots[0]?.durationMin).toBe(5);
    expect(setDuration(base(), 'a', 'abc').slots[0]?.durationMin).toBe(5);
    expect(setDuration(base(), 'a', '0').slots[0]?.durationMin).toBe(5);
    expect(setDuration(base(), 'a', '45').slots[0]?.durationMin).toBe(45);
  });

  it('deleting the first block lets the next one grow back to "Resume at"', () => {
    expect(view(deleteSlot(base(), 'a').slots)).toEqual(['b 09:00-11:00 (120)']);
  });

  it('"15m Break" / new block go after the last unresolved block', () => {
    const brk = addBlock(base(), true, 'new-1');
    expect(brk.slots[2]).toMatchObject({ id: 'new-1', title: 'Break', color: '#6b7280', startTime: '11:00', endTime: '11:15', durationMin: 15, sortOrder: 2 });
    expect(addBlock(base(), false, 'new-2').slots[2]).toMatchObject({ title: 'New Block', color: '#8b5cf6', startTime: '11:00', endTime: '12:00' });
    expect(addBlock(state([], 600), true, 'new-3').slots[0]).toMatchObject({ startTime: '10:00', endTime: '10:15' });
  });

  it('a custom block is pinned only when its start differs from where it would cascade to', () => {
    const pinned = createCustomBlock(base(), { title: '', startTime: '', durationMin: 45 }, 'new-1');
    expect(pinned.slots[2]).toMatchObject({ title: 'New Block', startTime: '09:00', endTime: '09:45', isPinned: true });
    const appended = createCustomBlock(base(), { title: 'Read', startTime: '11:00', durationMin: 30 }, 'new-2');
    expect(appended.slots[2]).toMatchObject({ title: 'Read', startTime: '11:00', endTime: '11:30', isPinned: false });
  });

  it('"+ Fill" covers a gap exactly', () => {
    const gappy = state([dm('a', '09:00', 60), dm('b', '10:30', 30)], 540);
    expect(dayManagerRows(gappy)[1]?.gapBefore).toEqual({ startMin: 600, endMin: 630, minutes: 30 });
    const filled = fillGap(gappy, 1, 600, 630, 'new-1');
    expect(view(filled.slots)).toEqual(['a 09:00-10:00 (60)', 'new-1 10:00-10:30 (30)', 'b 10:30-11:00 (30)']);
    expect(dayManagerRows(filled).every((r) => r.gapBefore === null)).toBe(true);
  });

  it('"Delay +30m" pushes the rest of the day back by 30 minutes, keeping durations', () => {
    const once = pushDelay(base(), 'new-x');
    expect(once.dayStartMin).toBe(570);
    expect(view(once.slots)).toEqual(['a 09:30-10:30 (60)', 'b 10:30-11:30 (60)']);
    const twice = pushDelay(once, 'new-y');
    expect(twice.dayStartMin).toBe(600);
    expect(view(twice.slots)).toEqual(['a 10:00-11:00 (60)', 'b 11:00-12:00 (60)']);
  });

  it('"Delay +30m" keeps gaps, leaves resolved and pinned blocks where they are', () => {
    const st = state(
      [
        dm('done', '08:00', 60, { status: 'COMPLETED' }),
        dm('a', '09:00', 60),
        dm('b', '10:30', 30),
        dm('p', '14:00', 60, { isPinned: true }),
        dm('c', '15:00', 30),
      ],
      540,
    );
    const out = pushDelay(st, 'new-x');
    expect(view(out.slots)).toEqual([
      'done 08:00-09:00 (60)',
      'a 09:30-10:30 (60)',
      'b 11:00-11:30 (30)',
      'p 14:00-15:00 (60)',
      'c 15:30-16:00 (30)',
    ]);
  });

  it("shrinkFirstBlockDelay keeps Revise's old \"Delay +30m\" (the first block shrinks)", () => {
    const once = shrinkFirstBlockDelay(base());
    expect(once.dayStartMin).toBe(570);
    expect(view(once.slots)).toEqual(['a 09:30-10:00 (30)', 'b 10:00-11:00 (60)']);
    const twice = shrinkFirstBlockDelay(once);
    expect(twice.dayStartMin).toBe(600);
    expect(view(twice.slots)).toEqual(['a 10:00-10:05 (5)', 'b 10:05-11:00 (55)']);
  });

  it('"Insert 30m Break" with an ACTIVE block puts a break right after it', () => {
    const active = state([dm('a', '09:00', 60, { status: 'ACTIVE' }), dm('b', '10:00', 60)], 540);
    expect(dayManagerSummary(active).delayAction).toBe('insert-break');
    const out = pushDelay(active, 'new-break-1');
    expect(out.dayStartMin).toBe(540);
    expect(view(out.slots)).toEqual(['a 09:00-10:00 (60)', 'new-break-1 10:00-10:30 (30)', 'b 10:30-11:00 (30)']);
    expect(out.slots[1]).toMatchObject({ title: 'Break', color: '#6b7280' });
  });

  it('"Resume at" input', () => {
    const st = base();
    expect(setDayStart(st, '')).toBe(st);
    const earlier = setDayStart(st, '08:30');
    expect(earlier.dayStartMin).toBe(510);
    expect(view(earlier.slots)).toEqual(['a 08:30-10:00 (90)', 'b 10:00-11:00 (60)']);
  });

  it('dragging re-anchors the block after its new predecessor and unpins it', () => {
    const st = state([dm('a', '09:00', 60), dm('b', '10:00', 30, { isPinned: true }), dm('c', '10:30', 60)], 540);
    const bFirst = moveSlot(st, 'b', 'a');
    expect(view(bFirst.slots)).toEqual(['b 09:00-09:30 (30)', 'a 09:30-10:00 (30)', 'c 10:30-11:30 (60)']);
    expect(bFirst.slots[0]?.isPinned).toBe(false);
    const aLast = moveSlot(st, 'a', 'c');
    expect(view(aLast.slots)).toEqual(['b 10:00-10:30 (30)', 'c 10:30-11:30 (60)', 'a 11:30-12:30 (60)']);
    expect(moveSlot(st, 'a', 'a')).toBe(st);
    expect(moveSlot(st, 'a', 'ghost')).toBe(st);
  });

  it('new slot ids follow Revise (new-<ms>, new-break-<ms>)', () => {
    expect(newSlotId('new', 123)).toBe('new-123');
    expect(newSlotId('new-break', 123)).toBe('new-break-123');
  });
});

describe('derived views', () => {
  it('gap rows (5+ min), measured from the last resolved block or Resume at; overlap badges', () => {
    const st = state(
      [
        dm('p', '08:00', 45, { status: 'COMPLETED', sortOrder: 0 }),
        dm('a', '09:00', 60),
        dm('b', '10:30', 30),
        dm('c', '11:02', 28),
        dm('d', '11:20', 40),
      ],
      510,
    );
    const rows = dayManagerRows(st);
    expect(rows.map((r) => [r.slot.id, r.index, r.gapBefore?.minutes ?? null, r.overlapsPrevious])).toEqual([
      ['a', 0, 15, false], // after p (ends 08:45)
      ['b', 1, 30, false],
      ['c', 2, null, false], // 2 minutes is not a gap
      ['d', 3, null, true], // starts before c ends
    ]);
    const noPast = dayManagerRows(state([dm('a', '09:00', 60)], 510));
    expect(noPast[0]?.gapBefore).toEqual({ startMin: 510, endMin: 540, minutes: 30 });
  });

  it('summary: remaining (not counting ACTIVE), total minutes, footer action', () => {
    const st = state([dm('p', '08:00', 30, { status: 'SKIPPED' }), dm('a', '09:00', 60, { status: 'ACTIVE' }), dm('b', '10:00', 45)], 540);
    expect(dayManagerSummary(st)).toEqual({ remaining: 1, futureDurationMin: 105, hasActiveBlock: true, delayAction: 'insert-break' });
    expect(dayManagerSummary(state([dm('p', '08:00', 30, { status: 'COMPLETED' })], 540)).delayAction).toBeNull();
    expect(dayManagerSummary(state([dm('b', '10:00', 45)], 540)).delayAction).toBe('delay-30');
  });
});

describe('save', () => {
  it('toSaveUpdates: list order becomes sortOrder; a future ACTIVE block goes back to UPCOMING', () => {
    const slots = [dm('a', '09:00', 60, { status: 'COMPLETED', remark: 'ok' }), dm('b', '10:00', 60, { status: 'ACTIVE' })];
    expect(toSaveUpdatesSnapshot(slots, 590)).toEqual([
      ['a', 0, 'COMPLETED', 'ok'],
      ['b', 1, 'UPCOMING', null],
    ]);
    expect(toSaveUpdatesSnapshot(slots, 610)[1]).toEqual(['b', 1, 'ACTIVE', null]);
  });

  it('planDayScheduleSave (updateDaySchedule): delete missing, create new-*, update owned, sync logs', () => {
    const day = '2026-10-21';
    const existing = [
      slot({ id: 'x1', date: day, sourceBlockId: 'gym' }),
      slot({ id: 'x2', date: day, sourceBlockId: null }),
      slot({ id: 'x3', date: day, sourceBlockId: 'deep' }),
    ];
    const u = (id: string, status: DayManagerSlotUpdate['status'], sortOrder: number, remark: string | null = null): DayManagerSlotUpdate => ({
      id, title: id, color: '#1', startTime: '09:00', endTime: '10:00', status, sortOrder, remark,
    });
    const plan = planDayScheduleSave(existing, [u('x1', 'COMPLETED', 0, 'ok'), u('new-1', 'COMPLETED', 1), u('x3', 'UPCOMING', 2), u('zz', 'SKIPPED', 3)], day);
    expect(plan.deleteIds).toEqual(['x2']);
    expect(plan.creates).toEqual([
      expect.objectContaining({ sourceBlockId: null, date: day, title: 'new-1', status: 'UPCOMING', sortOrder: 1 }),
    ]);
    expect(plan.updates.map((x) => x.id)).toEqual(['x1', 'x3']);
    expect(plan.logUpserts).toEqual([{ timeBlockId: 'gym', date: day, status: 'COMPLETED', remark: 'ok' }]);
  });
});

function toSaveUpdatesSnapshot(slots: DayManagerSlot[], nowMinutes: number) {
  return toSaveUpdates(slots, nowMinutes).map((x) => [x.id, x.sortOrder, x.status, x.remark]);
}

describe('dayManagerRows after midnight', () => {
  it('no false overlap or gap for blocks that continue past midnight', () => {
    const st = state([dm('A', '23:00', 60), dm('B', '00:00', 30), dm('C', '00:45', 15)], 1380);
    const rows = dayManagerRows(st);
    expect(rows.map((r) => r.overlapsPrevious)).toEqual([false, false, false]);
    expect(rows.map((r) => r.gapBefore)).toEqual([null, null, { startMin: 1470, endMin: 1485, minutes: 15 }]);
  });
});

describe('stampActualTimes (actual start / end, new)', () => {
  const slotAt = (status: DayManagerSlot['status'], actualStartTime: string | null = null, actualEndTime: string | null = null) => ({
    status,
    actualStartTime,
    actualEndTime,
  });

  it('Start (to ACTIVE) records the start; an existing start is kept', () => {
    expect(stampActualTimes(slotAt('UPCOMING'), { status: 'ACTIVE' }, '09:05')).toEqual({ actualStartTime: '09:05', actualEndTime: null });
    expect(stampActualTimes(slotAt('UPCOMING', '08:55'), { status: 'ACTIVE' }, '09:05')).toEqual({ actualStartTime: '08:55', actualEndTime: null });
  });

  it('Done / Partial / Skip after Start records the end', () => {
    for (const status of ['COMPLETED', 'PARTIAL', 'SKIPPED'] as const) {
      expect(stampActualTimes(slotAt('ACTIVE', '09:05'), { status }, '10:20')).toEqual({ actualStartTime: '09:05', actualEndTime: '10:20' });
    }
  });

  it('Done without Start leaves both null (the debrief then counts the planned span)', () => {
    expect(stampActualTimes(slotAt('UPCOMING'), { status: 'COMPLETED' }, '22:00')).toEqual({ actualStartTime: null, actualEndTime: null });
  });

  it('an unchanged status, or a change between resolved statuses, keeps the stored times', () => {
    expect(stampActualTimes(slotAt('ACTIVE', '09:00'), { status: 'ACTIVE' }, '11:00')).toEqual({ actualStartTime: '09:00', actualEndTime: null });
    expect(stampActualTimes(slotAt('COMPLETED', '09:00', '10:00'), { status: 'PARTIAL' }, '11:00')).toEqual({
      actualStartTime: '09:00',
      actualEndTime: '10:00',
    });
  });

  it('back to UPCOMING clears both; a bad clock is INVALID_TIME', () => {
    expect(stampActualTimes(slotAt('ACTIVE', '09:00'), { status: 'UPCOMING' }, '09:10')).toEqual({ actualStartTime: null, actualEndTime: null });
    expect(() => stampActualTimes(slotAt('UPCOMING'), { status: 'ACTIVE' }, '9am')).toThrow(expect.objectContaining({ code: 'INVALID_TIME' }));
  });
});
