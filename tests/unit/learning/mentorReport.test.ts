import { describe, expect, it } from 'vitest';
import {
  buildMentorPrompt,
  buildMentorReportInput,
  eachDay,
  weekdayName,
  type ExportBlock,
  type ExportDay,
  type MentorReportInput,
} from '../../../src/services/learning';
import { IST, NY, slot } from './_fixtures';

// Source: revise/src/lib/export/mentorReport.ts (copied nearly as-is) and the
// in-memory half of revise/src/app/actions/export.actions.ts getAiExportData.

const blk = (title: string, startTime: string, endTime: string, status: ExportBlock['status'], over: Partial<ExportBlock> = {}): ExportBlock => ({
  title,
  startTime,
  endTime,
  status,
  remark: null,
  minutesDone: null,
  actualStartTime: null,
  actualEndTime: null,
  ...over,
});

/** 14 days, 2026-10-05 (Mon) .. 2026-10-18 (Sun). */
function sampleInput(): MentorReportInput {
  const days: ExportDay[] = eachDay('2026-10-05', '2026-10-18').map((date) => ({
    date,
    weekday: weekdayName(date),
    blocks: [],
    debrief: null,
    revisionsCompleted: [],
  }));
  const dayOf = (date: string) => days.find((d) => d.date === date)!;

  for (const date of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']) {
    dayOf(date).blocks.push(
      blk('Deep Work', '09:00', '11:00', 'COMPLETED'),
      blk('TypeScript', '20:00', '21:00', 'SKIPPED', { remark: 'late at work' }),
    );
  }
  const week2Remarks = ['Skipped via triage', 'office meeting ran long', null, null, null];
  ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'].forEach((date, i) => {
    dayOf(date).blocks.push(
      blk('Deep Work', '09:00', '11:00', 'COMPLETED'),
      blk('TypeScript', '20:00', '21:00', 'SKIPPED', { remark: week2Remarks[i] ?? null }),
    );
  });
  dayOf('2026-10-14').blocks.unshift(blk('Gym', '07:00', '08:00', 'PARTIAL', { minutesDone: 30 }));
  dayOf('2026-10-17').debrief = {
    energy: 2, focus: 3, mood: 4, tags: ['Tired'], narrative: 'slow  day', tomorrowIntent: null, freeWrite: null,
  };
  dayOf('2026-10-14').revisionsCompleted.push({
    title: 'Graphs', subject: 'DSA', cycleNumber: 2, scheduledFor: '2026-10-12', completedOn: '2026-10-14', daysLate: 2,
  });
  dayOf('2026-10-12').revisionsCompleted.push({
    title: 'Trees', subject: 'DSA', cycleNumber: 1, scheduledFor: '2026-10-13', completedOn: '2026-10-12', daysLate: -1,
  });

  return {
    from: '2026-10-05',
    to: '2026-10-18',
    days,
    pendingRevisions: [
      { title: 'Heaps', subject: 'DSA', cycleNumber: 1, scheduledFor: '2026-10-15', completedOn: null, daysLate: null },
      { title: 'Tries', subject: 'DSA', cycleNumber: 1, scheduledFor: '2026-10-25', completedOn: null, daysLate: null },
    ],
    habits: [{ name: 'Meditate', currentStreak: 3, longestStreak: 10 }],
    globalStreak: 4,
  };
}

