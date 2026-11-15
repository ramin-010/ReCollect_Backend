// The morning notification (ALWAYS_ON_SPEC 6.3): Web Push to every browser or installed app the user
// switched it on in. One quiet line a day at the morning email's time ("3 revisions, about 12 min ·
// next: Caching part 2"); nothing on an empty day. The day is claimed (lastPushDay) before sending,
// like the email, so overlapping passes never send twice. A dead endpoint (404/410) is deleted.
import { prisma } from '../../db/prisma';
import { currentLine } from '../buddy/voice';
import { buddySettings } from '../buddy/state.service';
import { isNudgeDue, resolveTimeZone, today as todayIn } from '../learning';
import { fromDbDayOrNull, toDbDay } from '../learningDb/common';
import { buildMorningNudge } from '../learningDb/nudge.service';

// web-push 3.6.7 (MPL-2.0): no types shipped; the three calls we use.
interface WebPush {
    setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
    sendNotification(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options?: { TTL?: number }): Promise<{ statusCode: number }>;
}
let webpush: WebPush | null = null;

export class PushNotConfigured extends Error {
    constructor() {
        super('Notifications are not set up on the server (VAPID keys missing).');
    }
}

function client(): WebPush {
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    if (!pub || !priv) throw new PushNotConfigured();
    if (!webpush) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        webpush = require('web-push') as WebPush;
        webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:noreply@recollect.local', pub, priv);
    }
    return webpush;
}

export function vapidPublicKey(): string | null {
    return process.env.VAPID_PUBLIC_KEY || null;
}

export interface PushSubscriptionInput {
    endpoint: string;
    keys: { p256dh: string; auth: string };
}

export async function saveSubscription(userId: string, sub: PushSubscriptionInput): Promise<{ saved: true }> {
    await prisma.pushSubscription.upsert({
        where: { endpoint: sub.endpoint },
        create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        update: { userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    return { saved: true };
}

export async function removeSubscription(userId: string, endpoint: string): Promise<{ removed: number }> {
    const r = await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
    return { removed: r.count };
}

export async function countSubscriptions(userId: string): Promise<number> {
    return prisma.pushSubscription.count({ where: { userId } });
}

export interface PushMessage {
    title: string;
    body: string;
    url: string;
}

/** Sends one message to every subscription of the user; deletes the dead ones. */
export async function pushToUser(userId: string, message: PushMessage): Promise<{ sent: number; removed: number }> {
    const subs = await prisma.pushSubscription.findMany({ where: { userId } });
    const wp = client();
    let sent = 0;
    let removed = 0;
    for (const s of subs) {
        try {
            await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(message), { TTL: 6 * 3600 });
            sent++;
        } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
                await prisma.pushSubscription.deleteMany({ where: { id: s.id } });
                removed++;
            } else console.error(`[push] send failed (${status ?? 'no status'}) for user ${userId}`);
        }
    }
    return { sent, removed };
}

/**
 * The morning line: the buddy's morning line when it has one the lock check passed (a notification
 * shows on the lock screen too; its private note never goes here), then the email's digest; null on
 * a day with nothing to say.
 */
export async function morningLine(userId: string, now: Date = new Date()): Promise<PushMessage | null> {
    const [nudge, line, buddy] = await Promise.all([buildMorningNudge(userId, now), currentLine(userId, now), buddySettings(userId)]);
    const said = buddy.enabled && !buddy.paused && line && line.lockOk && !line.fallback ? line.text : null;
    const lead = nudge.heading === 'Busy week' || nudge.heading === 'Welcome back' ? `${nudge.heading}: ${nudge.intro}` : nudge.intro;
    if (said) return { title: buddy.name ? `From ${buddy.name}` : 'From your buddy', body: nudge.items.length ? `${said} · ${lead}` : said, url: '/' };
    if (!nudge.items.length) return null;
    const next = nudge.items[0]?.title;
    const total = nudge.items.length + nudge.moreCount;
    return { title: total === 1 ? 'One thing to revise today' : 'Today in Recollect', body: next ? `${lead} Next: ${next}.` : lead, url: '/' };
}

export interface PushPassResult {
    checked: number;
    sent: number;
    empty: number;
}

/** One pass of the 15-minute cron: users with a subscription whose morning time has come. */
export async function runMorningPushPass(now: Date = new Date()): Promise<PushPassResult> {
    if (!vapidPublicKey()) return { checked: 0, sent: 0, empty: 0 };
    const users = await prisma.user.findMany({
        where: { isGhost: false, pushSubscriptions: { some: {} } },
        select: { id: true, timezone: true, nudgeTime: true, lastPushDay: true },
        orderBy: { id: 'asc' },
    });
    const result: PushPassResult = { checked: users.length, sent: 0, empty: 0 };
    for (const u of users) {
        const tz = resolveTimeZone(u.timezone);
        if (!isNudgeDue({ now, tz, nudgeTime: u.nudgeTime, lastNudgeDay: fromDbDayOrNull(u.lastPushDay) })) continue;
        const today = todayIn(tz, now);
        const claimed = await prisma.user.updateMany({
            where: { id: u.id, OR: [{ lastPushDay: null }, { lastPushDay: { not: toDbDay(today) } }] },
            data: { lastPushDay: toDbDay(today) },
        });
        if (claimed.count === 0) continue;
        try {
            const line = await morningLine(u.id, now);
            if (!line) {
                result.empty++;
                continue;
            }
            const r = await pushToUser(u.id, line);
            if (r.sent > 0) result.sent++;
        } catch (err) {
            console.error(`[push] morning pass failed for user ${u.id}:`, err);
        }
    }
    return result;
}
