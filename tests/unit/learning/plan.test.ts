import { describe, expect, it } from 'vitest';
import {
  addDays,
  BUSY_MAX_BUDGET_MIN,
  BUSY_MAX_ITEMS,
  busyWeekUntil,
  clampBudget,
  COMEBACK_MAX_ITEMS,
  lastSeenBefore,
  planCandidates,
  planFreshStart,
  planLimits,
  planMode,
  planToday,
  revisionMinutes,
  REVISION_INTERVALS,
  type RevisionWithSubject,
} from '../../../src/services/learning';
import { deepFreeze } from './_fixtures';

// LOOP_V2_SPEC §2: Today = a budgeted plan + a quiet backlog; busy / comeback modes; fresh start.
const TODAY = '2026-11-14';

let seq = 0;
/** One pending revision (its own item unless `item` is given). */
function rev(
  scheduledFor: string,
  opts: { cycle?: number; subjectId?: string | null; item?: string; id?: string; status?: 'pending' | 'done' } = {},
): RevisionWithSubject {
  seq += 1;
  const cycle = opts.cycle ?? 2;
  const id = opts.id ?? `r${String(seq).padStart(3, '0')}`;
  return {
    id,
    topicId: opts.item ?? `item-${id}`,
    captureId: null,
    cycleNumber: cycle,
    intervalDays: REVISION_INTERVALS[cycle - 1]!,
    scheduledFor,
    completedAt: opts.status === 'done' ? new Date('2026-11-01T10:00:00Z') : null,
    status: opts.status ?? 'pending',
    subjectId: opts.subjectId === undefined ? 's-other' : opts.subjectId,
  };
}

/** A whole chain of one item: cycle k scheduled on days[k-1]. */
function chain(item: string, days: string[], opts: { subjectId?: string | null; done?: number[] } = {}): RevisionWithSubject[] {
  return days.map((day, i) =>
    rev(day, { cycle: i + 1, item, id: `${item}-c${i + 1}`, subjectId: opts.subjectId ?? 's-other', status: opts.done?.includes(i + 1) ? 'done' : 'pending' }),
  );
}

const ago = (n: number) => addDays(TODAY, -n);
const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((r) => r.id);

describe('minutes, budget, limits', () => {
  it('cycle 1 = 8 min, any later cycle = 5 min', () => {
    expect([1, 2, 3, 4].map((cycleNumber) => revisionMinutes({ cycleNumber }))).toEqual([8, 5, 5, 5]);
  });

  it('the budget is clamped to 5..120 (default 25)', () => {
    expect([clampBudget(0), clampBudget(5), clampBudget(25), clampBudget(500), clampBudget(Number.NaN), clampBudget(24.6)]).toEqual([5, 5, 25, 120, 25, 25]);
  });

  it('busy: max 3 items, budget at most 10; comeback: max 5; normal: the budget', () => {
    expect(planLimits('busy', 25)).toEqual({ budgetMin: BUSY_MAX_BUDGET_MIN, maxItems: BUSY_MAX_ITEMS });
    expect(planLimits('busy', 5)).toEqual({ budgetMin: 5, maxItems: 3 });
    expect(planLimits('comeback', 40)).toEqual({ budgetMin: 40, maxItems: COMEBACK_MAX_ITEMS });
    expect(planLimits('normal', 25)).toEqual({ budgetMin: 25, maxItems: null });
  });

  it('"Busy week" runs through today + 6', () => {
    expect(busyWeekUntil(TODAY)).toBe('2026-11-20');
  });
});

