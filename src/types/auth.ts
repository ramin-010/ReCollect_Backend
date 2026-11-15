import type { User } from '@prisma/client';

/**
 * What authMiddleware puts on `req.user`: the Postgres user row WITHOUT the password, plus `_id`
 * (same string as `id`) so existing code such as `req.user._id`, `req.user.id` and
 * `x.toString() === req.user._id` keeps working. It is a plain object, not a Mongoose document:
 * there is no .save(), .populate() or .toObject().
 */
export type AuthUser = Omit<User, 'password'> & { _id: string };

/** Personal access token scopes. A cookie session has all of them. */
export const API_SCOPES = ['read', 'docs:write', 'learning:write', 'sessions:write', 'tasks:write'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/**
 * What authMiddleware puts on `req.auth`: how the request was authenticated.
 *   cookie: the app (the JWT cookie), every scope.
 *   token : a personal access token (an agent): its scopes, and the agent's name for provenance
 *           (the X-Agent-Name header, else the token's name).
 */
export type RequestAuth =
    | { via: 'cookie'; scopes: readonly ApiScope[] }
    | { via: 'token'; tokenId: string; scopes: readonly ApiScope[]; agentName: string };
