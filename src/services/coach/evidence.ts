// The weekly coach's evidence (pure: no DB, no network). ./coach.service.ts loads the rows; this
// turns them into the compact JSON the prompt carries, and says how much there is to go on.
//
// The window is the 7 local days ending yesterday (the user's zone). Definitions:
//   revisions.dueInWeek          scheduled on a day of the window (any status)
//   revisions.doneOnTime         of those, done by the end of the window
//   revisions.missed             of those, not done by the end of the window (still pending, or
//                                done only today)
//   revisions.doneInWeek         completed in the window, whenever they were due (catch-up counts)
//   revisions.backlogFromBefore  still pending, due before the window began
//   recall.*                     sets finished in the window; answers given in the window
//   focus.*                      the window's focus lines
//   docs.created / edited        created in the window / last edited in it (Doc.updatedAt; a doc
//                                edited in the window and again today counts for today only)
//   goals                        active goals with today's forecast (goalForecast)
//   rhythm                       the window's days: active = a review or a focus line done
// Evidence levels: `none` (nothing at all: no activity, nothing due, no backlog, no goals) gets a
// note without a model call; `little` (at most LITTLE_EVIDENCE_POINTS data points) tells the model
// to say the week is too thin to judge rather than generalize.
import { addDays, goalForecast, rhythmLast7, startOfDay, weekdayName, type DayString, type GoalForecastStatus } from '../learning';
import { clip } from '../recall/output';

export const COACH_WINDOW_DAYS = 7;
/** At most this many data points in the week → `little`. */
export const LITTLE_EVIDENCE_POINTS = 3;

const MAX_TITLES = 8;
const MAX_MISSED_TITLES = 5;
const MAX_WEAK_TOPICS = 3;
const MAX_WEAK_QUESTIONS = 2;
const MAX_FOCUS_EXAMPLES = 5;
const MAX_DONE_FOCUS_EXAMPLES = 3;
const TITLE_CHARS = 80;
const QUESTION_CHARS = 140;

export interface CoachWindow {
    weekStart: DayString;
    weekEnd: DayString;
}

/** The 7 local days ending yesterday. */
export function coachWindow(today: DayString): CoachWindow {
    return { weekStart: addDays(today, -COACH_WINDOW_DAYS), weekEnd: addDays(today, -1) };
}

// ─── Rows (what the service loads) ─────────────────────────────────────

type Grade = 'strong' | 'partial' | 'weak';

export interface CoachRevisionRow {
    scheduledFor: DayString;
    status: 'pending' | 'done' | 'missed';
    completedAt: Date | null;
    /** The doc's (or topic's / capture's) title. */
    title: string;
    subject: string | null;
}

export interface CoachRecallRow {
    title: string;
    finishedAt: Date | null;
    result: Grade | null;
    questions: ReadonlyArray<{ id: string; prompt: string }>;
    attempts: ReadonlyArray<{ questionId: string; grade: Grade; createdAt: Date }>;
}

export interface CoachRows {
    /** Revisions due in the window or completed in it. */
    revisions: readonly CoachRevisionRow[];
    /** Pending revisions due before the window. */
    backlog: number;
    /** Recall sets finished in the window or answered in it. */
    recall: readonly CoachRecallRow[];
    /** The window's focus lines, oldest first. */
    focus: ReadonlyArray<{ day: DayString; text: string; done: boolean }>;
    /** The user's docs created or updated in the window (not archived). */
    docs: ReadonlyArray<{ title: string; createdAt: Date; updatedAt: Date }>;
    /**
     * The record (LOOP_COMPLETE_SPEC 1.7): sessions of the window (and around it), weak spots open now
     * and cleared in the window, the targets of the week the window ends in. Optional: older callers
     * and tests leave it out.
     */
    record?: {
        sessions: ReadonlyArray<{ day: DayString; kind: 'study' | 'practice' | 'build' | 'review'; minutes: number | null; outcome: string | null }>;
        weakSpotsOpen: number;
        weakSpotsCleared: number;
        weekTargets: { done: number; total: number } | null;
    };
    /** Active goals, milestones in their order. */
    goals: ReadonlyArray<{
        title: string;
        deadline: DayString;
        createdDay: DayString;
        milestones: ReadonlyArray<{ title: string; done: boolean; doneAt: Date | null; dueDay: DayString | null }>;
    }>;
}

// ─── The evidence (what the model sees) ────────────────────────────────

export type EvidenceLevel = 'none' | 'little' | 'enough';

type Counts = Record<Grade, number>;

