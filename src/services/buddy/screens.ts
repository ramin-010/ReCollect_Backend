// Stage 5b, part B (ECOSYSTEM_V2_PLAN): the screens that learn. What a person tells the buddy about when it may ask
// and what stays off their lock screen ("ask me later in the evening", "not on weekends", "keep money stuff off my
// lock screen"), and what their "not this, too private" taught it, kept as rules. Code holds the shapes it can
// (a question's hours and days, a thread off the screens); a topic is judged by the lock check, which is given them.
import type { BuddyScreenRule } from '@prisma/client';
import { prisma, type TxClient } from '../../db/prisma';
import { dayOf, startOfDay, type DayString } from '../learning';
import { badRequest, notFound } from '../learning/http';
import { minuteOf } from './tasks';
import type { ScreenOp } from './understand';

/** A rule's earliest time for questions: from 06:00 to 22:00 (anything else is not a wish about the day's hours). */
const FROM_MIN = 6 * 60;
const FROM_MAX = 22 * 60;
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKENDS = [0, 6];
const RULE_TEXT_MAX = 200;
/** A question keeps at least this long once its start moved. */
const ASK_MIN_MS = 30 * 60_000;
const ASK_MOVED_MS = 3 * 3600_000;

export const THUMB_REASONS = ['private', 'time', 'useless', 'wrong'] as const;
export type ThumbReason = (typeof THUMB_REASONS)[number];

type Db = TxClient | typeof prisma;

export async function activeScreenRules(userId: string, db: Db = prisma): Promise<BuddyScreenRule[]> {
    return db.buddyScreenRule.findMany({ where: { userId, endedAt: null }, orderBy: { createdAt: 'asc' } });
}

/** The rule that holds for a thread: its own, else the one about everything. */
function ruleFor(rules: readonly BuddyScreenRule[], kind: 'asks_from' | 'asks_days', threadId: string | null): BuddyScreenRule | undefined {
    const last = (list: BuddyScreenRule[]) => list[list.length - 1];
    const own = threadId ? last(rules.filter((r) => r.kind === kind && r.threadId === threadId)) : undefined;
    return own ?? last(rules.filter((r) => r.kind === kind && !r.threadId));
}

/**
 * A question's hours under the rules (§5b B): its start moves to the rule's time on its day, and a day the rule
 * leaves out drops it. Pure; `tz` is the person's zone.
 */
export function askWindow(rules: readonly BuddyScreenRule[], threadId: string | null, from: Date, until: Date, tz: string): { from: Date; until: Date } | { why: string } {
    const days = ruleFor(rules, 'asks_days', threadId);
    const local = dayOf(from, tz);
    if (days && days.days.length && !days.days.includes(new Date(`${local}T12:00:00Z`).getUTCDay())) return { why: 'not on the days they asked for' };
    const after = ruleFor(rules, 'asks_from', threadId);
    if (after?.fromMin == null) return { from, until };
    const earliest = new Date(startOfDay(local as DayString, tz).getTime() + after.fromMin * 60_000);
    if (from.getTime() >= earliest.getTime()) return { from, until };
    return { from: earliest, until: until.getTime() > earliest.getTime() + ASK_MIN_MS ? until : new Date(earliest.getTime() + ASK_MOVED_MS) };
}

export interface ScreenApplied {
    made: number;
    ended: number;
    snoozed: number;
    dropped: Array<{ what: string; why: string }>;
}

/**
 * The digest's screen rules (§5b B), inside its transaction: only from their own words (never passed on). A rule with
 * no time (or no days) ends the one of its kind; a new one of a kind replaces the old for the same thread (or for
 * everything). Said in reply to a question that is still waiting, the question also comes back at that time today.
 */
