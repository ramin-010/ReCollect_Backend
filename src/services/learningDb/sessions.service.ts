// The record (SYNC_SPINE_SPEC 1.2): one WorkSession per piece of work, written by an agent
// (`checkpoint`, again and again under one key), a Claude Code hook (`cc_<session>`), or by hand;
// projects (where build sessions belong); weak spots (study chats → Recall, and Recall → chats).
//
//   upsertSessionByKey   PUT    /api/sessions/by-key/:key   sessions:write (or the app)
//   createSession        POST   /api/sessions               the app (a manual entry)
//   listSessions         GET    /api/sessions?days=&kind=&project=&subject=
//   updateSession        PATCH  /api/sessions/:id           the app
//   deleteSession        DELETE /api/sessions/:id           the app
//   listProjects / updateProject   GET /api/projects · PATCH /api/projects/:id
//
// PERSONAL_OFFICE_PLAN (11-23): a folder (project) is personal, study or work. A new folder takes the PC's hint
// (`projectKind`, from the hook's rule), a folder the server knows keeps its own kind (the app's choice). A session
// takes its folder's area (work or personal); a study folder's hook sessions are study, not build; a work folder's
// sessions carry no commit subjects and are titled by the folder. Changing a folder's kind moves its past with it.
//
// Session writes are not AgentEdit rows: the list is their log (each row says who wrote it, and
// the user can change or delete any). A topic change a token's session asks for goes through the path
// update and IS logged (topic_update, undoable), only when it changes something.
import { randomInt } from 'node:crypto';
import { Prisma, type PracticeOutcome, type ProjectKind, type SessionArea, type SessionKind, type SessionSource, type TopicStatus, type WeakSpotSource } from '@prisma/client';
import { prisma, type DbClient } from '../../db/prisma';
import { addDays, dayOf, type DayString } from '../learning';
import { badRequest, notFound } from '../learning/http';
import { fromDbDay, loadLearningContext, toDbDay } from './common';
import { pathPlaces, readPath, updateTopicOnPath, type PathTopicJson } from './path.service';
import { quoted, recordAgentEdit, type AgentActor } from '../agent/agentEditLog';
import { rememberNotes, type NoteInput } from '../buddy/memory.service';
import { poke } from '../scheduler/scheduler';
import { areaOfKind, sessionsOf, type Lens } from './lens';

export const SESSION_KINDS = ['study', 'practice', 'build', 'review'] as const satisfies readonly SessionKind[];
export const PRACTICE_OUTCOMES = ['alone', 'hints', 'after_answer'] as const satisfies readonly PracticeOutcome[];
export const SESSION_KEY_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
export const SESSION_TITLE_MAX = 200;
export const WEAK_SPOT_MAX_CHARS = 160;
export const WEAK_SPOTS_PER_WRITE = 10;
export const MINUTES_MAX = 1440;
/** What a checkpoint may say it learned about the user at once (the buddy's notes). */
export const LEARNED_PER_WRITE = 3;
/**
 * A chat's checkpoint without minutes (LOOP_COMPLETE_SPEC S1.1 #5): the first write counts the time
 * since the key's start, up to FIRST_WRITE_CAP_MIN; each later write adds the time since the row's
 * last write, up to GAP_CAP_MIN, so a chat left open over lunch doesn't log hours.
 */
export const FIRST_WRITE_CAP_MIN = 45;
export const GAP_CAP_MIN = 30;
const LIST_LIMIT = 300;

// ─── Keys ──────────────────────────────────────────────────────────────

/**
 * A fresh session key for a chat: "s_" + the start second (base 36, 7 characters) + 5 random
 * characters. The key carries its start, so the first checkpoint knows how long the chat has run.
 */
export function newSessionKey(now: Date = new Date()): string {
    const seconds = Math.floor(now.getTime() / 1000).toString(36).padStart(7, '0').slice(-7);
    let rand = '';
    for (let i = 0; i < 5; i++) rand += randomInt(36).toString(36);
    return `s_${seconds}${rand}`;
}

/** The start a chat key carries, when it is believable (the last day, not the future). */
export function keyStartedAt(key: string, now: Date): Date | null {
    const m = /^s_([0-9a-z]{7})[0-9a-z]{5}$/.exec(key);
    if (!m) return null;
    const at = new Date(parseInt(m[1]!, 36) * 1000);
    const age = now.getTime() - at.getTime();
    return age >= -5 * 60_000 && age <= 24 * 3600_000 ? at : null;
}

/** lower case, single spaces: one weak spot per text and topic. */
export const weakSpotKey = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, WEAK_SPOT_MAX_CHARS);
const cleanText = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);
const projectKey = (name: string): string => name.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);

// ─── JSON ──────────────────────────────────────────────────────────────

export interface SessionJson {
    _id: string;
    key: string | null;
    kind: SessionKind;
    day: DayString;
    startedAt: string;
    endedAt: string | null;
    minutes: number | null;
    subject: { _id: string; name: string; color: string | null } | null;
    topic: { _id: string; title: string } | null;
    project: { _id: string; key: string; name: string } | null;
    title: string;
    score: { done: number; total: number } | null;
    outcome: PracticeOutcome | null;
    problem: string | null;
    url: string | null;
    nextStep: string | null;
    details: unknown;
    source: SessionSource;
    agentName: string | null;
    /** PERSONAL_OFFICE_PLAN: personal or work (its folder's). */
    area: SessionArea;
    createdAt: string;
    updatedAt: string;
}

