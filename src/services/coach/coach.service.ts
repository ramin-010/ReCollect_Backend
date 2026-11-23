// The weekly coach (HOME_DOCS_AGENT_PLAN §4, Phase D3): four lines on the last 7 days (strong,
// slipping, the one fix, is the deadline realistic) and 3 suggested focus lines, written by Claude
// from evidence the app gathers (./evidence.ts) and stored as a CoachNote.
//
//   generateCoachNote   POST /api/ai/coach: the note for the 7 local days ending yesterday. The
//                       note already written today is returned again unless `fresh`.
//   latestCoachNote     GET /api/ai/coach: the newest stored note, or null.
//
// A week with nothing in it (no reviews due or done, no recall, focus lines, docs, backlog or
// goals) gets an honest note written without a model call (model 'none'). Otherwise: the cap check
// (402), one call, its AiUsage row (billed either way), validation (502 when unusable), then the
// row. Model calls never run inside a transaction; there is no cron in this round.
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma';
import { captureTitle } from '../../db/serializers/learning';
import { serializeCoachNote, type CoachNoteJson } from '../../db/serializers/coach';
import { addDays, dayOf, startOfDay, type DayString } from '../learning';
import { dayRange, fromDbDay, fromDbDayOrNull, loadLearningContext, toDbDay } from '../learningDb/common';
import { countedSessions } from '../learningDb/lens';
import { aiModel, callClaude, isAiConfigured } from '../claude/client';
import { aiFailed, aiNotConfigured } from '../claude/errors';
import { assertUnderCap, recordAiUsage } from '../claude/usage.service';
import { ModelOutputError, parseStoredQuestions, responseText } from '../recall/output';
import { withRefusalFallbacks } from '../recall/prompts';
import { buildCoachEvidence, coachWindow, type CoachRows, type CoachWindow } from './evidence';
import { plainCoachNote, unsupportedNumbers } from './check';
import { weekStartOf, weekSummary } from '../learningDb/week.service';
import { parseCoachOutput, type CoachOutput } from './output';
import { coachRequest } from './prompts';

/** CoachNote.model of a note written without a model call (a week with nothing in it). */
export const QUIET_WEEK_MODEL = 'none';
/** Docs looked at per week (newest first): far more than a week's worth. */
const DOCS_SCANNED = 200;

/** The note of a week with nothing in it: honest, and free. */
export function quietWeekNote(): CoachOutput {
    return {
        lines: {
            strong: 'Nothing was logged in the last 7 days: no reviews, recall answers, focus lines or notes, so there is nothing to credit yet.',
            slipping: 'Nothing was due either, so nothing slipped, but nothing moved forward.',
            fix: 'Do one small thing each day: set one focus line in the morning, or write one note on something you learned.',
            deadline: 'You have no goal with a deadline yet, so there is no pace to check. Set one with a few milestones.',
        },
        focus: [
            'Write a practice note on a problem you solved recently',
            'Set a goal with a deadline and three milestones',
            'Mark one doc for revision so it comes back on schedule',
        ],
    };
}

/** An unusable model output as the 502 the app answers with. */
function outputFailure(err: unknown): unknown {
    if (!(err instanceof ModelOutputError)) return err;
    console.error(`[coach] unusable note: ${err.message}`);
    if (err.reason === 'refused') return aiFailed('The AI declined to write this week’s note.', 'AI_REFUSED');
    return aiFailed("The AI's note could not be read. Try again.");
}

