// "Send feedback" and the phone's diagnostics (ECOSYSTEM_V2_PLAN stage 11, §9.6 item 5 and the owner's item 10d): what a
// person sends the owner, shown on the People page. Feedback is their own words; diagnostics are the phone's facts
// (model, Android version, screen size, permissions, the last update times), never anything personal.
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';

export const FEEDBACK_MAX = 4000;
/** At most this many a day per person (a stuck button or a script never floods the owner's page). */
export const FEEDBACK_PER_DAY = 20;

async function underDailyLimit(userId: string, kind: string, now: Date): Promise<void> {
    const n = await prisma.feedback.count({ where: { userId, kind, createdAt: { gte: new Date(now.getTime() - 86_400_000) } } });
    if (n >= FEEDBACK_PER_DAY) throw new ErrorResponse(429, 'That’s a lot for one day. Try again tomorrow.');
}

/** POST /api/feedback {text, page?}: their words to the owner. */
export async function sendFeedback(userId: string, input: { text: string; page?: string | undefined; source: 'web' | 'phone' }, now: Date = new Date()): Promise<{ id: string }> {
    const text = input.text.replace(/\r\n/g, '\n').trim().slice(0, FEEDBACK_MAX);
    if (!text) throw new ErrorResponse(400, 'Write something first.');
    await underDailyLimit(userId, 'feedback', now);
    const page = input.page?.trim().slice(0, 200);
    return prisma.feedback.create({ data: { userId, kind: 'feedback', text, source: input.source, ...(page ? { details: { page } } : {}), createdAt: now }, select: { id: true } });
}

/** POST /api/phone/diagnostics {…}: the phone app's facts (checked by the controller's schema). */
export async function sendDiagnostics(userId: string, details: Record<string, unknown>, now: Date = new Date()): Promise<{ id: string }> {
    await underDailyLimit(userId, 'diagnostics', now);
    return prisma.feedback.create({ data: { userId, kind: 'diagnostics', source: 'phone', details: details as Prisma.InputJsonValue, createdAt: now }, select: { id: true } });
}
