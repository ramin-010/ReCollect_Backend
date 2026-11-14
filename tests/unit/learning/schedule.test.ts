import { describe, expect, it } from 'vitest';
import {
  applyCatchUp,
  BACKFILL_MAX_DAYS,
  backfillMissedDays,
  backfillRange,
  blockAppliesOn,
  blocksForDay,
  canSaveCatchUp,
  catchUpPrefill,
  computeAdherence,
  findTriageSlots,
  generateDaySlots,
  planDaySlots,
  planTriage,
  type BlockSessionLog,
  type CatchUpContext,
  type DayDebrief,
  type ScheduleSlot,
  type SlotStatus,
} from '../../../src/services/learning';
import { block, IST, NY, slot } from './_fixtures';

// 2026-10-19 is a Monday, 2026-10-21 a Wednesday.
const gym = block({ id: 'gym', title: 'Gym', startTime: '07:00', endTime: '08:00' });
const deep = block({ id: 'deep', title: 'Deep Work', startTime: '09:00', endTime: '11:00' });
const monOnly = block({ id: 'mon', title: 'Mon class', startTime: '18:00', endTime: '19:00', dayOfWeek: 0 });
const wedOnly = block({ id: 'wed', title: 'Wed class', startTime: '18:00', endTime: '19:00', dayOfWeek: 2 });
const wedEarly = block({ id: 'wedEarly', title: 'Wed run', startTime: '06:00', endTime: '06:30', dayOfWeek: 2 });
const dentist = block({ id: 'dentist', title: 'Dentist', startTime: '12:00', endTime: '13:00', date: '2026-10-21' });
const blocks = [deep, dentist, gym, monOnly, wedOnly, wedEarly];

const ids = (xs: ReadonlyArray<{ id: string }>) => xs.map((x) => x.id);
const sources = (xs: ReadonlyArray<{ sourceBlockId: string | null }>) => xs.map((x) => x.sourceBlockId);

describe('which blocks apply (ensureTodaySlots / backfillMissedDays / bulkPreSkip)', () => {
  it('MASTER: recurring blocks with dayOfWeek null, ordered by start time', () => {
    expect(ids(blocksForDay(blocks, '2026-10-22', 'MASTER'))).toEqual(['gym', 'deep']);
  });

  it('DAILY: the blocks of that weekday (0 = Monday)', () => {
    expect(ids(blocksForDay(blocks, '2026-10-19', 'DAILY'))).toEqual(['mon']);
    expect(ids(blocksForDay(blocks, '2026-10-22', 'DAILY'))).toEqual([]);
  });

  it('FIX: a one-off block applies only on its date, in both modes', () => {
    expect(ids(blocksForDay(blocks, '2026-10-21', 'MASTER'))).toEqual(['gym', 'deep', 'dentist']);
    // Revise's MASTER query (dayOfWeek: null) also returned the one-off on every other day:
    expect(blocks.filter((b) => b.dayOfWeek === null).map((b) => b.id)).toContain('dentist');
    expect(blockAppliesOn(dentist, '2026-10-22', 'MASTER')).toBe(false);
    // ...and DAILY mode never showed it; now it does, on its date:
    expect(ids(blocksForDay(blocks, '2026-10-21', 'DAILY'))).toEqual(['wedEarly', 'dentist', 'wed']);
  });

  it('equal start times keep their input order', () => {
    const a = block({ id: 'a', startTime: '09:00' });
    const b = block({ id: 'b', startTime: '09:00' });
    expect(ids(blocksForDay([b, a], '2026-10-21', 'MASTER'))).toEqual(['b', 'a']);
  });
});

