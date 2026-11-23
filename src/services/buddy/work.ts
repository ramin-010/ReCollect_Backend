// The work log (BUDDY_MEMORY_PLAN §11.2, B9): what they did, per project and day, office work too, so "what did I do
// on the ERP yesterday?" has an answer before a standup. A store apart from the memory about them: dated lines that
// never fade, never become memories or the portrait, and never reach the lock screen (the night's lock check treats
// them as private). A line they remove stays as a hidden row, so it is never written again.
//
// ECOSYSTEM_V2_PLAN stage 12: one picture of the work, from every chat. Several chats and apps work on the same thing
// at once (Claude Code fixes, ChatGPT reviews its pasted report, a parent chat hears the review), so the log follows the
// memory record's rules: every write under the person's lock; when a line happened, not when it arrived (a late older
// summary never becomes the newest); a writer says what its line is (a new thing, or news `on` a known one) and writes
// nothing for what the picture already has; open things are closed by a later line; rows keep their ids (other lines
// point at them); and one reader (`workRules.ts`) behind every surface, so every surface says the same.
//
//   GET    /api/buddy/work?project=&from=&to=&q=&limit=&view=&work=1   read: the app, agents, Ask AI (views: all, done, decided, open)
//   GET    /api/buddy/work/picture?project=&day=&work=1                 read: what a writer is shown (Claude Code's log_work)
//   POST   /api/buddy/work                                              sessions:write: a chat's list for a day (Claude Code's log_work, /log-work)
//   POST   /api/buddy/work/line                                         sessions:write: one outcome (claude.ai and ChatGPT's log_work)
//   PATCH  /api/buddy/work/line/:id                                     sessions:write: the writing app folds, rewords, links or removes its own line
//   DELETE /api/buddy/work/:id                                          cookie only: the person removes a line
//
// The summariser (Sonnet 5.5) writes the lines of Claude Code's personal folders from their captured words; every other
// writer is the chat's own model. No model call on our side for a web line: it works at zero AI credits.
import { randomBytes } from 'node:crypto';
import { Prisma, type BuddyChunk, type WorkLine, type WorkLineKind, type WorkLineSource } from '@prisma/client';
import { z } from 'zod';
import { prisma, type DbClient, type TxClient } from '../../db/prisma';
import { callClaude } from '../claude/client';
import { recordAiUsage } from '../claude/usage.service';
import { parseJson, responseText } from '../recall/output';
import { withRefusalFallbacks, type CreateParams } from '../recall/prompts';
import { addDays, isValidDay, type DayString } from '../learning';
import { dayOf } from '../learning/time';
import { notFound } from '../learning/http';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { folderKindOf, officeFolder } from '../learningDb/lens';
import { searchTerms } from '../docs/docSearch.service';
import ErrorResponse from '../../utils/errorResponse';
import { zonedWallTimeToDate } from '../../utils/timezone';
import { bumpDay, type ChunkMessage } from './capture.service';
import { scrubSecrets } from './scrub';
import { withPersonLock } from './threads';
import { unlabel } from './words';
import {
    WRITER_OPEN_DAYS,
    buildPicture,
    byHappened,
    closeWork,
    dayLines,
    decisionsOf,
    isVisible,
    laterOf,
    laterWord,
    likelyDone,
    lineKey,
    matchProject,
    openThings,
    resolveId,
    sameWork,
    workMatch,
    writerView,
    type LaterWord,
    type PicLine,
    type Picture,
    type WriterView,
} from './workRules';

export const WORK_MODEL = process.env['BUDDY_WORK_MODEL'] || 'claude-sonnet-5-5';
/** A session's lines for one day, at most. */
export const WORK_LINES_MAX = 6;
export const WORK_LINE_MAX = 160;
/** Their words as the summariser sees them (the agent's reply start is already ≤ 300). */
const WORDS_MAX = 600;
/** Lines they removed that a writer is checked against (this many days). */
const REMOVED_DAYS = 14;
/** How far back the picture reads (open things are kept this long). */
const PICTURE_DAYS = 30;
const EPHEMERAL = { type: 'ephemeral' } as const;

export const WORK_KINDS = ['did', 'decided', 'stuck', 'next'] as const;

export const WORK_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['lines'],
    properties: {
        lines: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'text', 'on'],
                properties: { kind: { type: 'string', enum: [...WORK_KINDS] }, text: { type: 'string' }, on: { type: 'string' } },
            },
        },
    },
};

export const WORK_SYSTEM = `You keep a short work log for a person who works with AI agents: what got done in one of their chats with an AI agent, per project and day, so they can answer "what did I do on this project yesterday?" before a standup. You get the chat (their messages, marked user:, and the start of each agent reply), the lines this chat already has for today, lines they removed from their log, and what their log already has from their other chats and apps (<already_logged>, each line with its id): they often work on one thing in several chats at once, for example ChatGPT reviewing what this chat did.

Write the chat's whole list for today; it replaces the lines so far. At most ${WORK_LINES_MAX} lines, each one short line (under ${WORK_LINE_MAX} characters) in plain past tense, specific enough to say in a standup: "Fixed the GST rounding in the invoice report", "Decided to keep the old export until the client signs off". kind: did (built, fixed, changed, checked), decided (a choice, with the reason in a few words), stuck (a problem not solved yet), next (what they said comes next).

Rules:
- Only what the chat shows. The agent's replies say what was done; their messages say what they asked for. An ask with no sign it was done is not "did" (it may be "next").
- Merge with the lines so far: keep what still holds, update what changed, drop what turned out wrong, never two lines for one thing. Never write a line they removed, or one that says the same.
- Already logged: never a line for something <already_logged> has, even in other words or with more detail (a decision they brought here from another chat is already there; write only what this chat did with it). A line that is news on one of them (an open problem there is now fixed, a decision there changed) carries that line's id in on; every other line has on "".
- Work only: nothing about their feelings, health, money, family, their job search or their life outside the work; those never belong in this log.
- No secrets, keys, passwords, tokens or links with them; no personal data of other people (names of private persons, phone numbers, emails).
- A chat that did no real work (small talk, a question about a topic, only approvals) gets no lines: return an empty list.`;

export interface WorkInput {
    project: string;
    day: DayString;
    weekday: string;
    messages: readonly ChunkMessage[];
    soFar: ReadonlyArray<{ kind: string; text: string }>;
    removed: readonly string[];
    /** Stage 12: what other chats and apps already logged (open things and that day's lines), with ids. */
    already?: ReadonlyArray<{ id: string; kind: string; text: string; app: string | null; open?: boolean }>;
}

const oneLine = (t: string, max: number) => {
    const s = t.replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/** The chat as the summariser reads it: their words (≤ 600 characters each) and the start of each reply. */
export function workChat(messages: readonly ChunkMessage[]): string {
    return messages.map((m) => `user: ${oneLine(m.text, WORDS_MAX)}${m.reply ? `\nagent: ${oneLine(m.reply, 300)}` : ''}`).join('\n');
}

const KIND_WORD: Readonly<Record<WorkLineKind, string>> = { did: 'did', decided: 'decided', stuck: 'open', next: 'next' };

export function workRequest(input: WorkInput): CreateParams {
    const already = (input.already ?? []).map((l) => `[${l.id}] ${l.open ? 'open' : KIND_WORD[l.kind as WorkLineKind] ?? l.kind} · ${l.text}${l.app ? ` (${l.app})` : ''}`);
    const text = [
        `<project>${input.project}</project>`,
        `<today>${input.weekday} ${input.day}</today>`,
        `<chat>\n${workChat(input.messages)}\n</chat>`,
        `<so_far>\n${input.soFar.map((l) => `${l.kind} · ${l.text}`).join('\n') || 'nothing yet'}\n</so_far>`,
        `<removed>\n${input.removed.join('\n') || 'none'}\n</removed>`,
        `<already_logged>\n${already.join('\n') || 'nothing'}\n</already_logged>`,
    ].join('\n\n');
    return {
        model: WORK_MODEL,
        max_tokens: 4000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: WORK_SCHEMA } },
        system: [{ type: 'text', text: WORK_SYSTEM, cache_control: EPHEMERAL }],
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    } as CreateParams;
}

