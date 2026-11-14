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

function cookieEnv() {
    const isProduction = process.env.NODE_ENV === 'production';
    // Let the browser default to the API host natively for standard cross-origin setups
    const cookieDomain = isProduction ? process.env.COOKIE_DOMAIN || undefined : undefined;
    return { isProduction, cookieDomain };
}

/** Options for the `token` and `auth_hint` cookies (JWT_COOKIE_EXPIRE is in days). */
export function authCookieOptions(now: number = Date.now()): { token: CookieOptions; hint: CookieOptions } {
    if (!process.env.JWT_COOKIE_EXPIRE) {
        throw new ErrorResponse(400, 'JWT_COOKIE_EXPIRE is undefined');
    }
    const days = parseInt(process.env.JWT_COOKIE_EXPIRE);
    const maxAge = days * 24 * 60 * 60 * 1000;
    const { isProduction, cookieDomain } = cookieEnv();

    return {
        token: {
            expires: new Date(now + maxAge),
            httpOnly: true,
            secure: isProduction, // Needs to be false for local HTTP testing
            sameSite: isProduction ? 'none' : 'lax', // Needs to be 'none' for cross-domain API
            domain: cookieDomain,
        },
        hint: {
            httpOnly: false,
            secure: isProduction,
            sameSite: isProduction ? 'none' : 'lax',
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
    const { isProduction, cookieDomain } = cookieEnv();

    res.cookie(AUTH_COOKIE_NAME, '', {
        httpOnly: true,
        expires: new Date(0),
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        domain: cookieDomain,
    });

    // Clear the auth hint cookie too
    res.cookie(AUTH_HINT_COOKIE_NAME, '', {
        httpOnly: false,
        expires: new Date(0),
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        domain: cookieDomain,
    });
}