export interface CoachEvidence {
    week: { from: DayString; to: DayString; today: DayString };
    level: EvidenceLevel;
    revisions: {
        dueInWeek: number;
        doneOnTime: number;
        missed: number;
        doneInWeek: number;
        backlogFromBefore: number;
        bySubject: Array<{ subject: string; due: number; done: number; missed: number }>;
        missedTitles: string[];
    };
    recall: {
        reviewsFinished: number;
        results: Counts;
        answers: Counts;
        weakestTopics: Array<{ title: string; weak: number; partial: number; answered: number; weakQuestions: string[] }>;
    };
    focus: { lines: number; done: number; daysWithLines: number; notDone: string[]; doneExamples: string[] };
    docs: { created: number; createdTitles: string[]; edited: number; editedTitles: string[] };
    goals: Array<{
        title: string;
        deadline: DayString;
        daysLeft: number;
        forecast: GoalForecastStatus;
        pacePerWeek: number;
        requiredPerWeek: number | null;
        projectedFinish: DayString | null;
        behindDays: number | null;
        milestones: { done: number; total: number; doneThisWeek: number };
        nextMilestone: { title: string; due: DayString | null } | null;
    }>;
    rhythm: { activeDays: number; days: Array<{ day: DayString; weekday: string; active: boolean }> };
    /** The record of the window: minutes per kind, sessions, practice outcomes, weak spots, the week's targets. */
    record: {
        minutes: Record<'study' | 'practice' | 'build' | 'review', number>;
        sessions: number;
        practice: { alone: number; hints: number; after_answer: number };
        weakSpots: { open: number; clearedInWeek: number };
        weekTargets: { done: number; total: number } | null;
    };
}

const zeroCounts = (): Counts => ({ strong: 0, partial: 0, weak: 0 });

const title = (text: string): string => clip(text.replace(/\s+/g, ' ').trim() || 'Untitled', TITLE_CHARS);

/** Distinct (case-insensitive) values in order, at most `max`. */
function distinct(values: readonly string[], max: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
        const key = v.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
        if (out.length === max) break;
    }
    return out;
}

