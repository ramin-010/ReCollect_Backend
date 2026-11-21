// Stage 20 (ECOSYSTEM_V2_PLAN, "What happened next: a quiet record"): for the day just ended, what followed each thing
// the buddy showed: a line (in its hours), the home thought, a question, a Later. By code only, before the night thinks;
// nothing reads it yet (scripts/what-landed.ts prints it for the talk after the trial). Outcomes: acted (a study or
// practice session on that left-off item within 3 hours of the start; the task ticked that day after it; progress or
// done on its thread that day after it), answered, later, thumb_up, thumb_down, none. A line withdrawn before its hours
// (what it rested on closed first) never showed, so it is not counted.
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { addDays, startOfDay, type DayString } from '../learning';
import { toDbDay } from '../learningDb/common';
import { instantOf, lineKey, lineWindow } from './lineTimes';
import { parseAbout, type About } from './threads';
import { parseRefs } from './aheadBlocks';
import type { Line } from './think';

/** A session within this long after a pick-up nudge's start is acting on it. */
export const ACTED_WITHIN_MS = 3 * 3600_000;

type Outcome = 'acted' | 'answered' | 'later' | 'thumb_up' | 'thumb_down' | 'none';
interface Row {
    shown: 'line' | 'thought' | 'question' | 'later';
    text: string;
    about: unknown[];
    fromAt: Date | null;
    untilAt: Date | null;
    outcome: Outcome;
    minutes: number | null;
    sourceKey: string;
}

const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

/** What the day's record says for the words of one item: refs and threads, from its start to the day's end. */
async function followed(userId: string, refs: readonly string[], about: readonly About[], from: Date, dayEnd: Date): Promise<{ at: Date } | null> {
    const times: Date[] = [];
    const tasks = refs.filter((r) => r.startsWith('tk_')).map((r) => r.slice(3));
    if (tasks.length) {
        const done = await prisma.todo.findMany({ where: { userId, id: { in: tasks }, completedAt: { gte: from, lt: dayEnd } }, select: { completedAt: true } });
        times.push(...done.map((t) => t.completedAt!));
    }
    const left = refs.filter((r) => r.startsWith('pu_')).map((r) => r.slice(3));
    if (left.length) {
        const origin = await prisma.workSession.findMany({ where: { userId, id: { in: left } }, select: { problem: true, topicId: true } });
        const problems = origin.map((o) => o.problem).filter((p): p is string => !!p);
        const topics = origin.map((o) => o.topicId).filter((t): t is string => !!t);
        if (problems.length || topics.length) {
            const s = await prisma.workSession.findFirst({
                where: { userId, startedAt: { gte: from, lt: new Date(from.getTime() + ACTED_WITHIN_MS) }, OR: [...(problems.length ? [{ problem: { in: problems, mode: 'insensitive' as const } }] : []), ...(topics.length ? [{ topicId: { in: topics } }] : [])] },
                orderBy: { startedAt: 'asc' },
                select: { startedAt: true },
            });
            if (s) times.push(s.startedAt);
        }
    }
    const threads = about.map((a) => a.threadId);
    if (threads.length) {
        const e = await prisma.buddyThreadEvent.findFirst({ where: { userId, threadId: { in: threads }, kind: { in: ['progress', 'done', 'finished'] }, duplicate: false, saidAt: { gte: from, lt: dayEnd } }, orderBy: { saidAt: 'asc' }, select: { saidAt: true } });
        if (e) times.push(e.saidAt);
    }
    if (!times.length) return null;
    return { at: new Date(Math.min(...times.map((t) => t.getTime()))) };
}

/** Whether what a line rests on closed before its hours began (then it never showed). */
async function withdrawnBefore(userId: string, refs: readonly string[], about: readonly About[], written: Date, start: Date): Promise<boolean> {
    const tasks = refs.filter((r) => r.startsWith('tk_')).map((r) => r.slice(3));
    if (tasks.length && (await prisma.todo.count({ where: { userId, id: { in: tasks }, completedAt: { lt: start } } }))) return true;
    const threads = about.map((a) => a.threadId);
    if (threads.length && (await prisma.buddyThreadEvent.count({ where: { userId, threadId: { in: threads }, duplicate: false, receivedAt: { gt: written, lt: start } } }))) return true;
    return false;
}