/** The rows the week's evidence is built from (reads only, on the root client). */
export async function loadCoachRows(userId: string, ctx: { today: DayString; tz: string }, w: CoachWindow): Promise<CoachRows> {
    const from = startOfDay(w.weekStart, ctx.tz);
    const to = startOfDay(ctx.today, ctx.tz);
    const weekDays = { gte: toDbDay(w.weekStart), lte: toDbDay(w.weekEnd) };
    const instants = { gte: from, lt: to };
    // The sessions that count as progress (PERSONAL_OFFICE_PLAN): the coach judges those only.
    const counted = await countedSessions(userId);
    const [revisions, backlog, recallSets, focus, docs, goals, sessions, weakSpotsOpen, weakSpotsCleared, week] = await Promise.all([
        prisma.revision.findMany({
            where: { userId, OR: [{ scheduledFor: weekDays }, { status: 'done', completedAt: instants }] },
            select: {
                scheduledFor: true,
                status: true,
                completedAt: true,
                topic: { select: { title: true, doc: { select: { title: true } }, subject: { select: { name: true } } } },
                capture: { select: { title: true, content: true, subject: { select: { name: true } } } },
            },
        }),
        prisma.revision.count({ where: { userId, status: 'pending', scheduledFor: { lt: toDbDay(w.weekStart) } } }),
        prisma.recallSet.findMany({
            where: { userId, status: 'ready', OR: [{ finishedAt: instants }, { attempts: { some: { createdAt: instants } } }] },
            select: {
                questions: true,
                finishedAt: true,
                result: true,
                attempts: { select: { questionId: true, grade: true, createdAt: true } },
                revision: { select: { topic: { select: { title: true, doc: { select: { title: true } } } }, capture: { select: { title: true, content: true } } } },
            },
        }),
        prisma.focusItem.findMany({
            where: { userId, day: weekDays },
            orderBy: [{ day: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
            select: { day: true, text: true, done: true },
        }),
        prisma.doc.findMany({
            where: { userId, isArchived: false, OR: [{ createdAt: instants }, { updatedAt: instants }] },
            select: { title: true, createdAt: true, updatedAt: true },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: DOCS_SCANNED,
        }),
        prisma.goal.findMany({
            where: { userId, status: 'active' },
            select: { title: true, deadline: true, createdAt: true, milestones: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] } },
        }),
        // The record (LOOP_COMPLETE_SPEC 1.7): sessions, weak spots, the week's targets.
        prisma.workSession.findMany({ where: { userId, day: weekDays, ...counted }, select: { day: true, kind: true, minutes: true, outcome: true } }),
        prisma.weakSpot.count({ where: { userId, status: 'open' } }),
        prisma.weakSpot.count({ where: { userId, status: 'cleared', clearedAt: instants } }),
        weekSummary(userId, weekStartOf(w.weekEnd), ctx.tz),
    ]);

    const itemTitle = (item: { topic: { title: string; doc: { title: string } | null } | null; capture: { title: string | null; content: string | null } | null }) =>
        item.topic ? item.topic.doc?.title ?? item.topic.title : item.capture ? captureTitle(item.capture) : 'Review';

    return {
        revisions: revisions.map((r) => ({
            scheduledFor: fromDbDay(r.scheduledFor),
            status: r.status,
            completedAt: r.completedAt,
            title: itemTitle(r),
            subject: r.topic?.subject.name ?? r.capture?.subject?.name ?? null,
        })),
        backlog,
        recall: recallSets.map((s) => ({
            title: itemTitle(s.revision),
            finishedAt: s.finishedAt,
            result: s.result,
            questions: parseStoredQuestions(s.questions),
            attempts: s.attempts,
        })),
        focus: focus.map((f) => ({ day: fromDbDay(f.day), text: f.text, done: f.done })),
        docs,
        goals: goals.map((g) => ({
            title: g.title,
            deadline: fromDbDay(g.deadline),
            createdDay: dayOf(g.createdAt, ctx.tz),
            milestones: g.milestones.map((m) => ({ title: m.title, done: m.done, doneAt: m.doneAt, dueDay: fromDbDayOrNull(m.dueDay) })),
        })),
        record: {
            sessions: sessions.map((x) => ({ day: fromDbDay(x.day), kind: x.kind, minutes: x.minutes, outcome: x.outcome })),
            weakSpotsOpen,
            weakSpotsCleared,
            weekTargets: week.targets.total ? week.targets : null,
        },
    };
}

