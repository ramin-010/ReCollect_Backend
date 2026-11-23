// Stage 19 (ECOSYSTEM_V2_PLAN, "One action on the home screen: Later"): the widget shows one item (the card) with one
// button, Later: "bring this back at a time I can act". The server chooses the card and the time (no model); a Later is
// one silent reminder of Buddy's, tied to the item (refKind, refId, origin 'later'), so until its time the item is off
// the widget and the home picture and words resting on it are hidden, and at its time it is one of the lock's rows.
import { prisma } from '../../db/prisma';
import ErrorResponse from '../../utils/errorResponse';
import { addDays, dayOf, startOfDay, type DayString } from '../learning';
import { loadLearningContext } from '../learningDb/common';
import { countedSessions } from '../learningDb/lens';
import { usualStart } from '../buddy/signals';
import { aheadFor, type AheadRow } from './ahead.service';
import { clockWords } from './aheadRules';

/** The evening a Later aims at when their usual start is unknown. */
export const LATER_EVENING = '19:30';
/** A Later is never set later than this in their evening. */
export const LATER_LATEST = '22:30';
/** Tomorrow's hour for a task or an event. */
export const LATER_MORNING = '09:00';

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const at = (day: DayString, hhmm: string, tz: string) => new Date(startOfDay(day, tz).getTime() + minutesOf(hhmm) * 60_000);

/**
 * When a Later brings the item back (pure): before 17:00 their time, tonight at their usual evening start (else 19:30), at
 * least an hour from now and never after 22:30; else tomorrow (09:00 for a task or an event, their evening for a
 * left-off item). Never past the item's own day; null when no such time is left (the button is not shown).
 */
export function laterAt(input: { now: Date; tz: string; kind: AheadRow['kind']; ownDay: DayString | null; usual: string | null }): Date | null {
    const { now, tz } = input;
    const today = dayOf(now, tz);
    const minute = Math.floor((now.getTime() - startOfDay(today, tz).getTime()) / 60_000);
    const evening = input.usual ?? LATER_EVENING;
    let when: Date | null = null;
    if (minute < 17 * 60) {
        const soonest = new Date(now.getTime() + 60 * 60_000);
        const tonight = at(today, evening, tz);
        const pick = tonight.getTime() >= soonest.getTime() ? tonight : soonest;
        when = pick.getTime() <= at(today, LATER_LATEST, tz).getTime() ? pick : null;
    }
    if (!when) {
        const tomorrow = addDays(today, 1);
        when = at(tomorrow, input.kind === 'pickup' ? evening : LATER_MORNING, tz);
    }
    if (input.ownDay && dayOf(when, tz) > input.ownDay) return null;
    return when;
}

/** "Tonight · 8:30 pm", "Tomorrow · 9 am" (what the button says it will do). */
export function laterLabel(when: Date, now: Date, tz: string): string {
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
        .format(when)
        .toLowerCase()
        .replace(/\s/g, ' ')
        .replace(':00', '');
    return `${dayOf(when, tz) === dayOf(now, tz) ? 'Tonight' : 'Tomorrow'} · ${clock}`;
}

/** Their usual evening start (signals.usual), read cheaply for the button: weekdays and weekends apart. */
export async function usualEvening(userId: string, now: Date, tz: string): Promise<string | null> {
    const from = new Date(now.getTime() - 14 * 86_400_000);
    const rows = await prisma.workSession.findMany({ where: { userId, kind: { in: ['study', 'practice'] }, startedAt: { gte: from }, ...(await countedSessions(userId)) }, select: { startedAt: true } });
    const weekend = (d: Date) => {
        const w = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(d);
        return w === 'Sat' || w === 'Sun';
    };
    const wantWeekend = weekend(now);
    const first = new Map<string, number>();
    for (const r of rows) {
        if (weekend(r.startedAt) !== wantWeekend) continue;
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(r.startedAt);
        const m = (Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24) * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
        if (m < 17 * 60) continue;
        const d = dayOf(r.startedAt, tz);
        if (!first.has(d) || m < first.get(d)!) first.set(d, m);
    }
    return usualStart([...first.values()]);
}