const zWork = z.object({ lines: z.array(z.object({ kind: z.enum(WORK_KINDS), text: z.string(), on: z.string().optional() })) });

export { lineKey } from './workRules';

/** The summariser's lines, cleaned: scrubbed, no label, short, no repeat and nothing they removed (`on` kept when given). */
export function cleanWorkLines(output: unknown, removed: readonly string[]): Array<{ kind: WorkLineKind; text: string; on?: string }> {
    const parsed = zWork.safeParse(output);
    if (!parsed.success) throw new Error('the work summary answered in the wrong shape');
    const gone = new Set(removed.map(lineKey));
    const seen = new Set<string>();
    const out: Array<{ kind: WorkLineKind; text: string; on?: string }> = [];
    for (const l of parsed.data.lines) {
        const text = oneLine(unlabel(scrubSecrets(l.text)), WORK_LINE_MAX);
        const key = lineKey(text);
        if (!key || gone.has(key) || seen.has(key)) continue;
        seen.add(key);
        const on = l.on?.trim();
        out.push({ kind: l.kind, text, ...(on ? { on } : {}) });
        if (out.length >= WORK_LINES_MAX) break;
    }
    return out;
}

/** Is their work log on (BuddyState.workLog)? */
export async function workLogOn(userId: string): Promise<boolean> {
    const s = await prisma.buddyState.findUnique({ where: { userId }, select: { workLog: true } });
    return !!s?.workLog;
}

// ─── Loading the picture ────────────────────────────────────────────────────

/**
 * Who reads (stage 12): Recollect itself (the app, Ask AI, the night: everything); a connected chat (ChatGPT, Claude,
 * Claude Code outside a work folder: a work folder's lines only while the person shares them); a work folder (its own
 * project only).
 */
export type WorkDoor = 'app' | 'connected' | { folder: string };
type Seen = { kind: 'app' } | { kind: 'connected'; share: boolean } | { kind: 'folder'; project: string };

const seenBy = (door: Seen, l: PicLine): boolean => (door.kind === 'app' ? true : door.kind === 'folder' ? l.project === door.project : door.share || !l.office);

async function seenFor(userId: string, door: WorkDoor): Promise<Seen> {
    if (door === 'app') return { kind: 'app' };
    if (door === 'connected') return { kind: 'connected', share: (await prisma.buddyState.findUnique({ where: { userId }, select: { shareOfficeWork: true } }))?.shareOfficeWork ?? true };
    return { kind: 'folder', project: door.folder.trim().toLowerCase() };
}

const PIC_SELECT = {
    id: true,
    day: true,
    project: true,
    kind: true,
    text: true,
    at: true,
    source: true,
    app: true,
    office: true,
    hidden: true,
    sameAsId: true,
    followsId: true,
    sessionKey: true,
    happenedAt: true,
    createdAt: true,
    position: true,
} as const;

type PicRow = Prisma.WorkLineGetPayload<{ select: typeof PIC_SELECT }>;

const toPic = (r: PicRow): PicLine => ({
    id: r.id,
    day: fromDbDay(r.day),
    project: r.project,
    kind: r.kind,
    text: r.text,
    at: r.at,
    source: r.source,
    app: r.app,
    office: r.office,
    hidden: r.hidden,
    sameAsId: r.sameAsId,
    followsId: r.followsId,
    sessionKey: r.sessionKey,
    happenedAt: r.happenedAt ?? r.createdAt,
    createdAt: r.createdAt,
    position: r.position,
});

/** Their lines from `since` on (hidden and joined ones too: the chains need them), with the older lines their chains reach. */
async function loadLines(db: DbClient, userId: string, since: DayString): Promise<PicLine[]> {
    const rows = await db.workLine.findMany({ where: { userId, day: { gte: toDbDay(since) } }, select: PIC_SELECT });
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    for (let round = 0; round < 5; round++) {
        const missing = [...new Set([...byId.values()].flatMap((r) => [r.followsId, r.sameAsId]).filter((id): id is string => !!id && !byId.has(id)))];
        if (!missing.length) break;
        const more = await db.workLine.findMany({ where: { userId, id: { in: missing } }, select: PIC_SELECT });
        if (!more.length) break;
        for (const r of more) byId.set(r.id, r);
    }
    return [...byId.values()].map(toPic);
}

// ─── JSON ───────────────────────────────────────────────────────────────────

/** A line as a writer is shown it (the brief, every log_work answer). */
export interface PictureLineJson {
    _id: string;
    kind: WorkLineKind;
    text: string;
    project: string;
    day: DayString;
    app: string | null;
    /** From a work folder. */
    office?: true;
    /** Close in words to the line just written: "this looks like the same thing". */
    close?: true;
    /** An open line a later done line likely closed, not linked (read time, no AI). */
    likely?: { _id: string; text: string; app: string | null };
}

export interface WorkPictureJson {
    open: PictureLineJson[];
    today: PictureLineJson[];
}

const pictureLine = (l: PicLine, close = false, likely?: PicLine): PictureLineJson => ({
    _id: l.id,
    kind: l.kind,
    text: l.text,
    project: l.project,
    day: l.day,
    app: l.app ?? (l.source === 'summary' ? 'Claude Code' : null),
    ...(l.office ? { office: true as const } : {}),
    ...(close ? { close: true as const } : {}),
    ...(likely ? { likely: { _id: likely.id, text: likely.text, app: likely.app ?? (likely.source === 'summary' ? 'Claude Code' : null) } } : {}),
});

/** A writer's view as JSON; an open line a later done line likely closed says so. */
function pictureJson(v: WriterView, p?: Picture): WorkPictureJson {
    const likely = p ? likelyDone(p) : new Map<string, PicLine>();
    const likelyOf = (l: PicLine) => (p ? likely.get(p.thingOf.get(l.id)?.key ?? '') : undefined);
    return { open: v.open.map((l) => pictureLine(l, false, likelyOf(l))), today: v.day.map((d) => pictureLine(d.line, d.close)) };
}

// ─── The summariser: a personal folder's chat, from their captured words ─────

/** Who a captured piece came from, for its lines' `app`. */
function appOfChunk(chunk: Partial<Pick<BuddyChunk, 'source' | 'via'>>): string {
    if (!chunk.source || chunk.source === 'hook') return 'Claude Code';
    if (chunk.via === 'connector') return 'a connected chat';
    return 'Recollect';
}

/**
 * One piece of a chat the gate marked as work: the session's lines for the day of its last message are rewritten by
 * difference (a line it keeps stays the same row), given what other chats and apps already logged; under the person's
 * lock. Returns how many lines it now has.
 */
