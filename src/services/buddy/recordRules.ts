// The record's pure rules (MCP_MEMORY_PLAN §4.3, §4.4): when a statement was said, which of two was said
// later (or that nobody can know), and when two texts are the same memory or close to one marked wrong.
// No database here: memory.service.ts and record.service.ts apply these under the person's lock.
import { addDays, dayOf, type DayString } from '../learning';
import { zonedWallTimeToDate } from '../../utils/timezone';
import { badRequest } from '../learning/http';

/** Whose word a connected assistant passed on (§4.4); null = Kaaga heard it itself, or an older build (passed on). */
export type Basis = 'said' | 'inferred';

/** What an update says about something known (§4.2); stored on the note as `updateKind`. */
export const UPDATE_KINDS = ['said', 'progress', 'done', 'skipped', 'changed', 'paused', 'resumed', 'dropped', 'finished'] as const;
export type UpdateKind = (typeof UPDATE_KINDS)[number];
/** Stored only: a change said before the current version (kept as history), or on its day in an unknown order. */
export type StoredUpdateKind = UpdateKind | 'history' | 'unclear';

/** `said_on`: a day, or a day and a time, in the person's own zone. */
export const SAID_ON = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/;
/** At most this far back (§4.2: "at most a year back"). */
export const SAID_ON_MAX_DAYS = 366;

/** When a statement was said: its instant (a day without a time sits at its local noon), whether only its day is known, and its local day. */
export interface SaidTime {
    at: Date;
    dayOnly: boolean;
    day: DayString;
}

/**
 * `said_on` read in the person's zone (§4.2, §4.4). Left out: said now, its time exact. A future time or
 * day is cut to now. More than a year back is refused. A day without a time keeps `dayOnly`.
 */
export function saidTimeOf(saidOn: string | null | undefined, ctx: { today: DayString; tz: string }, now: Date): SaidTime {
    const raw = (saidOn ?? '').trim();
    if (!raw) return { at: now, dayOnly: false, day: ctx.today };
    const m = SAID_ON.exec(raw);
    if (!m) throw badRequest('said_on: a day (YYYY-MM-DD), or a day and a time (YYYY-MM-DDTHH:mm)');
    const [, y, mo, d, h, mi] = m;
    const day = `${y}-${mo}-${d}` as DayString;
    const noon = zonedWallTimeToDate(Number(y), Number(mo), Number(d), 12, 0, ctx.tz);
    if (dayOf(noon, ctx.tz) !== day) throw badRequest(`said_on: ${day} is not a day`);
    if (day > ctx.today) return { at: now, dayOnly: false, day: ctx.today };
    if (day < addDays(ctx.today, -SAID_ON_MAX_DAYS)) throw badRequest('said_on: at most a year back');
    if (h !== undefined && mi !== undefined) {
        if (Number(h) > 23 || Number(mi) > 59) throw badRequest('said_on: the time is HH:mm');
        const at = zonedWallTimeToDate(Number(y), Number(mo), Number(d), Number(h), Number(mi), ctx.tz);
        return at.getTime() > now.getTime() ? { at: now, dayOnly: false, day: ctx.today } : { at, dayOnly: false, day };
    }
    return { at: noon.getTime() > now.getTime() ? now : noon, dayOnly: true, day };
}

/** One statement for ordering: when it was said (and whether only its day is known), and when it reached Kaaga. */
export interface Statement {
    at: Date;
    dayOnly: boolean;
    /** When it arrived: a statement known only by its day was said before it arrived. */
    arrivedAt: Date;
}

const HALF_DAY = 12 * 3600_000;

/** The earliest and latest instant a statement can have been said (a day-only one: its day, and not after it arrived). */
export function saidWindow(s: Statement): [number, number] {
    if (!s.dayOnly) return [s.at.getTime(), s.at.getTime()];
    return [s.at.getTime() - HALF_DAY, Math.min(s.at.getTime() + HALF_DAY, s.arrivedAt.getTime())];
}