const SESSION_INCLUDE = {
    subject: { select: { id: true, name: true, color: true } },
    topic: { select: { id: true, title: true, doc: { select: { title: true } } } },
    project: { select: { id: true, key: true, name: true } },
} as const;
type SessionRow = Prisma.WorkSessionGetPayload<{ include: typeof SESSION_INCLUDE }>;

export function serializeSession(r: SessionRow): SessionJson {
    return {
        _id: r.id,
        key: r.key,
        kind: r.kind,
        day: fromDbDay(r.day),
        startedAt: r.startedAt.toISOString(),
        endedAt: r.endedAt?.toISOString() ?? null,
        minutes: r.minutes,
        subject: r.subject ? { _id: r.subject.id, name: r.subject.name, color: r.subject.color } : null,
        topic: r.topic ? { _id: r.topic.id, title: r.topic.doc?.title || r.topic.title } : null,
        project: r.project ? { _id: r.project.id, key: r.project.key, name: r.project.name } : null,
        title: r.title,
        score: r.scoreDone !== null && r.scoreTotal !== null ? { done: r.scoreDone, total: r.scoreTotal } : null,
        outcome: r.outcome,
        problem: r.problem,
        url: r.url,
        nextStep: r.nextStep,
        details: r.details ?? null,
        source: r.source,
        agentName: r.agentName,
        area: r.area,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
    };
}

export interface WeakSpotJson {
    _id: string;
    text: string;
    source: WeakSpotSource;
    createdAt: string;
}

const weakSpotJson = (w: { id: string; text: string; source: WeakSpotSource; createdAt: Date }): WeakSpotJson => ({
    _id: w.id,
    text: w.text,
    source: w.source,
    createdAt: w.createdAt.toISOString(),
});

// ─── Weak spots ────────────────────────────────────────────────────────

export interface WeakSpotScope {
    topicId: string | null;
    subjectId: string | null;
}

/** Open these weak spots on a topic (else its subject); one already there opens again. */
export async function openWeakSpots(
    db: DbClient,
    userId: string,
    scope: WeakSpotScope,
    texts: readonly string[],
    meta: { sessionId?: string | null; source: WeakSpotSource }
): Promise<void> {
    for (const raw of texts) {
        const text = cleanText(raw, WEAK_SPOT_MAX_CHARS);
        if (!text) continue;
        const textKey = weakSpotKey(text);
        const where = scope.topicId ? { userId, topicId: scope.topicId, textKey } : { userId, topicId: null, subjectId: scope.subjectId, textKey };
        const found = await db.weakSpot.findFirst({ where, select: { id: true } });
        if (found) {
            await db.weakSpot.update({ where: { id: found.id }, data: { status: 'open', clearedAt: null, text }, select: { id: true } });
        } else {
            await db.weakSpot.create({
                data: { userId, topicId: scope.topicId, subjectId: scope.topicId ? null : scope.subjectId, text, textKey, source: meta.source, sessionId: meta.sessionId ?? null },
                select: { id: true },
            });
        }
    }
}

/** Clear weak spots by id (any of the user's) or by text (on this topic, else subject). */
export async function clearWeakSpots(db: DbClient, userId: string, scope: WeakSpotScope, items: readonly string[], now: Date): Promise<number> {
    let cleared = 0;
    for (const item of items) {
        const byId = await db.weakSpot.updateMany({ where: { id: item.trim(), userId, status: 'open' }, data: { status: 'cleared', clearedAt: now } });
        if (byId.count > 0) {
            cleared += byId.count;
            continue;
        }
        const textKey = weakSpotKey(item);
        if (!textKey || (!scope.topicId && !scope.subjectId)) continue;
        const where = scope.topicId ? { userId, topicId: scope.topicId, textKey, status: 'open' as const } : { userId, topicId: null, subjectId: scope.subjectId, textKey, status: 'open' as const };
        cleared += (await db.weakSpot.updateMany({ where, data: { status: 'cleared', clearedAt: now } })).count;
    }
    return cleared;
}

/** The open weak spots of these topics, oldest first. */
export async function openWeakSpotsOf(userId: string, topicIds: readonly string[], db: DbClient = prisma): Promise<Map<string, WeakSpotJson[]>> {
    const out = new Map<string, WeakSpotJson[]>();
    if (topicIds.length === 0) return out;
    const rows = await db.weakSpot.findMany({
        where: { userId, status: 'open', topicId: { in: [...topicIds] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, text: true, source: true, createdAt: true, topicId: true },
    });
    for (const r of rows) out.set(r.topicId!, [...(out.get(r.topicId!) ?? []), weakSpotJson(r)]);
    return out;
}

// ─── Projects ──────────────────────────────────────────────────────────

const PROJECT_FIELDS = { id: true, key: true, name: true, kind: true } as const;
type ProjectRef = { id: string; key: string; name: string; kind: ProjectKind };

/**
 * A project by key or name (case-insensitive), made when there is none: a new one takes `kindIfNew` (the PC's hint
 * for a folder the server has never seen), else personal. A known one keeps its kind (the app's choice wins).
 */
async function findOrMakeProject(db: DbClient, userId: string, nameOrKey: string, kindIfNew?: ProjectKind): Promise<ProjectRef> {
    const name = cleanText(nameOrKey, 120);
    if (!name) throw badRequest('project is empty');
    const key = projectKey(name);
    const found =
        (await db.project.findUnique({ where: { userId_key: { userId, key } }, select: PROJECT_FIELDS })) ??
        (await db.project.findFirst({ where: { userId, name: { equals: name, mode: 'insensitive' } }, select: PROJECT_FIELDS }));
    if (found) return found;
    try {
        return await db.project.create({ data: { userId, key, name, kind: kindIfNew ?? 'personal' }, select: PROJECT_FIELDS });
    } catch (err) {
        // Made at the same moment by another write.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            return db.project.findUniqueOrThrow({ where: { userId_key: { userId, key } }, select: PROJECT_FIELDS });
        }
        throw err;
    }
}