export async function summariseWork(
    chunk: Pick<BuddyChunk, 'userId' | 'sessionKey' | 'project' | 'office'> & Partial<Pick<BuddyChunk, 'source' | 'via'>>,
    messages: readonly ChunkMessage[],
    now: Date = new Date()
): Promise<{ lines: number; costUsd: number }> {
    if (!messages.length) return { lines: 0, costUsd: 0 };
    // PERSONAL_OFFICE_PLAN: a study folder is learning, not work: its chats write no work lines (and spend nothing here).
    if ((await folderKindOf(chunk.userId, chunk.project)) === 'study') return { lines: 0, costUsd: 0 };
    const ctx = await loadLearningContext(chunk.userId, now);
    const lastAt = new Date(messages[messages.length - 1]!.at);
    const happenedAt = Number.isNaN(lastAt.getTime()) ? now : lastAt;
    const day = dayOf(happenedAt, ctx.tz);
    const project = (chunk.project ?? '').trim().toLowerCase() || 'other';
    const [soFar, removed, all] = await Promise.all([
        prisma.workLine.findMany({ where: { userId: chunk.userId, sessionKey: chunk.sessionKey, day: toDbDay(day), hidden: false, sameAsId: null }, orderBy: { position: 'asc' } }),
        prisma.workLine.findMany({ where: { userId: chunk.userId, project, hidden: true, day: { gte: toDbDay(addDays(day, -REMOVED_DAYS)) } }, select: { text: true }, take: 40 }),
        loadLines(prisma, chunk.userId, addDays(day < ctx.today ? day : ctx.today, -WRITER_OPEN_DAYS)),
    ]);
    // What its other chats and apps logged (its own lines are in so_far): open things, and that day's lines.
    const mine = new Set(soFar.map((r) => r.id));
    const view = writerView(buildPicture(all.filter((l) => !mine.has(l.id))), { day, today: ctx.today, project, dayMax: 8 });
    const already = [...view.open.map((l) => ({ l, open: true })), ...view.day.map((d) => ({ l: d.line, open: false }))];
    const shown = new Set(already.map((a) => a.l.id));
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
    const message = await callClaude(
        chunk.userId,
        withRefusalFallbacks(
            workRequest({
                project,
                day,
                weekday,
                messages,
                soFar,
                removed: removed.map((r) => r.text),
                already: already.map((a) => ({ id: a.l.id, kind: a.l.kind, text: a.l.text, app: pictureLine(a.l).app, open: a.open && a.l.kind === 'stuck' })),
            })
        ),
        'buddy work'
    );
    const { costUsd } = await recordAiUsage(chunk.userId, 'buddy_work', message);
    const lines = cleanWorkLines(parseJson(responseText(message)), removed.map((r) => r.text));
    const app = appOfChunk(chunk);
    const written = await withPersonLock(chunk.userId, async (tx) => {
        const current = await tx.workLine.findMany({ where: { userId: chunk.userId, sessionKey: chunk.sessionKey, day: toDbDay(day), hidden: false, sameAsId: null }, orderBy: { position: 'asc' } });
        const others = await tx.workLine.findMany({ where: { userId: chunk.userId, day: toDbDay(day), hidden: false, sameAsId: null, sessionKey: { not: chunk.sessionKey } }, select: { kind: true, text: true } });
        // W2: a line another chat already has that day (the same kind, the same words) is not written again.
        const wanted = lines
            .filter((l) => !others.some((o) => o.kind === l.kind && sameWork(o.text, l.text)))
            .map((l) => ({ kind: l.kind, text: l.text, at: null, on: l.on && shown.has(l.on) ? l.on : null, happenedAt }));
        await applyList(tx, { userId: chunk.userId, sessionKey: chunk.sessionKey, day, project, office: chunk.office, source: 'summary', app, current, wanted });
        return wanted.length;
    });
    return { lines: written, costUsd };
}

/**
 * W10: a chat's list for a day written by difference: a line it keeps (the same words, or nearly) stays the same row,
 * so the lines that point at it keep pointing (a changed kind takes the new time); a new one is created; one it no
 * longer lists is deleted only when nothing points at it.
 */
async function applyList(
    tx: TxClient,
    o: {
        userId: string;
        sessionKey: string;
        day: DayString;
        project: string;
        office: boolean;
        source: WorkLineSource;
        app: string;
        current: readonly WorkLine[];
        wanted: ReadonlyArray<{ kind: WorkLineKind; text: string; at: string | null; on: string | null; happenedAt: Date }>;
    }
): Promise<void> {
    const used = new Set<string>();
    // Its own earlier line for the same thing: the same words first, else the closest one (more detail, a new kind):
    // within one chat's own list a loose match only keeps an id; the words written are the new ones either way.
    const ownLine = (text: string): WorkLine | undefined => {
        const free = o.current.filter((r) => !used.has(r.id));
        const exact = free.find((r) => lineKey(r.text) === lineKey(text));
        if (exact) return exact;
        return free
            .filter((r) => sameWork(r.text, text) || closeWork(r.text, text))
            .sort((a, b) => workMatch(b.text, text).ratio - workMatch(a.text, text).ratio)[0];
    };
    for (const [i, w] of o.wanted.entries()) {
        const match = ownLine(w.text);
        if (match) {
            used.add(match.id);
            const follows = w.on && w.on !== match.id && !match.followsId ? w.on : null;
            await tx.workLine.update({
                where: { id: match.id },
                data: {
                    text: w.text,
                    kind: w.kind,
                    at: w.at,
                    position: i,
                    ...(follows ? { followsId: follows } : {}),
                    ...(match.kind !== w.kind || !match.happenedAt ? { happenedAt: w.happenedAt } : {}),
                    ...(match.app ? {} : { app: o.app }),
                },
            });
        } else {
            await tx.workLine.create({
                data: {
                    userId: o.userId,
                    day: toDbDay(o.day),
                    project: o.project,
                    sessionKey: o.sessionKey,
                    kind: w.kind,
                    text: w.text,
                    at: w.at,
                    source: o.source,
                    office: o.office,
                    position: i,
                    app: o.app,
                    happenedAt: w.happenedAt,
                    ...(w.on ? { followsId: w.on } : {}),
                },
            });
        }
    }
    const gone = o.current.filter((r) => !used.has(r.id)).map((r) => r.id);
    if (!gone.length) return;
    const pointing = await tx.workLine.findMany({ where: { OR: [{ followsId: { in: gone } }, { sameAsId: { in: gone } }] }, select: { followsId: true, sameAsId: true } });
    const kept = new Set(pointing.flatMap((p) => [p.followsId, p.sameAsId]).filter((x): x is string => !!x));
    const del = gone.filter((id) => !kept.has(id));
    if (del.length) await tx.workLine.deleteMany({ where: { id: { in: del } } });
}

// ─── A chat's list for a day (Claude Code's log_work; B10) ──────────────────

/** Lines one log_work call may send. */
export const LOG_LINES_MAX = 8;
/** How far back a day may be logged (yesterday's work, the next morning). */
const LOG_DAYS_BACK = 3;

/** "10:15-11:40", "9:05 – 9:50" or "14:00" → "10:15–11:40" / "14:00"; anything else → null. */
export function workSpan(at: string | null | undefined): string | null {
    const m = /^\s*(\d{1,2}):(\d{2})\s*(?:(?:-|–|—|to)\s*(\d{1,2}):(\d{2}))?\s*$/i.exec(at ?? '');
    if (!m) return null;
    const t = (h: string, mm: string) => (Number(h) < 24 && Number(mm) < 60 ? `${Number(h)}:${mm}` : null);
    const a = t(m[1]!, m[2]!);
    const b = m[3] ? t(m[3], m[4]!) : '';
    return a && b !== null ? (b ? `${a}–${b}` : a) : null;
}

/** A local time on a day, as an instant. */
function localTime(day: DayString, hhmm: string, tz: string): Date {
    const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
    const [h, mi] = hhmm.split(':').map(Number) as [number, number];
    return zonedWallTimeToDate(y, mo, d, h, mi, tz);
}

/** W7: when a line happened: the end of its time span on its day; else now (today) or its day's noon. */
function happenedOf(day: DayString, span: string | null, ctx: { today: DayString; tz: string }, now: Date): Date {
    const end = span?.split('–').pop();
    if (end && /^\d{1,2}:\d{2}$/.test(end)) {
        const at = localTime(day, end, ctx.tz);
        return at.getTime() > now.getTime() ? now : at;
    }
    return day === ctx.today ? now : localTime(day, '12:00', ctx.tz);
}

