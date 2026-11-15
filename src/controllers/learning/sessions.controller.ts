// The record (SYNC_SPINE_SPEC 1.2): sessions, projects. Thin: validate, call the service.
// Tokens may only PUT a session by key (sessions:write) and read; the rest is the app's
// (src/services/apiTokens/tokenRoutes.ts refuses tokens everything else).
import { z } from 'zod';
import { isTokenRequest, requireUser } from '../../middlwares/auth';
import { agentActor } from '../../services/agent/agentEditLog';
import {
    MINUTES_MAX,
    PRACTICE_OUTCOMES,
    SESSION_KINDS,
    WEAK_SPOTS_PER_WRITE,
    createSession,
    deleteSession,
    listProjects,
    listSessions,
    updateProject,
    updateSession,
    upsertSessionByKey,
} from '../../services/learningDb/sessions.service';
import { handler, ok, param, parse, zDay, zId } from './common';

const zKind = z.enum(SESSION_KINDS);
const zWrite = z
    .object({
        kind: zKind.optional(),
        kindIfNew: zKind.optional(),
        title: z.string().max(400).optional(),
        titleIfNew: z.string().max(400).optional(),
        minutes: z.number().int().min(0).max(MINUTES_MAX).nullable().optional(),
        startedAt: z.iso.datetime({ offset: true }).optional(),
        endedAt: z.iso.datetime({ offset: true }).nullable().optional(),
        subjectId: zId.nullable().optional(),
        topicId: zId.nullable().optional(),
        project: z.string().max(200).nullable().optional(),
        score: z.object({ done: z.number().int(), total: z.number().int() }).nullable().optional(),
        outcome: z.enum(PRACTICE_OUTCOMES).nullable().optional(),
        problem: z.string().max(400).nullable().optional(),
        url: z.string().max(1000).nullable().optional(),
        nextStep: z.string().max(600).nullable().optional(),
        details: z.object({ branch: z.string().max(300).optional(), commits: z.array(z.string().max(500)).max(50).optional() }).nullable().optional(),
        weakSpots: z.array(z.string().trim().min(1).max(400)).max(WEAK_SPOTS_PER_WRITE).optional(),
        cleared: z.array(z.string().trim().min(1).max(400)).max(50).optional(),
        topicStatus: z.enum(['planned', 'in_progress', 'done', 'skipped']).optional(),
        source: z.enum(['agent', 'hook']).optional(),
    })
    .strict();

/** PUT /api/sessions/by-key/:key → { session, topic, weakSpots, topicEditId } */
export const putSessionByKeyHandler = handler(async (req, res) => {
    const input = parse(zWrite, req.body);
    const user = requireUser(req);
    ok(res, await upsertSessionByKey({ userId: user.id, actor: isTokenRequest(req) ? agentActor(req) : null }, param(req, 'key'), input));
});

const zCreate = zWrite.omit({ kindIfNew: true, titleIfNew: true, source: true, weakSpots: true, cleared: true, topicStatus: true }).extend({ title: z.string().min(1).max(400), day: zDay.optional() });

/** POST /api/sessions (the app: a manual entry) → the session */
export const createSessionHandler = handler(async (req, res) => {
    const input = parse(zCreate, req.body);
    ok(res, await createSession(requireUser(req).id, input), 201);
});

const zList = z.object({
    days: z.coerce.number().int().min(1).max(90).optional(),
    kind: zKind.optional(),
    project: z.string().max(200).optional(),
    subject: zId.optional(),
});

/** GET /api/sessions?days=&kind=&project=&subject= → { sessions, days } */
export const listSessionsHandler = handler(async (req, res) => {
    const q = parse(zList, req.query);
    ok(res, await listSessions(requireUser(req).id, { days: q.days, kind: q.kind, project: q.project, subjectId: q.subject }));
});

const zPatch = z
    .object({
        title: z.string().max(400).optional(),
        minutes: z.number().int().min(0).max(MINUTES_MAX).nullable().optional(),
        kind: zKind.optional(),
        day: zDay.optional(),
        nextStep: z.string().max(600).nullable().optional(),
    })
    .strict();

/** PATCH /api/sessions/:id (the app) → the session */
export const updateSessionHandler = handler(async (req, res) => {
    const patch = parse(zPatch, req.body);
    ok(res, await updateSession(requireUser(req).id, param(req, 'id'), patch));
});

/** DELETE /api/sessions/:id (the app) → { deleted: true } */
export const deleteSessionHandler = handler(async (req, res) => {
    ok(res, await deleteSession(requireUser(req).id, param(req, 'id')));
});

/** GET /api/projects → [project] */
export const listProjectsHandler = handler(async (req, res) => {
    ok(res, await listProjects(requireUser(req).id));
});

const zProjectPatch = z
    .object({
        name: z.string().max(200).optional(),
        goalId: zId.nullable().optional(),
        isArchived: z.boolean().optional(),
        nextStep: z.string().max(600).nullable().optional(),
    })
    .strict();

/** PATCH /api/projects/:id (the app) → the project */
export const updateProjectHandler = handler(async (req, res) => {
    const patch = parse(zProjectPatch, req.body);
    ok(res, await updateProject(requireUser(req).id, param(req, 'id'), patch));
});
