/**
 * Builds the mentor-analysis prompt from a period of logged data.
 *
 * Copied from revise/src/lib/export/mentorReport.ts nearly as-is. Changes:
 *   - `BlockStatusLike` is the shared `SlotStatus`; dates are `DayString`s;
 *   - array accesses are guarded for `noUncheckedIndexedAccess`, and
 *     `minutesBetween` destructures with NaN defaults (same results);
 *   - nothing else: the aggregation, the cause buckets and every line of the
 *     prompt are Revise's.
 *
 * Pure functions only — no Prisma, no server imports — so the formatting and
 * the arithmetic can be reasoned about (and run) without a database.
 *
 * Design notes, because they are the whole point of this file:
 *
 *  1. The aggregates are computed HERE, not left to the model. An LLM handed
 *     30 days of rows and asked for "trends" will pattern-match a vibe; handed
 *     "TypeScript 0/6, and here are the rows", it has to engage with a fact.
 *
 *  2. Recurring causes are clustered from remarks the user already writes.
 *     Per-day those read as noise. Grouped, "late at work x5" is a diagnosis.
 *
 *  3. The instruction block explicitly forbids encouragement-by-default.
 *     Asking for "insights and constructive feedback" reliably produces
 *     flattery; asking for a verdict with cited evidence does not.
 */
import type { DayString } from './time';
import type { SlotStatus } from './types';

export type BlockStatusLike = SlotStatus;

export interface ExportBlock {
  title: string;
  startTime: string;
  endTime: string;
  status: BlockStatusLike;
  remark: string | null;
  minutesDone: number | null;
  actualStartTime: string | null;
  actualEndTime: string | null;
}

export interface ExportDebrief {
  energy: number | null;
  focus: number | null;
  mood: number | null;
  tags: string[];
  narrative: string | null;
  tomorrowIntent: string | null;
  freeWrite: string | null;
}

export interface ExportRevision {
  title: string;
  subject: string;
  cycleNumber: number;
  scheduledFor: DayString;
  completedOn: DayString | null;
  daysLate: number | null;
}

export interface ExportDay {
  date: DayString; // YYYY-MM-DD in the user's zone
  weekday: string; // Mon..Sun
  blocks: ExportBlock[];
  debrief: ExportDebrief | null;
  revisionsCompleted: ExportRevision[];
}

export interface MentorReportInput {
  from: DayString;
  to: DayString;
  days: ExportDay[];
  /** Revisions still pending at export time (overdue or upcoming). */
  pendingRevisions: ExportRevision[];
  habits: Array<{ name: string; currentStreak: number; longestStreak: number }>;
  globalStreak: number;
}

// ── helpers ──────────────────────────────────────────────────────────

const TRIAGE_BOILERPLATE = /^skipped via triage$/i;

const isRealRemark = (r: string | null | undefined): r is string =>
  !!r && r.trim().length > 0 && !TRIAGE_BOILERPLATE.test(r.trim());

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));

const minutesBetween = (start: string, end: string): number => {
  const [sh = NaN, sm = NaN] = start.split(':').map(Number);
  const [eh = NaN, em = NaN] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some((v) => Number.isNaN(v))) return 0;
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60; // block crosses midnight
  return mins;
};

const avg = (xs: number[]): number | null =>
  xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;

const bar = (percent: number, width = 10): string => {
  const filled = Math.round((percent / 100) * width);
  return '#'.repeat(Math.max(0, filled)) + '.'.repeat(Math.max(0, width - filled));
};

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const padL = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

/**
 * Buckets for grouping free-text remarks into recurring causes. Ordered —
 * the first match wins, so more specific patterns come first.
 */
const CAUSE_BUCKETS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Work ran long / office',   pattern: /\b(late at work|at work|office|standup|deploy|meeting|client|work)\b/i },
  { label: 'On leave / travel',        pattern: /\b(on leave|leave|vacation|holiday|travel|trip|out of (town|station))\b/i },
  { label: 'Guests / family at home',  pattern: /\b(relative|guest|mom|dad|mummy|papa|massi|aunt|uncle|family|shopping|wedding|marriage|function)\b/i },
  { label: 'Sleep / fatigue',          pattern: /\b(sleep|slept|woke|overslept|tired|fatigue|exhaust|late night)\b/i },
  { label: 'Illness',                  pattern: /\b(sick|ill|fever|headache|unwell|pain|injur)\b/i },
  { label: 'Motivation / distraction', pattern: /\b(motivat|lazy|lazi|procrastinat|distract|mood|bored|scroll)\b/i },
  { label: 'Environment / infra',      pattern: /\b(environment|env\b|noise|noisy|light|internet|wifi|power|electricity)\b/i },
];