/** The evidence of one week from the loaded rows. `today` is the user's today (the day after the window). */
export function buildCoachEvidence(rows: CoachRows, ctx: CoachWindow & { today: DayString; tz: string }): CoachEvidence {
    const { weekStart, weekEnd, today, tz } = ctx;
    const from = startOfDay(weekStart, tz);
    const to = startOfDay(today, tz);
    const inWeek = (at: Date | null): at is Date => !!at && at >= from && at < to;
    const dayInWeek = (day: DayString): boolean => day >= weekStart && day <= weekEnd;

    // ── Revisions ──
    const due = rows.revisions.filter((r) => dayInWeek(r.scheduledFor));
    const doneByEnd = (r: CoachRevisionRow) => r.status === 'done' && !!r.completedAt && r.completedAt < to;
    const missed = due.filter((r) => !doneByEnd(r));
    const doneInWeek = rows.revisions.filter((r) => r.status === 'done' && inWeek(r.completedAt));
    const subjects = new Map<string, { subject: string; due: number; done: number; missed: number }>();
    const subjectOf = (r: CoachRevisionRow) => {
        const name = r.subject?.trim() || 'No subject';
        let entry = subjects.get(name);
        if (!entry) subjects.set(name, (entry = { subject: name, due: 0, done: 0, missed: 0 }));
        return entry;
    };
    for (const r of due) subjectOf(r).due += 1;
    for (const r of doneInWeek) subjectOf(r).done += 1;
    for (const r of missed) subjectOf(r).missed += 1;

    // ── Recall ──
    const results = zeroCounts();
    const answers = zeroCounts();
    const topics = new Map<string, { title: string; weak: number; partial: number; answered: number; weakQuestions: string[] }>();
    let reviewsFinished = 0;
    for (const set of rows.recall) {
        if (inWeek(set.finishedAt) && set.result) {
            reviewsFinished += 1;
            results[set.result] += 1;
        }
        const prompts = new Map(set.questions.map((q) => [q.id, q.prompt]));
        for (const a of set.attempts) {
            if (!inWeek(a.createdAt)) continue;
            answers[a.grade] += 1;
            const name = title(set.title);
            let topic = topics.get(name.toLowerCase());
            if (!topic) topics.set(name.toLowerCase(), (topic = { title: name, weak: 0, partial: 0, answered: 0, weakQuestions: [] }));
            topic.answered += 1;
            if (a.grade === 'partial') topic.partial += 1;
            if (a.grade === 'weak') {
                topic.weak += 1;
                const prompt = prompts.get(a.questionId);
                if (prompt && topic.weakQuestions.length < MAX_WEAK_QUESTIONS) {
                    const q = clip(prompt.replace(/\s+/g, ' ').trim(), QUESTION_CHARS);
                    if (!topic.weakQuestions.includes(q)) topic.weakQuestions.push(q);
                }
            }
        }
    }
    const weakestTopics = [...topics.values()]
        .filter((t) => t.weak + t.partial > 0)
        .sort((a, b) => b.weak - a.weak || b.partial - a.partial || a.title.localeCompare(b.title))
        .slice(0, MAX_WEAK_TOPICS);

    // ── Focus ──
    const focus = rows.focus.filter((f) => dayInWeek(f.day));
    const newestFirst = [...focus].reverse();
    const focusText = (t: string) => clip(t.replace(/\s+/g, ' ').trim(), TITLE_CHARS);

    // ── Docs ──
    const created = rows.docs.filter((d) => inWeek(d.createdAt)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const edited = rows.docs.filter((d) => inWeek(d.updatedAt) && d.createdAt < from).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    // ── Goals (nearest deadline first) ──
    let milestonesDone = 0;
    const goals = [...rows.goals]
        .sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0))
        .map((g) => {
            const f = goalForecast({ milestones: g.milestones, createdDay: g.createdDay, deadline: g.deadline, today });
            const doneThisWeek = g.milestones.filter((m) => m.done && inWeek(m.doneAt)).length;
            milestonesDone += doneThisWeek;
            const next = g.milestones.find((m) => !m.done);
            return {
                title: title(g.title),
                deadline: g.deadline,
                daysLeft: f.daysLeft,
                forecast: f.status,
                pacePerWeek: f.pacePerWeek,
                requiredPerWeek: f.requiredPerWeek,
                projectedFinish: f.projectedDay,
                behindDays: f.behindDays,
                milestones: { done: f.progress.done, total: f.progress.total, doneThisWeek },
                nextMilestone: next ? { title: title(next.title), due: next.dueDay } : null,
            };
        });

    // ── Rhythm ──
    const rhythm = rhythmLast7({
        today: weekEnd,
        tz,
        completions: doneInWeek.map((r) => r.completedAt!),
        focusDoneDays: focus.filter((f) => f.done).map((f) => f.day),
        sessionDays: (rows.record?.sessions ?? []).map((x) => x.day),
    });

    // ── The record ──
    const sessions = (rows.record?.sessions ?? []).filter((x) => dayInWeek(x.day));
    const record = {
        minutes: { study: 0, practice: 0, build: 0, review: 0 },
        sessions: sessions.length,
        practice: { alone: 0, hints: 0, after_answer: 0 },
        weakSpots: { open: rows.record?.weakSpotsOpen ?? 0, clearedInWeek: rows.record?.weakSpotsCleared ?? 0 },
        weekTargets: rows.record?.weekTargets ?? null,
    };
    for (const x of sessions) {
        record.minutes[x.kind] += x.minutes ?? 0;
        if (x.kind === 'practice' && (x.outcome === 'alone' || x.outcome === 'hints' || x.outcome === 'after_answer')) record.practice[x.outcome] += 1;
    }

    // ── How much is there to go on ──
    const catchUp = doneInWeek.filter((r) => !dayInWeek(r.scheduledFor)).length;
    const points = due.length + catchUp + answers.strong + answers.partial + answers.weak + focus.length + created.length + edited.length + milestonesDone + sessions.length + record.weakSpots.clearedInWeek;
    const level: EvidenceLevel =
        points === 0 && rows.backlog === 0 && goals.length === 0 ? 'none' : points <= LITTLE_EVIDENCE_POINTS ? 'little' : 'enough';

    return {
        week: { from: weekStart, to: weekEnd, today },
        level,
        revisions: {
            dueInWeek: due.length,
            doneOnTime: due.length - missed.length,
            missed: missed.length,
            doneInWeek: doneInWeek.length,
            backlogFromBefore: rows.backlog,
            bySubject: [...subjects.values()].sort((a, b) => b.due + b.done - (a.due + a.done) || a.subject.localeCompare(b.subject)),
            missedTitles: distinct(missed.map((r) => title(r.title)), MAX_MISSED_TITLES),
        },
        recall: { reviewsFinished, results, answers, weakestTopics },
        focus: {
            lines: focus.length,
            done: focus.filter((f) => f.done).length,
            daysWithLines: new Set(focus.map((f) => f.day)).size,
            notDone: distinct(newestFirst.filter((f) => !f.done).map((f) => focusText(f.text)), MAX_FOCUS_EXAMPLES),
            doneExamples: distinct(newestFirst.filter((f) => f.done).map((f) => focusText(f.text)), MAX_DONE_FOCUS_EXAMPLES),
        },
        docs: {
            created: created.length,
            createdTitles: distinct(created.map((d) => title(d.title)), MAX_TITLES),
            edited: edited.length,
            editedTitles: distinct(edited.map((d) => title(d.title)), MAX_TITLES),
        },
        goals,
        rhythm: { activeDays: rhythm.activeDays, days: rhythm.last7.map((d) => ({ day: d.day, weekday: weekdayName(d.day), active: d.active })) },
        record,
    };
}
