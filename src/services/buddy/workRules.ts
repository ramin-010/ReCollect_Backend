// The work picture's pure rules (ECOSYSTEM_V2_PLAN stage 12, §12.1-§12.2): when two work lines say the same thing in
// words, what a "thing" is (the lines joined by followsId, a repeat folded into the line it repeats), its state (its
// newest line by when it happened, never by when it arrived), and the views every surface reads (a day, what is open,
// the decisions, what a writer is shown). No database here: work.ts loads the lines and writes under the person's lock.
import type { WorkLineKind, WorkLineSource } from '@prisma/client';
import { addDays, type DayString } from '../learning';
import { topicStems } from './recordRules';

// ─── Same thing, in words ───────────────────────────────────────────────────

/** A comparison key: lower case, letters and digits only. */
export const lineKey = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Shared topic stems (content words without times, small verbs or amounts, stemmed: recordRules.topicStems); the
 * share of the larger set they make; the share of the smaller set.
 */
export function workMatch(a: string, b: string): { shared: number; ratio: number; ofSmaller: number } {
    const x = topicStems(a);
    const y = topicStems(b);
    if (!x.size || !y.size) return { shared: 0, ratio: 0, ofSmaller: 0 };
    const shared = [...x].filter((w) => y.has(w)).length;
    return { shared, ratio: shared / Math.max(x.size, y.size), ofSmaller: shared / Math.min(x.size, y.size) };
}

/**
 * The same line again (W1, W2: not written): the same words, or nearly all of the larger one's topic shared (0.9, at
 * least two). The labelled pairs (tests/unit/buddy/workRules.test.ts) set it: at 0.75, one swapped noun in five
 * ("the invoice report" / "the credit note report", "staging" / "production") read as the same line, and a wrong
 * "same" loses an outcome, the costly miss. Anything less alike is the writer's judgement, shown the close lines.
 */
export const SAME_WORK = 0.9;
export function sameWork(a: string, b: string): boolean {
    if (lineKey(a) && lineKey(a) === lineKey(b)) return true;
    const { shared, ratio } = workMatch(a, b);
    return shared >= 2 && ratio >= SAME_WORK;
}

/** Close in words but not the same (W5): shown first to a writer as "this looks like the same thing"; the writer decides. */
export const CLOSE_WORK = 0.5;
export function closeWork(a: string, b: string): boolean {
    if (sameWork(a, b)) return false;
    const { shared, ofSmaller } = workMatch(a, b);
    return shared >= 2 && ofSmaller >= CLOSE_WORK;
}

// ─── Things ─────────────────────────────────────────────────────────────────

/** A work line as the picture reads it. */
export interface PicLine {
    id: string;
    day: DayString;
    project: string;
    kind: WorkLineKind;
    text: string;
    at: string | null;
    source: WorkLineSource;
    app: string | null;
    office: boolean;
    hidden: boolean;
    sameAsId: string | null;
    followsId: string | null;
    sessionKey: string;
    /** happenedAt, else createdAt (older rows). */
    happenedAt: Date;
    createdAt: Date;
    position: number;
}

/** Oldest first: when it happened, then when it arrived, then its place in its list. */
export const byHappened = (a: PicLine, b: PicLine): number =>
    a.happenedAt.getTime() - b.happenedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Shown at all: not removed by the person, not folded into the line it repeats. */
export const isVisible = (l: PicLine): boolean => !l.hidden && !l.sameAsId;

/** One thing: the visible lines of one chain, oldest first; its state is its newest line. */
export interface Thing {
    /** The chain's first line (its id, even when that line is no longer loaded or visible). */
    key: string;
    lines: PicLine[];
    newest: PicLine;
}

export interface Picture {
    things: Thing[];
    /** Each visible line's thing. */
    thingOf: Map<string, Thing>;
    byId: Map<string, PicLine>;
}

const MAX_WALK = 50;

/** Where an id lands once repeats are folded: a joined line counts as the line it was joined to. */
export function resolveId(id: string, byId: ReadonlyMap<string, PicLine>): string {
    let cur = id;
    const seen = new Set<string>();
    for (let i = 0; i < MAX_WALK; i++) {
        const l = byId.get(cur);
        if (!l?.sameAsId || seen.has(cur)) return cur;
        seen.add(cur);
        cur = l.sameAsId;
    }
    return cur;
}

