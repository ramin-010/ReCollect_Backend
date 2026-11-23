// Revisions (LEARNING_SPEC §2 #4–7): start, complete, uncomplete ("Unmark"), reschedule.
//
// Write paths (one transaction each): lock the user row and the item's chain rows FOR UPDATE, run
// the engine, apply its patches, then the streak side effects (global + subject streak +
// DailyHistory). Completions store the engine's CompletionUndo on the revision so an undo
// restores the later cycles' dates exactly; the streak snapshots make the same-day undo exact.
// Responses are loaded after the commit (relation includes never run on the tx client).
import { Prisma } from '@prisma/client';
import type { Revision as RevisionRow } from '@prisma/client';
import { prisma, type TxClient } from '../../db/prisma';
import { isUniqueViolation } from '../../db/errors';
import {
    completeRevision,
    rescheduleRevision,
    startRevisions,
    streakEffectsOfCompletion,
    streakEffectsOfUncompletion,
    uncompleteRevision,
    type DailyHistoryEntry,
    type DayString,
    type RevisionPatch,
    type StreakState,
    type SubjectStreakInput,
} from '../learning';
import { LearningError } from '../learning/errors';
import { badRequest, notFound } from '../learning/http';
import {
    serializeChain,
    serializeRevisionItem,
    type ChainRevisionJson,
    type RevisionItemSource,
} from '../../db/serializers/learning';
import {
    dayRange,
    fromDbDay,
    globalStreakData,
    globalStreakOf,
    loadLearningContext,
    lockLearningContext,
    sameStreak,
    subjectStreakData,
    subjectStreakOf,
    toDbDay,
    toEngineRevision,
    undoJson,
    parseUndo,
    type LearningContext,
} from './common';
import { ensureLearningRollover } from './rollover.service';
import { poke } from '../scheduler/scheduler';

// ─── Shared reads ──────────────────────────────────────────────────────

const subjectRefSelect = { id: true, name: true, color: true } as const;

/** What serializeRevisionItem needs; read on the root client only (2 relations). */
export const revisionItemInclude = {
    topic: { select: { id: true, title: true, tags: true, docId: true, doc: { select: { title: true, cardBlockId: true } }, subject: { select: subjectRefSelect } } },
    capture: { select: { id: true, title: true, content: true, url: true, attachments: true, category: true, subject: { select: subjectRefSelect } } },
} satisfies Prisma.RevisionInclude;

export type RevisionWithItem = Prisma.RevisionGetPayload<{ include: typeof revisionItemInclude }>;

export const itemSource = (r: RevisionWithItem): RevisionItemSource => ({ topic: r.topic, capture: r.capture });

const chainWhere = (r: Pick<RevisionRow, 'topicId' | 'captureId'>): Prisma.RevisionWhereInput =>
    r.topicId ? { topicId: r.topicId } : { captureId: r.captureId };

/** The serialized RevisionItem + chain of one revision, read after a write. */
async function loadItemAndChain(revisionId: string): Promise<{ item: ReturnType<typeof serializeRevisionItem>; chain: ChainRevisionJson[] }> {
    const row = await prisma.revision.findUniqueOrThrow({ where: { id: revisionId }, include: revisionItemInclude });
    const chainRows = await prisma.revision.findMany({ where: chainWhere(row), orderBy: { cycleNumber: 'asc' } });
    const laterDone = chainRows.some((r) => r.cycleNumber > row.cycleNumber && r.status === 'done');
    const extras = row.status === 'done' ? { canUndo: !laterDone } : {};
    return { item: serializeRevisionItem(row, itemSource(row), extras), chain: serializeChain(chainRows) };
}

/** The user's revision (404 otherwise) and its whole chain, rows locked FOR UPDATE. */
async function lockChain(tx: TxClient, userId: string, revisionId: string): Promise<{ target: RevisionRow; chain: RevisionRow[] }> {
    const target = await tx.revision.findFirst({ where: { id: revisionId, userId } });
    if (!target) throw notFound();
    if (target.topicId) {
        await tx.$queryRaw`SELECT "id" FROM "Revision" WHERE "topicId" = ${target.topicId} FOR UPDATE`;
    } else {
        await tx.$queryRaw`SELECT "id" FROM "Revision" WHERE "captureId" = ${target.captureId} FOR UPDATE`;
    }
    const chain = await tx.revision.findMany({ where: chainWhere(target), orderBy: { cycleNumber: 'asc' } });
    const locked = chain.find((r) => r.id === revisionId) ?? target;
    return { target: locked, chain };
}