// ─── Writes ────────────────────────────────────────────────────────────

/** Who writes: the app (a cookie), or an agent token (a chat or a hook). */
export interface SessionWriter {
    userId: string;
    /** The agent of a token request; null for the app. */
    actor: AgentActor | null;
}

export interface SessionInput {
    kind?: SessionKind | undefined;
    /** The kind only when the row is new (a hook never overwrites a chat's kind). */
    kindIfNew?: SessionKind | undefined;
    title?: string | undefined;
    /**
     * A title only when the row has none worth keeping (the hook's first prompt): used for a new row
     * without a commit, or to replace a placeholder ("Session", "Worked on <project>").
     */
    titleIfNew?: string | undefined;
    minutes?: number | null | undefined;
    startedAt?: string | undefined;
    endedAt?: string | null | undefined;
    subjectId?: string | null | undefined;
    topicId?: string | null | undefined;
    /** A project's key or name: found, or made. null unlinks. */
    project?: string | null | undefined;
    /** The PC's hint for a folder the server has never seen (the hook's rule): its kind when it is made. */
    projectKind?: ProjectKind | undefined;
    score?: { done: number; total: number } | null | undefined;
    outcome?: PracticeOutcome | null | undefined;
    problem?: string | null | undefined;
    url?: string | null | undefined;
    nextStep?: string | null | undefined;
    details?: { branch?: string | undefined; commits?: string[] | undefined } | null | undefined;
    weakSpots?: string[] | undefined;
    cleared?: string[] | undefined;
    topicStatus?: TopicStatus | undefined;
    /** Tokens only: 'hook' for a Claude Code hook; else an agent. */
    source?: 'agent' | 'hook' | undefined;
    /** Notes about the user for the buddy (BUDDY_MEMORY_PLAN §3.1 B), tagged with the session's project and subject. */
    learned?: NoteInput[] | undefined;
}

export interface SessionWriteResult {
    session: SessionJson;
    /** The topic's line on its path, when the session names a topic. */
    topic: PathTopicJson | null;
    /** The open weak spots of the session's topic (else subject), after this write. */
    weakSpots: WeakSpotJson[];
    /** The id of the topic_update edit a topic change made (Undo), when there was one. */
    topicEditId: string | null;
    /** What became of `learned`: new memories, ones seen again, ones skipped (marked wrong, empty); null when none were sent. */
    learned: { saved: number; seen: number; skipped: number; paused: boolean } | null;
}

function checkScore(score: SessionInput['score']): { scoreDone: number | null; scoreTotal: number | null } | undefined {
    if (score === undefined) return undefined;
    if (score === null) return { scoreDone: null, scoreTotal: null };
    if (!Number.isInteger(score.done) || !Number.isInteger(score.total) || score.total < 1 || score.total > 100 || score.done < 0 || score.done > score.total) {
        throw badRequest('score needs done and total: whole numbers, 0 ≤ done ≤ total ≤ 100');
    }
    return { scoreDone: score.done, scoreTotal: score.total };
}

function checkDetails(details: SessionInput['details']): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
    if (details === undefined) return undefined;
    if (details === null) return Prisma.DbNull;
    const branch = typeof details.branch === 'string' ? cleanText(details.branch, 120) : undefined;
    const commits = (details.commits ?? []).map((c) => cleanText(String(c), 200)).filter(Boolean).slice(0, 10);
    return { ...(branch ? { branch } : {}), commits };
}

