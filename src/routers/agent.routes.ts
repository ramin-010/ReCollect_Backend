// /api/agent: the API the MCP server ("Kaaga for agents", HOME_DOCS_AGENT_PLAN §3) calls with a
// personal access token, plus the agent edit log Home shows. Cookie sessions work too (all scopes).
//
// Token access per route is decided by authMiddleware (src/services/apiTokens/tokenRoutes.ts);
// requireScope / cookieOnly below state the same rules at each route. POSTs accept an
// Idempotency-Key header (a retry within 24 h gets the first response).
import express from 'express';
import { authOnce, cookieOnly, requireScope } from '../middlwares/scopes';
import { idempotency } from '../middlwares/idempotency';
import { requireUser } from '../middlwares/auth';
import { docSharingForAgent } from '../services/docs/docSharing.service';
import { docsFromAgents } from '../services/agent/agentEdits.service';
import { handler, ok, param } from '../controllers/learning/common';
import {
    appendToDoc,
    createDoc,
    listEdits,
    markdownToBlocksHandler,
    markSeen,
    previewCanvas,
    readDoc,
    replaceSection,
    restoreDoc,
    searchDocs,
    trashDoc,
    undoEdit,
    updateCanvas,
    updateDoc,
} from '../controllers/agent.controller';
import { deleteBlocks, getOutline, insertBlocks, moveBlocks, readBlocks, updateBlock } from '../controllers/agentBlocks.controller';
import { addNote, listNotes, putCard, removeNote, updateNote } from '../controllers/agentNotes.controller';
import { deletePocket, deleteSubject, listPocket, updatePocket, updateSubject } from '../controllers/agentPocket.controller';
import { attachFile, noteFileBody, readFile, removeFile } from '../controllers/agentNoteFiles.controller';

const router = express.Router();

router.use(authOnce);

router.get('/docs', requireScope('read'), searchDocs);
router.get('/docs/:id', requireScope('read'), readDoc);
router.post('/docs', requireScope('docs:write'), idempotency, createDoc);
// Rename a doc, file it under a subject, or make it a planned topic's note (update_doc).
router.patch('/docs/:id', requireScope('docs:write'), idempotency, updateDoc);
router.post('/docs/:id/append', requireScope('docs:write'), idempotency, appendToDoc);
router.post('/docs/:id/replace-section', requireScope('docs:write'), idempotency, replaceSection);
router.post('/docs/:id/trash', requireScope('docs:write'), idempotency, trashDoc);
router.post('/docs/:id/restore', requireScope('docs:write'), idempotency, restoreDoc);
// A canvas board by id: change it in place (keeps what the user arranged), or see it as a PNG.
router.post('/docs/:id/canvas/:canvasId', requireScope('docs:write'), idempotency, updateCanvas);
router.get('/docs/:id/preview', requireScope('read'), previewCanvas);
// The new editor's blocks by id (DocOps, phase 3): outline, read, insert, update, move, delete.
router.get('/docs/:id/outline', requireScope('read'), getOutline);
router.get('/docs/:id/blocks', requireScope('read'), readBlocks);
router.post('/docs/:id/blocks', requireScope('docs:write'), idempotency, insertBlocks);
router.post('/docs/:id/blocks/move', requireScope('docs:write'), idempotency, moveBlocks);
router.post('/docs/:id/blocks/delete', requireScope('docs:write'), idempotency, deleteBlocks);
router.patch('/docs/:id/blocks/:blockId', requireScope('docs:write'), idempotency, updateBlock);
// STUDY_FLOW_PLAN (11-23): a lesson's revision card, and the notes and links on a lesson or a subject.
router.put('/docs/:id/card', requireScope('docs:write'), idempotency, putCard);
router.get('/notes', requireScope('read'), listNotes);
router.post('/notes', requireScope('learning:write'), idempotency, addNote);
router.patch('/notes/:id', requireScope('learning:write'), idempotency, updateNote);
router.post('/notes/:id/remove', requireScope('learning:write'), idempotency, removeNote);
// TOOL_ACCESS_PLAN §11 (11-27): files on a note: attach (a file from disk, or its text or base64), remove, read.
router.post('/notes/:id/files', requireScope('learning:write'), noteFileBody, idempotency, attachFile);
router.post('/notes/:id/files/remove', requireScope('learning:write'), idempotency, removeFile);
router.get('/notes/:id/files/:n', requireScope('read'), readFile);
// TOOL_ACCESS_PLAN §4.7 (11-27): their pocket notes, only while they allow chats at them (403 POCKET_PRIVATE until then).
router.get('/pocket', requireScope('read'), listPocket);
router.patch('/pocket/:id', requireScope('learning:write'), idempotency, updatePocket);
router.post('/pocket/:id/delete', requireScope('learning:write'), idempotency, deletePocket);
// A subject renamed or described; deleted at once when it holds nothing, else a card that waits for their tap.
router.patch('/subjects/:id', requireScope('learning:write'), idempotency, updateSubject);
router.post('/subjects/:id/delete', requireScope('learning:write'), idempotency, deleteSubject);
// Who can see a doc of his (get_sharing, read only): published or not, the people, the requests.
router.get('/docs/:id/sharing', requireScope('read'), handler(async (req, res) => ok(res, await docSharingForAgent(requireUser(req).id, param(req, 'id')))));

router.get('/edits', requireScope('read'), listEdits);
// The library's "From agents" view (cookie only): the docs agents wrote or changed, latest first.
router.get('/doc-activity', cookieOnly, handler(async (req, res) => ok(res, await docsFromAgents(requireUser(req).id))));
// Home only: an agent must not be able to hide ("seen") or revert its own work.
router.post('/edits/seen', cookieOnly, markSeen);
router.post('/markdown', cookieOnly, markdownToBlocksHandler);
router.post('/edits/:id/undo', cookieOnly, idempotency, undoEdit);

export default router;