// ── aggregation ──────────────────────────────────────────────────────

interface BlockStat {
  title: string;
  planned: number;
  completed: number;
  skipped: number;
  partial: number;
  unresolved: number;
}

function aggregate(input: MentorReportInput) {
  const { days } = input;

  const daysWithAnyRecord = days.filter((d) => d.blocks.length > 0 || d.debrief);
  const daysWithNoRecord = days.filter((d) => d.blocks.length === 0 && !d.debrief);

  let planned = 0, completed = 0, skipped = 0, partial = 0, unresolved = 0;
  let plannedMin = 0, completedMin = 0;

  const byBlock = new Map<string, BlockStat>();
  const byWeekday = new Map<string, { planned: number; completed: number }>();

  for (const day of days) {
    for (const b of day.blocks) {
      planned++;
      const mins = minutesBetween(b.startTime, b.endTime);
      plannedMin += mins;

      if (b.status === 'COMPLETED') { completed++; completedMin += b.minutesDone ?? mins; }
      else if (b.status === 'PARTIAL') { partial++; completedMin += b.minutesDone ?? 0; }
      else if (b.status === 'SKIPPED') skipped++;
      else unresolved++;

      const bs = byBlock.get(b.title) ?? {
        title: b.title, planned: 0, completed: 0, skipped: 0, partial: 0, unresolved: 0,
      };
      bs.planned++;
      if (b.status === 'COMPLETED') bs.completed++;
      else if (b.status === 'PARTIAL') bs.partial++;
      else if (b.status === 'SKIPPED') bs.skipped++;
      else bs.unresolved++;
      byBlock.set(b.title, bs);

      const wd = byWeekday.get(day.weekday) ?? { planned: 0, completed: 0 };
      wd.planned++;
      if (b.status === 'COMPLETED') wd.completed++;
      byWeekday.set(day.weekday, wd);
    }
  }

  // Weekly buckets, oldest first, for direction-of-travel.
  const weeks: Array<{ label: string; planned: number; completed: number }> = [];
  for (let i = 0; i < days.length; i += 7) {
    const chunk = days.slice(i, i + 7);
    const p = chunk.reduce((a, d) => a + d.blocks.length, 0);
    const c = chunk.reduce(
      (a, d) => a + d.blocks.filter((b) => b.status === 'COMPLETED').length, 0
    );
    const firstDay = chunk[0];
    const lastDay = chunk[chunk.length - 1];
    if (p > 0 && firstDay && lastDay) {
      weeks.push({ label: `${firstDay.date} to ${lastDay.date}`, planned: p, completed: c });
    }
  }

  // Days where nothing at all got completed, and the longest such run.
  const zeroDays = daysWithAnyRecord.filter(
    (d) => d.blocks.length > 0 && d.blocks.every((b) => b.status !== 'COMPLETED' && b.status !== 'PARTIAL')
  );
  let longestZeroRun = 0, currentRun = 0;
  for (const d of days) {
    const hasWin = d.blocks.some((b) => b.status === 'COMPLETED' || b.status === 'PARTIAL');
    if (hasWin) currentRun = 0;
    else { currentRun++; longestZeroRun = Math.max(longestZeroRun, currentRun); }
  }

  // Revisions
  const completedRevisions = days.flatMap((d) => d.revisionsCompleted);
  const byCycle = new Map<number, number[]>();
  for (const r of completedRevisions) {
    if (r.daysLate === null) continue;
    byCycle.set(r.cycleNumber, [...(byCycle.get(r.cycleNumber) ?? []), r.daysLate]);
  }
  const bySubject = new Map<string, { done: number; lateSum: number; lateN: number }>();
  for (const r of completedRevisions) {
    const s = bySubject.get(r.subject) ?? { done: 0, lateSum: 0, lateN: 0 };
    s.done++;
    if (r.daysLate !== null) { s.lateSum += r.daysLate; s.lateN++; }
    bySubject.set(r.subject, s);
  }

  // Debriefs
  const debriefs = days.map((d) => d.debrief).filter(Boolean) as ExportDebrief[];
  const tagCounts = new Map<string, number>();
  for (const d of debriefs) for (const t of d.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);

  return {
    totalDays: days.length,
    daysWithAnyRecord: daysWithAnyRecord.length,
    daysWithNoRecord: daysWithNoRecord.length,
    daysWithNoRecordList: daysWithNoRecord.map((d) => d.date),
    planned, completed, skipped, partial, unresolved,
    plannedMin, completedMin,
    blockStats: [...byBlock.values()].sort(
      (a, b) => pct(a.completed, a.planned) - pct(b.completed, b.planned)
    ),
    weekdayStats: [...byWeekday.entries()],
    weeks,
    zeroDays: zeroDays.length,
    longestZeroRun,
    completedRevisions,
    revisionsByCycle: [...byCycle.entries()].sort((a, b) => a[0] - b[0]),
    revisionsBySubject: [...bySubject.entries()],
    debriefs,
    tagCounts: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]),
  };
}