/** The widget's card (app 0.7.0): one item and what Later would do. */
export interface NextCard {
    id: string;
    kind: AheadRow['kind'];
    /** "Pick up", "Coming up · Sun", "Today · 3 pm": what it is and when (sentence case: DESIGN_RULES' craft floor). */
    label: string;
    title: string;
    /** Where they stopped (a left-off item); empty otherwise, since the label already says when (nothing said twice). */
    detail: string;
    /** The problem's page, else the topic's doc in the app, else none (the app opens Today). */
    link: string | null;
    later: { label: string; at: string } | null;
}

const ownDayOf = (r: AheadRow): DayString | null => (r.kind === 'pickup' ? null : r.day);

/**
 * The card (pure order): the item Buddy's line now rests on; else a coming-up item due within 2 days; else the left-off
 * item; else the nearest coming-up item; else today's next row. None: no card (the widget shows the day's numbers).
 */
export function pickCard(input: { today: readonly AheadRow[]; comingUp: readonly AheadRow[]; leftOff: readonly AheadRow[]; lineRefs: readonly string[]; todayDay: DayString }): AheadRow | null {
    const all = [...input.leftOff, ...input.comingUp, ...input.today];
    const onLine = all.find((r) => input.lineRefs.includes(r.id));
    if (onLine) return onLine;
    const soon = input.comingUp.find((r) => r.day <= addDays(input.todayDay, 2));
    return soon ?? input.leftOff[0] ?? input.comingUp[0] ?? input.today[0] ?? null;
}

/**
 * "Your reminder · 9 pm", "Your reminder · Tomorrow 9 am", "Your reminder · Thu 3 pm": what Later says when the item has
 * their own reminder ahead (the owner, 11-21: its time is kept unless they reschedule it themselves).
 */
export function ownLabel(when: Date, now: Date, tz: string): string {
    const day = dayOf(when, tz);
    const today = dayOf(now, tz);
    const clock = clockWords(when, tz);
    const words = day === today ? clock : day === addDays(today, 1) ? `Tomorrow ${clock}` : `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(when)} ${clock}`;
    return `Your reminder · ${words}`;
}

/** Their own reminder still ahead for an item (rm_ itself, or a task's next one), or null. */
export async function ownReminderAt(userId: string, id: string, now: Date): Promise<Date | null> {
    const [kind, ...rest] = id.split('_');
    const refId = rest.join('_');
    if (!refId) return null;
    if (kind === 'rm') return (await prisma.reminder.findFirst({ where: { id: refId, userId, status: 'pending', reminderDate: { gt: now } }, select: { reminderDate: true } }))?.reminderDate ?? null;
    if (kind === 'tk') return (await prisma.reminder.findFirst({ where: { userId, todoId: refId, status: 'pending', reminderDate: { gt: now } }, orderBy: { reminderDate: 'asc' }, select: { reminderDate: true } }))?.reminderDate ?? null;
    return null;
}

/** The card as the phone shows it. `own`: their own reminder for it still ahead (Later then keeps that time). */
export function cardOf(r: AheadRow, ctx: { now: Date; tz: string; usual: string | null; appUrl: string | null; own?: Date | null }): NextCard {
    const label = r.kind === 'pickup' ? 'Pick up' : r.day === dayOf(ctx.now, ctx.tz) ? `Today${r.at && r.at !== 'late' ? ` · ${r.at}` : ''}` : `Coming up${r.at ? ` · ${r.at}` : ''}`;
    const link = r.url ?? (r.docId && ctx.appUrl ? `${ctx.appUrl}/docs/${r.docId}` : null);
    const base = { id: r.id, kind: r.kind, label, title: r.text, detail: r.kind === 'pickup' ? (r.detail ?? '') : '', link };
    if (ctx.own) return { ...base, later: { label: ownLabel(ctx.own, ctx.now, ctx.tz), at: ctx.own.toISOString() } };
    const when = laterAt({ now: ctx.now, tz: ctx.tz, kind: r.kind, ownDay: ownDayOf(r), usual: ctx.usual });
    return { ...base, later: when ? { label: laterLabel(when, ctx.now, ctx.tz), at: when.toISOString() } : null };
}

