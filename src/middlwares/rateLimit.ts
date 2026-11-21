// Limits on the doors (hosting P1-4): how often one address, and one email, may try to log in,
// sign up, reset a password, ask for or check a code, sign in with Google, register an OAuth
// client or fetch a token, and knock on /mcp without a valid token. Over the limit: 429.
//
// In memory (express-rate-limit's store): the server is one process. The address is clientIp()
// (CF-Connecting-IP only with TRUST_CF_IP=1 from loopback). Under NODE_ENV=test each limiter is a
// pass-through unless a test asks for a real one (the suite signs up hundreds of times from one
// address); codes have their own always-on limits in services/auth/otp.service.ts.
import { isIP } from 'node:net';
import type { Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { clientIp } from '../utils/clientIp';

export interface DoorRule {
    windowMinutes: number;
    perIp: number;
    /** Also per email named in the body. */
    perEmail?: number;
    /** Count only the answers that failed (status 400 and up): /mcp, where a valid token passes freely. */
    failuresOnly?: boolean;
}

export const DOORS = {
    login: { windowMinutes: 15, perIp: 20, perEmail: 10 },
    signup: { windowMinutes: 60, perIp: 10, perEmail: 5 },
    reset: { windowMinutes: 60, perIp: 10, perEmail: 5 },
    code: { windowMinutes: 60, perIp: 30, perEmail: 15 },
    google: { windowMinutes: 15, perIp: 20 },
    oauthRegister: { windowMinutes: 60, perIp: 20 },
    oauthToken: { windowMinutes: 15, perIp: 60 },
    mcp: { windowMinutes: 15, perIp: 30, failuresOnly: true },
    // Stage 11: looking up an invite link's code (no login); unknown codes count.
    invite: { windowMinutes: 15, perIp: 30, failuresOnly: true },
} as const satisfies Record<string, DoorRule>;

export type Door = keyof typeof DOORS;

const emailOf = (req: Request): string | null => {
    const e = (req.body as { email?: unknown } | undefined)?.email;
    return typeof e === 'string' && e.trim() ? e.trim().toLowerCase() : null;
};

const ipKey = (req: Request): string => {
    const ip = clientIp(req);
    return isIP(ip) ? ipKeyGenerator(ip) : ip; // IPv6 counted per /56, as the library advises
};

const tooMany = (_req: Request, res: Response) => {
    res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many tries. Wait a few minutes and try again.' });
};

const passThrough: RequestHandler = (_req, _res, next) => next();

/** The limiter for a door: per address, then per email when the body names one. */
export function doorLimit(door: Door, opts: { force?: boolean; env?: NodeJS.ProcessEnv } = {}): RequestHandler {
    const env = opts.env ?? process.env;
    if (env['NODE_ENV'] === 'test' && !opts.force) return passThrough;
    const rule: DoorRule = DOORS[door];
    const common = {
        windowMs: rule.windowMinutes * 60_000,
        standardHeaders: 'draft-7' as const,
        legacyHeaders: false,
        handler: tooMany,
        skipSuccessfulRequests: rule.failuresOnly === true,
        // The address comes from clientIp(), never from Express's proxy settings.
        validate: { trustProxy: false, xForwardedForHeader: false, forwardedHeader: false },
    };
    const byIp = rateLimit({ ...common, limit: rule.perIp, keyGenerator: (req) => `${door}:ip:${ipKey(req)}` });
    if (!rule.perEmail) return byIp;
    const byEmail = rateLimit({ ...common, limit: rule.perEmail, keyGenerator: (req) => `${door}:email:${emailOf(req)}`, skip: (req) => !emailOf(req) });
    return (req, res, next) => {
        byIp(req, res, (err?: unknown) => (err ? next(err) : byEmail(req, res, next)));
    };
}