describe('planMode', () => {
  const base = { today: TODAY, busyUntil: null, lastSeenDay: ago(1), prevSeenDay: null, hasHistory: true };

  it('normal when the app was seen in the last 2 days', () => {
    expect(planMode(base)).toBe('normal');
    expect(planMode({ ...base, lastSeenDay: ago(2) })).toBe('normal');
  });

  it('busy while today <= busyUntil (inclusive), not after', () => {
    expect(planMode({ ...base, busyUntil: TODAY })).toBe('busy');
    expect(planMode({ ...base, busyUntil: addDays(TODAY, 6) })).toBe('busy');
    expect(planMode({ ...base, busyUntil: ago(1) })).toBe('normal');
  });

  it('comeback when last seen on or before today - 3, or never seen with history', () => {
    expect(planMode({ ...base, lastSeenDay: ago(3) })).toBe('comeback');
    expect(planMode({ ...base, lastSeenDay: ago(35) })).toBe('comeback');
    expect(planMode({ ...base, lastSeenDay: null })).toBe('comeback');
    expect(planMode({ ...base, lastSeenDay: null, hasHistory: false })).toBe('normal');
  });

  it('comeback lasts the whole day of the return (ensure-today moved lastSeenDay to today)', () => {
    expect(planMode({ ...base, lastSeenDay: TODAY, prevSeenDay: ago(5) })).toBe('comeback');
    expect(planMode({ ...base, lastSeenDay: TODAY, prevSeenDay: ago(1) })).toBe('normal');
    expect(planMode({ ...base, lastSeenDay: TODAY, prevSeenDay: null })).toBe('comeback');
    expect(planMode({ ...base, lastSeenDay: TODAY, prevSeenDay: null, hasHistory: false })).toBe('normal');
    expect(lastSeenBefore({ today: TODAY, lastSeenDay: TODAY, prevSeenDay: ago(4) })).toBe(ago(4));
    expect(lastSeenBefore({ today: TODAY, lastSeenDay: ago(2), prevSeenDay: ago(9) })).toBe(ago(2));
  });

  it('busy wins over comeback (the user chose it, and it is smaller)', () => {
    expect(planMode({ ...base, busyUntil: TODAY, lastSeenDay: ago(10) })).toBe('busy');
  });
});

describe('planToday: candidates', () => {
  it('only the earliest pending revision per item, due by today; done and future ones never count', () => {
    const a = chain('a', [ago(9), ago(7), ago(3), addDays(TODAY, 10)]); // cycles 1-3 pending and due: cycle 1 counts
    const b = chain('b', [ago(20), ago(18), addDays(TODAY, 1), addDays(TODAY, 15)], { done: [1, 2] }); // next is tomorrow
    const c = chain('c', [ago(5), TODAY, addDays(TODAY, 4), addDays(TODAY, 18)], { done: [1] }); // cycle 2 due today
    const all = [...a, ...b, ...c];
    expect(ids(planCandidates(all, TODAY))).toEqual(['a-c1', 'c-c2']);
    const res = planToday({ candidates: all, today: TODAY, budgetMin: 25, mode: 'normal', goalSubjectIds: [] });
    expect(ids(res.planned)).toEqual(['a-c1', 'c-c2']);
    expect(res.waitingCount).toBe(0);
  });

  it('no candidates: an empty plan', () => {
    expect(planToday({ candidates: [], today: TODAY, budgetMin: 25, mode: 'normal', goalSubjectIds: [] })).toEqual({
      planned: [],
      waitingCount: 0,
      estMinutes: 0,
      budgetMin: 25,
    });
  });
});