/** How long a tap may wait on the phone (offline) and still be timed from when it was made. */
export const LATER_TAP_WAIT_MS = 24 * 3600_000;

/**
 * The moment the time rules start from: the tap's own time when the phone sent it late (offline, at its next refresh),
 * so the reminder lands when the button said; the server's now for a tap from the future or more than a day old.
 */
export function tapMoment(now: Date, tappedAt?: Date | null): Date {
    if (!tappedAt || Number.isNaN(tappedAt.getTime())) return now;
    const t = tappedAt.getTime();
    return t <= now.getTime() + 5 * 60_000 && t >= now.getTime() - LATER_TAP_WAIT_MS ? new Date(Math.min(t, now.getTime())) : now;
}

const REF_KINDS = new Set(['pu', 'tk', 'th', 'rm', 'br']);

/** At most this far ahead a time the button showed is taken as it is. */
export const SHOWN_AHEAD_MS = 48 * 3600_000;

/**
 * The time the button showed (the phone sends it with the tap, app 0.7.1), when it still holds: ahead of now, at most two
 * days off, never past the item's own day. Null: the rules decide (the owner, 11-21: "bring it back at the time shown").
 */
export function shownTime(shownAt: Date | null | undefined, now: Date, tz: string, ownDay: DayString | null): Date | null {
    if (!shownAt || Number.isNaN(shownAt.getTime())) return null;
    const t = shownAt.getTime();
    if (t <= now.getTime() || t > now.getTime() + SHOWN_AHEAD_MS) return null;
    if (ownDay && dayOf(shownAt, tz) > ownDay) return null;
    return shownAt;
}

/**
 * POST /api/ambient/later {id, tappedAt?, at?}: Later on one of their items now. Usually one silent reminder of Buddy's at
 * the time the button showed (`at`, when it still holds; else the rules, timed from the tap: `tappedAt`), in the item's
 * words; a second Later on the same item moves it (one pending per item); the same tap again changes nothing. The owner's
 * words (11-21):
 * - an item with their own reminder still ahead keeps its time: no reminder of Buddy's, nothing of theirs moved; the item
 *   only leaves the widget, the home picture and Buddy's words until then ('defer');
 * - one of Buddy's own reminders is moved (it is Buddy's, so nothing of theirs changes).
 */
