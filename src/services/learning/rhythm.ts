/**
 * Rhythm (LOOP_V2_SPEC §5): a gentle weekly view of consistency that replaces the streak in the
 * UI. A day is ACTIVE when at least one revision was completed on it (user zone) or a focus item
 * of that day was done. Nothing breaks, nothing resets: it is just the last 7 days.
 */
import { addDays, assertDay, dayOf, DEFAULT_TIMEZONE, type DayString } from './time';

export const RHYTHM_DAYS = 7;

export interface RhythmDay {
  day: DayString;
  active: boolean;
}

export interface Rhythm {
  /** today − 6 … today, oldest first. */
  last7: RhythmDay[];
  /** How many of those days are active. */
  activeDays: number;
}

export interface RhythmInput {
  today: DayString;
  tz?: string;
  /** completedAt of revisions that are done (any range; only the last 7 days count). */
  completions?: readonly Date[];
  /** The `day` of focus items that are done. */
  focusDoneDays?: readonly DayString[];
}

/** The first day of the rhythm window (today − 6). */
export function rhythmStart(today: DayString): DayString {
  return addDays(today, -(RHYTHM_DAYS - 1));
}

export function rhythmLast7(input: RhythmInput): Rhythm {
  const { today } = input;
  assertDay(today);
  const tz = input.tz ?? DEFAULT_TIMEZONE;
  const active = new Set<DayString>();
  for (const at of input.completions ?? []) active.add(dayOf(at, tz));
  for (const day of input.focusDoneDays ?? []) active.add(day);

  const last7: RhythmDay[] = [];
  for (let i = RHYTHM_DAYS - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    last7.push({ day, active: active.has(day) });
  }
  return { last7, activeDays: last7.filter((d) => d.active).length };
}
