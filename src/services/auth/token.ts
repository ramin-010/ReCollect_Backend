// JWT + auth cookies, exactly as the Mongo version set them (userSchema.getSignedJwtToken and
// auth.controller sendTokenResponse/logout). Tests sign cookies with signAuthToken() too.
import jwt from 'jsonwebtoken';
import type { CookieOptions, Response } from 'express';
import ErrorResponse from '../../utils/errorResponse';
import { serializeUser, type SafeUserRow } from '../../db/serializers';

export const AUTH_COOKIE_NAME = 'token';
/** Non-HTTP-only hint cookie, readable by frontend JS for instant routing. */
export const AUTH_HINT_COOKIE_NAME = 'auth_hint';

/** Signs `{ id }` with JWT_SECRET, expiring after JWT_EXPIRE (default 30d). */
export function signAuthToken(userId: string): string {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is not defined in environment variables');
    }
    return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRE || '30d',
    } as jwt.SignOptions);
}

/**
 * The cookies' flags (hosting P1-6). COOKIE_SAMESITE (lax, strict or none) sets SameSite; unset,
 * today's: none in production (an API on another site), lax in dev. Production on one site
 * (re-collect.in and api.re-collect.in) sets lax. No Domain unless COOKIE_DOMAIN is set, and only
 * in production (as before): the cookie stays on the API's own host.
 */
function cookieEnv() {
    const isProduction = process.env.NODE_ENV === 'production';
    const cookieDomain = isProduction ? process.env.COOKIE_DOMAIN || undefined : undefined;
    const set = process.env.COOKIE_SAMESITE?.trim().toLowerCase();
    const sameSite: 'lax' | 'strict' | 'none' = set === 'lax' || set === 'strict' || set === 'none' ? set : isProduction ? 'none' : 'lax';
    return { isProduction, cookieDomain, sameSite };
}

/** Options for the `token` and `auth_hint` cookies (JWT_COOKIE_EXPIRE is in days). */
export function authCookieOptions(now: number = Date.now()): { token: CookieOptions; hint: CookieOptions } {
    if (!process.env.JWT_COOKIE_EXPIRE) {
        throw new ErrorResponse(400, 'JWT_COOKIE_EXPIRE is undefined');
    }
    const days = parseInt(process.env.JWT_COOKIE_EXPIRE);
    const maxAge = days * 24 * 60 * 60 * 1000;
    const { isProduction, cookieDomain, sameSite } = cookieEnv();

    return {
        token: {
            expires: new Date(now + maxAge),
            httpOnly: true,
            secure: isProduction, // Needs to be false for local HTTP testing
            sameSite,
            domain: cookieDomain,
        },
        hint: {
            httpOnly: false,
            secure: isProduction,
            sameSite,
            expires: new Date(now + maxAge),
            domain: cookieDomain,
        },
    };
}

/** Sign a token for the user, set both cookies and send `{ success: true, data: <user> }`. */
export function sendTokenResponse(user: SafeUserRow, statusCode: number, res: Response): void {
    const token = signAuthToken(user.id);
    const options = authCookieOptions();

    res.status(statusCode)
        .cookie(AUTH_COOKIE_NAME, token, options.token)
        .cookie(AUTH_HINT_COOKIE_NAME, '1', options.hint)
        .json({
            success: true,
            data: serializeUser(user),
        });
}

/** Expire both auth cookies (logout). */
export function clearAuthCookies(res: Response): void {
    const { isProduction, cookieDomain, sameSite } = cookieEnv();

    res.cookie(AUTH_COOKIE_NAME, '', {
        httpOnly: true,
        expires: new Date(0),
        secure: isProduction,
        sameSite,
        domain: cookieDomain,
    });

    // Clear the auth hint cookie too
    res.cookie(AUTH_HINT_COOKIE_NAME, '', {
        httpOnly: false,
        expires: new Date(0),
        secure: isProduction,
        sameSite,
        domain: cookieDomain,
    });
}
