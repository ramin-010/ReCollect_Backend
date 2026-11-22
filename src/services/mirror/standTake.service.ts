// The buddy's take on where they stand (WHERE_YOU_STAND_PLAN §9, the owner, 11-22): asked for on the page, one a
// day per window, kept for that day only (StandTake). Without an ask the page shows the code's verdict.
//
//   GET  /api/mirror/stand/takes            today's takes, and whether the buddy can be asked now
//   POST /api/mirror/stand/takes {window}   the take for that window: today's if there is one, else a new one
//
// The buddy's gate decides (buddyMaySpend: on, not paused, its key working, under its caps); its spend counts as
// a pulse (a small daytime step of the buddy: no new AiFeature value, ECOSYSTEM_V2_PLAN §10.1).
import { prisma } from '../../db/prisma';
import { callClaude } from '../claude/client';
import { AiHttpError, aiConflict, aiFailed, aiNotConfigured } from '../claude/errors';
import { recordAiUsage } from '../claude/usage.service';
import { ModelOutputError, responseText } from '../recall/output';
import { withRefusalFallbacks } from '../recall/prompts';
import { characterPrompt } from '../buddy/character';
import { buddyMaySpend, type BuddyGate } from '../buddy/spend';
import { personName, toneOf } from '../buddy/state.service';
import type { StandWindow } from '../learning/stand';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { getMirror } from './mirror.service';
import { getStand } from './stand.service';
import { parseTake, takeEvidence, takeRequest, unsupported } from './take';

export interface StandTakeJson {
    window: StandWindow;
    text: string;
    /** When it was written (ISO). */
    at: string;
}

export interface StandTakesJson {
    /** Today's takes by window. */
    takes: Partial<Record<StandWindow, StandTakeJson>>;
    /** Whether the buddy can be asked now ('ok'), else why not. */
    ask: BuddyGate;
    /** The buddy's name, for the button ("Ask Sam"); null when it has none. */
    name: string | null;
}

const WINDOWS: readonly StandWindow[] = ['week', 'month', 'year'];
export const isStandWindow = (w: unknown): w is StandWindow => typeof w === 'string' && (WINDOWS as readonly string[]).includes(w);

function toJson(row: { window: string; text: string; createdAt: Date }): StandTakeJson {
    return { window: row.window as StandWindow, text: row.text, at: row.createdAt.toISOString() };
}

/** GET: the takes written today (the person's own date), the gate, the buddy's name. */
export async function standTakes(userId: string, now: Date = new Date()): Promise<StandTakesJson> {
    const { today } = await loadLearningContext(userId, now);
    const [rows, ask, state] = await Promise.all([
        prisma.standTake.findMany({ where: { userId, day: toDbDay(today) } }),
        buddyMaySpend(userId, now),
        prisma.buddyState.findUnique({ where: { userId }, select: { name: true } }),
    ]);
    const takes: StandTakesJson['takes'] = {};
    for (const r of rows) if (isStandWindow(r.window)) takes[r.window] = toJson(r);
    return { takes, ask, name: state?.name ?? null };
}

/** Why the buddy can't be asked, as the error the page shows. */
function gateError(gate: Exclude<BuddyGate, 'ok'>): Error {
    switch (gate) {
        case 'off':
            return aiConflict('Turn your buddy on in About you to ask it.', 'BUDDY_OFF');
        case 'paused':
            return aiConflict('Your buddy is paused. Turn learning back on in About you to ask it.', 'BUDDY_PAUSED');
        case 'no_ai':
        case 'not_allowed':
            return aiNotConfigured();
        case 'buddy_cap':
        case 'account_cap':
            return new AiHttpError(402, 'AI_CAP_REACHED', 'Your buddy has reached this month’s AI cap. Raise it in About you, or wait for next month.');
        default:
            return aiFailed('Your buddy can’t think right now. Try again later.', 'AI_PAUSED');
    }
}

/** POST: today's take for the window, or a new one written now (one model call, at most one rewrite). */
export async function askStandTake(userId: string, window: StandWindow, now: Date = new Date()): Promise<StandTakeJson> {
    const { today } = await loadLearningContext(userId, now);
    const day = toDbDay(today);
    const kept = await prisma.standTake.findUnique({ where: { userId_day_window: { userId, day, window } } });
    if (kept) return toJson(kept);

    const gate = await buddyMaySpend(userId, now);
    if (gate !== 'ok') throw gateError(gate);

    const [stand, mirror, state, person] = await Promise.all([
        getStand(userId, now),
        getMirror(userId, now),
        prisma.buddyState.findUnique({ where: { userId }, select: { name: true, tone: true, loop: true, who: true, heading: true, now: true } }),
        personName(userId),
    ]);
    const evidence = takeEvidence({
        today: stand.today,
        recordStart: stand.recordStart,
        period: stand.periods[window],
        days: stand.days,
        openNow: stand.openNow,
        weakOpenNow: stand.weakOpenNow,
        goals: mirror.goals.map((g) => ({
            title: g.title,
            deadline: g.deadline,
            daysLeft: g.daysLeft,
            milestones: g.milestones,
            forecast: g.forecast.status,
            paths: g.paths.map((p) => ({ subject: p.subject.name, done: p.done, total: p.total, perWeek: p.perWeek, requiredPerWeek: p.requiredPerWeek, status: p.status, landsOn: p.landsOn })),
        })),
        portrait: { who: state?.who ?? null, heading: state?.heading ?? null, now: state?.now ?? null },
    });
    const character = characterPrompt({ name: state?.name ?? null, tone: toneOf(state?.tone), person, loop: !!state?.loop });

    let text: string | null = null;
    let model = '';
    let retryWithout: string[] = [];
    // At most two calls: a take with a number the record doesn't hold is written again once, told which.
    for (let attempt = 0; attempt < 2 && text === null; attempt++) {
        const message = await callClaude(userId, withRefusalFallbacks(takeRequest({ character, evidence, window, retryWithout })), 'stand take');
        await recordAiUsage(userId, 'buddy_pulse', message);
        let take: string;
        try {
            take = parseTake(responseText(message));
        } catch (err) {
            if (err instanceof ModelOutputError) {
                console.error(`[take] unusable take: ${err.message}`);
                throw aiFailed(err.reason === 'refused' ? 'Your buddy declined to write this one.' : 'Your buddy’s take couldn’t be read. Try again.');
            }
            throw err;
        }
        const bad = unsupported(take, evidence);
        if (bad.length === 0) {
            text = take;
            model = message.model;
        } else {
            console.warn(`[take] numbers not in the record (${bad.join(', ')})${attempt === 0 ? ': written again' : ''}`);
            retryWithout = bad;
        }
    }
    if (text === null) throw aiFailed('Your buddy’s take didn’t match your numbers, so it was left out. Try again.');

    // One a day per window; the days before are gone (a take lasts its day).
    const [row] = await prisma.$transaction([
        prisma.standTake.upsert({
            where: { userId_day_window: { userId, day, window } },
            create: { userId, day, window, text, model: model.slice(0, 100) },
            update: { text, model: model.slice(0, 100), createdAt: now },
        }),
        prisma.standTake.deleteMany({ where: { userId, day: { lt: day } } }),
    ]);
    return toJson(row);
}

/** For tests and the page's own checks: the day a take belongs to. */
export const takeDay = (row: { day: Date }) => fromDbDay(row.day);
