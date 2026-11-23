// Learning (Revise dashboard) rows → the JSON of LEARNING_SPEC §2.
//
// Conventions: `_id` at the top level only (Json columns such as attachments pass through
// untouched), `@db.Date` columns as 'YYYY-MM-DD' (dayFromUtcMidnight), instants as Dates (Express
// writes ISO strings).
import type {
    Capture,
    DailyScheduleSlot,
    DayDebrief,
    FocusItem,
    Goal,
    GoalMilestone,
    NewFolders,
    Prisma,
    QuickNote,
    Revision,
    RoutineMode,
    Subject,
    TimeBlock,
    Topic,
} from '@prisma/client';
import { dayFromUtcMidnight, type DayString } from '../../services/learning/time';
import type { GoalForecast } from '../../services/learning/goalForecast';

const dayOrNull = (d: Date | null): DayString | null => (d ? dayFromUtcMidnight(d) : null);

/**
 * Provenance of goals, milestones and focus lines: `{ createdBy: 'agent', agentName }` when an
 * agent (access token) created the row; nothing at all for the user's own rows, so their JSON is
 * exactly what it was before agents existed.
 */
export function provenanceOf(row: { createdBy?: string | null; agentName?: string | null }): { createdBy?: 'agent'; agentName?: string | null } {
    return row.createdBy === 'agent' ? { createdBy: 'agent', agentName: row.agentName ?? null } : {};
}

/** Json attachments column → an array (anything else → []). */
export function attachmentsOf(value: Prisma.JsonValue): Prisma.JsonArray {
    return Array.isArray(value) ? value : [];
}

// ─── Subjects ──────────────────────────────────────────────────────────

export interface SubjectRefJson {
    _id: string;
    name: string;
    color: string | null;
}

export function serializeSubjectRef(s: Pick<Subject, 'id' | 'name' | 'color'> | null | undefined): SubjectRefJson | null {
    return s ? { _id: s.id, name: s.name, color: s.color } : null;
}

export function serializeSubject(s: Subject) {
    return {
        _id: s.id,
        name: s.name,
        description: s.description,
        icon: s.icon,
        color: s.color,
        lastActiveAt: s.lastActiveAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
    };
}

// ─── Topics ────────────────────────────────────────────────────────────

/** A topic's title: its doc's title when it has a doc, else the stored title. */
export function topicTitle(t: Pick<Topic, 'title'>, docTitle: string | null | undefined): string {
    return docTitle ?? t.title;
}

export function serializeTopic(t: Topic, docTitle: string | null | undefined) {
    return {
        _id: t.id,
        subjectId: t.subjectId,
        docId: t.docId,
        title: topicTitle(t, docTitle),
        tags: t.tags,
        sortOrder: t.sortOrder,
        isArchived: t.isArchived,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
    };
}

// ─── Revisions ─────────────────────────────────────────────────────────

/** One cycle of a chain: { _id, cycleNumber, intervalDays, scheduledFor, status, completedAt }. */
export function serializeChainRevision(r: Pick<Revision, 'id' | 'cycleNumber' | 'intervalDays' | 'scheduledFor' | 'status' | 'completedAt'>) {
    return {
        _id: r.id,
        cycleNumber: r.cycleNumber,
        intervalDays: r.intervalDays,
        scheduledFor: dayFromUtcMidnight(r.scheduledFor),
        status: r.status,
        completedAt: r.completedAt,
    };
}

export type ChainRevisionJson = ReturnType<typeof serializeChainRevision>;

export function serializeChain(rows: ReadonlyArray<Parameters<typeof serializeChainRevision>[0]>): ChainRevisionJson[] {
    return [...rows].sort((a, b) => a.cycleNumber - b.cycleNumber).map(serializeChainRevision);
}

/** What a RevisionItem needs about its topic or capture. */
export interface RevisionItemSource {
    topic: (Pick<Topic, 'id' | 'title' | 'tags' | 'docId'> & {
        doc: { title: string } | null;
        subject: Pick<Subject, 'id' | 'name' | 'color'> | null;
    }) | null;
    capture: (Pick<Capture, 'id' | 'title' | 'content' | 'url' | 'attachments' | 'category'> & {
        subject: Pick<Subject, 'id' | 'name' | 'color'> | null;
    }) | null;
}

/** Revise's capture label: title, else the first 50 characters of the content, else 'Capture'. */
export function captureTitle(c: Pick<Capture, 'title' | 'content'>): string {
    return c.title?.trim() || c.content?.trim().slice(0, 50).trimEnd() || 'Capture';
}

