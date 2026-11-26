/**
 * Plain domain types for the learning engine.
 *
 * They mirror Revise's Prisma models (revise/prisma/schema.prisma) closely so
 * the later Prisma services can map rows 1:1, with two systematic changes:
 *   - every "day label" column (Revision.scheduledFor, DailyScheduleSlot.date,
 *     BlockSessionLog.date, DayDebrief.date, DailyHistory.date, TimeBlock.date)
 *     is a `DayString` ('YYYY-MM-DD' in the user's time zone), e.g. a
 *     Postgres `date` column read with `dayFromUtcMidnight`;
 *   - real instants (completedAt, createdAt) stay `Date`.
 * A Revise "workspace" is scoped to the Kaaga *user*, so no type carries a
 * workspaceId; the service layer adds the owner.
 */
import type { DayString } from './time';

// ─────────────────────────────────────────────────────────────────────────────
// Revisions (spaced repetition)
// ─────────────────────────────────────────────────────────────────────────────

/** Revise stores a free string; 'missed' exists in the schema but nothing writes it. */
export type RevisionStatus = 'pending' | 'done' | 'missed';

/** One cycle of an item's revision chain (Revise model `Revision`). */
export interface Revision {
  id: string;
  /** Exactly one of topicId / captureId is set (Revise: topic revisions vs capture/quick-note revisions). */
  topicId: string | null;
  captureId: string | null;
  /** 1..4 */
  cycleNumber: number;
  /** 1, 3, 7 or 21: the cycle's interval, used for the cascading shifts. */
  intervalDays: number;
  /** The day it is due, in the user's time zone. */
  scheduledFor: DayString;
  completedAt: Date | null;
  status: RevisionStatus;
}

/** A revision plus the subject it belongs to (via its topic or capture), as the dashboard needs it. */
export interface RevisionWithSubject extends Revision {
  /** null for a capture without a subject (Revise shows those under "General"). */
  subjectId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaks
// ─────────────────────────────────────────────────────────────────────────────

/** The stored numbers of a streak (User.globalStreak/longestGlobalStreak/lastGlobalStreakUpdate, or SubjectStreak). */
export interface StreakSnapshot {
  current: number;
  longest: number;
  /** Last day the streak was credited; null if never (Revise: lastGlobalStreakUpdate null / lastCalculated epoch). */
  lastCreditDay: DayString | null;
}

/**
 * A streak plus the snapshot taken just before its most recent credit, so an
 * undo on the same day can take that credit back exactly. New field compared
 * with Revise (persist it as three nullable columns or one JSON column).
 */
export interface StreakState extends StreakSnapshot {
  beforeLastCredit: StreakSnapshot | null;
}

/** Revise model `DailyHistory`: one row per (user, subject, day) on which a revision was completed. */
export interface DailyHistoryEntry {
  subjectId: string;
  day: DayString;
  revisionsDue: number;
  revisionsDone: number;
  streakMaintained: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule (time blocks → daily slots)
// ─────────────────────────────────────────────────────────────────────────────

/** Workspace.routineMode: MASTER = one routine for every day, DAILY = one per weekday. */
export type RoutineMode = 'MASTER' | 'DAILY';

/** Revise enum SlotStatus. */
export type SlotStatus = 'UPCOMING' | 'ACTIVE' | 'COMPLETED' | 'SKIPPED' | 'PARTIAL';

/** Revise enum BlockStatus (a BlockSessionLog only ever holds a terminal state). */
export type BlockLogStatus = 'COMPLETED' | 'SKIPPED' | 'PARTIAL';

/** Revise model `TimeBlock`: a routine template, or a one-off when `date` is set. */
export interface TimeBlock {
  id: string;
  title: string;
  /** 'HH:mm' */
  startTime: string;
  /** 'HH:mm' */
  endTime: string;
  color: string;
  /** 0 = Monday ... 6 = Sunday for DAILY templates; null for MASTER templates and one-offs. */
  dayOfWeek: number | null;
  /** Set for a one-off block (e.g. from "shift / replace block"): it applies to this day only. */
  date: DayString | null;
  createdAt: Date;
}

/** Revise model `BlockSessionLog`: unique per (timeBlockId, date). */
export interface BlockSessionLog {
  timeBlockId: string;
  date: DayString;
  status: BlockLogStatus;
  remark: string | null;
  minutesDone: number | null;
}

/** Revise model `DailyScheduleSlot`: the mutable copy of a block for one day. Unique per (sourceBlockId, date). */
export interface ScheduleSlot {
  id: string;
  /** null for slots added by hand in the Day Manager. */
  sourceBlockId: string | null;
  date: DayString;
  title: string;
  color: string;
  startTime: string;
  endTime: string;
  status: SlotStatus;
  actualStartTime: string | null;
  actualEndTime: string | null;
  remark: string | null;
  minutesDone: number | null;
  sortOrder: number;
}

/** A slot to insert (the database assigns the id). */
export type NewScheduleSlot = Omit<ScheduleSlot, 'id'>;

// ─────────────────────────────────────────────────────────────────────────────
// Debrief
// ─────────────────────────────────────────────────────────────────────────────

/** Revise model `DayDebrief`: unique per (owner, date). */
export interface DayDebrief {
  date: DayString;
  // Layer 1: auto-context
  blocksPlanned: number;
  blocksCompleted: number;
  blocksSkipped: number;
  totalFocusedMin: number;
  // Layer 2: structured signals (1-5)
  energy: number | null;
  focus: number | null;
  mood: number | null;
  tags: string[];
  narrative: string | null;
  tomorrowIntent: string | null;
  // Layer 3: free write
  freeWrite: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Goals
// ─────────────────────────────────────────────────────────────────────────────

/** Revise enum GoalType on TASK captures (Kaaga todos later). */
export type GoalType = 'NONE' | 'WEEKLY' | 'MONTHLY';
