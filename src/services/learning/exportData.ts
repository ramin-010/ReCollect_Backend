/**
 * Assembles `MentorReportInput` from rows, i.e. the in-memory half of
 * revise/src/app/actions/export.actions.ts getAiExportData. The service
 * queries the rows for [from, to] and calls this, then `buildMentorPrompt`.
 *
 * Rules kept from Revise:
 *   - DailyScheduleSlot is the primary block source; a BlockSessionLog only
 *     adds a block for a (day, block) pair that has no slot (older history);
 *   - each day's blocks are sorted by start time;
 *   - a revision counts on the day it was completed (user zone) if that day
 *     is in range, with daysLate = completed day - scheduled day (negative =
 *     early); every pending revision is listed as pending, whatever its date;
 *   - one entry per calendar day in the range, gaps included.
 * Revisions' title/subject are resolved by the caller (Revise: topic title ||
 * capture title || first 40 chars of the capture || 'Untitled'; subject name
 * || 'General').
 */
import { LearningError } from './errors';
import type { ExportBlock, ExportDay, ExportRevision, MentorReportInput } from './mentorReport';
import { assertDay, dayOf, DEFAULT_TIMEZONE, diffDays, eachDay, weekdayName, type DayString } from './time';
import type { BlockLogStatus, DayDebrief, RevisionStatus, ScheduleSlot } from './types';

export interface ExportLogRow {
  timeBlockId: string;
  date: DayString;
  status: BlockLogStatus;
  remark: string | null;
  minutesDone: number | null;
  block: { title: string; startTime: string; endTime: string };
}

export interface ExportRevisionRow {
  title: string;
  subject: string;
  cycleNumber: number;
  scheduledFor: DayString;
  status: RevisionStatus;
  completedAt: Date | null;
}

export interface MentorReportSource {
  from: DayString;
  to: DayString;
  tz?: string;
  slots: readonly ScheduleSlot[];
  logs: readonly ExportLogRow[];
  debriefs: readonly DayDebrief[];
  revisions: readonly ExportRevisionRow[];
  habits: Array<{ name: string; currentStreak: number; longestStreak: number }>;
  /** Pass `effectiveStreak(...)`: Revise passed the stored, never-dropping number. */
  globalStreak: number;
}

export function buildMentorReportInput(source: MentorReportSource): MentorReportInput {
  const from = assertDay(source.from);
  const to = assertDay(source.to);
  if (from > to) throw new LearningError('INVALID_RANGE', 'Start date is after end date');
  const tz = source.tz ?? DEFAULT_TIMEZONE;
  const inRange = (day: DayString): boolean => day >= from && day <= to;

  const blocksByDay = new Map<DayString, ExportBlock[]>();
  const push = (day: DayString, block: ExportBlock): void => {
    const list = blocksByDay.get(day);
    if (list) list.push(block);
    else blocksByDay.set(day, [block]);
  };

  const slotKeys = new Set<string>();
  const slots = [...source.slots].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sortOrder - b.sortOrder));
  for (const s of slots) {
    if (!inRange(s.date)) continue;
    push(s.date, {
      title: s.title,
      startTime: s.startTime,
      endTime: s.endTime,
      status: s.status,
      remark: s.remark,
      minutesDone: s.minutesDone,
      actualStartTime: s.actualStartTime,
      actualEndTime: s.actualEndTime,
    });
    if (s.sourceBlockId) slotKeys.add(`${s.date}|${s.sourceBlockId}`);
  }

  for (const l of source.logs) {
    if (!inRange(l.date) || slotKeys.has(`${l.date}|${l.timeBlockId}`)) continue;
    push(l.date, {
      title: l.block.title,
      startTime: l.block.startTime,
      endTime: l.block.endTime,
      status: l.status,
      remark: l.remark,
      minutesDone: l.minutesDone,
      actualStartTime: null,
      actualEndTime: null,
    });
  }
  for (const list of blocksByDay.values()) list.sort((a, b) => a.startTime.localeCompare(b.startTime));

  const debriefByDay = new Map(source.debriefs.map((d) => [d.date, d]));

  const revisionsByDay = new Map<DayString, ExportRevision[]>();
  const pendingRevisions: ExportRevision[] = [];
  for (const r of source.revisions) {
    const base = { title: r.title, subject: r.subject, cycleNumber: r.cycleNumber, scheduledFor: r.scheduledFor };
    if (r.status === 'done' && r.completedAt) {
      const day = dayOf(r.completedAt, tz);
      if (!inRange(day)) continue;
      const list = revisionsByDay.get(day) ?? [];
      list.push({ ...base, completedOn: day, daysLate: diffDays(day, r.scheduledFor) });
      revisionsByDay.set(day, list);
    } else if (r.status === 'pending') {
      pendingRevisions.push({ ...base, completedOn: null, daysLate: null });
    }
  }

  const days: ExportDay[] = eachDay(from, to).map((date) => {
    const db = debriefByDay.get(date);
    return {
      date,
      weekday: weekdayName(date),
      blocks: blocksByDay.get(date) ?? [],
      revisionsCompleted: revisionsByDay.get(date) ?? [],
      debrief: db
        ? {
            energy: db.energy,
            focus: db.focus,
            mood: db.mood,
            tags: db.tags ?? [],
            narrative: db.narrative,
            tomorrowIntent: db.tomorrowIntent,
            freeWrite: db.freeWrite,
          }
        : null,
    };
  });

  return { from, to, days, pendingRevisions, habits: source.habits, globalStreak: source.globalStreak };
}
