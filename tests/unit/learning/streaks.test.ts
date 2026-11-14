import { describe, expect, it } from 'vitest';
import {
  applyCompletionToStreak,
  completeRevision,
  countDue,
  creditDay,
  EMPTY_STREAK,
  effectiveStreak,
  isCompletedOn,
  isStreakAlive,
  recordCompletionInHistory,
  revertCompletionInHistory,
  revokeCreditIfUnearned,
  settleStreak,
  streakEffectsOfCompletion,
  streakEffectsOfUncompletion,
  uncompleteRevision,
  type CompletionUndo,
  type RevisionWithSubject,
  type StreakState,
} from '../../../src/services/learning';
import { IST, ist, makeChain } from './_fixtures';

const streak = (current: number, longest: number, lastCreditDay: string | null): StreakState => ({
  current,
  longest,
  lastCreditDay,
  beforeLastCredit: null,
});

describe('crediting a day (revision.actions.ts completeRevision steps 4-5)', () => {
  it('first credit ever starts at 1 (global: no lastGlobalStreakUpdate; subject: lastCalculated = epoch)', () => {
    expect(creditDay(EMPTY_STREAK, '2026-10-21')).toMatchObject({ current: 1, longest: 1, lastCreditDay: '2026-10-21' });
  });

  it('consecutive day → +1; a gap → back to 1; longest is kept', () => {
    const s1 = creditDay(streak(4, 9, '2026-10-20'), '2026-10-21');
    expect(s1).toMatchObject({ current: 5, longest: 9, lastCreditDay: '2026-10-21' });
    const s2 = creditDay(streak(9, 9, '2026-10-20'), '2026-10-21');
    expect(s2).toMatchObject({ current: 10, longest: 10 });
    const s3 = creditDay(streak(4, 9, '2026-10-18'), '2026-10-21');
    expect(s3).toMatchObject({ current: 1, longest: 9, lastCreditDay: '2026-10-21' });
  });

  it('already credited today → unchanged (same object)', () => {
    const s = streak(5, 9, '2026-10-21');
    expect(creditDay(s, '2026-10-21')).toBe(s);
  });

  it('a credit day in the future (user moved to a zone behind) → unchanged', () => {
    const s = streak(5, 9, '2026-10-22');
    expect(creditDay(s, '2026-10-21')).toBe(s);
  });

  it('keeps a snapshot of what it replaced, for a same-day undo', () => {
    expect(creditDay(streak(4, 9, '2026-10-20'), '2026-10-21').beforeLastCredit).toEqual({
      current: 4,
      longest: 9,
      lastCreditDay: '2026-10-20',
    });
  });

  it('+1 only when nothing is left due after the completion', () => {
    const s = streak(4, 9, '2026-10-20');
    expect(applyCompletionToStreak(s, '2026-10-21', 2)).toBe(s);
    expect(applyCompletionToStreak(s, '2026-10-21', 0).current).toBe(5);
  });
});

describe('THE FIX: the streak drops after a missed day', () => {
  const stored = streak(7, 7, '2026-10-18'); // last cleared day: Sunday the 18th

  it('alive on the credit day and the day after (it can still be extended)', () => {
    expect(effectiveStreak(stored, '2026-10-18')).toBe(7);
    expect(effectiveStreak(stored, '2026-10-19')).toBe(7);
    expect(isStreakAlive(stored, '2026-10-19')).toBe(true);
  });

  it('0 once a whole day passed without credit, although Revise kept showing 7', () => {
    expect(stored.current).toBe(7); // the number Revise displayed until the next cleared day
    expect(effectiveStreak(stored, '2026-10-20')).toBe(0);
    expect(effectiveStreak(stored, '2026-11-30')).toBe(0);
    expect(isStreakAlive(stored, '2026-10-20')).toBe(false);
  });

  it('never credited → 0', () => {
    expect(effectiveStreak(EMPTY_STREAK, '2026-10-20')).toBe(0);
  });

  it('settleStreak writes the 0 back, keeps longest, and the next credit restarts at 1', () => {
    const settled = settleStreak(stored, '2026-10-20');
    expect(settled).toMatchObject({ current: 0, longest: 7, lastCreditDay: '2026-10-18' });
    expect(settleStreak(settled, '2026-10-21')).toBe(settled); // idempotent
    expect(settleStreak(stored, '2026-10-19')).toBe(stored); // still alive: untouched
    expect(creditDay(settled, '2026-10-21')).toMatchObject({ current: 1, longest: 7 });
  });

  it('a week of use: clear, clear, miss, clear', () => {
    let s: StreakState = EMPTY_STREAK;
    s = applyCompletionToStreak(s, '2026-10-19', 0);
    s = applyCompletionToStreak(s, '2026-10-20', 0);
    expect(effectiveStreak(s, '2026-10-21')).toBe(2); // the 21st is not over yet
    expect(effectiveStreak(s, '2026-10-22')).toBe(0); // the 21st was missed
    s = applyCompletionToStreak(s, '2026-10-22', 0);
    expect(s).toMatchObject({ current: 1, longest: 2, lastCreditDay: '2026-10-22' });
  });
});