export interface RevisionItemExtras {
    /** overdue bucket only */
    daysLate?: number;
    /** done revisions only: no later cycle of the item is done */
    canUndo?: boolean;
    /** plan items only (loop v2): estimated minutes (cycle 1 = 8, otherwise 5) */
    minutes?: number;
}

/**
 * RevisionItem: { _id, kind, itemId, title, subject|null, cycleNumber, intervalDays, scheduledFor,
 * status, completedAt, daysLate?, tags, docId (topic) | content, url, attachments (capture), canUndo? }.
 * A capture's `tags` is its category ([] without one).
 */
export function serializeRevisionItem(
    r: Pick<Revision, 'id' | 'cycleNumber' | 'intervalDays' | 'scheduledFor' | 'status' | 'completedAt'>,
    source: RevisionItemSource,
    extras: RevisionItemExtras = {}
) {
    const base = {
        _id: r.id,
        cycleNumber: r.cycleNumber,
        intervalDays: r.intervalDays,
        scheduledFor: dayFromUtcMidnight(r.scheduledFor),
        status: r.status,
        completedAt: r.completedAt,
        ...(extras.daysLate !== undefined ? { daysLate: extras.daysLate } : {}),
        ...(extras.canUndo !== undefined ? { canUndo: extras.canUndo } : {}),
        ...(extras.minutes !== undefined ? { minutes: extras.minutes } : {}),
    };
    if (source.topic) {
        const t = source.topic;
        return {
            ...base,
            kind: 'topic' as const,
            itemId: t.id,
            title: topicTitle(t, t.doc?.title),
            subject: serializeSubjectRef(t.subject),
            tags: t.tags,
            docId: t.docId,
        };
    }
    const c = source.capture;
    return {
        ...base,
        kind: 'capture' as const,
        itemId: c?.id ?? '',
        title: c ? captureTitle(c) : 'Capture',
        subject: serializeSubjectRef(c?.subject),
        tags: c?.category ? [c.category] : [],
        content: c?.content ?? null,
        url: c?.url ?? null,
        attachments: c ? attachmentsOf(c.attachments) : [],
    };
}

// ─── Captures, quick notes ─────────────────────────────────────────────

export function serializeCapture(c: Capture, subject: Pick<Subject, 'id' | 'name' | 'color'> | null | undefined) {
    return {
        _id: c.id,
        type: c.type,
        title: c.title,
        content: c.content,
        url: c.url,
        fileType: c.fileType,
        category: c.category,
        isPinned: c.isPinned,
        subject: serializeSubjectRef(subject),
        topicId: c.topicId,
        attachments: attachmentsOf(c.attachments),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
    };
}

export function serializeQuickNote(n: QuickNote) {
    return {
        _id: n.id,
        content: n.content,
        isPinned: n.isPinned,
        category: n.category,
        attachments: attachmentsOf(n.attachments),
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
    };
}

// ─── Schedule ──────────────────────────────────────────────────────────

export function serializeSlot(s: DailyScheduleSlot) {
    return {
        _id: s.id,
        sourceBlockId: s.sourceBlockId,
        date: dayFromUtcMidnight(s.date),
        title: s.title,
        color: s.color,
        startTime: s.startTime,
        endTime: s.endTime,
        status: s.status,
        actualStartTime: s.actualStartTime,
        actualEndTime: s.actualEndTime,
        remark: s.remark,
        minutesDone: s.minutesDone,
        sortOrder: s.sortOrder,
    };
}

export type SlotJson = ReturnType<typeof serializeSlot>;

export function serializeDebrief(d: DayDebrief) {
    return {
        _id: d.id,
        date: dayFromUtcMidnight(d.date),
        blocksPlanned: d.blocksPlanned,
        blocksCompleted: d.blocksCompleted,
        blocksSkipped: d.blocksSkipped,
        totalFocusedMin: d.totalFocusedMin,
        energy: d.energy,
        focus: d.focus,
        mood: d.mood,
        tags: d.tags,
        narrative: d.narrative,
        tomorrowIntent: d.tomorrowIntent,
        freeWrite: d.freeWrite,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
    };
}

export type DebriefJson = ReturnType<typeof serializeDebrief>;

export function serializeTimeBlock(b: TimeBlock) {
    return {
        _id: b.id,
        title: b.title,
        startTime: b.startTime,
        endTime: b.endTime,
        color: b.color,
        dayOfWeek: b.dayOfWeek,
        date: dayOrNull(b.date),
        createdAt: b.createdAt,
    };
}

// ─── Daily loop v2 (LOOP_V2_SPEC) ──────────────────────────────────────