/** The first line of a line's chain (followsId upwards, repeats folded). */
export function rootOf(line: PicLine, byId: ReadonlyMap<string, PicLine>): string {
    let cur = resolveId(line.id, byId);
    const seen = new Set<string>([cur]);
    for (let i = 0; i < MAX_WALK; i++) {
        const l = byId.get(cur);
        if (!l?.followsId) return cur;
        const up = resolveId(l.followsId, byId);
        if (seen.has(up)) return cur;
        seen.add(up);
        cur = up;
    }
    return cur;
}

/** The lines as things: each visible line in the chain of its first line; each thing oldest first. */
export function buildPicture(lines: readonly PicLine[]): Picture {
    const byId = new Map(lines.map((l) => [l.id, l] as const));
    const groups = new Map<string, PicLine[]>();
    for (const l of lines) {
        if (!isVisible(l)) continue;
        const key = rootOf(l, byId);
        const g = groups.get(key);
        if (g) g.push(l);
        else groups.set(key, [l]);
    }
    const things: Thing[] = [];
    const thingOf = new Map<string, Thing>();
    for (const [key, g] of groups) {
        g.sort(byHappened);
        const thing: Thing = { key, lines: g, newest: g[g.length - 1]! };
        things.push(thing);
        for (const l of g) thingOf.set(l.id, thing);
    }
    things.sort((a, b) => byHappened(b.newest, a.newest));
    return { things, thingOf, byId };
}

// ─── The views ──────────────────────────────────────────────────────────────

/** A day as every surface shows it: per thing, that day's newest line (one entry per thing per day). */
export function dayLines(p: Picture, day: DayString): PicLine[] {
    const out: PicLine[] = [];
    for (const t of p.things) {
        const today = t.lines.filter((l) => l.day === day);
        if (today.length) out.push(today[today.length - 1]!);
    }
    return out.sort(byHappened);
}

export type LaterWord = 'fixed' | 'done' | 'changed' | 'reopened' | 'updated';

/** How a later line reads beside an earlier one of its thing ("Open: the upload bug · fixed Tue"). */
export function laterWord(shown: WorkLineKind, later: WorkLineKind): LaterWord {
    if (later === 'did') return shown === 'stuck' ? 'fixed' : 'done';
    if (later === 'decided') return shown === 'decided' ? 'changed' : 'updated';
    if (later === 'stuck') return shown === 'stuck' ? 'updated' : 'reopened';
    return 'updated';
}

/**
 * What came after a shown line: its thing's newest line, when that is newer (a day shows each thing at that day's
 * newest line, so there it is a later day's; the open and decided views show an earlier line of the day too).
 */
export function laterOf(shown: PicLine, p: Picture): PicLine | null {
    const t = p.thingOf.get(shown.id);
    if (!t || t.newest.id === shown.id || byHappened(t.newest, shown) <= 0) return null;
    return t.newest;
}

/** Open problems kept this long; "next" lines this long (a plan said in passing goes stale fast). */
export const OPEN_DAYS = 30;
export const NEXT_DAYS = 3;

/** What is still open: things whose newest line is an open problem (30 days) or a next step nothing followed (3 days); newest first. */
export function openThings(p: Picture, today: DayString, opts: { openDays?: number; nextDays?: number } = {}): Thing[] {
    const openFrom = addDays(today, -(opts.openDays ?? OPEN_DAYS));
    const nextFrom = addDays(today, -(opts.nextDays ?? NEXT_DAYS));
    return p.things.filter((t) => (t.newest.kind === 'stuck' && t.newest.day >= openFrom) || (t.newest.kind === 'next' && t.newest.day >= nextFrom));
}

/**
 * Likely done, not linked (read time, no AI; the live hour, 11-20: a fix logged without `on` left its open line open):
 * an open thing whose open line a later done line of the same project is close to in words, from any app. Shown as
 * "likely done" (never closed by code); the night's AI settles it where the account has AI; the writers are asked to link.
 */