describe('revokeCreditIfUnearned (undo support)', () => {
  const credited = creditDay(streak(4, 9, '2026-10-20'), '2026-10-21'); // 5, credited today

  it('takes back today\'s credit when something is due again', () => {
    expect(revokeCreditIfUnearned(credited, '2026-10-21', { completedToday: 1, pendingDue: 1 })).toEqual(streak(4, 9, '2026-10-20'));
  });

  it('takes it back when no completion is left today (an undone early revision)', () => {
    expect(revokeCreditIfUnearned(credited, '2026-10-21', { completedToday: 0, pendingDue: 0 }).current).toBe(4);
  });

  it('keeps it while it is still earned', () => {
    expect(revokeCreditIfUnearned(credited, '2026-10-21', { completedToday: 1, pendingDue: 0 })).toBe(credited);
  });

  it('never touches an earlier day\'s credit, or one without a snapshot', () => {
    expect(revokeCreditIfUnearned(credited, '2026-10-22', { completedToday: 0, pendingDue: 3 })).toBe(credited);
    const legacy = streak(5, 9, '2026-10-21');
    expect(revokeCreditIfUnearned(legacy, '2026-10-21', { completedToday: 0, pendingDue: 3 })).toBe(legacy);
  });

  it('restores longest too, when the credit had raised it', () => {
    const peak = creditDay(streak(9, 9, '2026-10-20'), '2026-10-21');
    expect(peak.longest).toBe(10);
    expect(revokeCreditIfUnearned(peak, '2026-10-21', { completedToday: 0, pendingDue: 0 })).toMatchObject({ current: 9, longest: 9 });
  });
});

describe('DailyHistory (completeRevision step 4)', () => {
  it('first completion of the day creates the row: due = pendingDue + 1, done = 1', () => {
    expect(recordCompletionInHistory(null, 's1', '2026-10-21', 2)).toEqual({
      subjectId: 's1',
      day: '2026-10-21',
      revisionsDue: 3,
      revisionsDone: 1,
      streakMaintained: false,
    });
  });

  it('later completions add 1 and re-evaluate streakMaintained (revisionsDue is not touched)', () => {
    const first = recordCompletionInHistory(null, 's1', '2026-10-21', 1);
    const second = recordCompletionInHistory(first, 's1', '2026-10-21', 0);
    expect(second).toMatchObject({ revisionsDue: 2, revisionsDone: 2, streakMaintained: true });
  });

  it("yesterday's row is never updated: a new row starts", () => {
    const yesterday = recordCompletionInHistory(null, 's1', '2026-10-20', 0);
    expect(recordCompletionInHistory(yesterday, 's1', '2026-10-21', 0)).toMatchObject({ day: '2026-10-21', revisionsDone: 1 });
  });

  it('revert removes one completion; the last one deletes the row (null)', () => {
    const two = recordCompletionInHistory(recordCompletionInHistory(null, 's1', '2026-10-21', 1), 's1', '2026-10-21', 0);
    const one = revertCompletionInHistory(two, 1);
    expect(one).toMatchObject({ revisionsDone: 1, streakMaintained: false });
    expect(revertCompletionInHistory(one!, 1)).toBeNull();
  });
});

