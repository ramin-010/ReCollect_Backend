import { describe, expect, it } from 'vitest';
import {
  buildRevisionBuckets,
  completeRevision,
  countDue,
  daysLate,
  earliestPendingPerItem,
  isCompletedOn,
  isDue,
  isMastered,
  isOverdue,
  nextRevisionAction,
  REVISION_CYCLES,
  REVISION_INTERVALS,
  rescheduleRevision,
  revisionItemKey,
  revisionProgress,
  startRevisions,
  today,
  uncompleteRevision,
  type Revision,
  type RevisionWithSubject,
} from '../../../src/services/learning';
import { datesOf, deepFreeze, IST, ist, makeChain, NY } from './_fixtures';

/** Completes `id` at `at` and returns the new chain. */
const done = <T extends Revision>(chain: T[], id: string, at: Date, tz = IST): T[] => completeRevision(chain, id, at, tz).revisions;

describe('startRevisions (revision.actions.ts startTopicRevisions / startCaptureRevisions)', () => {
  it('plans 4 pending cycles at +1, +3, +7, +21 days from the start day', () => {
    expect(REVISION_INTERVALS).toEqual([1, 3, 7, 21]);
    expect(REVISION_CYCLES).toBe(4);
    expect(startRevisions('2026-10-21')).toEqual([
      { cycleNumber: 1, intervalDays: 1, scheduledFor: '2026-10-22', status: 'pending', completedAt: null },
      { cycleNumber: 2, intervalDays: 3, scheduledFor: '2026-10-24', status: 'pending', completedAt: null },
      { cycleNumber: 3, intervalDays: 7, scheduledFor: '2026-10-28', status: 'pending', completedAt: null },
      { cycleNumber: 4, intervalDays: 21, scheduledFor: '2026-11-11', status: 'pending', completedAt: null },
    ]);
  });

  it('starts from the user-local day: 00:10 IST is already the next day', () => {
    const startDay = today(IST, ist('2026-10-21', '00:10'));
    expect(startRevisions(startDay)[0]?.scheduledFor).toBe('2026-10-22');
  });

  it('refuses to start a second set (guard Revise lacked)', () => {
    expect(() => startRevisions('2026-10-21', makeChain('2026-10-01'))).toThrow(
      expect.objectContaining({ code: 'ALREADY_STARTED' }),
    );
  });
});

