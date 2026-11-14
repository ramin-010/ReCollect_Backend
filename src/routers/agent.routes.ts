// /api/agent: the API the MCP server ("Recollect for agents", HOME_DOCS_AGENT_PLAN §3) calls with a
// personal access token, plus the agent edit log Home shows. Cookie sessions work too (all scopes).
//
// Token access per route is decided by authMiddleware (src/services/apiTokens/tokenRoutes.ts);
// requireScope / cookieOnly below state the same rules at each route. POSTs accept an
// Idempotency-Key header (a retry within 24 h gets the first response).
import express from 'express';
import { authOnce, cookieOnly, requireScope } from '../middlwares/scopes';
import { idempotency } from '../middlwares/idempotency';
import {
    appendToDoc,
    createDoc,
    listEdits,
    markdownToBlocksHandler,
    markSeen,
    previewCanvas,
    readDoc,
    replaceSection,
    searchDocs,
    undoEdit,
    updateCanvas,
} from '../controllers/agent.controller';

const router = express.Router();

router.use(authOnce);

router.get('/docs', requireScope('read'), searchDocs);
router.get('/docs/:id', requireScope('read'), readDoc);
router.post('/docs', requireScope('docs:write'), idempotency, createDoc);
router.post('/docs/:id/append', requireScope('docs:write'), idempotency, appendToDoc);
router.post('/docs/:id/replace-section', requireScope('docs:write'), idempotency, replaceSection);
// A canvas board by id: change it in place (keeps what Ramin arranged), or see it as a PNG.
router.post('/docs/:id/canvas/:canvasId', requireScope('docs:write'), idempotency, updateCanvas);
router.get('/docs/:id/preview', requireScope('read'), previewCanvas);

router.get('/edits', requireScope('read'), listEdits);
// Home only: an agent must not be able to hide ("seen") or revert its own work.
router.post('/edits/seen', cookieOnly, markSeen);
router.post('/markdown', cookieOnly, markdownToBlocksHandler);
router.post('/edits/:id/undo', cookieOnly, idempotency, undoEdit);

export default router;
