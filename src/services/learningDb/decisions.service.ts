// The decision journal (LOOP_COMPLETE_SPEC 4.2): what was decided, why, what was expected, and a day
// to look again. On that day Home asks "Was this right?" once: Right, Mixed, Wrong (an optional line),
// or look again later. It reuses no revision machinery: one date per decision is all it needs.
//
//   listDecisions    GET   /api/decisions?status=&project=&due=1   read
//   createDecision   POST  /api/decisions                          learning:write (agent: decision_create)
//   updateDecision   PATCH /api/decisions/:id                      learning:write (agent: decision_update)
import type { DecisionStatus, DecisionVerdict, Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { addDays, type DayString } from '../learning';
import { badRequest, notFound } from '../learning/http';
import { fromDbDay, loadLearningContext, toDbDay } from './common';

export const DECISION_VERDICTS = ['right', 'wrong', 'mixed'] as const satisfies readonly DecisionVerdict[];
export const DECISION_STATUSES = ['open', 'reviewed'] as const satisfies readonly DecisionStatus[];

export interface DecisionJson {
    _id: string;
    title: string;
    why: string;
    expect: string | null;
    lookAgainDay: DayString;
    status: DecisionStatus;
    verdict: DecisionVerdict | null;
    verdictNote: string | null;
    reviewedAt: string | null;
    subject: { _id: string; name: string } | null;
    project: { _id: string; key: string; name: string } | null;
    /** The day it was logged (the user's zone is not needed: a date label). */
    createdAt: string;
    createdBy: 'user' | 'agent';
    agentName: string | null;
}

const INCLUDE = { subject: { select: { id: true, name: true } }, project: { select: { id: true, key: true, name: true } } } as const;
type Row = Prisma.DecisionGetPayload<{ include: typeof INCLUDE }>;

export const serializeDecision = (d: Row): DecisionJson => ({
    _id: d.id,
    title: d.title,
    why: d.why,
    expect: d.expect,
    lookAgainDay: fromDbDay(d.lookAgainDay),
    status: d.status,
    verdict: d.verdict,
    verdictNote: d.verdictNote,
    reviewedAt: d.reviewedAt?.toISOString() ?? null,
    subject: d.subject ? { _id: d.subject.id, name: d.subject.name } : null,
    project: d.project ? { _id: d.project.id, key: d.project.key, name: d.project.name } : null,
    createdAt: d.createdAt.toISOString(),
    createdBy: d.createdBy,
    agentName: d.agentName,
});

const clean = (text: string | null | undefined, max: number): string | null => {
    const t = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    return t || null;
};

/** "2026-12-14", or "30d" / "6w" / "3m" from today. */
export function lookAgainOf(value: string, today: DayString): DayString {
    const v = value.trim().toLowerCase();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        if (v <= today) throw badRequest('lookAgain must be after today');
        return v as DayString;
    }
    const m = /^(\d{1,3})\s*(d|w|m)$/.exec(v);
    if (!m) throw badRequest('lookAgain is a day (YYYY-MM-DD) or a span like 30d, 6w, 3m');
    const n = Number(m[1]);
    if (n < 1) throw badRequest('lookAgain must be after today');
    return addDays(today, m[2] === 'd' ? n : m[2] === 'w' ? n * 7 : n * 30);
}

async function resolveScope(userId: string, input: { subjectId?: string | null | undefined; project?: string | null | undefined }) {
    if (input.subjectId && !(await prisma.subject.findFirst({ where: { id: input.subjectId, userId }, select: { id: true } }))) throw badRequest(`No subject with id ${input.subjectId}`, 'UNKNOWN_SUBJECT');
    let projectId: string | null | undefined;
    if (input.project === null) projectId = null;
    else if (input.project) {
        const key = input.project.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
        const found = await prisma.project.findFirst({ where: { userId, OR: [{ key }, { name: { equals: input.project.trim(), mode: 'insensitive' } }] }, select: { id: true } });
        projectId = found?.id ?? (await prisma.project.create({ data: { userId, key, name: input.project.trim().slice(0, 120) }, select: { id: true } })).id;
    }
    return { subjectId: input.subjectId, projectId };
}