/** §1 Settings: GET/PATCH /api/learning/settings. */
export function serializeLearningSettings(u: {
    timezone: string;
    routineMode: RoutineMode;
    dailyBudgetMin: number;
    routineEnabled: boolean;
    busyUntil: Date | null;
    nudgeEmailEnabled: boolean;
    nudgeTime: string;
    lastNudgeDay: Date | null;
    lastSeenDay: Date | null;
    agentProfile?: string | null;
    progressIncludesWork?: boolean;
    newFolders?: NewFolders;
}) {
    return {
        agentProfile: u.agentProfile ?? null,
        /** PERSONAL_OFFICE_PLAN: work counts as progress too (off: personal only). */
        progressIncludesWork: u.progressIncludesWork === true,
        /** EASY_SETUP_PLAN: what a folder the server has never seen is (ask: the agent asks once). */
        newFolders: u.newFolders ?? 'ask',
        dailyBudgetMin: u.dailyBudgetMin,
        routineEnabled: u.routineEnabled,
        busyUntil: dayOrNull(u.busyUntil),
        nudgeEmailEnabled: u.nudgeEmailEnabled,
        nudgeTime: u.nudgeTime,
        lastNudgeDay: dayOrNull(u.lastNudgeDay),
        lastSeenDay: dayOrNull(u.lastSeenDay),
        timezone: u.timezone,
        routineMode: u.routineMode,
    };
}

export type LearningSettingsJson = ReturnType<typeof serializeLearningSettings>;

/** §3 FocusItem: { _id, day, text, done, sortOrder, createdAt }. */
export function serializeFocusItem(f: FocusItem) {
    return {
        _id: f.id,
        day: dayFromUtcMidnight(f.day),
        text: f.text,
        done: f.done,
        sortOrder: f.sortOrder,
        createdAt: f.createdAt,
        ...provenanceOf(f),
    };
}

export type FocusItemJson = ReturnType<typeof serializeFocusItem>;

/** §4 GoalMilestone: { _id, goalId, title, dueDay, done, doneAt, sortOrder }. */
export function serializeMilestone(m: GoalMilestone) {
    return {
        _id: m.id,
        goalId: m.goalId,
        title: m.title,
        dueDay: dayOrNull(m.dueDay),
        done: m.done,
        doneAt: m.doneAt,
        sortOrder: m.sortOrder,
        ...provenanceOf(m),
    };
}

export type MilestoneJson = ReturnType<typeof serializeMilestone>;

/** A goal with its milestones (sortOrder order) and linked subjects, as the goals service loads it. */
export type GoalWithRelations = Goal & {
    milestones: GoalMilestone[];
    subjects: Array<{ subject: Pick<Subject, 'id' | 'name' | 'color'> }>;
};

/** The first milestone not done yet (milestones in sortOrder order), or null. */
export function nextMilestoneOf(milestones: readonly GoalMilestone[]): MilestoneJson | null {
    const next = milestones.find((m) => !m.done);
    return next ? serializeMilestone(next) : null;
}

/**
 * §4 Goal (GET/POST/PATCH /api/goals): every field, the subjects, the milestones, and the forecast
 * (daysLeft and progress repeated at the top level, as in GET /api/today's goals).
 */
export function serializeGoal(g: GoalWithRelations, forecast: GoalForecast) {
    return {
        _id: g.id,
        title: g.title,
        why: g.why,
        deadline: dayFromUtcMidnight(g.deadline),
        status: g.status,
        subjects: g.subjects.map((s) => serializeSubjectRef(s.subject)!),
        milestones: g.milestones.map(serializeMilestone),
        daysLeft: forecast.daysLeft,
        progress: forecast.progress,
        forecast,
        nextMilestone: nextMilestoneOf(g.milestones),
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        ...provenanceOf(g),
    };
}

export type GoalJson = ReturnType<typeof serializeGoal>;

/** §4 GET /api/today goals[]: { _id, title, deadline, daysLeft, progress, forecast, nextMilestone }. */
export function serializeTodayGoal(
    g: Pick<Goal, 'id' | 'title' | 'deadline'> & Partial<Pick<Goal, 'createdBy' | 'agentName'>> & { milestones: GoalMilestone[] },
    forecast: GoalForecast
) {
    return {
        _id: g.id,
        title: g.title,
        deadline: dayFromUtcMidnight(g.deadline),
        daysLeft: forecast.daysLeft,
        progress: forecast.progress,
        forecast,
        nextMilestone: nextMilestoneOf(g.milestones),
        ...provenanceOf(g),
    };
}