/** Groups the user's own remarks into recurring causes, plus verbatim repeats. */
function clusterRemarks(days: ExportDay[]) {
  type CauseEntry = { count: number; blocks: Map<string, number>; samples: string[] };
  const buckets = new Map<string, CauseEntry>();
  const verbatim = new Map<string, { count: number; text: string }>();
  let uncategorised = 0;

  for (const day of days) {
    for (const b of day.blocks) {
      if (!isRealRemark(b.remark)) continue;
      const text = b.remark.trim().replace(/\s+/g, ' ');

      const key = text.toLowerCase();
      const v = verbatim.get(key) ?? { count: 0, text };
      v.count++;
      verbatim.set(key, v);

      const bucket = CAUSE_BUCKETS.find((c) => c.pattern.test(text));
      if (!bucket) { uncategorised++; continue; }

      const entry: CauseEntry =
        buckets.get(bucket.label) ?? { count: 0, blocks: new Map<string, number>(), samples: [] };
      entry.count++;
      entry.blocks.set(b.title, (entry.blocks.get(b.title) ?? 0) + 1);
      if (entry.samples.length < 3 && !entry.samples.includes(text)) entry.samples.push(text);
      buckets.set(bucket.label, entry);
    }
  }

  return {
    buckets: [...buckets.entries()].sort((a, b) => b[1].count - a[1].count),
    repeated: [...verbatim.values()].filter((v) => v.count > 1).sort((a, b) => b.count - a.count),
    uncategorised,
  };
}

// ── the report ───────────────────────────────────────────────────────

