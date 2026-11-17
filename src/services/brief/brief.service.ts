// The brief (SYNC_SPINE_SPEC 1.3, ECOSYSTEM_PLAN change 3): the ONE picture of where the user stands,
// composed on the server from the services that already own each part. Agents read it with
// get_brief at the start of a chat (a Claude Code hook prints it); Home, the coach and Ask AI are to
// read it too. No query logic of its own: Today's payload (goals, plan, focus, next up), the
// sessions service (sessions, weak spots, projects), the coach's evidence (Recall's last 7 days).
//
//   GET /api/brief?project=<folder key>&key=<a session key to reuse>
import { getToday } from '../learningDb/today.service';
import { getLearningSettings } from '../learningDb/settings.service';
import { lastSessionsOf, listSessions, newSessionKey, openWeakSpotsOf, projectByKey, type SessionJson } from '../learningDb/sessions.service';
import { loadCoachRows } from '../coach/coach.service';
import { buildCoachEvidence, coachWindow } from '../coach/evidence';
import { loadLearningContext } from '../learningDb/common';
import type { NextUpJson } from '../learningDb/path.service';
import { reviewDue, weekStartOf, weekTargets } from '../learningDb/week.service';
import { getMirror } from '../mirror/mirror.service';
import { taskSummary } from '../tasks/tasks.service';
import { listDecisions } from '../learningDb/decisions.service';
import { buddyBrief, type BuddyBrief } from '../buddy/memory.service';
import { workForBrief, type WorkBrief } from '../buddy/work';

const WEAK_SPOTS_PER_TOPIC = 5;
const RECENT = 5;
const WEAK_TOPICS = 3;

type Today = Awaited<ReturnType<typeof getToday>>;

export interface BriefSession {
    day: string;
    kind: SessionJson['kind'];
    minutes: number | null;
    title: string;
    subject: string | null;
    project: string | null;
    score: { done: number; total: number } | null;
}

export interface Brief {
    now: { day: string; weekday: string; time: string; timezone: string };
    profile: string | null;
    goals: Array<
        Pick<Today['goals'][number], '_id' | 'title' | 'deadline' | 'daysLeft' | 'progress' | 'forecast' | 'nextMilestone'> & {
            /** Each path of the goal with its pace (LOOP_COMPLETE_SPEC 1.7). */
            paths: Array<{ subject: string; done: number; total: number; perWeek: number; requiredPerWeek: number | null; landsOn: string | null; status: string }>;
        }
    >;
    /** Decisions to look at again today; with ?project=, that project's last two (LOOP_COMPLETE_SPEC 4.2). */
    decisions: { due: Array<{ _id: string; title: string; lookAgainDay: string }>; project: Array<{ title: string; why: string; day: string }> };
    /** Personal tasks due today and overdue, up to 3 titles (LOOP_COMPLETE_SPEC 4.1). */
    tasks: { dueToday: number; overdue: number; titles: string[] };
    /** The running week's targets (LOOP_COMPLETE_SPEC 1.6); reviewDue: the Sunday review waits on Home. */
    week: { weekStart: string; targets: Array<{ _id: string; text: string; done: boolean; progress: { done: number; total: number } | null }>; reviewDue: boolean };
    today: { revisions: { planned: number; estMinutes: number; done: number; waiting: number }; focus: Array<{ _id: string; text: string; done: boolean }> };
    next: Array<NextUpJson & { lastSession: BriefSession | null; weakSpots: Array<{ _id: string; text: string }> }>;
    recent: BriefSession[];
    recall: { days: 7; finished: number; weakTopics: Array<{ title: string; weak: number }> };
    project: { key: string; name: string; nextStep: string | null; lastSession: { day: string; minutes: number | null; title: string } | null } | null;
    /** The buddy (BUDDY_MEMORY_PLAN §3.4): the portrait, the memories this chat starts with, a note for him. */
    buddy: BuddyBrief;
    /**
     * The work log (B9; null while it is off or has nothing): in his own chats, yesterday's lines across
     * projects (five at most); in a work folder's chat, that project's last three days with lines only.
     */
    work: WorkBrief | null;
    session: { key: string };
}

const brief = (s: SessionJson): BriefSession => ({
    day: s.day,
    kind: s.kind,
    minutes: s.minutes,
    title: s.title,
    subject: s.subject?.name ?? null,
    project: s.project?.name ?? null,
    score: s.score,
});

/** Where the user stands, now. `key` reuses a session key (a Claude Code session's); else a fresh one. */
/**
 * A work folder's brief (BUDDY_MEMORY_PLAN §4.3): his goal is a new job, so an office chat gets only
 * the day, this project's own line and the session key: no profile, goals, plan, sessions from
 * elsewhere, Recall or buddy.
 */
