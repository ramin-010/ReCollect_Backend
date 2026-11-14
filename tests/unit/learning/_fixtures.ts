/** Shared builders for the learning-engine tests (not a test file itself). */
import {
  startRevisions,
  type DayString,
  type RevisionWithSubject,
  type ScheduleSlot,
  type TimeBlock,
} from '../../../src/services/learning';

export const IST = 'Asia/Kolkata';
export const NY = 'America/New_York';

/** An instant written as IST wall time (IST is a fixed +05:30). */
export const ist = (day: DayString, hhmm: string): Date => new Date(`${day}T${hhmm}:00+05:30`);

/** The four revisions of one item started on `startDay`, with ids `<prefix>1`..`<prefix>4`. */
export function makeChain(
  startDay: DayString,
  opts: { prefix?: string; topicId?: string | null; captureId?: string | null; subjectId?: string | null } = {},
): RevisionWithSubject[] {
  const prefix = opts.prefix ?? 'r';
  const topicId = opts.topicId === undefined ? 't1' : opts.topicId;
  const captureId = opts.captureId ?? null;
  return startRevisions(startDay).map((p) => ({
    id: `${prefix}${p.cycleNumber}`,
    topicId,
    captureId,
    subjectId: opts.subjectId === undefined ? 's1' : opts.subjectId,
    ...p,
  }));
}

/** cycleNumber → scheduledFor, for compact assertions. */
export const datesOf = (chain: ReadonlyArray<{ cycleNumber: number; scheduledFor: DayString }>): Record<number, DayString> =>
  Object.fromEntries([...chain].sort((a, b) => a.cycleNumber - b.cycleNumber).map((r) => [r.cycleNumber, r.scheduledFor]));

export function block(over: Partial<TimeBlock> & Pick<TimeBlock, 'id'>): TimeBlock {
  return {
    title: over.id,
    startTime: '09:00',
    endTime: '10:00',
    color: '#3b82f6',
    dayOfWeek: null,
    date: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

export function slot(over: Partial<ScheduleSlot> & Pick<ScheduleSlot, 'id' | 'date'>): ScheduleSlot {
  return {
    sourceBlockId: null,
    title: over.id,
    color: '#3b82f6',
    startTime: '09:00',
    endTime: '10:00',
    status: 'UPCOMING',
    actualStartTime: null,
    actualEndTime: null,
    remark: null,
    minutesDone: null,
    sortOrder: 0,
    ...over,
  };
}

/** Deep-freezes test input so any mutation by the code under test throws. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Date) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