export interface DecisionInput {
    title: string;
    why: string;
    expect?: string | null | undefined;
    lookAgain: string;
    subjectId?: string | null | undefined;
    /** A project's key or name (made when new, like a session's). */
    project?: string | null | undefined;
}

export async function createDecision(userId: string, input: DecisionInput, now: Date = new Date()): Promise<DecisionJson> {
    const ctx = await loadLearningContext(userId, now);
    const title = clean(input.title, 160);
    const why = clean(input.why, 600);
    if (!title || !why) throw badRequest('A decision needs what was decided (title) and why');
    const day = lookAgainOf(input.lookAgain, ctx.today);
    const scope = await resolveScope(userId, input);
    // A write selects plain columns (a write that includes 2+ relations runs parallel queries on one connection).
    const made = await prisma.decision.create({
        data: { userId, title, why, expect: clean(input.expect, 400), lookAgainDay: toDbDay(day), subjectId: scope.subjectId ?? null, projectId: scope.projectId ?? null },
        select: { id: true },
    });
    return serializeDecision(await prisma.decision.findUniqueOrThrow({ where: { id: made.id }, include: INCLUDE }));
}

export interface DecisionPatch {
    title?: string | undefined;
    why?: string | undefined;
    expect?: string | null | undefined;
    /** Look again later: a day or a span (the decision stays open). */
    lookAgain?: string | undefined;
    /** The answer to "Was this right?": the decision becomes reviewed. */
    verdict?: DecisionVerdict | undefined;
    verdictNote?: string | null | undefined;
}

export async function updateDecision(userId: string, id: string, patch: DecisionPatch, now: Date = new Date()): Promise<DecisionJson> {
    const found = await prisma.decision.findFirst({ where: { id, userId }, select: { id: true } });
    if (!found) throw notFound();
    const ctx = await loadLearningContext(userId, now);
    const title = patch.title !== undefined ? clean(patch.title, 160) : undefined;
    const why = patch.why !== undefined ? clean(patch.why, 600) : undefined;
    if (title === null || why === null) throw badRequest('title and why cannot be empty');
    await prisma.decision.update({
        where: { id },
        data: {
            ...(title !== undefined ? { title } : {}),
            ...(why !== undefined ? { why } : {}),
            ...(patch.expect !== undefined ? { expect: clean(patch.expect, 400) } : {}),
            ...(patch.lookAgain !== undefined ? { lookAgainDay: toDbDay(lookAgainOf(patch.lookAgain, ctx.today)), status: 'open', verdict: null, reviewedAt: null } : {}),
            ...(patch.verdict !== undefined ? { verdict: patch.verdict, status: 'reviewed', reviewedAt: now } : {}),
            ...(patch.verdictNote !== undefined ? { verdictNote: clean(patch.verdictNote, 400) } : {}),
        },
        select: { id: true },
    });
    return serializeDecision(await prisma.decision.findUniqueOrThrow({ where: { id }, include: INCLUDE }));
}

/** For an agent's Undo. */
export function decisionBefore(userId: string, id: string) {
    return prisma.decision.findFirst({ where: { id, userId }, select: { id: true, title: true, why: true, expect: true, lookAgainDay: true, status: true, verdict: true, verdictNote: true, reviewedAt: true } });
}

/** GET /api/decisions: newest first; `due` = open ones whose day has come (Home's "Was this right?"). */
export async function listDecisions(
    userId: string,
    options: { status?: DecisionStatus | undefined; project?: string | undefined; due?: boolean | undefined } = {},
    now: Date = new Date()
): Promise<DecisionJson[]> {
    const ctx = await loadLearningContext(userId, now);
    const project = options.project
        ? await prisma.project.findFirst({ where: { userId, OR: [{ key: options.project.trim().toLowerCase() }, { name: { equals: options.project.trim(), mode: 'insensitive' } }] }, select: { id: true } })
        : null;
    if (options.project && !project) return [];
    const rows = await prisma.decision.findMany({
        where: {
            userId,
            ...(options.due ? { status: 'open', lookAgainDay: { lte: toDbDay(ctx.today) } } : options.status ? { status: options.status } : {}),
            ...(project ? { projectId: project.id } : {}),
        },
        include: INCLUDE,
        orderBy: options.due ? [{ lookAgainDay: 'asc' }, { createdAt: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
    });
    return rows.map(serializeDecision);
}