export function buildMentorPrompt(input: MentorReportInput): string {
  const s = aggregate(input);
  const causes = clusterRemarks(input.days);
  const out: string[] = [];
  const L = (line = '') => out.push(line);
  const RULE = '='.repeat(64);

  // ── Instructions first: role and constraints before evidence ──
  L('# YOUR ROLE');
  L();
  L('You are my performance mentor. I built the system that produced this data');
  L('and I am using your answer to decide what to change, so accuracy matters');
  L('more than my feelings.');
  L();
  L('Rules:');
  L('- Be blunt. Do not open with praise or soften conclusions to be kind.');
  L('- Cite evidence. Every claim must reference a specific date, block name,');
  L('  or number from below. No generic productivity advice.');
  L('- If the data says I am not working hard, say exactly that and show why.');
  L('- If the data is too thin to support a conclusion, say so instead of guessing.');
  L('- Distinguish what I DID from what I FELT. Both are below and they may disagree.');
  L('- Prefer deleting commitments over adding them. I do not need a new system.');
  L();
  L(`Period analysed: ${input.from} to ${input.to} (${s.totalDays} days)`);
  L();

  // ── Scorecard ──
  L(RULE);
  L('# SCORECARD');
  L(RULE);
  L();
  L(`Days with any record      ${s.daysWithAnyRecord}/${s.totalDays}  (${pct(s.daysWithAnyRecord, s.totalDays)}%)`);
  if (s.daysWithNoRecord > 0) {
    L(`Days with NO record       ${s.daysWithNoRecord}   <- app not opened / nothing logged`);
    L(`                          ${s.daysWithNoRecordList.slice(0, 12).join(', ')}${s.daysWithNoRecordList.length > 12 ? ', ...' : ''}`);
  }
  L();
  L(`Blocks scheduled          ${s.planned}`);
  L(`  completed               ${s.completed}  (${pct(s.completed, s.planned)}%)`);
  if (s.partial > 0) L(`  partial                 ${s.partial}`);
  L(`  skipped                 ${s.skipped}  (${pct(s.skipped, s.planned)}%)`);
  if (s.unresolved > 0) {
    L(`  never resolved          ${s.unresolved}  <- scheduled, never marked either way`);
  }
  L();
  L(`Time scheduled            ${Math.round(s.plannedMin / 60)}h`);
  L(`Time recorded as done     ${Math.round(s.completedMin / 60)}h  (${pct(s.completedMin, s.plannedMin)}% of plan)`);
  L();
  L(`Days with zero completed  ${s.zeroDays}`);
  L(`Longest such run          ${s.longestZeroRun} day(s)`);
  L(`Current global streak     ${input.globalStreak}`);
  L();

  const firstWeek = s.weeks[0];
  const lastWeek = s.weeks[s.weeks.length - 1];
  if (s.weeks.length > 1 && firstWeek && lastWeek) {
    L('Direction of travel (block completion by week, oldest first):');
    for (const w of s.weeks) {
      const p = pct(w.completed, w.planned);
      L(`  ${w.label}   ${bar(p)}  ${padL(String(p), 3)}%   (${w.completed}/${w.planned})`);
    }
    const first = pct(firstWeek.completed, firstWeek.planned);
    const last = pct(lastWeek.completed, lastWeek.planned);
    const delta = last - first;
    L();
    L(`  Net change: ${delta > 0 ? '+' : ''}${delta} points ` +
      `(${delta > 4 ? 'IMPROVING' : delta < -4 ? 'DECLINING' : 'FLAT'})`);
    L();
  }

  // ── Per block ──
  L(RULE);
  L('# BLOCK-LEVEL PERFORMANCE  (worst first)');
  L(RULE);
  L();
  L(`  ${pad('BLOCK', 26)} ${pad('RATE', 12)} DONE/PLANNED   SKIPPED`);
  for (const b of s.blockStats) {
    const p = pct(b.completed, b.planned);
    const flag = b.completed === 0 && b.planned >= 3 ? '   <- NEVER ONCE COMPLETED' : '';
    L(`  ${pad(b.title, 26)} ${pad(bar(p), 12)} ${padL(`${b.completed}/${b.planned}`, 7)} ${padL(`${p}%`, 5)}  ${padL(String(b.skipped), 3)}${flag}`);
  }
  L();

  if (s.weekdayStats.length > 0) {
    const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    L('By weekday:');
    for (const wd of order) {
      const st = s.weekdayStats.find(([k]) => k === wd);
      if (!st) continue;
      const p = pct(st[1].completed, st[1].planned);
      L(`  ${wd}  ${bar(p)}  ${padL(String(p), 3)}%   (${st[1].completed}/${st[1].planned})`);
    }
    L();
  }

  // ── Causes ──
  L(RULE);
  L('# RECURRING CAUSES  (clustered from my own notes, not inferred)');
  L(RULE);
  L();
  if (causes.buckets.length === 0) {
    L('  No categorised remarks in this period.');
  } else {
    for (const [label, data] of causes.buckets) {
      const topBlocks = [...data.blocks.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([t, n]) => `${t} x${n}`).join(', ');
      L(`  ${label} — ${data.count} occurrence(s)`);
      L(`     hits: ${topBlocks}`);
      for (const sample of data.samples) L(`     "${sample.slice(0, 110)}"`);
      L();
    }
  }
  if (causes.repeated.length > 0) {
    L('  Reasons I wrote more than once (verbatim):');
    for (const r of causes.repeated.slice(0, 8)) {
      L(`     x${r.count}  "${r.text.slice(0, 100)}"`);
    }
    L();
  }

  // ── Spaced repetition ──
  L(RULE);
  L('# SPACED REPETITION  (the learning system, separate from the schedule)');
  L(RULE);
  L();
  L(`Revisions completed in period   ${s.completedRevisions.length}`);
  L(`Still pending at export time    ${input.pendingRevisions.length}`);
  const overdue = input.pendingRevisions.filter((r) => r.scheduledFor < input.to);
  L(`  of which already overdue      ${overdue.length}`);
  L();
  if (s.revisionsByCycle.length > 0) {
    L('Lateness by cycle (days between scheduled date and completion):');
    for (const [cycle, lates] of s.revisionsByCycle) {
      const a = avg(lates);
      L(`  Cycle ${cycle}   n=${padL(String(lates.length), 3)}   avg ${a === null ? 'n/a' : `${a} day(s) late`}`);
    }
    L();
    L('  (Cycle 1 is first contact after creating a topic. If cycle 1 is the');
    L('   latest, the bottleneck is starting, not retaining.)');
    L();
  }
  if (s.revisionsBySubject.length > 0) {
    L('By subject:');
    for (const [subject, st] of s.revisionsBySubject) {
      const a = st.lateN > 0 ? Math.round((st.lateSum / st.lateN) * 10) / 10 : null;
      L(`  ${pad(subject, 24)} ${padL(String(st.done), 3)} done   avg ${a === null ? 'n/a' : `${a}d late`}`);
    }
    L();
  }

  // ── Self report ──
  L(RULE);
  L('# SELF-REPORT  (what I said about myself)');
  L(RULE);
  L();
  L(`Debriefs filled   ${s.debriefs.length}/${s.totalDays} days (${pct(s.debriefs.length, s.totalDays)}%)`);
  const e = avg(s.debriefs.map((d) => d.energy).filter((x): x is number => x != null));
  const f = avg(s.debriefs.map((d) => d.focus).filter((x): x is number => x != null));
  const m = avg(s.debriefs.map((d) => d.mood).filter((x): x is number => x != null));
  L(`Energy  ${e ?? 'n/a'}/5     Focus  ${f ?? 'n/a'}/5     Mood  ${m ?? 'n/a'}/5`);
  L();
  if (s.tagCounts.length > 0) {
    L('Context tags by frequency:');
    for (const [tag, n] of s.tagCounts) L(`  ${padL(`x${n}`, 4)}  ${tag}`);
    L();
  }
  if (input.habits.length > 0) {
    L('Habits:');
    for (const h of input.habits) {
      L(`  ${pad(h.name, 24)} current ${h.currentStreak}, longest ${h.longestStreak}`);
    }
    L();
  }

  // ── Raw daily log ──
  L(RULE);
  L('# DAILY LOG  (raw evidence — verify the numbers above against this)');
  L(RULE);
  L();
  for (const day of input.days) {
    if (day.blocks.length === 0 && !day.debrief && day.revisionsCompleted.length === 0) {
      L(`${day.date} ${day.weekday}  — no record`);
      continue;
    }
    L(`${day.date} ${day.weekday}`);
    for (const b of day.blocks) {
      const times = b.actualStartTime
        ? `${b.startTime}-${b.endTime} (actual ${b.actualStartTime}-${b.actualEndTime ?? '?'})`
        : `${b.startTime}-${b.endTime}`;
      let line = `   [${pad(b.status, 9)}] ${pad(b.title, 24)} ${times}`;
      if (b.minutesDone != null) line += ` | ${b.minutesDone}min`;
      if (isRealRemark(b.remark)) line += ` | "${b.remark.trim().replace(/\s+/g, ' ')}"`;
      L(line);
    }
    for (const r of day.revisionsCompleted) {
      L(`   [REVISION ] ${r.subject} / ${r.title} cycle ${r.cycleNumber}` +
        (r.daysLate != null && r.daysLate !== 0 ? ` (${r.daysLate > 0 ? `${r.daysLate}d late` : `${-r.daysLate}d early`})` : ''));
    }
    if (day.debrief) {
      const d = day.debrief;
      const parts: string[] = [];
      if (d.energy != null) parts.push(`energy ${d.energy}`);
      if (d.focus != null) parts.push(`focus ${d.focus}`);
      if (d.mood != null) parts.push(`mood ${d.mood}`);
      if (d.tags.length) parts.push(`tags: ${d.tags.join(', ')}`);
      if (parts.length) L(`   [DEBRIEF  ] ${parts.join(' | ')}`);
      if (d.narrative) L(`   [NARRATIVE] ${d.narrative.replace(/\s+/g, ' ')}`);
      if (d.tomorrowIntent) L(`   [INTENT   ] ${d.tomorrowIntent.replace(/\s+/g, ' ')}`);
      if (d.freeWrite) L(`   [FREEWRITE] ${d.freeWrite.replace(/\s+/g, ' ')}`);
    }
    L();
  }

  // ── The ask, last, where it stays salient ──
  L(RULE);
  L('# WHAT I NEED FROM YOU');
  L(RULE);
  L();
  L('Answer these directly, in order, citing the data:');
  L();
  L('1. VERDICT. Am I working hard, or am I busy scheduling work? One paragraph.');
  L('   Give me a number out of 10 for actual effort and justify it.');
  L();
  L('2. THE SCHEDULE IS A HYPOTHESIS. Which blocks should I DELETE outright?');
  L('   A block I have never once completed is not a discipline problem, it is a');
  L('   bad plan. Name them and say what to replace them with, if anything.');
  L();
  L('3. ROOT CAUSE. Look at the recurring causes section. Which single cause,');
  L('   if I solved it, would recover the most blocks? Is it actually solvable,');
  L('   or is it a fixed constraint I should design around instead?');
  L();
  L('4. SELF-REPORT VS REALITY. Where do my energy/focus/mood ratings disagree');
  L('   with what I actually completed? Am I over- or under-rating myself?');
  L();
  L('5. THE LIE. What is the one thing this data says that I am most likely');
  L('   telling myself is not true?');
  L();
  L('6. NEXT WEEK. Exactly three changes, ranked. Each must be concrete enough');
  L('   to verify from this same data next week. No vague advice.');
  L();

  return out.join('\n');
}