/** A day a writer may log: today by default, up to three days back. */
function logDay(day: string | null | undefined, today: DayString): DayString {
    const d = (day && isValidDay(day) ? day : today) as DayString;
    if (d > today || d < addDays(today, -LOG_DAYS_BACK)) throw new ErrorResponse(400, `Log today's work or up to ${LOG_DAYS_BACK} days back`);
    return d;
}

export interface LogWorkInput {
    /** The chat's key (the MCP makes one per chat): a second call replaces that chat's lines for the day. */
    key: string;
    project: string;
    /** Their local day (YYYY-MM-DD); today by default, at most three days back. */
    day?: string | undefined;
    /** From a work folder (the MCP knows it): only its own project's work brief shows it. */
    office?: boolean | undefined;
    lines: ReadonlyArray<{ kind: WorkLineKind; text: string; at?: string | undefined; on?: string | undefined }>;
    /** The app that wrote it (stage 12). */
    app?: string | undefined;
}

export type LogWorkResult =
    | { status: 'saved'; day: DayString; project: string; saved: number; skipped: number }
    | { status: 'off' }
    | { status: 'paused' };

/**
 * An agent writes a chat's lines for a day (log_work, /log-work): scrubbed, no label, short; a line they removed is
 * not written again (W1); one another chat already logged that day (the same kind and words) is skipped (W2); a line
 * may be news `on` a known one; this chat's lines for the day are rewritten by difference (W10), under the person's
 * lock. Needs the work log on and the buddy not paused.
 */
export async function logWork(userId: string, input: LogWorkInput, now: Date = new Date()): Promise<LogWorkResult> {
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { workLog: true, paused: true } });
    if (!state?.workLog) return { status: 'off' };
    if (state.paused) return { status: 'paused' };
    const ctx = await loadLearningContext(userId, now);
    const day = logDay(input.day, ctx.today);
    const project = input.project.trim().toLowerCase().slice(0, 100) || 'other';
    const app = (input.app ?? '').trim().slice(0, 60) || 'an agent';
    // A folder the server knows as work is office work, whatever the chat said (PERSONAL_OFFICE_PLAN).
    const office = await officeFolder(userId, project, input.office);
    const result = await withPersonLock(userId, async (tx) => {
        const [removed, others, current] = await Promise.all([
            tx.workLine.findMany({ where: { userId, hidden: true, day: { gte: toDbDay(addDays(day, -REMOVED_DAYS)) } }, select: { text: true }, take: 200 }),
            tx.workLine.findMany({ where: { userId, day: toDbDay(day), hidden: false, sameAsId: null, sessionKey: { not: input.key } }, select: { kind: true, text: true } }),
            tx.workLine.findMany({ where: { userId, sessionKey: input.key, day: toDbDay(day), hidden: false, sameAsId: null }, orderBy: { position: 'asc' } }),
        ]);
        const ons = await targetsOf(tx, userId, input.lines.map((l) => l.on).filter((x): x is string => !!x?.trim()));
        const wanted: Array<{ kind: WorkLineKind; text: string; at: string | null; on: string | null; happenedAt: Date }> = [];
        let skipped = 0;
        for (const l of input.lines.slice(0, LOG_LINES_MAX)) {
            const text = oneLine(unlabel(scrubSecrets(l.text)), WORK_LINE_MAX);
            if (
                !lineKey(text) ||
                removed.some((r) => sameWork(r.text, text)) ||
                others.some((x) => x.kind === l.kind && sameWork(x.text, text)) ||
                wanted.some((k) => sameWork(k.text, text))
            ) {
                skipped++;
                continue;
            }
            const at = workSpan(l.at);
            const target = l.on ? ons.get(l.on.trim()) : undefined;
            wanted.push({ kind: l.kind, text, at, on: target?.id ?? null, happenedAt: happenedOf(day, at, ctx, now) });
        }
        await applyList(tx, { userId, sessionKey: input.key, day, project, office, source: 'agent', app, current, wanted });
        return { saved: wanted.length, skipped };
    });
    if (result.saved) await bumpDay(userId, ctx.today, { work: result.saved });
    return { status: 'saved', day, project, ...result };
}

/** The visible lines named by ids (a repeat resolves to the line it repeats), by the id as given. */
async function targetsOf(db: DbClient, userId: string, ids: readonly string[]): Promise<Map<string, WorkLine>> {
    const out = new Map<string, WorkLine>();
    for (const given of [...new Set(ids.map((i) => i.trim()))].slice(0, LOG_LINES_MAX)) {
        let id = given;
        for (let i = 0; i < 10; i++) {
            const row = await db.workLine.findFirst({ where: { id, userId } });
            if (!row || row.hidden) break;
            if (row.sameAsId) {
                id = row.sameAsId;
                continue;
            }
            out.set(given, row);
            break;
        }
    }
    return out;
}

// ─── One outcome (claude.ai and ChatGPT's log_work; stage 12) ───────────────

/**
 * W8: new lines a day per account from the web door (the live hour, 11-20: 12 refused a real fix on a busy test day,
 * leaving its open line open). A line that is news `on` a known line never counts against it.
 */
export const WEB_LINES_PER_DAY = 30;
/** A web line's own key (one per line). */
export const WEB_KEY_PREFIX = 'w_';
export const LINE_KINDS = ['did', 'decided', 'stuck'] as const;

export interface LineInput {
    text: string;
    kind: (typeof LINE_KINDS)[number];
    project?: string | undefined;
    /** The line this one is news on (an open problem now fixed, a decision changed). */
    on?: string | undefined;
    day?: string | undefined;
    /**
     * Stage 13: the other results of the same message (the live hour, 11-20: two fixes in one message were logged as
     * one line or none). Written after the first, in order, under the same lock; the project and the day are the first's.
     */
    more?: ReadonlyArray<{ text: string; kind?: (typeof LINE_KINDS)[number] | undefined; on?: string | undefined }> | undefined;
}

/** Stage 13: at most this many further results ride with the first in one call. */
export const LINE_MORE_MAX = 2;

/** What happened to one line of a call (stage 13): `empty` when nothing was left once secrets were taken out. */
export interface LineOutcome {
    status: 'saved' | 'already' | 'removed' | 'full' | 'empty';
    line: PictureLineJson | null;
    follows?: PictureLineJson | null;
    onMissing?: true;
}

/**
 * The first line's outcome at the top level (as before stage 13, so an older MCP build reads it unchanged); with
 * `more`, also `lines` (every line's outcome, in order) and the picture after all of them.
 */
export type LogLineResult =
    | { status: 'saved'; line: PictureLineJson; follows: PictureLineJson | null; onMissing?: true; picture: WorkPictureJson; lines?: LineOutcome[] }
    /** W2: that day already has it (null when it is a work folder's line this chat may not see). */
    | { status: 'already'; line: PictureLineJson | null; picture: WorkPictureJson; lines?: LineOutcome[] }
    /** W1: they removed a line that says the same. */
    | { status: 'removed'; picture?: WorkPictureJson; lines?: LineOutcome[] }
    /** W8: the day's web lines are used up. */
    | { status: 'full'; picture: WorkPictureJson; lines?: LineOutcome[] }
    | { status: 'off' }
    | { status: 'paused' };

const newWebKey = () => `${WEB_KEY_PREFIX}${randomBytes(9).toString('base64url')}`;

/** The project names a writer may reuse: those of its picture, the most recent first. */
function recentProjects(lines: readonly PicLine[], max: number): string[] {
    const latest = new Map<string, number>();
    for (const l of lines) if (isVisible(l)) latest.set(l.project, Math.max(latest.get(l.project) ?? 0, l.happenedAt.getTime()));
    return [...latest.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([p]) => p)
        .filter((p) => p !== 'other')
        .slice(0, max);
}