async function applyPatches(tx: TxClient, patches: readonly RevisionPatch[], extra: Map<string, Prisma.RevisionUpdateInput> = new Map()): Promise<void> {
    const ids = new Set([...patches.map((p) => p.id), ...extra.keys()]);
    for (const id of ids) {
        const data: Prisma.RevisionUpdateInput = { ...(extra.get(id) ?? {}) };
        for (const p of patches) {
            if (p.id !== id) continue;
            if (p.status !== undefined) data.status = p.status;
            if (p.completedAt !== undefined) data.completedAt = p.completedAt;
            if (p.scheduledFor !== undefined) data.scheduledFor = toDbDay(p.scheduledFor);
        }
        await tx.revision.update({ where: { id }, data, select: { id: true } });
    }
}

async function subjectIdOf(tx: TxClient, r: Pick<RevisionRow, 'topicId' | 'captureId'>): Promise<string | null> {
    if (r.topicId) return (await tx.topic.findUnique({ where: { id: r.topicId }, select: { subjectId: true } }))?.subjectId ?? null;
    if (r.captureId) return (await tx.capture.findUnique({ where: { id: r.captureId }, select: { subjectId: true } }))?.subjectId ?? null;
    return null;
}

const ofSubject = (subjectId: string): Prisma.RevisionWhereInput => ({
    OR: [{ topic: { subjectId } }, { capture: { subjectId } }],
});

/** Pending revisions scheduled on or before `day` (all, or one subject's). */
function countPendingDue(tx: TxClient, userId: string, day: DayString, subjectId?: string): Promise<number> {
    return tx.revision.count({
        where: { userId, status: 'pending', scheduledFor: { lte: toDbDay(day) }, ...(subjectId ? ofSubject(subjectId) : {}) },
    });
}

/** Revisions completed on `day` in the user's zone (all, or one subject's). */
function countCompletedOn(tx: TxClient, userId: string, day: DayString, tz: string, subjectId?: string): Promise<number> {
    return tx.revision.count({
        where: { userId, status: 'done', completedAt: dayRange(day, tz), ...(subjectId ? ofSubject(subjectId) : {}) },
    });
}

async function loadSubjectState(tx: TxClient, userId: string, subjectId: string, day: DayString) {
    const streakRow = await tx.subjectStreak.findUnique({ where: { userId_subjectId: { userId, subjectId } } });
    const historyRow = await tx.dailyHistory.findUnique({ where: { userId_subjectId_date: { userId, subjectId, date: toDbDay(day) } } });
    const history: DailyHistoryEntry | null = historyRow
        ? {
              subjectId,
              day: fromDbDay(historyRow.date),
              revisionsDue: historyRow.revisionsDue,
              revisionsDone: historyRow.revisionsDone,
              streakMaintained: historyRow.streakMaintained,
          }
        : null;
    return { streak: streakRow ? subjectStreakOf(streakRow) : null, history, historyExists: historyRow !== null };
}

async function writeGlobal(tx: TxClient, ctx: LearningContext, next: StreakState): Promise<void> {
    if (sameStreak(globalStreakOf(ctx.user), next)) return;
    await tx.user.update({ where: { id: ctx.user.id }, data: globalStreakData(next), select: { id: true } });
}

async function writeSubjectStreak(tx: TxClient, userId: string, subjectId: string, before: StreakState | null, next: StreakState | null): Promise<void> {
    if (!next || (before && sameStreak(before, next))) return;
    const data = subjectStreakData(next);
    await tx.subjectStreak.upsert({
        where: { userId_subjectId: { userId, subjectId } },
        create: { userId, subjectId, ...data },
        update: data,
        select: { userId: true },
    });
}