/** Writes the day's outcomes (once per item: a second run changes nothing). Returns how many rows it wrote. */
export async function recordOutcomes(userId: string, day: DayString, tz: string): Promise<number> {
    const dayStart = startOfDay(day, tz);
    const dayEnd = new Date(startOfDay(addDays(day, 1), tz).getTime() + 4 * 3600_000); // their day runs to 04:00
    const steps = await prisma.buddyDay.findMany({ where: { userId, day: toDbDay(day) }, orderBy: { createdAt: 'desc' } });
    const rows: Row[] = [];
    const stepIds = steps.map((s) => s.id);
    const thumbs = stepIds.length ? await prisma.buddyFeedback.findMany({ where: { userId, buddyDayId: { in: stepIds } }, orderBy: { createdAt: 'asc' } }) : [];
    const laters = await prisma.buddyReminder.findMany({ where: { userId, origin: 'later', createdAt: { gte: dayStart, lt: dayEnd } } });
    const newest = steps[0];
    if (newest) {
        for (const l of ((Array.isArray(newest.lines) ? newest.lines : []) as unknown as Line[]).filter((x) => x.text && !x.fallback)) {
            // A line's hours are minutes of their buddy day (from 04:00): instantOf places them.
            const [s, e] = lineWindow(l);
            const from = instantOf(day, tz, s);
            const until = instantOf(day, tz, e <= s ? e + 1440 : e);
            const refs = l.refs ?? [];
            const about = l.about ?? [];
            const written = steps.find((st) => ((Array.isArray(st.lines) ? st.lines : []) as unknown as Line[]).some((x) => lineKey(x) === lineKey(l) && x.text === l.text))?.createdAt ?? newest.createdAt;
            if (await withdrawnBefore(userId, refs, about, written, from)) continue;
            const thumb = [...thumbs].reverse().find((t) => t.target === lineKey(l) || t.target === l.slot);
            const later = laters.find((x) => x.refKind && x.refId && refs.includes(`${x.refKind}_${x.refId}`) && x.createdAt >= from);
            const act = refs.length || about.length ? await followed(userId, refs, about, from, dayEnd) : null;
            const [outcome, when]: [Outcome, Date | null] = thumb ? [thumb.verdict === 'more' ? 'thumb_up' : 'thumb_down', thumb.createdAt] : act ? ['acted', act.at] : later ? ['later', later.createdAt] : ['none', null];
            rows.push({ shown: 'line', text: l.text.slice(0, 200), about: [...about, ...refs.map((ref) => ({ ref }))], fromAt: from, untilAt: until, outcome, minutes: when ? minutesBetween(from, when) : null, sourceKey: `line:${newest.id}:${lineKey(l)}` });
        }
        if (newest.insight && newest.insightLockOk) {
            const refs = parseRefs(newest.insightAbout);
            const about = parseAbout(newest.insightAbout);
            const act = refs.length || about.length ? await followed(userId, refs, about, newest.createdAt, dayEnd) : null;
            const later = laters.find((x) => x.refKind && x.refId && refs.includes(`${x.refKind}_${x.refId}`));
            rows.push({ shown: 'thought', text: newest.insight.slice(0, 200), about: [...about, ...refs.map((ref) => ({ ref }))], fromAt: newest.createdAt, untilAt: dayEnd, outcome: act ? 'acted' : later ? 'later' : 'none', minutes: act ? minutesBetween(newest.createdAt, act.at) : later ? minutesBetween(newest.createdAt, later.createdAt) : null, sourceKey: `thought:${newest.id}` });
        }
    }
    const asks = await prisma.buddyAsk.findMany({ where: { userId, fromAt: { gte: dayStart, lt: dayEnd } } });
    for (const a of asks.filter((x) => x.shownOn.length > 0)) {
        const answered = (a.state === 'answered' || a.state === 'replied') && a.answeredAt;
        const outcome: Outcome = answered ? 'answered' : a.thumb === 'less' ? 'thumb_down' : 'none';
        rows.push({ shown: 'question', text: a.text.slice(0, 200), about: a.threadId ? [{ threadId: a.threadId }] : [], fromAt: a.fromAt, untilAt: a.untilAt, outcome, minutes: answered ? minutesBetween(a.firstShownAt ?? a.fromAt, a.answeredAt!) : null, sourceKey: `ask:${a.id}` });
    }
    for (const x of laters) {
        const ref = x.refKind && x.refId ? `${x.refKind}_${x.refId}` : null;
        const act = ref ? await followed(userId, [ref], [], x.at, new Date(x.at.getTime() + 24 * 3600_000)) : null;
        rows.push({ shown: 'later', text: x.text.slice(0, 200), about: ref ? [{ ref }] : [], fromAt: x.createdAt, untilAt: x.at, outcome: act ? 'acted' : 'none', minutes: act ? minutesBetween(x.at, act.at) : null, sourceKey: `later:${x.id}` });
    }
    if (!rows.length) return 0;
    const made = await prisma.buddyOutcome.createMany({
        data: rows.map((r) => ({ userId, day: toDbDay(day), shown: r.shown, text: r.text, about: r.about as Prisma.InputJsonValue, fromAt: r.fromAt, untilAt: r.untilAt, outcome: r.outcome, minutes: r.minutes, sourceKey: r.sourceKey })),
        skipDuplicates: true,
    });
    return made.count;
}
