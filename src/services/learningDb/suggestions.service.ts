// Suggestions (LOOP_COMPLETE_SPEC 1.6, ECOSYSTEM_PLAN change 9): every proposal from the app, the
// coach or an agent is one row, shown in one place on Home ("Suggested") and accepted with one tap.
// Accepting is always Ramin's (cookie only); an agent can propose, never accept.
//
//   listSuggestions    GET  /api/suggestions?status=pending        read
//   proposeSuggestion  POST /api/suggestions                       learning:write (SELF_LOGGED)
//   acceptSuggestion / dismissSuggestion / decideSuggestions        the app only
//   proposeWeek        the Sunday review's batch, written by code (no model call) when it is due
//
// A kind is one handler (what accepting does) and one line of card text: add a kind by adding a
// handler to ACCEPT. `action` (the manager, stage 4) has none yet.
import type { Prisma, Suggestion, SuggestionKind, SuggestionProposer, SuggestionStatus } from '@prisma/client';
import { runAction } from '../actions/actions.service';
import { prisma } from '../../db/prisma';
import { addDays, diffDays, type DayString } from '../learning';
import { badRequest, conflict, notFound } from '../learning/http';
import { fromDbDay, loadLearningContext, toDbDay } from './common';
import { createFocusItem } from './focus.service';
import { readPath } from './path.service';
import { updateLearningSettings } from './settings.service';
import { addWeekTarget, reviewDue, weekTargets, type WeekTargetInput } from './week.service';
import { createTask } from '../tasks/tasks.service';
import { createCapture } from './items.service';
import { createDecision } from './decisions.service';
import { createRoutine, maybeOfferRoutine } from '../buddy/routines';

export const SUGGESTION_KINDS = ['week_target', 'focus_line', 'profile_edit', 'action', 'task', 'note', 'decision', 'routine'] as const satisfies readonly SuggestionKind[];
/** Pending suggestions one agent may have waiting at once. */
export const AGENT_PENDING_MAX = 10;
const WEEK_PROPOSALS_MAX = 5;
const PER_PATH_MAX = 2;

export interface SuggestionJson {
    _id: string;
    kind: SuggestionKind;
    text: string;
    reason: string | null;
    payload: unknown;
    proposedBy: SuggestionProposer;
    agentName: string | null;
    batch: string | null;
    status: SuggestionStatus;
    expiresDay: DayString | null;
    decidedAt: string | null;
    createdAt: string;
}

export const serializeSuggestion = (s: Suggestion): SuggestionJson => ({
    _id: s.id,
    kind: s.kind,
    text: s.text,
    reason: s.reason,
    payload: s.payload,
    proposedBy: s.proposedBy,
    agentName: s.agentName,
    batch: s.batch,
    status: s.status,
    expiresDay: s.expiresDay ? fromDbDay(s.expiresDay) : null,
    decidedAt: s.decidedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
});

const clip = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);
/** "Fri 20 Nov" (a local day, for a card's reason line). */
const shortDay = (day: DayString): string => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');

// ─── Reads ─────────────────────────────────────────────────────────────

