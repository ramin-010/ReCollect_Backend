// Sharing endpoints (MANAGER_AND_DOCS_PLAN §2): publish + people + requests. Cookie only (agents read
// sharing through /api/agent/docs/:id/sharing; publishing and adding people are actions that need
// the user's tap, POST /api/actions). The rules: src/services/docs/docSharing.service.ts.
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import ErrorResponse from '../utils/errorResponse';
import { requireUser } from '../middlwares/auth';
import {
    addDocPerson,
    answerDocRequest,
    changeDocPersonRole,
    docPeople,
    readPublishedDoc,
    removeDocPerson,
    requestToEdit,
    setDocPublished,
} from '../services/docs/docSharing.service';
import { cookieUserId } from '../middlwares/optionalUser';

function param(req: Request, name: string): string {
    const value = req.params[name];
    if (typeof value !== 'string' || !value) throw new ErrorResponse(404, 'Doc not found');
    return value;
}

const handle =
    (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    (req: Request, res: Response, next: NextFunction) => {
        fn(req, res).catch(next);
    };

/** PUT /api/docs/:id/publish { on } */
export const publishDoc = handle(async (req, res) => {
    const on = req.body?.on;
    if (typeof on !== 'boolean') throw new ErrorResponse(400, 'Send { on: true } to publish, { on: false } to stop');
    const published = await setDocPublished(requireUser(req).id, param(req, 'id'), on);
    res.status(200).json({ success: true, data: { published } });
});

/** GET /api/docs/:id/people */
export const listPeople = handle(async (req, res) => {
    res.status(200).json({ success: true, data: await docPeople(param(req, 'id'), requireUser(req).id) });
});

/** POST /api/docs/:id/people { email, role } */
export const addPerson = handle(async (req, res) => {
    const { people, already, name } = await addDocPerson(requireUser(req).id, param(req, 'id'), { email: req.body?.email, role: req.body?.role });
    res.status(already ? 200 : 201).json({ success: true, data: people, already, name });
});

/** PATCH /api/docs/:id/people/:userId { role } */
export const changePerson = handle(async (req, res) => {
    res.status(200).json({ success: true, data: await changeDocPersonRole(requireUser(req).id, param(req, 'id'), param(req, 'userId'), req.body?.role) });
});

/** DELETE /api/docs/:id/people/:userId (the owner, or someone leaving) */
export const removePerson = handle(async (req, res) => {
    const out = await removeDocPerson(requireUser(req).id, param(req, 'id'), param(req, 'userId'));
    res.status(200).json('left' in out ? { success: true, left: true } : { success: true, data: out });
});

/** POST /api/docs/:id/requests/:reqId/approve · /decline */
export const answerRequest = (answer: 'approve' | 'decline'): RequestHandler =>
    handle(async (req, res) => {
        res.status(200).json({ success: true, data: await answerDocRequest(requireUser(req).id, param(req, 'id'), param(req, 'reqId'), answer) });
    });

/** GET /api/public/docs/:slug (anyone; a login cookie only adds what the reader may do). */
export const readPublic = handle(async (req, res) => {
    const doc = await readPublishedDoc(param(req, 'slug'), await cookieUserId(req));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ success: true, data: doc });
});

/** POST /api/public/docs/:slug/request (logged in): ask to edit. */
export const requestEdit = handle(async (req, res) => {
    const user = requireUser(req);
    const outcome = await requestToEdit(param(req, 'slug'), { id: user.id, name: user.name, email: user.email });
    res.status(outcome === 'requested' ? 201 : 200).json({ success: true, status: 'pending', already: outcome === 'already-pending' });
});
