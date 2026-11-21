// Stage 11: the People page (/api/owner, the owner only, cookie only), invite links (/api/invites, no login), "Send
// feedback" (/api/feedback) and the phone's diagnostics (/api/phone/diagnostics). See owner.controller.ts.
import express from 'express';
import { authOnce, cookieOnly } from '../middlwares/scopes';
import { doorLimit } from '../middlwares/rateLimit';
import {
    accountExportHandler,
    addPersonHandler,
    ceilingHandler,
    checkHandler,
    diagnosticsHandler,
    endAccessHandler,
    feedbackHandler,
    firstRunHandler,
    inviteViewHandler,
    ownerOnly,
    peopleHandler,
    restoreAccessHandler,
    revokeInviteHandler,
    setBudgetHandler,
    topUpHandler,
    updateFirstRunHandler,
} from '../controllers/owner.controller';

export const ownerRouter = express.Router();
ownerRouter.use(authOnce, cookieOnly);
ownerRouter.get('/check', checkHandler);
ownerRouter.use(ownerOnly);
ownerRouter.get('/people', peopleHandler);
ownerRouter.post('/people', addPersonHandler);
ownerRouter.post('/people/:id/top-up', topUpHandler);
ownerRouter.patch('/people/:id', setBudgetHandler);
ownerRouter.post('/people/:id/end-access', endAccessHandler);
ownerRouter.post('/people/:id/restore-access', restoreAccessHandler);
ownerRouter.delete('/invites/:id', revokeInviteHandler);
ownerRouter.patch('/friends', ceilingHandler);

/** No login: the signup page reads its invite. */
export const inviteRouter = express.Router();
inviteRouter.get('/:code', doorLimit('invite'), inviteViewHandler);

/** The app (cookie) or the phone app (its ambient token: tokenRoutes.ts). */
export const feedbackRouter = express.Router();
feedbackRouter.post('/feedback', authOnce, feedbackHandler);
feedbackRouter.post('/phone/diagnostics', authOnce, diagnosticsHandler);
// §9.6 item 6: "Download everything" (cookie only; DELETE /api/account is in user.routes.ts).
feedbackRouter.get('/account/export', authOnce, cookieOnly, accountExportHandler);
// The first run (§9.6 item 2): Home's checklist for a new account (cookie only).
feedbackRouter.get('/first-run', authOnce, cookieOnly, firstRunHandler);
feedbackRouter.patch('/first-run', authOnce, cookieOnly, updateFirstRunHandler);