describe('streakEffectsOfCompletion / streakEffectsOfUncompletion', () => {
  it('without a subject only the global streak is evaluated', () => {
    const fx = streakEffectsOfCompletion({ today: '2026-10-21', global: streak(1, 1, '2026-10-20'), pendingDueGlobal: 0 });
    expect(fx.global.current).toBe(2);
    expect(fx.subject).toBeUndefined();
  });

  it('the subject streak row is only created once the subject has nothing due', () => {
    const busy = streakEffectsOfCompletion({
      today: '2026-10-21',
      global: EMPTY_STREAK,
      pendingDueGlobal: 3,
      subject: { subjectId: 's1', streak: null, history: null, pendingDue: 1 },
    });
    expect(busy.global).toBe(EMPTY_STREAK);
    expect(busy.subject?.streak).toBeNull();
    expect(busy.subject?.history).toMatchObject({ revisionsDue: 2, revisionsDone: 1, streakMaintained: false });

    const clear = streakEffectsOfCompletion({
      today: '2026-10-21',
      global: EMPTY_STREAK,
      pendingDueGlobal: 3,
      subject: { subjectId: 's1', streak: null, history: null, pendingDue: 0 },
    });
    expect(clear.subject?.streak).toMatchObject({ current: 1, longest: 1, lastCreditDay: '2026-10-21' });
  });

  it('undoing a completion from an earlier day leaves streaks and history alone', () => {
    const global = creditDay(streak(4, 9, '2026-10-19'), '2026-10-20');
    const fx = streakEffectsOfUncompletion({
      today: '2026-10-21',
      completedDay: '2026-10-20',
      global,
      pendingDueGlobal: 5,
      completedTodayGlobal: 0,
    });
    expect(fx.global).toBe(global);
  });
});