describe('generateDaySlots', () => {
  it('copies the block, status UPCOMING, sortOrder by start time', () => {
    expect(generateDaySlots(blocks, '2026-10-21', 'MASTER')).toEqual([
      {
        sourceBlockId: 'gym', date: '2026-10-21', title: 'Gym', color: '#3b82f6', startTime: '07:00', endTime: '08:00',
        status: 'UPCOMING', actualStartTime: null, actualEndTime: null, remark: null, minutesDone: null, sortOrder: 0,
      },
      expect.objectContaining({ sourceBlockId: 'deep', sortOrder: 1 }),
      expect.objectContaining({ sourceBlockId: 'dentist', startTime: '12:00', sortOrder: 2 }),
    ]);
  });

  it('a BlockSessionLog written ahead of time (vacation pre-skip) sets status, remark and minutes', () => {
    const logs: BlockSessionLog[] = [
      { timeBlockId: 'deep', date: '2026-10-22', status: 'SKIPPED', remark: 'vacation', minutesDone: null },
      { timeBlockId: 'gym', date: '2026-10-22', status: 'PARTIAL', remark: null, minutesDone: 45 },
      { timeBlockId: 'gym', date: '2026-10-23', status: 'COMPLETED', remark: 'other day', minutesDone: null },
    ];
    const slots = generateDaySlots(blocks, '2026-10-22', 'MASTER', logs);
    expect(slots.map((s) => [s.sourceBlockId, s.status, s.remark, s.minutesDone])).toEqual([
      ['gym', 'PARTIAL', null, 45],
      ['deep', 'SKIPPED', 'vacation', null],
    ]);
  });

  it('planDaySlots leaves a day that already has slots alone', () => {
    const existing = [slot({ id: 'x', date: '2026-10-21' })];
    expect(planDaySlots(existing, blocks, '2026-10-21', 'MASTER')).toEqual([]);
    expect(sources(planDaySlots([slot({ id: 'y', date: '2026-10-20' })], blocks, '2026-10-21', 'MASTER'))).toEqual([
      'gym',
      'deep',
      'dentist',
    ]);
  });
});

describe('backfillMissedDays (schedule-slot.actions.ts)', () => {
  const routine = [gym, deep];

  it('fills from the day after the last slot day up to yesterday (never today)', () => {
    const res = backfillMissedDays({ lastSlotDay: '2026-10-15', blocks: routine, logs: [], mode: 'MASTER', today: '2026-10-21', tz: IST });
    expect(res.backfilledDays).toBe(5);
    expect(res.startDate).toBe('2026-10-16');
    expect(res.endDate).toBe('2026-10-20');
    expect(res.slots).toHaveLength(10);
    expect(res.slots.some((s) => s.date === '2026-10-21')).toBe(false);
  });

  it('caps the backfill at the last 30 days', () => {
    expect(BACKFILL_MAX_DAYS).toBe(30);
    const res = backfillMissedDays({ lastSlotDay: '2026-08-01', blocks: routine, logs: [], mode: 'MASTER', today: '2026-10-21', tz: IST });
    expect(res.backfilledDays).toBe(30);
    expect(res.startDate).toBe('2026-09-21');
    expect(res.endDate).toBe('2026-10-20');
    expect(res.slots).toHaveLength(60);
    expect(backfillRange('2026-08-01', null, '2026-10-21')).toEqual({ from: '2026-09-21', to: '2026-10-20' });
    expect(backfillRange('2026-09-20', null, '2026-10-21')).toEqual({ from: '2026-09-21', to: '2026-10-20' });
    expect(backfillRange('2026-09-21', null, '2026-10-21')).toEqual({ from: '2026-09-22', to: '2026-10-20' });
  });

  it('with no slots yet, starts the day after the earliest block was created (in the user zone)', () => {
    const created = (iso: string) => routine.map((b) => ({ ...b, createdAt: new Date(iso) }));
    // 2026-10-18T02:00Z is 07:30 on the 18th in IST but 22:00 on the 17th in New York.
    const istRes = backfillMissedDays({ lastSlotDay: null, blocks: created('2026-10-18T02:00:00Z'), logs: [], mode: 'MASTER', today: '2026-10-21', tz: IST });
    expect([istRes.startDate, istRes.endDate, istRes.backfilledDays]).toEqual(['2026-10-19', '2026-10-20', 2]);
    const nyRes = backfillMissedDays({ lastSlotDay: null, blocks: created('2026-10-18T02:00:00Z'), logs: [], mode: 'MASTER', today: '2026-10-21', tz: NY });
    expect([nyRes.startDate, nyRes.endDate, nyRes.backfilledDays]).toEqual(['2026-10-18', '2026-10-20', 3]);
  });

  it('DAILY mode skips days without blocks, and does not count them', () => {
    const res = backfillMissedDays({ lastSlotDay: '2026-10-16', blocks: [monOnly, wedOnly], logs: [], mode: 'DAILY', today: '2026-10-21', tz: IST });
    expect(res).toMatchObject({ backfilledDays: 1, startDate: '2026-10-19', endDate: '2026-10-19' });
    expect(sources(res.slots)).toEqual(['mon']);
  });

  it('a one-off block in the window lands on its day only', () => {
    const trip = block({ id: 'trip', startTime: '15:00', endTime: '16:00', date: '2026-10-18' });
    const res = backfillMissedDays({ lastSlotDay: '2026-10-15', blocks: [...routine, trip], logs: [], mode: 'MASTER', today: '2026-10-21', tz: IST });
    expect(res.slots.filter((s) => s.sourceBlockId === 'trip').map((s) => s.date)).toEqual(['2026-10-18']);
  });

  it('pre-skipped days come in as SKIPPED', () => {
    const logs: BlockSessionLog[] = [{ timeBlockId: 'gym', date: '2026-10-17', status: 'SKIPPED', remark: 'vacation', minutesDone: null }];
    const res = backfillMissedDays({ lastSlotDay: '2026-10-15', blocks: routine, logs, mode: 'MASTER', today: '2026-10-21', tz: IST });
    expect(res.slots.filter((s) => s.status === 'SKIPPED').map((s) => [s.date, s.sourceBlockId])).toEqual([['2026-10-17', 'gym']]);
  });

  it('notBefore (loop v2): days before the last rollover are never filled, e.g. while the routine was off', () => {
    // Last slots on 09-10, routine off since; the rollover ran daily, last on 10-20.
    expect(backfillRange('2026-09-10', null, '2026-10-21', '2026-10-20')).toEqual({ from: '2026-10-20', to: '2026-10-20' });
    expect(backfillRange('2026-09-10', null, '2026-10-21', '2026-10-21')).toBeNull();
    // A bound older than the last slot day changes nothing.
    expect(backfillRange('2026-10-15', null, '2026-10-21', '2026-10-01')).toEqual({ from: '2026-10-16', to: '2026-10-20' });
    const res = backfillMissedDays({ lastSlotDay: '2026-09-10', blocks: routine, logs: [], mode: 'MASTER', today: '2026-10-21', tz: IST, notBefore: '2026-10-19' });
    expect([res.startDate, res.endDate, res.backfilledDays]).toEqual(['2026-10-19', '2026-10-20', 2]);
  });

  it('nothing to do: up to date, no blocks, or no history at all', () => {
    const none = { slots: [], backfilledDays: 0, startDate: null, endDate: null };
    expect(backfillMissedDays({ lastSlotDay: '2026-10-20', blocks: routine, logs: [], mode: 'MASTER', today: '2026-10-21', tz: IST })).toEqual(none);
    expect(backfillMissedDays({ lastSlotDay: '2026-10-21', blocks: routine, logs: [], mode: 'MASTER', today: '2026-10-21', tz: IST })).toEqual(none);
    expect(backfillMissedDays({ lastSlotDay: '2026-10-01', blocks: [], logs: [], mode: 'MASTER', today: '2026-10-21', tz: IST })).toEqual(none);
    expect(backfillRange(null, null, '2026-10-21')).toBeNull();
  });
});

