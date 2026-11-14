// The agent API (/api/agent): docs as Markdown for agents, and the agent edit log for Home.
// Thin: validate with zod (400 { message, code }), call the agent services, answer
// { success: true, data } with small payloads.
import { z } from 'zod';
import { markdownToDocJson } from '../services/docs/markdown/docMarkdown';
import { resolveDiagrams } from '../services/docs/diagram/resolve';
import { requireUser } from '../middlwares/auth';
import { agentActor } from '../services/agent/agentEditLog';
import {
    AGENT_TITLE_MAX,
    SEARCH_LIMIT_MAX,
    appendToDocForAgent,
    createDocForAgent,
    readDocForAgent,
    replaceSectionForAgent,
    searchDocsForAgent,
} from '../services/agent/agentDocs.service';
import { EDITS_LIMIT_MAX, listAgentEdits, markAgentEditsSeen, undoAgentEdit } from '../services/agent/agentEdits.service';
import { previewCanvasForAgent, updateCanvasForAgent } from '../services/agent/agentCanvas.service';
import { handler, ok, param, parse, zId } from './learning/common';

/** Agent Markdown is capped (a doc this long is a mistake, and it is held in memory twice). */
const MARKDOWN_MAX = 500_000;
const markdown = z.string().max(MARKDOWN_MAX, `markdown is at most ${MARKDOWN_MAX} characters`);
const queryFlag = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

// ─── Docs ──────────────────────────────────────────────────────────────

const searchSchema = z.object({
    query: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
});

/** GET /api/agent/docs?query=&limit= → [{ id, title, subject, updatedAt, snippet }] */
export const searchDocs = handler(async (req, res) => {
    const { query, limit } = parse(searchSchema, req.query);
    ok(res, await searchDocsForAgent(requireUser(req).id, { query, limit }));
});

/** GET /api/agent/docs/:id → { id, title, markdown, subject, topicId, updatedAt, canEdit } */
export const readDoc = handler(async (req, res) => {
    ok(res, await readDocForAgent(requireUser(req).id, param(req, 'id')));
});

const createSchema = z.object({
    title: z.string().trim().min(1, 'A doc needs a title').max(AGENT_TITLE_MAX),
    markdown: markdown.default(''),
    subjectId: zId.optional(),
    revise: z.boolean().optional(),
});

/** POST /api/agent/docs {title, markdown, subjectId?, revise?} → 201 { id, title, subject, topicId, nextRevision, editId, canvases? } */
export const createDoc = handler(async (req, res) => {
    const input = parse(createSchema, req.body);
    ok(res, await createDocForAgent(agentActor(req), input), 201);
});

const appendSchema = z.object({ markdown: markdown.min(1, 'markdown is empty') });

/** POST /api/agent/docs/:id/append {markdown} → { id, appended, editId, canvases? } (canvases: a report per canvas written) */
export const appendToDoc = handler(async (req, res) => {
    const { markdown: md } = parse(appendSchema, req.body);
    ok(res, await appendToDocForAgent(agentActor(req), param(req, 'id'), md));
});

const replaceSectionSchema = z.object({
    heading: z.string().trim().min(1, 'heading is required').max(300),
    markdown: markdown.min(1, 'markdown is empty'),
});

/** POST /api/agent/docs/:id/replace-section {heading, markdown} → { id, heading, removed, inserted, editId, canvases? } */
export const replaceSection = handler(async (req, res) => {
    const { heading, markdown: md } = parse(replaceSectionSchema, req.body);
    ok(res, await replaceSectionForAgent(agentActor(req), param(req, 'id'), heading, md));
});

// ─── Canvas boards by id ──────────────────────────────────────────────

