/**
 * Learning engine: the pure domain logic of Revise's dashboard, ported for
 * Recollect (no database, no Express, no React). See each module's header for
 * the Revise source it mirrors and the bugs it fixes.
 *
 *   time          per-user time-zone days, 'HH:mm' helpers
 *   revisions     start / complete / uncomplete / reschedule, due lists
 *   streaks       global + subject streaks, DailyHistory
 *   schedule      slots from time blocks, backfill, triage, catch-up, adherence
 *   dayManager    the Day Manager's recalculate and handlers
 *   debrief       debrief stats and save plan
 *   goals         weekly / monthly goal due days (todos: "This week" / "This month")
 *   mentorReport  the AI mentor prompt (+ exportData to assemble its input)
 *
 * Daily loop v2 (LOOP_V2_SPEC):
 *   plan          today's budgeted plan, busy / comeback modes, the fresh start
 *   goalForecast  goals with a deadline: pace, projection, status, suggestion
 *   rhythm        the last 7 days, active or not
 *   nudge         the morning email: when it is due, its subject line
 */
export * from './errors';
export * from './types';
export * from './time';
export * from './revisions';
export * from './streaks';
export * from './schedule';
export * from './dayManager';
export * from './debrief';
export * from './goals';
export * from './mentorReport';
export * from './exportData';
export * from './plan';
export * from './goalForecast';
export * from './rhythm';
export * from './nudge';