describe('triage (planner.actions.ts getUnverifiedBlocks + TriageInterceptor)', () => {
  const TODAY = '2026-10-21';
  const slots: ScheduleSlot[] = [
    slot({ id: 's1', date: '2026-10-19', sourceBlockId: 'deep', sortOrder: 1 }),
    slot({ id: 's2', date: '2026-10-19', sourceBlockId: 'gym', sortOrder: 0, status: 'COMPLETED' }),
    slot({ id: 's3', date: '2026-10-19', sourceBlockId: null, sortOrder: 2 }),
    slot({ id: 's4', date: '2026-10-20', sourceBlockId: 'deep', sortOrder: 1 }),
    slot({ id: 's5', date: '2026-10-20', sourceBlockId: 'gym', sortOrder: 0 }),
    slot({ id: 's6', date: TODAY, sourceBlockId: 'gym' }),
    slot({ id: 's7', date: '2026-09-20', sourceBlockId: 'gym' }),
    slot({ id: 's8', date: '2026-09-21', sourceBlockId: 'gym' }),
  ];
  const logs: BlockSessionLog[] = [
    { timeBlockId: 'gym', date: '2026-10-19', status: 'COMPLETED', remark: null, minutesDone: null },
    { timeBlockId: 'deep', date: '2026-10-20', status: 'COMPLETED', remark: 'done late', minutesDone: 90 },
  ];

  it('past UPCOMING slots of the last 30 days, oldest first, then sortOrder; today is excluded', () => {
    expect(ids(findTriageSlots(slots, logs, TODAY).unverified)).toEqual(['s8', 's1', 's3', 's5']);
  });

  it('auto-heals a slot whose block already has a log for that day', () => {
    expect(findTriageSlots(slots, logs, TODAY).heal).toEqual([{ slotId: 's4', status: 'COMPLETED', remark: 'done late' }]);
  });

  it("a log from the neighbouring day does not heal (Revise's ±24 h match did)", () => {
    // gym was logged on the 19th; the 20th's gym slot stays unverified.
    expect(ids(findTriageSlots(slots, logs, TODAY).unverified)).toContain('s5');
  });

  it('planTriage: nothing, one day → debrief, several days → catch-up', () => {
    expect(planTriage([])).toEqual({ kind: 'none' });
    const oneDay = slots.filter((s) => s.id === 's5');
    expect(planTriage(oneDay)).toEqual({ kind: 'debrief', date: '2026-10-20', slots: oneDay });
    const plan = planTriage(findTriageSlots(slots, logs, TODAY).unverified);
    expect(plan.kind).toBe('catch-up');
    if (plan.kind === 'catch-up') {
      expect(plan.days.map((d) => [d.date, ids(d.slots)])).toEqual([
        ['2026-09-21', ['s8']],
        ['2026-10-19', ['s1', 's3']],
        ['2026-10-20', ['s5']],
      ]);
    }
  });
});

