// The morning nudge email (LOOP_V2_SPEC §7). A cron every 15 minutes sends each learner one
// digest per local day: users with nudgeEmailEnabled whose local time is at or past nudgeTime and
// whose lastNudgeDay is not their today. The day is claimed (lastNudgeDay = today, a conditional
// update) BEFORE the email goes out, so overlapping passes or several server instances never send
// twice; a failed send is logged and not retried that day (no morning spam).
//
// Who counts as a learner: not a placeholder (ghost) user, and has revisions, goals or focus lines,
// so Recollect users who never used the learning Home get nothing. Reserved, undeliverable
// addresses (dev@recollect.local) are skipped. The address is the user's reminder email, else the
// account email. The link is FRONTEND_URL (the app URL the other emails use).
import cron from 'node-cron';
import { prisma } from '../../db/prisma';
import { isDeliverableEmail, isNudgeDue, nudgeSubject, resolveTimeZone, revisionMinutes, today as todayIn, type GoalForecast } from '../learning';
import { sendMorningNudgeEmail, type MorningNudgeEmail } from '../../utils/emailService';
import { contextOf, fromDbDayOrNull, learningUserSelect, toDbDay } from './common';
import { forecastOf, goalInclude } from './goals.service';
import { computePlan, hasRevisionHistory, needsHistoryCheck, planRevisionWhere, toPlanRow } from './plan.service';
import { revisionItemInclude } from './revisions.service';
import { captureTitle, topicTitle } from '../../db/serializers/learning';

/** How many planned items the email lists. */
export const NUDGE_TOP_ITEMS = 3;

export type NudgeSender = (to: { name: string; email: string }, nudge: MorningNudgeEmail) => Promise<boolean>;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function goalWhen(forecast: GoalForecast): string {
    if (forecast.daysLeft > 1) return `${forecast.daysLeft} days left`;
    if (forecast.daysLeft === 1) return '1 day left';
    if (forecast.daysLeft === 0) return 'Due today';
    return 'Past the deadline';
}

/** The digest for one user right now (reads only). */
export async function buildMorningNudge(userId: string, now: Date = new Date()): Promise<MorningNudgeEmail> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: learningUserSelect });
    const ctx = contextOf(user, now);
    const [rows, goals, hasHistory] = await Promise.all([
        prisma.revision.findMany({ where: planRevisionWhere(userId, ctx.today, ctx.tz), include: revisionItemInclude }),
        prisma.goal.findMany({ where: { userId, status: 'active' }, include: goalInclude }),
        needsHistoryCheck(user, ctx.today) ? hasRevisionHistory(userId, ctx.today, ctx.tz) : Promise.resolve(false),
    ]);
    const goalSubjectIds = goals.flatMap((g) => g.subjects.map((s) => s.subject.id));
    const { mode, result } = computePlan(ctx, rows.map(toPlanRow), goalSubjectIds, hasHistory);
    const n = result.planned.length;

    const subject = nudgeSubject({ mode, plannedCount: n, estMinutes: result.estMinutes, waitingCount: result.waitingCount });
    let heading: string;
    let intro: string;
    if (n === 0 && result.waitingCount === 0) {
        heading = 'Nothing due today';
        intro = 'A free day for revisions.';
    } else if (n === 0) {
        heading = "Today's plan is done";
        intro = 'The rest can wait for another day.';
    } else if (mode === 'busy') {
        heading = 'Busy week';
        intro = `Just ${plural(n, 'thing')} today, about ${result.estMinutes} min. The rest waits.`;
    } else if (mode === 'comeback') {
        heading = 'Welcome back';
        intro = `Just these ${n} to get going, about ${result.estMinutes} min.`;
    } else {
        heading = "Today's plan";
        intro = `${plural(n, 'revision')}, about ${result.estMinutes} min.`;
    }

    const items = result.planned.slice(0, NUDGE_TOP_ITEMS).map((r) => {
        const t = r.row.topic;
        const c = r.row.capture;
        const title = t ? topicTitle(t, t.doc?.title) : c ? captureTitle(c) : 'Revision';
        const subjectName = t?.subject?.name ?? c?.subject?.name ?? 'General';
        return { title, detail: `${subjectName} · cycle ${r.cycleNumber} · ${revisionMinutes(r)} min` };
    });

    const goalLines = goals
        .sort((a, b) => a.deadline.getTime() - b.deadline.getTime())
        .map((g) => ({ title: g.title, when: goalWhen(forecastOf(g, ctx)) }));

    return { subject, heading, intro, items, moreCount: Math.max(0, n - items.length), goals: goalLines };
}

export interface NudgePassResult {
    /** Learners with the nudge on. */
    checked: number;
    sent: number;
    failed: number;
    /** Undeliverable (reserved) addresses. */
    skipped: number;
}

/** One cron pass (tests call it with a fixed `now` and the mocked mailer). */
export async function runMorningNudgePass(now: Date = new Date(), send: NudgeSender = sendMorningNudgeEmail): Promise<NudgePassResult> {
    const users = await prisma.user.findMany({
        where: {
            nudgeEmailEnabled: true,
            isGhost: false,
            OR: [{ revisions: { some: {} } }, { goals: { some: {} } }, { focusItems: { some: {} } }],
        },
        select: { id: true, name: true, email: true, reminderEmail: true, timezone: true, nudgeTime: true, lastNudgeDay: true },
        orderBy: { id: 'asc' },
    });
    const result: NudgePassResult = { checked: users.length, sent: 0, failed: 0, skipped: 0 };
    for (const u of users) {
        const to = u.reminderEmail?.trim() || u.email;
        if (!isDeliverableEmail(to)) {
            result.skipped++;
            continue;
        }
        const tz = resolveTimeZone(u.timezone);
        if (!isNudgeDue({ now, tz, nudgeTime: u.nudgeTime, lastNudgeDay: fromDbDayOrNull(u.lastNudgeDay) })) continue;
        const today = todayIn(tz, now);
        try {
            const nudge = await buildMorningNudge(u.id, now);
            // Claim the day first: only one pass / instance gets to send.
            const claimed = await prisma.user.updateMany({
                where: {
                    id: u.id,
                    nudgeEmailEnabled: true,
                    OR: [{ lastNudgeDay: null }, { lastNudgeDay: { not: toDbDay(today) } }],
                },
                data: { lastNudgeDay: toDbDay(today) },
            });
            if (claimed.count === 0) continue;
            if (await send({ name: u.name, email: to }, nudge)) result.sent++;
            else result.failed++;
        } catch (err) {
            result.failed++;
            console.error(`[learning] morning nudge failed for user ${u.id}:`, err);
        }
    }
    return result;
}

let passRunning = false;

/** Every 15 minutes: the morning digest for learners whose local nudge time has come. */
export function startMorningNudgeCron(): void {
    cron.schedule('*/15 * * * *', async () => {
        if (passRunning) return; // a slow pass never overlaps the next one
        passRunning = true;
        try {
            const r = await runMorningNudgePass();
            if (r.sent > 0 || r.failed > 0) console.log(`[learning] morning nudge: ${r.sent} sent, ${r.failed} failed`);
        } catch (err) {
            console.error('[learning] morning nudge pass failed:', err);
        } finally {
            passRunning = false;
        }
    });
}