/**
 * One outcome from a connected chat (W1-W9): written at once unless they removed the same line, that day already has
 * it, or the day's lines are used up; `on` makes it news on a known line (its project then is that line's). The answer
 * carries the picture (W5): what is open and the day's other lines, a line close in words first. Under the lock.
 */
export async function logLine(userId: string, writer: { app: string }, input: LineInput, now: Date = new Date()): Promise<LogLineResult> {
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { workLog: true, paused: true, shareOfficeWork: true } });
    if (!state?.workLog) return { status: 'off' };
    if (state.paused) return { status: 'paused' };
    const ctx = await loadLearningContext(userId, now);
    const day = logDay(input.day, ctx.today);
    const clean = (t: string) => oneLine(unlabel(scrubSecrets(t)), WORK_LINE_MAX);
    // The first line, then the other results of the same message (stage 13), each with its own kind and `on`.
    const asked = [{ text: input.text, kind: input.kind, on: input.on }, ...(input.more ?? []).slice(0, LINE_MORE_MAX).map((m) => ({ text: m.text, kind: m.kind ?? 'did', on: m.on }))].map((l) => ({ ...l, text: clean(l.text) }));
    if (!lineKey(asked[0]!.text)) throw new ErrorResponse(400, 'Nothing left to log once secrets are taken out');
    const several = asked.length > 1;
    const door: Seen = { kind: 'connected', share: state.shareOfficeWork };
    const happenedAt = happenedOf(day, null, ctx, now);
    const startOfToday = localTime(ctx.today, '00:00', ctx.tz);
    const removedFrom = addDays(ctx.today, -REMOVED_DAYS);
    const result = await withPersonLock(userId, async (tx): Promise<{ outcomes: LineOutcome[]; picture: WorkPictureJson; saved: number }> => {
        // Lines written by this call join the picture at once, so a later line of the same message sees the earlier.
        const all = await loadLines(tx, userId, addDays(day < ctx.today ? day : ctx.today, -PICTURE_DAYS));
        const seen = all.filter((l) => seenBy(door, l));
        const outcomes: LineOutcome[] = [];
        const shown: string[] = [];
        let project: string | undefined;
        let saved = 0;
        for (const one of asked) {
            const text = one.text;
            if (!lineKey(text)) {
                outcomes.push({ status: 'empty', line: null });
                continue;
            }
            // W1: a line they removed.
            if (all.some((l) => l.hidden && l.day >= removedFrom && sameWork(l.text, text))) {
                outcomes.push({ status: 'removed', line: null });
                continue;
            }
            // The line it is news on (a repeat counts as the line it repeats); one it may not see, or gone, is no target.
            let target: PicLine | null = null;
            let onMissing = false;
            if (one.on?.trim()) {
                const found = (await targetsOf(tx, userId, [one.on])).get(one.on.trim());
                const asPic = found ? (all.find((l) => l.id === found.id) ?? toPic(found)) : null;
                if (asPic && seenBy(door, asPic)) target = asPic;
                else onMissing = true;
            }
            // W2: that day already has it (the same kind and words), whichever app wrote it; or it repeats its own target.
            const dup =
                (target && target.kind === one.kind && sameWork(target.text, text) ? target : null) ??
                all.find((l) => isVisible(l) && l.day === day && l.kind === one.kind && sameWork(l.text, text)) ??
                null;
            if (dup) {
                shown.push(dup.id);
                outcomes.push({ status: 'already', line: seenBy(door, dup) ? pictureLine(dup) : null });
                continue;
            }
            // W8: the day's web lines (each line of a call counts; news on a known line never does).
            const todays = target ? 0 : await tx.workLine.count({ where: { userId, sessionKey: { startsWith: WEB_KEY_PREFIX }, createdAt: { gte: startOfToday }, followsId: null } });
            if (todays >= WEB_LINES_PER_DAY) {
                outcomes.push({ status: 'full', line: null });
                continue;
            }
            const lineProject = target ? target.project : matchProject(input.project, recentProjects(seen, 50));
            const row = await tx.workLine.create({
                data: {
                    userId,
                    day: toDbDay(day),
                    project: lineProject,
                    sessionKey: newWebKey(),
                    kind: one.kind,
                    source: 'agent',
                    app: writer.app.slice(0, 60),
                    text,
                    office: false,
                    position: 0,
                    happenedAt,
                    ...(target ? { followsId: target.id } : {}),
                },
                select: PIC_SELECT,
            });
            const line = toPic(row);
            all.push(line);
            seen.push(line);
            shown.push(line.id);
            project ??= lineProject;
            saved++;
            outcomes.push({ status: 'saved', line: pictureLine(line), follows: target ? pictureLine(target) : null, ...(onMissing ? { onMissing: true as const } : {}) });
        }
        // The picture once, after every line: what this call wrote or found is not shown back; a line close to any of them first.
        const p = buildPicture(seen);
        const words = asked.map((l) => l.text).join(' ');
        return { outcomes, picture: pictureJson(writerView(p, { day, today: ctx.today, text: words, exclude: shown, project: project ?? null }), p), saved };
    });
    if (result.saved) await bumpDay(userId, ctx.today, { work: result.saved });
    const first = result.outcomes[0]!;
    const lines = several ? { lines: result.outcomes } : {};
    switch (first.status) {
        case 'saved':
            return { status: 'saved', line: first.line!, follows: first.follows ?? null, ...(first.onMissing ? { onMissing: true as const } : {}), picture: result.picture, ...lines };
        case 'already':
            return { status: 'already', line: first.line, picture: result.picture, ...lines };
        case 'removed':
            return { status: 'removed', ...(several ? { picture: result.picture, lines: result.outcomes } : {}) };
        default:
            return { status: 'full', picture: result.picture, ...lines };
    }
}

/** Whether a line's chain (followsId upwards, repeats folded) passes through `id`. */
function reaches(from: PicLine, id: string, byId: ReadonlyMap<string, PicLine>): boolean {
    let cur: string | null = resolveId(from.id, byId);
    const seen = new Set<string>();
    for (let i = 0; cur && i < 50 && !seen.has(cur); i++) {
        if (cur === id) return true;
        seen.add(cur);
        const l = byId.get(cur);
        cur = l?.followsId ? resolveId(l.followsId, byId) : null;
    }
    return false;
}

/** What the writing app may do to its own line (W6). */
export type LineChange = { sameAs: string } | { text: string } | { remove: true } | { on: string };

export type ChangeLineResult =
    | { status: 'joined'; line: PictureLineJson; into: PictureLineJson; picture: WorkPictureJson }
    | { status: 'reworded'; line: PictureLineJson }
    | { status: 'linked'; line: PictureLineJson; follows: PictureLineJson; picture: WorkPictureJson }
    | { status: 'removed' }
    | { status: 'off' }
    | { status: 'paused' };

/**
 * W6: an app folds its own line into another (a repeat it saw only after writing), rewords it the same day, makes it
 * news on a known line, or removes it on the person's word (hidden, as their own removal). Never another app's line.
 */
