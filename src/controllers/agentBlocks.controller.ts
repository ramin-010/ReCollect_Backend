// Block tools (/api/agent/docs/:id/outline and /blocks…): the new editor's blocks by id, for agents
// and the app's AI (DOCS_EDITOR_V2_PLAN §5). Thin: validate with zod, call agentBlocks.service.
import { z } from 'zod';
import { requireUser } from '../middlwares/auth';
import { agentActor } from '../services/agent/agentEditLog';
import { deleteBlocksForAgent, insertBlocksForAgent, moveBlocksForAgent, outlineForAgent, readBlocksForAgent, updateBlockForAgent } from '../services/agent/agentBlocks.service';
import type { Where } from '../services/docs/blocks/docOps';
import { PART_ACTIONS, editDocPartForAgent } from '../services/agent/agentDocPart.service';
import { handler, ok, param, parse } from './learning/common';

const MARKDOWN_MAX = 500_000;
const markdown = z.string().max(MARKDOWN_MAX, `markdown is at most ${MARKDOWN_MAX} characters`);
const blockId = z.string().trim().min(1, 'a block id is required').max(100);
const ids = z.array(blockId).min(1, 'give at least one block id').max(200);

/** Where blocks go: after, before or under a block id, or at the start or end of the doc. */
const where = z
    .object({
        after: blockId.optional(),
        before: blockId.optional(),
        under: blockId.optional(),
        at: z.enum(['start', 'end']).optional(),
    })
    .refine((w) => [w.after, w.before, w.under, w.at].filter((v) => v !== undefined).length === 1, 'where needs exactly one of after, before, under or at')
    .transform((w): Where => (w.after ? { after: w.after } : w.before ? { before: w.before } : w.under ? { under: w.under } : { at: w.at ?? 'end' }));

/** GET /api/agent/docs/:id/outline → { id, title, blocks: [{ id, type, depth, text, props? }], canEdit } */
export const getOutline = handler(async (req, res) => {
    ok(res, await outlineForAgent(requireUser(req).id, param(req, 'id')));
});

const readSchema = z.object({ ids: z.string().max(4000).optional() });

/** GET /api/agent/docs/:id/blocks?ids=a,b → { id, title, markdown } (those blocks, or the whole doc) */
export const readBlocks = handler(async (req, res) => {
    const { ids: list } = parse(readSchema, req.query);
    const picked = list
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    ok(res, await readBlocksForAgent(requireUser(req).id, param(req, 'id'), picked));
});

const insertSchema = z.object({ markdown: markdown.min(1, 'markdown is empty'), where: where.default({ at: 'end' }) });

/** POST /api/agent/docs/:id/blocks { markdown, where } → { id, ids, inserted, editId, canvases? } */
export const insertBlocks = handler(async (req, res) => {
    const input = parse(insertSchema, req.body);
    ok(res, await insertBlocksForAgent(agentActor(req), param(req, 'id'), input.markdown, input.where as Where));
});

const updateSchema = z.object({
    markdown: markdown.optional(),
    type: z.string().trim().min(1).max(40).optional(),
    props: z.record(z.string().max(40), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
});

/** PATCH /api/agent/docs/:id/blocks/:blockId { markdown?, type?, props? } → { id, block, editId } */
export const updateBlock = handler(async (req, res) => {
    const input = parse(updateSchema, req.body);
    ok(res, await updateBlockForAgent(agentActor(req), param(req, 'id'), param(req, 'blockId'), input));
});

const moveSchema = z.object({ ids, where });

/** POST /api/agent/docs/:id/blocks/move { ids, where } → { id, moved, editId } */
export const moveBlocks = handler(async (req, res) => {
    const input = parse(moveSchema, req.body);
    ok(res, await moveBlocksForAgent(agentActor(req), param(req, 'id'), input.ids, input.where as Where));
});

const deleteSchema = z.object({ ids });

/** POST /api/agent/docs/:id/blocks/delete { ids } → { id, deleted, editId } */
export const deleteBlocks = handler(async (req, res) => {
    const input = parse(deleteSchema, req.body);
    ok(res, await deleteBlocksForAgent(agentActor(req), param(req, 'id'), input.ids));
});

const partSchema = z.object({
    part: z.string().trim().min(1, 'name the part: a heading, words from the block, or a kind ("the code block")').max(300),
    action: z.enum(PART_ACTIONS),
    markdown: markdown.optional(),
});

/** POST /api/agent/docs/:id/part { part, action, markdown? } → { id, title, done, part, ids?, editId } (TOOL_ACCESS_PLAN §10). */
export const editDocPart = handler(async (req, res) => {
    const input = parse(partSchema, req.body);
    ok(res, await editDocPartForAgent(agentActor(req), param(req, 'id'), input));
});