const zCanvasId = z.string().regex(/^cv_[A-Za-z0-9_-]{12}$/, 'must be a canvas id like cv_Ab3dE6gH9jK0 (read_doc shows it on the fence’s first line)');
const DIAGRAM_MAX = 20_000;
const updateCanvasSchema = z
    .object({
        diagram: z.string().trim().min(1, 'diagram is empty').max(DIAGRAM_MAX, `diagram is at most ${DIAGRAM_MAX} characters`).optional(),
        add: z.string().max(DIAGRAM_MAX, `add is at most ${DIAGRAM_MAX} characters`).optional(),
        remove: z.array(z.string().trim().min(1).max(300)).max(300).optional(),
        rename: z.record(z.string().max(40), z.string().max(1000)).optional(),
        relayout: z.boolean().optional(),
    })
    .strict()
    .refine((v) => v.diagram !== undefined || v.add !== undefined || (v.remove?.length ?? 0) > 0 || Object.keys(v.rename ?? {}).length > 0, {
        message: 'Send diagram (the whole new text), or add, remove or rename',
    })
    .refine((v) => v.diagram === undefined || (v.add === undefined && v.remove === undefined && v.rename === undefined), {
        message: 'Send diagram on its own, or add / remove / rename without it',
    });

/** POST /api/agent/docs/:id/canvas/:canvasId {diagram} | {add?, remove?, rename?} → { id, canvasId, editId, canvases: [report] } */
export const updateCanvas = handler(async (req, res) => {
    const input = parse(updateCanvasSchema, req.body);
    const canvasId = parse(zCanvasId, param(req, 'canvasId'));
    ok(res, await updateCanvasForAgent(agentActor(req), param(req, 'id'), canvasId, input));
});

const previewSchema = z.object({
    canvasId: zCanvasId.optional(),
    theme: z.enum(['light', 'dark']).optional(),
});

/** GET /api/agent/docs/:id/preview?canvasId=&theme= → { canvasId, width, height, png (Base64), report } */
export const previewCanvas = handler(async (req, res) => {
    const { canvasId, theme } = parse(previewSchema, req.query);
    ok(res, await previewCanvasForAgent(requireUser(req).id, param(req, 'id'), canvasId, theme));
});

// ─── Edits (Home: "From your agent") ───────────────────────────────────

const editsSchema = z.object({
    since: z.iso.datetime({ offset: true }).optional(),
    unseen: queryFlag.optional(),
    limit: z.coerce.number().int().min(1).max(EDITS_LIMIT_MAX).optional(),
});

/** GET /api/agent/edits?since=&unseen=&limit= → [{ id, kind, agentName, summary, docId, entityId, createdAt, seenAt, undoneAt, canUndo }] */
export const listEdits = handler(async (req, res) => {
    const { since, unseen, limit } = parse(editsSchema, req.query);
    ok(res, await listAgentEdits(requireUser(req).id, { since: since ? new Date(since) : undefined, unseen, limit }));
});

const seenSchema = z.object({ ids: z.array(zId).min(1).max(200) });

/** POST /api/agent/edits/seen {ids} → { updated } (cookie only) */
export const markSeen = handler(async (req, res) => {
    const { ids } = parse(seenSchema, req.body);
    ok(res, await markAgentEditsSeen(requireUser(req).id, ids));
});

/** POST /api/agent/edits/:id/undo → the edit, with undoneAt (cookie only) */
export const undoEdit = handler(async (req, res) => {
    ok(res, await undoAgentEdit(requireUser(req).id, param(req, 'id')));
});

/**
 * The editor's Markdown paste: Markdown (from a terminal, an AI chat, a .md file) → the doc's blocks,
 * using the same dialect agents write (callouts, toggles, fenced code, mermaid, canvases: their
 * diagrams laid out, each board in its block's data for the browser to absorb). Cookie only.
 */
const markdownBody = z.object({ markdown: z.string().max(200_000) });
export const markdownToBlocksHandler = handler(async (req, res) => {
    requireUser(req);
    const { markdown } = parse(markdownBody, req.body);
    const json = markdownToDocJson(markdown);
    await resolveDiagrams(json, { checkMermaid: false });
    ok(res, { content: json.content ?? [] });
});