export async function changeLine(userId: string, writer: { app: string }, id: string, change: LineChange, now: Date = new Date()): Promise<ChangeLineResult> {
    const state = await prisma.buddyState.findUnique({ where: { userId }, select: { workLog: true, paused: true, shareOfficeWork: true } });
    if (!state?.workLog) return { status: 'off' };
    if (state.paused) return { status: 'paused' };
    const ctx = await loadLearningContext(userId, now);
    const door: Seen = { kind: 'connected', share: state.shareOfficeWork };
    return withPersonLock(userId, async (tx): Promise<ChangeLineResult> => {
        const row = await tx.workLine.findFirst({ where: { id, userId }, select: PIC_SELECT });
        if (!row) throw new ErrorResponse(404, 'Nothing in their work log with that id');
        if (row.source !== 'agent' || (row.app ?? '') !== writer.app.slice(0, 60)) {
            throw new ErrorResponse(403, `Only the app that wrote a line can change it; this one came from ${row.app ?? (row.source === 'summary' ? 'Claude Code' : 'another app')}. The person can remove it on /you.`);
        }
        if (row.hidden) throw new ErrorResponse(409, 'That line was removed');
        const line = toPic(row);
        if ('remove' in change) {
            await tx.workLine.update({ where: { id }, data: { hidden: true } });
            return { status: 'removed' };
        }
        if ('text' in change) {
            if (line.day !== ctx.today) throw new ErrorResponse(409, "Only today's lines can be reworded");
            const text = oneLine(unlabel(scrubSecrets(change.text)), WORK_LINE_MAX);
            if (!lineKey(text)) throw new ErrorResponse(400, 'Nothing left once secrets are taken out');
            const updated = await tx.workLine.update({ where: { id }, data: { text }, select: PIC_SELECT });
            return { status: 'reworded', line: pictureLine(toPic(updated)) };
        }
        const otherId = 'sameAs' in change ? change.sameAs : change.on;
        const all = await loadLines(tx, userId, addDays(ctx.today, -PICTURE_DAYS));
        const found = (await targetsOf(tx, userId, [otherId])).get(otherId.trim());
        const other = found ? (all.find((l) => l.id === found.id) ?? toPic(found)) : null;
        if (!other || !seenBy(door, other)) throw new ErrorResponse(404, 'Nothing in their work log with that id');
        const byId = new Map(all.map((l) => [l.id, l] as const));
        byId.set(line.id, line);
        byId.set(other.id, other);
        // Never a loop: the other line may not be this one, nor (for `on`) a line that is already news on this one.
        if (other.id === line.id || ('on' in change && reaches(other, line.id, byId))) throw new ErrorResponse(409, 'That line is this one, or news on it already');
        if ('sameAs' in change) {
            await tx.workLine.update({ where: { id }, data: { sameAsId: other.id } });
            const after = buildPicture(all.filter((l) => seenBy(door, l)).map((l) => (l.id === id ? { ...l, sameAsId: other.id } : l)));
            return { status: 'joined', line: pictureLine(line), into: pictureLine(other), picture: pictureJson(writerView(after, { day: line.day, today: ctx.today, exclude: [other.id] }), after) };
        }
        const updated = await tx.workLine.update({ where: { id }, data: { followsId: other.id, project: other.project }, select: PIC_SELECT });
        const after = buildPicture(all.filter((l) => seenBy(door, l)).map((l) => (l.id === id ? toPic(updated) : l)));
        return { status: 'linked', line: pictureLine(toPic(updated)), follows: pictureLine(other), picture: pictureJson(writerView(after, { day: line.day, today: ctx.today, exclude: [id] }), after) };
    });
}

// ─── Reading it: one reader behind every surface ────────────────────────────

export type WorkView = 'all' | 'done' | 'decided' | 'open';
/** The open view also shows what was open and got closed in these last days (marked with what closed it). */
const CLOSED_LATELY_DAYS = 7;
export const WORK_VIEWS = ['all', 'done', 'decided', 'open'] as const;

export interface WorkLineJson {
    _id: string;
    kind: WorkLineKind;
    text: string;
    /** The time it took, when an agent logged it from the hook's clock ("10:15–11:40"). */
    at: string | null;
    /** summary: from their captured words; agent: logged by a chat (B10, stage 12). */
    source: WorkLineSource;
    /** The app that wrote it (stage 12; null on older lines). */
    app: string | null;
    /** What came after it on a later day: an open problem fixed, a decision changed (stage 12). */
    later: { kind: WorkLineKind; day: DayString; text: string; word: LaterWord } | null;
    /**
     * The line of its thing just before it (the open problem it fixes, the decision it changed), so a question about
     * the earlier words ("anything from the review still open?") finds them; in the decided view, the decision it changed.
     */
    was: { text: string; day: DayString; kind: WorkLineKind; app: string | null } | null;
    /** An open line a later done line likely closed, not linked (read time, no AI): "likely done". */
    likely: { _id: string; text: string; day: DayString; app: string | null } | null;
}

/** A line's kind as a label ("Open: "), left out when its words already say it ("Decided to keep…"). */
export function kindLabel(kind: WorkLineKind | undefined, text: string): string {
    const label = kind === 'decided' ? 'Decided' : kind === 'stuck' ? 'Open' : kind === 'next' ? 'Next' : '';
    if (!label) return '';
    const says = kind === 'stuck' ? /^(open|stuck|still)\b/i : new RegExp(`^${label}\\b`, 'i');
    return says.test(text.trim()) ? '' : `${label}: `;
}

/** A line as briefs and the night read it: its time, its kind, its words, and what came after it. */
export const workLineText = (l: { text: string; kind?: WorkLineKind; at?: string | null; later?: WorkLineJson['later'] }): string => {
    const label = kindLabel(l.kind, l.text);
    const later = l.later ? ` (${l.later.word} ${l.later.day})` : '';
    return `${l.at ? `${l.at} ` : ''}${label}${l.text}${later}`;
};

export interface WorkProjectJson {
    project: string;
    /** From a folder that never gets their brief. */
    office: boolean;
    /** The time Claude Code logged in that project that day (its sessions). */
    minutes: number;
    sessions: number;
    /** Commit subjects from those sessions (10 at most). */
    commits: string[];
    lines: WorkLineJson[];
}

export interface WorkDayJson {
    day: DayString;
    projects: WorkProjectJson[];
}

export interface WorkQuery {
    project?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    q?: string | undefined;
    limit?: number | undefined;
    view?: WorkView | undefined;
}

const appOf = (l: PicLine): string | null => l.app ?? (l.source === 'summary' ? 'Claude Code' : null);

function lineJson(l: PicLine, p: Picture, decidedWas?: PicLine | null, likely?: ReadonlyMap<string, PicLine>): WorkLineJson {
    const later = laterOf(l, p);
    // The line just before it in its thing (the decided view passes the decision it changed).
    const lines = p.thingOf.get(l.id)?.lines ?? [];
    const before = decidedWas !== undefined ? decidedWas : (lines[lines.findIndex((x) => x.id === l.id) - 1] ?? null);
    return {
        _id: l.id,
        kind: l.kind,
        text: l.text,
        at: l.at ?? null,
        source: l.source,
        app: appOf(l),
        later: later ? { kind: later.kind, day: later.day, text: later.text, word: laterWord(l.kind, later.kind) } : null,
        was: before ? { text: before.text, day: before.day, kind: before.kind, app: appOf(before) } : null,
        likely: (() => {
            const t = p.thingOf.get(l.id);
            const hit = t && t.newest.id === l.id ? likely?.get(t.key) : undefined;
            return hit ? { _id: hit.id, text: hit.text, day: hit.day, app: appOf(hit) } : null;
        })(),
    };
}

