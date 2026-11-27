// The People page, invites, feedback and the phone's diagnostics (ECOSYSTEM_V2_PLAN stage 11).
//
//   GET    /api/owner/check                      → { owner }               any signed-in cookie (the sidebar's link)
//   GET    /api/owner/people                     → the People page         the owner only (OWNER_EMAIL), cookie only
//   POST   /api/owner/people {email, name, allowanceUsd?}  → an invite link, or a grant to an account that exists
//   POST   /api/owner/people/:id/top-up {amountUsd, note?}
//   PATCH  /api/owner/people/:id {dailyCapUsd}   "Set budget": their limit a day (null: $1)
//   POST   /api/owner/people/:id/end-access | /restore-access
//   DELETE /api/owner/invites/:id               revoke
//   PATCH  /api/owner/friends {ceilingUsd}       the friends' monthly ceiling
//   GET    /api/invites/:code                    the signup page's invite (no login; limited per address)
//   POST   /api/feedback {text, page?}           "Send feedback" (cookie, or the phone app's token)
//   POST   /api/phone/diagnostics {…}            the phone app's facts (its token)
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { requireUser, isTokenRequest } from '../middlwares/auth';
import { handler, ok, param, parse } from './learning/common';
import ErrorResponse from '../utils/errorResponse';
import { ownerEmail } from '../config/owner';
import { setDailyCapUsd, setFriendsCeilingUsd, INVITE_ALLOWANCE_USD } from '../services/claude/allowance';
import { addPerson, endAccess, peopleView, restoreAccess, topUp } from '../services/owner/people.service';
import { inviteView, revokeInvite } from '../services/owner/invites.service';
import { sendDiagnostics, sendFeedback, FEEDBACK_MAX } from '../services/owner/feedback.service';
import { firstRunFor, updateFirstRun } from '../services/users/firstRun.service';
import { exportAccount } from '../services/users/accountExport.service';
import { logAction, logViews, ownerAccessOf } from '../services/owner/ownerAccess.service';
import { accountSummary } from '../services/users/accountSummary.service';
import { isOwnerAccount } from '../services/claude/allowance';

/** TRUST_PLAN T4: a row in the person's own log; a logging failure never fails the owner's action. */
function logged(what: Promise<unknown>): Promise<void> {
    return what.then(
        () => undefined,
        (err: unknown) => console.warn(`[owner] the access log missed a row: ${(err as Error).message}`)
    );
}

const isOwnerEmail = (email: string) => {
    const owner = ownerEmail();
    return !!owner && email.trim().toLowerCase() === owner;
};

/** The owner only (OWNER_EMAIL set and matching): 403 for anyone else, and for everyone while it is unset. */
export function ownerOnly(req: Request, _res: Response, next: NextFunction): void {
    if (!ownerEmail()) return next(new ErrorResponse(403, 'The People page needs OWNER_EMAIL set on this server.'));
    if (!isOwnerEmail(requireUser(req).email)) return next(new ErrorResponse(403, 'Only the owner of this server can open the People page.'));
    next();
}

export const checkHandler = handler(async (req, res) => {
    ok(res, { owner: isOwnerEmail(requireUser(req).email) });
});

export const peopleHandler = handler(async (_req, res) => {
    const view = await peopleView();
    // TRUST_PLAN T4: each person the page shows gets a row in their own log (one an hour); the owner's own never.
    await logged(logViews(view.people.filter((p) => !p.isOwner).map((p) => p.id)));
    ok(res, view);
});

const zUsd = z.number().finite().min(0).max(500);

export const addPersonHandler = handler(async (req, res) => {
    const input = parse(
        z.object({ email: z.string().trim().email().max(320), name: z.string().trim().max(50).default(''), allowanceUsd: zUsd.default(INVITE_ALLOWANCE_USD) }).strict(),
        req.body
    );
    ok(res, await addPerson(requireUser(req).id, input), 201);
});

export const topUpHandler = handler(async (req, res) => {
    const input = parse(z.object({ amountUsd: zUsd.refine((n) => n > 0, { message: 'more than $0' }), note: z.string().trim().max(200).optional() }).strict(), req.body);
    const ownerId = requireUser(req).id;
    const personId = param(req, 'id');
    await topUp(ownerId, personId, input.amountUsd, input.note);
    if (personId !== ownerId) await logged(logAction(personId, 'topped_up', { usd: input.amountUsd }));
    ok(res, { done: true });
});