describe('planToday: priority', () => {
  it('1. goal-linked first, even with a higher cycle and less lateness', () => {
    const plain = rev(ago(10), { cycle: 1, id: 'plain' });
    const goal = rev(TODAY, { cycle: 4, id: 'goal', subjectId: 's-goal' });
    const res = planToday({ candidates: [plain, goal], today: TODAY, budgetMin: 120, mode: 'normal', goalSubjectIds: ['s-goal'] });
    expect(ids(res.planned)).toEqual(['goal', 'plain']);
  });

  it('2. lower cycle first, 3. more days late first, 4. older first, 5. id', () => {
    const rows = [
      rev(ago(1), { cycle: 3, id: 'c3-late1' }),
      rev(ago(2), { cycle: 2, id: 'c2-late2' }),
      rev(ago(30), { cycle: 2, id: 'c2-late30' }),
      rev(ago(15), { cycle: 2, id: 'c2-late15' }),
      rev(TODAY, { cycle: 2, id: 'c2-today-b' }),
      rev(TODAY, { cycle: 2, id: 'c2-today-a' }),
      rev(TODAY, { cycle: 1, id: 'c1-today' }),
    ];
    const res = planToday({ candidates: deepFreeze(rows), today: TODAY, budgetMin: 120, mode: 'normal', goalSubjectIds: [] });
    // 30 and 15 days late both count as 14 (the cap); then scheduledFor ascending puts 30 first.
    expect(ids(res.planned)).toEqual(['c1-today', 'c2-late30', 'c2-late15', 'c2-late2', 'c2-today-a', 'c2-today-b', 'c3-late1']);
  });

  it('a subject-less capture (subject null) is never goal-linked', () => {
    const inbox = rev(ago(3), { cycle: 2, id: 'inbox', subjectId: null });
    const goal = rev(ago(1), { cycle: 2, id: 'goal', subjectId: 's-goal' });
    expect(ids(planToday({ candidates: [inbox, goal], today: TODAY, budgetMin: 60, mode: 'normal', goalSubjectIds: ['s-goal'] }).planned)).toEqual(['goal', 'inbox']);
  });
});

describe('planToday: filling the budget', () => {
  it('adds items while they fit (never over the budget): 8 + 5 + 5 + 5 = 23 of 25', () => {
    const rows = [rev(TODAY, { cycle: 1, id: 'a' }), rev(ago(1), { id: 'b' }), rev(ago(2), { id: 'c' }), rev(ago(3), { id: 'd' }), rev(ago(4), { id: 'e' })];
    const res = planToday({ candidates: rows, today: TODAY, budgetMin: 25, mode: 'normal', goalSubjectIds: [] });
    expect(ids(res.planned)).toEqual(['a', 'e', 'd', 'c']);
    expect([res.estMinutes, res.waitingCount, res.budgetMin]).toEqual([23, 1, 25]);
  });

  it('the plan is a prefix of the priority order: a smaller item never jumps a bigger one that does not fit', () => {
    const rows = [rev(ago(1), { cycle: 1, id: 'x1' }), rev(ago(1), { cycle: 1, id: 'x2' }), rev(ago(1), { cycle: 1, id: 'x3' }), rev(ago(1), { cycle: 1, id: 'x4' }), rev(ago(1), { cycle: 2, id: 'y' })];
    const res = planToday({ candidates: rows, today: TODAY, budgetMin: 30, mode: 'normal', goalSubjectIds: [] });
    expect(ids(res.planned)).toEqual(['x1', 'x2', 'x3']); // 24; x4 (8) does not fit, so y (5) waits too
    expect([res.estMinutes, res.waitingCount]).toEqual([24, 2]);
  });

  it('at least 3 items with any candidates, even when the first one alone is over the budget', () => {
    const rows = [rev(ago(2), { cycle: 1, id: 'a' }), rev(ago(1), { cycle: 1, id: 'b' }), rev(TODAY, { cycle: 1, id: 'c' }), rev(TODAY, { cycle: 2, id: 'd' })];
    const res = planToday({ candidates: rows, today: TODAY, budgetMin: 5, mode: 'normal', goalSubjectIds: [] });
    expect(ids(res.planned)).toEqual(['a', 'b', 'c']);
    expect([res.estMinutes, res.waitingCount, res.budgetMin]).toEqual([24, 1, 5]);
    // Fewer than 3 candidates: all of them.
    expect(planToday({ candidates: rows.slice(0, 2), today: TODAY, budgetMin: 5, mode: 'normal', goalSubjectIds: [] }).planned).toHaveLength(2);
  });

  it('a big backlog: the budget plans a few, the rest waits quietly', () => {
    const rows = Array.from({ length: 15 }, (_, i) => rev(ago(35 - i * 2), { cycle: i % 3 === 0 ? 1 : 2 }));
    const res = planToday({ candidates: rows, today: TODAY, budgetMin: 25, mode: 'normal', goalSubjectIds: [] });
    expect(res.estMinutes).toBeLessThanOrEqual(25);
    expect(res.planned.length + res.waitingCount).toBe(15);
    expect(res.planned.length).toBe(3); // three cycle-1 items: 24 min
  });
});

