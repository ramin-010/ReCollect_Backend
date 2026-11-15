// The trash in the app (MANAGER_AND_DOCS_PLAN §3.2): src/services/docs/trash.service.ts. Cookie
// sessions only: agents move docs with POST /api/agent/docs/:id/trash and /restore (logged, undoable)
// and can only ask for the trash to be emptied (POST /api/actions, "empty_trash").
import { requireUser } from '../middlwares/auth';
import { emptyTrash, restoreDoc, trashDoc } from '../services/docs/trash.service';
import { handler, ok, param } from './learning/common';

/** POST /api/docs/:id/trash → { _id, title, trashedAt } */
export const trashDocHandler = handler(async (req, res) => {
    const { changed: _changed, ...state } = await trashDoc(requireUser(req).id, param(req, 'id'));
    ok(res, state);
});

/** POST /api/docs/:id/restore → { _id, title, trashedAt: null } */
export const restoreDocHandler = handler(async (req, res) => {
    const { changed: _changed, ...state } = await restoreDoc(requireUser(req).id, param(req, 'id'));
    ok(res, state);
});

/** POST /api/docs/trash/empty → { deleted } */
export const emptyTrashHandler = handler(async (req, res) => {
    ok(res, await emptyTrash(requireUser(req).id));
});
