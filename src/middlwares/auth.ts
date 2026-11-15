import { Request, Response, NextFunction } from "express"
import ErrorResponse from "../utils/errorResponse";
import jwt from 'jsonwebtoken'
import dotenv from 'dotenv'
dotenv.config();

import { findUserById, toAuthUser } from '../services/users/users.service';
import { API_TOKEN_PREFIX, findApiToken, storedScopes, touchApiToken } from '../services/apiTokens/apiTokens.service';
import { tokenRouteScope } from '../services/apiTokens/tokenRoutes';
import { API_SCOPES, type AuthUser, type RequestAuth } from '../types/auth';

const COOKIE_AUTH: RequestAuth = Object.freeze({ via: 'cookie', scopes: API_SCOPES });

/** Longest agent name kept (AgentEdit.agentName). */
export const AGENT_NAME_MAX = 60;

/** `Authorization: Bearer rcl_…` → the token; anything else (no header, other schemes) → null. */
function bearerApiToken(req: Request): string | null {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    return match?.[1]?.startsWith(API_TOKEN_PREFIX) ? match[1] : null;
}

/** The X-Agent-Name header (printable, trimmed, ≤ 60 chars), else the token's name. */
export function agentNameFor(header: unknown, tokenName: string): string {
    const raw = typeof header === 'string' ? header : '';
    const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (clean || tokenName.trim() || 'agent').slice(0, AGENT_NAME_MAX);
}

/**
 * Access-token authentication (an agent). The token must exist and not be revoked (401), the
 * endpoint must accept tokens (src/services/apiTokens/tokenRoutes.ts) and the token must have the
 * scope it needs (403). Then req.user is set exactly like cookie auth, plus req.auth.
 */
async function authenticateApiToken(req: Request, token: string): Promise<void> {
    const row = await findApiToken(token);
    if (!row) throw new ErrorResponse(401, 'Invalid access token');
    if (row.revokedAt) throw new ErrorResponse(401, 'This access token was revoked');
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) throw new ErrorResponse(401, 'This access token has expired');

    const needed = tokenRouteScope(req.method, req.originalUrl);
    if (!needed) throw new ErrorResponse(403, 'Access tokens cannot be used for this endpoint');
    const scopes = storedScopes(row.scopes);
    if (!scopes.includes(needed)) throw new ErrorResponse(403, `This access token lacks the "${needed}" scope`);

    const user = await findUserById(row.userId);
    if (!user) throw new ErrorResponse(404, "User not found");

    await touchApiToken(row);
    req.user = toAuthUser(user);
    req.auth = { via: 'token', tokenId: row.id, scopes, agentName: agentNameFor(req.headers['x-agent-name'], row.name) };
}

/**
 * Reads the `token` cookie, verifies the JWT and loads the user from Postgres into `req.user`
 * (a plain object without the password, with both `id` and `_id`), and sets req.auth (cookie:
 * every scope).
 *
 * Same responses as before: no cookie → 401, bad token → 404 "Invalid token",
 * unknown user → 404 "User not found".
 * One deliberate change: an EXPIRED token is now 401 "Not authorized, token expired". It used to
 * call next() with no req.user, which with Prisma is dangerous: `where: { userId: undefined }`
 * means "no filter" and would match every user's rows.
 *
 * `Authorization: Bearer rcl_…` (a personal access token, for agents) is checked instead of the
 * cookie: see authenticateApiToken. Other Authorization headers are ignored, as before.
 */
const authMiddleware = async (req: Request, res: Response, next: NextFunction) : Promise<void>=> {
    try {
        const apiToken = bearerApiToken(req);
        if (apiToken) {
            await authenticateApiToken(req, apiToken);
            return next();
        }

        const token = req.cookies?.token;

        if (!token) {
            throw new ErrorResponse(401, "Not authorized, no token found");
        }

        if (!process.env.JWT_SECRET) {
            throw new ErrorResponse(400, "JWT_SECRET is not defined in environment variables");
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET) as { id?: unknown };
        const user = typeof decoded.id === 'string' ? await findUserById(decoded.id) : null;

        if (!user) {
            throw new ErrorResponse(404, "User not found");
        }

        req.user = toAuthUser(user);
        req.auth = COOKIE_AUTH;
        next();
    } catch (err : any) {
        if(err.name === 'JsonWebTokenError'){
            return next(new ErrorResponse(404, "Invalid token"))
        }
        if(err.name === 'TokenExpiredError'){
            return next(new ErrorResponse(401, "Not authorized, token expired"))
        }
        next(err);
    }
};

/**
 * For handlers behind authMiddleware: returns req.user or throws 401. Use it instead of
 * `req.user?._id` so a missing user can never turn into an unfiltered Prisma query.
 */
export function requireUser(req: Request): AuthUser {
    if (!req.user) {
        throw new ErrorResponse(401, "Not authorized, no token found");
    }
    return req.user;
}

/** True when an access token (an agent), not the app's cookie, authenticated the request. */
export function isTokenRequest(req: Request): boolean {
    return req.auth?.via === 'token';
}

export default authMiddleware;