describe('planToday: modes', () => {
  const backlog = () => Array.from({ length: 10 }, (_, i) => rev(ago(i + 1), { cycle: 2, id: `b${i}` }));

  it('busy: at most 3 items (the minimum of 3 makes it exactly 3 with enough candidates), budget capped at 10', () => {
    const res = planToday({ candidates: backlog(), today: TODAY, budgetMin: 25, mode: 'busy', goalSubjectIds: [] });
    expect(res.planned).toHaveLength(3);
    expect([res.estMinutes, res.waitingCount, res.budgetMin]).toEqual([15, 7, 10]);
  });

  it('comeback: at most 5 items that day, even with a large budget', () => {
    const res = planToday({ candidates: backlog(), today: TODAY, budgetMin: 120, mode: 'comeback', goalSubjectIds: [] });
    expect(res.planned).toHaveLength(5);
    expect([res.estMinutes, res.waitingCount]).toEqual([25, 5]);
    // A small budget still fills to the minimum of 3.
    expect(planToday({ candidates: backlog(), today: TODAY, budgetMin: 10, mode: 'comeback', goalSubjectIds: [] }).planned).toHaveLength(3);
  });

  it('normal: only the budget limits it', () => {
    expect(planToday({ candidates: backlog(), today: TODAY, budgetMin: 120, mode: 'normal', goalSubjectIds: [] }).planned).toHaveLength(10);
  });
});

describe('planToday: what was done today counts (Today is finite)', () => {
  it('done minutes use up the budget; finishing the plan leaves it empty instead of refilling', () => {
    const rows = Array.from({ length: 8 }, (_, i) => rev(ago(i + 1), { cycle: 2, id: `w${i}` }));
    const done8 = { cycleNumber: 1 };
    const done5 = { cycleNumber: 3 };
    const half = planToday({ candidates: rows, today: TODAY, budgetMin: 25, mode: 'normal', goalSubjectIds: [], doneToday: [done8, done8] });
    expect([half.planned.length, half.estMinutes]).toEqual([1, 5]); // 16 done + 5 = 21; another 5 → 26
    const full = planToday({ candidates: rows, today: TODAY, budgetMin: 25, mode: 'normal', goalSubjectIds: [], doneToday: [done8, done8, done8] });
    expect([full.planned.length, full.waitingCount]).toEqual([0, 8]);
    // The minimum of 3 counts done items too: 1 done → at least 2 planned.
    const one = planToday({ candidates: rows, today: TODAY, budgetMin: 5, mode: 'normal', goalSubjectIds: [], doneToday: [done5] });
    expect(one.planned).toHaveLength(2);
  });

  it('busy and comeback limits count done items', () => {
    const rows = Array.from({ length: 8 }, (_, i) => rev(ago(i + 1), { cycle: 2 }));
    expect(planToday({ candidates: rows, today: TODAY, budgetMin: 25, mode: 'busy', goalSubjectIds: [], doneToday: [{ cycleNumber: 2 }, { cycleNumber: 2 }] }).planned).toHaveLength(1);
    expect(planToday({ candidates: rows, today: TODAY, budgetMin: 25, mode: 'busy', goalSubjectIds: [], doneToday: Array(4).fill({ cycleNumber: 2 }) }).planned).toHaveLength(0);
    expect(planToday({ candidates: rows, today: TODAY, budgetMin: 120, mode: 'comeback', goalSubjectIds: [], doneToday: Array(4).fill({ cycleNumber: 2 }) }).planned).toHaveLength(1);
  });
});