async function writeHistory(tx: TxClient, userId: string, subjectId: string, day: DayString, existed: boolean, next: DailyHistoryEntry | null): Promise<void> {
    const where = { userId_subjectId_date: { userId, subjectId, date: toDbDay(day) } };
    if (next === null) {
        if (existed) await tx.dailyHistory.delete({ where, select: { id: true } });
        return;
    }
    const data = { revisionsDue: next.revisionsDue, revisionsDone: next.revisionsDone, streakMaintained: next.streakMaintained };
    await tx.dailyHistory.upsert({
        where,
        create: { userId, subjectId, date: toDbDay(next.day), ...data },
        update: data,
        select: { id: true },
    });
}

export interface StreakJson {
    current: number;
    longest: number;
}

const streakJson = (s: StreakState): StreakJson => ({ current: s.current, longest: s.longest });

// ─── #4 Start ──────────────────────────────────────────────────────────

/** Starts the +1/+3/+7/+21 cycles of an item on `today` inside a transaction (no ownership check). */
export async function createRevisionChain(
    tx: TxClient,
    userId: string,
    target: { topicId: string } | { captureId: string },
    today: DayString
): Promise<void> {
    const where = 'topicId' in target ? { topicId: target.topicId } : { captureId: target.captureId };
    const existing = await tx.revision.findMany({ where });
    const planned = startRevisions(today, existing.map(toEngineRevision));
    await tx.revision.createMany({
        data: planned.map((p) => ({
            userId,
            topicId: 'topicId' in target ? target.topicId : null,
            captureId: 'captureId' in target ? target.captureId : null,
            cycleNumber: p.cycleNumber,
            intervalDays: p.intervalDays,
            scheduledFor: toDbDay(p.scheduledFor),
            status: p.status,
            completedAt: null,
        })),
    });
}

/** P2002 on (item, cycle) = a concurrent start won the race. */
export function rethrowAlreadyStarted(err: unknown): never {
    if (isUniqueViolation(err)) throw new LearningError('ALREADY_STARTED', 'This item already has revisions');
    throw err;
}

export async function loadChain(target: { topicId: string } | { captureId: string }): Promise<ChainRevisionJson[]> {
    const rows = await prisma.revision.findMany({ where: target, orderBy: { cycleNumber: 'asc' } });
    return serializeChain(rows);
}

/** POST /api/revisions/start { topicId } | { captureId }. */
export async function startItemRevisions(
    userId: string,
    target: { topicId: string } | { captureId: string },
    now: Date = new Date()
): Promise<{ chain: ChainRevisionJson[] }> {
    try {
        await prisma.$transaction(async (tx) => {
            const ctx = await loadLearningContext(userId, now, tx);
            const owned =
                'topicId' in target
                    ? await tx.topic.findFirst({ where: { id: target.topicId, userId }, select: { id: true } })
                    : await tx.capture.findFirst({ where: { id: target.captureId, userId }, select: { id: true } });
            if (!owned) throw notFound();
            await createRevisionChain(tx, userId, target, ctx.today);
        });
    } catch (err) {
        rethrowAlreadyStarted(err);
    }
    return { chain: await loadChain(target) };
}

// ─── #5 Complete ───────────────────────────────────────────────────────

export interface CompleteResultJson {
    item: ReturnType<typeof serializeRevisionItem>;
    chain: ChainRevisionJson[];
    streak: StreakJson;
    mastered: boolean;
}