/** The lines a search finds (ids and days), the newest day first. */
async function searchIds(userId: string, q: string, limit: number): Promise<Array<{ id: string; day: DayString }>> {
    const terms = searchTerms(q.slice(0, 200));
    if (!terms.length) return [];
    const query = Prisma.join(
        terms.map((t) => Prisma.sql`(to_tsquery('english', ${t}) || to_tsquery('simple', ${`${t}:*`}))`),
        ' && '
    );
    const rows = await prisma.$queryRaw<Array<{ id: string; day: Date }>>`
        WITH q AS (SELECT ${query} AS "query")
        SELECT w."id", w."day" FROM "WorkLine" w, q
        WHERE w."userId" = ${userId} AND w."hidden" = FALSE AND w."sameAsId" IS NULL AND w."searchVector" @@ q."query"
        ORDER BY w."day" DESC, ts_rank(w."searchVector", q."query") DESC
        LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, day: fromDbDay(r.day) }));
}

/**
 * Their work as one picture (stage 12), newest day first: per day and project, one entry per thing (that day's newest
 * line, with what came after it), the time and the commits. `view`: all (the days from `from` to `to`, the last 7 by
 * default, 31 at most), done, decided (each decision at its newest state), open (what is still open, 30 days). `q`
 * searches the lines' words. `door`: who reads (a connected chat sees a work folder's lines only while they are shared).
 */
export async function listWork(userId: string, query: WorkQuery = {}, door: WorkDoor = 'app', now: Date = new Date()): Promise<WorkDayJson[]> {
    const ctx = await loadLearningContext(userId, now);
    const view: WorkView = query.view ?? 'all';
    const to = query.to && isValidDay(query.to) ? (query.to as DayString) : ctx.today;
    let from = query.from && isValidDay(query.from) ? (query.from as DayString) : addDays(to, -6);
    if (from < addDays(to, -30)) from = addDays(to, -30);
    const project = query.project?.trim().toLowerCase() || null;
    const limit = Math.min(Math.max(1, query.limit ?? 200), 500);
    const seen = await seenFor(userId, door);
    const q = (query.q ?? '').trim();
    const found = q ? await searchIds(userId, q, limit) : null;
    if (found && !found.length) return [];

    // The picture from the earliest day asked for (30 days at least, so open things and their chains are whole).
    const earliest = [view === 'open' ? null : from, addDays(ctx.today, -PICTURE_DAYS), ...(found ?? []).map((f) => f.day)].filter((d): d is DayString => !!d).sort()[0]!;
    const all = await loadLines(prisma, userId, earliest);
    const pic = buildPicture(all.filter((l) => seenBy(seen, l)));
    const likely = likelyDone(pic);
    const inProject = (l: PicLine) => !project || l.project === project;

    let shown: Array<{ line: PicLine; was?: PicLine | null }>;
    if (found) {
        // A search: the lines it found, one per thing and day (the newest).
        const hit = new Set(found.map((f) => f.id));
        const best = new Map<string, PicLine>();
        for (const t of pic.things) {
            for (const l of t.lines) {
                if (!hit.has(l.id) || !inProject(l)) continue;
                const k = `${t.key}|${l.day}`;
                const cur = best.get(k);
                if (!cur || byHappened(cur, l) < 0) best.set(k, l);
            }
        }
        shown = [...best.values()].map((line) => ({ line }));
    } else if (view === 'open') {
        // What is still open, and what was open and closed in the last 7 days (at its open line, with what closed it),
        // so "is anything from the review still open?" finds the review's finding and sees it fixed.
        const closedFrom = addDays(ctx.today, -CLOSED_LATELY_DAYS);
        const closed = pic.things
            .filter((t) => t.newest.kind !== 'stuck' && t.newest.day >= closedFrom && t.lines.some((l) => l.kind === 'stuck'))
            .map((t) => t.lines.filter((l) => l.kind === 'stuck').pop()!);
        shown = [...openThings(pic, ctx.today).map((t) => t.newest), ...closed].filter(inProject).map((line) => ({ line }));
    } else if (view === 'decided') {
        shown = decisionsOf(pic).filter((d) => inProject(d.line) && d.line.day >= from && d.line.day <= to);
    } else {
        shown = [];
        for (let d = to; d >= from; d = addDays(d, -1)) {
            for (const line of dayLines(pic, d)) if (inProject(line) && (view !== 'done' || line.kind === 'did')) shown.push({ line });
        }
    }
    shown = shown.sort((a, b) => (a.line.day < b.line.day ? 1 : a.line.day > b.line.day ? -1 : byHappened(b.line, a.line))).slice(0, limit);
    const days = [...new Set(shown.map((s) => s.line.day))].sort().reverse();
    if (!days.length) return [];
    // The time and commits of those days' sessions, by project.
    const sessions = await prisma.workSession.findMany({
        where: { userId, day: { in: days.map(toDbDay) }, project: project ? { key: project } : { isNot: null } },
        select: { day: true, minutes: true, details: true, project: { select: { key: true } } },
    });
    return days.map((day) => {
        const here = shown.filter((s) => s.line.day === day).sort((a, b) => byHappened(a.line, b.line));
        const projects = [...new Set(here.map((s) => s.line.project))].sort();
        return {
            day,
            projects: projects.map((p) => {
                const lines = here.filter((s) => s.line.project === p);
                const s = sessions.filter((x) => fromDbDay(x.day) === day && x.project?.key === p);
                const commits = s.flatMap((x) => {
                    const c = (x.details as { commits?: unknown } | null)?.commits;
                    return Array.isArray(c) ? c.filter((v): v is string => typeof v === 'string') : [];
                });
                return {
                    project: p,
                    office: lines.some((l) => l.line.office),
                    minutes: s.reduce((a, x) => a + (x.minutes ?? 0), 0),
                    sessions: s.length,
                    commits: [...new Set(commits)].slice(0, 10),
                    lines: lines.map((l) => lineJson(l.line, pic, view === 'decided' ? (l.was ?? null) : undefined, likely)),
                };
            }),
        };
    });
}

/** They remove a line: hidden, kept so no writer ever writes it again. */
export async function hideWorkLine(userId: string, id: string): Promise<{ hidden: true }> {
    const r = await prisma.workLine.updateMany({ where: { id, userId }, data: { hidden: true } });
    if (!r.count) throw notFound();
    return { hidden: true };
}

/** What a writer is shown (W5) for a day: what is open and that day's lines, by who reads (Claude Code's log_work). */
export async function workPicture(userId: string, options: { day?: string | undefined; project?: string | undefined; door: WorkDoor }, now: Date = new Date()): Promise<WorkPictureJson | null> {
    if (!(await workLogOn(userId))) return null;
    const ctx = await loadLearningContext(userId, now);
    const day = options.day && isValidDay(options.day) && options.day <= ctx.today ? (options.day as DayString) : ctx.today;
    const seen = await seenFor(userId, options.door);
    const all = await loadLines(prisma, userId, addDays(day < ctx.today ? day : ctx.today, -PICTURE_DAYS));
    const pic = buildPicture(all.filter((l) => seenBy(seen, l)));
    return pictureJson(writerView(pic, { day, today: ctx.today, project: options.project?.trim().toLowerCase() || null }), pic);
}

/** The web brief's work part (stage 12): what is open (3), what was logged today (4), the project names (6). */
export interface WebWorkBrief {
    open: PictureLineJson[];
    today: PictureLineJson[];
    projects: string[];
}

export async function workForWebBrief(userId: string, now: Date = new Date()): Promise<WebWorkBrief | null> {
    if (!(await workLogOn(userId))) return null;
    const ctx = await loadLearningContext(userId, now);
    const seen = await seenFor(userId, 'connected');
    const lines = (await loadLines(prisma, userId, addDays(ctx.today, -PICTURE_DAYS))).filter((l) => seenBy(seen, l));
    const pic = buildPicture(lines);
    const v = writerView(pic, { day: ctx.today, today: ctx.today, openMax: 3, dayMax: 4 });
    const short = (t: string) => (t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t);
    const cut = (l: PictureLineJson): PictureLineJson => ({ ...l, text: short(l.text), ...(l.likely ? { likely: { ...l.likely, text: short(l.likely.text) } } : {}) });
    const j = pictureJson(v, pic);
    return { open: j.open.map(cut), today: j.today.map(cut), projects: recentProjects(lines, 6) };
}

/** The brief's part: a work folder's own project, its last three days with lines; else yesterday across projects (five lines). */
export interface WorkBrief {
    days: Array<{ day: DayString; projects: Array<{ project: string; minutes: number; lines: string[] }> }>;
}

export async function workForBrief(userId: string, options: { project?: string | undefined; work?: boolean | undefined }, now: Date = new Date()): Promise<WorkBrief | null> {
    if (!(await workLogOn(userId))) return null;
    const ctx = await loadLearningContext(userId, now);
    if (options.work) {
        const project = options.project?.trim().toLowerCase();
        if (!project) return null;
        const recent = await prisma.workLine.findMany({ where: { userId, project, hidden: false, sameAsId: null, day: { gte: toDbDay(addDays(ctx.today, -30)) } }, distinct: ['day'], orderBy: { day: 'desc' }, select: { day: true }, take: 3 });
        if (!recent.length) return null;
        const days = recent.map((r) => fromDbDay(r.day));
        const list = await listWork(userId, { project, from: days[days.length - 1], to: days[0] }, { folder: project }, now);
        return { days: list.map((d) => ({ day: d.day, projects: d.projects.map((p) => ({ project: p.project, minutes: p.minutes, lines: p.lines.map(workLineText) })) })) };
    }
    const yesterday = addDays(ctx.today, -1);
    const list = await listWork(userId, { from: yesterday, to: yesterday }, 'connected', now);
    if (!list.length) return null;
    let left = 5;
    const projects = list[0]!.projects
        .map((p) => {
            const lines = p.lines.slice(0, left).map(workLineText);
            left -= lines.length;
            return { project: p.project, minutes: p.minutes, lines };
        })
        .filter((p) => p.lines.length);
    return { days: [{ day: yesterday, projects }] };
}

// ─── The night settles what the writers left open (stage 12, after the live hour) ───

export const SETTLE_MODEL = process.env['BUDDY_SETTLE_MODEL'] || 'claude-haiku-5-5';
export const SETTLE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['pairs'],
    properties: { pairs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'verdict'], properties: { n: { type: 'integer' }, verdict: { type: 'string', enum: ['closes', 'same', 'different'] } } } } },
};
export const SETTLE_SYSTEM = `You keep a person's work log consistent. Several chats and apps log their work, and sometimes an open problem stays open after it was fixed, or the same open problem is logged twice in other words. Each numbered pair below is an open problem and a later line of the same project. Answer for each: "closes" when the later line fixes, resolves or ends that open problem; "same" when the later line is the same open problem again; "different" when it is another thing, or you are not sure. Say "closes" or "same" only when the words clearly show it.`;

/** At most this many pairs a night (the oldest open problems first). */
const SETTLE_PAIRS_MAX = 24;

/**
 * Where the account has AI, the night settles what the writers left open (the live hour: a fix logged without `on`, an
 * open problem logged twice): each open thing of the last 7 days is paired with the later lines of its project (done
 * lines and other open lines), the model judges each pair, and code links a fix to the open line (`followsId`: closed)
 * or folds the later copy of an open problem into the earlier (`sameAsId`). A pair the model doesn't call clear is left.
 */
export async function settleWork(userId: string, now: Date = new Date()): Promise<{ linked: number; folded: number; costUsd: number }> {
    const none = { linked: 0, folded: 0, costUsd: 0 };
    if (!(await workLogOn(userId))) return none;
    const ctx = await loadLearningContext(userId, now);
    const pic = buildPicture(await loadLines(prisma, userId, addDays(ctx.today, -7)));
    const pairs: Array<{ open: PicLine; other: PicLine }> = [];
    for (const t of pic.things.filter((x) => x.newest.kind === 'stuck').sort((a, b) => byHappened(a.newest, b.newest))) {
        for (const u of pic.things) {
            if (u === t || u.newest.project !== t.newest.project || byHappened(u.newest, t.newest) <= 0) continue;
            if (u.newest.kind === 'did' || u.newest.kind === 'stuck') pairs.push({ open: t.newest, other: u.newest });
        }
    }
    const asked = pairs.slice(0, SETTLE_PAIRS_MAX);
    if (!asked.length) return none;
    const text = asked.map((x, i) => `${i + 1}. open: ${x.open.text}\n   later (${x.other.kind === 'stuck' ? 'open' : 'done'}): ${x.other.text}`).join('\n');
    const message = await callClaude(
        userId,
        withRefusalFallbacks({
            model: SETTLE_MODEL,
            max_tokens: 2000,
            output_config: { effort: 'high', format: { type: 'json_schema', schema: SETTLE_SCHEMA } },
            system: [{ type: 'text', text: SETTLE_SYSTEM, cache_control: EPHEMERAL }],
            messages: [{ role: 'user', content: [{ type: 'text', text: `<pairs>\n${text}\n</pairs>` }] }],
        } as CreateParams),
        'buddy work settle'
    );
    const { costUsd } = await recordAiUsage(userId, 'buddy_work', message);
    const parsed = z.object({ pairs: z.array(z.object({ n: z.number().int(), verdict: z.enum(['closes', 'same', 'different']) })) }).safeParse(parseJson(responseText(message)));
    if (!parsed.success) return { ...none, costUsd };
    let linked = 0;
    let folded = 0;
    await withPersonLock(userId, async (tx) => {
        const settled = new Set<string>();
        for (const v of parsed.data.pairs) {
            const x = asked[v.n - 1];
            if (!x || v.verdict === 'different' || settled.has(x.open.id) || settled.has(x.other.id)) continue;
            const row = await tx.workLine.findFirst({ where: { id: x.other.id, userId, hidden: false, sameAsId: null }, select: { followsId: true, kind: true } });
            if (!row) continue;
            if (v.verdict === 'closes' && row.kind === 'did' && !row.followsId) {
                await tx.workLine.update({ where: { id: x.other.id }, data: { followsId: x.open.id } });
                linked++;
            } else if (v.verdict === 'closes' && row.kind === 'did' && row.followsId) {
                // The fix already closed another open line: the two open lines were one problem (the relay's miss); the later folds into the earlier.
                const target = await tx.workLine.findFirst({ where: { id: row.followsId, userId, kind: 'stuck', hidden: false, sameAsId: null }, select: { id: true, happenedAt: true, createdAt: true } });
                if (!target || target.id === x.open.id) continue;
                const targetAt = (target.happenedAt ?? target.createdAt).getTime();
                const [later, earlier] = targetAt >= x.open.happenedAt.getTime() ? [target.id, x.open.id] : [x.open.id, target.id];
                await tx.workLine.update({ where: { id: later }, data: { sameAsId: earlier } });
                folded++;
            } else if (v.verdict === 'same' && row.kind === 'stuck') {
                // The later copy folds into the earlier; a fix linked to the copy then counts on the earlier one.
                await tx.workLine.update({ where: { id: x.other.id }, data: { sameAsId: x.open.id } });
                folded++;
            } else continue;
            settled.add(x.open.id);
            settled.add(x.other.id);
        }
    });
    return { linked, folded, costUsd };
}

/** The night's view of their last day's work (per project: time and lines, one per thing; office ones marked), or null. */
export async function workForNight(userId: string, today: DayString, now: Date = new Date()): Promise<{ text: string; lines: string[] } | null> {
    if (!(await workLogOn(userId))) return null;
    const list = await listWork(userId, { from: addDays(today, -1), to: addDays(today, -1) }, 'app', now);
    if (!list.length) return null;
    const lines = list[0]!.projects.flatMap((p) => p.lines.map((l) => l.text));
    const text = list[0]!.projects
        .map((p) => `${p.project}${p.office ? ' (office)' : ''} · ${p.minutes} min\n${p.lines.map((l) => `- ${l.kind}${l.at ? ` (${l.at})` : ''}: ${l.text}${l.later ? ` (${l.later.word} ${l.later.day})` : ''}`).join('\n')}`)
        .join('\n');
    return { text, lines };
}