describe('completeRevision (revision.actions.ts completeRevision, steps 1-2)', () => {
  // Chain started 2026-10-01: cycle 1 → 10-02, 2 → 10-04, 3 → 10-08, 4 → 10-22.
  const base = () => makeChain('2026-10-01');

  it('on time: later cycles land where they already were', () => {
    const at = ist('2026-10-02', '09:30');
    const res = completeRevision(base(), 'r1', at, IST);
    expect(res.completedDay).toBe('2026-10-02');
    expect(datesOf(res.revisions)).toEqual({ 1: '2026-10-02', 2: '2026-10-04', 3: '2026-10-08', 4: '2026-10-22' });
    expect(res.patches).toEqual([{ id: 'r1', status: 'done', completedAt: at }]);
    expect(res.undo).toEqual({ revisionId: 'r1', completedDay: '2026-10-02', shifts: [] });
    expect(res.revisions[0]).toMatchObject({ status: 'done', completedAt: at });
  });

  it('late: later pending cycles move to completedDay + (interval_j - interval_k)', () => {
    const res = completeRevision(base(), 'r1', ist('2026-10-05', '20:00'), IST);
    // 3 days late: 10-05 + 2, + 6, + 20
    expect(datesOf(res.revisions)).toEqual({ 1: '2026-10-02', 2: '2026-10-07', 3: '2026-10-11', 4: '2026-10-25' });
    expect(res.undo.shifts).toEqual([
      { revisionId: 'r2', from: '2026-10-04', to: '2026-10-07' },
      { revisionId: 'r3', from: '2026-10-08', to: '2026-10-11' },
      { revisionId: 'r4', from: '2026-10-22', to: '2026-10-25' },
    ]);
    expect(res.patches).toHaveLength(4);
  });

  it('early: completing cycle 2 a day early pulls cycles 3 and 4 in', () => {
    const afterC1 = done(base(), 'r1', ist('2026-10-02', '08:00'));
    const res = completeRevision(afterC1, 'r2', ist('2026-10-03', '08:00'), IST);
    expect(datesOf(res.revisions)).toEqual({ 1: '2026-10-02', 2: '2026-10-04', 3: '2026-10-07', 4: '2026-10-21' });
  });

  it('"Revise Early" on cycle 1 (the start day)', () => {
    const res = completeRevision(base(), 'r1', ist('2026-10-01', '21:00'), IST);
    expect(datesOf(res.revisions)).toEqual({ 1: '2026-10-02', 2: '2026-10-03', 3: '2026-10-07', 4: '2026-10-21' });
  });

  it("uses the user's zone to decide the completed day", () => {
    const at = new Date('2026-10-04T20:00:00Z'); // 01:30 IST on the 5th, 16:00 EDT on the 4th
    expect(datesOf(completeRevision(base(), 'r1', at, IST).revisions)[2]).toBe('2026-10-07');
    const ny = completeRevision(base(), 'r1', at, NY);
    expect(ny.completedDay).toBe('2026-10-04');
    expect(datesOf(ny.revisions)).toEqual({ 1: '2026-10-02', 2: '2026-10-06', 3: '2026-10-10', 4: '2026-10-24' });
  });

  it('cycle 4 done = mastered', () => {
    let chain = base();
    chain = done(chain, 'r1', ist('2026-10-02', '09:00'));
    chain = done(chain, 'r2', ist('2026-10-04', '09:00'));
    chain = done(chain, 'r3', ist('2026-10-08', '09:00'));
    expect(isMastered(chain)).toBe(false);
    const res = completeRevision(chain, 'r4', ist('2026-10-22', '09:00'), IST);
    expect(res.mastered).toBe(true);
    expect(isMastered(res.revisions)).toBe(true);
  });

  it('only shifts later PENDING cycles (a later cycle already done stays put)', () => {
    const chain = base().map((r) => (r.id === 'r3' ? { ...r, status: 'done' as const, completedAt: ist('2026-10-03', '10:00') } : r));
    const res = completeRevision(chain, 'r1', ist('2026-10-05', '09:00'), IST);
    expect(datesOf(res.revisions)).toEqual({ 1: '2026-10-02', 2: '2026-10-07', 3: '2026-10-08', 4: '2026-10-25' });
  });

  it('guards: not pending, unknown id, mixed chain', () => {
    const chain = done(base(), 'r1', ist('2026-10-02', '09:00'));
    expect(() => completeRevision(chain, 'r1', new Date(), IST)).toThrow(expect.objectContaining({ code: 'NOT_PENDING' }));
    expect(() => completeRevision(chain, 'nope', new Date(), IST)).toThrow(expect.objectContaining({ code: 'REVISION_NOT_FOUND' }));
    const mixed = [...base(), ...makeChain('2026-10-01', { prefix: 'x', topicId: 't2' })];
    expect(() => completeRevision(mixed, 'r1', new Date(), IST)).toThrow(expect.objectContaining({ code: 'MIXED_CHAIN' }));
  });

  it('never mutates its input', () => {
    const chain = deepFreeze(base());
    const snapshot = JSON.stringify(chain);
    completeRevision(chain, 'r1', ist('2026-10-05', '09:00'), IST);
    expect(JSON.stringify(chain)).toBe(snapshot);
  });
});

