/**
 * The morning nudge email (LOOP_V2_SPEC §7): when it is due and what its subject says. Pure; the
 * service (learningDb/nudge.service.ts) loads the plan and sends through the existing mailer.
 *
 * Tone (recollect/PRODUCT.md): calm, plain, the next small step. Never guilt.
 */
import { dayOf, isValidTime, minutesOfDay, timeToMinutes, type DayString } from './time';
import type { PlanMode } from './plan';

export const DEFAULT_NUDGE_TIME = '08:30';

export interface NudgeDueInput {
  now: Date;
  tz: string;
  /** 'HH:mm' local; anything invalid counts as the default 08:30. */
  nudgeTime: string;
  lastNudgeDay: DayString | null;
}

/** Due when the user's local time is at or past nudgeTime and nothing was sent on their today yet. */
export function isNudgeDue(input: NudgeDueInput): boolean {
  const today = dayOf(input.now, input.tz);
  if (input.lastNudgeDay === today) return false;
  const time = isValidTime(input.nudgeTime) ? input.nudgeTime : DEFAULT_NUDGE_TIME;
  return minutesOfDay(input.now, input.tz) >= timeToMinutes(time);
}

export interface NudgeSubjectInput {
  mode: PlanMode;
  plannedCount: number;
  estMinutes: number;
  waitingCount: number;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 *   "Today: 6 revisions · ~25 min"
 *   busy mode:    "Busy week: just 3 things today"
 *   nothing due:  "Nothing due today"
 *   (everything planned already done early: "Today's plan is done")
 */
export function nudgeSubject(input: NudgeSubjectInput): string {
  if (input.plannedCount === 0) return input.waitingCount === 0 ? 'Nothing due today' : "Today's plan is done";
  if (input.mode === 'busy') return `Busy week: just ${plural(input.plannedCount, 'thing')} today`;
  return `Today: ${plural(input.plannedCount, 'revision')} · ~${input.estMinutes} min`;
}

/**
 * Addresses under reserved, never-deliverable top-level domains (RFC 2606 / 6761: .local, .test,
 * .invalid, .example, .localhost), e.g. the local dev login dev@recollect.local. The nudge skips
 * them, so a dev server with real SMTP credentials never mails them every morning.
 */
export function isDeliverableEmail(email: string | null | undefined): email is string {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return false;
  const tld = email.slice(at + 1).toLowerCase().replace(/\.$/, '').split('.').pop() ?? '';
  return !['local', 'localhost', 'test', 'invalid', 'example'].includes(tld);
}