function workBrief(b: Brief): Brief {
    return {
        ...b,
        profile: null,
        goals: [],
        tasks: { dueToday: 0, overdue: 0, titles: [] },
        decisions: { due: [], project: b.decisions.project },
        week: { weekStart: b.week.weekStart, targets: [], reviewDue: false },
        today: { revisions: { planned: 0, estMinutes: 0, done: 0, waiting: 0 }, focus: [] },
        next: [],
        recent: [],
        recall: { days: 7, finished: 0, weakTopics: [] },
        buddy: { who: null, heading: null, now: null, memories: [], note: null, followUp: null, noteId: null, noteDay: null },
    };
}

export async function getBrief(userId: string, options: { project?: string | undefined; key?: string | undefined; work?: boolean | undefined } = {}, now: Date = new Date()): Promise<Brief> {
    const full = await fullBrief(userId, options, now);
    if (!options.work) return full;
    // A work folder: its own project's work only (never the other projects', never his life).
    return { ...workBrief(full), work: await workForBrief(userId, { project: options.project, work: true }, now) };
}

async function fullBrief(userId: string, options: { project?: string | undefined; key?: string | undefined } = {}, now: Date = new Date()): Promise<Brief> {
    const ctx = await loadLearningContext(userId, now);
    const window = coachWindow(ctx.today);
    const weekStart = weekStartOf(ctx.today);
    const [today, settings, sessions, project, coachRows, targets, review, mirror, tasks, dueDecisions, projectDecisions, buddy] = await Promise.all([
        getToday(userId, now),
        getLearningSettings(userId),
        listSessions(userId, { days: 14 }, now),
        options.project ? projectByKey(userId, options.project) : Promise.resolve(null),
        loadCoachRows(userId, ctx, window),
        weekTargets(userId, weekStart, ctx.tz),
        reviewDue(userId, ctx.today),
        getMirror(userId, now),
        taskSummary(userId, now),
        listDecisions(userId, { due: true }, now),
        options.project ? listDecisions(userId, { project: options.project }, now) : Promise.resolve([]),
        buddyBrief(userId, { project: options.project }),
    ]);
    const work = await workForBrief(userId, {}, now);
    const topicIds = today.next.map((n) => n.topic._id);
    const [weak, last] = await Promise.all([openWeakSpotsOf(userId, topicIds), lastSessionsOf(userId, topicIds)]);
    const evidence = buildCoachEvidence(coachRows, { ...window, today: ctx.today, tz: ctx.tz });

    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: ctx.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    const part = (type: string) => clock.find((p) => p.type === type)?.value ?? '';

    return {
        now: { day: ctx.today, weekday: part('weekday'), time: `${part('hour')}:${part('minute')}`, timezone: ctx.tz },
        profile: settings.agentProfile,
        goals: today.goals.map((g) => ({
            _id: g._id,
            title: g.title,
            deadline: g.deadline,
            daysLeft: g.daysLeft,
            progress: g.progress,
            forecast: g.forecast,
            nextMilestone: g.nextMilestone,
            paths: (mirror.goals.find((m) => m._id === g._id)?.paths ?? []).map((p) => ({ subject: p.subject.name, done: p.done, total: p.total, perWeek: p.perWeek, requiredPerWeek: p.requiredPerWeek, landsOn: p.landsOn, status: p.status })),
        })),
        tasks,
        decisions: {
            due: dueDecisions.slice(0, 3).map((d) => ({ _id: d._id, title: d.title, lookAgainDay: d.lookAgainDay })),
            project: projectDecisions.slice(0, 2).map((d) => ({ title: d.title, why: d.why, day: d.createdAt.slice(0, 10) })),
        },
        week: { weekStart, targets: targets.map((t) => ({ _id: t._id, text: t.text, done: t.done, progress: t.progress })), reviewDue: review.due },
        today: {
            revisions: { planned: today.plan.planned.length, estMinutes: today.plan.estMinutes, done: today.plan.doneToday.length, waiting: today.plan.waitingCount },
            focus: today.focus.items.map((f) => ({ _id: f._id, text: f.text, done: f.done })),
        },
        next: today.next.map((n) => {
            const l = last.get(n.topic._id);
            return {
                ...n,
                lastSession: l ? brief(l) : null,
                weakSpots: (weak.get(n.topic._id) ?? []).slice(0, WEAK_SPOTS_PER_TOPIC).map((w) => ({ _id: w._id, text: w.text })),
            };
        }),
        recent: sessions.sessions.slice(0, RECENT).map(brief),
        recall: {
            days: 7,
            finished: evidence.recall.reviewsFinished,
            weakTopics: evidence.recall.weakestTopics.filter((t) => t.weak > 0).slice(0, WEAK_TOPICS).map((t) => ({ title: t.title, weak: t.weak })),
        },
        project: project ? { key: project.key, name: project.name, nextStep: project.nextStep, lastSession: project.lastSession } : null,
        buddy,
        work,
        session: { key: options.key ?? newSessionKey(now) },
    };
}