describe('buildMentorPrompt (mentorReport.ts)', () => {
  const prompt = buildMentorPrompt(sampleInput());
  const lines = prompt.split('\n');

  it('starts with the role, ends with the ask', () => {
    expect(lines[0]).toBe('# YOUR ROLE');
    expect(prompt).toContain('Period analysed: 2026-10-05 to 2026-10-18 (14 days)');
    expect(lines[lines.length - 2]).toBe('   to verify from this same data next week. No vague advice.');
  });

  it('scorecard numbers are computed, not left to the model', () => {
    expect(lines).toContain('Days with any record      11/14  (79%)');
    expect(lines).toContain('Days with NO record       3   <- app not opened / nothing logged');
    expect(lines).toContain(`${' '.repeat(26)}2026-10-10, 2026-10-11, 2026-10-18`);
    expect(lines).toContain('Blocks scheduled          21');
    expect(lines).toContain('  completed               10  (48%)');
    expect(lines).toContain('  partial                 1');
    expect(lines).toContain('  skipped                 10  (48%)');
    expect(prompt).not.toContain('never resolved');
    expect(lines).toContain('Time scheduled            31h');
    expect(lines).toContain('Time recorded as done     21h  (66% of plan)');
    expect(lines).toContain('Days with zero completed  0');
    expect(lines).toContain('Longest such run          2 day(s)');
    expect(lines).toContain('Current global streak     4');
  });

  it('direction of travel by week', () => {
    expect(lines).toContain('  2026-10-05 to 2026-10-11   #####.....   50%   (5/10)');
    expect(lines).toContain('  2026-10-12 to 2026-10-18   #####.....   45%   (5/11)');
    expect(lines).toContain('  Net change: -5 points (DECLINING)');
  });

  it('flags a block never once completed, and clusters the remarks into causes', () => {
    expect(prompt).toMatch(/TypeScript\s+\.{10}\s+0\/10\s+0%\s+10 {3}<- NEVER ONCE COMPLETED/);
    expect(lines).toContain('  Work ran long / office — 6 occurrence(s)');
    expect(lines).toContain('     hits: TypeScript x6');
    expect(lines).toContain('     x5  "late at work"');
    expect(prompt).not.toMatch(/Skipped via triage/i); // boilerplate remarks are ignored
  });

  it('spaced repetition: lateness by cycle and subject, overdue pending', () => {
    expect(lines).toContain('Revisions completed in period   2');
    expect(lines).toContain('Still pending at export time    2');
    expect(lines).toContain('  of which already overdue      1');
    expect(lines).toContain('  Cycle 1   n=  1   avg -1 day(s) late');
    expect(lines).toContain('  Cycle 2   n=  1   avg 2 day(s) late');
    expect(prompt).toMatch(/ {2}DSA\s+2 done {3}avg 0\.5d late/);
  });

  it('self-report and the raw daily log', () => {
    expect(lines).toContain('Debriefs filled   1/14 days (7%)');
    expect(lines).toContain('Energy  2/5     Focus  3/5     Mood  4/5');
    expect(lines).toContain('    x1  Tired');
    expect(prompt).toMatch(/ {2}Meditate\s+current 3, longest 10/);
    expect(lines).toContain('2026-10-10 Sat  — no record');
    expect(lines).toContain('   [REVISION ] DSA / Graphs cycle 2 (2d late)');
    expect(lines).toContain('   [REVISION ] DSA / Trees cycle 1 (1d early)');
    expect(lines).toContain('   [DEBRIEF  ] energy 2 | focus 3 | mood 4 | tags: Tired');
    expect(lines).toContain('   [NARRATIVE] slow day');
    expect(lines).toContain(`   [PARTIAL  ] ${'Gym'.padEnd(24)} 07:00-08:00 | 30min`);
  });

  it('a flat or improving trend', () => {
    const input = sampleInput();
    for (const d of input.days.slice(7)) d.blocks = d.blocks.map((b) => ({ ...b, status: 'COMPLETED' as const }));
    expect(buildMentorPrompt(input)).toContain('  Net change: +50 points (IMPROVING)');
  });
});

