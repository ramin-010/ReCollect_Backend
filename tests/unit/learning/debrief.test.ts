import { describe, expect, it } from 'vitest';
import {
  canSaveDebrief,
  computeDebriefStats,
  planDebriefSave,
  type DebriefForm,
  type DebriefSlot,
} from '../../../src/services/learning';

// Sources: revise/src/components/dashboard/DayDebriefModal.tsx (stats, handleSave)
//          revise/src/app/actions/debrief.actions.ts (saveDebrief)

const ds = (over: Partial<DebriefSlot> & Pick<DebriefSlot, 'id'>): DebriefSlot => ({
  sourceBlockId: null,
  startTime: '09:00',
  endTime: '10:00',
  status: 'UPCOMING',
  remark: null,
  minutesDone: null,
  actualStartTime: null,
  actualEndTime: null,
  ...over,
});

describe('computeDebriefStats (Layer 1 auto-context)', () => {
  const slots = [
    ds({ id: 'a', status: 'COMPLETED' }), // 60 from the planned span
    ds({ id: 'b', status: 'PARTIAL', minutesDone: 45 }), // minutesDone wins
    ds({ id: 'c', status: 'COMPLETED', minutesDone: 0, startTime: '14:00', endTime: '15:30' }), // 0 counts as unset → 90
    ds({ id: 'd', status: 'COMPLETED', actualStartTime: '22:30', actualEndTime: '00:15' }), // actual times, across midnight → 105
    ds({ id: 'e', status: 'SKIPPED' }),
    ds({ id: 'f', status: 'UPCOMING' }),
    ds({ id: 'g', status: 'ACTIVE' }),
    ds({ id: 'h', status: 'COMPLETED', startTime: '09:00', endTime: '09:00' }), // a zero span stays 0 here
  ];

  it('counts planned / completed (incl. PARTIAL) / skipped / remaining', () => {
    expect(computeDebriefStats(slots)).toMatchObject({ planned: 8, completed: 5, skipped: 1, remaining: 2 });
  });

  it('focused minutes: minutesDone if non-zero, else (actual or planned) span; hours to one decimal', () => {
    const stats = computeDebriefStats(slots);
    expect(stats.focusedMin).toBe(60 + 45 + 90 + 105 + 0);
    expect(stats.focusedHrs).toBe('5.0');
    expect(computeDebriefStats([ds({ id: 'x', status: 'COMPLETED', endTime: '11:30' })]).focusedHrs).toBe('2.5');
  });

  it('an empty day', () => {
    expect(computeDebriefStats([])).toEqual({ planned: 0, completed: 0, skipped: 0, remaining: 0, focusedMin: 0, focusedHrs: '0.0' });
  });
});

describe('saving a debrief', () => {
  const form: DebriefForm = {
    energy: 3,
    focus: 4,
    mood: 2,
    tags: ['Tired'],
    narrative: '  rough day  ',
    tomorrowIntent: '   ',
    freeWrite: '',
  };

  it('needs energy, focus and mood rated 1-5 (the narrative is optional)', () => {
    expect(canSaveDebrief(form)).toBe(true);
    expect(canSaveDebrief({ energy: null, focus: 4, mood: 2 })).toBe(false);
    expect(canSaveDebrief({ energy: 0, focus: 4, mood: 2 })).toBe(false);
    expect(canSaveDebrief({ energy: 3.5, focus: 4, mood: 2 })).toBe(false);
    expect(() => planDebriefSave('2026-10-20', [], { ...form, mood: null })).toThrow(expect.objectContaining({ code: 'DEBRIEF_INVALID' }));
    expect(() => planDebriefSave('20-10-2026', [], form)).toThrow(expect.objectContaining({ code: 'INVALID_DAY' }));
  });

  it('plans the debrief row, the slot writes and the BlockSessionLog sync', () => {
    const slots = [
      ds({ id: 'a', sourceBlockId: 'deep', status: 'COMPLETED', remark: '' }),
      ds({ id: 'e', sourceBlockId: 'gym', status: 'SKIPPED', remark: 'tired' }),
      ds({ id: 'f', sourceBlockId: 'read', status: 'UPCOMING' }),
      ds({ id: 'm', sourceBlockId: null, status: 'COMPLETED', minutesDone: 50 }),
    ];
    const plan = planDebriefSave('2026-10-20', slots, form);
    expect(plan.debrief).toEqual({
      date: '2026-10-20',
      blocksPlanned: 4,
      blocksCompleted: 2,
      blocksSkipped: 1,
      totalFocusedMin: 110,
      energy: 3,
      focus: 4,
      mood: 2,
      tags: ['Tired'],
      narrative: 'rough day',
      tomorrowIntent: null,
      freeWrite: null,
    });
    expect(plan.slotUpdates.map((u) => [u.slotId, u.status, u.remark])).toEqual([
      ['a', 'COMPLETED', ''],
      ['e', 'SKIPPED', 'tired'],
      ['f', 'UPCOMING', null],
      ['m', 'COMPLETED', null],
    ]);
    // Only resolved slots that come from a block, dated with the debrief's day.
    expect(plan.logUpserts).toEqual([
      { timeBlockId: 'deep', date: '2026-10-20', status: 'COMPLETED', remark: '', minutesDone: null },
      { timeBlockId: 'gym', date: '2026-10-20', status: 'SKIPPED', remark: 'tired', minutesDone: null },
    ]);
  });
});