describe('rescheduleRevision (planner.actions.ts rescheduleRevision)', () => {
  const base = () => makeChain('2026-10-01');

  it('moves the cycle and shifts every later pending cycle by the same number of days', () => {
    const res = rescheduleRevision(base(), 'r1', '2026-10-05');
    expect(res.deltaDays).toBe(3);
    expect(datesOf(res.revisions)).toEqual({ 1: '2026-10-05', 2: '2026-10-07', 3: '2026-10-11', 4: '2026-10-25' });
    expect(res.patches.map((p) => p.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('moving earlier works the same way', () => {
    const res = rescheduleRevision(base(), 'r1', '2026-10-01');
    expect(res.deltaDays).toBe(-1);
    expect(datesOf(res.revisions)).toEqual({ 1: '2026-10-01', 2: '2026-10-03', 3: '2026-10-07', 4: '2026-10-21' });
  });

  it('rescheduling a middle cycle leaves earlier cycles alone', () => {
    const chain = done(base(), 'r1', ist('2026-10-02', '09:00'));
    const res = rescheduleRevision(chain, 'r2', '2026-10-06');
    expect(datesOf(res.revisions)).toEqual({ 1: '2026-10-02', 2: '2026-10-06', 3: '2026-10-10', 4: '2026-10-24' });
  });

  it('a later cycle that is already done is not shifted (Revise shifted every later cycle)', () => {
    const chain = base().map((r) => (r.id === 'r3' ? { ...r, status: 'done' as const, completedAt: ist('2026-10-03', '10:00') } : r));
    const res = rescheduleRevision(chain, 'r2', '2026-10-06');
    expect(datesOf(res.revisions)).toEqual({ 1: '2026-10-02', 2: '2026-10-06', 3: '2026-10-08', 4: '2026-10-24' });
  });

  it('same day = no change; done or invalid input is rejected', () => {
    expect(rescheduleRevision(base(), 'r1', '2026-10-02')).toMatchObject({ deltaDays: 0, patches: [] });
    const chain = done(base(), 'r1', ist('2026-10-02', '09:00'));
    expect(() => rescheduleRevision(chain, 'r1', '2026-10-09')).toThrow(expect.objectContaining({ code: 'NOT_PENDING' }));
    expect(() => rescheduleRevision(base(), 'r1', '2026-10-32')).toThrow(expect.objectContaining({ code: 'INVALID_DAY' }));
  });
});

describe('uncompleteRevision: the correct undo', () => {
  const base = () => makeChain('2026-10-01');

  it('with the undo record: restores the exact pre-completion chain', () => {
    const original = base();
    const completed = completeRevision(original, 'r1', ist('2026-10-05', '20:00'), IST);
    const res = uncompleteRevision(completed.revisions, 'r1', completed.undo, IST);
    expect(res.revisions).toEqual(original);
    expect(res.restoredWith).toBe('undo-record');
    expect(res.completedDay).toBe('2026-10-05');
    expect(res.patches).toEqual([
      { id: 'r1', status: 'pending', completedAt: null },
      { id: 'r2', scheduledFor: '2026-10-04' },
      { id: 'r3', scheduledFor: '2026-10-08' },
      { id: 'r4', scheduledFor: '2026-10-22' },
    ]);
  });

  it("is not Revise's toggleRevision, which only flipped the status and left the dates shifted", () => {
    const completed = completeRevision(base(), 'r1', ist('2026-10-05', '20:00'), IST);
    const reviseStyle = completed.revisions.map((r) => (r.id === 'r1' ? { ...r, status: 'pending' as const, completedAt: null } : r));
    expect(datesOf(reviseStyle)[2]).toBe('2026-10-07'); // what Revise leaves behind
    expect(datesOf(uncompleteRevision(completed.revisions, 'r1', completed.undo).revisions)[2]).toBe('2026-10-04');
  });

  it('keeps a reschedule made between the completion and the undo', () => {
    const completed = completeRevision(base(), 'r1', ist('2026-10-05', '20:00'), IST); // r2 → 10-07
    const moved = rescheduleRevision(completed.revisions, 'r2', '2026-10-09'); // +2 on r2..r4
    const res = uncompleteRevision(moved.revisions, 'r1', completed.undo, IST);
    expect(datesOf(res.revisions)).toEqual({ 1: '2026-10-02', 2: '2026-10-06', 3: '2026-10-10', 4: '2026-10-24' });
  });

  it('without a record (e.g. imported from Revise): re-spaces later cycles from the restored one', () => {
    const completed = completeRevision(base(), 'r1', ist('2026-10-05', '20:00'), IST);
    const res = uncompleteRevision(completed.revisions, 'r1', null, IST);
    expect(res.revisions).toEqual(base());
    expect(res.restoredWith).toBe('interval-spacing');
    expect(res.completedDay).toBe('2026-10-05');
  });

  it('interval spacing also survives an earlier reschedule', () => {
    const rescheduled = rescheduleRevision(base(), 'r1', '2026-10-05').revisions; // 10-05, 07, 11, 25
    const completed = done(rescheduled, 'r1', ist('2026-10-08', '09:00')); // r2 → 10-10 ...
    expect(datesOf(uncompleteRevision(completed, 'r1').revisions)).toEqual(datesOf(rescheduled));
  });

  it('complete → undo → complete gives the same result as the first completion', () => {
    const at = ist('2026-10-05', '20:00');
    const first = completeRevision(base(), 'r1', at, IST);
    const undone = uncompleteRevision(first.revisions, 'r1', first.undo, IST);
    expect(completeRevision(undone.revisions, 'r1', at, IST).revisions).toEqual(first.revisions);
  });

  it('guards: not done, a later cycle done, wrong undo record', () => {
    expect(() => uncompleteRevision(base(), 'r1')).toThrow(expect.objectContaining({ code: 'NOT_DONE' }));
    const c1 = completeRevision(base(), 'r1', ist('2026-10-02', '09:00'), IST);
    const c2 = completeRevision(c1.revisions, 'r2', ist('2026-10-04', '09:00'), IST);
    expect(() => uncompleteRevision(c2.revisions, 'r1', c1.undo)).toThrow(expect.objectContaining({ code: 'LATER_CYCLE_DONE' }));
    expect(() => uncompleteRevision(c2.revisions, 'r2', c1.undo)).toThrow(expect.objectContaining({ code: 'UNDO_MISMATCH' }));
    // Undoing in reverse order works.
    const back = uncompleteRevision(uncompleteRevision(c2.revisions, 'r2', c2.undo).revisions, 'r1', c1.undo);
    expect(back.revisions).toEqual(base());
  });

  it('never mutates its input', () => {
    const completed = completeRevision(base(), 'r1', ist('2026-10-05', '20:00'), IST);
    const frozen = deepFreeze(completed.revisions);
    const snapshot = JSON.stringify(frozen);
    uncompleteRevision(frozen, 'r1', completed.undo, IST);
    expect(JSON.stringify(frozen)).toBe(snapshot);
  });
});

describe('due, overdue, daysLate (page.tsx, RevisionsList.tsx)', () => {
  const rev = (scheduledFor: string, status: Revision['status'] = 'pending'): Revision => ({
    id: scheduledFor,
    topicId: 't',
    captureId: null,
    cycleNumber: 1,
    intervalDays: 1,
    scheduledFor,
    completedAt: status === 'done' ? new Date('2026-10-18T05:00:00Z') : null,
    status,
  });

  it('due = pending and scheduled on or before today; overdue = strictly before', () => {
    expect(isDue(rev('2026-10-21'), '2026-10-21')).toBe(true);
    expect(isOverdue(rev('2026-10-21'), '2026-10-21')).toBe(false);
    expect(isDue(rev('2026-10-18'), '2026-10-21')).toBe(true);
    expect(isOverdue(rev('2026-10-18'), '2026-10-21')).toBe(true);
    expect(isDue(rev('2026-10-22'), '2026-10-21')).toBe(false);
    expect(isDue(rev('2026-10-18', 'done'), '2026-10-21')).toBe(false);
    expect(isDue(rev('2026-10-18', 'missed'), '2026-10-21')).toBe(false);
    expect(countDue([rev('2026-10-18'), rev('2026-10-21'), rev('2026-10-22'), rev('2026-10-19', 'done')], '2026-10-21')).toBe(2);
  });

  it('daysLate = max(1, today - scheduledFor)', () => {
    expect(daysLate('2026-10-18', '2026-10-21')).toBe(3);
    expect(daysLate('2026-10-20', '2026-10-21')).toBe(1);
    expect(daysLate('2026-10-21', '2026-10-21')).toBe(1);
  });

  it("isCompletedOn uses the user's zone", () => {
    const r: Revision = { ...rev('2026-10-20', 'done'), completedAt: ist('2026-10-21', '00:05') };
    expect(isCompletedOn(r, '2026-10-21', IST)).toBe(true);
    expect(isCompletedOn(r, '2026-10-21', NY)).toBe(false); // 14:35 EDT on the 20th
    expect(isCompletedOn(r, '2026-10-20', NY)).toBe(true);
  });
});

describe('earliest pending per item, next action, progress', () => {
  it('keeps one pending revision per item: the earliest, lower cycle on ties', () => {
    const a = makeChain('2026-10-01', { prefix: 'a', topicId: 'tA' });
    const b = done(makeChain('2026-10-01', { prefix: 'b', topicId: null, captureId: 'cB' }), 'b1', ist('2026-10-02', '09:00'));
    const tie = makeChain('2026-10-01', { prefix: 'c', topicId: 'tC' }).map((r) =>
      r.cycleNumber <= 2 ? { ...r, scheduledFor: '2026-10-05' } : r,
    );
    const picked = earliestPendingPerItem([...b, ...tie, ...a]);
    expect(picked.map((r) => r.id)).toEqual(['a1', 'b2', 'c1']);
    expect(revisionItemKey(b[0]!)).toBe('capture_cB');
    expect(revisionItemKey(a[0]!)).toBe('topic_tA');
  });

  it('topic page button: start / wait / early (Revise Early) / due / completed', () => {
    const chain = makeChain('2026-10-20'); // c1 → 10-21
    expect(nextRevisionAction([], '2026-10-21')).toEqual({ kind: 'start' });
    expect(nextRevisionAction(chain, '2026-10-19')).toMatchObject({ kind: 'wait', inDays: 2 });
    expect(nextRevisionAction(chain, '2026-10-20')).toMatchObject({ kind: 'early', next: { id: 'r1' } });
    expect(nextRevisionAction(chain, '2026-10-21')).toMatchObject({ kind: 'due', next: { id: 'r1' } });
    expect(nextRevisionAction(chain, '2026-10-25')).toMatchObject({ kind: 'due', next: { id: 'r1' } });
    const allDone = chain.map((r) => ({ ...r, status: 'done' as const, completedAt: new Date() }));
    expect(nextRevisionAction(allDone, '2026-10-21')).toEqual({ kind: 'completed' });
  });

  it('progress counters: mastered, in progress, not started (topics only)', () => {
    const mastered = makeChain('2026-09-01').map((r) => ({ ...r, status: 'done' as const, completedAt: new Date() }));
    const inProgress = done(makeChain('2026-10-01', { topicId: 't2' }), 'r1', ist('2026-10-02', '09:00'));
    expect(revisionProgress([[], mastered, inProgress])).toEqual({
      totalTopics: 3,
      topicsWithRevisions: 2,
      mastered: 1,
      inProgress: 1,
      notStarted: 1,
    });
  });
});

describe('buildRevisionBuckets (page.tsx + DashboardClient.tsx)', () => {
  const now = ist('2026-10-21', '00:10'); // inside Revise's 00:00-05:30 blind spot
  const day = today(IST, now);

  // A: due today (subject s1)
  const A = makeChain('2026-10-20', { prefix: 'A', topicId: 'tA', subjectId: 's1' });
  // B: cycles 1 and 2 overdue (subject s2): only cycle 1 is shown
  const B = makeChain('2026-10-15', { prefix: 'B', topicId: 'tB', subjectId: 's2' }).map((r) =>
    r.cycleNumber === 2 ? { ...r, scheduledFor: '2026-10-18' } : r,
  );
  // C: capture without subject, due today → 'general'
  const C = makeChain('2026-10-20', { prefix: 'C', topicId: null, captureId: 'cC', subjectId: null });
  // D: cycle 1 (due 10-18) completed at 00:05 IST today
  const D = done(makeChain('2026-10-17', { prefix: 'D', topicId: 'tD', subjectId: 's1' }), 'D1', ist('2026-10-21', '00:05'));
  // E: completed yesterday → not shown
  const E = done(makeChain('2026-10-19', { prefix: 'E', topicId: 'tE', subjectId: 's2' }), 'E1', ist('2026-10-20', '22:00'));
  // F: first cycle tomorrow → not shown
  const F = makeChain('2026-10-21', { prefix: 'F', topicId: 'tF', subjectId: 's1' });
  // G: a 'missed' row (Revise never writes it) → not shown
  const G: RevisionWithSubject = { ...makeChain('2026-10-18', { prefix: 'G', topicId: 'tG' })[0]!, status: 'missed' };
  // H: due today (subject s1), after A in input order
  const H = makeChain('2026-10-20', { prefix: 'H', topicId: 'tH', subjectId: 's1' });
  // I: cycle 2 (due today) completed today at 00:08 → done today, newest scheduledFor first
  const I = done(
    done(makeChain('2026-10-18', { prefix: 'I', topicId: 'tI', subjectId: 's2' }), 'I1', ist('2026-10-19', '09:00')),
    'I2',
    ist('2026-10-21', '00:08'),
  );

  const all = [...A, ...B, ...C, ...D, ...E, ...F, G, ...H, ...I];
  const buckets = buildRevisionBuckets(all, day, IST);

  it('today flips at local midnight: at 00:10 IST the 21st is today', () => {
    expect(day).toBe('2026-10-21');
    // Revise: `scheduledFor (2026-10-21T00:00Z) <= now (2026-10-20T18:40Z)` was false, so A/C/H were hidden.
    expect(buckets.dueToday.map((r) => r.id)).toEqual(['A1', 'C1', 'H1']);
  });

  it('overdue keeps only the earliest pending cycle per item, with daysLate', () => {
    expect(buckets.overdue.map((r) => [r.id, r.daysLate])).toEqual([['B1', 5]]);
  });

  it('done today includes a completion at 00:05 IST, sorted by scheduledFor descending', () => {
    // Revise: `completedAt >= today label (05:30 IST)` dropped D1.
    expect(buckets.doneToday.map((r) => r.id)).toEqual(['I2', 'D1']);
  });

  it('groups today by subject in order of appearance, general for no subject', () => {
    expect(buckets.dueTodayBySubject.map((g) => [g.subjectId, g.revisions.map((r) => r.id)])).toEqual([
      ['s1', ['A1', 'H1']],
      ['general', ['C1']],
    ]);
  });

  it('totalDue = due today + overdue', () => {
    expect(buckets.totalDue).toBe(4);
  });

  it("'done today' is judged in the user's zone", () => {
    const r = done(makeChain('2026-10-19', { prefix: 'Z', topicId: 'tZ' }), 'Z1', new Date('2026-10-21T03:30:00Z'), IST);
    expect(buildRevisionBuckets(r, '2026-10-21', IST).doneToday.map((x) => x.id)).toEqual(['Z1']); // 09:00 IST
    expect(buildRevisionBuckets(r, '2026-10-21', NY).doneToday).toEqual([]); // 23:30 EDT on the 20th
  });

  it('an empty list means "all caught up"', () => {
    expect(buildRevisionBuckets([], '2026-10-21', IST)).toEqual({
      dueToday: [],
      dueTodayBySubject: [],
      overdue: [],
      doneToday: [],
      totalDue: 0,
    });
  });
});
