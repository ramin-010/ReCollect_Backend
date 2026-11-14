// `Idempotency-Key` for POST/PUT/PATCH routes agents call (retry-safe writes). Behind authMiddleware.
//
//   no header                       → the route runs as usual
//   new key                         → the route runs; its response (status < 500) is kept 24 h
//   same key, same request, done    → the first response again (header Idempotent-Replayed: true)
//   same key, still running         → 409
//   same key, different request     → 422
// A 5xx is not kept, so a retry runs the route again. Keys are per user. The browser app never
// sends the header (CORS does not even allow it), so cookie behaviour is unchanged.
import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { isUniqueViolation } from '../db/errors';
import ErrorResponse from '../utils/errorResponse';
import { pathOf } from '../services/apiTokens/tokenRoutes';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_FORMAT = /^[\x21-\x7e]{1,200}$/;

function fingerprintOf(req: Request): string {
    const body = JSON.stringify(req.body ?? null) ?? 'null';
    return crypto.createHash('sha256').update(`${req.method} ${pathOf(req.originalUrl)}\n${body}`).digest('hex');
}

export const idempotency: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const key = req.get('Idempotency-Key');
    if (key === undefined) return next();
    run(req, res, next, key.trim()).catch(next);
};

async function run(req: Request, res: Response, next: NextFunction, key: string): Promise<void> {
    if (!KEY_FORMAT.test(key)) throw new ErrorResponse(400, 'Idempotency-Key must be 1–200 visible ASCII characters');
    const userId = req.user?.id;
    if (!userId) throw new ErrorResponse(401, 'Not authorized, no token found');
    const fingerprint = fingerprintOf(req);
    const now = new Date();
    const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS);

    let row = await prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
    if (row && row.createdAt < cutoff) {
        await prisma.idempotencyKey.deleteMany({ where: { id: row.id } });
        row = null;
    }
    if (row) {
        if (row.fingerprint !== fingerprint) throw new ErrorResponse(422, 'This Idempotency-Key was already used for a different request');
        if (row.statusCode === null) throw new ErrorResponse(409, 'A request with this Idempotency-Key is still running');
        res.set('Idempotent-Replayed', 'true');
        res.status(row.statusCode).json(row.response);
        return;
    }

    let rowId: string;
    try {
        rowId = (await prisma.idempotencyKey.create({ data: { userId, key, fingerprint }, select: { id: true } })).id;
    } catch (err) {
        if (isUniqueViolation(err)) throw new ErrorResponse(409, 'A request with this Idempotency-Key is still running');
        throw err;
    }
    // Expired keys of everyone, now and then (the table only needs the last 24 h).
    await prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: cutoff } } });

    const send = res.json.bind(res);
    res.json = ((body: unknown) => {
        const status = res.statusCode;
        // Stored as the client receives it (dates as ISO strings).
        const response: Prisma.InputJsonValue | typeof Prisma.JsonNull =
            body === undefined || body === null ? Prisma.JsonNull : (JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue);
        const keep: Promise<unknown> =
            status < 500
                ? prisma.idempotencyKey.update({ where: { id: rowId }, data: { statusCode: status, response }, select: { id: true } })
                : prisma.idempotencyKey.deleteMany({ where: { id: rowId } });
        // The response leaves once it is kept, so an immediate retry is a replay, never a re-run.
        keep.catch((err: unknown) => console.error('[idempotency] could not keep a response:', err)).finally(() => send(body));
        return res;
    }) as Response['json'];
    next();
}
