// Personal access tokens (Settings → Tokens). Cookie sessions only (the router refuses tokens), so
// an agent can never mint or revoke tokens. Envelope: { success: true, data }.
import { requireUser } from '../middlwares/auth';
import { createApiToken, listApiTokens, revokeApiToken } from '../services/apiTokens/apiTokens.service';
import { handler, ok, param } from './learning/common';

/** GET /api/tokens → [{ _id, name, prefix, scopes, lastUsedAt, revokedAt, createdAt }] (never the token). */
export const listTokens = handler(async (req, res) => {
    ok(res, await listApiTokens(requireUser(req).id));
});

/** POST /api/tokens {name, scopes} → 201 { …, token } (the plain token, shown this once). */
export const createToken = handler(async (req, res) => {
    ok(res, await createApiToken(requireUser(req).id, { name: req.body?.name, scopes: req.body?.scopes }), 201);
});

/** DELETE /api/tokens/:id → { …, revokedAt }. */
export const revokeToken = handler(async (req, res) => {
    ok(res, await revokeApiToken(requireUser(req).id, param(req, 'id')));
});
