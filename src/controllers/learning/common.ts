// Shared bits of the thin learning controllers: zod parsing (400 { message, code }) and the
// async handler wrapper. Envelope: { success: true, data }.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { badRequest } from '../../services/learning/http';
import { isValidDay, type DayString } from '../../services/learning/time';

/** Parse with zod; the first issue becomes a 400 INVALID_INPUT. */
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
    const result = schema.safeParse(value ?? {});
    if (result.success) return result.data;
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw badRequest(`${path}${issue?.message ?? 'Invalid input'}`);
}

/** async (req, res) → RequestHandler with errors passed to next(). */
export function handler(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        fn(req, res).catch(next);
    };
}

export const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });

/** A route param as a non-empty string. */
export function param(req: Request, name: string): string {
    const v = req.params[name];
    if (typeof v !== 'string' || !v) throw badRequest(`Missing ${name}`);
    return v;
}

export const zDay = z.string().refine((v): v is DayString => isValidDay(v), { message: "must be a calendar day 'YYYY-MM-DD'" });
export const zId = z.string().trim().min(1).max(128);
export const zSlotStatus = z.enum(['UPCOMING', 'ACTIVE', 'COMPLETED', 'SKIPPED', 'PARTIAL']);
export const zRating = z.number().int().min(1).max(5).nullable();
export const zAttachment = z.object({
    url: z.string().min(1).max(2048),
    publicId: z.string().max(512),
    fileName: z.string().max(512),
    fileType: z.string().max(256),
});