export async function completeRevisionForUser(userId: string, revisionId: string, now: Date = new Date()): Promise<CompleteResultJson> {
    // Settle yesterday first, or a rest day not bridged yet would reset the streak to 1 here.
    await ensureLearningRollover(userId, now);

    const { streak, mastered } = await prisma.$transaction(async (tx) => {
        const ctx = await lockLearningContext(tx, userId, now);
        const { target, chain } = await lockChain(tx, userId, revisionId);
        const result = completeRevision(chain.map(toEngineRevision), revisionId, now, ctx.tz);
        await applyPatches(tx, result.patches, new Map([[target.id, { undo: undoJson(result.undo) }]]));

        const day = result.completedDay;
        const subjectId = await subjectIdOf(tx, target);
        const pendingDueGlobal = await countPendingDue(tx, userId, day);
        let subject: SubjectStreakInput | undefined;
        let historyExisted = false;
        if (subjectId) {
            const state = await loadSubjectState(tx, userId, subjectId, day);
            historyExisted = state.historyExists;
            subject = { subjectId, streak: state.streak, history: state.history, pendingDue: await countPendingDue(tx, userId, day, subjectId) };
        }

        const effects = streakEffectsOfCompletion({ today: day, global: globalStreakOf(ctx.user), pendingDueGlobal, ...(subject ? { subject } : {}) });
        await writeGlobal(tx, ctx, effects.global);
        if (subject && effects.subject) {
            await writeSubjectStreak(tx, userId, subject.subjectId, subject.streak, effects.subject.streak);
            await writeHistory(tx, userId, subject.subjectId, day, historyExisted, effects.subject.history);
            await tx.subject.update({ where: { id: subject.subjectId }, data: { lastActiveAt: now }, select: { id: true } });
        }
        return { streak: streakJson(effects.global), mastered: result.mastered };
    });

    poke('buddy'); // 11-22: the buddy's day reacts to what they do (a pulse may fall due)
    return { ...(await loadItemAndChain(revisionId)), streak, mastered };
}

// ─── #6 Uncomplete ─────────────────────────────────────────────────────

export interface UncompleteResultJson {
    item: ReturnType<typeof serializeRevisionItem>;
    chain: ChainRevisionJson[];
    streak: StreakJson;
}

export async function uncompleteRevisionForUser(userId: string, revisionId: string, now: Date = new Date()): Promise<UncompleteResultJson> {
    await ensureLearningRollover(userId, now);

    const streak = await prisma.$transaction(async (tx) => {
        const ctx = await lockLearningContext(tx, userId, now);
        const { target, chain } = await lockChain(tx, userId, revisionId);
        const result = uncompleteRevision(chain.map(toEngineRevision), revisionId, parseUndo(target.undo), ctx.tz);
        await applyPatches(tx, result.patches, new Map([[target.id, { undo: Prisma.DbNull }]]));

        const today = ctx.today;
        const subjectId = await subjectIdOf(tx, target);
        const pendingDueGlobal = await countPendingDue(tx, userId, today);
        const completedTodayGlobal = await countCompletedOn(tx, userId, today, ctx.tz);
        let subject: (SubjectStreakInput & { completedToday: number }) | undefined;
        let historyExisted = false;
        if (subjectId) {
            const state = await loadSubjectState(tx, userId, subjectId, today);
            historyExisted = state.historyExists;
            subject = {
                subjectId,
                streak: state.streak,
                history: state.history,
                pendingDue: await countPendingDue(tx, userId, today, subjectId),
                completedToday: await countCompletedOn(tx, userId, today, ctx.tz, subjectId),
            };
        }

        const effects = streakEffectsOfUncompletion({
            today,
            completedDay: result.completedDay,
            global: globalStreakOf(ctx.user),
            pendingDueGlobal,
            completedTodayGlobal,
            ...(subject ? { subject } : {}),
        });
        await writeGlobal(tx, ctx, effects.global);
        if (subject && effects.subject && result.completedDay === today) {
            await writeSubjectStreak(tx, userId, subject.subjectId, subject.streak, effects.subject.streak);
            await writeHistory(tx, userId, subject.subjectId, today, historyExisted, effects.subject.history);
        }
        return streakJson(effects.global);
    });

    return { ...(await loadItemAndChain(revisionId)), streak };
}

// ─── #7 Reschedule ─────────────────────────────────────────────────────

export async function rescheduleRevisionForUser(
    userId: string,
    revisionId: string,
    day: DayString,
    now: Date = new Date()
): Promise<{ item: ReturnType<typeof serializeRevisionItem>; chain: ChainRevisionJson[] }> {
    await prisma.$transaction(async (tx) => {
        const ctx = await lockLearningContext(tx, userId, now);
        if (day < ctx.today) throw badRequest('The new day must be today or later', 'INVALID_DAY');
        const { chain } = await lockChain(tx, userId, revisionId);
        const result = rescheduleRevision(chain.map(toEngineRevision), revisionId, day);
        await applyPatches(tx, result.patches);
    });
    return loadItemAndChain(revisionId);
}