const validDate = (iso: string | undefined | null): Date | null => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * The kind of a new row that names none and has no `kindIfNew` (LOOP_COMPLETE_SPEC S1.1 #3):
 * practice when it has an outcome or a problem; study when it names a topic, a subject, a score or
 * weak spots; build when it names a project or is a Claude Code session (`cc_` key); else study.
 */
export function inferKind(key: string, input: Pick<SessionInput, 'outcome' | 'problem' | 'topicId' | 'subjectId' | 'score' | 'weakSpots' | 'project'>): SessionKind {
    if (input.outcome || input.problem) return 'practice';
    if (input.topicId || input.subjectId || input.score || input.weakSpots?.length) return 'study';
    if (input.project || key.startsWith('cc_')) return 'build';
    return 'study';
}

/** A checkpoint's minutes when it sends none (S1.1 #5): see FIRST_WRITE_CAP_MIN. */
export function estimateMinutes(existing: { minutes: number | null; updatedAt: Date } | null, startedAt: Date, now: Date): number {
    const since = (from: Date) => Math.round((now.getTime() - from.getTime()) / 60_000);
    if (!existing) return Math.min(FIRST_WRITE_CAP_MIN, Math.max(1, since(startedAt)));
    return Math.min(MINUTES_MAX, (existing.minutes ?? 0) + Math.min(GAP_CAP_MIN, Math.max(0, since(existing.updatedAt))));
}

export const URL_RE = /^https?:\/\/\S+$/i;

/** The topic and subject a write names (owned, live), checked against each other. */
async function resolveFiling(userId: string, input: Pick<SessionInput, 'topicId' | 'subjectId'>) {
    let topic: { id: string; subjectId: string; status: TopicStatus; nextStep: string | null } | null = null;
    if (input.topicId) {
        topic = await prisma.topic.findFirst({ where: { id: input.topicId, userId, isArchived: false }, select: { id: true, subjectId: true, status: true, nextStep: true } });
        if (!topic) throw badRequest(`No topic with id ${input.topicId} (get_path shows them)`, 'UNKNOWN_TOPIC');
    }
    let subjectId: string | null | undefined = input.subjectId;
    if (subjectId) {
        const owned = await prisma.subject.findFirst({ where: { id: subjectId, userId }, select: { id: true } });
        if (!owned) throw badRequest(`No subject with id ${subjectId}`, 'UNKNOWN_SUBJECT');
        if (topic && topic.subjectId !== subjectId) throw badRequest(`Topic ${topic.id} is not in that subject`, 'TOPIC_SUBJECT_MISMATCH');
    }
    if (topic && subjectId === undefined) subjectId = topic.subjectId;
    return { topic, subjectId };
}

/**
 * PUT /api/sessions/by-key/:key: make or change the session with this key. Fields sent replace,
 * fields left out stay. A new row without a kind is `study`. Everything is checked before anything
 * is written. Answers the session, its topic's path line and the open weak spots there.
 */
export async function upsertSessionByKey(writer: SessionWriter, key: string, input: SessionInput, now: Date = new Date()): Promise<SessionWriteResult> {
    if (!SESSION_KEY_RE.test(key)) throw badRequest('A session key is 1 to 80 letters, digits, _ . : or -', 'BAD_KEY');
    const { userId } = writer;
    const ctx = await loadLearningContext(userId, now);
    const filing = await resolveFiling(userId, input);
    const score = checkScore(input.score);
    const details = checkDetails(input.details);
    if (input.minutes !== undefined && input.minutes !== null && (!Number.isInteger(input.minutes) || input.minutes < 0 || input.minutes > MINUTES_MAX)) {
        throw badRequest(`minutes is a whole number from 0 to ${MINUTES_MAX}`);
    }
    if (input.weakSpots && input.weakSpots.length > WEAK_SPOTS_PER_WRITE) throw badRequest(`At most ${WEAK_SPOTS_PER_WRITE} weak spots at once`);
    if (input.url && !URL_RE.test(input.url.trim())) throw badRequest('url must start with http:// or https://');
    if (input.learned && input.learned.length > LEARNED_PER_WRITE) throw badRequest(`At most ${LEARNED_PER_WRITE} learned notes at once`);

    const existing = await prisma.workSession.findUnique({ where: { userId_key: { userId, key } } });
    const topicId = input.topicId === undefined ? existing?.topicId ?? null : filing.topic?.id ?? null;
    const subjectId = filing.subjectId === undefined ? existing?.subjectId ?? null : filing.subjectId ?? null;
    if ((input.weakSpots?.length || input.cleared?.length) && !topicId && !subjectId) throw badRequest('weakSpots and cleared need a topicId or a subject');
    if (input.topicStatus && !topicId) throw badRequest('topicStatus needs a topicId');

    const project = input.project === undefined ? undefined : input.project === null ? null : await findOrMakeProject(prisma, userId, input.project, input.projectKind);
    // The folder this session is in: the one named now, else the one it was already in.
    const folder: ProjectRef | null =
        project !== undefined ? project : existing?.projectId ? await prisma.project.findUnique({ where: { id: existing.projectId }, select: PROJECT_FIELDS }) : null;
    const work = folder?.kind === 'work';
    const source: SessionSource = writer.actor ? (input.source === 'hook' ? 'hook' : 'agent') : 'user';
    const startedAt = existing?.startedAt ?? validDate(input.startedAt) ?? keyStartedAt(key, now) ?? now;
    // A study folder's coding sessions are study, not build (PERSONAL_OFFICE_PLAN §2.1).
    const kindIfNew: SessionKind | undefined = folder?.kind === 'study' && (input.kindIfNew === undefined || input.kindIfNew === 'build') ? 'study' : input.kindIfNew;
    const kind: SessionKind = input.kind ?? existing?.kind ?? kindIfNew ?? (folder?.kind === 'study' ? 'study' : inferKind(key, { ...input, topicId, subjectId }));
    // A chat's checkpoint without minutes gets an estimate; the hook sends active minutes.
    const minutes = input.minutes !== undefined ? input.minutes : source === 'agent' ? estimateMinutes(existing, startedAt, now) : undefined;
    const endedAt = input.endedAt !== undefined ? validDate(input.endedAt) : source === 'agent' ? now : undefined;
    // A work folder's sessions keep no branch or commit subjects (company text), whatever the PC sent.
    const commits = work ? [] : (input.details?.commits?.filter(Boolean) ?? []);
    const keptDetails: typeof details = work && details !== undefined && input.details !== null ? { commits: [] } : details;
    const topicTitle = topicId ? (await prisma.topic.findUnique({ where: { id: topicId }, select: { title: true, doc: { select: { title: true } } } })) : null;
    // Order for a row without a title of its own: the first commit, the hook's first prompt, then
    // "Worked on <project>" or the topic. A placeholder from an earlier write gives way to a real one.
    // A work folder's hook session is titled by the folder, never by their words.
    const titleIfNew = work && source === 'hook' && folder ? folder.name : input.titleIfNew;
    const better = (commits[0] ? cleanText(commits[0], SESSION_TITLE_MAX) : '') || (titleIfNew ? cleanText(titleIfNew, SESSION_TITLE_MAX) : '');
    const placeholder = (t: string) => t === 'Session' || (!!project && t === `Worked on ${project.name}`);
    const title =
        input.title !== undefined
            ? cleanText(input.title, SESSION_TITLE_MAX)
            : existing
              ? placeholder(existing.title) && better
                  ? better
                  : existing.title
              : better || (project ? `Worked on ${project.name}` : topicTitle ? topicTitle.doc?.title || topicTitle.title : 'Session');
    if (!title) throw badRequest('title cannot be empty');

    const data = {
        kind,
        title,
        subjectId,
        topicId,
        ...(project !== undefined ? { projectId: project?.id ?? null, area: areaOfKind(project?.kind) } : {}),
        ...(minutes !== undefined ? { minutes } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
        ...(score ?? {}),
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.problem !== undefined ? { problem: input.problem === null ? null : cleanText(input.problem, 200) || null } : {}),
        ...(input.url !== undefined ? { url: input.url === null ? null : input.url.trim().slice(0, 500) || null } : {}),
        ...(input.nextStep !== undefined ? { nextStep: input.nextStep === null ? null : cleanText(input.nextStep, 300) || null } : {}),
        ...(keptDetails !== undefined ? { details: keptDetails } : {}),
        // A hook closing a session a chat wrote keeps the chat as its writer.
        ...(existing && source === 'hook' && existing.source !== 'hook'
            ? {}
            : { source, agentName: writer.actor?.agentName ?? existing?.agentName ?? null }),
    };

    // Writes select plain columns only (a write that includes 2+ relations runs parallel queries on
    // one connection); the full row is read once at the end.
    const ROW = { id: true, topicId: true, subjectId: true, projectId: true } as const;
    let row: { id: string; topicId: string | null; subjectId: string | null; projectId: string | null };
    try {
        row = existing
            ? await prisma.workSession.update({ where: { id: existing.id }, data, select: ROW })
            : await prisma.workSession.create({ data: { userId, key, startedAt, day: toDbDay(dayOf(startedAt, ctx.tz)), ...data }, select: ROW });
    } catch (err) {
        // Two first checkpoints at once: the other made the row; write over it.
        if (!existing && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            row = await prisma.workSession.update({ where: { userId_key: { userId, key } }, data, select: ROW });
        } else {
            throw err;
        }
    }

    if (!existing) poke('buddy'); // 11-22: a new session wakes the buddy's day (a checkpoint written again does not)
    const scope: WeakSpotScope = { topicId: row.topicId, subjectId: row.subjectId };
    if (input.weakSpots?.length) await openWeakSpots(prisma, userId, scope, input.weakSpots, { sessionId: row.id, source: 'session' });
    if (input.cleared?.length) await clearWeakSpots(prisma, userId, scope, input.cleared, now);
    // The project's next step follows a session that has no topic (a coding session's checkpoint),
    // whether this write or an earlier one named the project.
    if (row.projectId && input.nextStep !== undefined && !row.topicId) {
        await prisma.project.update({ where: { id: row.projectId }, data: { nextStep: input.nextStep === null ? null : cleanText(input.nextStep, 300) || null }, select: { id: true } });
    }

    // The topic moves along its path only when something changes (and a token's change is logged).
    let topic: PathTopicJson | null = null;
    let topicEditId: string | null = null;
    if (row.topicId) {
        const current = await prisma.topic.findUnique({ where: { id: row.topicId }, select: { status: true, nextStep: true, title: true, subjectId: true, startedAt: true, doneAt: true } });
        const nextStep = input.nextStep === undefined ? undefined : input.nextStep === null ? null : cleanText(input.nextStep, 300) || null;
        const statusChange = input.topicStatus !== undefined && input.topicStatus !== current?.status;
        const stepChange = nextStep !== undefined && nextStep !== current?.nextStep;
        if (current && (statusChange || stepChange)) {
            const before = {
                subjectId: current.subjectId,
                title: current.title,
                status: current.status,
                nextStep: current.nextStep,
                startedAt: current.startedAt?.toISOString() ?? null,
                doneAt: current.doneAt?.toISOString() ?? null,
                places: await pathPlaces(userId, current.subjectId),
            };
            const updated = await updateTopicOnPath(userId, row.topicId, { ...(statusChange ? { status: input.topicStatus } : {}), ...(stepChange ? { nextStep } : {}) }, now);
            topic = updated.topic;
            if (writer.actor) {
                const name = quoted(updated.topic.title);
                const summary = !statusChange ? `Set the next step of topic ${name}` : input.topicStatus === 'done' ? `Finished topic ${name}` : input.topicStatus === 'in_progress' ? `Started topic ${name}` : input.topicStatus === 'skipped' ? `Skipped topic ${name}` : `Updated topic ${name}`;
                topicEditId = await recordAgentEdit(writer.actor, { kind: 'topic_update', summary, entityId: row.topicId, undoData: { before } as Prisma.InputJsonValue });
            }
        }
        if (!topic) {
            const path = await prisma.topic.findUnique({ where: { id: row.topicId }, select: { subjectId: true } });
            if (path) topic = (await readPath(userId, path.subjectId)).topics.find((t) => t._id === row.topicId) ?? null;
        }
    }

    const open = row.topicId
        ? (await openWeakSpotsOf(userId, [row.topicId])).get(row.topicId) ?? []
        : row.subjectId
          ? (await prisma.weakSpot.findMany({ where: { userId, topicId: null, subjectId: row.subjectId, status: 'open' }, orderBy: { createdAt: 'asc' }, take: 20 })).map(weakSpotJson)
          : [];
    const fresh = await prisma.workSession.findUniqueOrThrow({ where: { id: row.id }, include: SESSION_INCLUDE });

    // The buddy's notes ride the checkpoint (no extra call), tagged with this session's project and subject.
    let learned: SessionWriteResult['learned'] = null;
    if (input.learned?.length) {
        const r = await rememberNotes(
            {
                userId,
                source: writer.actor ? 'agent' : 'app',
                agentName: writer.actor?.agentName ?? null,
                sessionKey: key,
                project: fresh.project?.key ?? null,
                tags: fresh.subject ? [fresh.subject.name] : [],
            },
            input.learned,
            now
        );
        learned = {
            saved: r.notes.filter((n) => n.status === 'saved').length,
            seen: r.notes.filter((n) => n.status === 'seen').length,
            skipped: r.paused ? input.learned.length : r.notes.filter((n) => n.status === 'wrong' || n.status === 'empty').length,
            paused: r.paused,
        };
    }
    return { session: serializeSession(fresh), topic, weakSpots: open, topicEditId, learned };
}

/** POST /api/sessions: a manual entry (no key), by the app. */
export async function createSession(userId: string, input: SessionInput & { title: string; day?: string | undefined }, now: Date = new Date()): Promise<SessionJson> {
    const ctx = await loadLearningContext(userId, now);
    const filing = await resolveFiling(userId, input);
    const title = cleanText(input.title, SESSION_TITLE_MAX);
    if (!title) throw badRequest('title cannot be empty');
    if (input.minutes !== undefined && input.minutes !== null && (!Number.isInteger(input.minutes) || input.minutes < 0 || input.minutes > MINUTES_MAX)) {
        throw badRequest(`minutes is a whole number from 0 to ${MINUTES_MAX}`);
    }
    const day = (input.day as DayString | undefined) ?? ctx.today;
    const project = input.project ? await findOrMakeProject(prisma, userId, input.project) : null;
    const made = await prisma.workSession.create({
        data: {
            userId,
            area: areaOfKind(project?.kind),
            kind: input.kind ?? 'study',
            title,
            day: toDbDay(day),
            startedAt: now,
            minutes: input.minutes ?? null,
            subjectId: filing.subjectId ?? null,
            topicId: filing.topic?.id ?? null,
            projectId: project?.id ?? null,
            ...(checkScore(input.score) ?? {}),
            outcome: input.outcome ?? null,
            problem: input.problem ? cleanText(input.problem, 200) : null,
            source: 'user',
        },
        select: { id: true },
    });
    poke('buddy'); // 11-22: the buddy's day reacts to what they do
    return serializeSession(await prisma.workSession.findUniqueOrThrow({ where: { id: made.id }, include: SESSION_INCLUDE }));
}

/** PATCH /api/sessions/:id: the user corrects an entry (any writer's). */
export async function updateSession(
    userId: string,
    id: string,
    patch: { title?: string | undefined; minutes?: number | null | undefined; kind?: SessionKind | undefined; day?: string | undefined; nextStep?: string | null | undefined }
): Promise<SessionJson> {
    const row = await prisma.workSession.findFirst({ where: { id, userId }, select: { id: true } });
    if (!row) throw notFound();
    const title = patch.title !== undefined ? cleanText(patch.title, SESSION_TITLE_MAX) : undefined;
    if (title !== undefined && !title) throw badRequest('title cannot be empty');
    if (patch.minutes !== undefined && patch.minutes !== null && (!Number.isInteger(patch.minutes) || patch.minutes < 0 || patch.minutes > MINUTES_MAX)) {
        throw badRequest(`minutes is a whole number from 0 to ${MINUTES_MAX}`);
    }
    await prisma.workSession.update({
        where: { id },
        data: {
            ...(title !== undefined ? { title } : {}),
            ...(patch.minutes !== undefined ? { minutes: patch.minutes } : {}),
            ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
            ...(patch.day !== undefined ? { day: toDbDay(patch.day as DayString) } : {}),
            ...(patch.nextStep !== undefined ? { nextStep: patch.nextStep === null ? null : cleanText(patch.nextStep, 300) || null } : {}),
        },
        select: { id: true },
    });
    return serializeSession(await prisma.workSession.findUniqueOrThrow({ where: { id }, include: SESSION_INCLUDE }));
}

/** DELETE /api/sessions/:id. Weak spots it opened stay (they are about the topic, not the entry). */
export async function deleteSession(userId: string, id: string): Promise<{ deleted: true }> {
    const { count } = await prisma.workSession.deleteMany({ where: { id, userId } });
    if (count === 0) throw notFound();
    return { deleted: true };
}

// ─── Reads ─────────────────────────────────────────────────────────────

export interface SessionDayTotal {
    day: DayString;
    /** Minutes per kind (sessions without minutes count 0). */
    minutes: Record<SessionKind, number>;
    count: number;
}

export interface SessionList {
    sessions: SessionJson[];
    /** One per day that has sessions, newest first. */
    days: SessionDayTotal[];
}

/** GET /api/sessions: the last `days` local days (today included), newest first. */
export async function listSessions(
    userId: string,
    options: { days?: number | undefined; kind?: SessionKind | undefined; project?: string | undefined; subjectId?: string | undefined; lens?: Lens | undefined } = {},
    now: Date = new Date()
): Promise<SessionList> {
    const ctx = await loadLearningContext(userId, now);
    const days = Math.min(Math.max(Math.trunc(options.days ?? 14), 1), 90);
    const from = addDays(ctx.today, -(days - 1));
    const project = options.project
        ? await prisma.project.findFirst({ where: { userId, OR: [{ id: options.project }, { key: projectKey(options.project) }, { name: { equals: options.project.trim(), mode: 'insensitive' } }] }, select: { id: true } })
        : null;
    if (options.project && !project) return { sessions: [], days: [] };
    const rows = await prisma.workSession.findMany({
        where: {
            userId,
            day: { gte: toDbDay(from), lte: toDbDay(ctx.today) },
            ...(options.kind ? { kind: options.kind } : {}),
            ...(project ? { projectId: project.id } : {}),
            ...(options.subjectId ? { subjectId: options.subjectId } : {}),
            ...sessionsOf(options.lens ?? 'all'),
        },
        orderBy: [{ day: 'desc' }, { startedAt: 'desc' }, { id: 'desc' }],
        take: LIST_LIMIT,
        include: SESSION_INCLUDE,
    });
    const byDay = new Map<DayString, SessionDayTotal>();
    for (const r of rows) {
        const day = fromDbDay(r.day);
        const total = byDay.get(day) ?? { day, minutes: { study: 0, practice: 0, build: 0, review: 0 }, count: 0 };
        total.minutes[r.kind] += r.minutes ?? 0;
        total.count += 1;
        byDay.set(day, total);
    }
    return { sessions: rows.map(serializeSession), days: [...byDay.values()] };
}

/** Days with a session in [from, to] that the lens sees (the rhythm counts them as active: the progress lens). */
export async function sessionDays(userId: string, from: DayString, to: DayString, lens: Lens, db: DbClient = prisma): Promise<DayString[]> {
    const rows = await db.workSession.findMany({ where: { userId, day: { gte: toDbDay(from), lte: toDbDay(to) }, ...sessionsOf(lens) }, select: { day: true }, distinct: ['day'] });
    return rows.map((r) => fromDbDay(r.day));
}

export interface ProjectJson {
    _id: string;
    key: string;
    name: string;
    /** PERSONAL_OFFICE_PLAN: personal, study or work (Settings › Tracking). */
    kind: ProjectKind;
    goal: { _id: string; title: string } | null;
    nextStep: string | null;
    isArchived: boolean;
    lastSession: { day: DayString; minutes: number | null; title: string } | null;
    sessions: number;
    /** Minutes logged in it over the last 28 days (today included). */
    minutes28: number;
}

/** How many days `minutes28` covers. */
export const PROJECT_RECENT_DAYS = 28;

/** GET /api/projects: newest activity first. */
export async function listProjects(userId: string, now: Date = new Date()): Promise<ProjectJson[]> {
    const { today } = await loadLearningContext(userId, now);
    const [rows, recent] = await Promise.all([
        prisma.project.findMany({
            where: { userId },
            include: {
                goal: { select: { id: true, title: true } },
                sessions: { orderBy: [{ day: 'desc' }, { startedAt: 'desc' }], take: 1, select: { day: true, minutes: true, title: true } },
                _count: { select: { sessions: true } },
            },
        }),
        prisma.workSession.groupBy({
            by: ['projectId'],
            where: { userId, projectId: { not: null }, day: { gte: toDbDay(addDays(today, -(PROJECT_RECENT_DAYS - 1))), lte: toDbDay(today) } },
            _sum: { minutes: true },
        }),
    ]);
    const minutes = new Map(recent.map((r) => [r.projectId, r._sum.minutes ?? 0]));
    const json = rows.map(
        (p): ProjectJson => ({
            _id: p.id,
            key: p.key,
            name: p.name,
            kind: p.kind,
            goal: p.goal ? { _id: p.goal.id, title: p.goal.title } : null,
            nextStep: p.nextStep,
            isArchived: p.isArchived,
            lastSession: p.sessions[0] ? { day: fromDbDay(p.sessions[0].day), minutes: p.sessions[0].minutes, title: p.sessions[0].title } : null,
            sessions: p._count.sessions,
            minutes28: minutes.get(p.id) ?? 0,
        })
    );
    return json.sort((a, b) => (b.lastSession?.day ?? '').localeCompare(a.lastSession?.day ?? '') || a.name.localeCompare(b.name));
}

/** The project of a folder (its key), with its last session. */
export async function projectByKey(userId: string, key: string): Promise<ProjectJson | null> {
    const found = await prisma.project.findFirst({ where: { userId, key: projectKey(key) }, select: { id: true } });
    if (!found) return null;
    return (await listProjects(userId)).find((p) => p._id === found.id) ?? null;
}

/**
 * A folder's new kind moves its past with it (PERSONAL_OFFICE_PLAN §2.1), in the caller's transaction: its sessions'
 * area; its hook sessions between build and study (a chat's own kind stays); its work log lines' office mark.
 */
async function moveFolderPast(tx: DbClient, userId: string, project: { id: string; key: string }, from: ProjectKind, to: ProjectKind): Promise<void> {
    await tx.workSession.updateMany({ where: { userId, projectId: project.id }, data: { area: areaOfKind(to) } });
    const codingKind = (k: ProjectKind): SessionKind => (k === 'study' ? 'study' : 'build');
    if (codingKind(from) !== codingKind(to)) {
        await tx.workSession.updateMany({ where: { userId, projectId: project.id, source: 'hook', kind: codingKind(from) }, data: { kind: codingKind(to) } });
    }
    if ((from === 'work') !== (to === 'work')) {
        await tx.workLine.updateMany({ where: { userId, project: project.key }, data: { office: to === 'work' } });
    }
}

/** PATCH /api/projects/:id: rename, link a goal, archive, set the next step, or its kind (personal, study, work). */
export async function updateProject(
    userId: string,
    id: string,
    patch: { name?: string | undefined; goalId?: string | null | undefined; isArchived?: boolean | undefined; nextStep?: string | null | undefined; kind?: ProjectKind | undefined }
): Promise<ProjectJson> {
    const row = await prisma.project.findFirst({ where: { id, userId }, select: { id: true, key: true, kind: true } });
    if (!row) throw notFound();
    if (patch.goalId) {
        const goal = await prisma.goal.findFirst({ where: { id: patch.goalId, userId }, select: { id: true } });
        if (!goal) throw badRequest('No goal with that id');
    }
    const name = patch.name !== undefined ? cleanText(patch.name, 120) : undefined;
    if (name !== undefined && !name) throw badRequest('name cannot be empty');
    const kindChange = patch.kind !== undefined && patch.kind !== row.kind ? patch.kind : undefined;
    await prisma.$transaction(async (tx) => {
        await tx.project.update({
            where: { id },
            data: {
                ...(name !== undefined ? { name } : {}),
                ...(patch.goalId !== undefined ? { goalId: patch.goalId } : {}),
                ...(patch.isArchived !== undefined ? { isArchived: patch.isArchived } : {}),
                ...(patch.nextStep !== undefined ? { nextStep: patch.nextStep === null ? null : cleanText(patch.nextStep, 300) || null } : {}),
                ...(kindChange ? { kind: kindChange } : {}),
            },
            select: { id: true },
        });
        if (kindChange) await moveFolderPast(tx, userId, row, row.kind, kindChange);
    });
    // What counts changed: the buddy's day hears it (as it hears a session logged).
    if (kindChange) poke('buddy');
    return (await listProjects(userId)).find((p) => p._id === id)!;
}

// ─── Recall ↔ weak spots (no model call of its own) ───────────────────

/**
 * After a Recall answer: a strong answer (or "Knew it") to a question about a weak spot clears it;
 * a weak answer opens one on the topic (the question's words), unless the question was about one.
 */
export async function weakSpotsAfterAnswer(
    userId: string,
    topicId: string | null,
    question: { prompt: string; weakSpotId?: string | undefined },
    grade: 'strong' | 'partial' | 'weak',
    now: Date = new Date()
): Promise<void> {
    if (!topicId) return;
    if (grade === 'strong' && question.weakSpotId) {
        await prisma.weakSpot.updateMany({ where: { id: question.weakSpotId, userId, topicId, status: 'open' }, data: { status: 'cleared', clearedAt: now } });
    } else if (grade === 'weak' && !question.weakSpotId) {
        await openWeakSpots(prisma, userId, { topicId, subjectId: null }, [question.prompt.slice(0, WEAK_SPOT_MAX_CHARS)], { source: 'recall' });
    }
}

/** The newest session of each of these topics (the brief's "last time on this"). */
export async function lastSessionsOf(userId: string, topicIds: readonly string[]): Promise<Map<string, SessionJson>> {
    const out = new Map<string, SessionJson>();
    if (topicIds.length === 0) return out;
    const rows = await prisma.workSession.findMany({
        where: { userId, topicId: { in: [...topicIds] } },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        distinct: ['topicId'],
        include: SESSION_INCLUDE,
    });
    for (const r of rows) if (r.topicId) out.set(r.topicId, serializeSession(r));
    return out;
}
