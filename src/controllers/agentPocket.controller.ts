// TOOL_ACCESS_PLAN §4.7 (11-27): pocket notes (only while the person allows chats at them) and subjects, for agents.
// Thin: validate with zod, call agentPocket.service.ts / agentSubjects.service.ts.
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { agentActor } from '../services/agent/agentEditLog';
import { POCKET_TEXT_MAX, deletePocketForAgent, listPocketForAgent, updatePocketForAgent } from '../services/agent/agentPocket.service';
import { deleteSubjectForAgent, updateSubjectForAgent } from '../services/agent/agentSubjects.service';
import { handler, ok, param, parse } from './learning/common';

const listSchema = z.object({ id: z.string().trim().min(1).max(64).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

/** GET /api/agent/pocket [?id=] [&limit=] */
export const listPocket = handler(async (req, res) => {
    ok(res, await listPocketForAgent(requireUser(req).id, parse(listSchema, req.query)));
});

const updateSchema = z
    .object({ text: z.string().max(POCKET_TEXT_MAX).optional(), pinned: z.boolean().optional() })
    .refine((v) => v.text !== undefined || v.pinned !== undefined, 'Send text, pinned, or both');

/** PATCH /api/agent/pocket/:id { text?, pinned? } */
export const updatePocket = handler(async (req, res) => {
    ok(res, await updatePocketForAgent(agentActor(req), param(req, 'id'), parse(updateSchema, req.body)));
});

/** POST /api/agent/pocket/:id/delete */
export const deletePocket = handler(async (req, res) => {
    ok(res, await deletePocketForAgent(agentActor(req), param(req, 'id')));
});

const subjectSchema = z
    .object({ name: z.string().trim().min(1, 'A subject needs a name').max(100).optional(), description: z.string().max(500).nullable().optional() })
    .refine((v) => v.name !== undefined || v.description !== undefined, 'Send name, description, or both');

/** PATCH /api/agent/subjects/:id { name?, description? } (the id, or the subject's name) */
export const updateSubject = handler(async (req, res) => {
    ok(res, await updateSubjectForAgent(agentActor(req), param(req, 'id'), parse(subjectSchema, req.body)));
});

const deleteSchema = z.object({ reason: z.string().trim().max(200).optional() });

/** POST /api/agent/subjects/:id/delete { reason? } */
export const deleteSubject = handler(async (req, res) => {
    ok(res, await deleteSubjectForAgent(agentActor(req), param(req, 'id'), parse(deleteSchema, req.body ?? {})));
});
