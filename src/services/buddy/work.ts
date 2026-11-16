// The work log (BUDDY_MEMORY_PLAN §11.2, B9): what he did, per project and day, office work too, so
// "what did I do on the ERP yesterday?" has an answer before a standup. A store apart from the memory
// about him: dated lines that never fade, never become memories or the portrait, and never reach the
// lock screen (the night's lock check treats them as private). The gate's `work` label sends a piece
// of a chat here; the summariser (Sonnet 5.5) rewrites that session's lines for the day. A line he
// removes stays as a hidden row, so it is never written again.
//
//   GET    /api/buddy/work?project=&from=&to=&q=&limit=&work=1   read (cookie or token)
//   DELETE /api/buddy/work/:id                                     cookie only: hides a line
import { Prisma, type BuddyChunk, type WorkLine, type WorkLineKind } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db/prisma';
import { callClaude } from '../claude/client';
import { recordAiUsage } from '../claude/usage.service';
import { parseJson, responseText } from '../recall/output';
import { withRefusalFallbacks, type CreateParams } from '../recall/prompts';
import { addDays, isValidDay, type DayString } from '../learning';
import { dayOf } from '../learning/time';
import { notFound } from '../learning/http';
import { fromDbDay, loadLearningContext, toDbDay } from '../learningDb/common';
import { searchTerms } from '../docs/docSearch.service';
import type { ChunkMessage } from './capture.service';
import { scrubSecrets } from './scrub';
import { unlabel } from './words';

export const WORK_MODEL = process.env['BUDDY_WORK_MODEL'] || 'claude-sonnet-5-5';
/** A session's lines for one day, at most. */
export const WORK_LINES_MAX = 6;
export const WORK_LINE_MAX = 160;
/** His words as the summariser sees them (the agent's reply start is already ≤ 300). */
const WORDS_MAX = 600;
/** Lines he removed that the summariser is told about (this project, this many days). */
const REMOVED_DAYS = 14;
const EPHEMERAL = { type: 'ephemeral' } as const;

export const WORK_KINDS = ['did', 'decided', 'stuck', 'next'] as const;

export const WORK_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['lines'],
    properties: {
        lines: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['kind', 'text'], properties: { kind: { type: 'string', enum: [...WORK_KINDS] }, text: { type: 'string' } } },
        },
    },
};

export const WORK_SYSTEM = `You keep a short work log for a software engineer: what got done in one of his chats with an AI agent, per project and day, so he can answer "what did I do on this project yesterday?" before a standup. You get the chat (his messages and the start of each agent reply), the lines this chat already has for today, and lines he removed from his log.

Write the chat's whole list for today; it replaces the lines so far. At most ${WORK_LINES_MAX} lines, each one short line (under ${WORK_LINE_MAX} characters) in plain past tense, specific enough to say in a standup: "Fixed the GST rounding in the invoice report", "Decided to keep the old export until the client signs off". kind: did (built, fixed, changed, checked), decided (a choice, with the reason in a few words), stuck (a problem not solved yet), next (what he said comes next).

Rules:
- Only what the chat shows. The agent's replies say what was done; his messages say what he asked for. An ask with no sign it was done is not "did" (it may be "next").
- Merge with the lines so far: keep what still holds, update what changed, drop what turned out wrong, never two lines for one thing. Never write a line he removed, or one that says the same.
- Work only: nothing about his feelings, health, money, family, his job search or his life outside the work; those never belong in this log.
- No secrets, keys, passwords, tokens or links with them; no personal data of other people (names of private persons, phone numbers, emails).
- A chat that did no real work (small talk, a question about a topic, only approvals) gets no lines: return an empty list.`;

export interface WorkInput {
    project: string;
    day: DayString;
    weekday: string;
    messages: readonly ChunkMessage[];
    soFar: ReadonlyArray<{ kind: string; text: string }>;
    removed: readonly string[];
}