export async function applyScreenOps(tx: TxClient, userId: string, ops: readonly ScreenOp[], ctx: { now: Date; tz: string; direct: boolean; context: ReadonlySet<number>; messages: number }): Promise<ScreenApplied> {
    const out: ScreenApplied = { made: 0, ended: 0, snoozed: 0, dropped: [] };
    for (const op of ops.slice(0, 3)) {
        let why: string | null = null;
        if (!ctx.direct) why = 'only their own words make a rule';
        else if (op.message < 1 || op.message > ctx.messages || ctx.context.has(op.message)) why = 'no such message';
        const threadId = op.threadId ? ((await tx.buddyThread.findFirst({ where: { id: op.threadId, userId }, select: { id: true } }))?.id ?? null) : null;
        if (!why && op.threadId && !threadId) why = 'not one of their threads';
        const words = op.words.replace(/\s+/g, ' ').trim().slice(0, RULE_TEXT_MAX);
        if (why) {
            out.dropped.push({ what: `screen rule ${op.kind}`, why });
            continue;
        }
        const same = { userId, kind: op.kind, threadId, endedAt: null };
        if (op.kind === 'asks_from') {
            const min = minuteOf(op.time);
            if (min == null) {
                // "You can ask me anytime again": the rule of its kind ends.
                out.ended += (await tx.buddyScreenRule.updateMany({ where: same, data: { endedAt: ctx.now } })).count;
                continue;
            }
            if (min < FROM_MIN || min > FROM_MAX) {
                out.dropped.push({ what: 'screen rule asks_from', why: 'not a time of the day for questions' });
                continue;
            }
            await tx.buddyScreenRule.updateMany({ where: same, data: { endedAt: ctx.now } });
            await tx.buddyScreenRule.create({ data: { userId, kind: 'asks_from', threadId, fromMin: min, text: words || `Questions not before ${op.time}`, source: 'said', createdAt: ctx.now } });
            out.made++;
            // Said in reply to a question still waiting: it comes back at that time today (a snooze), not before.
            if (op.askId) {
                const ask = await tx.buddyAsk.findFirst({ where: { id: op.askId, userId, state: { in: ['open', 'replied'] } } });
                const at = new Date(startOfDay(dayOf(ctx.now, ctx.tz) as DayString, ctx.tz).getTime() + min * 60_000);
                if (ask && at.getTime() > ctx.now.getTime()) {
                    await tx.buddyAsk.update({ where: { id: ask.id }, data: { state: 'open', fromAt: at, untilAt: ask.untilAt.getTime() > at.getTime() + ASK_MIN_MS ? ask.untilAt : new Date(at.getTime() + ASK_MOVED_MS) }, select: { id: true } });
                    out.snoozed++;
                }
            }
        } else if (op.kind === 'asks_days') {
            if (!op.days) {
                out.ended += (await tx.buddyScreenRule.updateMany({ where: same, data: { endedAt: ctx.now } })).count;
                continue;
            }
            await tx.buddyScreenRule.updateMany({ where: same, data: { endedAt: ctx.now } });
            await tx.buddyScreenRule.create({ data: { userId, kind: 'asks_days', threadId, days: op.days === 'weekdays' ? WEEKDAYS : WEEKENDS, text: words || `Questions only on ${op.days}`, source: 'said', createdAt: ctx.now } });
            out.made++;
        } else {
            if (!words) {
                out.dropped.push({ what: 'screen rule topic', why: 'no words' });
                continue;
            }
            await tx.buddyScreenRule.create({ data: { userId, kind: 'topic', threadId, text: words, source: 'said', createdAt: ctx.now } });
            out.made++;
        }
    }
    return out;
}

/** "Too private" on a line tied to no thread (§5b B): a topic rule in the line's own words, for the lock check. */
export async function topicFromThumb(userId: string, line: string, now: Date, db: Db = prisma): Promise<void> {
    const text = `Lines like: ${line.replace(/\s+/g, ' ').trim()}`.slice(0, RULE_TEXT_MAX);
    const exists = await db.buddyScreenRule.findFirst({ where: { userId, kind: 'topic', text, endedAt: null }, select: { id: true } });
    if (!exists) await db.buddyScreenRule.create({ data: { userId, kind: 'topic', text, source: 'thumb', createdAt: now } });
}

/** "Too private" on words tied to threads: they go off the screens (On my mind shows it and puts them back); a steer of his own is kept. */
export async function offScreensFromThumb(db: Db, userId: string, threadIds: readonly string[], text: string): Promise<void> {
    if (!threadIds.length) return;
    await db.buddyThread.updateMany({ where: { userId, id: { in: [...threadIds] } }, data: { onScreens: false } });
    await db.buddyThread.updateMany({ where: { userId, id: { in: [...threadIds] }, steer: null }, data: { steer: `Too private (your thumb on: ${text.replace(/\s+/g, ' ').trim()})`.slice(0, RULE_TEXT_MAX) } });
}

const aboutIds = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((o) => (o && typeof (o as { threadId?: unknown }).threadId === 'string' ? [(o as { threadId: string }).threadId] : [])) : []);

/**
 * "Not this: too private" on a line or the note of one of its steps (§5b B): the threads it rests on go off the screens;
 * resting on none, its words become a topic rule for the lock check. Answers what it did.
 */