export async function setLater(userId: string, id: string, now: Date = new Date(), tappedAt?: Date | null, shownAt?: Date | null): Promise<{ id: string; at: string; label: string }> {
    const [refKind, ...rest] = id.split('_');
    const refId = rest.join('_');
    if (!refKind || !REF_KINDS.has(refKind) || !refId) throw new ErrorResponse(400, 'Not an item of the widget');
    const { tz } = await loadLearningContext(userId, now);

    const own = await ownReminderAt(userId, id, now);
    if (own) {
        const kept = await prisma.buddyReminder.findFirst({ where: { userId, origin: 'defer', refKind, refId, status: 'pending' } });
        if (kept) await prisma.buddyReminder.update({ where: { id: kept.id }, data: { at: own } });
        else await prisma.buddyReminder.create({ data: { userId, text: 'Later, at their own reminder', at: own, refKind, refId, origin: 'defer', createdAt: now } });
        return { id, at: own.toISOString(), label: ownLabel(own, now, tz) };
    }

    const usual = await usualEvening(userId, now, tz);
    const timeFor = (kind: AheadRow['kind'], ownDay: DayString | null): Date | null => {
        const shown = shownTime(shownAt, now, tz, ownDay);
        if (shown) return shown;
        let when = laterAt({ now: tapMoment(now, tappedAt), tz, kind, ownDay, usual });
        // The time the button showed has passed while the tap waited: the rules again from now.
        if (when && when.getTime() <= now.getTime()) when = laterAt({ now, tz, kind, ownDay, usual });
        return when;
    };

    if (refKind === 'br') {
        const mine = await prisma.buddyReminder.findFirst({ where: { id: refId, userId, status: 'pending' } });
        if (!mine) throw new ErrorResponse(404, 'That item is not on their day any more');
        const when = timeFor('reminder', null);
        if (!when) throw new ErrorResponse(409, 'No time is left before its own day');
        if (mine.at.getTime() !== when.getTime()) await prisma.buddyReminder.update({ where: { id: mine.id }, data: { at: when } });
        return { id, at: when.toISOString(), label: laterLabel(when, now, tz) };
    }

    // The same tap again (a phone that sends it twice): the Later it already set.
    const already = await prisma.buddyReminder.findFirst({ where: { userId, origin: 'later', refKind, refId, status: 'pending', at: { gt: now } } });
    if (already) return { id, at: already.at.toISOString(), label: laterLabel(already.at, now, tz) };
    const ahead = await aheadFor(userId, now, { tz, todayMax: 20, aheadMax: 20, leftMax: 5 });
    const item = [...ahead.today, ...ahead.comingUp, ...ahead.leftOff].find((r) => r.id === id);
    if (!item) throw new ErrorResponse(404, 'That item is not on their day any more');
    const when = timeFor(item.kind, ownDayOf(item));
    if (!when) throw new ErrorResponse(409, 'No time is left before its own day');
    const text = (item.kind === 'pickup' ? `Pick up: ${item.text}` : item.text).slice(0, 120);
    const pending = await prisma.buddyReminder.findFirst({ where: { userId, origin: 'later', refKind, refId, status: 'pending' } });
    // Stamped with the server's now (a moved clock in the simulations): the pulses read a Later tapped since their last step.
    if (pending) await prisma.buddyReminder.update({ where: { id: pending.id }, data: { at: when, text, createdAt: now } });
    else await prisma.buddyReminder.create({ data: { userId, text, at: when, refKind, refId, origin: 'later', createdAt: now } });
    return { id, at: when.toISOString(), label: laterLabel(when, now, tz) };
}

/**
 * The last Laters, for the night and the pulses (<later>): what they put off, from when, and when it comes back, with the
 * item's id (`refs`: a line may rest on it). The owner (11-21): a Later brings Buddy's nudge back at its time, once.
 */
export async function laterBlock(userId: string, now: Date, tz: string): Promise<{ text: string; refs: string[]; sources: string }> {
    const rows = await prisma.buddyReminder.findMany({ where: { userId, origin: 'later', createdAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 5 });
    if (!rows.length) return { text: '', refs: [], sources: '' };
    const clock = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).replace(',', '');
    const ref = (r: (typeof rows)[number]) => (r.refKind && r.refId ? `${r.refKind}_${r.refId}` : null);
    const state = (r: (typeof rows)[number]) => (r.status === 'cancelled' ? ' (taken back)' : r.status !== 'pending' ? '' : r.at > now ? ' (still to come)' : ' (came back)');
    const lines = rows.map((r) => `${ref(r) ? `${ref(r)} · ` : ''}"${r.text}" · put off ${clock(r.createdAt)} → back ${clock(r.at)}${state(r)}`);
    // The items still to come back (or back now): a line may rest on them.
    const open = rows.filter((r) => r.status === 'pending' && r.at.getTime() > now.getTime() - 2 * 3600_000).map(ref).filter((x): x is string => !!x);
    const text = `<later>\n${lines.join('\n')}\nA Later is their own time for that thing: when one comes back within the hours you write for and it still matters, you may give it one line from that time (from = its time), with its id in about, in words that fit that moment; never before its time. Without your line it shows as a row on their lock screen. A Later also tells you their time for that kind of thing: follow it.\n</later>`;
    return { text, refs: [...new Set(open)], sources: rows.map((r) => `${r.text} ${clockWords(r.at, tz)} ${clock(r.at)}`).join('\n') };
}