const oneLine = (t: string, max: number) => {
    const s = t.replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/** The chat as the summariser reads it: his words (≤ 600 characters each) and the start of each reply. */
export function workChat(messages: readonly ChunkMessage[]): string {
    return messages.map((m) => `him: ${oneLine(m.text, WORDS_MAX)}${m.reply ? `\nagent: ${oneLine(m.reply, 300)}` : ''}`).join('\n');
}

export function workRequest(input: WorkInput): CreateParams {
    const text = [
        `<project>${input.project}</project>`,
        `<today>${input.weekday} ${input.day}</today>`,
        `<chat>\n${workChat(input.messages)}\n</chat>`,
        `<so_far>\n${input.soFar.map((l) => `${l.kind} · ${l.text}`).join('\n') || 'nothing yet'}\n</so_far>`,
        `<removed>\n${input.removed.join('\n') || 'none'}\n</removed>`,
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

const zWork = z.object({ lines: z.array(z.object({ kind: z.enum(WORK_KINDS), text: z.string() })) });

/** A comparison key: lower case, letters and digits only. */
const lineKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The summariser's lines, cleaned: scrubbed, no label, short, no repeat and nothing he removed. */
export function cleanWorkLines(output: unknown, removed: readonly string[]): Array<{ kind: WorkLineKind; text: string }> {
    const parsed = zWork.safeParse(output);
    if (!parsed.success) throw new Error('the work summary answered in the wrong shape');
    const gone = new Set(removed.map(lineKey));
    const seen = new Set<string>();
    const out: Array<{ kind: WorkLineKind; text: string }> = [];
    for (const l of parsed.data.lines) {
        const text = oneLine(unlabel(scrubSecrets(l.text)), WORK_LINE_MAX);
        const key = lineKey(text);
        if (!key || gone.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: l.kind, text });
        if (out.length >= WORK_LINES_MAX) break;
    }
    return out;
}

/** Is his work log on (BuddyState.workLog)? */
export async function workLogOn(userId: string): Promise<boolean> {
    const s = await prisma.buddyState.findUnique({ where: { userId }, select: { workLog: true } });
    return !!s?.workLog;
}

/**
 * One piece of a chat the gate marked as work: the session's lines for the day of its last message
 * are rewritten (one transaction). Returns how many lines it now has.
 */
export async function summariseWork(chunk: Pick<BuddyChunk, 'userId' | 'sessionKey' | 'project' | 'office'>, messages: readonly ChunkMessage[], now: Date = new Date()): Promise<{ lines: number; costUsd: number }> {
    if (!messages.length) return { lines: 0, costUsd: 0 };
    const ctx = await loadLearningContext(chunk.userId, now);
    const lastAt = new Date(messages[messages.length - 1]!.at);
    const day = dayOf(Number.isNaN(lastAt.getTime()) ? now : lastAt, ctx.tz);
    const project = (chunk.project ?? '').trim().toLowerCase() || 'other';
    const [soFar, removed] = await Promise.all([
        prisma.workLine.findMany({ where: { userId: chunk.userId, sessionKey: chunk.sessionKey, day: toDbDay(day), hidden: false }, orderBy: { position: 'asc' } }),
        prisma.workLine.findMany({ where: { userId: chunk.userId, project, hidden: true, day: { gte: toDbDay(addDays(day, -REMOVED_DAYS)) } }, select: { text: true }, take: 40 }),
    ]);
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
    const message = await callClaude(withRefusalFallbacks(workRequest({ project, day, weekday, messages, soFar, removed: removed.map((r) => r.text) })), 'buddy work');
    const { costUsd } = await recordAiUsage(chunk.userId, 'buddy_work', message);
    const lines = cleanWorkLines(parseJson(responseText(message)), removed.map((r) => r.text));
    await prisma.$transaction([
        prisma.workLine.deleteMany({ where: { userId: chunk.userId, sessionKey: chunk.sessionKey, day: toDbDay(day), hidden: false } }),
        prisma.workLine.createMany({
            data: lines.map((l, i) => ({ userId: chunk.userId, day: toDbDay(day), project, sessionKey: chunk.sessionKey, kind: l.kind, text: l.text, office: chunk.office, position: i })),
        }),
    ]);
    return { lines: lines.length, costUsd };
}

// ─── Reading it ─────────────────────────────────────────────────────────────

export interface WorkLineJson {
    _id: string;
    kind: WorkLineKind;
    text: string;
}

export interface WorkProjectJson {
    project: string;
    /** From a folder that never gets his brief. */
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
}

const WORK_COLUMNS = Prisma.sql`w."id", w."userId", w."day", w."project", w."sessionKey", w."kind", w."text", w."office", w."hidden", w."position", w."createdAt"`;

/**
 * His work, newest day first: per day and project the lines, the time and the commits. `q` searches
 * the lines' words (each day then shows the lines that match); without it the days from `from` to
 * `to` (the last 7 by default, 31 at most).
 */
export async function listWork(userId: string, query: WorkQuery = {}, now: Date = new Date()): Promise<WorkDayJson[]> {
    const ctx = await loadLearningContext(userId, now);
    const to = query.to && isValidDay(query.to) ? (query.to as DayString) : ctx.today;
    let from = query.from && isValidDay(query.from) ? (query.from as DayString) : addDays(to, -6);
    if (from < addDays(to, -30)) from = addDays(to, -30);
    const project = query.project?.trim().toLowerCase() || null;
    const limit = Math.min(Math.max(1, query.limit ?? 200), 500);
    const terms = searchTerms((query.q ?? '').slice(0, 200));

    let rows: WorkLine[];
    if (terms.length) {
        const q = Prisma.join(
            terms.map((t) => Prisma.sql`(to_tsquery('english', ${t}) || to_tsquery('simple', ${`${t}:*`}))`),
            ' && '
        );
        const where = project ? Prisma.sql`AND w."project" = ${project}` : Prisma.empty;
        rows = await prisma.$queryRaw<WorkLine[]>`
            WITH q AS (SELECT ${q} AS "query")
            SELECT ${WORK_COLUMNS} FROM "WorkLine" w, q
            WHERE w."userId" = ${userId} AND w."hidden" = FALSE ${where} AND w."searchVector" @@ q."query"
            ORDER BY w."day" DESC, ts_rank(w."searchVector", q."query") DESC
            LIMIT ${limit}`;
    } else {
        rows = await prisma.workLine.findMany({
            where: { userId, hidden: false, day: { gte: toDbDay(from), lte: toDbDay(to) }, ...(project ? { project } : {}) },
            orderBy: [{ day: 'desc' }, { project: 'asc' }, { createdAt: 'asc' }, { position: 'asc' }],
            take: limit,
        });
    }
    const days = [...new Set(rows.map((r) => fromDbDay(r.day)))].sort().reverse();
    if (!days.length) return [];
    // The time and commits of those days' sessions, by project.
    const sessions = await prisma.workSession.findMany({
        where: { userId, day: { in: days.map(toDbDay) }, project: project ? { key: project } : { isNot: null } },
        select: { day: true, minutes: true, details: true, project: { select: { key: true } } },
    });
    return days.map((day) => {
        const here = rows.filter((r) => fromDbDay(r.day) === day);
        const projects = [...new Set(here.map((r) => r.project))].sort();
        return {
            day,
            projects: projects.map((p) => {
                const lines = here.filter((r) => r.project === p);
                const s = sessions.filter((x) => fromDbDay(x.day) === day && x.project?.key === p);
                const commits = s.flatMap((x) => {
                    const c = (x.details as { commits?: unknown } | null)?.commits;
                    return Array.isArray(c) ? c.filter((v): v is string => typeof v === 'string') : [];
                });
                return {
                    project: p,
                    office: lines.some((l) => l.office),
                    minutes: s.reduce((a, x) => a + (x.minutes ?? 0), 0),
                    sessions: s.length,
                    commits: [...new Set(commits)].slice(0, 10),
                    lines: lines.map((l) => ({ _id: l.id, kind: l.kind, text: l.text })),
                };
            }),
        };
    });
}

/** He removes a line: hidden, kept so the summariser never writes it again. */
export async function hideWorkLine(userId: string, id: string): Promise<{ hidden: true }> {
    const r = await prisma.workLine.updateMany({ where: { id, userId }, data: { hidden: true } });
    if (!r.count) throw notFound();
    return { hidden: true };
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
        const recent = await prisma.workLine.findMany({ where: { userId, project, hidden: false, day: { gte: toDbDay(addDays(ctx.today, -30)) } }, distinct: ['day'], orderBy: { day: 'desc' }, select: { day: true }, take: 3 });
        if (!recent.length) return null;
        const days = recent.map((r) => fromDbDay(r.day));
        const list = await listWork(userId, { project, from: days[days.length - 1], to: days[0] }, now);
        return { days: list.map((d) => ({ day: d.day, projects: d.projects.map((p) => ({ project: p.project, minutes: p.minutes, lines: p.lines.map((l) => l.text) })) })) };
    }
    const yesterday = addDays(ctx.today, -1);
    const list = await listWork(userId, { from: yesterday, to: yesterday }, now);
    if (!list.length) return null;
    let left = 5;
    const projects = list[0]!.projects.map((p) => {
        const lines = p.lines.slice(0, left).map((l) => l.text);
        left -= lines.length;
        return { project: p.project, minutes: p.minutes, lines };
    }).filter((p) => p.lines.length);
    return { days: [{ day: yesterday, projects }] };
}

/** The night's view of his last day's work (per project: time and lines; office ones marked), or null. */
export async function workForNight(userId: string, today: DayString, now: Date = new Date()): Promise<{ text: string; lines: string[] } | null> {
    if (!(await workLogOn(userId))) return null;
    const list = await listWork(userId, { from: addDays(today, -1), to: addDays(today, -1) }, now);
    if (!list.length) return null;
    const lines = list[0]!.projects.flatMap((p) => p.lines.map((l) => l.text));
    const text = list[0]!.projects
        .map((p) => `${p.project}${p.office ? ' (office)' : ''} · ${p.minutes} min\n${p.lines.map((l) => `- ${l.kind}: ${l.text}`).join('\n')}`)
        .join('\n');
    return { text, lines };
}
