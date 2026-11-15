// The coach's numbers are checked (LOOP_COMPLETE_SPEC 1.7, ECOSYSTEM_PLAN rule 3: code computes,
// models write). Every number in the model's note must be one the evidence holds; a note that fails
// is replaced by a plain one written here from the same facts, with no second call.
import type { CoachEvidence } from './evidence';
import type { CoachOutput } from './output';

/** Numbers a note may always use: the window's length. */
const ALWAYS = new Set(['7']);

/** Every number written with digits ("4", "0.5", "1,200"), as plain text. */
export function numbersIn(text: string): string[] {
    return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(/,(?=\d{3}\b)/g, '').replace(/^0+(?=\d)/, ''));
}

/** The numbers in the note that the evidence does not hold (empty: the note passes). */
export function unsupportedNumbers(output: CoachOutput, evidence: CoachEvidence): string[] {
    const allowed = new Set([...ALWAYS, ...numbersIn(JSON.stringify(evidence))]);
    const written = [...Object.values(output.lines), ...output.focus].flatMap(numbersIn);
    return [...new Set(written.filter((n) => !allowed.has(n)))];
}

const formatPlainMinutes = (m: number): string => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** A note written by code from the evidence alone: plain, short, never scolding. */
export function plainCoachNote(e: CoachEvidence): CoachOutput {
    const r = e.revisions;
    const rec = e.record;
    const minutes = rec ? Object.values(rec.minutes).reduce((a, b) => a + b, 0) : 0;
    const strongParts = [
        r.doneInWeek ? `${r.doneInWeek} review${r.doneInWeek === 1 ? '' : 's'} done` : null,
        minutes ? `${formatPlainMinutes(minutes)} logged` : null,
        e.recall.reviewsFinished ? `${e.recall.reviewsFinished} Recall review${e.recall.reviewsFinished === 1 ? '' : 's'} finished` : null,
        e.focus.done ? `${e.focus.done} focus line${e.focus.done === 1 ? '' : 's'} done` : null,
        e.docs.created ? `${e.docs.created} new note${e.docs.created === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    const weakest = e.recall.weakestTopics[0];
    const slipParts = [
        r.missed ? `${r.missed} review${r.missed === 1 ? '' : 's'} missed` : null,
        r.backlogFromBefore ? `${r.backlogFromBefore} still waiting from before` : null,
        weakest ? `${weakest.title} came back weak in Recall` : null,
        rec && rec.weakSpots.open ? `${rec.weakSpots.open} weak spot${rec.weakSpots.open === 1 ? '' : 's'} open` : null,
    ].filter(Boolean);
    const goal = e.goals[0];
    const deadline = goal
        ? goal.forecast === 'behind' && goal.behindDays
            ? `${goal.title}: at this pace it lands ${goal.behindDays} days after ${goal.deadline}.`
            : goal.forecast === 'done'
              ? `${goal.title}: every milestone is done.`
              : `${goal.title}: ${goal.milestones.done} of ${goal.milestones.total} milestones done, ${goal.daysLeft} days left.`
        : 'No goal with a deadline yet.';
    const focus = [
        ...(weakest ? [`Re-test ${weakest.title}`] : []),
        ...r.missedTitles.map((t) => `Do the missed review of ${t}`),
        ...(goal?.nextMilestone ? [`Work on ${goal.nextMilestone.title}`] : []),
        ...e.focus.notDone.map((t) => t),
        'Clear today’s reviews before anything new',
        'Plan the next topic on a path',
        'Write one note on what you learned',
    ];
    const uniqueFocus = [...new Set(focus.map((f) => clip(f, 140)))].slice(0, 3);
    return {
        lines: {
            strong: clip(strongParts.length ? `This week: ${strongParts.join(', ')}.` : 'A quiet week: nothing to credit yet, and that is fine.', 220),
            slipping: clip(slipParts.length ? `${slipParts.join('; ')}.` : 'Nothing slipped.', 220),
            fix: clip(r.missed || r.backlogFromBefore ? 'Clear due reviews first, before anything new.' : weakest ? `Start with ${weakest.title}: it came back weak.` : 'Keep the same rhythm: one piece a day.', 220),
            deadline: clip(deadline, 220),
        },
        focus: uniqueFocus,
    };
}