export async function privateFromThumb(userId: string, buddyDayId: string, target: string, now: Date): Promise<'threads' | 'topic' | 'none'> {
    const day = await prisma.buddyDay.findFirst({ where: { id: buddyDayId, userId }, select: { lines: true, note: true, noteAbout: true } });
    if (!day) return 'none';
    let text: string | null = null;
    let ids: string[] = [];
    if (target === 'note') {
        text = day.note;
        ids = aboutIds(day.noteAbout);
    } else {
        const lines = (Array.isArray(day.lines) ? day.lines : []) as Array<{ slot?: string; from?: string; text?: string; about?: unknown }>;
        const line = lines.find((l) => (l.from ?? l.slot) === target) ?? lines.find((l) => l.slot === target);
        text = line?.text ?? null;
        ids = aboutIds(line?.about);
    }
    if (!text) return 'none';
    if (ids.length) {
        await offScreensFromThumb(prisma, userId, ids, text);
        return 'threads';
    }
    await topicFromThumb(userId, text, now);
    return 'topic';
}

export interface ScreenRuleJson {
    _id: string;
    kind: string;
    /** In words, for /you ("Questions not before 19:00", "Questions only on weekdays", "Off the lock screen: money matters"). */
    what: string;
    threadId: string | null;
    thread: string | null;
    /** Their words, or the line a thumb was on. */
    text: string;
    source: string;
    createdAt: string;
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** The rules for /you › "On my screens", with their words. */
export async function listScreenRules(userId: string): Promise<ScreenRuleJson[]> {
    const rules = await activeScreenRules(userId);
    const ids = [...new Set(rules.flatMap((r) => (r.threadId ? [r.threadId] : [])))];
    const titles = new Map((ids.length ? await prisma.buddyThread.findMany({ where: { userId, id: { in: ids } }, select: { id: true, title: true } }) : []).map((t) => [t.id, t.title]));
    return rules.map((r) => {
        const about = r.threadId ? titles.get(r.threadId) ?? null : null;
        const what =
            r.kind === 'asks_from'
                ? `Questions${about ? ` about ${about}` : ''} not before ${hhmm(r.fromMin ?? 0)}`
                : r.kind === 'asks_days'
                  ? `Questions${about ? ` about ${about}` : ''} only on ${r.days.length === 5 ? 'weekdays' : 'weekends'}`
                  : r.text.startsWith('Lines like: ')
                    ? `Off the lock screen: lines like “${r.text.slice('Lines like: '.length)}”`
                    : `Off the lock screen: ${r.text}`;
        return { _id: r.id, kind: r.kind, what, threadId: r.threadId, thread: about, text: r.text, source: r.source, createdAt: r.createdAt.toISOString() };
    });
}

/** DELETE /api/buddy/screens/:id: Remove on /you (the rule ends; nothing else is changed). */
export async function endScreenRule(userId: string, id: string, now: Date = new Date()): Promise<{ ended: true }> {
    const r = await prisma.buddyScreenRule.findFirst({ where: { id, userId }, select: { id: true, endedAt: true } });
    if (!r) throw notFound();
    if (r.endedAt) throw badRequest('That rule has ended already');
    await prisma.buddyScreenRule.update({ where: { id: r.id }, data: { endedAt: now } });
    return { ended: true };
}

/** The night's and the pulses' block of his screen rules, or null when he has none. */
export async function screenRulesBlock(userId: string): Promise<string | null> {
    const rules = await activeScreenRules(userId);
    if (!rules.length) return null;
    return `<screen_rules>\n${rulesInWords(rules).join('\n')}\nWhat they asked about when you may ask them and what stays off their lock screen: follow it in every line and question (code holds the hours of questions too).\n</screen_rules>`;
}

/** The rules in words for the lock check and the night: what they asked about their screens. */
export function rulesInWords(rules: ReadonlyArray<Pick<BuddyScreenRule, 'kind' | 'text' | 'fromMin' | 'days' | 'threadId'>>): string[] {
    return rules.map((r) => (r.kind === 'asks_from' ? `questions${r.threadId ? ' about one thread' : ''} not before ${hhmm(r.fromMin ?? 0)} (${r.text})` : r.kind === 'asks_days' ? `questions${r.threadId ? ' about one thread' : ''} only on ${r.days.length === 5 ? 'weekdays' : 'weekends'} (${r.text})` : `keep off their lock screen: ${r.text}`));
}
