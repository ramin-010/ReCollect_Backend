// Scope checks for routes behind authMiddleware. A cookie session has every scope, so these never
// change what the app (cookie) can do; they only limit personal access tokens (agents).
//
// authMiddleware already refuses a token on any endpoint not listed in
// src/services/apiTokens/tokenRoutes.ts (and checks the scope listed there); these are the
// per-route statements of the same rules, so a route stays safe if it is ever listed by mistake.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import ErrorResponse from '../utils/errorResponse';
import authMiddleware from './auth';
import type { ApiScope } from '../types/auth';

/** The request must carry `scope` (403 for a token without it). */
export function requireScope(scope: ApiScope, ...also: ApiScope[]): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction) => {
        if (!req.auth) return next(new ErrorResponse(401, 'Not authorized, no token found'));
        const scopes = req.auth.scopes;
        if (![scope, ...also].some((s) => scopes.includes(s))) return next(new ErrorResponse(403, `This access token lacks the "${scope}" scope`));
        next();
    };
}

/** GET/HEAD need `read`; every other method needs `writeScope` (a router's write scope). */
export function scopeByMethod(writeScope: ApiScope): RequestHandler {
    const read = requireScope('read');
    const write = requireScope(writeScope);
    return (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? read : write)(req, res, next);
}

/** Cookie sessions only: access tokens get a 403 (tokens, account, Home's Undo/seen for agent edits). */
export const cookieOnly: RequestHandler = (req, _res, next) => {
    if (req.auth?.via === 'token') return next(new ErrorResponse(403, 'Access tokens cannot be used for this endpoint'));
    next();
};

/**
 * authMiddleware, skipped when an earlier router already authenticated this request (userRoutes
 * runs it for every /api request it sees), without relying on that mount order.
 */
export const authOnce: RequestHandler = (req, res, next) => (req.user && req.auth ? next() : authMiddleware(req, res, next));
