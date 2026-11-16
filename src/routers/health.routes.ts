// Health checks (hosting P1-8).
//
// GET /healthz: 200 while the process is up. It never touches the database: an outside checker
// calls it every few minutes, and a hosted database that sleeps when idle (Neon) must stay asleep.
// It sits before CORS and every login check (it says nothing but "up").
//
// GET /api/health/db: one `SELECT 1` and how long it took, for a manual check. Cookie sessions only
// (an access token gets 403), and only the owner's account when OWNER_EMAIL is set.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { prisma } from '../db/prisma';
import { ownerEmail } from '../config/owner';
import { requireUser } from '../middlwares/auth';
import { authOnce, cookieOnly } from '../middlwares/scopes';
import ErrorResponse from '../utils/errorResponse';

export const healthzRouter = Router();

healthzRouter.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
});

/** OWNER_EMAIL set: only that account (403 for any other). Unset: any signed-in cookie. */
function ownerOnly(req: Request, _res: Response, next: NextFunction): void {
    const owner = ownerEmail();
    if (owner && requireUser(req).email.trim().toLowerCase() !== owner) {
        return next(new ErrorResponse(403, 'Only the owner of this server can check its database'));
    }
    next();
}

/** A Prisma or driver error's code (P1001, ECONNREFUSED, ...) without its message (it can name the host). */
function errorCode(err: unknown): string {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'UNREACHABLE';
}

export const healthDbRouter = Router();

healthDbRouter.get('/', authOnce, cookieOnly, ownerOnly, async (_req: Request, res: Response) => {
    const started = Date.now();
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.status(200).json({ success: true, data: { database: 'up', ms: Date.now() - started } });
    } catch (err) {
        res.status(503).json({ success: false, data: { database: 'down', ms: Date.now() - started, code: errorCode(err) } });
    }
});