/**
 * Which was said later (§4.4): 1 when `a` surely was, -1 when `b` surely was, 0 when nobody can know (the same
 * day, and one of them known only by its day). Two exact times compare directly; equal ones by arrival.
 */
export function laterOf(a: Statement, b: Statement): 1 | -1 | 0 {
    const [aLow, aHigh] = saidWindow(a);
    const [bLow, bHigh] = saidWindow(b);
    if (!a.dayOnly && !b.dayOnly) {
        if (aLow !== bLow) return aLow > bLow ? 1 : -1;
        return a.arrivedAt.getTime() >= b.arrivedAt.getTime() ? 1 : -1;
    }
    if (aLow > bHigh || (aLow === bHigh && !a.dayOnly)) return 1;
    if (bLow > aHigh || (bLow === aHigh && !b.dayOnly)) return -1;
    return 0;
}

// ─── Same memory, close to a wrong one ───────────────────────────────────────

/** Small words that never change what a memory says (negations and tenses stay: "not", "had", "was"). */
const FILLER = new Set(['the', 'and', 'for', 'with', 'his', 'her', 'their', 'its', 'our', 'also', 'very', 'really', 'just', 'that', 'this']);

/** A text's content words: lower case, no punctuation, longer than two letters, filler left out. */
export function contentWords(text: string): Set<string> {
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return new Set(key.split(' ').filter((w) => w.length > 2 && !FILLER.has(w)));
}

/**
 * Shared content words; the share of the larger set they make (a longer text with more in it is not the same);
 * and the share of the smaller set (how much of the shorter text the other one holds).
 */
export function wordMatch(a: string, b: string): { shared: number; ratio: number; ofSmaller: number } {
    const x = contentWords(a);
    const y = contentWords(b);
    if (!x.size || !y.size) return { shared: 0, ratio: 0, ofSmaller: 0 };
    const shared = [...x].filter((w) => y.has(w)).length;
    return { shared, ratio: shared / Math.max(x.size, y.size), ofSmaller: shared / Math.min(x.size, y.size) };
}

/** Related enough to show beside a save (§4.2 "Related"): two shared content words, or half of the shorter text. */
export function related(a: string, b: string): boolean {
    const { shared, ofSmaller } = wordMatch(a, b);
    return shared >= 2 || (shared >= 1 && ofSmaller >= 0.5);
}

/** §4.3 rule 2: nearly the same words (0.9 of the larger set), so the same memory seen again. */
export const NEAR_SAME = 0.9;
/** §4.3 rule 3: close to a memory marked wrong (0.6, with at least three shared words; fewer must be near the same). */
export const CLOSE_TO_WRONG = 0.6;

export const nearSame = (a: string, b: string): boolean => wordMatch(a, b).ratio >= NEAR_SAME;

export function closeToWrong(text: string, wrong: string): boolean {
    const { shared, ratio } = wordMatch(text, wrong);
    return shared >= 3 ? ratio >= CLOSE_TO_WRONG : ratio >= NEAR_SAME;
}

// ─── What an update's words say (after the live hour, 11-19) ────────────────
// An assistant names the thing (`on`) and the kind of news (`update`) from a brief it read and a chat it is in the
// middle of. On the live hour ChatGPT put "Decided to start learning Spanish" on "Walking after work" as a change, and
// one morning's walk on it as a change of routine, and the record took both as they came. So before anything changes,
// the record checks the two things code can check in the user's own words: is it about that thing at all, and is it
// one day's doing or a new way of doing it (or an end). When the words say nothing either way, the assistant's choice
// stands. The cues are English; other languages keep the choice made.

