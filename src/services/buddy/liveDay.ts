// Stage 18 (ECOSYSTEM_V2_PLAN, "A live day"): their own fresh words that change today (a plan for tonight, a change to
// today's plan, how today is going) start one small pulse within minutes, so today's screens follow today, not
// tomorrow's night. The digest says so for words it reads (`today`); a direct save from a connected chat, passed on as
// their word, says so by its words (a word list, no model). Either stamps BuddyCaptureDay.todayAt; pulseDue (the loop
// on) treats a stamp newer than the last step as an event, within the pulse budget (3 minutes after, 30 after the step
// before, 4 a day).
import { prisma } from '../../db/prisma';
import { dayOf, type DayString } from '../learning';
import { toDbDay } from '../learningDb/common';

/** Words that name today (a direct save is about today only when it says so). */
export const TODAY_WORDS = /\b(today|tonight|this (morning|afternoon|evening)|right now)\b/i;

/** Words said this long ago or more are old news: they build history, never a pulse (the digest's own rule). */
const FRESH_MS = 48 * 3600_000;

/** The words kept with the stamp: the latest 400 characters (J16b, 11-20: a pulse that saw no note kept a push). */
export const TODAY_WORDS_MAX = 400;

/** Stamps that their words changed today (now), with those words (scrubbed by the caller), so the pulse knows what changed. */
export async function stampToday(userId: string, today: DayString, now: Date, words: string): Promise<void> {
    const text = words.replace(/\s+/g, ' ').trim();
    const had = (await prisma.buddyCaptureDay.findUnique({ where: { userId_day: { userId, day: toDbDay(today) } }, select: { todayWords: true } }))?.todayWords ?? '';
    const joined = (had ? `${had} / ${text}` : text).slice(-TODAY_WORDS_MAX);
    await prisma.buddyCaptureDay.upsert({
        where: { userId_day: { userId, day: toDbDay(today) } },
        create: { userId, day: toDbDay(today), todayAt: now, todayWords: joined },
        update: { todayAt: now, todayWords: joined },
    });
}

/** Whether a message said at `at` is today's fresh news (said today, their clock, and not long before it arrived). */
export function freshToday(at: Date, now: Date, tz: string, today: DayString): boolean {
    return dayOf(at, tz) === today && now.getTime() - at.getTime() <= FRESH_MS && at.getTime() <= now.getTime() + 60_000;
}

/** A direct save passed on as their word: does it change today (its words name today, said today)? */
export function directSaveChangesToday(text: string, said: { at: Date; dayOnly?: boolean }, now: Date, tz: string, today: DayString): boolean {
    return TODAY_WORDS.test(text) && freshToday(said.at, now, tz, today);
}