describe('applyCatchUp (MultiDayCatchUpModal + saveMultiDayCatchUp)', () => {
  const context: CatchUpContext = { energy: 2, focus: 3, mood: 2, tags: ['Sick'], narrative: '  Fever all weekend  ' };
  const slots: ScheduleSlot[] = [
    slot({ id: 'a', date: '2026-10-19', sourceBlockId: 'deep', sortOrder: 0 }),
    slot({ id: 'b', date: '2026-10-19', sourceBlockId: 'gym', sortOrder: 1, status: 'COMPLETED' }),
    slot({ id: 'c', date: '2026-10-20', sourceBlockId: 'deep', sortOrder: 0 }),
    slot({ id: 'd', date: '2026-10-20', sourceBlockId: null, sortOrder: 1 }),
    slot({ id: 'e', date: '2026-10-21', sourceBlockId: 'deep' }), // not a catch-up date
  ];
  const existing: DayDebrief[] = [
    {
      date: '2026-10-19', blocksPlanned: 9, blocksCompleted: 9, blocksSkipped: 0, totalFocusedMin: 300,
      energy: 5, focus: 5, mood: 5, tags: [], narrative: 'old', tomorrowIntent: 'gym first', freeWrite: 'notes',
    },
  ];
  const result = applyCatchUp({
    dates: ['2026-10-20', '2026-10-19'],
    context,
    decisions: [
      { slotId: 'c', status: 'COMPLETED', remark: '  did it after all ' },
      { slotId: 'd', status: 'UNRESOLVED', remark: '   ' },
      { slotId: 'e', status: 'COMPLETED' },
      { slotId: 'ghost', status: 'COMPLETED' },
    ],
    slots,
    existingDebriefs: existing,
  });

  it('unresolved blocks become SKIPPED; explicit exceptions keep their decision; others are ignored', () => {
    expect(result.slotUpdates).toEqual([
      { slotId: 'a', status: 'SKIPPED', remark: null },
      { slotId: 'c', status: 'COMPLETED', remark: 'did it after all' },
      { slotId: 'd', status: 'SKIPPED', remark: null },
    ]);
  });

  it('logs every resolved slot that has a source block', () => {
    expect(result.logUpserts).toEqual([
      { timeBlockId: 'deep', date: '2026-10-19', status: 'SKIPPED', remark: null },
      { timeBlockId: 'deep', date: '2026-10-20', status: 'COMPLETED', remark: 'did it after all' },
    ]);
  });

  it('writes one debrief per date: shared context + stats from all of that day\'s slots', () => {
    expect(result.debriefs).toEqual([
      {
        date: '2026-10-19', blocksPlanned: 2, blocksCompleted: 1, blocksSkipped: 1, totalFocusedMin: 60,
        energy: 2, focus: 3, mood: 2, tags: ['Sick'], narrative: 'Fever all weekend',
        tomorrowIntent: 'gym first', freeWrite: 'notes',
      },
      {
        date: '2026-10-20', blocksPlanned: 2, blocksCompleted: 1, blocksSkipped: 1, totalFocusedMin: 60,
        energy: 2, focus: 3, mood: 2, tags: ['Sick'], narrative: 'Fever all weekend',
        tomorrowIntent: null, freeWrite: null,
      },
    ]);
  });

  it('totalFocusedMin counts COMPLETED and PARTIAL slots (minutesDone, else actual or planned span), not 0', () => {
    const out = applyCatchUp({
      dates: ['2026-10-19'],
      context,
      decisions: [{ slotId: 'x', status: 'COMPLETED' }],
      slots: [
        slot({ id: 'x', date: '2026-10-19', startTime: '09:00', endTime: '10:30' }),
        slot({ id: 'y', date: '2026-10-19', status: 'PARTIAL', minutesDone: 25 }),
        slot({ id: 'z', date: '2026-10-19', status: 'COMPLETED', actualStartTime: '23:30', actualEndTime: '00:15' }),
        slot({ id: 'w', date: '2026-10-19' }),
      ],
      existingDebriefs: [],
    });
    expect(out.debriefs[0]).toMatchObject({ blocksPlanned: 4, blocksCompleted: 3, blocksSkipped: 1, totalFocusedMin: 90 + 25 + 45 });
  });

  it('needs energy, focus, mood (1-5) and a narrative', () => {
    expect(canSaveCatchUp(context)).toBe(true);
    expect(canSaveCatchUp({ ...context, energy: null })).toBe(false);
    expect(canSaveCatchUp({ ...context, narrative: '   ' })).toBe(false);
    expect(canSaveCatchUp({ ...context, mood: 6 })).toBe(false);
    expect(() =>
      applyCatchUp({ dates: ['2026-10-19'], context: { ...context, narrative: '' }, decisions: [], slots, existingDebriefs: [] }),
    ).toThrow(expect.objectContaining({ code: 'CATCH_UP_INVALID' }));
  });

  it('prefills a reopened catch-up from the earliest saved debrief', () => {
    const later: DayDebrief = { ...existing[0]!, date: '2026-10-20', narrative: 'later', energy: 1 };
    expect(catchUpPrefill([later, existing[0]!])).toEqual({ energy: 5, focus: 5, mood: 5, tags: [], narrative: 'old' });
    expect(catchUpPrefill([])).toBeNull();
  });
});