/** Words that never tell what a statement is about: times, amounts, small verbs, hedges, pronouns. */
const NOT_TOPIC = new Set(
    (
        'today tonight yesterday tomorrow morning mornings afternoon afternoons evening evenings night nights week weeks weekend weekends day days ' +
        'daily weekly month months year years now then soon later earlier again already still ago after before since until while during every each ' +
        'often usually always never sometimes lately recently first last next time times minute minutes min mins hour hours half quarter ' +
        'some much many more less lot lots bit few all any one two three four five six ten hundred thousand couple ' +
        'got get gets getting did does doing done went going gone been being have has had having made make makes making was were are will would ' +
        'could should can cannot didn don doesn wasn weren couldn wouldn shouldn isn aren won keep keeps kept try tried trying want wanted ' +
        'need needed decided decide start started starting stop stopped finish finished plan planned planning think thinking thought feel felt ' +
        'feeling guess seem seems seemed look looks looked put take took give gave let say said tell told know knew come came back side note btw ' +
        'okay yeah yes not also just really very quite pretty actually probably maybe perhaps might likely anyway finally enough good great nice ' +
        'fine bad new old big long short hard easy tired happy you your yours mine ours they them she him its this that these those there here ' +
        'what when where which who why how without from into onto about around over under off out through than but instead anymore way thing ' +
        'things stuff something anything everything nothing own same other else unrelated heads didnt dont doesnt wasnt werent couldnt ' +
        'wouldnt shouldnt isnt arent wont ive ill youre theyre thats theres lets too well haha lol ugh hmm wow yay oops'
    ).split(' ')
);

/** Everyday irregular pasts, to their present form. */
const IRREGULAR: Readonly<Record<string, string>> = {
    ran: 'run', swam: 'swim', rode: 'ride', ate: 'eat', slept: 'sleep', wrote: 'write', drove: 'drive', taught: 'teach', bought: 'buy',
    built: 'build', spent: 'spend', met: 'meet', sang: 'sing', drew: 'draw', flew: 'fly', began: 'begin', read: 'read', fought: 'fight',
};

/** A word's plain stem, so "walks", "walked" and "walking" meet, and "ran" meets "run" (crude, and the same on both sides). */
export function stem(word: string): string {
    let w = word.toLowerCase();
    w = IRREGULAR[w] ?? w;
    if (w.length > 4 && (w.endsWith('ies') || w.endsWith('ied'))) w = `${w.slice(0, -3)}y`;
    else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 4 && /(ss|sh|ch|x|z)es$/.test(w)) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (/([bdgmnprt])\1$/.test(w)) w = w.slice(0, -1);
    if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
    return w;
}