describe('planFreshStart', () => {
  const days = (rows: ReadonlyArray<{ id: string; scheduledFor?: string }>) => Object.fromEntries(rows.map((p) => [p.id, p.scheduledFor]));

  it('nothing overdue: nothing moves', () => {
    const res = planFreshStart({ revisions: [...chain('a', [TODAY, addDays(TODAY, 2), addDays(TODAY, 6), addDays(TODAY, 20)])], today: TODAY, budgetMin: 25 });
    expect(res).toEqual({ patches: [], moved: 0, spreadDays: 0, days: [] });
  });

  it("moves each overdue chain's earliest pending revision; later pending cycles keep their gaps; done cycles stay", () => {
    // Cycle 1 done long ago, cycle 2 is 35 days late; cycles 3/4 sit 4 and 18 days after it.
    const late = chain('late', [ago(40), ago(35), ago(31), ago(17)], { done: [1] });
    const res = planFreshStart({ revisions: deepFreeze(late), today: TODAY, budgetMin: 25 });
    expect(res.moved).toBe(1);
    expect(res.spreadDays).toBe(1);
    expect(days(res.patches)).toEqual({ 'late-c2': TODAY, 'late-c3': addDays(TODAY, 4), 'late-c4': addDays(TODAY, 18) });
  });

  it('spreads over the next days at what fits the budget per day, in plan priority order', () => {
    const overdue = Array.from({ length: 12 }, (_, i) => rev(ago(20 - i), { cycle: 2, id: `o${String(i).padStart(2, '0')}` }));
    const res = planFreshStart({ revisions: overdue, today: TODAY, budgetMin: 25 });
    expect(res.moved).toBe(12);
    expect(res.days.map((d) => [d.day, d.revisionIds.length, d.minutes])).toEqual([
      [TODAY, 5, 25],
      [addDays(TODAY, 1), 5, 25],
      [addDays(TODAY, 2), 2, 10],
    ]);
    expect(res.spreadDays).toBe(3);
    expect(res.days[0]!.revisionIds).toEqual(['o00', 'o01', 'o02', 'o03', 'o04']); // the most late first
  });

  it("counts what is already due on each day (and today's completions), and places at least one item per day", () => {
    const dueToday = [rev(TODAY, { cycle: 2, id: 't1' }), rev(TODAY, { cycle: 2, id: 't2' })]; // 10 min today
    const heavyTomorrow = Array.from({ length: 6 }, (_, i) => rev(addDays(TODAY, 1), { cycle: 2, id: `h${i}` })); // 30 min
    const overdue = Array.from({ length: 6 }, (_, i) => rev(ago(10 - i), { cycle: 2, id: `o${i}` }));
    const res = planFreshStart({ revisions: [...dueToday, ...heavyTomorrow, ...overdue], today: TODAY, budgetMin: 25, doneToday: [{ cycleNumber: 2 }] });
    expect(res.days.map((d) => [d.day, d.revisionIds])).toEqual([
      [TODAY, ['o0', 'o1']], // 10 due + 5 done + 10 = 25
      [addDays(TODAY, 1), ['o2']], // already over budget: still one
      [addDays(TODAY, 2), ['o3', 'o4', 'o5']],
    ]);
    // Nothing that was due today or later moved.
    expect(res.patches.map((p) => p.id).sort()).toEqual(['o0', 'o1', 'o2', 'o3', 'o4', 'o5']);
  });

  it('goal-linked chains come first, and cycle-1 items count 8 minutes', () => {
    const plain = rev(ago(30), { cycle: 2, id: 'plain' });
    const goal = rev(ago(2), { cycle: 1, id: 'goal', subjectId: 's-goal' });
    const res = planFreshStart({ revisions: [plain, goal], today: TODAY, budgetMin: 10, goalSubjectIds: ['s-goal'] });
    expect(res.days.map((d) => [d.day, d.revisionIds, d.minutes])).toEqual([
      [TODAY, ['goal'], 8],
      [addDays(TODAY, 1), ['plain'], 5],
    ]);
  });
});