/**
 * POST /api/ai/coach[?fresh=1] → { note, created }. The note written today (the user's day) comes
 * back as it is (created false) unless `fresh`; otherwise a new note for the 7 days ending
 * yesterday is written and stored. Errors: 503 AI_NOT_CONFIGURED, 402 AI_CAP_REACHED,
 * 502 AI_REFUSED / AI_BUSY / AI_FAILED (nothing is stored then).
 */
export async function generateCoachNote(userId: string, opts: { fresh?: boolean } = {}, now: Date = new Date()): Promise<{ note: CoachNoteJson; created: boolean }> {
    const ctx = await loadLearningContext(userId, now);
    if (!opts.fresh) {
        const todays = await prisma.coachNote.findFirst({
            where: { userId, createdAt: dayRange(ctx.today, ctx.tz) },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (todays) return { note: serializeCoachNote(todays), created: false };
        // B5 (BUDDY_MEMORY_PLAN §3.3): with his buddy on, Sunday's night writes the week's note; the
        // week stays on it until the next Sunday (no second model for the same week).
        const buddy = await prisma.buddyState.findUnique({ where: { userId }, select: { enabled: true, paused: true } });
        if (buddy?.enabled && !buddy.paused) {
            const weeks = await prisma.coachNote.findFirst({ where: { userId, createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
            if (weeks) return { note: serializeCoachNote(weeks), created: false };
        }
    }

    const window = coachWindow(ctx.today);
    const evidence = buildCoachEvidence(await loadCoachRows(userId, ctx, window), { ...window, today: ctx.today, tz: ctx.tz });
    let output: CoachOutput;
    let model: string;
    if (evidence.level === 'none') {
        output = quietWeekNote();
        model = QUIET_WEEK_MODEL;
    } else {
        if (!isAiConfigured()) throw aiNotConfigured();
        await assertUnderCap(userId, now);
        const message = await callClaude(userId, withRefusalFallbacks(coachRequest({ model: aiModel(), evidence })), 'weekly coach');
        await recordAiUsage(userId, 'weekly_coach', message);
        try {
            output = parseCoachOutput(responseText(message));
        } catch (err) {
            throw outputFailure(err);
        }
        model = message.model;
        // Every number must be one the evidence holds; otherwise a plain note from the same facts.
        const unsupported = unsupportedNumbers(output, evidence);
        if (unsupported.length) {
            console.warn(`[coach] numbers not in the evidence (${unsupported.join(', ')}): a plain note instead`);
            output = plainCoachNote(evidence);
            model = `plain (checked): ${message.model}`;
        }
    }

    const row = await prisma.coachNote.create({
        data: {
            userId,
            weekStart: toDbDay(window.weekStart),
            weekEnd: toDbDay(window.weekEnd),
            lines: output.lines as Prisma.InputJsonValue,
            focus: output.focus,
            model: model.slice(0, 100),
            createdAt: now,
        },
    });
    // Its focus lines wait on Home under Suggested (one tap adds one to today), for a week.
    if (model !== QUIET_WEEK_MODEL) {
        await prisma.suggestion.createMany({
            data: output.focus.map((text) => ({
                userId,
                kind: 'focus_line' as const,
                text: text.slice(0, 200),
                reason: 'From the weekly coach',
                payload: { text: text.slice(0, 140) },
                proposedBy: 'coach' as const,
                batch: `coach:${row.id}`.slice(0, 40),
                expiresDay: toDbDay(addDays(ctx.today, 6)),
            })),
        });
    }
    return { note: serializeCoachNote(row), created: true };
}

/** GET /api/ai/coach → the newest stored note, or null. */
export async function latestCoachNote(userId: string): Promise<CoachNoteJson | null> {
    const row = await prisma.coachNote.findFirst({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return row ? serializeCoachNote(row) : null;
}