/** What a text is about: its content words, minus times, amounts and small verbs, as stems (numbers left out). */
export function topicStems(text: string): Set<string> {
    const out = new Set<string>();
    for (const w of contentWords(text.replace(/[’']/g, ''))) {
        if (NOT_TOPIC.has(w) || /^\d/.test(w)) continue;
        const s = stem(w);
        if (s.length >= 3 && !NOT_TOPIC.has(s)) out.add(s);
    }
    return out;
}

/** A statement must name at least this many things of its own, none the target's, to count as being about something else (one stray word is weak). */
export const APART_MIN_WORDS = 2;

/**
 * Whether a statement is about a known thing (pure): 'yes' when they share a topic word; 'no' when the statement names
 * two or more things and none is the thing's ("Decided to start learning Spanish" against "Walking after work");
 * 'unknown' when it names fewer ("Done for today!", "Got my steps in": the assistant's choice of id stands).
 */
export function aboutThing(text: string, thing: string): 'yes' | 'no' | 'unknown' {
    const mine = topicStems(text);
    if (!mine.size) return 'unknown';
    const theirs = topicStems(thing);
    if ([...mine].some((w) => theirs.has(w))) return 'yes';
    return mine.size >= APART_MIN_WORDS ? 'no' : 'unknown';
}

/** The share of a statement's topic words that a thing holds (0 when it names none). */
export function topicCover(text: string, thing: string): number {
    const mine = topicStems(text);
    if (!mine.size) return 0;
    const theirs = topicStems(thing);
    return [...mine].filter((w) => theirs.has(w)).length / mine.size;
}

/** One dated occurrence: a day named (today, this morning, last night, on Monday). */
const ONCE = /\b(today|tonight|yesterday|this (morning|afternoon|evening|week)|last (night|evening)|earlier today|just now|so far today)\b|\bon (mon|tues|wednes|thurs|fri|satur|sun)day\b/i;
/** A standing routine, or a change to one. */
const ROUTINE =
    /\b(nowadays|these days|any ?more|no longer|from now on|from (today|tomorrow|next \w+)|starting (today|tomorrow|next \w+)|going forward|instead|usually|normally|every|each (day|morning|evening|night|week)|most days|(mon|tues|wednes|thurs|fri|satur|sun)days|weekdays|weekends|daily|weekly|switch(ed|ing)?|mov(e|ed|ing) (my|the|it|them|to)|chang(e|ed|ing)|start(ed|ing)? (to )?\w+ing|a (day|week|month)|per (day|week|month))\b|(?<!(just|right) )\bnow\b/i;
/** An end of the thing itself. */
const ENDING = /\b(stop(ped|ping)?|quit(ting)?|gave up|give up|giving up|done with|finished with|no longer|dropp(ed|ing)|enough (for now|of)|leave it|leaving it|call(ed|ing)? it (off|quits)|cancel(l?ed|ling)?|for good)\b/i;
/** Did it (or some of it). */
const DID =
    /\b(did|done|got (it|my|the|a|in|some|to)|finished|completed|hit (my|the)|made it|managed|went (for|to|on)|had (my|a)|walked|ran|swam|jogged|cycled|biked|hiked|played|practi[cs]ed|trained|worked out|studied|meditated|stretched|lifted|cooked|wrote|logged)\b|\b\d+(\.\d+)?\s?(k|km|mi|miles?|mins?|minutes?|hours?|hrs?|pages?|reps?|steps|laps?|sets?)\b/i;
/** Did not. */
const SKIPPED = /\b(skip(ped|ping)?|miss(ed|ing)|didn'?t|did not|couldn'?t|could not|no time|wasn'?t able|not today|bailed)\b|\bno \w+ today\b/i;

/** What a statement's words say about its shape (pure; English cues). */
export interface Shape {
    /** It names one day. */
    once: boolean;
    /** It names a routine, or a change of one. */
    routine: boolean;
    /** It names an end. */
    ending: boolean;
    did: boolean;
    skipped: boolean;
}

export function shapeOf(text: string): Shape {
    const t = text.replace(/’/g, "'");
    const skipped = SKIPPED.test(t);
    return { once: ONCE.test(t), routine: ROUTINE.test(t), ending: ENDING.test(t), skipped, did: DID.test(t.replace(new RegExp(SKIPPED.source, 'gi'), ' ')) };
}

/** One day's news in a statement's words: skipped, done, or some progress. */
export function dayNewsOf(text: string): 'skipped' | 'done' | 'progress' {
    const s = shapeOf(text);
    return s.skipped && !s.did ? 'skipped' : s.did ? 'done' : 'progress';
}

/**
 * The update a statement's words support (pure). One day's doing (a day named, no new routine, no end) is never a
 * change of routine or an end: "changed" or "dropped" become that day's news, and so does "finished" on something
 * that recurs (a habit is not finished by one finished walk; an aim may well be finished on a day). A day's news whose
 * words say the opposite (skipped against did) takes the words' side. Anything else stays as the assistant chose.
 */
export function updateFromWords(update: UpdateKind, text: string, recurring: boolean): UpdateKind {
    const s = shapeOf(text);
    const oneDay = s.once && !s.routine && !s.ending;
    switch (update) {
        case 'changed':
        case 'dropped':
            return oneDay ? dayNewsOf(text) : update;
        case 'finished':
            return oneDay && recurring ? dayNewsOf(text) : update;
        case 'progress':
        case 'done':
            return s.skipped && !s.did ? 'skipped' : update;
        case 'skipped':
            return s.did && !s.skipped ? 'done' : update;
        default:
            return update;
    }
}

/** Whether words describe a routine ("most days", "on Sundays", "a day"), for something that recurs. */
export const soundsRoutine = (text: string): boolean => ROUTINE.test(text.replace(/’/g, "'"));

// ─── remember, resolved by the words (MCP_MEMORY_PLAN §12.4 B, the final look of 11-19) ─────────────────────
// The same words must land in the same place whichever tool the assistant picked. On the fresh live test ChatGPT sent
// "Had two coffees today, the cutting down isn't going great" with remember (a new habit) while "Cutting down to one
// coffee a day" was followed, and "Stopped reading before bed, audiobooks instead" with remember while "Reads 20 pages
// before bed" stayed: two contradicting habits. Code reads one day's news as the thing's progress, and marks an older
// memory that new words may replace (never replacing it: a wrong replacement would lose a true memory unseen).

/** remember for one day's doing of a followed thing is its day news when this sure: at most this many words. */
export const DAY_NEWS_MAX_WORDS = 25;
/** ... and, with a doing or a skip word, at least this share of its topic words are the thing's. */
export const DAY_NEWS_COVER = 0.5;
/** Without a doing or a skip word, at least this many topic words shared (and half of one side's). */
export const PROGRESS_MIN_SHARED = 2;
/** New words may replace an older memory sharing at least this many topic words with them. */
export const MAY_REPLACE_MIN_SHARED = 2;

/** The topic words two texts share, and how many each names. */
export function topicOverlap(text: string, thing: string): { shared: number; mine: number; theirs: number } {
    const mine = topicStems(text);
    const theirs = topicStems(thing);
    return { shared: [...mine].filter((w) => theirs.has(w)).length, mine: mine.size, theirs: theirs.size };
}

/**
 * One day's news about a thing (§12.4 B1), or null: a day named, no routine, no end, at most 25 words. With a doing or
 * a skip word: done or skipped, when at least half of its topic words are the thing's. Without one ("had two coffees
 * today, the cutting down isn't going great"): progress, when two or more topic words are shared and they are half of
 * the remark's or half of the thing's.
 */
export function dayNewsOn(text: string, thing: string): 'done' | 'skipped' | 'progress' | null {
    const s = shapeOf(text);
    if (!s.once || s.routine || s.ending) return null;
    if (text.split(/\s+/).length > DAY_NEWS_MAX_WORDS) return null;
    const o = topicOverlap(text, thing);
    if (!o.mine) return null;
    if (s.did || s.skipped) return o.shared / o.mine >= DAY_NEWS_COVER ? (s.skipped && !s.did ? 'skipped' : 'done') : null;
    return o.shared >= PROGRESS_MIN_SHARED && (o.shared / o.mine >= 0.5 || o.shared / Math.max(1, o.theirs) >= 0.5) ? 'progress' : null;
}

/** A correction's words ("cashews, not peanuts", "actually", "rather than"). */
const CORRECTION = /\b(not|actually|rather than|no longer|any ?more|instead|correction)\b/i;

/** Words that may replace what was known (§12.4 B2): a routine or a change of one, an end, or a correction. */
export const soundsLikeChange = (text: string): boolean => {
    const t = text.replace(/’/g, "'");
    return ROUTINE.test(t) || ENDING.test(t) || CORRECTION.test(t);
};

/**
 * A search word's root (§12.4 D), so other forms of it meet ("allergies" finds "Allergic to cashews", "cycling" the
 * ride): its stem, less its last letter when that is still long; null when the word itself already says it all or
 * the root would be too short to mean anything.
 */
export function searchRoot(word: string): string | null {
    let root = stem(word);
    if (root.length > 5) root = root.slice(0, -1);
    return root.length >= 4 && root !== word.toLowerCase() ? root : null;
}
