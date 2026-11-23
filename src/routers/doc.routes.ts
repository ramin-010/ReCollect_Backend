import express, { RequestHandler } from 'express';
import authMiddleware from '../middlwares/auth';
import { scopeByMethod } from '../middlwares/scopes';
import { getDoc, deleteDoc, getAllDocs, createDoc, updateDoc } from '../controllers/doc.controller';
import { searchLibraryDocs } from '../controllers/docSearch.controller';
import { emptyTrashHandler, restoreDocHandler, trashDocHandler } from '../controllers/docTrash.controller';
import { addPerson, answerRequest, changePerson, listPeople, publishDoc, removePerson } from '../controllers/docSharing.controller';
import { getCard } from '../controllers/agentNotes.controller';

const router = express.Router();
// Access tokens: GETs need `read`, writes `docs:write` (a cookie session has every scope). Which doc
// routes accept a token at all: src/services/apiTokens/tokenRoutes.ts (reads only; agents write
// through /api/agent/docs).
const auth: RequestHandler[] = [authMiddleware as RequestHandler, scopeByMethod('docs:write')];

// Before '/:id'. Not on the token list: agents search through /api/agent/docs?query=.
router.get('/search', auth, searchLibraryDocs);
// The trash (cookie only: agents use /api/agent/docs/:id/trash and ask for emptying via /api/actions).
router.post('/trash/empty', auth, emptyTrashHandler);
router.post('/:id/trash', auth, trashDocHandler);
router.post('/:id/restore', auth, restoreDocHandler);
router.get('/', auth, getAllDocs as RequestHandler);
router.post('/', auth, createDoc as RequestHandler);
router.get('/:id', auth, getDoc as RequestHandler);
// STUDY_FLOW_PLAN §4.4: the doc's revision card, drawn read-only at a review (cookie only: tokens read the doc itself).
router.get('/:id/card', auth, getCard);
router.patch('/:id', auth, updateDoc as RequestHandler);
router.delete('/:id', auth, deleteDoc as RequestHandler);

// Sharing (MANAGER_AND_DOCS_PLAN §2: publish + people; src/services/docs/docSharing.service.ts).
// Cookie only: not on the token list (agents read /api/agent/docs/:id/sharing and ask through /api/actions).
router.put('/:id/publish', auth, publishDoc);
router.get('/:id/people', auth, listPeople);
router.post('/:id/people', auth, addPerson);
router.patch('/:id/people/:userId', auth, changePerson);
router.delete('/:id/people/:userId', auth, removePerson);
router.post('/:id/requests/:reqId/approve', auth, answerRequest('approve'));
router.post('/:id/requests/:reqId/decline', auth, answerRequest('decline'));

export default router;