describe('buildMentorReportInput (export.actions.ts getAiExportData, in memory)', () => {
  const base = {
    from: '2026-10-19',
    to: '2026-10-20',
    tz: IST,
    habits: [],
    globalStreak: 0,
  };

  it('slots first; a session log only adds a block no slot covers; sorted by start time', () => {
    const input = buildMentorReportInput({
      ...base,
      slots: [
        slot({ id: 's1', date: '2026-10-19', sourceBlockId: 'deep', title: 'Deep Work', startTime: '09:00', endTime: '11:00', status: 'COMPLETED' }),
        slot({ id: 's2', date: '2026-10-25', sourceBlockId: 'deep', title: 'out of range' }),
      ],
      logs: [
        { timeBlockId: 'deep', date: '2026-10-19', status: 'SKIPPED', remark: 'dup', minutesDone: null, block: { title: 'Deep Work', startTime: '09:00', endTime: '11:00' } },
        { timeBlockId: 'gym', date: '2026-10-19', status: 'COMPLETED', remark: null, minutesDone: 40, block: { title: 'Gym', startTime: '07:00', endTime: '08:00' } },
        { timeBlockId: 'gym', date: '2026-10-20', status: 'SKIPPED', remark: 'rain', minutesDone: null, block: { title: 'Gym', startTime: '07:00', endTime: '08:00' } },
      ],
      debriefs: [],
      revisions: [],
    });
    expect(input.days.map((d) => [d.date, d.weekday, d.blocks.map((b) => `${b.title}:${b.status}`)])).toEqual([
      ['2026-10-19', 'Mon', ['Gym:COMPLETED', 'Deep Work:COMPLETED']],
      ['2026-10-20', 'Tue', ['Gym:SKIPPED']],
    ]);
    expect(input.days[0]?.blocks[0]).toMatchObject({ minutesDone: 40, actualStartTime: null, actualEndTime: null });
  });

  it("revisions count on the user-local completion day; daysLate may be negative; pending listed", () => {
    const revisions = [
      { title: 'Graphs', subject: 'DSA', cycleNumber: 2, scheduledFor: '2026-10-18', status: 'done' as const, completedAt: new Date('2026-10-20T20:00:00Z') },
      { title: 'Trees', subject: 'DSA', cycleNumber: 1, scheduledFor: '2026-10-21', status: 'done' as const, completedAt: new Date('2026-10-19T06:00:00Z') },
      { title: 'Heaps', subject: 'DSA', cycleNumber: 1, scheduledFor: '2026-11-01', status: 'pending' as const, completedAt: null },
      { title: 'Ghost', subject: 'DSA', cycleNumber: 1, scheduledFor: '2026-10-19', status: 'missed' as const, completedAt: null },
    ];
    const ist = buildMentorReportInput({ ...base, slots: [], logs: [], debriefs: [], revisions });
    // 2026-10-20T20:00Z is 01:30 on the 21st in IST: outside the range.
    expect(ist.days.flatMap((d) => d.revisionsCompleted.map((r) => [d.date, r.title, r.daysLate]))).toEqual([['2026-10-19', 'Trees', -2]]);
    expect(ist.pendingRevisions.map((r) => r.title)).toEqual(['Heaps']);
    const ny = buildMentorReportInput({ ...base, tz: NY, slots: [], logs: [], debriefs: [], revisions });
    expect(ny.days.flatMap((d) => d.revisionsCompleted.map((r) => [d.date, r.title, r.daysLate]))).toEqual([
      ['2026-10-19', 'Trees', -2],
      ['2026-10-20', 'Graphs', 2],
    ]);
  });

  it('debriefs by day, gaps included, and the range is validated', () => {
    const input = buildMentorReportInput({
      ...base,
      slots: [],
      logs: [],
      debriefs: [
        {
          date: '2026-10-20', blocksPlanned: 0, blocksCompleted: 0, blocksSkipped: 0, totalFocusedMin: 0,
          energy: 3, focus: 3, mood: 3, tags: ['Sick'], narrative: 'n', tomorrowIntent: 't', freeWrite: null,
        },
      ],
      revisions: [],
    });
    expect(input.days[0]?.debrief).toBeNull();
    expect(input.days[1]?.debrief).toEqual({ energy: 3, focus: 3, mood: 3, tags: ['Sick'], narrative: 'n', tomorrowIntent: 't', freeWrite: null });
    expect(buildMentorPrompt(input)).toContain('Period analysed: 2026-10-19 to 2026-10-20 (2 days)');
    expect(() => buildMentorReportInput({ ...base, from: '2026-10-21', slots: [], logs: [], debriefs: [], revisions: [] })).toThrow(
      expect.objectContaining({ code: 'INVALID_RANGE' }),
    );
  });
});