describe('computeAdherence (dashboard/page.tsx)', () => {
  const TODAY = '2026-10-21';
  const rows = (date: string, statuses: SlotStatus[]) => statuses.map((status) => ({ date, status }));

  it('(completed + partial) / all over the last 7 days vs the 7 before, with the delta', () => {
    const slots = [
      ...rows('2026-10-14', ['COMPLETED', 'COMPLETED', 'SKIPPED']), // first day of this week
      ...rows('2026-10-18', ['COMPLETED', 'PARTIAL', 'UPCOMING']),
      ...rows('2026-10-20', ['COMPLETED', 'COMPLETED', 'COMPLETED', 'SKIPPED']),
      ...rows('2026-10-07', ['COMPLETED', 'SKIPPED']), // first day of the prior week
      ...rows('2026-10-13', ['COMPLETED', 'COMPLETED', 'SKIPPED', 'SKIPPED', 'SKIPPED', 'SKIPPED']),
      ...rows(TODAY, ['SKIPPED', 'SKIPPED']), // today: in progress, ignored
      ...rows('2026-10-06', ['SKIPPED']), // older than 14 days: ignored
    ];
    expect(computeAdherence(slots, TODAY)).toEqual({
      adherence: 70, // 7 of 10
      priorAdherence: 38, // 3 of 8 = 37.5 → 38
      adherenceDelta: 32,
      adherenceDone: 7,
      adherenceTotal: 10,
    });
  });

  it('no slots → null, and no delta without both weeks', () => {
    expect(computeAdherence([], TODAY)).toEqual({ adherence: null, priorAdherence: null, adherenceDelta: null, adherenceDone: 0, adherenceTotal: 0 });
    expect(computeAdherence(rows('2026-10-20', ['COMPLETED', 'SKIPPED', 'SKIPPED']), TODAY)).toMatchObject({
      adherence: 33,
      adherenceDelta: null,
    });
  });

  it('a falling week gives a negative delta', () => {
    const slots = [...rows('2026-10-20', ['SKIPPED', 'COMPLETED']), ...rows('2026-10-10', ['COMPLETED', 'COMPLETED'])];
    expect(computeAdherence(slots, TODAY)).toMatchObject({ adherence: 50, priorAdherence: 100, adherenceDelta: -50 });
  });
});