describe('end to end: complete, undo, redo (revisions + streaks)', () => {
  const TODAY = '2026-10-21';
  const at = ist(TODAY, '09:00');

  // s1/A and s2/B each have cycle 1 due today; s1/C is not due yet.
  const initial: RevisionWithSubject[] = [
    ...makeChain('2026-10-20', { prefix: 'A', topicId: 'tA', subjectId: 's1' }),
    ...makeChain('2026-10-20', { prefix: 'B', topicId: 'tB', subjectId: 's2' }),
    ...makeChain('2026-10-21', { prefix: 'C', topicId: 'tC', subjectId: 's1' }),
  ];
  const initialGlobal = streak(4, 9, '2026-10-20');
  const initialS1 = streak(2, 2, '2026-10-20');

  interface World {
    revisions: RevisionWithSubject[];
    global: StreakState;
    subjects: Record<string, StreakState | null>;
    history: Record<string, ReturnType<typeof recordCompletionInHistory> | null>;
    undo: Record<string, CompletionUndo>;
  }

  const itemOf = (id: string) => id.charAt(0);
  const chainOf = (w: World, id: string) => w.revisions.filter((r) => r.id.charAt(0) === itemOf(id));
  const replaceChain = (w: World, id: string, chain: RevisionWithSubject[]) => [
    ...w.revisions.filter((r) => r.id.charAt(0) !== itemOf(id)),
    ...chain,
  ];
  const subjectOf = (w: World, id: string) => w.revisions.find((r) => r.id === id)!.subjectId!;
  const dueIn = (revs: RevisionWithSubject[], subjectId?: string) =>
    countDue(subjectId ? revs.filter((r) => r.subjectId === subjectId) : revs, TODAY);
  const doneToday = (revs: RevisionWithSubject[], subjectId?: string) =>
    (subjectId ? revs.filter((r) => r.subjectId === subjectId) : revs).filter((r) => isCompletedOn(r, TODAY, IST)).length;

  function complete(w: World, id: string): World {
    const res = completeRevision(chainOf(w, id), id, at, IST);
    const revisions = replaceChain(w, id, res.revisions);
    const subjectId = subjectOf(w, id);
    const fx = streakEffectsOfCompletion({
      today: res.completedDay,
      global: w.global,
      pendingDueGlobal: dueIn(revisions),
      subject: { subjectId, streak: w.subjects[subjectId] ?? null, history: w.history[subjectId] ?? null, pendingDue: dueIn(revisions, subjectId) },
    });
    return {
      revisions,
      global: fx.global,
      subjects: { ...w.subjects, [subjectId]: fx.subject!.streak },
      history: { ...w.history, [subjectId]: fx.subject!.history },
      undo: { ...w.undo, [id]: res.undo },
    };
  }

  function uncomplete(w: World, id: string): World {
    const res = uncompleteRevision(chainOf(w, id), id, w.undo[id] ?? null, IST);
    const revisions = replaceChain(w, id, res.revisions);
    const subjectId = subjectOf(w, id);
    const fx = streakEffectsOfUncompletion({
      today: TODAY,
      completedDay: res.completedDay,
      global: w.global,
      pendingDueGlobal: dueIn(revisions),
      completedTodayGlobal: doneToday(revisions),
      subject: {
        subjectId,
        streak: w.subjects[subjectId] ?? null,
        history: w.history[subjectId] ?? null,
        pendingDue: dueIn(revisions, subjectId),
        completedToday: doneToday(revisions, subjectId),
      },
    });
    const { [id]: _dropped, ...undo } = w.undo;
    return {
      revisions,
      global: fx.global,
      subjects: { ...w.subjects, [subjectId]: fx.subject!.streak },
      history: { ...w.history, [subjectId]: fx.subject!.history },
      undo,
    };
  }

  const start: World = { revisions: initial, global: initialGlobal, subjects: { s1: initialS1, s2: null }, history: {}, undo: {} };

  it('crediting follows "nothing left due" globally and per subject', () => {
    const w1 = complete(start, 'A1');
    expect(w1.global).toBe(initialGlobal); // B1 is still due
    expect(w1.subjects.s1).toMatchObject({ current: 3, longest: 3, lastCreditDay: TODAY }); // s1 is clear
    expect(w1.history.s1).toMatchObject({ revisionsDue: 1, revisionsDone: 1, streakMaintained: true });

    const w2 = complete(w1, 'B1');
    expect(w2.global).toMatchObject({ current: 5, longest: 9, lastCreditDay: TODAY });
    expect(w2.subjects.s2).toMatchObject({ current: 1, lastCreditDay: TODAY });
  });

  it('undoing the completion that cleared the day takes the global credit back', () => {
    const w = uncomplete(complete(complete(start, 'A1'), 'B1'), 'B1');
    expect(w.global).toEqual(initialGlobal);
    expect(w.subjects.s2).toMatchObject({ current: 0, longest: 0, lastCreditDay: null });
    expect(w.history.s2).toBeNull();
  });

  it('undoing an EARLIER completion also takes it back (the day is no longer clear)', () => {
    const w = uncomplete(complete(complete(start, 'A1'), 'B1'), 'A1');
    expect(w.global).toEqual(initialGlobal);
    expect(w.subjects.s1).toEqual(initialS1);
    expect(w.history.s1).toBeNull();
    expect(w.subjects.s2).toMatchObject({ current: 1 }); // s2 is still clear and done today
    // and the revisions themselves are back where they were
    expect(w.revisions.filter((r) => r.id.startsWith('A'))).toEqual(initial.filter((r) => r.id.startsWith('A')));
  });

  it('complete → undo everything → complete again ends in the same state', () => {
    const once = complete(complete(start, 'A1'), 'B1');
    const undone = uncomplete(uncomplete(once, 'B1'), 'A1');
    expect(undone.global).toEqual(initialGlobal);
    expect(undone.subjects.s1).toEqual(initialS1);
    const again = complete(complete(undone, 'A1'), 'B1');
    expect(again.global).toEqual(once.global);
    expect(again.subjects).toEqual(once.subjects);
    expect(again.history).toEqual(once.history);
    expect([...again.revisions].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...once.revisions].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