/** GET /api/suggestions: pending ones (not expired) by default, newest batch first. Writes the week's batch when it is due. */
export async function listSuggestions(userId: string, options: { status?: SuggestionStatus | undefined } = {}, now: Date = new Date()): Promise<SuggestionJson[]> {
    const status = options.status ?? 'pending';
    const ctx = await loadLearningContext(userId, now);
    if (status === 'pending') await proposeWeek(userId, now);
    const rows = await prisma.suggestion.findMany({
        where: { userId, status, ...(status === 'pending' ? { OR: [{ expiresDay: null }, { expiresDay: { gte: toDbDay(ctx.today) } }] } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 50,
    });
    return rows.map(serializeSuggestion);
}

// ─── Proposing ─────────────────────────────────────────────────────────

export interface SuggestionInput {
    kind: SuggestionKind;
    text: string;
    reason?: string | null | undefined;
    payload: Record<string, unknown>;
}

/** What each kind's payload must hold (checked again when accepted). */
function checkPayload(kind: SuggestionKind, payload: Record<string, unknown>): void {
    if (kind === 'week_target') {
        if (typeof payload['text'] !== 'string' || !payload['text'].trim()) throw badRequest('A week_target suggestion needs payload.text');
    } else if (kind === 'focus_line') {
        if (typeof payload['text'] !== 'string' || !payload['text'].trim() || payload['text'].length > 140) throw badRequest('A focus_line suggestion needs payload.text (at most 140 characters)');
    } else if (kind === 'profile_edit') {
        if (typeof payload['profile'] !== 'string' || payload['profile'].length > 600) throw badRequest('A profile_edit suggestion needs payload.profile (at most 600 characters)');
    } else {
        throw badRequest('An action that needs a tap is asked for with POST /api/actions', 'KIND_NOT_AVAILABLE');
    }
}

/** POST /api/suggestions (an agent proposes): at most AGENT_PENDING_MAX waiting per agent. */
export async function proposeSuggestion(userId: string, agentName: string | null, input: SuggestionInput): Promise<SuggestionJson> {
    const text = clip(input.text ?? '', 200);
    if (!text) throw badRequest('text cannot be empty');
    checkPayload(input.kind, input.payload ?? {});
    if (agentName) {
        const waiting = await prisma.suggestion.count({ where: { userId, status: 'pending', proposedBy: 'agent', agentName } });
        if (waiting >= AGENT_PENDING_MAX) throw conflict(`${AGENT_PENDING_MAX} of your suggestions are still waiting for Ramin`, 'SUGGESTION_LIMIT');
    }
    const row = await prisma.suggestion.create({
        data: {
            userId,
            kind: input.kind,
            text,
            reason: input.reason ? clip(input.reason, 200) : null,
            payload: input.payload as Prisma.InputJsonValue,
            proposedBy: agentName ? 'agent' : 'app',
            agentName,
        },
    });
    return serializeSuggestion(row);
}

// ─── Accepting ─────────────────────────────────────────────────────────

/** Does what the suggestion says; an action says what happened (the toast's words). */
type Accept = (userId: string, payload: Record<string, unknown>, now: Date) => Promise<string | void>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const ACCEPT: Record<SuggestionKind, Accept | null> = {
    week_target: async (userId, p, now) => {
        const input: WeekTargetInput = {
            text: String(p['text'] ?? ''),
            weekStart: str(p['weekStart']),
            topicId: str(p['topicId']),
            milestoneId: str(p['milestoneId']),
            todoId: str(p['todoId']),
            measure: (str(p['measure']) as WeekTargetInput['measure']) ?? undefined,
            amount: typeof p['amount'] === 'number' ? p['amount'] : undefined,
            subjectId: str(p['subjectId']),
            projectId: str(p['projectId']),
        };
        await addWeekTarget(userId, input, now);
    },
    focus_line: async (userId, p, now) => {
        await createFocusItem(userId, String(p['text'] ?? ''), now);
    },
    profile_edit: async (userId, p, now) => {
        await updateLearningSettings(userId, { agentProfile: typeof p['profile'] === 'string' ? p['profile'] : null }, now);
    },
    // Level 3 (MANAGER_AND_DOCS_PLAN §3.2): his tap runs the call the action holds.
    action: async (userId, p) => runAction(userId, p),
    // The buddy's items from his chats (BUDDY_MEMORY_PLAN §3.6): what his tap makes.
    task: async (userId, p, now) => {
        const t = await createTask(userId, { title: String(p['title'] ?? ''), due: str(p['dueDay']) ?? null }, now);
        return t.due ? 'Added to your tasks, with its day' : 'Added to your tasks';
    },
    note: async (userId, p, now) => {
        const title = String(p['title'] ?? '').trim();
        await createCapture(userId, { type: 'NOTE', title: title.slice(0, 200), ...(str(p['why']) ? { content: str(p['why']) } : {}) }, now);
        return 'Saved to your inbox';
    },
    decision: async (userId, p, now) => {
        await createDecision(userId, { title: String(p['title'] ?? ''), why: str(p['why']) ?? 'From your chat', lookAgain: '30d', project: str(p['project']) ?? null }, now);
        return 'Logged in your decisions (look again in 30 days)';
    },
    // B6: his standing yes makes a routine (listed on /you with a switch).
    routine: async (userId, p) => {
        await createRoutine(userId, String(p['routine'] ?? ''));
        return 'It does this by itself now (About you lists it, with a switch)';
    },
};

async function pendingOf(userId: string, id: string): Promise<Suggestion> {
    const s = await prisma.suggestion.findFirst({ where: { id, userId } });
    if (!s) throw notFound();
    if (s.status !== 'pending') throw conflict('This suggestion was already decided', 'ALREADY_DECIDED');
    return s;
}

/** POST /api/suggestions/:id/accept (the app only): do what it says, then mark it accepted. */
export async function acceptSuggestion(userId: string, id: string, now: Date = new Date()): Promise<SuggestionJson & { result?: string }> {
    const s = await pendingOf(userId, id);
    const accept = ACCEPT[s.kind];
    if (!accept) throw badRequest('This kind of suggestion has no action yet', 'KIND_NOT_AVAILABLE');
    const result = await accept(userId, (s.payload ?? {}) as Record<string, unknown>, now);
    const { count } = await prisma.suggestion.updateMany({ where: { id, status: 'pending' }, data: { status: 'accepted', decidedAt: now } });
    if (count === 0) throw conflict('This suggestion was already decided', 'ALREADY_DECIDED');
    // The buddy's third item of a kind in 30 days brings its offer to do it by itself (B6), once.
    if (s.proposedBy === 'buddy') await maybeOfferRoutine(userId, s.kind, now);
    const json = serializeSuggestion(await prisma.suggestion.findUniqueOrThrow({ where: { id } }));
    return typeof result === 'string' ? { ...json, result } : json;
}

/** POST /api/suggestions/:id/dismiss (the app only). */
export async function dismissSuggestion(userId: string, id: string, now: Date = new Date()): Promise<SuggestionJson> {
    await pendingOf(userId, id);
    await prisma.suggestion.updateMany({ where: { id, status: 'pending' }, data: { status: 'dismissed', decidedAt: now } });
    return serializeSuggestion(await prisma.suggestion.findUniqueOrThrow({ where: { id } }));
}

/** POST /api/suggestions/decide { accept, dismiss } (the app only): "Accept all" and "Skip". One failure doesn't stop the rest. */
export async function decideSuggestions(
    userId: string,
    input: { accept?: string[] | undefined; dismiss?: string[] | undefined },
    now: Date = new Date()
): Promise<{ accepted: string[]; dismissed: string[]; failed: Array<{ _id: string; message: string }> }> {
    const out = { accepted: [] as string[], dismissed: [] as string[], failed: [] as Array<{ _id: string; message: string }> };
    for (const id of input.accept ?? []) {
        try {
            await acceptSuggestion(userId, id, now);
            out.accepted.push(id);
        } catch (err) {
            out.failed.push({ _id: id, message: err instanceof Error ? err.message : String(err) });
        }
    }
    for (const id of input.dismiss ?? []) {
        try {
            await dismissSuggestion(userId, id, now);
            out.dismissed.push(id);
        } catch (err) {
            out.failed.push({ _id: id, message: err instanceof Error ? err.message : String(err) });
        }
    }
    return out;
}

// ─── The Sunday review ─────────────────────────────────────────────────

interface Proposal {
    text: string;
    reason: string;
    payload: Record<string, unknown>;
    /** Dedupe key: the thing it points at, or its text. */
    key: string;
}

/**
 * The review's proposals for a week, worked out by code (pure over what it is given): the path topics
 * the goals' deadlines need (at most 2 per path), the next topic of a path studied lately, last
 * week's open targets ("Keep"), a milestone due within 14 days, the coach's newest suggestion. At most
 * 5, goal-linked first.
 */
export function weekProposals(input: {
    weekStart: DayString;
    goals: Array<{ title: string; deadline: DayString; subjectIds: string[]; milestones: Array<{ id: string; title: string; dueDay: DayString | null; done: boolean }> }>;
    paths: Array<{ subjectId: string; name: string; topics: Array<{ _id: string; title: string; position: number; status: string }> }>;
    recentSubjectIds: string[];
    lastWeekOpen: Array<{ text: string; topicId: string | null; milestoneId: string | null; todoId: string | null; measure: string | null; amount: number | null; subjectId: string | null; projectId: string | null }>;
    coachLine: string | null;
}): Proposal[] {
    const out: Proposal[] = [];
    const add = (p: Proposal) => {
        if (out.length < WEEK_PROPOSALS_MAX && !out.some((o) => o.key === p.key)) out.push(p);
    };
    const open = (topics: (typeof input.paths)[number]['topics']) => [
        ...topics.filter((t) => t.status === 'in_progress'),
        ...topics.filter((t) => t.status === 'planned'),
    ];
    const target = (t: { _id: string; title: string; position: number }) => ({ text: `Finish ${t.position}. ${t.title}`, topicId: t._id });

    // 1. Paths of active goals: the pace their deadline needs.
    const goalSubjects = new Set(input.goals.flatMap((g) => g.subjectIds));
    for (const g of input.goals) {
        for (const p of input.paths.filter((x) => g.subjectIds.includes(x.subjectId))) {
            const left = open(p.topics);
            if (!left.length) continue;
            const weeksLeft = Math.max(1, Math.ceil(diffDays(g.deadline, input.weekStart) / 7));
            const perWeek = Math.min(PER_PATH_MAX, Math.ceil(left.length / weeksLeft));
            for (const t of left.slice(0, perWeek)) {
                const { text, topicId } = target(t);
                add({ text, reason: `${p.name}: ${left.length} topic${left.length === 1 ? '' : 's'} left before "${g.title}" (${shortDay(g.deadline)})`, payload: { text, topicId, weekStart: input.weekStart }, key: `topic:${topicId}` });
            }
        }
    }
    // 2. A milestone due within 14 days.
    const soon = input.goals
        .flatMap((g) => g.milestones.filter((m) => !m.done && m.dueDay && m.dueDay >= input.weekStart && diffDays(m.dueDay, input.weekStart) <= 14).map((m) => ({ ...m, goal: g.title })))
        .sort((a, b) => (a.dueDay! < b.dueDay! ? -1 : 1))[0];
    if (soon) add({ text: soon.title, reason: `Milestone due ${shortDay(soon.dueDay!)} (${soon.goal})`, payload: { text: soon.title.slice(0, 140), milestoneId: soon.id, weekStart: input.weekStart }, key: `milestone:${soon.id}` });
    // 3. Last week's open targets.
    for (const t of input.lastWeekOpen) {
        add({
            text: `Keep: ${t.text}`,
            reason: 'Open at the end of last week',
            payload: { text: t.text, weekStart: input.weekStart, topicId: t.topicId, milestoneId: t.milestoneId, todoId: t.todoId, measure: t.measure, amount: t.amount, subjectId: t.subjectId, projectId: t.projectId },
            key: t.topicId ? `topic:${t.topicId}` : t.milestoneId ? `milestone:${t.milestoneId}` : `text:${t.text.toLowerCase()}`,
        });
    }
    // 4. A path without a goal that was studied in the last 14 days: its next topic.
    for (const p of input.paths.filter((x) => !goalSubjects.has(x.subjectId) && input.recentSubjectIds.includes(x.subjectId))) {
        const next = open(p.topics)[0];
        if (!next) continue;
        const { text, topicId } = target(next);
        add({ text, reason: `${p.name}: studied in the last two weeks`, payload: { text, topicId, weekStart: input.weekStart }, key: `topic:${topicId}` });
    }
    // 5. The coach's newest suggestion.
    if (input.coachLine) add({ text: input.coachLine, reason: "The weekly coach's suggestion", payload: { text: input.coachLine.slice(0, 140), weekStart: input.weekStart }, key: `text:${input.coachLine.toLowerCase()}` });
    return out;
}

/**
 * When the review is due and its batch doesn't exist yet: write it (once; two calls at once write
 * one batch). Returns the batch's pending suggestions, or [] when not due.
 */
export async function proposeWeek(userId: string, now: Date = new Date()): Promise<SuggestionJson[]> {
    const ctx = await loadLearningContext(userId, now);
    const { due, weekStart } = await reviewDue(userId, ctx.today);
    if (!due) return [];
    const batch = `week:${weekStart}`;
    const existing = await prisma.suggestion.findMany({ where: { userId, batch }, orderBy: { createdAt: 'asc' } });
    if (existing.length) return existing.filter((s) => s.status === 'pending').map(serializeSuggestion);

    const proposals = await gatherWeekProposals(userId, weekStart, ctx.tz, ctx.today);
    if (!proposals.length) return [];
    const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`suggest:${userId}`}))`;
        if (await tx.suggestion.count({ where: { userId, batch } })) return tx.suggestion.findMany({ where: { userId, batch }, orderBy: { createdAt: 'asc' } });
        const made: Suggestion[] = [];
        for (const p of proposals) {
            made.push(
                await tx.suggestion.create({
                    data: { userId, kind: 'week_target', text: p.text.slice(0, 200), reason: p.reason.slice(0, 200), payload: p.payload as Prisma.InputJsonValue, proposedBy: 'app', batch, expiresDay: toDbDay(addDays(weekStart, 6)) },
                })
            );
        }
        return made;
    });
    return rows.filter((s) => s.status === 'pending').map(serializeSuggestion);
}

async function gatherWeekProposals(userId: string, weekStart: DayString, tz: string, today: DayString): Promise<Proposal[]> {
    const [goals, subjects, recent, lastWeek, coach] = await Promise.all([
        prisma.goal.findMany({
            where: { userId, status: 'active' },
            select: { title: true, deadline: true, subjects: { select: { subjectId: true } }, milestones: { select: { id: true, title: true, dueDay: true, done: true }, orderBy: { sortOrder: 'asc' } } },
            orderBy: { deadline: 'asc' },
        }),
        prisma.subject.findMany({ where: { userId, topics: { some: { status: { in: ['planned', 'in_progress'] }, isArchived: false } } }, select: { id: true } }),
        prisma.workSession.findMany({ where: { userId, day: { gte: toDbDay(addDays(today, -13)) }, subjectId: { not: null } }, select: { subjectId: true }, distinct: ['subjectId'] }),
        weekTargets(userId, addDays(weekStart, -7), tz),
        prisma.coachNote.findFirst({ where: { userId, createdAt: { gte: new Date(Date.now() - 8 * 24 * 3600_000) }, model: { not: 'none' } }, orderBy: { createdAt: 'desc' }, select: { focus: true } }),
    ]);
    const paths = [];
    for (const s of subjects) {
        const p = await readPath(userId, s.id);
        paths.push({ subjectId: s.id, name: p.subject.name, topics: p.topics.map((t) => ({ _id: t._id, title: t.title, position: t.position, status: t.status })) });
    }
    const coachFocus = Array.isArray(coach?.focus) ? (coach!.focus as unknown[]).find((x): x is string => typeof x === 'string' && !!x.trim()) ?? null : null;
    return weekProposals({
        weekStart,
        goals: goals.map((g) => ({
            title: g.title,
            deadline: fromDbDay(g.deadline),
            subjectIds: g.subjects.map((x) => x.subjectId),
            milestones: g.milestones.map((m) => ({ id: m.id, title: m.title, dueDay: m.dueDay ? fromDbDay(m.dueDay) : null, done: m.done })),
        })),
        paths,
        recentSubjectIds: recent.map((r) => r.subjectId!).filter(Boolean),
        lastWeekOpen: lastWeek
            .filter((t) => !t.done && t.status === 'open')
            .map((t) => ({ text: t.text, topicId: t.topic?._id ?? null, milestoneId: t.milestone?._id ?? null, todoId: t.task?._id ?? null, measure: t.measure, amount: t.amount, subjectId: t.subject?._id ?? null, projectId: t.project?._id ?? null })),
        coachLine: coachFocus,
    });
}