export const setBudgetHandler = handler(async (req, res) => {
    const input = parse(z.object({ dailyCapUsd: zUsd.nullable() }).strict(), req.body);
    const personId = param(req, 'id');
    await setDailyCapUsd(personId, input.dailyCapUsd);
    if (personId !== requireUser(req).id) await logged(logAction(personId, 'limit_set', { limitUsd: input.dailyCapUsd }));
    ok(res, { done: true });
});

export const endAccessHandler = handler(async (req, res) => {
    const personId = param(req, 'id');
    await endAccess(requireUser(req).id, personId);
    await logged(logAction(personId, 'access_ended'));
    ok(res, { done: true });
});

export const restoreAccessHandler = handler(async (req, res) => {
    const personId = param(req, 'id');
    await restoreAccess(personId);
    if (personId !== requireUser(req).id) await logged(logAction(personId, 'access_restored'));
    ok(res, { done: true });
});

export const revokeInviteHandler = handler(async (req, res) => {
    ok(res, { revoked: await revokeInvite(param(req, 'id')) });
});

export const ceilingHandler = handler(async (req, res) => {
    const input = parse(z.object({ ceilingUsd: z.number().finite().min(0).max(5000) }).strict(), req.body);
    ok(res, { ceilingUsd: await setFriendsCeilingUsd(input.ceilingUsd) });
});

export const inviteViewHandler = handler(async (req, res) => {
    const view = await inviteView(param(req, 'code'));
    if (!view) throw new ErrorResponse(404, 'This invite link is not known here. Check the link, or ask for a new one.');
    ok(res, view);
});

export const feedbackHandler = handler(async (req, res) => {
    const input = parse(z.object({ text: z.string().max(FEEDBACK_MAX * 2), page: z.string().max(200).optional() }).strict(), req.body);
    ok(res, await sendFeedback(requireUser(req).id, { text: input.text, page: input.page, source: isTokenRequest(req) ? 'phone' : 'web' }), 201);
});

/** The phone's facts only: short strings, numbers, booleans and times; anything else is refused. */
const zFact = z.union([z.string().max(80), z.number().finite(), z.boolean(), z.null()]);
const diagnosticsSchema = z
    .object({
        appVersion: z.string().max(40).optional(),
        model: z.string().max(80).optional(),
        maker: z.string().max(40).optional(),
        android: z.string().max(20).optional(),
        sdk: z.number().int().min(1).max(100).optional(),
        screen: z.object({ width: z.number().int().min(1).max(10000), height: z.number().int().min(1).max(10000), density: z.number().finite().min(0).max(10).optional() }).strict().optional(),
        wallpaper: z.record(z.string().max(40), zFact).optional(),
        permissions: z.record(z.string().max(40), zFact).optional(),
        lastUpdates: z.record(z.string().max(40), zFact).optional(),
    })
    .strict();

/** GET /api/account/export: everything this account keeps, as one JSON file (stage 11, §9.6 item 6). */
export const accountExportHandler = handler(async (req, res) => {
    const data = await exportAccount(requireUser(req).id);
    res.setHeader('Content-Disposition', `attachment; filename="recollect-export-${data.exportedAt.slice(0, 10)}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    ok(res, data);
});

/** GET /api/account/summary (TRUST_PLAN T3): what Kaaga keeps for this account, and who can see it. */
export const accountSummaryHandler = handler(async (req, res) => {
    ok(res, await accountSummary(requireUser(req).id));
});

/** GET /api/account/owner-access (TRUST_PLAN T4): what the app showed the owner of this account, and what they did. */
export const ownerAccessHandler = handler(async (req, res) => {
    const userId = requireUser(req).id;
    const isOwner = await isOwnerAccount(userId);
    ok(res, { isOwner, rows: isOwner ? [] : await ownerAccessOf(userId) });
});

/** GET /api/first-run: Home's checklist for a new account (stage 11, §9.6 item 2). */
export const firstRunHandler = handler(async (req, res) => {
    ok(res, await firstRunFor(requireUser(req).id));
});

/** PATCH /api/first-run {zoneOk?, dismissed?} */
export const updateFirstRunHandler = handler(async (req, res) => {
    const input = parse(z.object({ zoneOk: z.literal(true).optional(), dismissed: z.literal(true).optional() }).strict(), req.body);
    ok(res, await updateFirstRun(requireUser(req).id, input));
});

export const diagnosticsHandler = handler(async (req, res) => {
    const details = parse(diagnosticsSchema, req.body);
    ok(res, await sendDiagnostics(requireUser(req).id, details), 201);
});