export function likelyDone(p: Picture): Map<string, PicLine> {
    const out = new Map<string, PicLine>();
    const done = p.things.flatMap((t) => t.lines.filter((l) => l.kind === 'did').map((l) => ({ l, t })));
    for (const t of p.things) {
        if (t.newest.kind !== 'stuck') continue;
        const open = t.newest;
        const hit = done
            .filter(({ l, t: u }) => u !== t && l.project === open.project && byHappened(l, open) > 0 && (closeWork(open.text, l.text) || sameWork(open.text, l.text)))
            .map(({ l }) => l)
            .sort(byHappened)
            .pop();
        if (hit) out.set(t.key, hit);
    }
    return out;
}

/** Each decision at its newest state: a thing's last decided line, with the one it changed (if any). */
export function decisionsOf(p: Picture): Array<{ line: PicLine; was: PicLine | null }> {
    const out: Array<{ line: PicLine; was: PicLine | null }> = [];
    for (const t of p.things) {
        const d = t.lines.filter((l) => l.kind === 'decided');
        if (d.length) out.push({ line: d[d.length - 1]!, was: d.length > 1 ? d[d.length - 2]! : null });
    }
    return out.sort((a, b) => byHappened(b.line, a.line));
}

/** What a writer is shown (W5): what is open, and the day's other lines; a line close in words first, then its project. */
export interface WriterView {
    open: PicLine[];
    day: Array<{ line: PicLine; close: boolean }>;
}

export const WRITER_OPEN_MAX = 5;
export const WRITER_OPEN_DAYS = 14;
export const WRITER_DAY_MAX = 6;

export function writerView(
    p: Picture,
    opts: { day: DayString; today: DayString; project?: string | null | undefined; text?: string | null | undefined; exclude?: readonly string[]; openMax?: number; dayMax?: number }
): WriterView {
    // The thing just written (or the writer's own lines) is not shown back to it.
    const skip = new Set<Thing>();
    for (const id of opts.exclude ?? []) {
        const t = p.thingOf.get(id) ?? p.thingOf.get(resolveId(id, p.byId));
        if (t) skip.add(t);
    }
    const text = opts.text ?? '';
    const close = (l: PicLine) => !!text && (closeWork(text, l.text) || sameWork(text, l.text));
    const open = openThings(p, opts.today, { openDays: WRITER_OPEN_DAYS })
        .filter((t) => !skip.has(t))
        .map((t) => t.newest)
        .sort((a, b) => Number(close(b)) - Number(close(a)) || Number(b.project === opts.project) - Number(a.project === opts.project) || byHappened(b, a))
        .slice(0, opts.openMax ?? WRITER_OPEN_MAX);
    const shownOpen = new Set(open.map((l) => l.id));
    const day = dayLines(p, opts.day)
        .filter((l) => !shownOpen.has(l.id) && !skip.has(p.thingOf.get(l.id)!))
        .map((line) => ({ line, close: close(line) }))
        .sort((a, b) => Number(b.close) - Number(a.close) || Number(b.line.project === opts.project) - Number(a.line.project === opts.project) || byHappened(b.line, a.line))
        .slice(0, opts.dayMax ?? WRITER_DAY_MAX);
    return { open, day };
}

// ─── Projects without Projects ──────────────────────────────────────────────

/** A project name as a key: lower case, spaces collapsed (as folder keys are). */
export const projectName = (name: string): string => name.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
const squash = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const wordsOf = (name: string) => [...new Set(name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))].sort().join(' ');

/**
 * A given project name matched loosely to the person's existing ones (case, punctuation, the same words in any order:
 * "Second Brain" is "second_brain"); none matches: the name as given; none given: "other".
 */
export function matchProject(given: string | null | undefined, existing: readonly string[]): string {
    const name = projectName(given ?? '');
    if (!name) return 'other';
    const hit = existing.find((e) => e === name) ?? existing.find((e) => squash(e) === squash(name)) ?? existing.find((e) => wordsOf(e) === wordsOf(name));
    return hit ?? name;
}
